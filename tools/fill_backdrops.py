#!/usr/bin/env python3
"""Find frames (backdrops) on TMDB for catalogue cards that have none.

The server cannot reach TMDB's API, so this runs on a machine that can (the Mac):

  1. a list of cards without a frame comes from the server (see --help for the format);
  2. for every card TMDB is asked for its frames, a frame without text first;
  3. the result is merged into app/data/catalog_backdrops.json ({card id: image URL}),
     which is copied to the server; the catalogue index picks it up by itself.

The TMDB token is read from the environment (TMDB_TOKEN) or app/config.local.js and is
never printed.

  python3 tools/fill_backdrops.py --cards missing.json [--out app/data/catalog_backdrops.json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.themoviedb.org/3"
IMAGE = "https://image.tmdb.org/t/p/w1280"
_pause_until = [0.0]
_pause_lock = threading.Lock()


def tmdb_token() -> str:
    token = os.environ.get("TMDB_TOKEN", "").strip()
    if token:
        return token
    config = ROOT / "app" / "config.local.js"
    match = re.search(r"tmdbApiKey\s*:\s*\"([^\"]+)\"", config.read_text(encoding="utf-8")) if config.is_file() else None
    if not match:
        raise SystemExit("Нет токена TMDB: задайте TMDB_TOKEN или tmdbApiKey в app/config.local.js")
    return match.group(1)


def get(path: str, token: str, attempts: int = 4) -> Optional[Dict[str, Any]]:
    headers = {"Accept": "application/json"}
    url = f"{API}{path}"
    if token.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {token}"
    else:
        url += ("&" if "?" in url else "?") + f"api_key={token}"
    for attempt in range(attempts):
        with _pause_lock:
            wait = _pause_until[0] - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code == 429:
                with _pause_lock:
                    _pause_until[0] = time.monotonic() + float(error.headers.get("Retry-After") or 2)
                continue
            if attempt == attempts - 1:
                return None
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == attempts - 1:
                return None
            time.sleep(1 + attempt)
    return None


def find_frame(card: Dict[str, Any], token: str) -> str:
    kind = "tv" if card.get("kind") == "series" else "movie"
    tmdb_id = str(card.get("tmdbId") or "").strip()
    if not tmdb_id and str(card.get("imdbId") or "").startswith("tt"):
        found = get(f"/find/{card['imdbId']}?external_source=imdb_id", token) or {}
        results = found.get("tv_results" if kind == "tv" else "movie_results") or found.get("movie_results" if kind == "tv" else "tv_results") or []
        if results:
            tmdb_id = str(results[0].get("id") or "")
            kind = "tv" if results[0].get("media_type") == "tv" or "first_air_date" in results[0] else kind
    if not tmdb_id.isdigit():
        return ""
    # A frame without text reads best under a title printed on top of it.
    images = get(f"/{kind}/{tmdb_id}/images?include_image_language=null", token) or {}
    frames = sorted(images.get("backdrops") or [], key=lambda frame: (frame.get("vote_count") or 0, frame.get("width") or 0), reverse=True)
    path = frames[0]["file_path"] if frames else ""
    if not path:
        details = get(f"/{kind}/{tmdb_id}", token) or {}
        path = details.get("backdrop_path") or ""
    return f"{IMAGE}{path}" if path else ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cards", type=Path, required=True, help='JSON list of {"id", "kind", "tmdbId", "imdbId"}')
    parser.add_argument("--out", type=Path, default=ROOT / "app" / "data" / "catalog_backdrops.json")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    token = tmdb_token()
    cards = json.loads(args.cards.read_text(encoding="utf-8"))
    frames: Dict[str, str] = {}
    if args.out.is_file():
        frames = json.loads(args.out.read_text(encoding="utf-8"))
    todo = [card for card in cards if card.get("id") and card["id"] not in frames]
    started, done, found = time.monotonic(), 0, 0
    lock = threading.Lock()

    def work(card: Dict[str, Any]) -> None:
        nonlocal done, found
        frame = find_frame(card, token)
        with lock:
            done += 1
            if frame:
                frames[card["id"]] = frame
                found += 1
            if done % 500 == 0:
                print(f"  {done}/{len(todo)}, кадров {found}, {time.monotonic() - started:.0f} с", flush=True)
                args.out.write_text(json.dumps(frames, ensure_ascii=False, indent=0), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, todo))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(frames, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"готово: проверено {done}, найдено кадров {found}, всего в файле {len(frames)}, {time.monotonic() - started:.0f} с", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
