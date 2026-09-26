#!/usr/bin/env python3
"""Incrementally grow the CineVault metadata catalog from TMDB.

The script intentionally imports metadata only. It never discovers, proxies or
downloads video streams. Run it daily for recent releases, and use the
backfill mode in small batches to grow the historic catalog without creating a
large request spike.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG_PATH = ROOT / "app" / "data" / "catalog_imports.json"
TMDB_API = "https://api.themoviedb.org/3"
TMDB_POSTER = "https://image.tmdb.org/t/p/w780"


def tmdb_request(path: str, token: str, params: Dict[str, Any]) -> Dict[str, Any]:
    query = urllib.parse.urlencode({key: value for key, value in params.items() if value not in (None, "")})
    request = urllib.request.Request(
        f"{TMDB_API}{path}?{query}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("TMDB вернул неожиданный ответ")
    return payload


def tmdb_genres(token: str, language: str) -> Dict[str, Dict[int, str]]:
    result: Dict[str, Dict[int, str]] = {}
    for media_type, path in (("movie", "/genre/movie/list"), ("tv", "/genre/tv/list")):
        payload = tmdb_request(path, token, {"language": language})
        result[media_type] = {
            int(item["id"]): str(item["name"]).strip().lower()
            for item in payload.get("genres", [])
            if isinstance(item, dict) and item.get("id") is not None and item.get("name")
        }
    return result


def catalog_entry(item: Dict[str, Any], media_type: str, genre_names: Dict[int, str]) -> Dict[str, Any]:
    tmdb_id = int(item.get("id") or 0)
    if tmdb_id < 1:
        raise ValueError("В ответе TMDB отсутствует ID")
    kind = "movie" if media_type == "movie" else "series"
    title = str(item.get("title") if kind == "movie" else item.get("name") or "").strip()
    if not title:
        raise ValueError("В ответе TMDB отсутствует название")
    release_date = str(item.get("release_date") if kind == "movie" else item.get("first_air_date") or "")
    try:
        year: Any = int(release_date[:4]) if len(release_date) >= 4 else "—"
    except ValueError:
        year = "—"
    genres = [genre_names[genre_id] for genre_id in item.get("genre_ids", []) if genre_id in genre_names]
    poster_path = str(item.get("poster_path") or "").strip()
    return {
        "id": f"tmdb-{kind}-{tmdb_id}",
        "kind": kind,
        "title": title,
        "originalTitle": str(item.get("original_title") if kind == "movie" else item.get("original_name") or title).strip(),
        "year": year,
        "description": str(item.get("overview") or "").strip(),
        "tags": genres,
        "genres": genres,
        "rating": float(item.get("vote_average") or 0) or None,
        "tmdbId": tmdb_id,
        "poster": "linear-gradient(145deg, #425466, #171b28)",
        "posterImage": f"{TMDB_POSTER}{poster_path}" if poster_path.startswith("/") else "",
        "providerUrl": f"https://www.themoviedb.org/{media_type}/{tmdb_id}",
        "providerName": "TMDB · метаданные",
        "providerNote": "Карточка обновлена из TMDB. Видеопоток добавляется только из отдельного разрешённого источника.",
        "videoSources": [],
    }


def merge_catalog(existing: Iterable[Dict[str, Any]], incoming: Iterable[Dict[str, Any]]) -> tuple[list[Dict[str, Any]], int, int]:
    catalog = [dict(item) for item in existing if isinstance(item, dict)]
    positions = {str(item.get("id", "")): index for index, item in enumerate(catalog)}
    created = updated = 0
    for fresh in incoming:
        identifier = str(fresh["id"])
        index = positions.get(identifier)
        if index is None:
            catalog.append(fresh)
            positions[identifier] = len(catalog) - 1
            created += 1
            continue
        previous = catalog[index]
        # Preserve manually added Kinopoisk IDs and every attached playback
        # source. Metadata sync must never break an already playable card.
        preserved = {key: previous[key] for key in ("kinopoiskId", "catalogId", "videoSources", "sourceFile", "episodeDataFile", "seasons") if previous.get(key)}
        catalog[index] = {**previous, **fresh, **preserved}
        updated += 1
    return catalog, created, updated


def load_catalog(path: Path) -> list[Dict[str, Any]]:
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("catalog_imports.json должен содержать массив")
    return [item for item in payload if isinstance(item, dict)]


def discover_params(mode: str, media_type: str, page: int, today: date) -> Dict[str, Any]:
    params: Dict[str, Any] = {"language": "ru-RU", "include_adult": "false", "page": page}
    if mode == "daily":
        date_field = "primary_release_date" if media_type == "movie" else "first_air_date"
        params.update({"sort_by": f"{date_field}.desc", f"{date_field}.gte": (today - timedelta(days=21)).isoformat(), f"{date_field}.lte": (today + timedelta(days=90)).isoformat()})
    else:
        params.update({"sort_by": "popularity.desc", "vote_count.gte": 20})
    return params


def sync(token: str, catalog_path: Path, mode: str, pages: int, dry_run: bool) -> Dict[str, int]:
    genre_map = tmdb_genres(token, "ru-RU")
    fresh: list[Dict[str, Any]] = []
    today = date.today()
    for media_type in ("movie", "tv"):
        for page in range(1, pages + 1):
            payload = tmdb_request(f"/discover/{media_type}", token, discover_params(mode, media_type, page, today))
            results = payload.get("results", [])
            if not isinstance(results, list) or not results:
                break
            for item in results:
                if not isinstance(item, dict) or item.get("adult"):
                    continue
                try:
                    fresh.append(catalog_entry(item, media_type, genre_map[media_type]))
                except ValueError:
                    continue
    catalog, created, updated = merge_catalog(load_catalog(catalog_path), fresh)
    if not dry_run:
        catalog_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = catalog_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(catalog_path)
    return {"seen": len(fresh), "created": created, "updated": updated, "total": len(catalog)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Постепенно расширить CineVault-каталог из TMDB")
    parser.add_argument("--mode", choices=("daily", "backfill"), default="daily")
    parser.add_argument("--pages", type=int, default=2, help="Страниц фильмов и сериалов за запуск (1–50)")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG_PATH)
    parser.add_argument("--token", default=os.environ.get("CINEVAULT_TMDB_API_TOKEN", ""), help="TMDB API Read Access Token; лучше использовать переменную окружения")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    token = str(args.token).strip()
    if not token:
        parser.error("задайте CINEVAULT_TMDB_API_TOKEN")
    if not 1 <= args.pages <= 50:
        parser.error("--pages должен быть от 1 до 50")
    try:
        result = sync(token, args.catalog_path.resolve(), args.mode, args.pages, args.dry_run)
    except (OSError, ValueError, urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as exc:
        print(f"Ошибка синхронизации TMDB: {exc}", file=sys.stderr)
        return 1
    action = "Проверено" if args.dry_run else "Синхронизировано"
    print(f"{action}: просмотрено {result['seen']}, добавлено {result['created']}, обновлено {result['updated']}, всего карточек {result['total']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
