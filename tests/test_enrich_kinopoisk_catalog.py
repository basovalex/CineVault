import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.enrich_kinopoisk_catalog import candidate_ids, enrich
from tools.media_library_server import imported_catalog_entries


class EnrichKinopoiskCatalogTests(unittest.TestCase):
    def test_candidate_ids_uses_existing_metadata_overlay(self):
        legacy = [{"kinopoiskId": 1, "description": "Коротко"}]
        existing = [{"kinopoiskId": 1, "description": "Подробное описание истории с героями, событиями и полноценным сюжетом.",
                     "voteCount": 1000, "posterImage": "https://example.org/poster.jpg", "genres": ["драма"]}]
        self.assertEqual(candidate_ids(legacy, existing), [])

    def test_enrichment_keeps_playback_and_saves_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "catalog_imports.json"
            metadata = root / "catalog_metadata.json"
            state = root / "state.json"
            original = [{"id": "kinopoisk-1", "kinopoiskId": 1, "kind": "series",
                         "title": "Сериал", "year": 2020, "description": "Коротко",
                         "videoSources": [{"url": "https://example.org/video.m3u8"}]}]
            catalog.write_text(json.dumps(original), encoding="utf-8")
            row = {"id": 1, "name": "Сериал", "type": "tv-series", "isSeries": True,
                   "year": 2020, "description": "Подробное описание истории с героями, событиями и полноценным сюжетом.",
                   "votes": {"kp": 1000}, "poster": {"url": "https://example.org/poster.jpg"},
                   "genres": [{"name": "драма"}]}
            with patch("tools.enrich_kinopoisk_catalog.fetch_ids", return_value=[row]):
                result = enrich("fake-token", catalog, metadata, state, 10, 1, 0)
            self.assertEqual(result["processed"], 1)
            self.assertEqual(json.loads(catalog.read_text()), original)
            self.assertEqual(json.loads(state.read_text())["last_kinopoisk_id"], 1)
            card = imported_catalog_entries(catalog)[0]
            self.assertEqual(card["voteCount"], 1000)
            self.assertEqual(card["description"], row["description"])
            self.assertEqual(card["videoSources"], original[0]["videoSources"])


if __name__ == "__main__":
    unittest.main()
