import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.import_kinopoisk_metadata import import_links, metadata_entry, parse_target
from tools.media_library_server import KinopoiskOnDemandUpdater, imported_catalog_entries, sitemap_title_ids
from tools.sync_kinopoisk_dev_catalog import api_token, catalog_entry as kinopoisk_dev_entry, sync as sync_kinopoisk_dev


def metadata(name="Тестовый фильм", category="1"):
    return {"data": {"name": name, "category": category, "year": 2020,
                     "description": "Описание", "genre": "драма", "poster": "https://example.org/poster.jpg"}}


class KinopoiskMetadataImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.catalog = self.root / "catalog_imports.json"
        self.metadata = self.root / "catalog_metadata.json"
        self.generated = self.root / "generated"
        self.catalog.write_text("[]", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_links_and_metadata_only_cards(self):
        self.assertEqual(parse_target("https://www.kinopoisk.ru/film/123/"), (123, "film"))
        self.assertEqual(parse_target("456"), (456, ""))
        film = metadata_entry(metadata(), 123, "film")
        series = metadata_entry(metadata("Тестовый сериал", "2"), 456, "")
        self.assertEqual(film["videoSources"], [])
        self.assertEqual(film["id"], "kinopoisk-123")
        self.assertEqual(series["kind"], "series")
        self.assertEqual(series["seasons"], [])
        self.assertIn("/series/456/", series["providerUrl"])

    def test_import_keeps_legacy_card_and_adds_only_metadata(self):
        self.catalog.write_text(json.dumps([{"id": "custom", "kinopoiskId": 1,
                                             "title": "Existing", "videoSources": [{"url": "https://example.org/movie.m3u8"}]}]), encoding="utf-8")
        for kp_id in (1, 2):
            folder = self.generated / str(kp_id)
            folder.mkdir(parents=True)
            (folder / "response.json").write_text(json.dumps(metadata("Film {}".format(kp_id))), encoding="utf-8")
        result = import_links(["https://www.kinopoisk.ru/film/1/", "https://www.kinopoisk.ru/film/2/"],
                              catalog_path=self.catalog, metadata_path=self.metadata, generated_dir=self.generated)
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["already_in_catalog"], 1)
        cards = imported_catalog_entries(self.catalog)
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["id"], "custom")
        self.assertEqual(cards[1]["videoSources"], [])
        self.assertIn("kinopoisk-2", sitemap_title_ids(self.catalog))
        self.assertEqual(len(json.loads(self.catalog.read_text())[0]["videoSources"]), 1)
        # Once the on-demand updater creates a full card, it takes precedence.
        legacy = json.loads(self.catalog.read_text())
        legacy.append({"id": "kinopoisk-2", "kinopoiskId": 2, "title": "Playable", "videoSources": [{"url": "https://example.org/new.m3u8"}]})
        self.catalog.write_text(json.dumps(legacy), encoding="utf-8")
        cards = imported_catalog_entries(self.catalog)
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[1]["title"], "Playable")

    def test_dry_run_does_not_write_metadata_file(self):
        folder = self.generated / "8"
        folder.mkdir(parents=True)
        (folder / "response.json").write_text(json.dumps(metadata()), encoding="utf-8")
        result = import_links(["8"], catalog_path=self.catalog, metadata_path=self.metadata,
                              generated_dir=self.generated, dry_run=True)
        self.assertEqual(result["created"], 1)
        self.assertFalse(self.metadata.exists())

    def test_new_card_registers_source_only_at_first_playback(self):
        updater_dir = self.root / "helper"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("", encoding="utf-8")
        (updater_dir / "add_media.py").write_text("", encoding="utf-8")
        (updater_dir / "media_sources.json").write_text('{"media": []}', encoding="utf-8")
        self.metadata.write_text(json.dumps([metadata_entry(metadata(), 99, "film")]), encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, catalog_path=self.catalog)
        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "Успешно: 1"
            run.return_value.stderr = ""
            updater.refresh(99)
        self.assertEqual(run.call_count, 2)
        self.assertIn("--no-update", run.call_args_list[0].args[0])
        self.assertIn("--only", run.call_args_list[1].args[0])

    def test_paginated_provider_sync_checkpoints_only_saved_pages(self):
        row = {"id": 777, "name": "Новый сериал", "type": "tv-series", "year": 2024,
               "rating": {"kp": 7.8}, "poster": {"url": "https://example.org/poster.jpg"},
               "genres": [{"name": "драма"}]}
        self.assertEqual(kinopoisk_dev_entry(row)["videoSources"], [])
        self.assertEqual(kinopoisk_dev_entry(row)["kind"], "series")
        state = self.root / "checkpoint.json"
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [row], "pages": 1}):
            result = sync_kinopoisk_dev("fake-token", self.catalog, self.metadata, state,
                                        start_page=0, pages=1, limit=100, delay_seconds=0)
        self.assertEqual(result["created"], 1)
        self.assertEqual(json.loads(state.read_text())["next_page"], 2)
        self.assertEqual(len(imported_catalog_entries(self.catalog)), 1)
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [], "pages": 1}):
            result = sync_kinopoisk_dev("fake-token", self.catalog, self.metadata, state,
                                        start_page=0, pages=1, limit=100, delay_seconds=0)
        self.assertEqual(result["next_page"], 2)

    def test_daily_sync_updates_metadata_without_removing_playback_fields(self):
        old = kinopoisk_dev_entry({"id": 777, "name": "Старое имя", "type": "movie", "year": 2023})
        old["videoSources"] = [{"url": "https://example.org/movie.m3u8"}]
        self.metadata.write_text(json.dumps([old]), encoding="utf-8")
        fresh = {"id": 777, "name": "Новое имя", "type": "movie", "year": 2024,
                 "rating": {"kp": 8.1}, "poster": {"url": "https://example.org/new.jpg"}}
        state = self.root / "checkpoint.json"
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [fresh], "pages": 1}) as fetch:
            result = sync_kinopoisk_dev("fake-token", self.catalog, self.metadata, state,
                                        start_page=0, pages=1, limit=250, delay_seconds=0,
                                        mode="daily", lookback_days=7)
        saved = json.loads(self.metadata.read_text())
        self.assertEqual(result["updated"], 1)
        self.assertEqual(saved[0]["title"], "Новое имя")
        self.assertEqual(saved[0]["videoSources"], old["videoSources"])
        self.assertIsNotNone(fetch.call_args.kwargs["updated_since"])
        self.assertIn("last_daily_sync", json.loads(state.read_text()))

    def test_series_backfill_uses_independent_checkpoint(self):
        row = {"id": 778, "name": "Новый сериал", "type": "tv-series", "isSeries": True}
        state = self.root / "checkpoint.json"
        state.write_text(json.dumps({"next_page": 9}), encoding="utf-8")
        with patch("tools.sync_kinopoisk_dev_catalog.fetch_page", return_value={"docs": [row], "pages": 20}) as fetch:
            sync_kinopoisk_dev("fake-token", self.catalog, self.metadata, state,
                               start_page=0, pages=1, limit=250, delay_seconds=0,
                               mode="backfill", kind="series")
        saved_state = json.loads(state.read_text())
        self.assertEqual(saved_state["next_page"], 9)
        self.assertEqual(saved_state["next_page_series"], 2)
        self.assertEqual(fetch.call_args.kwargs["kind"], "series")

    def test_provider_token_can_be_loaded_from_ignored_local_env_file(self):
        (self.root / ".env").write_text("CINEVAULT_KINOPOISK_DEV_TOKEN=test-only\n", encoding="utf-8")
        with patch.dict("tools.sync_kinopoisk_dev_catalog.os.environ", {}, clear=True), \
                patch("tools.sync_kinopoisk_dev_catalog.ROOT", self.root):
            self.assertEqual(api_token(), "test-only")


if __name__ == "__main__":
    unittest.main()
