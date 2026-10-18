#!/usr/bin/env python3
"""Import the whole Alloha (player 2) library as catalog cards.

The apbugall API lists every title Alloha can play, newest first, 30 per page,
with full metadata. Cards are written as JSON lines to catalog_alloha.jsonl,
which the catalog index streams; nothing here is held in memory beyond the set
of IDs already written.

The same API serves player 1 stream refreshes, so pages are fetched slowly and
any error pauses the run instead of retrying hard.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

API_URL = "https://api.apbugall.org/"
DEFAULT_OUTPUT = ROOT / "app" / "data" / "catalog_alloha.jsonl"
DEFAULT_STATE = ROOT / "data" / "media-library" / "alloha_catalog_sync.json"
HEADERS = {"origin": "https://fbfind.life", "referer": "https://fbfind.life/", "user-agent": "Mozilla/5.0 CineVault/1.0",
           "accept": "application/json"}
SERIES_WORDS = ("сериал", "шоу")


def api_token() -> str:
    token = os.environ.get("CINEVAULT_APBUGALL_TOKEN", "").strip()
    if token:
        return token
    env_path = ROOT / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip() == "CINEVAULT_APBUGALL_TOKEN":
                return value.strip().strip("\"'")
    return ""


def _text(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    return "" if text in {"None", "null"} else text


def _names(value: Any, limit: int = 12) -> list[str]:
    return [part.strip() for part in _text(value).split(",") if part.strip()][:limit]


def _number(value: Any, kind=float) -> Any:
    try:
        result = kind(_text(value))
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _minutes(value: Any) -> Optional[int]:
    match = re.fullmatch(r"(\d+):(\d{2})(?::\d{2})?", _text(value))
    if not match:
        return _number(value, int)
    return int(match.group(1)) * 60 + int(match.group(2)) or None


def card_from_alloha(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    kp_id = _number(row.get("id_kp"), int)
    title = _text(row.get("name"))
    if not kp_id or not title:
        return None
    category = _text(row.get("category")).casefold()
    kind = "series" if any(word in category for word in SERIES_WORDS) else "movie"
    genres = [genre.casefold() for genre in _names(row.get("genre"))]
    if "аниме" in category and "аниме" not in genres:
        genres.append("аниме")
    if "мульт" in category and "мультфильм" not in genres:
        genres.append("мультфильм")
    translations = row.get("translation_iframe")
    voices = []
    if isinstance(translations, dict):
        voices = [str(value.get("name") or "").strip() for value in translations.values() if isinstance(value, dict) and value.get("name")]
    if not voices:
        voices = _names(row.get("translation"), 40)
    card = {
        "id": "kinopoisk-{}".format(kp_id), "kinopoiskId": kp_id, "kind": kind, "title": title,
        "originalTitle": _text(row.get("original_name")) or title, "year": _number(row.get("year"), int),
        "description": _text(row.get("description")), "tagline": _text(row.get("tagline")),
        "genres": genres, "tags": genres, "countries": _names(row.get("country"), 6),
        "actors": _names(row.get("actors")), "directors": _names(row.get("directors"), 6),
        "producers": _names(row.get("producers"), 6), "ageRating": _number(row.get("age_restrictions"), int),
        "premiere": (_text(row.get("premiere_ru")) or _text(row.get("premiere")))[:10],
        "rating": _number(row.get("rating_kp")), "ratingKinopoisk": _number(row.get("rating_kp")),
        "imdbRating": _number(row.get("rating_imdb")), "runtime": _minutes(row.get("time")),
        "posterImage": _text(row.get("poster")), "quality": _text(row.get("quality")),
        "voices": voices[:40], "allohaAddedAt": _text(row.get("date")),
        "providerUrl": "https://www.kinopoisk.ru/{}/{}/".format("series" if kind == "series" else "film", kp_id),
        "providerName": "Alloha · каталог плеера 2",
        "providerNote": "Карточка из библиотеки плеера 2. Видеопоток запрашивается при открытии.",
        "videoSources": [],
    }
    if kind == "series":
        card["seasons"] = []
        card["lastSeason"] = _number(row.get("last_season"), int)
        card["lastEpisode"] = _number(row.get("last_episode"), int)
    tmdb_id = _number(row.get("id_tmdb"), int)
    if tmdb_id:
        card["tmdbId"] = tmdb_id
    imdb_id = _text(row.get("id_imdb"))
    if re.fullmatch(r"tt\d+", imdb_id):
        card["imdbId"] = imdb_id
    return {key: value for key, value in card.items() if value not in (None, "", []) or key in ("videoSources", "seasons")}


class RateLimited(RuntimeError):
    pass


def fetch_page(session: requests.Session, token: str, page: int) -> Dict[str, Any]:
    response = session.post(API_URL, params={"token": token, "list": "all", "page": page}, headers=HEADERS, timeout=40)
    if response.status_code == 429:
        raise RateLimited("HTTP 429")
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("status") != "success" or not isinstance(payload.get("data"), list):
        raise ValueError("Неожиданный ответ API: {}".format(str(payload)[:200]))
    return payload


def read_lines(path: Path) -> Iterator[Dict[str, Any]]:
    try:
        handle = path.open(encoding="utf-8")
    except FileNotFoundError:
        return
    with handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def save_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _fetch_with_pauses(session: requests.Session, token: str, page: int) -> Dict[str, Any]:
    while True:
        try:
            return fetch_page(session, token, page)
        except RateLimited:
            print("Alloha API: лимит запросов, пауза 5 минут", flush=True)
        except (requests.RequestException, ValueError) as exc:
            print("Alloha API: {} — пауза 5 минут".format(exc), flush=True)
        time.sleep(300)


def sync_full(token: str, output: Path, state_path: Path, max_pages: int, delay: float) -> Dict[str, int]:
    """Walk every page, appending cards and checkpointing as it goes."""
    state = _read_state(state_path)
    page = int(state.get("full_next_page") or 1)
    written = {card.get("kinopoiskId") for card in read_lines(output)}
    totals = {"pages": 0, "added": 0}
    output.parent.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session, output.open("a", encoding="utf-8") as handle:
        while totals["pages"] < max_pages:
            payload = _fetch_with_pauses(session, token, page)
            totals["pages"] += 1
            for row in payload["data"]:
                card = card_from_alloha(row) if isinstance(row, dict) else None
                if card is None or card["kinopoiskId"] in written:
                    continue
                written.add(card["kinopoiskId"])
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")
                totals["added"] += 1
            next_page = payload.get("next_page")
            state["full_next_page"] = int(next_page) if next_page else page
            if not next_page:
                state["full_complete"] = date.today().isoformat()
            if totals["pages"] % 10 == 0 or not next_page:
                handle.flush()
                os.fsync(handle.fileno())
                state["cards"] = len(written)
                save_state(state_path, state)
            if totals["pages"] % 100 == 0:
                print("Alloha: страница {}, всего карточек {}".format(page, len(written)), flush=True)
            if not next_page:
                break
            page = int(next_page)
            if delay:
                time.sleep(delay)
    state["cards"] = len(written)
    save_state(state_path, state)
    return {**totals, "cards": len(written)}


def sync_recent(token: str, output: Path, state_path: Path, max_pages: int, delay: float) -> Dict[str, int]:
    """Re-read the newest pages and stop once a page holds only known titles."""
    known = {card.get("kinopoiskId") for card in read_lines(output)}
    fresh_cards: Dict[int, Dict[str, Any]] = {}
    totals = {"pages": 0, "added": 0}
    with requests.Session() as session:
        page = 1
        while totals["pages"] < max_pages:
            payload = _fetch_with_pauses(session, token, page)
            totals["pages"] += 1
            unseen = 0
            for row in payload["data"]:
                card = card_from_alloha(row) if isinstance(row, dict) else None
                if card is None:
                    continue
                if card["kinopoiskId"] not in known and card["kinopoiskId"] not in fresh_cards:
                    unseen += 1
                fresh_cards.setdefault(card["kinopoiskId"], card)
            totals["added"] += unseen
            next_page = payload.get("next_page")
            if not next_page or (unseen == 0 and page > 2):
                break
            page = int(next_page)
            if delay:
                time.sleep(delay)
    # Newest first, then everything else already imported.
    temporary = output.with_name(".{}.tmp".format(output.name))
    with temporary.open("w", encoding="utf-8") as handle:
        for card in fresh_cards.values():
            handle.write(json.dumps(card, ensure_ascii=False) + "\n")
        for card in read_lines(output):
            if card.get("kinopoiskId") not in fresh_cards:
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")
    os.replace(temporary, output)
    state = _read_state(state_path)
    state.update({"last_sync": date.today().isoformat(), "cards": len(known | set(fresh_cards))})
    save_state(state_path, state)
    return {**totals, "cards": state["cards"]}


def _read_state(path: Path) -> Dict[str, Any]:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return state if isinstance(state, dict) else {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Импортировать библиотеку плеера Alloha в каталог CineVault")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--pages", type=int, default=20, help="Сколько страниц по 30 карточек взять за запуск")
    parser.add_argument("--delay-seconds", type=float, default=3.0)
    parser.add_argument("--full", action="store_true", help="Пройти всю библиотеку, продолжая с контрольной точки")
    args = parser.parse_args()
    token = api_token()
    if not token:
        parser.error("Задай CINEVAULT_APBUGALL_TOKEN")
    runner = sync_full if args.full else sync_recent
    result = runner(token, args.output, args.state_path, max(1, args.pages), max(0.0, args.delay_seconds))
    print("Alloha: страниц {pages}, новых карточек {added}, всего карточек {cards}".format(**result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
