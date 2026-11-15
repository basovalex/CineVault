import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import urlparse

from tools import title_logos


class FakeResponse:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(params)
        return self.response


class FakeHandler:
    def __init__(self, root, path):
        self.library = SimpleNamespace(root=root)
        self.sent = None
        self.parsed = urlparse(path)

    def send_json(self, status, payload):
        self.sent = (status, payload)


class TitleLogoTests(unittest.TestCase):
    def setUp(self):
        title_logos._cache = None
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        title_logos._cache = None
        self.folder.cleanup()

    def test_lookup_takes_the_logo_of_the_asked_kind(self):
        session = FakeSession(FakeResponse(200, {"docs": [
            {"isSeries": False, "logo": {"url": "https://example/movie.png"}},
            {"isSeries": True, "logo": {"url": "https://example/series.png"}},
        ]}))
        self.assertEqual(title_logos.lookup("1405", "tv", "", "key", session), "https://example/series.png")
        self.assertIn(("externalId.tmdb", "1405"), session.calls[0])

    def test_lookup_by_kinopoisk_id_and_missing_logo(self):
        session = FakeSession(FakeResponse(200, {"docs": [{"isSeries": True, "logo": {}}]}))
        self.assertEqual(title_logos.lookup("", "tv", "77044", "key", session), "")
        self.assertIn(("id", "77044"), session.calls[0])

    def test_lookup_reports_a_failed_service_as_none(self):
        self.assertIsNone(title_logos.lookup("1", "movie", "", "key", FakeSession(FakeResponse(403, {}))))

    def test_handle_remembers_answers_and_needs_an_id(self):
        handler = FakeHandler(self.root, "/api/title-logo")
        self.assertTrue(title_logos.handle(handler, handler.parsed))
        self.assertEqual(handler.sent[0], 400)
        with mock.patch.dict("os.environ", {"CINEVAULT_KINOPOISK_DEV_TOKEN": "key"}), \
                mock.patch.object(title_logos, "lookup", return_value="https://example/logo.png") as lookup:
            first = FakeHandler(self.root, "/api/title-logo?tmdb=1405&type=tv")
            title_logos.handle(first, first.parsed)
            second = FakeHandler(self.root, "/api/title-logo?tmdb=1405&type=tv")
            title_logos.handle(second, second.parsed)
        self.assertEqual(second.sent, (200, {"url": "https://example/logo.png"}))
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(json.loads((self.root / "title-logos.json").read_text()), {"tv:1405": "https://example/logo.png"})

    def test_other_paths_are_not_handled(self):
        handler = FakeHandler(self.root, "/api/other")
        self.assertFalse(title_logos.handle(handler, handler.parsed))


if __name__ == "__main__":
    unittest.main()
