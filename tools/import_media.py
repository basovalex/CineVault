#!/usr/bin/env python3
"""Import one backend-local video into the shared CineVault library."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

try:
    from .media_library_server import DEFAULT_DATA_DIR, MediaLibrary, load_local_tmdb_token
except ImportError:
    from media_library_server import DEFAULT_DATA_DIR, MediaLibrary, load_local_tmdb_token


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a backend-local video into CineVault")
    parser.add_argument("file", type=Path, help="Path on the backend server")
    parser.add_argument("--title", required=True)
    parser.add_argument("--season", type=int, default=0, help="0 for a movie")
    parser.add_argument("--episode", type=int, default=0, help="0 for a movie")
    parser.add_argument("--episode-title", default="")
    parser.add_argument("--tmdb-id", default=None, help="TMDB series/movie id for automatic metadata")
    parser.add_argument("--kind", choices=["series", "movie"], default="series")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--ffmpeg", default=None)
    parser.add_argument("--no-transcode", action="store_true")
    args = parser.parse_args()
    tmdb_token = os.environ.get("CINEVAULT_TMDB_API_TOKEN", "").strip() or load_local_tmdb_token()
    library = MediaLibrary(args.data_dir, ffmpeg_path=args.ffmpeg, transcode=not args.no_transcode, tmdb_api_token=tmdb_token)
    try:
        metadata = library.catalog_details(args.tmdb_id, args.kind) if args.tmdb_id else None
        result = library.import_file(args.file, args.title, args.season, args.episode, args.episode_title, metadata)
        print(result)
    finally:
        library.close()


if __name__ == "__main__":
    main()
