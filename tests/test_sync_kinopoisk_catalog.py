import json
import tempfile
import unittest
from pathlib import Path

from tools.sync_kinopoisk_catalog import build_entry


class SyncKinopoiskCatalogTests(unittest.TestCase):
    def test_series_card_records_when_playback_sources_were_refreshed(self):
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory)
            episode_links = generated / "episode_links.json"
            episode_links.write_text(json.dumps([{
                "kinopoisk_id": 460586,
                "series_title": "Пацаны",
                "original_series_title": "The Boys",
                "season": 1,
                "episode": 1,
                "title": "Пилотная серия",
                "url": "https://video.example/episode-1/master.m3u8",
                "sources": [{
                    "label": "Дубляж",
                    "url": "https://video.example/episode-1/master.m3u8",
                }],
            }]), encoding="utf-8")

            result = build_entry(episode_links)

        self.assertTrue(result["entry"]["playbackUpdatedAt"].endswith("+00:00"))
        self.assertEqual(result["entry"]["seasons"], [1])
        self.assertEqual(len(result["source_rows"]), 1)


if __name__ == "__main__":
    unittest.main()
