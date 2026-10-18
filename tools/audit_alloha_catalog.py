#!/usr/bin/env python3
"""Check catalog cards against the Alloha player (player 2) one by one.

A card whose stream has not been verified for player 1 still becomes visible
once Alloha has translations for it. The check is one fast HTTP request per
title, so it runs far ahead of the full stream audit. Results go to the same
SQLite file as the stream audit, in a separate table.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.audit_kinopoisk_catalog import DEFAULT_CATALOG, DEFAULT_METADATA, catalog_ids  # noqa: E402
from tools.catalog_tombstones import ALLOHA_TABLE, AUDIT_FILENAME, ensure_others_column, read_audit_ids, read_tombstones  # noqa: E402

DEFAULT_STATE = Path("/data/media-library") / AUDIT_FILENAME
RECHECK_MISSING_DAYS = 30
RESYNC_INTERVAL_SECONDS = 15 * 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AllohaAuditor:
    def __init__(self, state_path: Path):
        self.db = sqlite3.connect(str(state_path), timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            f"""CREATE TABLE IF NOT EXISTS {ALLOHA_TABLE} (
                kinopoisk_id INTEGER PRIMARY KEY,
                available INTEGER,
                translations INTEGER NOT NULL DEFAULT 0,
                failures INTEGER NOT NULL DEFAULT 0,
                checked_at TEXT
            )"""
        )
        columns = {row[1] for row in self.db.execute(f"PRAGMA table_info({ALLOHA_TABLE})")}
        if "priority" not in columns:
            self.db.execute(f"ALTER TABLE {ALLOHA_TABLE} ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
        ensure_others_column(self.db)
        self.db.commit()

    def sync_ids(self, ids: list[int], priority: int = 0) -> int:
        before = self.db.total_changes
        self.db.executemany(f"INSERT OR IGNORE INTO {ALLOHA_TABLE} (kinopoisk_id, priority) VALUES (?, ?)", ((value, priority) for value in ids))
        self.db.executemany(f"UPDATE {ALLOHA_TABLE} SET priority = ? WHERE kinopoisk_id = ? AND priority < ?", ((priority, value, priority) for value in ids))
        self.db.commit()
        return self.db.total_changes - before

    def next_id(self) -> Optional[int]:
        # Unchecked first (newest IDs first: fresh titles matter most), then
        # titles Alloha did not have a month ago.
        row = self.db.execute(
            f"""SELECT kinopoisk_id FROM {ALLOHA_TABLE}
                WHERE (available IS NULL AND failures < 5)
                   OR (available = 0 AND checked_at < ?)
                ORDER BY available IS NOT NULL, priority DESC, kinopoisk_id DESC LIMIT 1""",
            (datetime.fromtimestamp(time.time() - RECHECK_MISSING_DAYS * 86400, timezone.utc).isoformat(),),
        ).fetchone()
        return int(row[0]) if row else None

    def record(self, kinopoisk_id: int, translations: int, others: int = 0) -> None:
        self.db.execute(
            f"UPDATE {ALLOHA_TABLE} SET available = ?, translations = ?, others = ?, failures = 0, checked_at = ? WHERE kinopoisk_id = ?",
            (1 if translations else 0, translations, others, now_iso(), kinopoisk_id),
        )
        self.db.commit()

    def record_failure(self, kinopoisk_id: int) -> None:
        self.db.execute(f"UPDATE {ALLOHA_TABLE} SET failures = failures + 1, checked_at = ? WHERE kinopoisk_id = ?", (now_iso(), kinopoisk_id))
        self.db.commit()

    def stats(self) -> dict:
        rows = self.db.execute(f"SELECT CASE available WHEN 1 THEN 'available' WHEN 0 THEN 'missing' ELSE 'pending' END, COUNT(*) FROM {ALLOHA_TABLE} GROUP BY 1")
        return {name: count for name, count in rows}


def main() -> int:
    parser = argparse.ArgumentParser(description="Быстрая проверка карточек каталога в плеере Alloha")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--delay-seconds", type=float, default=15.0)
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()

    from tools.media_library_server import PlayerOptionsRateLimited, fetch_player_options, player_options_counts  # noqa: E402

    auditor = AllohaAuditor(args.state_path)
    # Cards in the catalog plus titles player 1 gave up on: Alloha may have them.
    data_dir = args.state_path.parent
    def queue_ids() -> None:
        # Catalog cards first; titles player 1 gave up on after them.
        auditor.sync_ids(sorted(read_audit_ids(data_dir, ("deleted", "missing")) | read_tombstones(data_dir)), priority=1)
        auditor.sync_ids(catalog_ids(args.catalog_path, args.metadata_path), priority=2)
    queue_ids()
    if args.status:
        print(json.dumps(auditor.stats(), ensure_ascii=False))
        return 0
    synced_at = time.monotonic()
    processed = 0
    while not args.max_items or processed < args.max_items:
        if time.monotonic() - synced_at > RESYNC_INTERVAL_SECONDS:
            queue_ids()
            synced_at = time.monotonic()
        kinopoisk_id = auditor.next_id()
        if kinopoisk_id is None:
            time.sleep(600)
            continue
        try:
            auditor.record(kinopoisk_id, *player_options_counts(fetch_player_options(kinopoisk_id, use_cache=False)))
        except PlayerOptionsRateLimited:
            # Viewers share this API budget: back off well before retrying.
            print("Alloha: лимит запросов, пауза 10 минут", flush=True)
            time.sleep(600)
            continue
        except (RuntimeError, ValueError, OSError):
            auditor.record_failure(kinopoisk_id)
            translations = -1
        processed += 1
        if processed % 100 == 0:
            print(f"Alloha: проверено {processed} · {auditor.stats()}", flush=True)
        if args.delay_seconds:
            time.sleep(args.delay_seconds)
    print(json.dumps(auditor.stats(), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
