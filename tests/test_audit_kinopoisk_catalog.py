import json
import tempfile
import unittest
from pathlib import Path
from tools.audit_kinopoisk_catalog import CatalogAuditor, catalog_ids


class CatalogAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.auditor = CatalogAuditor(self.root / "audit.sqlite3", "http://example.test/refresh")

    def tearDown(self):
        self.auditor.close()
        self.temp.cleanup()

    def test_catalog_ids_are_deduplicated_across_both_files(self):
        catalog = self.root / "catalog.json"
        metadata = self.root / "metadata.json"
        catalog.write_text(json.dumps([{"kinopoiskId": 2}, {"kinopoiskId": 1}]), encoding="utf-8")
        metadata.write_text(json.dumps([{"kinopoiskId": 2}, {"kinopoiskId": 3}]), encoding="utf-8")
        self.assertEqual(catalog_ids(catalog, metadata), [1, 2, 3])

    def test_missing_card_remains_queued_until_deleted(self):
        self.auditor.sync_ids([42])
        self.assertEqual(self.auditor.record(42, {"failures": 1}), "missing")
        self.assertEqual(self.auditor.next_id(), 42)
        self.assertEqual(self.auditor.record(42, {"failures": 3, "deleted": True}), "deleted")
        self.assertIsNone(self.auditor.next_id())

    def test_transport_error_does_not_count_as_missing_source(self):
        self.auditor.sync_ids([99])
        self.auditor.record_transport_error(99, RuntimeError("temporary"))
        row = self.auditor.db.execute(
            "SELECT status, source_failures, transport_failures FROM cards WHERE kinopoisk_id = 99"
        ).fetchone()
        self.assertEqual(row, ("transient", 0, 1))


if __name__ == "__main__":
    unittest.main()
