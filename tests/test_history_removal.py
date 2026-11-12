import unittest

from tools.accounts import merge_site_state


class HistoryRemovalTests(unittest.TestCase):
    def test_removed_title_does_not_come_back_from_the_server_copy(self):
        saved = {
            "history": {"tmdb-tv-1": 1000, "tmdb-movie-2": 1000},
            "progress": {"tmdb-tv-1-s1e2": {"titleId": "tmdb-tv-1", "updatedAt": 1000}, "tmdb-movie-2": {"titleId": "tmdb-movie-2", "updatedAt": 1000}},
        }
        incoming = {"history": {"tmdb-movie-2": 1000}, "progress": {}, "historyRemoved": {"tmdb-tv-1": 2000}}
        merged = merge_site_state(saved, incoming)
        self.assertEqual(list(merged["history"]), ["tmdb-movie-2"])
        self.assertEqual(list(merged["progress"]), ["tmdb-movie-2"])
        self.assertEqual(merged["historyRemoved"], {"tmdb-tv-1": 2000.0})

    def test_watching_again_after_removal_brings_it_back(self):
        saved = {"historyRemoved": {"tmdb-tv-1": 2000}}
        incoming = {"history": {"tmdb-tv-1": 3000}, "progress": {"tmdb-tv-1-s1e3": {"titleId": "tmdb-tv-1", "updatedAt": 3000}}}
        merged = merge_site_state(saved, incoming)
        self.assertIn("tmdb-tv-1", merged["history"])
        self.assertIn("tmdb-tv-1-s1e3", merged["progress"])

    def test_progress_without_title_id_is_matched_by_its_key(self):
        merged = merge_site_state({"progress": {"tmdb-tv-1-s2e5": {"updatedAt": 1000}, "tmdb-tv-1-alt": {"updatedAt": 1500}}}, {"historyRemoved": {"tmdb-tv-1": 2000}})
        self.assertEqual(merged["progress"], {})


if __name__ == "__main__":
    unittest.main()
