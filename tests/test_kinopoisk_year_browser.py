import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "sync_kinopoisk_year_browser", ROOT / "tools" / "sync_kinopoisk_year_browser.py"
)
year_sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(year_sync)


class KinopoiskYearBrowserTests(unittest.TestCase):
    def test_browser_row_becomes_metadata_only_card(self):
        entry = year_sync.catalog_entry_from_browser_row({
            "href": "/film/5437614/",
            "title": "Майкл",
            "lines": ["Майкл", "Michael", ", 2026, 2 ч 10 мин", "США • биография  Режиссёр: Антуан Фукуа"],
            "text": "Рейтинг Кинопоиска 8.0",
            "src": "//poster/72x108",
            "srcset": "//poster/72x108 1x, //poster/136x204 2x",
        }, 2026)
        self.assertEqual(entry["kinopoiskId"], 5437614)
        self.assertEqual(entry["originalTitle"], "Michael")
        self.assertEqual(entry["countries"], ["США"])
        self.assertEqual(entry["genres"], ["биография"])
        self.assertEqual(entry["ratingKinopoisk"], 8.0)
        self.assertEqual(entry["posterImage"], "https://poster/136x204")
        self.assertEqual(entry["videoSources"], [])

    def test_merge_does_not_replace_legacy_or_playback_fields(self):
        incoming = year_sync.catalog_entry_from_browser_row({
            "href": "/film/10/", "title": "Новое название",
            "lines": ["Новое название", "2026", "Россия • драма"], "text": "", "src": "", "srcset": "",
        }, 2026)
        cards = {10: {"kinopoiskId": 10, "title": "Старое", "videoSources": [{"url": "saved"}]}}
        result = year_sync.merge_entries([incoming], cards, set())
        self.assertEqual(result["updated"], 1)
        self.assertEqual(cards[10]["videoSources"], [{"url": "saved"}])
        skipped = year_sync.merge_entries([incoming], cards, {10})
        self.assertEqual(skipped["skipped"], 1)


if __name__ == "__main__":
    unittest.main()
