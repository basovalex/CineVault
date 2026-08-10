#!/usr/bin/env python3
"""First-party CineVault media-library server.

This server accepts only user-supplied media files and never fetches or
extracts streams from third-party sites.  It is intentionally dependency-free
for the local MVP; put authentication, TLS and a reverse proxy in front of it
before exposing it outside a trusted network.
"""

from __future__ import annotations

import argparse
import cgi
import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import ssl
import subprocess
import threading
import uuid
import urllib.error
import urllib.parse
import urllib.request

try:
    import certifi
except ImportError:  # pragma: no cover - deployment may use system certificates
    certifi = None
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "app"
DEFAULT_DATA_DIR = ROOT / "data" / "media-library"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024
MAX_TITLE_LENGTH = 200
ALLOWED_EXTENSIONS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
QUALITY_PRESETS = (("360p", 360, 600_000), ("720p", 720, 2_500_000), ("1080p", 1080, 5_000_000))
HLS_SEGMENT_SECONDS = 4
INTRODB_SEGMENTS_URL = "https://api.introdb.app/segments"
INTRODB_SEGMENT_TYPES = ("recap", "intro", "outro")
SKIP_SEGMENTS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
EMPTY_SKIP_SEGMENTS_CACHE_TTL_SECONDS = 60 * 60
UPLOAD_EPISODE_RE = re.compile(r"s(\d{1,2})[ ._-]*e(\d{1,3})", re.IGNORECASE)
UPLOAD_X_RE = re.compile(r"(?:^|[ ._-])(\d{1,2})x(\d{1,3})(?:$|[ ._-])", re.IGNORECASE)
UPLOAD_SEASON_DIR_RE = re.compile(r"(?:season|сезон)[ ._-]*(\d{1,2})$", re.IGNORECASE)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ]+", "-", value.strip().lower()).strip("-")
    return normalized[:80] or "title"


def safe_name(value: str) -> str:
    name = Path(value or "video.mp4").name
    stem = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ._ -]+", "_", name).strip(" .")
    return stem[:180] or "video.mp4"


def is_materialized_file(path: Path) -> bool:
    """Return false for macOS cloud placeholders/dataless files."""
    try:
        file_stat = path.stat()
    except OSError:
        return False
    return file_stat.st_size == 0 or getattr(file_stat, "st_blocks", 1) > 0


def infer_uploaded_episode(filename: str):
    path = Path(filename)
    match = UPLOAD_EPISODE_RE.search(path.stem) or UPLOAD_X_RE.search(path.stem)
    if match:
        season, episode = int(match.group(1)), int(match.group(2))
        title = UPLOAD_EPISODE_RE.sub("", path.stem) if UPLOAD_EPISODE_RE.search(path.stem) else UPLOAD_X_RE.sub("", path.stem)
        title = re.sub(r"[._-]+", " ", title).strip(" -") or f"Серия {episode}"
        return season, episode, title
    season = None
    for parent in path.parts[:-1][::-1]:
        match = UPLOAD_SEASON_DIR_RE.match(parent)
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
    title = re.sub(r"[._-]+", " ", title).strip(" -") or f"Серия {episode}"
    return season, episode, title


def load_local_tmdb_token() -> str:
    """Read the existing local token without exposing it to the web client."""
    config_path = APP_DIR / "config.local.js"
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r"tmdbApiKey\s*:\s*['\"]([^'\"]+)['\"]", text)
    return match.group(1).strip() if match else ""


def open_https(request):
    context = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()
    return urllib.request.urlopen(request, timeout=15, context=context)


class MediaLibrary:
    """SQLite metadata plus controlled source/HLS directories."""

    def __init__(self, data_dir: Path, ffmpeg_path: Optional[str] = None, transcode: bool = True, tmdb_api_token: Optional[str] = None, max_quality_height: Optional[int] = None):
        self.root = Path(data_dir).resolve()
        self.uploads_dir = self.root / "uploads"
        self.hls_dir = self.root / "hls"
        self.db_path = self.root / "library.sqlite3"
        self.root.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(exist_ok=True)
        self.hls_dir.mkdir(exist_ok=True)
        self.ffmpeg_path = ffmpeg_path or shutil.which("ffmpeg")
        self.tmdb_api_token = str(tmdb_api_token or "").strip()
        self.transcode_enabled = transcode
        self.max_quality_height = max_quality_height
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cinevault-transcode")
        self._db = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._init_db()

    def close(self) -> None:
        self._executor.shutdown(wait=True)
        with self._lock:
            self._db.close()

    def _init_db(self) -> None:
        with self._lock:
            self._db.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS titles (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL CHECK(kind IN ('movie', 'series')),
                    title TEXT NOT NULL,
                    original_title TEXT,
                    year INTEGER,
                    overview TEXT,
                    poster_url TEXT,
                    metadata_provider TEXT,
                    metadata_external_id TEXT,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS episodes (
                    id TEXT PRIMARY KEY,
                    title_id TEXT NOT NULL REFERENCES titles(id),
                    season_number INTEGER NOT NULL DEFAULT 0,
                    episode_number INTEGER NOT NULL DEFAULT 0,
                    episode_title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    hls_path TEXT,
                    status TEXT NOT NULL,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(title_id, season_number, episode_number)
                );
                CREATE TABLE IF NOT EXISTS progress (
                    episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
                    position_seconds REAL NOT NULL DEFAULT 0,
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    completed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS watch_rooms (
                    id TEXT PRIMARY KEY,
                    share_code TEXT NOT NULL UNIQUE,
                    episode_id TEXT NOT NULL REFERENCES episodes(id),
                    state_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS catalog_requests (
                    id TEXT PRIMARY KEY,
                    catalog_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('movie', 'series')),
                    title TEXT NOT NULL,
                    original_title TEXT,
                    year INTEGER,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(catalog_id, kind)
                );
                CREATE TABLE IF NOT EXISTS episode_segments (
                    episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
                    imdb_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    episode_number INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    segments_json TEXT NOT NULL,
                    fetched_at TEXT NOT NULL
                );
                """
            )
            existing_columns = {row[1] for row in self._db.execute("PRAGMA table_info(titles)").fetchall()}
            for column, definition in {
                "original_title": "TEXT",
                "year": "INTEGER",
                "overview": "TEXT",
                "poster_url": "TEXT",
                "metadata_provider": "TEXT",
                "metadata_external_id": "TEXT",
                "metadata_json": "TEXT",
            }.items():
                if column not in existing_columns:
                    self._db.execute(f"ALTER TABLE titles ADD COLUMN {column} {definition}")
            self._db.execute("CREATE INDEX IF NOT EXISTS idx_titles_metadata ON titles(metadata_provider, metadata_external_id)")
            self._db.commit()

    def _execute(self, query: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cursor = self._db.execute(query, tuple(params))
            self._db.commit()
            return cursor

    def _episode_payload(self, row: sqlite3.Row) -> Dict[str, Any]:
        hls_file = self.hls_dir / row["id"] / "master.m3u8"
        hls_ready = hls_file.is_file()
        available_qualities = [
            label for label, _, _ in QUALITY_PRESETS
            if (self.hls_dir / row["id"] / label / "index.m3u8").is_file()
        ] if hls_ready else []
        progress = self._db.execute(
            "SELECT position_seconds, duration_seconds, completed, updated_at FROM progress WHERE episode_id = ?",
            (row["id"],),
        ).fetchone()
        segments_row = self._db.execute(
            "SELECT segments_json FROM episode_segments WHERE episode_id = ?",
            (row["id"],),
        ).fetchone()
        try:
            skip_segments = json.loads(segments_row["segments_json"]) if segments_row else []
        except (TypeError, json.JSONDecodeError):
            skip_segments = []
        return {
            "id": row["id"],
            "title_id": row["title_id"],
            "title": row["title"],
            "kind": row["kind"],
            "original_title": row["original_title"],
            "year": row["year"],
            "overview": row["overview"],
            "poster_url": row["poster_url"],
            "metadata_provider": row["metadata_provider"],
            "metadata_external_id": row["metadata_external_id"],
            "metadata": json.loads(row["metadata_json"] or "{}") if row["metadata_json"] else {},
            "season": row["season_number"] or None,
            "episode": row["episode_number"] or None,
            "episode_title": row["episode_title"],
            "status": "ready" if hls_ready else row["status"],
            "error": row["error_message"],
            "hls_url": f"/media/hls/{row['id']}/master.m3u8" if hls_ready else None,
            "available_qualities": available_qualities,
            "source_url": f"/media/source/{row['id']}/{quote_path(Path(row['source_path']).name)}",
            "offline_manifest_url": f"/api/library/episodes/{row['id']}/offline-manifest",
            "skip_segments": skip_segments,
            "progress": {
                "position": float(progress["position_seconds"]),
                "duration": float(progress["duration_seconds"]),
                "completed": bool(progress["completed"]),
                "updatedAt": progress["updated_at"],
            } if progress else None,
        }

    def list_library(self) -> list:
        with self._lock:
            rows = self._db.execute(
                """
                SELECT e.*, t.title, t.kind
                    , t.original_title, t.year, t.overview, t.poster_url, t.metadata_provider, t.metadata_external_id, t.metadata_json
                FROM episodes e JOIN titles t ON t.id = e.title_id
                ORDER BY lower(t.title), e.season_number, e.episode_number
                """
            ).fetchall()
            return [self._episode_payload(row) for row in rows]

    @staticmethod
    def _valid_imdb_id(value: Any) -> Optional[str]:
        candidate = str(value or "").strip()
        return candidate if re.fullmatch(r"tt\d+", candidate, re.IGNORECASE) else None

    @staticmethod
    def _normalise_introdb_segments(payload: Dict[str, Any]) -> list:
        """Convert IntroDB's exact per-episode objects into our stable API shape."""
        segments = []
        for segment_type in INTRODB_SEGMENT_TYPES:
            item = payload.get(segment_type)
            if not isinstance(item, dict):
                continue
            try:
                start = float(item.get("start_sec"))
                end = float(item.get("end_sec"))
            except (TypeError, ValueError):
                continue
            if not (0 <= start < end):
                continue
            confidence = item.get("confidence")
            try:
                confidence = float(confidence) if confidence is not None else None
            except (TypeError, ValueError):
                confidence = None
            submission_count = item.get("submission_count")
            try:
                submission_count = int(submission_count) if submission_count is not None else None
            except (TypeError, ValueError):
                submission_count = None
            segments.append({
                "id": f"{segment_type}-{start:g}-{end:g}",
                "type": segment_type,
                "start": start,
                "end": end,
                "confidence": confidence,
                "submission_count": submission_count,
                "source": "introdb",
            })
        return sorted(segments, key=lambda item: (item["start"], item["end"]))

    def _resolve_episode_imdb_id(self, row: sqlite3.Row) -> Optional[str]:
        try:
            metadata = json.loads(row["metadata_json"] or "{}") if row["metadata_json"] else {}
        except json.JSONDecodeError:
            metadata = {}
        for key in ("imdb_id", "imdbId", "imdb"):
            imdb_id = self._valid_imdb_id(metadata.get(key))
            if imdb_id:
                return imdb_id

        provider = str(row["metadata_provider"] or "").lower()
        external_id = str(row["metadata_external_id"] or "").strip()
        if not external_id:
            return None
        try:
            if provider == "tmdb" and external_id.isdigit():
                external = self._tmdb_request(
                    f"/{'tv' if row['kind'] == 'series' else 'movie'}/{external_id}/external_ids",
                    {},
                )
                imdb_id = self._valid_imdb_id(external.get("imdb_id"))
            elif provider == "tvmaze" and external_id.isdigit():
                external = self._tvmaze_request(f"/shows/{external_id}", {})
                imdb_id = self._valid_imdb_id((external.get("externals") or {}).get("imdb"))
            else:
                imdb_id = None
        except RuntimeError:
            return None
        if not imdb_id:
            return None

        metadata["imdb_id"] = imdb_id
        with self._lock:
            self._db.execute(
                "UPDATE titles SET metadata_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(metadata, ensure_ascii=False), now_iso(), row["title_id"]),
            )
            self._db.commit()
        return imdb_id

    def _introdb_request(self, imdb_id: str, season: int, episode: int) -> Optional[Dict[str, Any]]:
        query = urllib.parse.urlencode({"imdb_id": imdb_id, "season": season, "episode": episode})
        request = urllib.request.Request(
            f"{INTRODB_SEGMENTS_URL}?{query}",
            headers={"Accept": "application/json", "User-Agent": "CineVault/1.0"},
        )
        try:
            with open_https(request) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise RuntimeError("IntroDB segments request failed") from exc
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError("IntroDB segments request failed") from exc
        return payload if isinstance(payload, dict) and not payload.get("error") else None

    def get_skip_segments(self, episode_id: str) -> Dict[str, Any]:
        with self._lock:
            row = self._db.execute(
                """
                SELECT e.id, e.title_id, e.season_number, e.episode_number,
                       t.kind, t.metadata_provider, t.metadata_external_id,
                       t.metadata_json
                FROM episodes e JOIN titles t ON t.id = e.title_id
                WHERE e.id = ?
                """,
                (episode_id,),
            ).fetchone()
            if not row:
                raise KeyError("Серия не найдена")
            cached = self._db.execute(
                "SELECT imdb_id, source, segments_json, fetched_at FROM episode_segments WHERE episode_id = ?",
                (episode_id,),
            ).fetchone()
        cache_is_fresh = False
        if cached:
            try:
                segments = json.loads(cached["segments_json"])
            except (TypeError, json.JSONDecodeError):
                segments = []
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])).total_seconds()
                ttl = SKIP_SEGMENTS_CACHE_TTL_SECONDS if segments else EMPTY_SKIP_SEGMENTS_CACHE_TTL_SECONDS
                cache_is_fresh = 0 <= age < ttl
            except (TypeError, ValueError):
                cache_is_fresh = False
        if cached and cache_is_fresh:
            return {
                "available": bool(segments),
                "source": cached["source"],
                "imdb_id": cached["imdb_id"],
                "season": row["season_number"] or None,
                "episode": row["episode_number"] or None,
                "fetched_at": cached["fetched_at"],
                "segments": segments,
            }

        season = int(row["season_number"] or 0)
        episode = int(row["episode_number"] or 0)
        # IntroDB is episode-based. A movie without season/episode data must
        # not receive guessed skip buttons.
        if row["kind"] != "series" or season <= 0 or episode <= 0:
            return {"available": False, "source": None, "imdb_id": None, "season": None, "episode": None, "segments": []}

        imdb_id = self._resolve_episode_imdb_id(row)
        if not imdb_id:
            return {"available": False, "source": None, "imdb_id": None, "season": season, "episode": episode, "segments": []}
        try:
            payload = self._introdb_request(imdb_id, season, episode)
        except RuntimeError:
            # Metadata/segment lookup must never make playback fail.
            return {"available": False, "source": None, "imdb_id": imdb_id, "season": season, "episode": episode, "segments": []}
        segments = self._normalise_introdb_segments(payload or {})
        fetched_at = now_iso()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO episode_segments(episode_id, imdb_id, season_number, episode_number, source, segments_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (episode_id, imdb_id, season, episode, "introdb", json.dumps(segments, ensure_ascii=False), fetched_at),
            )
            self._db.commit()
        return {
            "available": bool(segments),
            "source": "introdb",
            "imdb_id": imdb_id,
            "season": season,
            "episode": episode,
            "fetched_at": fetched_at,
            "segments": segments,
        }

    def list_history(self) -> list:
        """Return the shared server-side viewing history for all users."""
        with self._lock:
            rows = self._db.execute(
                """
                SELECT e.*, t.title, t.kind
                    , t.original_title, t.year, t.overview, t.poster_url, t.metadata_provider, t.metadata_external_id, t.metadata_json
                    , p.updated_at AS history_updated_at
                FROM progress p
                JOIN episodes e ON e.id = p.episode_id
                JOIN titles t ON t.id = e.title_id
                ORDER BY p.updated_at DESC
                """
            ).fetchall()
            return [self._episode_payload(row) for row in rows]

    def create_catalog_request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Queue a catalog title for a later, licensed server import.

        The request is deliberately metadata-only: this endpoint never fetches
        a video from a third-party site. A duplicate request returns the
        existing queue item instead of creating noise.
        """
        catalog_id = str(payload.get("catalog_id") or "").strip()[:120]
        title = str(payload.get("title") or "").strip()[:MAX_TITLE_LENGTH]
        original_title = str(payload.get("original_title") or "").strip()[:MAX_TITLE_LENGTH] or None
        kind = str(payload.get("kind") or "").strip()
        year_value = payload.get("year")
        year = int(year_value) if year_value not in (None, "", 0) else None
        if not catalog_id or not title:
            raise ValueError("У запроса должны быть catalog_id и title")
        if kind not in {"movie", "series"}:
            raise ValueError("Некорректный тип тайтла")
        timestamp = now_iso()
        with self._lock:
            existing = self._db.execute(
                "SELECT id, catalog_id, kind, title, original_title, year, status, created_at, updated_at FROM catalog_requests WHERE catalog_id = ? AND kind = ?",
                (catalog_id, kind),
            ).fetchone()
            if existing:
                return {"request_id": existing["id"], "catalog_id": existing["catalog_id"], "kind": existing["kind"], "title": existing["title"], "original_title": existing["original_title"], "year": existing["year"], "status": existing["status"], "created_at": existing["created_at"], "updated_at": existing["updated_at"], "already_exists": True}
            request_id = uuid.uuid4().hex
            self._db.execute(
                "INSERT INTO catalog_requests(id, catalog_id, kind, title, original_title, year, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                (request_id, catalog_id, kind, title, original_title, year, timestamp, timestamp),
            )
            self._db.commit()
        return {"request_id": request_id, "catalog_id": catalog_id, "kind": kind, "title": title, "original_title": original_title, "year": year, "status": "pending", "created_at": timestamp, "updated_at": timestamp, "already_exists": False}

    def _tmdb_request(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self.tmdb_api_token:
            raise RuntimeError("TMDB backend token не настроен")
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(
            f"https://api.themoviedb.org/3{path}?{query}",
            headers={"Authorization": f"Bearer {self.tmdb_api_token}", "Accept": "application/json"},
        )
        try:
            with open_https(request) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError("TMDB metadata request failed") from exc

    @staticmethod
    def _strip_html(value: str) -> str:
        return re.sub(r"<[^>]+>", "", value or "").strip()

    def _tvmaze_request(self, path: str, params: Dict[str, Any]) -> Any:
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(f"https://api.tvmaze.com{path}?{query}" if query else f"https://api.tvmaze.com{path}", headers={"Accept": "application/json"})
        try:
            with open_https(request) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError("TVmaze metadata request failed") from exc

    @staticmethod
    def _tmdb_result_payload(item: Dict[str, Any], kind: str) -> Dict[str, Any]:
        is_series = kind == "series"
        return {
            "provider": "tmdb",
            "external_id": str(item.get("id", "")),
            "kind": kind,
            "title": item.get("name" if is_series else "title") or "",
            "original_title": item.get("original_name" if is_series else "original_title") or "",
            "year": int(str(item.get("first_air_date" if is_series else "release_date") or "0")[:4] or 0) or None,
            "overview": item.get("overview") or "",
            "poster_url": f"https://image.tmdb.org/t/p/w780{item['poster_path']}" if item.get("poster_path") else "",
        }

    def _tvmaze_result_payload(self, item: Dict[str, Any]) -> Dict[str, Any]:
        show = item.get("show", item)
        premiered = str(show.get("premiered") or "")
        return {
            "provider": "tvmaze",
            "external_id": str(show.get("id", "")),
            "kind": "series",
            "title": show.get("name") or "",
            "original_title": show.get("name") or "",
            "year": int(premiered[:4]) if premiered[:4].isdigit() else None,
            "overview": self._strip_html(show.get("summary") or ""),
            "poster_url": (show.get("image") or {}).get("original") or (show.get("image") or {}).get("medium") or "",
        }

    def _tvmaze_details(self, external_id: str) -> Dict[str, Any]:
        item = self._tvmaze_request(f"/shows/{external_id}", {"embed[]": "episodes"})
        payload = self._tvmaze_result_payload(item)
        grouped = {}
        for episode in item.get("_embedded", {}).get("episodes", []):
            number = int(episode.get("season") or 0)
            if number <= 0:
                continue
            grouped.setdefault(number, []).append(episode)
        payload["seasons"] = [
            {"number": number, "episode_count": len(episodes), "title": f"Сезон {number}", "episodes": [{"number": ep.get("number"), "title": ep.get("name"), "overview": self._strip_html(ep.get("summary") or ""), "image": (ep.get("image") or {}).get("original") or (ep.get("image") or {}).get("medium") or ""} for ep in episodes]}
            for number, episodes in sorted(grouped.items())
        ]
        return payload

    def search_catalog(self, query: str, kind: str = "series") -> list:
        query = str(query or "").strip()[:120]
        if not query:
            return []
        if kind not in {"movie", "series"}:
            raise ValueError("Неизвестный тип каталога")
        try:
            response = self._tmdb_request(f"/search/{'tv' if kind == 'series' else 'movie'}", {"query": query, "language": "ru-RU", "include_adult": "false", "page": 1})
            return [self._tmdb_result_payload(item, kind) for item in response.get("results", [])[:10] if item.get("id")]
        except RuntimeError:
            if kind != "series":
                raise
            response = self._tvmaze_request("/search/shows", {"q": query})
            return [self._tvmaze_result_payload(item) for item in response[:10] if item.get("show", {}).get("id")]

    def catalog_details(self, external_id: str, kind: str = "series", provider: str = "tmdb") -> Dict[str, Any]:
        if not str(external_id).isdigit():
            raise ValueError("Некорректный TMDB id")
        if kind not in {"movie", "series"}:
            raise ValueError("Неизвестный тип каталога")
        if provider == "tvmaze":
            if kind != "series":
                raise ValueError("TVmaze используется только для сериалов")
            return self._tvmaze_details(external_id)
        item = self._tmdb_request(f"/{'tv' if kind == 'series' else 'movie'}/{external_id}", {"language": "ru-RU"})
        payload = self._tmdb_result_payload(item, kind)
        if kind == "series":
            payload["seasons"] = [
                {"number": season.get("season_number"), "episode_count": season.get("episode_count"), "title": season.get("name")}
                for season in item.get("seasons", []) if season.get("season_number", 0) > 0
            ]
        return payload

    def _new_title_id(self, title: str) -> str:
        base = slugify(title)
        candidate = base
        while self._db.execute("SELECT 1 FROM titles WHERE id = ?", (candidate,)).fetchone():
            candidate = f"{base}-{uuid.uuid4().hex[:6]}"
        return candidate

    def create_upload(
        self,
        title: str,
        season: int,
        episode: int,
        episode_title: str,
        filename: str,
        source_stream,
        content_length: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metadata = metadata or {}
        title = str(metadata.get("title") or title or "").strip()[:MAX_TITLE_LENGTH]
        episode_title = str(episode_title or "").strip()[:MAX_TITLE_LENGTH]
        if not title:
            raise ValueError("Название тайтла обязательно")
        extension = Path(filename).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise ValueError(f"Неподдерживаемый формат: {extension or 'без расширения'}")
        if content_length is not None and content_length > MAX_UPLOAD_BYTES:
            raise ValueError("Файл превышает лимит загрузки 50 ГБ")
        season = int(season or 0)
        episode = int(episode or 0)
        if (season < 0 or episode < 0) or ((season == 0) != (episode == 0)):
            raise ValueError("Для фильма сезон и серия должны быть 0, для сериала — больше 0")
        kind = str(metadata.get("kind") or ("series" if season else "movie"))
        if kind not in {"series", "movie"}:
            raise ValueError("Некорректный тип тайтла")
        safe_filename = safe_name(filename)
        episode_id = uuid.uuid4().hex
        title_id = None
        temp_path = self.uploads_dir / f".{episode_id}.part"
        final_dir = self.uploads_dir / episode_id
        final_dir.mkdir()
        digest = hashlib.sha256()
        total = 0
        try:
            with temp_path.open("wb") as output:
                while True:
                    chunk = source_stream.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise ValueError("Файл превышает лимит загрузки 50 ГБ")
                    digest.update(chunk)
                    output.write(chunk)
            if total == 0:
                raise ValueError("Пустой файл нельзя добавить в медиатеку")
            source_path = final_dir / safe_filename
            temp_path.replace(source_path)
            with self._lock:
                metadata_provider = str(metadata.get("provider") or "")[:40] or None
                metadata_external_id = str(metadata.get("external_id") or "")[:80] or None
                existing = self._db.execute(
                    "SELECT id FROM titles WHERE metadata_provider = ? AND metadata_external_id = ?",
                    (metadata_provider, metadata_external_id),
                ).fetchone() if metadata_provider and metadata_external_id else None
                if not existing:
                    existing = self._db.execute("SELECT id FROM titles WHERE lower(title) = lower(?) AND kind = ?", (title, kind)).fetchone()
                if existing:
                    title_id = existing["id"]
                    self._db.execute(
                        "UPDATE titles SET title = ?, original_title = ?, year = ?, overview = ?, poster_url = ?, metadata_provider = ?, metadata_external_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
                        (title, metadata.get("original_title"), metadata.get("year"), metadata.get("overview"), metadata.get("poster_url"), metadata_provider, metadata_external_id, json.dumps(metadata, ensure_ascii=False), now_iso(), title_id),
                    )
                else:
                    title_id = self._new_title_id(title)
                    timestamp = now_iso()
                    self._db.execute(
                        "INSERT INTO titles(id, kind, title, original_title, year, overview, poster_url, metadata_provider, metadata_external_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (title_id, kind, title, metadata.get("original_title"), metadata.get("year"), metadata.get("overview"), metadata.get("poster_url"), metadata_provider, metadata_external_id, json.dumps(metadata, ensure_ascii=False), timestamp, timestamp),
                    )
                timestamp = now_iso()
                initial_status = "queued" if self.transcode_enabled else "stored"
                self._db.execute(
                    "INSERT INTO episodes(id, title_id, season_number, episode_number, episode_title, source_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (episode_id, title_id, season, episode, episode_title or f"Серия {episode or 1}", str(source_path.relative_to(self.root)), initial_status, timestamp, timestamp),
                )
                self._db.commit()
            if self.transcode_enabled:
                self._executor.submit(self.transcode_episode, episode_id)
            return {"episode_id": episode_id, "title_id": title_id, "bytes": total, "sha256": digest.hexdigest(), "status": "queued" if self.transcode_enabled else "stored"}
        except Exception:
            temp_path.unlink(missing_ok=True)
            if final_dir.exists():
                shutil.rmtree(final_dir, ignore_errors=True)
            raise

    def import_file(
        self,
        source_file: Path,
        title: str,
        season: int = 0,
        episode: int = 0,
        episode_title: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Import a file already present on the backend filesystem.

        This is the preferred admin path for a server deployment: the media
        file never travels through a user's browser.
        """
        source_file = Path(source_file).resolve()
        if not source_file.is_file():
            raise FileNotFoundError(f"Файл не найден: {source_file}")
        with source_file.open("rb") as stream:
            return self.create_upload(
                title,
                season,
                episode,
                episode_title,
                source_file.name,
                stream,
                source_file.stat().st_size,
                metadata,
            )

    def transcode_episode(self, episode_id: str) -> None:
        with self._lock:
            row = self._db.execute("SELECT * FROM episodes WHERE id = ?", (episode_id,)).fetchone()
            if not row:
                return
            self._db.execute("UPDATE episodes SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?", (now_iso(), episode_id))
            self._db.commit()
        if not self.ffmpeg_path:
            self._mark_error(episode_id, "FFmpeg не найден. Установите ffmpeg и повторите обработку.")
            return
        source = self.root / row["source_path"]
        if not is_materialized_file(source):
            self._mark_error(episode_id, "Исходный файл хранится только в облаке macOS. Нажмите «Загрузить сейчас» в Finder и повторите обработку.")
            return
        output_root = self.hls_dir / episode_id
        output_root.mkdir(parents=True, exist_ok=True)
        try:
            source_height = None
            ffprobe_path = shutil.which("ffprobe")
            if not ffprobe_path and self.ffmpeg_path:
                sibling_ffprobe = Path(self.ffmpeg_path).with_name("ffprobe")
                if sibling_ffprobe.is_file():
                    ffprobe_path = str(sibling_ffprobe)
            if ffprobe_path:
                try:
                    probe = subprocess.run(
                        [ffprobe_path, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", str(source)],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                except subprocess.TimeoutExpired:
                    # A damaged or very large source must not block the whole
                    # transcode queue.  720p is a safe fallback for playback.
                    source_height = 720
                    probe = None
                if probe is not None:
                    try:
                        source_height = int(probe.stdout.strip().splitlines()[0])
                    except (ValueError, IndexError):
                        source_height = 720
            presets = tuple(
                item for item in QUALITY_PRESETS
                if (source_height is None or item[1] <= source_height)
                and (self.max_quality_height is None or item[1] <= self.max_quality_height)
            )
            presets = presets or (QUALITY_PRESETS[0],)
            for label, _, _ in QUALITY_PRESETS:
                if all(label != preset[0] for preset in presets):
                    shutil.rmtree(output_root / label, ignore_errors=True)
            variants = []
            for label, height, bitrate in presets:
                variant_dir = output_root / label
                variant_dir.mkdir(exist_ok=True)
                playlist = variant_dir / "index.m3u8"
                if playlist.is_file() and playlist.stat().st_size > 0:
                    variants.append((label, bitrate, f"{label}/index.m3u8"))
                    continue
                command = [
                    self.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                    "-vf", f"scale=-2:{height}:force_original_aspect_ratio=decrease",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k",
                    "-force_key_frames", f"expr:gte(t,n_forced*{HLS_SEGMENT_SECONDS})",
                    "-sc_threshold", "0",
                    "-f", "hls", "-hls_time", str(HLS_SEGMENT_SECONDS), "-hls_flags", "independent_segments", "-hls_playlist_type", "vod",
                    "-hls_segment_filename", str(variant_dir / "segment-%05d.ts"), str(playlist),
                ]
                subprocess.run(command, check=True, timeout=12 * 60 * 60)
                if not playlist.is_file():
                    raise RuntimeError(f"FFmpeg не создал playlist для {label}")
                variants.append((label, bitrate, f"{label}/index.m3u8"))
            master = "#EXTM3U\n#EXT-X-VERSION:3\n" + "".join(
                f"#EXT-X-STREAM-INF:BANDWIDTH={bitrate}\n{path}\n" for label, bitrate, path in variants
            )
            (output_root / "master.m3u8").write_text(master, encoding="utf-8")
            self._execute("UPDATE episodes SET hls_path = ?, status = 'ready', error_message = NULL, updated_at = ? WHERE id = ?", (str((output_root / "master.m3u8").relative_to(self.root)), now_iso(), episode_id))
        except Exception as exc:
            self._mark_error(episode_id, str(exc)[:500])

    def _mark_error(self, episode_id: str, message: str) -> None:
        self._execute("UPDATE episodes SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?", (message, now_iso(), episode_id))

    def update_progress(self, episode_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        position = max(0.0, float(payload.get("position", 0)))
        duration = max(0.0, float(payload.get("duration", 0)))
        completed = bool(payload.get("completed", False))
        if not self._db.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone():
            raise KeyError("Серия не найдена")
        self._execute(
            "INSERT INTO progress(episode_id, position_seconds, duration_seconds, completed, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds, completed=excluded.completed, updated_at=excluded.updated_at",
            (episode_id, position, duration, int(completed), now_iso()),
        )
        return next(item for item in self.list_library() if item["id"] == episode_id)["progress"]

    def offline_manifest(self, episode_id: str, quality: Optional[str] = None) -> Dict[str, Any]:
        allowed = {item[0] for item in QUALITY_PRESETS}
        if quality is not None and quality not in allowed:
            raise ValueError("Неизвестное качество")
        if quality is None:
            available = [label for label, _, _ in QUALITY_PRESETS if (self.hls_dir / episode_id / label / "index.m3u8").is_file()]
            if not available:
                raise FileNotFoundError("HLS ещё не готов")
            quality = available[-1]
        playlist = self.hls_dir / episode_id / quality / "index.m3u8"
        if not playlist.is_file():
            raise FileNotFoundError("HLS ещё не готов")
        relative = f"/media/hls/{episode_id}/{quality}/index.m3u8"
        resources = [relative]
        resource_sizes = [playlist.stat().st_size]
        for line in playlist.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#"):
                segment = self.hls_dir / episode_id / quality / Path(line).name
                resources.append(f"/media/hls/{episode_id}/{quality}/{quote_path(Path(line).name)}")
                resource_sizes.append(segment.stat().st_size if segment.is_file() else 0)
        return {
            "episode_id": episode_id,
            "quality": quality,
            "quality_playlist": relative,
            "resources": resources,
            "resource_sizes": resource_sizes,
        }

    def create_room(self, episode_id: str) -> Dict[str, Any]:
        if not self._db.execute("SELECT 1 FROM episodes WHERE id = ?", (episode_id,)).fetchone():
            raise KeyError("Серия не найдена")
        room_id = uuid.uuid4().hex[:12]
        share_code = uuid.uuid4().hex[:8].upper()
        state = {"episode_id": episode_id, "position": 0, "playing": False, "seq": 0, "updated_at": now_iso()}
        self._execute("INSERT INTO watch_rooms(id, share_code, episode_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)", (room_id, share_code, episode_id, json.dumps(state), state["updated_at"]))
        return {"room_id": room_id, "share_code": share_code, "state": state}

    def get_room(self, room_id: str) -> Dict[str, Any]:
        row = self._db.execute("SELECT * FROM watch_rooms WHERE id = ?", (room_id,)).fetchone()
        if not row:
            raise KeyError("Комната не найдена")
        return {"room_id": row["id"], "share_code": row["share_code"], "state": json.loads(row["state_json"])}

    def update_room(self, room_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        current = self.get_room(room_id)
        state = current["state"]
        state.update({"position": max(0.0, float(payload.get("position", state["position"]))), "playing": bool(payload.get("playing", state["playing"])), "seq": int(state.get("seq", 0)) + 1, "updated_at": now_iso()})
        self._execute("UPDATE watch_rooms SET state_json = ?, updated_at = ? WHERE id = ?", (json.dumps(state), state["updated_at"], room_id))
        return {"room_id": room_id, "share_code": current["share_code"], "state": state}


def quote_path(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ._ -]", "_", str(value))


class MediaLibraryHandler(SimpleHTTPRequestHandler):
    server_version = "CineVaultMediaLibrary/1.0"

    @property
    def library(self) -> MediaLibrary:
        return self.server.library  # type: ignore[attr-defined]

    def send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def admin_authorized(self) -> bool:
        expected = str(getattr(self.server, "admin_token", "") or "")  # type: ignore[attr-defined]
        if not expected:
            return False
        supplied = self.headers.get("X-CineVault-Admin-Token", "")
        if supplied.lower().startswith("bearer "):
            supplied = supplied[7:].strip()
        return bool(supplied) and hmac.compare_digest(supplied, expected)

    def viewer_authorized(self) -> bool:
        """Allow private viewers when CINEVAULT_VIEWER_TOKEN is configured."""
        expected = str(getattr(self.server, "viewer_token", "") or "")  # type: ignore[attr-defined]
        if not expected:
            return True
        supplied = self.headers.get("Authorization", "")
        if supplied.lower().startswith("bearer "):
            supplied = supplied[7:].strip()
        return bool(supplied) and hmac.compare_digest(supplied, expected)

    def require_viewer(self) -> bool:
        if self.viewer_authorized():
            return True
        self.send_json(401, {"error": "Требуется viewer-токен CineVault"})
        return False

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        protected = parsed.path.startswith("/api/") and parsed.path != "/api/health" or parsed.path.startswith("/media/")
        if protected and not self.require_viewer():
            return
        if parsed.path == "/config.local.js":
            body = b"window.CINEVAULT_CONFIG = {};"
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "service": "cinevault-media-library"})
        elif parsed.path == "/api/catalog/search":
            params = urllib.parse.parse_qs(parsed.query)
            try:
                self.send_json(200, {"items": self.library.search_catalog(params.get("q", [""])[0], params.get("kind", ["series"])[0])})
            except (RuntimeError, ValueError) as exc:
                self.send_json(503, {"error": str(exc)})
        elif parsed.path.startswith("/api/catalog/title/"):
            parts = parsed.path.split("/")
            try:
                if len(parts) >= 7 and parts[4] in {"tmdb", "tvmaze"}:
                    provider, kind, external_id = parts[4], parts[5], parts[6]
                else:
                    provider, kind, external_id = "tmdb", parts[4], parts[5]
                self.send_json(200, self.library.catalog_details(external_id, kind, provider))
            except (RuntimeError, ValueError) as exc:
                self.send_json(503, {"error": str(exc)})
        elif parsed.path == "/api/library":
            self.send_json(200, {"items": self.library.list_library(), "history": self.library.list_history()})
        elif parsed.path == "/api/catalog/requests":
            with self.library._lock:
                rows = self.library._db.execute("SELECT id, catalog_id, kind, title, original_title, year, status, created_at, updated_at FROM catalog_requests ORDER BY created_at DESC").fetchall()
            self.send_json(200, {"items": [dict(row) for row in rows]})
        elif parsed.path == "/api/history":
            self.send_json(200, {"items": self.library.list_history()})
        elif parsed.path.startswith("/api/library/episodes/") and parsed.path.endswith("/skip-segments"):
            episode_id = parsed.path.split("/")[4]
            try:
                self.send_json(200, self.library.get_skip_segments(episode_id))
            except KeyError as exc:
                self.send_json(404, {"error": str(exc)})
        elif parsed.path.startswith("/api/library/episodes/") and parsed.path.endswith("/offline-manifest"):
            episode_id = parsed.path.split("/")[4]
            try:
                params = urllib.parse.parse_qs(parsed.query)
                quality = params.get("quality", [None])[0]
                self.send_json(200, self.library.offline_manifest(episode_id, quality))
            except (FileNotFoundError, ValueError) as exc:
                self.send_json(409, {"error": str(exc)})
        elif parsed.path.startswith("/api/watch/rooms/"):
            try:
                self.send_json(200, self.library.get_room(parsed.path.rsplit("/", 1)[-1]))
            except KeyError as exc:
                self.send_json(404, {"error": str(exc)})
        elif parsed.path.startswith("/media/"):
            self.serve_media(parsed.path)
        else:
            super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path in {"/api/library/upload", "/api/library/bulk-upload"}:
                if not self.admin_authorized():
                    self.send_json(403, {"error": "Загрузка доступна только администратору backend"})
                    return
                if parsed.path.endswith("bulk-upload"):
                    self.handle_bulk_upload()
                else:
                    self.handle_upload()
                return
            if parsed.path == "/api/watch/rooms":
                if not self.require_viewer():
                    return
                payload = self.read_json()
                self.send_json(201, self.library.create_room(str(payload.get("episode_id", ""))))
                return
            if parsed.path == "/api/catalog/requests":
                if not self.require_viewer():
                    return
                self.send_json(201, self.library.create_catalog_request(self.read_json()))
                return
            if parsed.path.startswith("/api/watch/rooms/"):
                if not self.require_viewer():
                    return
                payload = self.read_json()
                self.send_json(200, self.library.update_room(parsed.path.rsplit("/", 1)[-1], payload))
                return
            self.send_json(404, {"error": "Неизвестный endpoint"})
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/progress/"):
            if not self.require_viewer():
                return
            try:
                self.send_json(200, self.library.update_progress(parsed.path.rsplit("/", 1)[-1], self.read_json()))
            except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
                self.send_json(400, {"error": str(exc)})
            return
        self.send_json(404, {"error": "Неизвестный endpoint"})

    def read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            raise ValueError("Слишком большой JSON-запрос")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def handle_upload(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD_BYTES + 10 * 1024 * 1024:
            raise ValueError("Некорректный размер загрузки")
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "")})
        file_item = form["file"] if "file" in form else None
        if file_item is None or not getattr(file_item, "filename", None):
            raise ValueError("Выберите видеофайл")
        result = self.library.create_upload(
            form.getfirst("title", ""),
            int(form.getfirst("season", "0") or 0),
            int(form.getfirst("episode", "0") or 0),
            form.getfirst("episode_title", ""),
            file_item.filename,
            file_item.file,
            length,
            json.loads(form.getfirst("metadata", "{}") or "{}"),
        )
        self.send_json(201, result)

    def handle_bulk_upload(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD_BYTES + 20 * 1024 * 1024:
            raise ValueError("Некорректный размер загрузки")
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "")})
        file_field = form["file"] if "file" in form else None
        items = file_field if isinstance(file_field, list) else [file_field]
        items = [item for item in items if item is not None and getattr(item, "filename", None)]
        if not items:
            raise ValueError("Выберите папку или несколько видеофайлов")
        metadata = json.loads(form.getfirst("metadata", "{}") or "{}")
        title = form.getfirst("title", "")
        parsed_items = []
        for item in items:
            parsed = infer_uploaded_episode(item.filename)
            if not parsed:
                raise ValueError(f"Не удалось определить сезон/серию из имени: {item.filename}")
            parsed_items.append((item, parsed))
        results = []
        for item, (season, episode, episode_title) in parsed_items:
            results.append(self.library.create_upload(title, season, episode, episode_title, item.filename, item.file, metadata=metadata))
        self.send_json(201, {"count": len(results), "items": results})

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        protected = parsed.path.startswith("/media/")
        if protected and not self.require_viewer():
            return
        if parsed.path.startswith("/media/"):
            self.serve_media(parsed.path, head_only=True)
            return
        self.send_error(404)

    def serve_media(self, request_path: str, head_only: bool = False) -> None:
        parts = [unquote(part) for part in request_path.split("/") if part]
        if len(parts) < 4 or parts[0] != "media" or parts[1] not in {"hls", "source"}:
            self.send_error(404)
            return
        kind, episode_id = parts[1], parts[2]
        if not re.fullmatch(r"[a-f0-9]{32}", episode_id):
            self.send_error(404)
            return
        base = self.library.hls_dir / episode_id if kind == "hls" else self.library.uploads_dir / episode_id
        candidate = (base.joinpath(*parts[3:])).resolve()
        try:
            candidate.relative_to(base.resolve())
        except ValueError:
            self.send_error(404)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        if not is_materialized_file(candidate):
            self.send_json(503, {"error": "Медиафайл сейчас не загружен на этот Mac. В Finder выберите «Загрузить сейчас», затем повторите просмотр."})
            return
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        file_size = candidate.stat().st_size
        start, end = 0, file_size - 1
        status = 200
        range_header = self.headers.get("Range", "")
        if range_header:
            if not range_header.startswith("bytes=") or "," in range_header:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            range_spec = range_header[6:].strip()
            range_start, separator, range_end = range_spec.partition("-")
            try:
                if not separator:
                    raise ValueError
                if range_start:
                    start = int(range_start)
                    end = int(range_end) if range_end else file_size - 1
                else:
                    suffix_length = int(range_end)
                    if suffix_length <= 0:
                        raise ValueError
                    start = max(file_size - suffix_length, 0)
                    end = file_size - 1
            except ValueError:
                start, end = 1, 0
            if start < 0 or start >= file_size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, file_size - 1)
            status = 206

        content_length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Connection", "close")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        cache_control = "public, max-age=31536000, immutable" if candidate.suffix.lower() == ".ts" else "public, max-age=60"
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.close_connection = True
        if head_only:
            return
        with candidate.open("rb") as source:
            source.seek(start)
            remaining = content_length
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return
                remaining -= len(chunk)


def main() -> None:
    parser = argparse.ArgumentParser(description="CineVault first-party media library server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; keep 127.0.0.1 until auth/TLS are configured")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--no-transcode", action="store_true", help="Store uploads without starting FFmpeg jobs")
    parser.add_argument("--ffmpeg", default=None, help="Explicit FFmpeg executable path")
    args = parser.parse_args()
    tmdb_token = os.environ.get("CINEVAULT_TMDB_API_TOKEN", "").strip() or load_local_tmdb_token()
    library = MediaLibrary(args.data_dir, ffmpeg_path=args.ffmpeg, transcode=not args.no_transcode, tmdb_api_token=tmdb_token)
    handler = lambda *a, **kw: MediaLibraryHandler(*a, directory=str(APP_DIR), **kw)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.library = library  # type: ignore[attr-defined]
    server.admin_token = os.environ.get("CINEVAULT_ADMIN_TOKEN", "").strip()  # type: ignore[attr-defined]
    server.viewer_token = os.environ.get("CINEVAULT_VIEWER_TOKEN", "").strip()  # type: ignore[attr-defined]
    print(f"CineVault media library: http://{args.host}:{args.port}", flush=True)
    print(f"Data directory: {library.root}", flush=True)
    print("Admin browser upload: enabled." if server.admin_token else "Admin browser upload: disabled; use CINEVAULT_ADMIN_TOKEN or the backend import CLI.", flush=True)
    print("Private viewer access: enabled." if server.viewer_token else "Private viewer access: disabled; set CINEVAULT_VIEWER_TOKEN before internet exposure.", flush=True)
    print("Only user-supplied files are accepted; no third-party stream extraction is enabled.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping", flush=True)
    finally:
        server.server_close()
        library.close()


if __name__ == "__main__":
    main()
