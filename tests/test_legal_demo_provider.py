import socket
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.legal_demo_provider import FixtureError, LegalDemoProvider


FIXTURES = Path(__file__).parents[1] / "fixtures" / "legal_demo"


class LegalDemoProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = LegalDemoProvider(FIXTURES)

    def test_search_is_local(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network")):
            results = self.provider.search("тестовый")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].title_id, "test-series")

    def test_title_metadata(self):
        title = self.provider.get_title("test-series")
        self.assertEqual(title.title, "Тестовый сериал")
        self.assertIn("локального тестирования", title.description)
        self.assertTrue(title.poster_path.exists())
        self.assertEqual(len(title.seasons), 2)

    def test_seasons_and_episodes(self):
        episodes = self.provider.get_episodes("test-series", season=1)
        self.assertEqual([episode.number for episode in episodes], [1, 2])
        self.assertEqual(
            episodes[0].translations,
            ("Оригинал", "Тестовая дорожка"),
        )

    def test_stream_is_local_fixture(self):
        stream = self.provider.get_stream("test-series", 1, 1, "Оригинал")
        self.assertTrue(stream.playlist_path.exists())
        self.assertEqual(stream.playlist_path.suffix, ".m3u8")
        content = stream.playlist_path.read_text(encoding="utf-8")
        media_lines = [
            line for line in content.splitlines()
            if line and not line.startswith("#")
        ]
        self.assertTrue(media_lines)
        self.assertTrue(all("://" not in line for line in media_lines))

    def test_unknown_translation_is_rejected(self):
        with self.assertRaises(FixtureError):
            self.provider.get_stream("test-series", 1, 1, "Unknown")


if __name__ == "__main__":
    unittest.main()
