#!/usr/bin/env python3
"""Episode ratings of popular series, from IMDb's open datasets.

Once a day (cinevault-episode-ratings.timer) this script reads two files that
IMDb publishes every night:

  title.episode.tsv.gz  which series, season and number every episode belongs to
  title.ratings.tsv.gz  the average rating and the number of votes of every title

and keeps only the series the catalogue shows as popular (5000+ votes) that have
an IMDb id. Both files are read line by line straight from the download, so the
whole job stays small; the result is a SQLite file next to the catalogue index.

The site asks GET /api/episode-ratings?title=<catalogue id>. A series without
data answers with no seasons and the page simply shows no ratings map.

Run by hand:  python3 tools/episode_ratings.py --data-dir data/media-library
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple
from urllib.parse import parse_qs

DATASETS = "https://datasets.imdbws.com"
DB_NAME = "episode_ratings.sqlite3"
INDEX_NAME = "catalog_index.sqlite3"
MIN_SERIES_VOTES = 5000
USER_AGENT = "CineVault episode ratings (personal media library)"


def tsv_lines(source: Any) -> Iterator[List[str]]:
    """Yields rows of a gzipped TSV, read as a stream; the header row is skipped."""
    with gzip.open(source, "rt", encoding="utf-8", newline="") as handle:
        next(handle, None)
        for line in handle:
            yield line.rstrip("\n").split("\t")


def open_dataset(name: str, local_dir: Optional[Path] = None) -> Any:
    if local_dir is not None:
        return open(local_dir / name, "rb")
    request = urllib.request.Request(f"{DATASETS}/{name}", headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(request, timeout=120)


def popular_series(index_path: Path, min_votes: int = MIN_SERIES_VOTES) -> Set[str]:
    """IMDb ids of the catalogue's series with enough votes to deserve a ratings map."""
    db = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT json_extract(p.payload_json, '$.imdbId') FROM cards c JOIN card_payloads p USING (id) "
            "WHERE c.kind = 'series' AND (c.votes + CAST(COALESCE(json_extract(c.summary_json, '$.imdbVoteCount'), 0) AS INTEGER)) >= ?",
            (min_votes,),
        ).fetchall()
    finally:
        db.close()
    return {str(value).strip() for (value,) in rows if str(value or "").startswith("tt")}


def collect(episodes_rows: Iterable[List[str]], ratings_rows: Iterable[List[str]], wanted: Set[str]) -> List[Tuple[str, int, int, float, int]]:
    """(series, season, episode, rating, votes) for the wanted series; specials (season 0) left out."""
    episodes: Dict[str, Tuple[str, int, int]] = {}
    for row in episodes_rows:
        if len(row) < 4 or row[1] not in wanted:
            continue
        try:
            season, episode = int(row[2]), int(row[3])
        except ValueError:
            continue
        if season > 0 and episode > 0:
            episodes[row[0]] = (row[1], season, episode)
    result = []
    for row in ratings_rows:
        if len(row) < 3:
            continue
        place = episodes.get(row[0])
        if place is None:
            continue
        try:
            result.append((place[0], place[1], place[2], round(float(row[1]), 1), int(row[2])))
        except ValueError:
            continue
    return result


def write_db(path: Path, rows: List[Tuple[str, int, int, float, int]]) -> None:
    temporary = path.with_suffix(".building")
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(str(temporary))
    db.executescript(
        "CREATE TABLE episodes (series TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, rating REAL NOT NULL, votes INTEGER NOT NULL, PRIMARY KEY (series, season, episode));"
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"
    )
    db.executemany("INSERT OR REPLACE INTO episodes VALUES (?, ?, ?, ?, ?)", rows)
    db.execute("INSERT INTO meta VALUES ('updated_at', ?)", (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),))
    db.commit()
    db.close()
    os.replace(temporary, path)


def sync(data_dir: Path, local_dir: Optional[Path] = None, min_votes: int = MIN_SERIES_VOTES) -> int:
    wanted = popular_series(data_dir / INDEX_NAME, min_votes)
    if not wanted:
        raise RuntimeError("В каталоге нет популярных сериалов с IMDb-id")
    with open_dataset("title.episode.tsv.gz", local_dir) as episodes, open_dataset("title.ratings.tsv.gz", local_dir) as ratings:
        # Ratings are read after the whole episode list, so the first stream is consumed first.
        episodes_rows = tsv_lines(episodes)
        rows = collect(episodes_rows, tsv_lines(ratings), wanted)
    write_db(data_dir / DB_NAME, rows)
    return len(rows)


# -- reading, used by the web server ------------------------------------------

def series_ratings(data_dir: Path, imdb_id: str) -> Dict[str, Any]:
    path = Path(data_dir) / DB_NAME
    if not imdb_id or not path.is_file():
        return {"seasons": []}
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = db.execute("SELECT season, episode, rating, votes FROM episodes WHERE series = ? ORDER BY season, episode", (imdb_id,)).fetchall()
        updated = db.execute("SELECT value FROM meta WHERE key = 'updated_at'").fetchone()
    finally:
        db.close()
    seasons: Dict[int, List[Dict[str, Any]]] = {}
    for season, episode, rating, votes in rows:
        seasons.setdefault(season, []).append({"episode": episode, "rating": rating, "votes": votes})
    return {"seasons": [{"season": number, "episodes": episodes} for number, episodes in sorted(seasons.items())], "updatedAt": updated[0] if updated else ""}


def imdb_id_for(data_dir: Path, title_id: str) -> str:
    """The IMDb id stored with a catalogue card, read from the catalogue index."""
    path = Path(data_dir) / INDEX_NAME
    if not title_id or not path.is_file():
        return ""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = db.execute("SELECT json_extract(payload_json, '$.imdbId') FROM card_payloads WHERE id = ?", (title_id,)).fetchone()
    finally:
        db.close()
    value = str(row[0] or "") if row else ""
    return value if value.startswith("tt") else ""


def handle(handler: Any, parsed: Any) -> bool:
    """Serves GET /api/episode-ratings?title=<id>; returns False for any other path."""
    if parsed.path != "/api/episode-ratings":
        return False
    title = str(parse_qs(parsed.query).get("title", [""])[0]).strip()
    try:
        root = Path(handler.server.library.root)
        payload = series_ratings(root, imdb_id_for(root, title))
    except (OSError, sqlite3.Error):
        payload = {"seasons": []}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    # The data changes once a day.
    handler.send_header("Cache-Control", "public, max-age=21600")
    handler.end_headers()
    handler.wfile.write(body)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--local-dir", type=Path, help="read the two .tsv.gz files from here instead of IMDb")
    parser.add_argument("--min-votes", type=int, default=MIN_SERIES_VOTES)
    args = parser.parse_args()
    started = time.monotonic()
    count = sync(args.data_dir, args.local_dir, args.min_votes)
    print(f"episode ratings: {count} episodes in {time.monotonic() - started:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
