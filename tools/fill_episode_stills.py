#!/usr/bin/env python3
"""Find episode stills on TMDB for catalogue series.

The episode pictures that come with the catalogue are often wrong (frames of other titles,
portrait crops), so the site prefers TMDB stills. The server cannot reach TMDB's API, so this
runs on the Mac:

  1. a list of series comes from the server: JSON list of {"id", "tmdbId"};
  2. every season of every series is asked for its episode stills;
  3. one file per series is written to --out-dir as <card id>.json:
     {"<season>": {"<episode>": "https://image.tmdb.org/t/p/w300/..."}},
     and the folder is copied to the server's app/data/stills/.

  python3 tools/fill_episode_stills.py --cards series.json --out-dir app/data/stills
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.fill_backdrops import get, tmdb_token  # noqa: E402

STILL = "https://image.tmdb.org/t/p/w300"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def find_stills(tmdb_id: str, token: str) -> Dict[str, Dict[str, str]]:
    show = get(f"/tv/{tmdb_id}", token) or {}
    stills: Dict[str, Dict[str, str]] = {}
    for season in show.get("seasons") or []:
        number = int(season.get("season_number") or 0)
        if number < 1 or not season.get("episode_count"):
            continue
        payload = get(f"/tv/{tmdb_id}/season/{number}", token) or {}
        episodes = {str(int(episode["episode_number"])): f"{STILL}{episode['still_path']}"
                    for episode in payload.get("episodes") or [] if episode.get("still_path") and episode.get("episode_number")}
        if episodes:
            stills[str(number)] = episodes
    return stills


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cards", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--refresh", action="store_true", help="ask again for series that already have a file")
    args = parser.parse_args()
    token = tmdb_token()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    cards = [card for card in json.loads(args.cards.read_text(encoding="utf-8"))
             if SAFE_ID.match(str(card.get("id") or "")) and str(card.get("tmdbId") or "").isdigit()]
    todo = [card for card in cards if args.refresh or not (args.out_dir / f"{card['id']}.json").exists()]
    started, done, found = time.monotonic(), 0, 0
    lock = threading.Lock()

    def work(card: Dict[str, Any]) -> None:
        nonlocal done, found
        stills = find_stills(str(card["tmdbId"]), token)
        if stills:
            (args.out_dir / f"{card['id']}.json").write_text(json.dumps(stills, separators=(",", ":")), encoding="utf-8")
        with lock:
            done += 1
            found += bool(stills)
            if done % 250 == 0:
                print(f"  {done}/{len(todo)}, с кадрами {found}, {time.monotonic() - started:.0f} с", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, todo))
    print(f"готово: проверено {done}, с кадрами {found}, {time.monotonic() - started:.0f} с", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
