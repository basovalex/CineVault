#!/usr/bin/env python3
"""Enrich existing Kinopoisk cards in batches without rewriting playback data."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.catalog_tombstones import deleted_ids  # noqa: E402
from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402
from tools.sync_kinopoisk_dev_catalog import (  # noqa: E402
    API_URL, SELECT_FIELDS, api_token, merge_page, positive_int, save_json_atomic,
)

DEFAULT_STATE = ROOT / "data" / "media-library" / "kinopoisk_metadata_enrichment.json"
# Kinopoisk.dev answers these once the daily request quota is spent.
QUOTA_STATUSES = {401, 402, 403, 429}


def quota_exhausted(exc: Exception) -> bool:
    return getattr(getattr(exc, "response", None), "status_code", 0) in QUOTA_STATUSES


def needs_enrichment(item: Dict[str, Any]) -> bool:
    return not (
        positive_int(item.get("voteCount"))
        and len(str(item.get("description") or "").strip()) >= 60
        and str(item.get("posterImage") or "").strip()
        and item.get("genres")
    )


def candidate_ids(legacy: Iterable[Dict[str, Any]], existing: Iterable[Dict[str, Any]]) -> List[int]:
    cards = {positive_int(item.get("kinopoiskId")): dict(item) for item in existing
             if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    for item in legacy:
        if not isinstance(item, dict):
            continue
        kp_id = positive_int(item.get("kinopoiskId"))
        if not kp_id:
            continue
        merged = dict(item)
        for key, value in cards.get(kp_id, {}).items():
            if merged.get(key) in (None, "", [], 0) or key == "description" and len(str(merged.get(key) or "")) < 60 and len(str(value or "")) >= 60:
                merged[key] = value
        cards[kp_id] = merged
    return sorted(kp_id for kp_id, item in cards.items() if needs_enrichment(item))


def fetch_ids(session: requests.Session, token: str, identifiers: List[int]) -> List[Dict[str, Any]]:
    params: List[tuple[str, Any]] = [("id", ",".join(map(str, identifiers))),
                                     ("page", 1), ("limit", len(identifiers))]
    params.extend(("selectFields", field) for field in SELECT_FIELDS)
    last_error: Optional[Exception] = None
    for attempt in range(4):
        try:
            response = session.get(API_URL, headers={"X-API-KEY": token, "Accept": "application/json"},
                                   params=params, timeout=60)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("docs"), list):
                raise ValueError("Провайдер вернул неожиданный формат списка")
            return [row for row in payload["docs"] if isinstance(row, dict)]
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt >= 3 or getattr(getattr(exc, "response", None), "status_code", 0) in {401, 402, 403}:
                raise
            status = getattr(getattr(exc, "response", None), "status_code", 0)
            retry_after = positive_int(getattr(getattr(exc, "response", None), "headers", {}).get("Retry-After")) if status == 429 else 0
            time.sleep(min(60, max(2 ** attempt, retry_after)))
    raise RuntimeError("Kinopoisk.dev не ответил") from last_error


def enrich(token: str, catalog_path: Path, metadata_path: Path, state_path: Path,
           batch_size: int, batches: int, delay_seconds: float,
           dry_run: bool = False, resume: bool = False) -> Dict[str, int]:
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    state = read_json(state_path, {})
    if not isinstance(legacy, list) or not isinstance(existing, list) or not isinstance(state, dict):
        raise ValueError("Каталог или контрольная точка имеют неверный формат")
    cursor = positive_int(state.get("last_kinopoisk_id")) if resume else 0
    hidden = deleted_ids(state_path.parent)
    pending = [kp_id for kp_id in candidate_ids(legacy, existing) if kp_id > cursor and kp_id not in hidden]
    cards = {positive_int(item.get("kinopoiskId")): item for item in existing
             if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    totals = {"pending": len(pending), "processed": 0, "fetched": 0, "created": 0,
              "updated": 0, "last_kinopoisk_id": cursor, "quota_exhausted": False}
    with requests.Session() as session:
        for offset in range(0, min(len(pending), batch_size * batches), batch_size):
            identifiers = pending[offset:offset + batch_size]
            try:
                rows = fetch_ids(session, token, identifiers)
            except requests.HTTPError as exc:
                if not quota_exhausted(exc):
                    raise
                # Saved batches stay saved; the next run resumes from here.
                totals["quota_exhausted"] = True
                break
            result = merge_page(rows, cards, hidden)
            if not dry_run:
                save_json_atomic(metadata_path, list(cards.values()))
                cursor = identifiers[-1]
                state = {**state, "provider": "kinopoisk.dev-v1.4", "last_kinopoisk_id": cursor,
                         "complete": offset + len(identifiers) >= len(pending)}
                save_json_atomic(state_path, state)
            totals["processed"] += len(identifiers)
            totals["fetched"] += len(rows)
            totals["created"] += result["created"]
            totals["updated"] += result["updated"]
            totals["last_kinopoisk_id"] = identifiers[-1]
            if delay_seconds:
                time.sleep(delay_seconds)
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Дополнить метаданные существующих карточек Kinopoisk")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--batches", type=int, default=10)
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 250 or not 1 <= args.batches <= 500 or args.delay_seconds < 0:
        parser.error("Проверь диапазоны batch-size, batches и delay-seconds")
    token = api_token()
    if not token:
        parser.error("Задай CINEVAULT_KINOPOISK_DEV_TOKEN в окружении")
    try:
        result = enrich(token, args.catalog_path, args.metadata_path, args.state_path,
                        args.batch_size, args.batches, args.delay_seconds,
                        args.dry_run, args.resume)
    except (OSError, ValueError, requests.RequestException) as exc:
        parser.exit(1, "Обогащение остановлено на последней сохранённой пачке: {}\n".format(type(exc).__name__))
    print("Нужно {}, проверено {}, найдено {}, новых метаданных {}, обновлено {}, последний ID {}{}".format(
        result["pending"], result["processed"], result["fetched"], result["created"],
        result["updated"], result["last_kinopoisk_id"],
        " · дневной лимит API исчерпан, продолжу в следующий запуск" if result["quota_exhausted"] else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
