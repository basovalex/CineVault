#!/usr/bin/env python3
"""Build the "what people watch now" list from TMDB and match it to our catalogue.

The result is a static file, so the first screen does not wait for SQLite and
the browser does not need TMDB, which is unreachable on some networks.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "app" / "data" / "world_trending.json"
TMDB_BASE = "https://api.themoviedb.org/3"
LIST_LIMIT = 100
MIN_MATCHES = 20
CATALOG_BATCH = 50
RECORDS_TO_MATCH = 260
TITLE_SEARCH_PAUSE_SECONDS = 0.15
KINOPOISK_PAGES = 3
RANK_FUSION_CONSTANT = 60


def tmdb_get(path: str, page: int, token: str, proxy: str) -> Dict[str, Any]:
    url = f"{TMDB_BASE}{path}?{urllib.parse.urlencode({'page': page, 'language': 'ru-RU'})}"
    # The token goes through stdin so that it never appears in the process list.
    config = f'header = "Authorization: Bearer {token}"\n'
    command = ["curl", "-sS", "--fail", "--max-time", "25", "--config", "-", url]
    if proxy:
        command[1:1] = ["--proxy", proxy]
    done = subprocess.run(command, input=config, capture_output=True, text=True, check=True)
    return json.loads(done.stdout)


def ranked_records(pages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: Dict[int, Dict[str, Any]] = {}
    for page in pages:
        for record in page.get("results") or []:
            tmdb_id = record.get("id")
            if isinstance(tmdb_id, int) and tmdb_id not in seen:
                released_on = str(record.get("release_date") or record.get("first_air_date") or "")
                seen[tmdb_id] = {
                    "id": tmdb_id,
                    "title": record.get("title") or record.get("name") or "",
                    "original": record.get("original_title") or record.get("original_name") or "",
                    "year": int(released_on[:4]) if released_on[:4].isdigit() else 0,
                    "popularity": float(record.get("popularity") or 0),
                }
    return sorted(seen.values(), key=lambda record: -record["popularity"])


def normalized(value: Any) -> str:
    return "".join(character for character in str(value or "").casefold() if character.isalnum())


def matches_record(card: Dict[str, Any], record: Dict[str, Any]) -> bool:
    names = {normalized(card.get("originalTitle")), normalized(card.get("title"))} - {""}
    wanted = {normalized(record["original"]), normalized(record["title"])} - {""}
    year = int(card.get("year") or 0)
    return bool(names & wanted) and bool(year) and bool(record["year"]) and abs(year - record["year"]) <= 1


def catalog_get(base: str, query: Dict[str, str]) -> List[Dict[str, Any]]:
    url = f"{base}/api/catalog?{urllib.parse.urlencode(query)}"
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response).get("items") or []


def cards_by_tmdb_id(base: str, records: List[Dict[str, Any]]) -> Dict[int, List[Dict[str, Any]]]:
    found: Dict[int, List[Dict[str, Any]]] = {}
    for start in range(0, len(records), CATALOG_BATCH):
        batch = [str(record["id"]) for record in records[start:start + CATALOG_BATCH]]
        for card in catalog_get(base, {"tmdb_ids": ",".join(batch), "limit": str(CATALOG_BATCH)}):
            if card.get("tmdbId"):
                found.setdefault(int(card["tmdbId"]), []).append(card)
    return found


def card_by_title(base: str, record: Dict[str, Any], kind: str) -> Dict[str, Any] | None:
    for name in dict.fromkeys(filter(None, (record["original"], record["title"]))):
        try:
            items = catalog_get(base, {"search": name, "limit": "20", "type": kind})
        except (OSError, ValueError):
            continue
        finally:
            time.sleep(TITLE_SEARCH_PAUSE_SECONDS)
        match = next((card for card in items if card.get("kind") == kind and matches_record(card, record)), None)
        if match:
            return match
    return None


def released(card: Dict[str, Any], today: date) -> bool:
    premiere = str(card.get("premiere") or "")[:10]
    try:
        return date.fromisoformat(premiere) <= today
    except ValueError:
        return int(card.get("year") or 0) <= today.year


def compact_card(card: Dict[str, Any]) -> Dict[str, Any]:
    compact = {key: value for key, value in card.items() if key not in {"producers", "providerNote", "tagline"}}
    if isinstance(compact.get("actors"), list):
        compact["actors"] = compact["actors"][:8]
    return compact


def ordered_cards(base: str, records: List[Dict[str, Any]], kind: str, today: date) -> List[Dict[str, Any]]:
    by_id = cards_by_tmdb_id(base, records)
    result: List[Dict[str, Any]] = []
    used = set()
    for record in records[:RECORDS_TO_MATCH]:
        match = next((card for card in by_id.get(record["id"], []) if card.get("kind") == kind), None) or card_by_title(base, record, kind)
        if match and match["id"] not in used and match.get("posterImage") and released(match, today):
            used.add(match["id"])
            result.append(compact_card(match))
        if len(result) >= LIST_LIMIT:
            break
    return result


def kinopoisk_cards(base: str, kind: str, today: date) -> List[Dict[str, Any]]:
    cards: List[Dict[str, Any]] = []
    for page in range(1, KINOPOISK_PAGES + 1):
        items = catalog_get(base, {"collection": "trending", "sort": "popular", "type": kind, "limit": str(CATALOG_BATCH), "page": str(page)})
        cards += [compact_card(card) for card in items if card.get("kind") == kind and card.get("posterImage") and released(card, today)]
    return cards


def fuse_ranked(world: List[Dict[str, Any]], kinopoisk: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    """Combine two real popularity rankings by position, with no rule about country.

    TMDB barely sees the Russian-speaking audience and Kinopoisk is mostly that
    audience, so neither alone answers "what is being watched". A title high in
    both rises above a title that leads only one of them.
    """
    scores: Dict[str, float] = {}
    cards: Dict[str, Dict[str, Any]] = {}
    for ranking in (world, kinopoisk):
        for position, card in enumerate(ranking):
            scores[card["id"]] = scores.get(card["id"], 0) + 1 / (RANK_FUSION_CONSTANT + position)
            cards.setdefault(card["id"], card)
    return [cards[card_id] for card_id in sorted(scores, key=lambda card_id: -scores[card_id])[:limit]]


def collect(kind_path: str, pages: int, token: str, proxy: str) -> List[Dict[str, Any]]:
    responses = []
    for path in (f"/trending/{kind_path}/week", f"/{kind_path}/popular"):
        for page in range(1, pages + 1):
            responses.append(tmdb_get(path, page, token, proxy))
            time.sleep(0.2)
    return ranked_records(responses)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--catalog-base", default="http://127.0.0.1:8081")
    parser.add_argument("--proxy", default=os.environ.get("CINEVAULT_TMDB_PROXY", "socks5h://127.0.0.1:1080"))
    parser.add_argument("--pages", type=int, default=8)
    args = parser.parse_args()
    token = (os.environ.get("CINEVAULT_TMDB_API_TOKEN") or os.environ.get("CINEVAULT_TMDB_BROWSER_TOKEN") or "").strip()
    if not token:
        print("CINEVAULT_TMDB_API_TOKEN is not set", file=sys.stderr)
        return 2
    base = args.catalog_base.rstrip("/")
    today = date.today()
    movies = fuse_ranked(ordered_cards(base, collect("movie", args.pages, token, args.proxy), "movie", today), kinopoisk_cards(base, "movie", today), LIST_LIMIT)
    series = fuse_ranked(ordered_cards(base, collect("tv", args.pages, token, args.proxy), "series", today), kinopoisk_cards(base, "series", today), LIST_LIMIT)
    if len(movies) + len(series) < MIN_MATCHES:
        print(f"Only {len(movies) + len(series)} titles matched; keeping the previous list", file=sys.stderr)
        return 1
    payload = {"syncedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "tmdb+kinopoisk", "movies": movies, "series": series}
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o644)
    temporary.replace(args.output)
    print(f"movies={len(movies)} series={len(series)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
