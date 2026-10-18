#!/usr/bin/env python3
"""Add well-described series from each year without replacing playback data."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402
from tools.sync_kinopoisk_dev_catalog import (  # noqa: E402
    DEFAULT_STATE, api_token, catalog_entry, fetch_page, merge_page,
    positive_int, save_json_atomic,
)


def eligible_series(row: Dict[str, Any], year: int, min_votes: int) -> bool:
    if not isinstance(row, dict) or row.get("isSeries") is not True or positive_int(row.get("year")) != year:
        return False
    votes = row.get("votes") if isinstance(row.get("votes"), dict) else {}
    poster = row.get("poster") if isinstance(row.get("poster"), dict) else {}
    return (
        positive_int(votes.get("kp")) >= min_votes
        and bool(str(row.get("name") or "").strip())
        and len(str(row.get("description") or "").strip()) >= 60
        and bool(str(poster.get("url") or poster.get("previewUrl") or "").strip())
        and bool(row.get("genres"))
    )


def curate(token: str, catalog_path: Path, metadata_path: Path, state_path: Path,
           start_year: int, end_year: int, target: int, min_votes: int,
           candidate_pages: int, delay_seconds: float, dry_run: bool = False,
           resume: bool = False) -> Dict[str, Any]:
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    state = read_json(state_path, {})
    if not isinstance(legacy, list) or not isinstance(existing, list) or not isinstance(state, dict):
        raise ValueError("Каталог или контрольная точка имеют неверный формат")
    legacy_cards = {positive_int(item.get("kinopoiskId")): item for item in legacy
                    if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    cards = {positive_int(item.get("kinopoiskId")): item for item in existing
             if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    if resume and state.get("curated_series_target") == target and state.get("curated_series_min_votes") == min_votes:
        start_year = max(start_year, positive_int(state.get("curated_series_last_year")) + 1)
    result: Dict[str, Any] = {"selected": 0, "created": 0, "updated": 0, "years": {}}
    with requests.Session() as session:
        for year in range(start_year, end_year + 1):
            selected: Dict[int, Dict[str, Any]] = {}
            for page in range(1, candidate_pages + 1):
                payload = fetch_page(session, token, page, 250, kind="series",
                                     year=year, min_votes=min_votes, sort_votes=True)
                for row in payload["docs"]:
                    if eligible_series(row, year, min_votes):
                        legacy_card = legacy_cards.get(positive_int(row["id"]))
                        if legacy_card and (legacy_card.get("kind") != "series" or positive_int(legacy_card.get("year")) not in (0, year)):
                            continue
                        selected.setdefault(positive_int(row["id"]), row)
                    if len(selected) >= target:
                        break
                if len(selected) >= target or page >= positive_int(payload.get("pages")) > 0 or not payload["docs"]:
                    break
                if delay_seconds:
                    time.sleep(delay_seconds)
            selected_rows = list(selected.values())[:target]
            merged = merge_page(selected_rows, cards, set())
            result["selected"] += len(selected_rows)
            result["created"] += merged["created"]
            result["updated"] += merged["updated"]
            result["years"][str(year)] = len(selected_rows)
            if not dry_run:
                save_json_atomic(metadata_path, list(cards.values()))
                state = {**state, "curated_series_last_year": year,
                         "curated_series_target": target, "curated_series_min_votes": min_votes}
                save_json_atomic(state_path, state)
            if delay_seconds:
                time.sleep(delay_seconds)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Добавить качественные сериалы по годам без видеопотоков")
    parser.add_argument("--start-year", type=int, default=2000)
    parser.add_argument("--end-year", type=int, default=2026)
    parser.add_argument("--target", type=int, default=100)
    parser.add_argument("--min-votes", type=int, default=100)
    parser.add_argument("--candidate-pages", type=int, default=3)
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--resume", action="store_true", help="Продолжить с года после последнего сохранённого")
    args = parser.parse_args()
    if not 1900 <= args.start_year <= args.end_year <= 2100 or not 1 <= args.target <= 250 or args.min_votes < 1 or not 1 <= args.candidate_pages <= 20 or args.delay_seconds < 0:
        parser.error("Проверь диапазоны годов, target, min-votes, candidate-pages и delay-seconds")
    token = api_token()
    if not token:
        parser.error("Задай CINEVAULT_KINOPOISK_DEV_TOKEN в окружении")
    try:
        result = curate(token, args.catalog_path, args.metadata_path, args.state_path,
                        args.start_year, args.end_year, args.target, args.min_votes,
                        args.candidate_pages, args.delay_seconds, args.dry_run, args.resume)
    except (OSError, ValueError, requests.RequestException) as exc:
        parser.exit(1, "Пополнение остановлено: {}\n".format(type(exc).__name__))
    print("{} сериалов, добавлено {}, обновлено {}".format(result["selected"], result["created"], result["updated"]))
    print("По годам: " + ", ".join("{}: {}".format(year, count) for year, count in result["years"].items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
