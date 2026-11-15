import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

from tools import app_updates

TOKEN = "t" * 24


class FakeHandler:
    def __init__(self, root, headers=None):
        self.library = SimpleNamespace(root=Path(root))
        self.server = SimpleNamespace(public_base_url="https://example.test")
        self.headers = headers or {}
        self.wfile = io.BytesIO()
        self.status = None
        self.sent = {}
        self.json = None
        self.path = ""
        self.errors = []

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent[key] = value

    def end_headers(self):
        pass

    def send_json(self, status, payload, extra_headers=None):
        self.status, self.json = status, payload

    def send_error(self, status):
        self.errors.append(status)


def publish(root, code=9, name="0.4.0", body=b"A" * 1000):
    folder = Path(root) / "apk"
    folder.mkdir(parents=True)
    (folder / "CineVault-android.apk").write_bytes(body)
    (folder / "android.json").write_text(json.dumps({"versionCode": code, "versionName": name, "sha256": "ab", "notes": "Новое"}), encoding="utf-8")


class RangeTests(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(app_updates.parse_range("bytes=0-99", 1000), (0, 99))
        self.assertEqual(app_updates.parse_range("bytes=900-", 1000), (900, 999))
        self.assertEqual(app_updates.parse_range("bytes=-100", 1000), (900, 999))
        self.assertEqual(app_updates.parse_range("bytes=0-5000", 1000), (0, 999))

    def test_bad_ranges(self):
        for bad in ("bytes=1000-", "bytes=5-2", "items=0-1", "bytes=0-1,5-6", "bytes=x-y", "bytes=-0"):
            self.assertIsNone(app_updates.parse_range(bad, 1000), bad)


class TokenTests(unittest.TestCase):
    def test_token_path(self):
        self.assertTrue(app_updates.token_matches(f"/dl/{TOKEN}/CineVault.apk", TOKEN))
        self.assertFalse(app_updates.token_matches(f"/dl/{'x' * 24}/CineVault.apk", TOKEN))
        self.assertFalse(app_updates.token_matches(f"/dl/{TOKEN}/other.apk", TOKEN))
        self.assertFalse(app_updates.token_matches("/dl/short/CineVault.apk", "short"))
        self.assertFalse(app_updates.token_matches(f"/dl/{TOKEN}/CineVault.apk", ""))


class HandleTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.old = os.environ.get("CINEVAULT_APK_TOKEN")
        os.environ["CINEVAULT_APK_TOKEN"] = TOKEN
        self.addCleanup(lambda: os.environ.__setitem__("CINEVAULT_APK_TOKEN", self.old) if self.old is not None else os.environ.pop("CINEVAULT_APK_TOKEN", None))

    def run_get(self, path, headers=None, method="GET"):
        handler = FakeHandler(self.dir.name, headers)
        handled = app_updates.handle(handler, method, urlparse(path))
        return handler, handled

    def test_nothing_published(self):
        handler, handled = self.run_get("/tv/latest.json")
        self.assertTrue(handled)
        self.assertEqual(handler.status, 404)
        handler, handled = self.run_get("/tv/CineVault-android.apk")
        self.assertEqual(handler.status, 404)

    def test_manifest(self):
        publish(self.dir.name)
        handler, handled = self.run_get("/tv/latest.json")
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.json["versionCode"], 9)
        self.assertEqual(handler.json["size"], 1000)
        self.assertEqual(handler.json["shareUrl"], f"https://example.test/dl/{TOKEN}/CineVault.apk")

    def test_manifest_without_token_has_no_share_url(self):
        publish(self.dir.name)
        os.environ["CINEVAULT_APK_TOKEN"] = ""
        handler, _ = self.run_get("/tv/latest.json")
        self.assertNotIn("shareUrl", handler.json)

    def test_download_and_range(self):
        publish(self.dir.name, body=bytes(range(200)) * 5)
        handler, handled = self.run_get("/tv/CineVault-android.apk")
        self.assertTrue(handled)
        self.assertEqual(handler.status, 200)
        self.assertEqual(len(handler.wfile.getvalue()), 1000)
        self.assertEqual(handler.sent["Content-Type"], "application/vnd.android.package-archive")
        handler, _ = self.run_get("/tv/CineVault-android.apk", {"Range": "bytes=10-19"})
        self.assertEqual(handler.status, 206)
        self.assertEqual(handler.wfile.getvalue(), bytes(range(10, 20)))
        self.assertEqual(handler.sent["Content-Range"], "bytes 10-19/1000")
        handler, _ = self.run_get("/tv/CineVault-android.apk", {"Range": "bytes=5000-"})
        self.assertEqual(handler.status, 416)

    def test_head_sends_no_body(self):
        publish(self.dir.name)
        handler, _ = self.run_get("/tv/CineVault-android.apk", method="HEAD")
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.sent["Content-Length"], "1000")
        self.assertEqual(handler.wfile.getvalue(), b"")

    def test_secret_link(self):
        publish(self.dir.name)
        handler, handled = self.run_get(f"/dl/{TOKEN}/CineVault.apk")
        self.assertTrue(handled)
        self.assertEqual(handler.status, 200)
        handler, handled = self.run_get(f"/dl/{'z' * 24}/CineVault.apk")
        self.assertTrue(handled)
        self.assertEqual(handler.errors, [404])

    def test_page_is_left_to_static_files(self):
        handler, handled = self.run_get("/tv")
        self.assertFalse(handled)
        self.assertEqual(handler.path, "/tv.html")

    def test_other_paths_are_not_ours(self):
        _, handled = self.run_get("/api/catalog")
        self.assertFalse(handled)

    def test_broken_manifest_is_not_published(self):
        publish(self.dir.name)
        (Path(self.dir.name) / "apk" / "android.json").write_text("{nope", encoding="utf-8")
        self.assertIsNone(app_updates.load_manifest(Path(self.dir.name)))


if __name__ == "__main__":
    unittest.main()
