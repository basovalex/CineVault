#!/usr/bin/env python3
"""Bulk-import a server-local series folder by S01E01-style names."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

try:
    from .media_library_server import DEFAULT_DATA_DIR, ALLOWED_EXTENSIONS, MediaLibrary, load_local_tmdb_token
except ImportError:
    from media_library_server import DEFAULT_DATA_DIR, ALLOWED_EXTENSIONS, MediaLibrary, load_local_tmdb_token


SEASON_EPISODE_RE = re.compile(r"s(\d{1,2})[ ._-]*e(\d{1,3})", re.IGNORECASE)
X_RE = re.compile(r"(?:^|[ ._-])(\d{1,2})x(\d{1,3})(?:$|[ ._-])", re.IGNORECASE)
SEASON_DIR_RE = re.compile(r"(?:season|сезон)[ ._-]*(\d{1,2})$", re.IGNORECASE)


def episode_info(path: Path, root: Path):
    match = SEASON_EPISODE_RE.search(path.stem) or X_RE.search(path.stem)
    if match:
        season, episode = int(match.group(1)), int(match.group(2))
        title = SEASON_EPISODE_RE.sub("", path.stem) if SEASON_EPISODE_RE.search(path.stem) else X_RE.sub("", path.stem)
        return season, episode, clean_episode_title(title, episode)
    season = None
    for parent in path.relative_to(root).parents:
        match = SEASON_DIR_RE.match(parent.name)
        if match:
            season = int(match.group(1))
            break
    if season is None:
        return None
    numbers = re.findall(r"(?<!\d)(\d{1,3})(?!\d)", path.stem)
    if not numbers:
        return None
    episode = int(numbers[-1])
    title = re.sub(r"(?<!\d)\d{1,3}(?!\d)", "", path.stem)
    return season, episode, clean_episode_title(title, episode)


def clean_episode_title(value: str, episode: int) -> str:
    value = re.sub(r"[._-]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" -")
    return value or f"Серия {episode}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Bulk-import a server-local series folder")
    parser.add_argument("root", type=Path, help="Folder containing S01E01 files or Season 01 folders")
    parser.add_argument("--title", default=None, help="Series title; defaults to folder name")
    parser.add_argument("--tmdb-id", default=None)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--ffmpeg", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-transcode", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Папка не найдена: {root}")
    title = args.title or root.name
    candidates = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS:
            info = episode_info(path, root)
            if info:
                candidates.append((path, *info))
    if not candidates:
        raise SystemExit("Не найдено серий. Используй имена S01E01.mkv или папки Season 01/01.mkv")
    for path, season, episode, episode_title in candidates:
        print(f"S{season:02d}E{episode:02d}  {path.name}  →  {episode_title}")
    if args.dry_run:
        return
    tmdb_token = os.environ.get("CINEVAULT_TMDB_API_TOKEN", "").strip() or load_local_tmdb_token()
    library = MediaLibrary(args.data_dir, ffmpeg_path=args.ffmpeg, transcode=not args.no_transcode, tmdb_api_token=tmdb_token)
    try:
        metadata = library.catalog_details(args.tmdb_id, "series") if args.tmdb_id else None
        if not metadata and library.tmdb_api_token:
            matches = library.search_catalog(title, "series")
            selected = next((item for item in matches if item["title"].casefold() == title.casefold()), matches[0] if matches else None)
            if selected:
                metadata = library.catalog_details(selected["external_id"], "series")
                print(f"Метаданные: выбрано «{metadata['title']}» ({metadata['provider']}:{metadata['external_id']})")
        for path, season, episode, episode_title in candidates:
            try:
                result = library.import_file(path, title, season, episode, episode_title, metadata)
                print(f"imported {result['episode_id']} status={result['status']}")
            except Exception as exc:
                print(f"skip {path.name}: {exc}")
    finally:
        library.close()


if __name__ == "__main__":
    main()
