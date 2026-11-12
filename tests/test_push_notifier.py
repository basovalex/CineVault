import unittest
from unittest import mock

from tools import push_notifier


class LampacProbeTests(unittest.TestCase):
    def probe(self, answers):
        probe = push_notifier.LampacProbe("https://lampac.example")
        calls = []

        def fake(url, timeout=15):
            calls.append(url)
            for prefix, answer in answers:
                if url.startswith(prefix) or url.startswith("https://lampac.example" + prefix):
                    return answer
            return None

        probe._json = fake
        return probe, calls

    def test_finds_episode_through_season_list(self):
        probe, _ = self.probe([
            ("/lite/events", [{"url": "/lite/one", "show": True}]),
            ("https://lampac.example/lite/one", {"type": "season", "data": [{"s": 1, "url": "/lite/one?s=1"}, {"s": 2, "url": "/lite/one?s=2"}]}),
            ("/lite/one?s=2", {"type": "episode", "data": [{"s": 2, "e": 1}, {"s": 2, "e": 2}]}),
        ])
        self.assertTrue(probe.has_episode({"id": "1"}, 2, 2))

    def test_episode_not_out_yet_and_look_alikes_are_skipped(self):
        probe, _ = self.probe([
            ("/lite/events", {"online": [{"url": "/lite/a"}, {"url": "/lite/b"}]}),
            ("https://lampac.example/lite/a", {"type": "similar", "data": [{"url": "/x"}]}),
            ("https://lampac.example/lite/b", {"type": "episode", "data": [{"e": 1}, {"e": 2}]}),
        ])
        self.assertFalse(probe.has_episode({"id": "1"}, 1, 3))
        self.assertTrue(probe.has_episode({"id": "1"}, 1, 2))


class NoticeTests(unittest.TestCase):
    def test_episode_waits_for_a_source(self):
        notifier = push_notifier.PushNotifier.__new__(push_notifier.PushNotifier)
        notifier.lampac = mock.Mock()
        notifier.lampac.has_episode.return_value = False
        notice = {"key": "tmdb-tv-1:s1e3", "season": 1, "episode": 3, "query": {"id": "1"}}
        self.assertFalse(notifier._playable(notice, {}))
        notifier.lampac.has_episode.return_value = True
        self.assertTrue(notifier._playable(notice, {}))

    def test_without_lampac_falls_back_to_air_date(self):
        notifier = push_notifier.PushNotifier.__new__(push_notifier.PushNotifier)
        notifier.lampac = None
        self.assertTrue(notifier._playable({"key": "k", "season": 1, "episode": 1, "query": {}}, {}))


if __name__ == "__main__":
    unittest.main()
