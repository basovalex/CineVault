import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tools.media_library_server as server
from tools.catalog_tombstones import add_tombstone, deleted_ids, unplayable_ids
from tools.sync_kinopoisk_dev_catalog import sync as sync_kinopoisk_dev, sync_popular


def provider_row(kp_id, votes=100, year=2026, kind="movie"):
    return {
        "id": kp_id, "name": "Фильм {}".format(kp_id), "type": kind, "year": year,
        "description": "Достаточно длинное описание карточки, чтобы она считалась заполненной и попала в каталог.",
        "genres": [{"name": "драма"}], "poster": {"url": "https://example.test/{}.jpg".format(kp_id)},
        "votes": {"kp": votes}, "rating": {"kp": 7.1},
    }


def write_audit(data_dir, statuses):
    db = sqlite3.connect(str(data_dir / "kinopoisk_stream_audit.sqlite3"))
    db.execute("CREATE TABLE cards (kinopoisk_id INTEGER PRIMARY KEY, status TEXT NOT NULL)")
    db.executemany("INSERT INTO cards VALUES (?, ?)", statuses.items())
    db.commit()
    db.close()


def write_alloha(data_dir, statuses):
    db = sqlite3.connect(str(data_dir / "kinopoisk_stream_audit.sqlite3"))
    db.execute("CREATE TABLE IF NOT EXISTS alloha_cards (kinopoisk_id INTEGER PRIMARY KEY, available INTEGER)")
    db.executemany("INSERT OR REPLACE INTO alloha_cards VALUES (?, ?)", statuses.items())
    db.commit()
    db.close()


class CatalogPopularityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data_dir = self.root / "state"
        self.data_dir.mkdir()
        self.catalog = self.root / "catalog_imports.json"
        self.metadata = self.root / "catalog_metadata.json"
        self.popular = self.root / "catalog_popular.json"
        self.state = self.data_dir / "kinopoisk_catalog_sync.json"
        self.catalog.write_text("[]", encoding="utf-8")
        self.metadata.write_text("[]", encoding="utf-8")
        server._catalog_cache.update({"path": None, "mtime_ns": None, "items": []})
        server._catalog_hidden_cache.update({"loaded_at": 0.0, "dir": None, "value": None})

    def tearDown(self):
        server.CATALOG_STATE_DIR = None
        self.temp.cleanup()

    def test_tombstones_combine_file_and_audit(self):
        add_tombstone(self.data_dir, 5)
        add_tombstone(self.data_dir, 5)
        write_audit(self.data_dir, {6: "deleted", 7: "missing", 8: "available", 9: "deleted"})
        # Dead only when player 2 (Alloha) was checked and lacks it too.
        write_alloha(self.data_dir, {5: 0, 6: 0, 7: 1})
        self.assertEqual(deleted_ids(self.data_dir), {5, 6})
        self.assertEqual(unplayable_ids(self.data_dir), {5, 6})

    def test_daily_sync_does_not_bring_back_deleted_cards(self):
        self.metadata.write_text(json.dumps([{"id": "kinopoisk-5", "kinopoiskId": 5, "title": "Старое"}]), encoding="utf-8")
        add_tombstone(self.data_dir, 5)
        write_alloha(self.data_dir, {5: 0})
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [provider_row(5), provider_row(9)], "pages": 1}):
            sync_kinopoisk_dev("token", self.catalog, self.metadata, self.state, 0, 1, 10, 0, mode="daily")
        ids = [item["kinopoiskId"] for item in json.loads(self.metadata.read_text(encoding="utf-8"))]
        self.assertEqual(ids, [9])

    def test_popular_sync_ranks_by_votes_and_skips_deleted(self):
        self.catalog.write_text(json.dumps([{"id": "kinopoisk-1", "kinopoiskId": 1, "title": "Готовый", "videoSources": [{"url": "x"}]}]), encoding="utf-8")
        add_tombstone(self.data_dir, 3)
        write_alloha(self.data_dir, {3: 0})
        pages = {
            "popular-films": [provider_row(1, votes=10), provider_row(2, votes=5000), provider_row(3, votes=9000)],
            "popular-series": [provider_row(4, votes=700, kind="tv-series")],
        }
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page",
                   side_effect=lambda *args, **kwargs: {"docs": pages[kwargs["list_slug"]], "pages": 1}):
            result = sync_popular("token", self.catalog, self.metadata, self.state, self.popular, 3, 250, 0, 2025)
        ranking = json.loads(self.popular.read_text(encoding="utf-8"))["items"]
        self.assertEqual([(row["kinopoiskId"], row["rank"]) for row in ranking], [(2, 1), (4, 2), (1, 3)])
        metadata_ids = sorted(item["kinopoiskId"] for item in json.loads(self.metadata.read_text(encoding="utf-8")))
        self.assertEqual(metadata_ids, [2, 4])  # the playable legacy card stays in catalog_imports only
        self.assertEqual(result["ranked"], 3)

    def test_server_lists_unverified_cards_and_hides_only_dead_ones(self):
        self.catalog.write_text(json.dumps([{"id": "kinopoisk-1", "kinopoiskId": 1, "title": "Готовый"}]), encoding="utf-8")
        self.metadata.write_text(json.dumps([
            {"id": "kinopoisk-{}".format(kp_id), "kinopoiskId": kp_id, "title": str(kp_id)} for kp_id in (2, 3, 4, 5)
        ]), encoding="utf-8")
        self.popular.write_text(json.dumps({"items": [{"kinopoiskId": 1, "rank": 2}, {"kinopoiskId": 4, "rank": 1},
                                                      {"kinopoiskId": 5, "rank": 3}]}), encoding="utf-8")
        write_audit(self.data_dir, {2: "available", 3: "pending", 5: "missing"})
        write_alloha(self.data_dir, {5: 0})
        server.CATALOG_STATE_DIR = self.data_dir
        items = {item["kinopoiskId"]: item for item in server.imported_catalog_entries(self.catalog)}
        # 5 failed in both players; 3 is unverified but still listed.
        self.assertEqual(sorted(items), [1, 2, 3, 4])
        self.assertTrue(items[2]["playbackVerified"])
        self.assertFalse(items[3]["playbackVerified"])
        self.assertEqual(items[4]["popularRank"], 1)
        self.assertEqual(items[1]["popularRank"], 2)
        self.assertNotIn("popularRank", items[2])

    def test_trending_collection_follows_popularity_rank(self):
        self.catalog.write_text(json.dumps([
            {"id": "a", "kinopoiskId": 1, "title": "A", "kind": "movie", "voteCount": 9000},
            {"id": "b", "kinopoiskId": 2, "title": "B", "kind": "movie", "voteCount": 10},
            {"id": "c", "kinopoiskId": 3, "title": "C", "kind": "movie", "voteCount": 500000},
        ]), encoding="utf-8")
        self.popular.write_text(json.dumps({"items": [{"kinopoiskId": 2, "rank": 1}, {"kinopoiskId": 1, "rank": 2}]}), encoding="utf-8")
        items = server.imported_catalog_entries(self.catalog)
        with patch.object(server, "imported_catalog_entries", return_value=items):
            page = server.catalog_page({"collection": ["trending"]})
        self.assertEqual([item["id"] for item in page["items"]], ["b", "a"])


if __name__ == "__main__":
    unittest.main()


class CatalogProgressTest(unittest.TestCase):
    def test_newest_progress_wins_and_unknown_fields_are_dropped(self):
        with tempfile.TemporaryDirectory() as temp:
            library = server.MediaLibrary(Path(temp), transcode=False)
            try:
                library.update_catalog_progress("film-alt", {"titleId": "film", "player": "alternative", "position": 120, "updatedAt": 2000, "evil": "x"})
                stale = library.update_catalog_progress("film-alt", {"titleId": "film", "position": 5, "updatedAt": 1000})
                self.assertEqual(stale["position"], 120)
                items = library.list_catalog_progress()
                self.assertEqual(items["film-alt"], {"titleId": "film", "player": "alternative", "position": 120.0, "updatedAt": 2000})
                with self.assertRaises(ValueError):
                    library.update_catalog_progress("film", {"position": 1})
                library.clear_catalog_progress()
                self.assertEqual(library.list_catalog_progress(), {})
            finally:
                library.close()


class SharedStateTest(unittest.TestCase):
    def test_pets_keep_newest_write_and_reject_unknown_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            library = server.MediaLibrary(Path(temp), transcode=False)
            try:
                self.assertEqual(library.get_shared_state("pets"), {"value": None, "updatedAt": 0})
                library.put_shared_state("pets", {"updatedAt": 200, "value": {"fox": {"xp": 25}}})
                stale = library.put_shared_state("pets", {"updatedAt": 100, "value": {"fox": {"xp": 0}}})
                self.assertEqual(stale["value"], {"fox": {"xp": 25}})
                with self.assertRaises(KeyError):
                    library.put_shared_state("secrets", {"updatedAt": 1, "value": {}})
                with self.assertRaises(ValueError):
                    library.put_shared_state("pets", {"updatedAt": 300, "value": "x"})
            finally:
                library.close()


class TrailerScoreTest(unittest.TestCase):
    def test_official_trailer_beats_reviews_and_full_films(self):
        score = server.score_trailer_candidate
        official = score({"title": "Кракен — Официальный трейлер (2025)", "duration": 124, "hits": 15000}, ["Кракен"], 2025)
        review = score({"title": "Кракен обзор фильма и трейлер", "duration": 124}, ["Кракен"], 2025)
        self.assertGreater(official, 15)
        self.assertLess(review, 6)
        self.assertEqual(score({"title": "Кракен полный фильм", "duration": 5000}, ["Кракен"], 2025), 0)
        self.assertEqual(score({"title": "Другое кино трейлер", "duration": 90}, ["Кракен"], 2025), 0)


class AllohaVisibilityTest(unittest.TestCase):
    def test_alloha_titles_are_visible_and_not_dead(self):
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            write_audit(data_dir, {1: "deleted", 2: "deleted", 3: "pending"})
            db = sqlite3.connect(str(data_dir / "kinopoisk_stream_audit.sqlite3"))
            db.execute("CREATE TABLE alloha_cards (kinopoisk_id INTEGER PRIMARY KEY, available INTEGER)")
            db.executemany("INSERT INTO alloha_cards VALUES (?, ?)", [(1, 1), (3, 1), (2, 0)])
            db.commit(); db.close()
            self.assertEqual(deleted_ids(data_dir), {2})
            server.CATALOG_STATE_DIR = data_dir
            server._catalog_hidden_cache.update({"loaded_at": 0.0, "dir": None, "value": None})
            try:
                available, unplayable = server.catalog_metadata_visibility()
            finally:
                server.CATALOG_STATE_DIR = None
            self.assertTrue({1, 3} <= available)
            self.assertNotIn(1, unplayable)


class HiddenCardRefreshTest(unittest.TestCase):
    def test_hidden_metadata_card_is_still_found_for_refresh(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "state").mkdir()
            catalog = root / "catalog_imports.json"
            catalog.write_text("[]", encoding="utf-8")
            (root / "catalog_metadata.json").write_text(json.dumps([{"id": "kinopoisk-7", "kinopoiskId": 7, "title": "Новый"}]), encoding="utf-8")
            write_audit(root / "state", {7: "deleted"})
            write_alloha(root / "state", {7: 0})
            server._catalog_cache.update({"path": None, "mtime_ns": None, "items": []})
            server._catalog_hidden_cache.update({"loaded_at": 0.0, "dir": None, "value": None})
            server.CATALOG_STATE_DIR = root / "state"
            try:
                self.assertEqual(server.imported_catalog_entries(catalog), [])
                with self.assertRaises(KeyError):
                    server.imported_catalog_item("7", catalog)
                self.assertEqual(server.imported_catalog_item("7", catalog, include_hidden=True)["title"], "Новый")
            finally:
                server.CATALOG_STATE_DIR = None


class CatalogIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "state").mkdir()
        self.catalog = self.root / "catalog_imports.json"
        self.catalog.write_text(json.dumps([
            {"id": "a", "kinopoiskId": 1, "title": "Альфа", "kind": "movie", "year": 2025, "genres": ["драма"], "voteCount": 5000, "rating": 8.0, "videoSources": [{"url": "x"}]},
        ]), encoding="utf-8")
        (self.root / "catalog_metadata.json").write_text(json.dumps([
            {"id": "kinopoisk-2", "kinopoiskId": 2, "title": "Бета", "kind": "series", "year": 2024, "genres": ["комедия"], "voteCount": 9000, "rating": 7.0},
            {"id": "kinopoisk-3", "kinopoiskId": 3, "title": "Гамма", "kind": "movie", "year": 2020, "genres": ["драма"], "voteCount": 100000, "rating": 9.0},
            {"id": "kinopoisk-4", "kinopoiskId": 4, "title": "Дельта", "kind": "movie", "year": 2019, "genres": ["ужасы"], "voteCount": 10, "rating": 5.0},
        ]), encoding="utf-8")
        server._catalog_cache.update({"path": None, "mtime_ns": None, "items": []})
        from tools.catalog_index import CatalogIndex, build_index
        self.index_path = self.root / "state" / "catalog_index.sqlite3"
        build_index(self.catalog, self.index_path)
        self.index = CatalogIndex(self.catalog, self.index_path)

    def tearDown(self):
        server.CATALOG_INDEX = None
        self.temp.cleanup()

    def test_page_filters_sorts_and_hides_dead_cards(self):
        visibility = (frozenset({2}), frozenset({4}))
        page = self.index.page({"genre": ["драма"]}, visibility)
        self.assertEqual([item["id"] for item in page["items"]], ["a", "kinopoisk-3"])  # verified first
        self.assertFalse(page["items"][1]["playbackVerified"])
        everything = self.index.page({}, visibility)
        self.assertEqual(everything["total"], 3)  # Дельта is dead in both players
        search = self.index.page({"search": ["гамм"]}, visibility)
        self.assertEqual([item["id"] for item in search["items"]], ["kinopoisk-3"])
        facets = self.index.facets(visibility)
        self.assertEqual((facets["total"], facets["movies"], facets["series"]), (3, 2, 1))
        self.assertEqual(facets["genres"]["драма"], 2)

    def test_item_lookup_and_upsert_after_refresh(self):
        from tools.catalog_index import upsert_entry
        visibility = (frozenset(), frozenset({4}))
        self.assertEqual(self.index.item("3", visibility)["title"], "Гамма")
        with self.assertRaises(KeyError):
            self.index.item("4", visibility)
        self.assertEqual(self.index.item("4", visibility, include_hidden=True)["title"], "Дельта")
        upsert_entry(self.index_path, {"id": "kinopoisk-3", "kinopoiskId": 3, "title": "Гамма", "videoSources": [{"url": "fresh"}]})
        refreshed = self.index.item("kinopoisk-3", visibility)
        self.assertEqual(refreshed["videoSources"], [{"url": "fresh"}])
        self.assertEqual(refreshed["genres"], ["драма"])  # enrichment kept

    def test_server_functions_use_the_index(self):
        server.CATALOG_INDEX = self.index
        self.index._checked_at = float("inf")  # no rebuild checks in tests
        self.assertEqual(server.catalog_page({"sort": ["title"]})["total"], 4)
        self.assertEqual(server.imported_catalog_item("a")["title"], "Альфа")


class AllohaLibraryTest(unittest.TestCase):
    def test_alloha_rows_become_cards_and_merge_into_the_index(self):
        from tools.sync_alloha_catalog import card_from_alloha
        from tools.catalog_index import CatalogIndex, build_index
        card = card_from_alloha({"id_kp": "301", "name": "Матрица", "original_name": "The Matrix", "year": "1999",
                                 "category": "Фильм", "genre": "фантастика, боевик", "time": "02:16", "rating_kp": "8.5",
                                 "translation_iframe": {"1": {"name": "Дубляж"}}, "tagline": "None"})
        self.assertEqual((card["kind"], card["runtime"], card["voices"], card["genres"]), ("movie", 136, ["Дубляж"], ["фантастика", "боевик"]))
        self.assertNotIn("tagline", card)
        series = card_from_alloha({"id_kp": "7", "name": "Сериал", "category": "Аниме сериал"})
        self.assertEqual((series["kind"], series["genres"]), ("series", ["аниме"]))
        self.assertIsNone(card_from_alloha({"id_kp": "None", "name": "Без ID"}))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = root / "catalog_imports.json"
            catalog.write_text(json.dumps([{"id": "the-matrix", "kinopoiskId": 301, "title": "Матрица", "kind": "movie"}]), encoding="utf-8")
            (root / "catalog_alloha.jsonl").write_text(json.dumps(card, ensure_ascii=False) + "\n" + json.dumps(series, ensure_ascii=False) + "\n", encoding="utf-8")
            server._catalog_cache.update({"path": None, "mtime_ns": None, "items": []})
            index_path = root / "index.sqlite3"
            self.assertEqual(build_index(catalog, index_path), 2)
            index = CatalogIndex(catalog, index_path)
            visibility = (frozenset(), frozenset({7}))  # Alloha listing beats an old failed check
            page = index.page({}, visibility)
            self.assertEqual(page["total"], 2)
            self.assertEqual(index.item("301", visibility)["voices"], ["Дубляж"])
            self.assertTrue(index.item("7", visibility)["playbackVerified"])
