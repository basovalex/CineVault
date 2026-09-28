#!/usr/bin/env python3
"""Gradually verify every Kinopoisk card through CineVault's refresh API."""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "app" / "data" / "catalog_imports.json"
DEFAULT_METADATA = ROOT / "app" / "data" / "catalog_metadata.json"
DEFAULT_STATE = Path("/data/media-library/kinopoisk_stream_audit.sqlite3")
DEFAULT_API = "http://127.0.0.1:8081/api/playback/refresh"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def catalog_ids(catalog_path: Path, metadata_path: Path) -> list[int]:
    result = set()
    for path in (catalog_path, metadata_path):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        if not isinstance(payload, list):
            raise ValueError(f"{path} должен содержать массив")
        for item in payload:
            if not isinstance(item, dict):
                continue
            try:
                kinopoisk_id = int(item.get("kinopoiskId") or 0)
            except (TypeError, ValueError):
                continue
            if kinopoisk_id > 0:
                result.add(kinopoisk_id)
    return sorted(result)


class CatalogAuditor:
    def __init__(self, state_path: Path, api_url: str = DEFAULT_API, max_transport_attempts: int = 10):
        self.state_path = state_path.expanduser().resolve()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.api_url = api_url
        self.max_transport_attempts = max(1, int(max_transport_attempts))
        self.db = sqlite3.connect(str(self.state_path))
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            """
            CREATE TABLE IF NOT EXISTS cards (
                kinopoisk_id INTEGER PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'pending',
                checks INTEGER NOT NULL DEFAULT 0,
                source_failures INTEGER NOT NULL DEFAULT 0,
                transport_failures INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                checked_at TEXT
            )
            """
        )
        self.db.commit()

    def sync_ids(self, ids: list[int]) -> int:
        before = self.db.total_changes
        self.db.executemany("INSERT OR IGNORE INTO cards (kinopoisk_id) VALUES (?)", ((value,) for value in ids))
        self.db.commit()
        return self.db.total_changes - before

    def next_id(self) -> Optional[int]:
        row = self.db.execute(
            """
            SELECT kinopoisk_id FROM cards
            WHERE status IN ('pending', 'missing', 'transient')
              AND transport_failures < ?
            ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                     COALESCE(checked_at, ''), kinopoisk_id
            LIMIT 1
            """,
            (self.max_transport_attempts,),
        ).fetchone()
        return int(row[0]) if row else None

    def refresh(self, kinopoisk_id: int, timeout: float = 330) -> Dict[str, Any]:
        request = urllib.request.Request(
            self.api_url,
            data=json.dumps({"kinopoisk_id": kinopoisk_id, "force": True}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Refresh API вернул неожиданный ответ")
        return payload

    def record(self, kinopoisk_id: int, payload: Dict[str, Any]) -> str:
        if payload.get("deleted"):
            status = "deleted"
        elif payload.get("failures"):
            status = "missing"
        else:
            status = "available"
        self.db.execute(
            """
            UPDATE cards SET status = ?, checks = checks + 1,
                source_failures = ?, last_error = ?, checked_at = ?
            WHERE kinopoisk_id = ?
            """,
            (status, int(payload.get("failures") or 0), str(payload.get("warning") or "")[:1000], now_iso(), kinopoisk_id),
        )
        self.db.commit()
        return status

    def record_transport_error(self, kinopoisk_id: int, error: Exception) -> None:
        self.db.execute(
            """
            UPDATE cards SET status = 'transient', checks = checks + 1,
                transport_failures = transport_failures + 1,
                last_error = ?, checked_at = ? WHERE kinopoisk_id = ?
            """,
            (str(error)[:1000], now_iso(), kinopoisk_id),
        )
        self.db.commit()

    def stats(self) -> Dict[str, int]:
        counts = {row[0]: int(row[1]) for row in self.db.execute("SELECT status, COUNT(*) FROM cards GROUP BY status")}
        counts["total"] = sum(counts.values())
        return counts

    def close(self) -> None:
        self.db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Фоновая проверка всех Kinopoisk-карточек CineVault")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--delay-seconds", type=float, default=5.0)
    parser.add_argument("--max-items", type=int, default=0, help="0 — работать до завершения очереди")
    parser.add_argument("--max-transport-attempts", type=int, default=10)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.delay_seconds < 0 or args.max_items < 0 or args.max_transport_attempts < 1:
        parser.error("Некорректные параметры ограничения")

    auditor = CatalogAuditor(args.state_path, args.api_url, args.max_transport_attempts)
    try:
        added = auditor.sync_ids(catalog_ids(args.catalog_path, args.metadata_path))
        if args.status:
            print(json.dumps({"added": added, **auditor.stats()}, ensure_ascii=False))
            return 0
        processed = 0
        while not args.max_items or processed < args.max_items:
            kinopoisk_id = auditor.next_id()
            if kinopoisk_id is None:
                break
            try:
                status = auditor.record(kinopoisk_id, auditor.refresh(kinopoisk_id))
                print(f"Kinopoisk {kinopoisk_id}: {status} · {auditor.stats()}", flush=True)
            except (OSError, ValueError, RuntimeError, urllib.error.HTTPError, urllib.error.URLError) as exc:
                auditor.record_transport_error(kinopoisk_id, exc)
                print(f"Kinopoisk {kinopoisk_id}: transient · {exc}", flush=True)
            processed += 1
            if args.delay_seconds:
                time.sleep(args.delay_seconds)
        print(json.dumps(auditor.stats(), ensure_ascii=False), flush=True)
        return 0
    finally:
        auditor.close()


if __name__ == "__main__":
    raise SystemExit(main())
