import tempfile
import unittest
from pathlib import Path

from tools.import_media_folder import episode_info


class ImportMediaFolderTests(unittest.TestCase):
    def test_sxxexx_name(self):
        root = Path("/tmp/library")
        info = episode_info(root / "Show.S02E03.mkv", root)
        self.assertEqual(info[:2], (2, 3))

    def test_season_folder_and_episode_number(self):
        root = Path("/tmp/library")
        info = episode_info(root / "Season 01" / "04.mp4", root)
        self.assertEqual(info[:2], (1, 4))

    def test_unrecognized_file_is_skipped(self):
        root = Path("/tmp/library")
        self.assertIsNone(episode_info(root / "poster.jpg", root))


if __name__ == "__main__":
    unittest.main()
