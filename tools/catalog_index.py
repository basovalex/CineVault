#!/usr/bin/env python3
"""SQLite index of the merged CineVault catalog.

The catalog lives in large JSON files (cards with streams, metadata-only cards,
the popularity ranking). Holding all of them as Python objects costs the
server several hundred megabytes, so a separate process merges them once into
this index and exits; the server then answers catalog queries from SQLite.

Playback refreshes change one card at a time and call ``upsert_entry`` instead
of forcing a full rebuild. Which titles are dead or verified changes all the
time and is not stored here: the server passes those sets in at query time.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

INDEX_FILENAME = "catalog_index.sqlite3"
ALLOHA_FILENAME = "catalog_alloha.jsonl"
SCHEMA_VERSION = 5
EDITORIAL_TAGS = {"уютно", "для нас", "на вечер", "напряжённо", "атмосферно", "классика"}
EVENING_GENRES = ("уютно", "на вечер", "комедия", "драма", "мелодрама", "приключения", "семейный")
TENSE_GENRES = ("триллер", "детектив", "ужасы", "криминал")
TOGETHER_GENRES = ("романтика", "мелодрама", "комедия")


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def confidence_rating(item: Dict[str, Any]) -> float:
    """Same shrinkage as media_library_server.catalog_confidence_rating."""
    rating = _float(item.get("ratingKinopoisk") or item.get("rating") or item.get("imdbRating"))
    votes = _int(item.get("voteCount") or item.get("imdbVoteCount"))
    if rating <= 0:
        return 0.0
    return (rating * votes + 6.8 * 500) / (votes + 500)


def item_genres(item: Dict[str, Any]) -> list[str]:
    values = item.get("genres") if isinstance(item.get("genres"), list) else item.get("tags", [])
    return sorted({str(value).strip().casefold() for value in values or [] if str(value).strip()})


def search_text(item: Dict[str, Any]) -> str:
    fields = [item.get("title"), item.get("originalTitle"), item.get("description"), item.get("tagline")]
    fields += item.get("tags", []) if isinstance(item.get("tags"), list) else []
    fields += item.get("genres", []) if isinstance(item.get("genres"), list) else []
    for people in ("actors", "directors"):
        fields += item.get(people, []) if isinstance(item.get(people), list) else []
    return " ".join(str(value or "") for value in fields).casefold().replace("ё", "е")


def _row(item: Dict[str, Any], source: str, index_fields: Iterable[str], alloha: int = 0) -> tuple:
    kp_id = _int(item.get("kinopoiskId"))
    summary = {key: item[key] for key in index_fields if key in item and key != "playbackVerified"}
    return (
        str(item.get("id") or ""), kp_id or None, source, str(item.get("kind") or ""),
        str(item.get("title") or ""), str(item.get("title") or "").casefold(), _int(item.get("year")),
        _int(item.get("voteCount")), confidence_rating(item), _int(item.get("popularRank")) or None,
        1 if item.get("posterImage") else 0, len(str(item.get("description") or "")),
        search_text(item), json.dumps(summary, ensure_ascii=False), int(bool(alloha)),
    ), (str(item.get("id") or ""), json.dumps(item, ensure_ascii=False))


SCHEMA = """
CREATE TABLE cards (
    id TEXT PRIMARY KEY, kinopoisk_id INTEGER, source TEXT NOT NULL, kind TEXT, title TEXT,
    title_sort TEXT, year INTEGER, votes INTEGER, confidence REAL, popular_rank INTEGER,
    has_poster INTEGER, description_length INTEGER, search_text TEXT, summary_json TEXT,
    alloha INTEGER NOT NULL DEFAULT 0  -- listed in the Alloha (player 2) library
);
-- Full cards live apart so list scans only read the small rows above.
CREATE TABLE card_payloads (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
-- Trigram full-text index: substring search ("матри") without a full scan.
CREATE VIRTUAL TABLE card_search USING fts5(id UNINDEXED, text, tokenize = 'trigram');
CREATE INDEX cards_kp ON cards(kinopoisk_id);
CREATE INDEX cards_confidence ON cards(confidence DESC, year DESC);
CREATE TABLE card_genres (card_id TEXT NOT NULL, genre TEXT NOT NULL);
CREATE INDEX card_genres_genre ON card_genres(genre, card_id);
CREATE INDEX card_genres_card ON card_genres(card_id);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""


def source_mtimes(catalog_path: Path) -> Dict[str, int]:
    result = {}
    for name in ("catalog_imports.json", "catalog_metadata.json", "catalog_popular.json", ALLOHA_FILENAME):
        try:
            result[name] = (catalog_path.parent / name).stat().st_mtime_ns
        except OSError:
            result[name] = 0
    return result


def build_index(catalog_path: Path, out_path: Path) -> int:
    """Merge the JSON catalog into a fresh SQLite file; returns the card count."""
    import tools.media_library_server as server

    server.CATALOG_STATE_DIR = None  # visibility is applied at query time
    for attempt in range(5):
        mtimes = source_mtimes(catalog_path)
        try:
            items = server.imported_catalog_entries(catalog_path)
            break
        except RuntimeError:
            # A writer may be replacing a file right now; read it again.
            if attempt == 4:
                raise
            time.sleep(3)
    legacy_ids = set()
    try:
        legacy_ids = {str(item.get("id") or "") for item in json.loads(catalog_path.read_text(encoding="utf-8")) if isinstance(item, dict)}
    except (OSError, json.JSONDecodeError):
        pass
    temporary = out_path.with_suffix(".building")
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(str(temporary))
    db.executescript(SCHEMA)
    rows, payloads, genres = [], [], []
    seen = set()
    for item in items:
        identifier = str(item.get("id") or "")
        if not identifier or identifier in seen:
            continue
        seen.add(identifier)
        row, payload = _row(item, "imports" if identifier in legacy_ids else "metadata", server.CATALOG_INDEX_FIELDS)
        rows.append(row)
        payloads.append(payload)
        genres.extend((identifier, genre) for genre in item_genres(item))
    db.executemany("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    db.executemany("INSERT INTO card_payloads VALUES (?, ?)", payloads)
    db.executemany("INSERT INTO card_search (id, text) VALUES (?, ?)", ((row[0], row[12]) for row in rows))
    count = len(rows) + merge_alloha(db, catalog_path.with_name(ALLOHA_FILENAME), server.CATALOG_INDEX_FIELDS)
    db.executemany("INSERT INTO card_genres VALUES (?, ?)", genres)
    db.executemany("INSERT INTO meta VALUES (?, ?)", [("schema", str(SCHEMA_VERSION)), ("mtimes", json.dumps(mtimes)), ("built_at", str(time.time()))])
    db.commit()
    db.close()
    os.replace(temporary, out_path)
    return count


def merge_alloha(db: sqlite3.Connection, path: Path, index_fields: Iterable[str]) -> int:
    """Stream the Alloha library: flag known cards, add the rest."""
    if not path.is_file():
        return 0
    index_fields = tuple(index_fields)
    known = {kp: identifier for identifier, kp in db.execute("SELECT id, kinopoisk_id FROM cards WHERE kinopoisk_id IS NOT NULL")}
    added = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                card = json.loads(line)
            except json.JSONDecodeError:
                continue
            kp_id = _int(card.get("kinopoiskId")) if isinstance(card, dict) else 0
            if not kp_id or not card.get("id"):
                continue
            identifier = known.get(kp_id)
            if identifier:
                row = db.execute("SELECT payload_json FROM card_payloads WHERE id = ?", (identifier,)).fetchone()
                payload = json.loads(row[0]) if row else {}
                changed = False
                for key in ("voices", "description", "posterImage", "actors", "directors", "countries", "imdbId", "tmdbId", "quality"):
                    if payload.get(key) in (None, "", [], 0) and card.get(key) not in (None, "", [], 0):
                        payload[key] = card[key]
                        changed = True
                if changed:
                    db.execute("UPDATE card_payloads SET payload_json = ? WHERE id = ?", (json.dumps(payload, ensure_ascii=False), identifier))
                db.execute("UPDATE cards SET alloha = 1 WHERE id = ?", (identifier,))
                continue
            row, payload = _row(card, "alloha", index_fields, alloha=1)
            db.execute("INSERT OR IGNORE INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", row)
            db.execute("INSERT OR IGNORE INTO card_payloads VALUES (?, ?)", payload)
            db.execute("INSERT INTO card_search (id, text) VALUES (?, ?)", (row[0], row[12]))
            db.executemany("INSERT INTO card_genres VALUES (?, ?)", [(row[0], genre) for genre in item_genres(card)])
            known[kp_id] = row[0]
            added += 1
    return added


def upsert_entry(index_path: Path, entry: Dict[str, Any], catalog_path: Optional[Path] = None) -> None:
    """Replace one card after a playback refresh rewrote catalog_imports.json."""
    import tools.media_library_server as server

    if not index_path.is_file() or not isinstance(entry, dict) or not entry.get("id"):
        return
    db = sqlite3.connect(str(index_path), timeout=30)
    try:
        kp_id = _int(entry.get("kinopoiskId"))
        row = db.execute("SELECT p.payload_json FROM cards c JOIN card_payloads p ON p.id = c.id WHERE c.id = ? OR (c.kinopoisk_id = ? AND ? > 0) LIMIT 1",
                         (entry["id"], kp_id, kp_id)).fetchone()
        merged = dict(entry)
        if row:
            previous = json.loads(row[0])
            # The refresh writes a bare card; keep enrichment it does not carry.
            for key, value in previous.items():
                if merged.get(key) in (None, "", [], 0) and value not in (None, "", [], 0):
                    merged[key] = value
        old_rows = db.execute("SELECT id, alloha FROM cards WHERE id = ? OR (kinopoisk_id = ? AND ? > 0)", (entry["id"], kp_id, kp_id)).fetchall()
        old_ids = [value for value, _ in old_rows]
        alloha = max([flag for _, flag in old_rows] or [0])
        for old_id in set(old_ids) | {entry["id"]}:
            db.execute("DELETE FROM cards WHERE id = ?", (old_id,))
            db.execute("DELETE FROM card_payloads WHERE id = ?", (old_id,))
            db.execute("DELETE FROM card_genres WHERE card_id = ?", (old_id,))
            db.execute("DELETE FROM card_search WHERE id = ?", (old_id,))
        row, payload = _row(merged, "imports", server.CATALOG_INDEX_FIELDS, alloha=alloha)
        db.execute("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", row)
        db.execute("INSERT INTO card_search (id, text) VALUES (?, ?)", (row[0], row[12]))
        db.execute("INSERT INTO card_payloads VALUES (?, ?)", payload)
        db.executemany("INSERT INTO card_genres VALUES (?, ?)", [(entry["id"], genre) for genre in item_genres(merged)])
        if catalog_path is not None:
            meta = db.execute("SELECT value FROM meta WHERE key = 'mtimes'").fetchone()
            mtimes = json.loads(meta[0]) if meta else {}
            mtimes["catalog_imports.json"] = source_mtimes(catalog_path)["catalog_imports.json"]
            db.execute("INSERT OR REPLACE INTO meta VALUES ('mtimes', ?)", (json.dumps(mtimes),))
        db.commit()
    finally:
        db.close()


def delete_entry(index_path: Path, kinopoisk_id: int) -> None:
    if not index_path.is_file():
        return
    db = sqlite3.connect(str(index_path), timeout=30)
    try:
        ids = [row[0] for row in db.execute("SELECT id FROM cards WHERE kinopoisk_id = ?", (int(kinopoisk_id),))]
        db.executemany("DELETE FROM card_genres WHERE card_id = ?", ((value,) for value in ids))
        db.executemany("DELETE FROM card_payloads WHERE id = ?", ((value,) for value in ids))
        db.executemany("DELETE FROM card_search WHERE id = ?", ((value,) for value in ids))
        db.execute("DELETE FROM cards WHERE kinopoisk_id = ?", (int(kinopoisk_id),))
        db.commit()
    finally:
        db.close()


class CatalogIndex:
    """Read side used by the server; rebuilds itself in a child process."""

    CHECK_SECONDS = 60
    # A full rebuild takes tens of seconds and a lot of memory in the child;
    # long imports touch the source files constantly, so space rebuilds out.
    MIN_REBUILD_SECONDS = 20 * 60

    def __init__(self, catalog_path: Path, index_path: Path):
        self.catalog_path = Path(catalog_path)
        self.index_path = Path(index_path)
        self._lock = threading.RLock()
        self._db: Optional[sqlite3.Connection] = None
        self._db_inode = None
        self._checked_at = 0.0
        self._building: Optional[Any] = None
        self._built_at = time.monotonic()
        self._sets_key = None
        self._has_visibility = False

    # -- lifecycle -------------------------------------------------------
    def stale(self) -> bool:
        if not self.index_path.is_file():
            return True
        try:
            db = sqlite3.connect("file:{}?mode=ro".format(self.index_path), uri=True)
            meta = dict(db.execute("SELECT key, value FROM meta"))
            db.close()
        except sqlite3.Error:
            return True
        if meta.get("schema") != str(SCHEMA_VERSION):
            return True
        return json.loads(meta.get("mtimes") or "{}") != source_mtimes(self.catalog_path)

    def build_in_child(self, wait: bool = False) -> None:
        import subprocess

        if self._building is not None and self._building.poll() is None:
            if wait:
                self._building.wait()
            return
        self._building = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--build", "--catalog-path", str(self.catalog_path), "--index-path", str(self.index_path)],
            cwd=str(ROOT),
        )
        if wait:
            self._building.wait()

    def maybe_refresh(self) -> None:
        now = time.monotonic()
        if now - self._checked_at < self.CHECK_SECONDS:
            return
        self._checked_at = now
        if now - self._built_at < self.MIN_REBUILD_SECONDS:
            return
        if self.stale():
            self._built_at = now
            self.build_in_child()

    def _connection(self) -> sqlite3.Connection:
        try:
            inode = self.index_path.stat().st_ino
        except OSError:
            raise RuntimeError("Каталог CineVault ещё собирается")
        if self._db is None or inode != self._db_inode:
            if self._db is not None:
                self._db.close()
            self._db = sqlite3.connect(str(self.index_path), check_same_thread=False, timeout=30, isolation_level=None)
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA cache_size = -65536")
            self._db.execute("PRAGMA mmap_size = 268435456")
            self._db.execute("CREATE TEMP TABLE IF NOT EXISTS hidden_ids (kp INTEGER PRIMARY KEY)")
            self._db.execute("CREATE TEMP TABLE IF NOT EXISTS verified_ids (kp INTEGER PRIMARY KEY)")
            self._db_inode = inode
            self._sets_key = None
        return self._db

    def _load_sets(self, db: sqlite3.Connection, visibility: Optional[tuple]) -> None:
        key = id(visibility) if visibility is not None else None
        if key == self._sets_key:
            return
        db.execute("DELETE FROM hidden_ids")
        db.execute("DELETE FROM verified_ids")
        if visibility is not None:
            available, unplayable = visibility
            db.executemany("INSERT OR IGNORE INTO hidden_ids VALUES (?)", ((value,) for value in unplayable))
            db.executemany("INSERT OR IGNORE INTO verified_ids VALUES (?)", ((value,) for value in available))
        self._sets_key = key
        self._has_visibility = visibility is not None

    # -- queries ---------------------------------------------------------
    VISIBLE = "(c.source = 'imports' OR c.alloha = 1 OR c.kinopoisk_id IS NULL OR c.kinopoisk_id NOT IN (SELECT kp FROM hidden_ids))"
    VERIFIED = "(c.source = 'imports' OR c.alloha = 1 OR c.kinopoisk_id IN (SELECT kp FROM verified_ids))"

    def _summary(self, row: sqlite3.Row) -> Dict[str, Any]:
        summary = json.loads(row["summary_json"])
        if row["source"] != "imports" and self._has_visibility:
            summary["playbackVerified"] = bool(row["verified"])
        return summary

    def page(self, params: Dict[str, list[str]], visibility: Optional[tuple]) -> Dict[str, Any]:
        requested_ids = [value.strip() for raw in params.get("ids", []) for value in raw.split(",") if value.strip()]
        query = str(params.get("search", [""])[0]).strip().casefold().replace("ё", "е")
        genre = str(params.get("genre", [""])[0]).strip().casefold()
        kind = str(params.get("type", params.get("kind", [""]))[0]).strip().casefold()
        collection = str(params.get("collection", [""])[0]).strip().casefold()
        collection = {"romance": "together", "thrill": "tense"}.get(collection, collection)
        sort = str(params.get("sort", ["rating"])[0]).strip().casefold()
        if collection in {"popular", "trending"} and sort == "rating":
            sort = "popular"
        kind = {"movies": "movie", "film": "movie", "films": "movie", "serial": "series", "serials": "series", "tv": "series"}.get(kind, kind)
        where, args = [self.VISIBLE], []
        if requested_ids:
            where.append("c.id IN ({})".format(",".join("?" * len(requested_ids))))
            args += requested_ids
        if kind:
            where.append("lower(c.kind) = ?")
            args.append(kind)
        if len(query) >= 3:
            where.append("c.id IN (SELECT id FROM card_search WHERE text MATCH ?)")
            args.append('"{}"'.format(query.replace('"', '""')))
        elif query:
            where.append("instr(c.search_text, ?) > 0")
            args.append(query)
        if genre:
            where.append("EXISTS (SELECT 1 FROM card_genres g WHERE g.card_id = c.id AND g.genre = ?)")
            args.append(genre)

        def any_genre(names: Iterable[str]) -> str:
            names = list(names)
            args.extend(names)
            return "EXISTS (SELECT 1 FROM card_genres g WHERE g.card_id = c.id AND g.genre IN ({}))".format(",".join("?" * len(names)))

        this_year = datetime.now().year
        if collection == "popular":
            where.append("(c.popular_rank IS NOT NULL OR c.votes > 0)")
        elif collection == "trending":
            where.append("c.popular_rank IS NOT NULL")
        elif collection == "new":
            where.append("c.year BETWEEN ? AND ? AND c.votes >= CASE WHEN c.popular_rank IS NOT NULL THEN 100 ELSE 1000 END "
                         "AND c.has_poster = 1 AND c.description_length >= 60 AND c.confidence >= 6.5")
            args += [this_year - 1, this_year]
        elif collection in {"evening", "mood"}:
            where.append(any_genre(EVENING_GENRES))
        elif collection == "anime":
            where.append(any_genre(["аниме"]))
        elif collection == "tense":
            where.append(any_genre(TENSE_GENRES))
        elif collection == "together":
            where.append(any_genre(TOGETHER_GENRES))

        verified_first = "" if query else "verified DESC, "
        rank = "COALESCE(c.popular_rank, 1000000000)"
        order = {
            "popular": f"{verified_first}{rank} ASC, c.votes DESC, c.confidence DESC, c.year DESC",
            "trending": f"{verified_first}{rank} ASC, c.votes DESC, c.confidence DESC, c.year DESC",
            "votes": f"{verified_first}c.votes DESC, c.confidence DESC, c.year DESC",
            "new": f"{verified_first}c.year DESC, {rank} ASC, c.votes DESC, c.confidence DESC",
            "year": f"{verified_first}c.year DESC, c.confidence DESC",
            "year_desc": f"{verified_first}c.year DESC, c.confidence DESC",
            "title": "c.title_sort ASC",
            "alphabetical": "c.title_sort ASC",
        }.get(sort, f"{verified_first}c.confidence DESC, c.year DESC")
        try:
            page = max(1, int(params.get("page", ["1"])[0]))
        except (TypeError, ValueError):
            page = 1
        try:
            limit = min(50, max(1, int(params.get("limit", ["50"])[0])))
        except (TypeError, ValueError):
            limit = 50
        clause = " AND ".join(where)
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            total = db.execute(f"SELECT COUNT(*) FROM cards c WHERE {clause}", args).fetchone()[0]
            pages = max(1, (total + limit - 1) // limit)
            page = min(page, pages)
            rows = db.execute(
                f"SELECT c.source, c.summary_json, {self.VERIFIED} AS verified FROM cards c WHERE {clause} ORDER BY {order}, c.rowid LIMIT ? OFFSET ?",
                args + [limit, (page - 1) * limit],
            ).fetchall()
            items = [self._summary(row) for row in rows]
        return {"items": items, "page": page, "limit": limit, "total": total, "pages": pages}

    def facets(self, visibility: Optional[tuple]) -> Dict[str, Any]:
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            total, movies, series = db.execute(
                f"SELECT COUNT(*), SUM(c.kind = 'movie'), SUM(c.kind = 'series') FROM cards c WHERE {self.VISIBLE}").fetchone()
            genres = {
                genre: count for genre, count in db.execute(
                    f"SELECT g.genre, COUNT(*) FROM card_genres g JOIN cards c ON c.id = g.card_id WHERE {self.VISIBLE} GROUP BY g.genre")
                if genre not in EDITORIAL_TAGS
            }
        return {"total": total or 0, "movies": movies or 0, "series": series or 0, "genres": genres}

    def discovery(self, limit: int, visibility: Optional[tuple]) -> list[Dict[str, Any]]:
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            rows = db.execute(
                f"SELECT c.source, c.summary_json, {self.VERIFIED} AS verified FROM cards c WHERE {self.VISIBLE} "
                "ORDER BY c.confidence DESC, c.year DESC, c.rowid LIMIT ?",
                (max(1, min(1000, int(limit or 500))),),
            ).fetchall()
            return [self._summary(row) for row in rows]

    def item(self, identifier: str, visibility: Optional[tuple], include_hidden: bool = False) -> Dict[str, Any]:
        needle = str(identifier).strip()
        kp = int(needle) if needle.isdigit() else 0
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            visible = "1" if include_hidden else self.VISIBLE
            row = db.execute(
                f"SELECT c.source, p.payload_json, {self.VERIFIED} AS verified FROM cards c JOIN card_payloads p ON p.id = c.id WHERE (c.id = ? OR (? > 0 AND c.kinopoisk_id = ?)) AND {visible} "
                "ORDER BY c.source = 'imports' DESC LIMIT 1",
                (needle, kp, kp),
            ).fetchone()
        if row is None:
            raise KeyError("Карточка каталога не найдена")
        item = json.loads(row["payload_json"])
        if row["source"] != "imports" and self._has_visibility:
            item["playbackVerified"] = bool(row["verified"])
        return item

    def ids(self) -> list[str]:
        with self._lock:
            db = self._connection()
            return [row[0] for row in db.execute("SELECT id FROM cards")]


def main() -> int:
    parser = argparse.ArgumentParser(description="Собрать SQLite-индекс каталога CineVault")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--catalog-path", type=Path, default=ROOT / "app" / "data" / "catalog_imports.json")
    parser.add_argument("--index-path", type=Path, default=ROOT / "data" / "media-library" / INDEX_FILENAME)
    args = parser.parse_args()
    started = time.monotonic()
    count = build_index(args.catalog_path, args.index_path)
    print("Индекс каталога: {} карточек за {:.1f} с".format(count, time.monotonic() - started), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
