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
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.catalog_tombstones import deleted_ids  # noqa: E402
from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402


DEFAULT_STATE = ROOT / "data" / "media-library" / "kinopoisk_catalog_sync.json"
# kinopoisk.dev now answers with a 301 to poiskkino.dev; call it directly.
API_URL = "https://api.poiskkino.dev/v1.4/movie"
DEFAULT_POPULAR = ROOT / "app" / "data" / "catalog_popular.json"
# Kinopoisk's own "popular right now" collections.
POPULAR_LISTS = ("popular-films", "popular-series")
SERIES_TYPES = {"tv-series", "animated-series", "anime"}
SELECT_FIELDS = (
    "id", "name", "alternativeName", "enName", "type", "isSeries", "year",
    "description", "shortDescription", "genres", "countries", "rating", "poster",
    "externalId", "movieLength", "seriesLength", "createdAt", "updatedAt",
    "votes", "persons", "ageRating", "slogan", "premiere",
)


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
    votes = row.get("votes") if isinstance(row.get("votes"), dict) else {}
    premiere = row.get("premiere") if isinstance(row.get("premiere"), dict) else {}
    people = row.get("persons") if isinstance(row.get("persons"), list) else []
    def people_by_role(role: str, limit: int) -> List[str]:
        return list(dict.fromkeys(str(person.get("name") or person.get("enName") or "").strip()
            for person in people if isinstance(person, dict) and person.get("enProfession") == role
            and (person.get("name") or person.get("enName"))))[:limit]
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
        "voteCount": positive_int(votes.get("kp")),
        "imdbVoteCount": positive_int(votes.get("imdb")),
        "actors": people_by_role("actor", 12),
        "directors": people_by_role("director", 6),
        "producers": people_by_role("producer", 6),
        "ageRating": positive_int(row.get("ageRating")) or None,
        "tagline": str(row.get("slogan") or "").strip(),
        "premiere": str(premiere.get("russia") or premiere.get("world") or "")[:10],
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


def fetch_page(session: requests.Session, token: str, page: int, limit: int,
               updated_since: Optional[date] = None, kind: str = "all",
               year: Any = None, min_votes: int = 0,
               sort_votes: bool = False, list_slug: str = "") -> Dict[str, Any]:
    params: list[tuple[str, Any]] = [
        ("page", page), ("limit", limit),
        ("sortField", "votes.kp" if sort_votes else "updatedAt" if updated_since else "id"),
        ("sortType", "-1" if sort_votes or updated_since else "1"),
    ]
    params.extend(("selectFields", field) for field in SELECT_FIELDS)
    if updated_since:
        # Kinopoisk.dev uses dd.mm.yyyy ranges for date filters. Keep an
        # overlap between daily runs so a delayed provider update is retried.
        params.append(("updatedAt", "{}-{}".format(updated_since.strftime("%d.%m.%Y"), date.today().strftime("%d.%m.%Y"))))
    if list_slug:
        params.append(("lists", list_slug))
    if year is not None:
        params.append(("year", year))
    if min_votes:
        params.append(("votes.kp", "{}-99999999".format(min_votes)))
    if kind == "series":
        params.append(("isSeries", "true"))
    elif kind == "movie":
        params.append(("isSeries", "false"))
    response = None
    last_error: Optional[requests.RequestException] = None
    for attempt in range(4):
        try:
            response = session.get(API_URL, headers={"X-API-KEY": token, "Accept": "application/json"},
                                   params=params, timeout=45)
            response.raise_for_status()
            break
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= 3:
                raise
            retry_after = positive_int(response.headers.get("Retry-After")) if response is not None and response.status_code == 429 else 0
            time.sleep(min(60, max(2 ** attempt, retry_after)))
    if response is None:
        raise last_error or RuntimeError("Kinopoisk.dev не ответил")
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


def has_core_metadata(row: Dict[str, Any]) -> bool:
    poster = row.get("poster") if isinstance(row.get("poster"), dict) else {}
    return bool(
        str(row.get("name") or "").strip()
        and len(str(row.get("description") or "").strip()) >= 60
        and str(poster.get("url") or poster.get("previewUrl") or "").strip()
        and row.get("genres")
    )


def merge_page(rows: Iterable[Dict[str, Any]], cards: Dict[int, Dict[str, Any]],
               legacy_ids: set, require_complete: bool = False) -> Dict[str, int]:
    result = {"seen": 0, "created": 0, "updated": 0, "skipped": 0}
    for row in rows:
        result["seen"] += 1
        if require_complete and not has_core_metadata(row):
            result["skipped"] += 1
            continue
        try:
            entry = catalog_entry(row)
        except ValueError:
            result["skipped"] += 1
            continue
        kp_id = entry["kinopoiskId"]
        if kp_id in legacy_ids:
            result["skipped"] += 1
            continue
        previous = cards.get(kp_id)
        if previous is not None:
            # Metadata refreshes may improve titles, posters and ratings, but
            # must never remove playback data added by another workflow.
            preserved = {
                key: previous[key]
                for key in ("videoSources", "sourceFile", "episodeDataFile", "seasons", "catalogId")
                if previous.get(key)
            }
            fresh_fields = {key: value for key, value in entry.items() if value not in (None, "", [])}
            if len(str(fresh_fields.get("description") or "")) < len(str(previous.get("description") or "")):
                fresh_fields.pop("description", None)
            cards[kp_id] = {**previous, **fresh_fields, **preserved}
            result["updated"] += 1
            continue
        cards[kp_id] = entry
        result["created"] += 1
    return result


def sync(token: str, catalog_path: Path, metadata_path: Path, state_path: Path,
         start_page: int, pages: int, limit: int, delay_seconds: float,
         dry_run: bool = False, mode: str = "backfill", lookback_days: int = 7,
         kind: str = "all", min_votes: int = 0,
         require_complete: bool = False) -> Dict[str, int]:
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    if not isinstance(legacy, list) or not isinstance(existing, list):
        raise ValueError("Файлы каталога должны содержать массивы")
    hidden = deleted_ids(state_path.parent)
    legacy_ids = {positive_int(item.get("kinopoiskId")) for item in legacy if isinstance(item, dict)} | hidden
    cards = {positive_int(item.get("kinopoiskId")): item for item in existing if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    # Drop cards the stream audit already deleted; an older copy of this file
    # may have brought them back.
    for kp_id in hidden & cards.keys():
        cards.pop(kp_id)
    state = read_json(state_path, {})
    if mode not in {"backfill", "daily"} or kind not in {"all", "movie", "series"}:
        raise ValueError("Неизвестный режим синхронизации")
    checkpoint_key = "next_page" if kind == "all" else "next_page_{}".format(kind)
    page = 1 if mode == "daily" else start_page or positive_int(state.get(checkpoint_key) if isinstance(state, dict) else 0) or 1
    updated_since = date.today() - timedelta(days=lookback_days) if mode == "daily" else None
    totals = {"pages": 0, "seen": 0, "created": 0, "updated": 0, "skipped": 0, "next_page": page}
    with requests.Session() as session:
        for _ in range(pages):
            payload = fetch_page(session, token, page, limit, updated_since=updated_since,
                                 kind=kind, min_votes=min_votes)
            rows = payload["docs"]
            if not rows:
                break
            result = merge_page(rows, cards, legacy_ids, require_complete=require_complete)
            if not dry_run:
                save_json_atomic(metadata_path, list(cards.values()))
                next_state = dict(state) if isinstance(state, dict) else {}
                next_state["provider"] = "kinopoisk.dev-v1.4"
                if mode == "backfill":
                    next_state[checkpoint_key] = page + 1
                    completion_key = "backfill_complete" if kind == "all" else "backfill_{}_complete".format(kind)
                    next_state[completion_key] = page >= positive_int(payload.get("pages")) > 0
                else:
                    next_state["last_daily_sync"] = date.today().isoformat()
                    next_state["daily_lookback_days"] = lookback_days
                save_json_atomic(state_path, next_state)
                state = next_state
            for key in ("seen", "created", "updated", "skipped"):
                totals[key] += result[key]
            totals["pages"] += 1
            page += 1
            totals["next_page"] = page
            if page > positive_int(payload.get("pages")) > 0:
                break
            if delay_seconds:
                time.sleep(delay_seconds)
    return totals


def sync_popular(token: str, catalog_path: Path, metadata_path: Path, state_path: Path,
                 popular_path: Path, max_pages: int, limit: int, delay_seconds: float,
                 min_year: int, dry_run: bool = False) -> Dict[str, int]:
    """Rank Kinopoisk's popular films and series and add missing cards.

    The ranking goes to a small separate file; catalog_imports.json (cards
    with verified streams) is never written here.
    """
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    if not isinstance(legacy, list) or not isinstance(existing, list):
        raise ValueError("Файлы каталога должны содержать массивы")
    hidden = deleted_ids(state_path.parent)
    legacy_ids = {positive_int(item.get("kinopoiskId")) for item in legacy if isinstance(item, dict)}
    cards = {positive_int(item.get("kinopoiskId")): item for item in existing
             if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))}
    for kp_id in hidden & cards.keys():
        cards.pop(kp_id)
    totals = {"pages": 0, "seen": 0, "created": 0, "updated": 0, "skipped": 0, "ranked": 0}
    ranked: List[Dict[str, Any]] = []
    seen_ids: set = set()
    with requests.Session() as session:
        for slug in POPULAR_LISTS:
            for page in range(1, max_pages + 1):
                payload = fetch_page(session, token, page, limit, sort_votes=True, list_slug=slug,
                                     year="{}-{}".format(min_year, date.today().year + 1))
                totals["pages"] += 1
                rows = [row for row in payload["docs"] if isinstance(row, dict)]
                fresh = [row for row in rows if positive_int(row.get("year")) >= min_year]
                totals["seen"] += len(rows)
                for row in fresh:
                    kp_id = positive_int(row.get("id"))
                    if not kp_id or kp_id in hidden or kp_id in seen_ids:
                        continue
                    if kp_id not in legacy_ids and not has_core_metadata(row):
                        continue
                    seen_ids.add(kp_id)
                    votes = row.get("votes") if isinstance(row.get("votes"), dict) else {}
                    ranked.append({"kinopoiskId": kp_id, "list": slug, "votes": positive_int(votes.get("kp")),
                                   "year": positive_int(row.get("year"))})
                result = merge_page(fresh, cards, legacy_ids | hidden, require_complete=True)
                for key in ("created", "updated", "skipped"):
                    totals[key] += result[key]
                if not rows or page >= positive_int(payload.get("pages")):
                    break
                if delay_seconds:
                    time.sleep(delay_seconds)
    # Kinopoisk's list order is not a popularity order, so rank by the vote
    # count: within "popular now" it separates hits from long-tail entries.
    ranked.sort(key=lambda row: (row["votes"], row["year"]), reverse=True)
    for index, row in enumerate(ranked, start=1):
        row["rank"] = index
    totals["ranked"] = len(ranked)
    if not dry_run:
        save_json_atomic(metadata_path, list(cards.values()))
        save_json_atomic(popular_path, {"provider": "kinopoisk.dev-v1.4", "lists": list(POPULAR_LISTS),
                                        "syncedAt": date.today().isoformat(), "items": ranked})
        state = read_json(state_path, {})
        next_state = dict(state) if isinstance(state, dict) else {}
        next_state["last_popular_sync"] = date.today().isoformat()
        save_json_atomic(state_path, next_state)
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Добавить или обновить карточки Kinopoisk.dev без видеопотоков")
    parser.add_argument("--mode", choices=("backfill", "daily", "popular"), default="backfill",
                        help="backfill постепенно обходит всю базу; daily обновляет последние изменения; "
                             "popular обновляет подборки «Популярные фильмы» и «Популярные сериалы»")
    parser.add_argument("--kind", choices=("all", "movie", "series"), default="all",
                        help="Ограничить обход фильмами или сериалами; контрольные точки хранятся отдельно")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--start-page", type=int, default=0, help="0 — продолжить с контрольной точки")
    parser.add_argument("--pages", type=int, default=1, help="Не более 100 страниц за запуск")
    parser.add_argument("--limit", type=int, default=100, help="До 250 карточек на страницу")
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--lookback-days", type=int, default=7,
                        help="Перекрытие обновлений для daily (1–31 день)")
    parser.add_argument("--min-votes", type=int, default=0,
                        help="Минимальное число оценок Кинопоиска для новых карточек")
    parser.add_argument("--require-complete", action="store_true",
                        help="Добавлять только карточки с описанием, постером и жанром")
    parser.add_argument("--popular-path", type=Path, default=DEFAULT_POPULAR)
    parser.add_argument("--min-year", type=int, default=date.today().year - 2,
                        help="popular: не брать в подборку тайтлы старше этого года")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.start_page < 0 or not 1 <= args.pages <= 100 or not 1 <= args.limit <= 250 or args.delay_seconds < 0 or not 1 <= args.lookback_days <= 31 or args.min_votes < 0:
        parser.error("Проверь диапазоны start-page, pages, limit, delay-seconds и lookback-days")
    token = api_token()
    if not token:
        parser.error("Задай CINEVAULT_KINOPOISK_DEV_TOKEN в окружении")
    if args.mode == "popular":
        try:
            result = sync_popular(token, args.catalog_path, args.metadata_path, args.state_path,
                                  args.popular_path, args.pages, args.limit, args.delay_seconds,
                                  args.min_year, args.dry_run)
        except (OSError, ValueError, requests.RequestException, json.JSONDecodeError) as exc:
            parser.exit(1, "Подборка популярного не обновлена: {}\n".format(type(exc).__name__))
        print("{}: популярное, страниц {pages}, просмотрено {seen}, в подборке {ranked}, добавлено {created}, "
              "обновлено {updated}, пропущено {skipped}".format("Проверено" if args.dry_run else "Сохранено", **result))
        return 0
    try:
        result = sync(token, args.catalog_path, args.metadata_path, args.state_path,
                      args.start_page, args.pages, args.limit, args.delay_seconds, args.dry_run,
                      mode=args.mode, lookback_days=args.lookback_days, kind=args.kind,
                      min_votes=args.min_votes, require_complete=args.require_complete)
    except (OSError, ValueError, requests.RequestException, json.JSONDecodeError) as exc:
        parser.exit(1, "Синхронизация остановлена на текущей странице: {}\n".format(type(exc).__name__))
    print("{}: режим {}, тип {}, страниц {{pages}}, просмотрено {{seen}}, добавлено {{created}}, обновлено {{updated}}, пропущено {{skipped}}, следующая страница {{next_page}}".format(
        "Проверено" if args.dry_run else "Сохранено", args.mode, args.kind).format(
        **result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
