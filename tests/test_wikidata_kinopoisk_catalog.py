import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.sync_wikidata_kinopoisk_catalog import catalog_entry, sync


def claim(value):
    return {"mainsnak": {"datavalue": {"value": value}}}


class WikidataKinopoiskCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.catalog = self.root / "catalog_imports.json"
        self.metadata = self.root / "catalog_metadata.json"
        self.state = self.root / "state.json"
        self.catalog.write_text("[]", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_builds_series_card_with_open_metadata_only(self):
        entity = {
            "id": "Q1",
            "labels": {"ru": {"value": "Тестовый сериал"}, "en": {"value": "Test Series"}},
            "descriptions": {"ru": {"value": "Описание"}},
            "claims": {
                "P31": [claim({"id": "Q5398426"})],
                "P577": [claim({"time": "+2024-01-01T00:00:00Z"})],
                "P18": [claim("Poster image.jpg")],
                "P345": [claim("tt1234567")],
                "P4983": [claim("987")],
            },
        }
        card = catalog_entry(entity, 123)
        self.assertEqual(card["kind"], "series")
        self.assertEqual(card["year"], 2024)
        self.assertEqual(card["videoSources"], [])
        self.assertEqual(card["tmdbId"], 987)
        self.assertIn("Poster%20image.jpg", card["posterImage"])

    def test_sync_preserves_existing_catalog_and_checkpoints(self):
        self.catalog.write_text(json.dumps([{"id": "custom", "kinopoiskId": 1, "videoSources": [{"url": "x"}]}]), encoding="utf-8")
        rows = [{"qid": "Q1", "kinopoiskId": 1}, {"qid": "Q2", "kinopoiskId": 2}]
        entities = {
            "Q2": {"id": "Q2", "labels": {"ru": {"value": "Новый фильм"}},
                   "descriptions": {}, "claims": {"P31": [claim({"id": "Q11424"})]}},
        }
        with patch("tools.sync_wikidata_kinopoisk_catalog.fetch_id_batch", return_value=rows), \
                patch("tools.sync_wikidata_kinopoisk_catalog.fetch_entities", return_value=entities):
            result = sync(self.catalog, self.metadata, self.state, batches=1, limit=500, delay_seconds=0)
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(json.loads(self.state.read_text())["last_kinopoisk_id"], 2)
        self.assertEqual(json.loads(self.metadata.read_text())[0]["kinopoiskId"], 2)


if __name__ == "__main__":
    unittest.main()
