#!/usr/bin/env python3
"""Grow CineVault's metadata-only catalog from paginated Kinopoisk.dev results.

No playback lookup is performed. Each successfully saved page advances a local
checkpoint, so a later run continues instead of repeating the whole catalog.
Coverage is limited to the provider's own index and API access conditions.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

import requests
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402


DEFAULT_STATE = ROOT / "data" / "media-library" / "kinopoisk_catalog_sync.json"
API_URL = "https://api.kinopoisk.dev/v1.4/movie"
SERIES_TYPES = {"tv-series", "animated-series", "anime"}


def text_list(value: Any) -> List[str]:
    return [str(item.get("name") or "").strip() for item in value if isinstance(item, dict) and item.get("name")] if isinstance(value, list) else []


def positive_int(value: Any) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return 0
    return result if result > 0 else 0


def rating(value: Any) -> Any:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def catalog_entry(row: Dict[str, Any]) -> Dict[str, Any]:
    kp_id = positive_int(row.get("id"))
    title = str(row.get("name") or "").strip()
    if not kp_id or not title:
        raise ValueError("Kinopoisk ID и название обязательны")
    kind = "series" if row.get("type") in SERIES_TYPES or row.get("isSeries") is True else "movie"
    url_kind = "series" if kind == "series" else "film"
    ratings = row.get("rating") if isinstance(row.get("rating"), dict) else {}
    image = row.get("poster") if isinstance(row.get("poster"), dict) else {}
    external_ids = row.get("externalId") if isinstance(row.get("externalId"), dict) else {}
    genres = text_list(row.get("genres"))
    entry = {
        "id": "kinopoisk-{}".format(kp_id), "kinopoiskId": kp_id,
        "kind": kind, "title": title,
        "originalTitle": str(row.get("alternativeName") or row.get("enName") or title).strip(),
        "year": positive_int(row.get("year")) or None,
        "description": str(row.get("description") or row.get("shortDescription") or "").strip(),
        "genres": genres, "tags": genres,
        "countries": text_list(row.get("countries")),
        "rating": rating(ratings.get("kp")),
        "ratingKinopoisk": rating(ratings.get("kp")),
        "imdbRating": rating(ratings.get("imdb")),
        "runtime": positive_int(row.get("seriesLength") if kind == "series" else row.get("movieLength")) or None,
        "posterImage": str(image.get("url") or image.get("previewUrl") or "").strip(),
        "providerUrl": "https://www.kinopoisk.ru/{}/{}/".format(url_kind, kp_id),
        "providerName": "Kinopoisk.dev · метаданные",
        "providerNote": "Карточка содержит метаданные. Видеопоток запрашивается при открытии.",
        "videoSources": [],
    }
    if kind == "series":
        entry["seasons"] = []
    tmdb_id = positive_int(external_ids.get("tmdb"))
    if tmdb_id:
        entry["tmdbId"] = tmdb_id
    return entry


def fetch_page(session: requests.Session, token: str, page: int, limit: int) -> Dict[str, Any]:
    response = session.get(API_URL, headers={"X-API-KEY": token, "Accept": "application/json"},
                           params={"page": page, "limit": limit, "sortField": "id", "sortType": "1"}, timeout=45)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("docs"), list):
        raise ValueError("Провайдер вернул неожиданный формат списка")
    return payload


def save_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def api_token() -> str:
    token = os.environ.get("CINEVAULT_KINOPOISK_DEV_TOKEN", "").strip()
    if token:
        return token
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "CINEVAULT_KINOPOISK_DEV_TOKEN":
            return value.strip().strip('"\'')
    return ""


def merge_page(rows: Iterable[Dict[str, Any]], cards: Dict[int, Dict[str, Any]], legacy_ids: set) -> Dict[str, int]:
    result = {"seen": 0, "created": 0, "skipped": 0}
    for row in rows:
        result["seen"] += 1
        try:
            entry = catalog_entry(row)
        except ValueError:
            result["skipped"] += 1
            continue
        kp_id = entry["kinopoiskId"]
        if kp_id in legacy_ids or kp_id in cards:
            result["skipped"] += 1
            continue
        cards[kp_id] = entry
        result["created"] += 1
    return result


def sync(token: str, catalog_path: Path, metadata_path: Path, state_path: Path,
         start_page: int, pages: int, limit: int, delay_seconds: float,
         dry_run: bool = False) -> Dict[str, int]:
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    if not isinstance(legacy, list) or not isinstance(existing, list):
        raise ValueError("Файлы каталога должны содержать массивы")
    legacy_ids = {positive_int(item.get("kinopoiskId")) for item in legacy if isinstance(item, dict)}
    cards = {positive_int(item.get("kinopoiskId")): item for item in existing if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    state = read_json(state_path, {})
    page = start_page or positive_int(state.get("next_page") if isinstance(state, dict) else 0) or 1
    totals = {"pages": 0, "seen": 0, "created": 0, "skipped": 0, "next_page": page}
    with requests.Session() as session:
        for _ in range(pages):
            payload = fetch_page(session, token, page, limit)
            rows = payload["docs"]
            if not rows:
                break
            result = merge_page(rows, cards, legacy_ids)
            if not dry_run:
                save_json_atomic(metadata_path, list(cards.values()))
                save_json_atomic(state_path, {"provider": "kinopoisk.dev-v1.4", "next_page": page + 1})
            for key in ("seen", "created", "skipped"):
                totals[key] += result[key]
            totals["pages"] += 1
            page += 1
            totals["next_page"] = page
            if page > positive_int(payload.get("pages")) > 0:
                break
            if delay_seconds:
                time.sleep(delay_seconds)
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Постранично добавить карточки Kinopoisk.dev без видеопотоков")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--start-page", type=int, default=0, help="0 — продолжить с контрольной точки")
    parser.add_argument("--pages", type=int, default=1, help="Не более 20 страниц за запуск")
    parser.add_argument("--limit", type=int, default=100, help="До 250 карточек на страницу")
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.start_page < 0 or not 1 <= args.pages <= 20 or not 1 <= args.limit <= 250 or args.delay_seconds < 0:
        parser.error("Проверь диапазоны start-page, pages, limit и delay-seconds")
    token = api_token()
    if not token:
        parser.error("Задай CINEVAULT_KINOPOISK_DEV_TOKEN в окружении")
    try:
        result = sync(token, args.catalog_path, args.metadata_path, args.state_path,
                      args.start_page, args.pages, args.limit, args.delay_seconds, args.dry_run)
    except (OSError, ValueError, requests.RequestException, json.JSONDecodeError) as exc:
        parser.exit(1, "Синхронизация остановлена на текущей странице: {}\n".format(type(exc).__name__))
    print("{}: страниц {pages}, просмотрено {seen}, добавлено {created}, пропущено {skipped}, следующая страница {next_page}".format(
        "Проверено" if args.dry_run else "Сохранено", **result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
