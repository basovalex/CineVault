import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

from tools import client_errors


class ClientErrorJournalTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        client_errors._window.update(started=0.0, count=0)

    def lines(self):
        return [json.loads(line) for line in (self.root / client_errors.JOURNAL_NAME).read_text(encoding="utf-8").splitlines()]

    def test_keeps_known_fields_and_drops_personal_data(self):
        payload = {
            "kind": "error", "message": "boom at https://site/x?q=секретный+поиск for ivan@example.com id 79991234567",
            "stack": "at a (app.js?v=1:10:2)", "path": "/catalog/some/deeper", "version": "20261111",
            "ua": "Mozilla/5.0", "ip": "10.0.0.1", "cookie": "session=1",
        }
        self.assertTrue(client_errors.record_error(self.root, payload, now=100))
        entry = self.lines()[0]
        self.assertNotIn("ip", entry)
        self.assertNotIn("cookie", entry)
        self.assertNotIn("секретный", entry["message"])
        self.assertNotIn("ivan@example.com", entry["message"])
        self.assertNotIn("79991234567", entry["message"])
        self.assertEqual(entry["stack"], "at a (app.js:10:2)")
        self.assertEqual(entry["path"], "/catalog/")

    def test_title_path_stays_and_fields_are_cut(self):
        client_errors.record_error(self.root, {"message": "x" * 5000, "path": "/title/kinopoisk-1/"}, now=100)
        entry = self.lines()[0]
        self.assertEqual(len(entry["message"]), client_errors.FIELDS["message"])
        self.assertEqual(entry["path"], "/title/kinopoisk-1/")

    def test_empty_or_odd_payloads_are_ignored(self):
        for payload in (None, [], "text", {"message": ""}, {"kind": "error"}):
            self.assertFalse(client_errors.record_error(self.root, payload, now=100))
        self.assertFalse((self.root / client_errors.JOURNAL_NAME).exists())

    def test_rate_is_capped_per_minute(self):
        results = [client_errors.record_error(self.root, {"message": f"m{i}"}, now=100) for i in range(client_errors.PER_MINUTE + 5)]
        self.assertEqual(results.count(True), client_errors.PER_MINUTE)
        self.assertTrue(client_errors.record_error(self.root, {"message": "later"}, now=161))

    def test_journal_rotates_when_large(self):
        journal = self.root / client_errors.JOURNAL_NAME
        journal.write_text("x" * (client_errors.MAX_FILE_BYTES + 1), encoding="utf-8")
        client_errors.record_error(self.root, {"message": "fresh"}, now=100)
        self.assertTrue(journal.with_suffix(".jsonl.1").exists())
        self.assertEqual([entry["message"] for entry in self.lines()], ["fresh"])

    def test_http_route(self):
        sent = []
        body = json.dumps({"message": "boom"}).encode()

        def handler_for(content_length, data):
            return SimpleNamespace(
                headers={"Content-Length": str(content_length)}, rfile=io.BytesIO(data),
                server=SimpleNamespace(library=SimpleNamespace(root=str(self.root))),
                send_response=sent.append, send_header=lambda *_: None, end_headers=lambda: None,
            )

        self.assertFalse(client_errors.handle(handler_for(len(body), body), urlparse("/api/other")))
        self.assertTrue(client_errors.handle(handler_for(len(body), body), urlparse("/api/client-errors")))
        self.assertTrue(client_errors.handle(handler_for(client_errors.MAX_BODY + 1, b""), urlparse("/api/client-errors")))
        self.assertEqual(sent, [204, 413])
        self.assertEqual(self.lines()[0]["message"], "boom")


if __name__ == "__main__":
    unittest.main()
