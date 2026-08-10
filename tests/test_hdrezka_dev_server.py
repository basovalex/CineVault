import unittest

from tools.hdrezka_dev_server import probe_payload, search_payload


class LegalDemoEndpointTests(unittest.TestCase):
    def test_search_endpoint_payload(self):
        payload = search_payload("Тестовый сериал")
        self.assertEqual(payload["provider"], "legal-demo")
        self.assertEqual(payload["items"][0]["title"], "Тестовый сериал")

    def test_probe_does_not_return_media_path(self):
        payload = probe_payload("Тестовый сериал", 0, 1, 1)
        self.assertTrue(payload["has_player"])
        self.assertEqual(payload["source"], "local-fixture")
        self.assertNotIn("playlist_path", payload)
        self.assertNotIn("url", payload)


if __name__ == "__main__":
    unittest.main()
