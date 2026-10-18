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
        write_audit(self.data_dir, {6: "deleted", 7: "missing", 8: "available"})
        self.assertEqual(deleted_ids(self.data_dir), {5, 6})
        self.assertEqual(unplayable_ids(self.data_dir), {5, 6, 7})

    def test_daily_sync_does_not_bring_back_deleted_cards(self):
        self.metadata.write_text(json.dumps([{"id": "kinopoisk-5", "kinopoiskId": 5, "title": "Старое"}]), encoding="utf-8")
        add_tombstone(self.data_dir, 5)
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [provider_row(5), provider_row(9)], "pages": 1}):
            sync_kinopoisk_dev("token", self.catalog, self.metadata, self.state, 0, 1, 10, 0, mode="daily")
        ids = [item["kinopoiskId"] for item in json.loads(self.metadata.read_text(encoding="utf-8"))]
        self.assertEqual(ids, [9])

    def test_popular_sync_ranks_by_votes_and_skips_deleted(self):
        self.catalog.write_text(json.dumps([{"id": "kinopoisk-1", "kinopoiskId": 1, "title": "Готовый", "videoSources": [{"url": "x"}]}]), encoding="utf-8")
        add_tombstone(self.data_dir, 3)
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

    def test_server_hides_unverified_metadata_cards_unless_popular(self):
        self.catalog.write_text(json.dumps([{"id": "kinopoisk-1", "kinopoiskId": 1, "title": "Готовый"}]), encoding="utf-8")
        self.metadata.write_text(json.dumps([
            {"id": "kinopoisk-{}".format(kp_id), "kinopoiskId": kp_id, "title": str(kp_id)} for kp_id in (2, 3, 4, 5)
        ]), encoding="utf-8")
        self.popular.write_text(json.dumps({"items": [{"kinopoiskId": 1, "rank": 2}, {"kinopoiskId": 4, "rank": 1},
                                                      {"kinopoiskId": 5, "rank": 3}]}), encoding="utf-8")
        write_audit(self.data_dir, {2: "available", 3: "pending", 5: "missing"})
        server.CATALOG_STATE_DIR = self.data_dir
        items = {item["kinopoiskId"]: item for item in server.imported_catalog_entries(self.catalog)}
        # 3 is unverified and not popular; 5 is popular but its stream check failed.
        self.assertEqual(sorted(items), [1, 2, 4])
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
