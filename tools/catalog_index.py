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
import re
import sqlite3
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

INDEX_FILENAME = "catalog_index.sqlite3"
ALLOHA_FILENAME = "catalog_alloha.jsonl"
# Frames for cards that came without one: {card id: image URL}, filled from TMDB by
# tools/fill_backdrops.py. A separate file, so nightly catalogue syncs never overwrite it.
BACKDROPS_FILENAME = "catalog_backdrops.json"
SCHEMA_VERSION = 6
FRESH_MIN_VOTES = 200
# The world audience first: IMDb votes per year of the title's life. Kinopoisk votes count
# a little, so a title that IMDb does not know still has a place. A weak title (IMDb rating,
# or Kinopoisk when IMDb has none, under 6) is held back.
NOW_INTEREST_SQL = (
    "(CAST(COALESCE(json_extract(c.summary_json, '$.imdbVoteCount'), 0) AS INTEGER) + c.votes * 0.15) * 1.0"
    " / MAX(1, CAST(strftime('%Y', 'now') AS INTEGER) - c.year + 1)"
    " * CASE WHEN COALESCE(NULLIF(CAST(json_extract(c.summary_json, '$.imdbRating') AS REAL), 0),"
    " CAST(json_extract(c.summary_json, '$.ratingKinopoisk') AS REAL),"
    " CAST(json_extract(c.summary_json, '$.rating') AS REAL), 0) BETWEEN 0.1 AND 5.99 THEN 0.4 ELSE 1 END"
)
FRESH_MIN_RATING = 5.0
RESULT_CACHE_SIZE = 80
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
    votes = _int(item.get("voteCount"))
    if rating <= 0:
        return 0.0
    return (rating * votes + 6.8 * 25000) / (votes + 25000)


def item_genres(item: Dict[str, Any]) -> list[str]:
    values = item.get("genres") if isinstance(item.get("genres"), list) else item.get("tags", [])
    return sorted({str(value).strip().casefold() for value in values or [] if str(value).strip()})


# -- title search ----------------------------------------------------------
# A query is matched against titles, not against descriptions or genres: "лед"
# must find «Лёд 2», not every card whose description says "последний".

_WORDS = re.compile(r"\w+")
_LATIN = re.compile(r"[a-z]")


def search_words(value: Any) -> list[str]:
    """Lower-cased words of a title or query; ё is е and punctuation is a separator."""
    return _WORDS.findall(str(value or "").casefold().replace("ё", "е"))


def title_tier(tokens: list[str], title: Any) -> Optional[int]:
    """How well a title answers the query, smaller is better; None when it does not.

    0 the whole title        «Лёд»
    1 title starts with it   «Лёд 2», «Лёд. Продолжение»
    2 it is whole words      «Золотой лёд»
    3 it starts the title    «Ледниковый период»
    4 each word starts one   «Мой лёгкий лёд» for "лег ле"
    5 inside a word          «Последний» for "лед" (used only when nothing better exists)
    """
    words = search_words(title)
    if not tokens or not words:
        return None
    phrase = " ".join(tokens)
    text = " ".join(words)
    if text == phrase:
        return 0
    if text.startswith(phrase + " "):
        return 1
    if (" " + phrase + " ") in (" " + text + " "):
        return 2
    if text.startswith(phrase):
        return 3
    if all(any(word.startswith(token) for word in words) for token in tokens):
        return 4
    if all(token in text for token in tokens):
        return 5
    return None


def person_matches(tokens: list[str], names: Any) -> bool:
    """True when every query word starts a word of one actor's or director's name."""
    if not isinstance(names, list):
        return False
    for name in names:
        words = search_words(name)
        if words and all(any(word.startswith(token) for word in words) for token in tokens):
            return True
    return False


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
    for name in ("catalog_imports.json", "catalog_metadata.json", "catalog_popular.json", ALLOHA_FILENAME, BACKDROPS_FILENAME):
        try:
            result[name] = (catalog_path.parent / name).stat().st_mtime_ns
        except OSError:
            result[name] = 0
    return result


METADATA_MERGE_KEYS = (
    "year", "description", "genres", "tags", "posterImage", "backdropImage", "logoImage", "actors", "directors",
    "producers", "countries", "ageRating", "tagline", "premiere", "premiereRegion", "premiereSource", "premiereCheckedAt", "runtime",
    "voteCount", "imdbVoteCount", "awaitVotes",
)
BATCH_SIZE = 2000


def iter_json_array(path: Path, chunk_size: int = 1 << 20):
    """Yields the elements of a top-level JSON array one at a time.

    The catalog files are hundreds of megabytes; decoding them whole costs
    gigabytes of Python objects. Anything but an array yields nothing, the way
    the server treats such a file as empty.
    """
    decoder = json.JSONDecoder()
    with Path(path).open(encoding="utf-8") as handle:
        buffer, position, eof = "", 0, False

        def fill() -> None:
            nonlocal buffer, position, eof
            chunk = handle.read(chunk_size)
            eof = not chunk
            buffer = buffer[position:] + chunk
            position = 0

        def next_char() -> str:
            nonlocal position
            while True:
                while position < len(buffer) and buffer[position] in " \t\r\n":
                    position += 1
                if position < len(buffer):
                    return buffer[position]
                if eof:
                    return ""
                fill()

        if next_char() != "[":
            return
        position += 1
        while True:
            char = next_char()
            if char == "":
                raise json.JSONDecodeError("Unterminated array", buffer, position)
            if char == "]":
                return
            if char == ",":
                position += 1
                continue
            while True:
                try:
                    value, end = decoder.raw_decode(buffer, position)
                except json.JSONDecodeError:
                    if eof:
                        raise
                    fill()
                    continue
                if end == len(buffer) and not eof:
                    fill()
                    continue
                break
            position = end
            yield value


def build_index(catalog_path: Path, out_path: Path) -> int:
    """Merge the JSON catalog into a fresh SQLite file; returns the card count.

    Gives the same cards as ``imported_catalog_entries`` with visibility off,
    but reads the files one card at a time through a scratch SQLite file, so a
    small server can rebuild while it keeps serving.
    """
    import tools.media_library_server as server

    server.CATALOG_STATE_DIR = None  # visibility is applied at query time
    catalog_path = Path(catalog_path)
    for attempt in range(5):
        mtimes = source_mtimes(catalog_path)
        try:
            return _build_index(server, catalog_path, Path(out_path), mtimes)
        except RuntimeError:
            # A writer may be replacing a file right now; read it again.
            if attempt == 4:
                raise
            time.sleep(3)
    raise RuntimeError("unreachable")


def _build_index(server: Any, catalog_path: Path, out_path: Path, mtimes: Dict[str, int]) -> int:
    metadata_path = catalog_path.with_name("catalog_metadata.json")
    popular_path = catalog_path.with_name(server.CATALOG_POPULAR_FILENAME)
    if not catalog_path.is_file():
        raise RuntimeError("Каталог CineVault временно недоступен")
    ranking = server.load_catalog_popularity(popular_path if popular_path.is_file() else None)
    backdrops = load_backdrops(catalog_path)
    staging_path = out_path.with_suffix(".staging")
    temporary = out_path.with_suffix(".building")
    staging_path.unlink(missing_ok=True)
    temporary.unlink(missing_ok=True)
    stage = sqlite3.connect(str(staging_path))
    try:
        stage.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; CREATE TABLE items (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE genres (card_id TEXT NOT NULL, genre TEXT NOT NULL);")
        try:
            legacy_ids = _stage_items(stage, catalog_path, metadata_path)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise RuntimeError("Каталог CineVault временно недоступен") from exc
        db = sqlite3.connect(str(temporary))
        db.executescript(SCHEMA)
        rows, payloads, seen, count = [], [], set(), 0

        def flush() -> None:
            db.executemany("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
            db.executemany("INSERT INTO card_payloads VALUES (?, ?)", payloads)
            db.executemany("INSERT INTO card_search (id, text) VALUES (?, ?)", ((row[0], row[12]) for row in rows))
            rows.clear()
            payloads.clear()

        for (payload_json,) in stage.execute("SELECT payload FROM items ORDER BY seq"):
            item = json.loads(payload_json)
            server.apply_catalog_popularity([item], ranking)
            fill_backdrop(item, backdrops)
            identifier = str(item.get("id") or "")
            if not identifier or identifier in seen:
                continue
            seen.add(identifier)
            row, payload = _row(item, "imports" if identifier in legacy_ids else "metadata", server.CATALOG_INDEX_FIELDS)
            rows.append(row)
            payloads.append(payload)
            stage.executemany("INSERT INTO genres VALUES (?, ?)", [(identifier, genre) for genre in item_genres(item)])
            count += 1
            if len(rows) >= BATCH_SIZE:
                flush()
        flush()
        count += merge_alloha(db, catalog_path.with_name(ALLOHA_FILENAME), server.CATALOG_INDEX_FIELDS, backdrops)
        db.executemany("INSERT INTO card_genres VALUES (?, ?)", stage.execute("SELECT card_id, genre FROM genres ORDER BY rowid"))
        db.executemany("INSERT INTO meta VALUES (?, ?)", [("schema", str(SCHEMA_VERSION)), ("mtimes", json.dumps(mtimes)), ("built_at", str(time.time()))])
        db.commit()
        db.close()
        os.replace(temporary, out_path)
        return count
    finally:
        stage.close()
        staging_path.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)


def _stage_items(stage: sqlite3.Connection, catalog_path: Path, metadata_path: Path) -> set:
    """Writes imported cards, then metadata-only cards, to the scratch table in catalog order.

    Metadata fills gaps in imported cards the way ``imported_catalog_entries``
    does; returns the ids of imported cards.
    """
    by_id: Dict[str, int] = {}
    by_kinopoisk_id: Dict[str, int] = {}
    known_ids: set = set()
    known_kinopoisk_ids: set = set()
    batch: list = []
    seq = 0

    def flush() -> None:
        stage.executemany("INSERT INTO items VALUES (?, ?)", batch)
        batch.clear()

    for item in iter_json_array(catalog_path):
        if not isinstance(item, dict):
            continue
        seq += 1
        identifier = str(item.get("id") or "")
        known_ids.add(identifier)
        by_id[identifier] = seq
        if item.get("kinopoiskId"):
            kinopoisk_id = str(item.get("kinopoiskId") or "")
            known_kinopoisk_ids.add(kinopoisk_id)
            by_kinopoisk_id[kinopoisk_id] = seq
        batch.append((seq, json.dumps(item, ensure_ascii=False)))
        if len(batch) >= BATCH_SIZE:
            flush()
    flush()
    legacy_ids = set(known_ids)
    if not metadata_path.is_file():
        return legacy_ids
    for item in iter_json_array(metadata_path):
        if not isinstance(item, dict):
            continue
        identifier = str(item.get("id") or "")
        kinopoisk_id = str(item.get("kinopoiskId") or "")
        if not identifier or not kinopoisk_id:
            continue
        target = by_id.get(identifier) or by_kinopoisk_id.get(kinopoisk_id)
        if target is not None:
            flush()
            (payload_json,) = stage.execute("SELECT payload FROM items WHERE seq = ?", (target,)).fetchone()
            imported = json.loads(payload_json)
            changed = False
            for key in METADATA_MERGE_KEYS:
                missing = imported.get(key) in (None, "", [], 0)
                short_description = key == "description" and len(str(imported.get(key) or "")) < 60 and len(str(item.get(key) or "")) >= 60
                if (missing or short_description) and item.get(key) not in (None, "", [], 0):
                    imported[key] = item[key]
                    changed = True
            if changed:
                stage.execute("UPDATE items SET payload = ? WHERE seq = ?", (json.dumps(imported, ensure_ascii=False), target))
            continue
        if identifier in known_ids or kinopoisk_id in known_kinopoisk_ids:
            continue
        seq += 1
        batch.append((seq, json.dumps(item, ensure_ascii=False)))
        known_ids.add(identifier)
        known_kinopoisk_ids.add(kinopoisk_id)
        if len(batch) >= BATCH_SIZE:
            flush()
    flush()
    return legacy_ids


def load_backdrops(catalog_path: Path) -> Dict[str, str]:
    try:
        payload = json.loads(catalog_path.with_name(BACKDROPS_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(key): str(value) for key, value in payload.items() if str(value).startswith("https://")} if isinstance(payload, dict) else {}


def fill_backdrop(item: Dict[str, Any], backdrops: Dict[str, str]) -> None:
    """A card keeps its own frame; one without gets the frame found for it, if any."""
    if not item.get("backdropImage") and backdrops.get(str(item.get("id") or "")):
        item["backdropImage"] = backdrops[str(item["id"])]


def merge_alloha(db: sqlite3.Connection, path: Path, index_fields: Iterable[str], backdrops: Optional[Dict[str, str]] = None) -> int:
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
            fill_backdrop(card, backdrops or {})
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
        self._results: Dict[str, str] = {}
        self._result_lock = threading.Lock()
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

    def usable(self) -> bool:
        """True when an index of this schema exists, even an outdated one."""
        if not self.index_path.is_file():
            return False
        try:
            db = sqlite3.connect("file:{}?mode=ro".format(self.index_path), uri=True)
            row = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
            db.close()
        except sqlite3.Error:
            return False
        return bool(row) and row[0] == str(SCHEMA_VERSION)

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
    UPCOMING = "((date(json_extract(c.summary_json, '$.premiere')) IS NOT NULL AND date(json_extract(c.summary_json, '$.premiere')) > date('now', '+5 hours')) OR (length(json_extract(c.summary_json, '$.premiere')) = 7 AND json_extract(c.summary_json, '$.premiere') GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND CAST(substr(json_extract(c.summary_json, '$.premiere'), 6, 2) AS INTEGER) BETWEEN 1 AND 12 AND json_extract(c.summary_json, '$.premiere') > strftime('%Y-%m', 'now', '+5 hours')) OR ((json_extract(c.summary_json, '$.premiere') IS NULL OR json_extract(c.summary_json, '$.premiere') = '' OR (length(json_extract(c.summary_json, '$.premiere')) = 4 AND json_extract(c.summary_json, '$.premiere') GLOB '[0-9][0-9][0-9][0-9]')) AND COALESCE(NULLIF(CAST(json_extract(c.summary_json, '$.premiere') AS INTEGER), 0), c.year) > CAST(strftime('%Y', 'now', '+5 hours') AS INTEGER)))"

    def _summary(self, row: sqlite3.Row) -> Dict[str, Any]:
        summary = json.loads(row["summary_json"])
        if row["source"] != "imports" and self._has_visibility:
            summary["playbackVerified"] = bool(row["verified"])
        return summary

    def _cached(self, label: str, request: Any, visibility: Optional[tuple], compute: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        """Results only change with the daily index rebuild, or when the date rolls over."""
        sizes = tuple(len(part) for part in visibility) if visibility else ()
        try:
            built = self.index_path.stat().st_mtime_ns
        except OSError:
            return compute()
        key = json.dumps([label, request, sizes, built, date.today().isoformat()], sort_keys=True, default=str)
        with self._result_lock:
            hit = self._results.pop(key, None)
            if hit is not None:
                self._results[key] = hit
        if hit is not None:
            return json.loads(hit)
        result = compute()
        with self._result_lock:
            self._results[key] = json.dumps(result, ensure_ascii=False)
            while len(self._results) > RESULT_CACHE_SIZE:
                self._results.pop(next(iter(self._results)))
        return result

    def page(self, params: Dict[str, list[str]], visibility: Optional[tuple]) -> Dict[str, Any]:
        return self._cached("page", params, visibility, lambda: self._page(params, visibility))

    def _page(self, params: Dict[str, list[str]], visibility: Optional[tuple]) -> Dict[str, Any]:
        requested_ids = [value.strip() for raw in params.get("ids", []) for value in raw.split(",") if value.strip()]
        tmdb_ids = list(dict.fromkeys(int(value) for raw in params.get("tmdb_ids", []) for value in raw.split(",") if value.isdigit() and 0 < int(value) < 2147483648))[:50]
        tokens = search_words(params.get("search", [""])[0])
        genre = str(params.get("genre", [""])[0]).strip().casefold()
        kind = str(params.get("type", params.get("kind", [""]))[0]).strip().casefold()
        collection = str(params.get("collection", [""])[0]).strip().casefold()
        collection = {"romance": "together", "thrill": "tense"}.get(collection, collection)
        sort = str(params.get("sort", ["popular"])[0]).strip().casefold()
        if collection in {"popular", "trending"} and sort == "rating":
            sort = "popular"
        if collection == "popular":
            collection = "audience"
            if sort == "popular":
                sort = "audience"
        # «Любимые зрителями» keeps its all-time order whatever the catalogue sort is.
        if collection == "audience" and sort == "now":
            sort = "audience"
        kind = {"movies": "movie", "film": "movie", "films": "movie", "serial": "series", "serials": "series", "tv": "series"}.get(kind, kind)
        today = datetime.now(timezone(timedelta(hours=5))).date()
        # Future premieres must remain discoverable even when a past player
        # audit found no stream: that is expected for an unreleased title.
        premiere = "json_extract(c.summary_json, '$.premiere')"
        upcoming = self.UPCOMING
        # Explicit lookups are used for saved favourites; a stream audit must
        # not make a previously saved title disappear from that list.
        # Future premieres belong only to the dedicated upcoming feed. Regular
        # catalogue pages should contain titles that have already been released.
        where, args = (["1"] if requested_ids or collection == "upcoming" else [self.VISIBLE]), []
        if requested_ids:
            where.append("c.id IN ({})".format(",".join("?" * len(requested_ids))))
            args += requested_ids
        if tmdb_ids:
            where.append("CAST(json_extract(c.summary_json, '$.tmdbId') AS INTEGER) IN ({})".format(",".join("?" * len(tmdb_ids))))
            args += tmdb_ids
        elif "tmdb_ids" in params:
            where.append("0")
        if kind:
            where.append("lower(c.kind) = ?")
            args.append(kind)
        # The trigram index only narrows the candidates quickly; titles decide below.
        for token in tokens:
            if len(token) >= 3:
                where.append("c.id IN (SELECT id FROM card_search WHERE text MATCH ?)")
                args.append('"{}"'.format(token.replace('"', '""')))
        if tokens and all(len(token) < 3 for token in tokens):
            where.append("instr(replace(c.title_sort, 'ё', 'е'), ?) > 0")
            args.append(tokens[0])
        if genre:
            where.append("EXISTS (SELECT 1 FROM card_genres g WHERE g.card_id = c.id AND g.genre = ?)")
            args.append(genre)

        def any_genre(names: Iterable[str]) -> str:
            names = list(names)
            args.extend(names)
            return "EXISTS (SELECT 1 FROM card_genres g WHERE g.card_id = c.id AND g.genre IN ({}))".format(",".join("?" * len(names)))

        this_year = today.year
        if collection == "popular":
            where.append("(c.popular_rank IS NOT NULL OR c.votes > 0)")
        elif collection == "audience":
            where.append("c.has_poster = 1 AND (c.votes > 0 OR CAST(COALESCE(json_extract(c.summary_json, '$.imdbVoteCount'), 0) AS INTEGER) > 0)")
        elif collection == "trending":
            where.append("c.popular_rank IS NOT NULL")
        elif collection == "new":
            # A known future premiere is not a released film. Missing dates stay
            # eligible, but cannot be described as a verified premiere.
            where.append("c.year BETWEEN ? AND ? AND c.has_poster = 1 AND "
                         "(date(json_extract(c.summary_json, '$.premiere')) IS NULL OR "
                         "date(json_extract(c.summary_json, '$.premiere')) <= ?)")
            args += [this_year - 1, this_year, today.isoformat()]
        elif collection == "upcoming":
            where.append(upcoming)
        elif collection in {"evening", "mood"}:
            where.append(any_genre(EVENING_GENRES))
        elif collection == "anime":
            where.append(any_genre(["аниме"]))
        elif collection == "tense":
            where.append(any_genre(TENSE_GENRES))
        elif collection == "together":
            where.append(any_genre(TOGETHER_GENRES))

        if sort == "fresh":
            # Newest first, but a title nobody has rated yet is not a recommendation.
            total_votes = "(c.votes + CAST(COALESCE(json_extract(c.summary_json, '$.imdbVoteCount'), 0) AS INTEGER))"
            rating = "COALESCE(CAST(json_extract(c.summary_json, '$.rating') AS REAL), 0)"
            where.append(f"c.has_poster = 1 AND {total_votes} >= ? AND ({rating} = 0 OR {rating} >= ?) "
                         f"AND (date({premiere}) <= ? OR (date({premiere}) IS NULL AND c.year <= ?))")
            args += [FRESH_MIN_VOTES, FRESH_MIN_RATING, today.isoformat(), this_year]
        verified_first = "" if tokens else "verified DESC, "
        rank = "COALESCE(c.popular_rank, 1000000000)"
        order = {
            "popular": f"{rank} ASC, c.votes DESC, c.confidence DESC, {verified_first}c.year DESC",
            "trending": f"{rank} ASC, c.votes DESC, c.confidence DESC, {verified_first}c.year DESC",
            "votes": f"{verified_first}c.votes DESC, c.confidence DESC, c.year DESC",
            "audience": "(c.votes + CAST(COALESCE(json_extract(c.summary_json, '$.imdbVoteCount'), 0) AS INTEGER)) DESC, c.id ASC",
            # What people watch now: ratings gathered per year of the title's life, so a film
            # that got half a million votes this year outranks a classic with three million
            # over thirty years. A weak title (rating under 6) is held back.
            "now": f"({NOW_INTEREST_SQL}) DESC, c.confidence DESC, c.id ASC",
            "new": f"c.year DESC, date(json_extract(c.summary_json, '$.premiere')) DESC, {rank} ASC, c.votes DESC, c.id ASC",
            # A title without a known date is placed by its year.
            "fresh": f"COALESCE(date({premiere}), printf('%04d-07-01', c.year)) DESC, c.votes DESC, c.id ASC",
            "year": f"{verified_first}c.year DESC, c.confidence DESC",
            "year_desc": f"{verified_first}c.year DESC, c.confidence DESC",
            "title": "c.title_sort ASC",
            "alphabetical": "c.title_sort ASC",
        }.get(sort, f"{verified_first}c.confidence DESC, c.year DESC")
        if collection == "upcoming":
            awaiting = "CAST(COALESCE(json_extract(c.summary_json, '$.awaitVotes'), 0) AS INTEGER) DESC"
            by_date = f"CASE WHEN date({premiere}) IS NOT NULL THEN 0 ELSE 1 END, date({premiere}) ASC"
            # «Ближайшие» puts the nearest known date first; otherwise the most awaited lead.
            first, then = (by_date, awaiting) if sort == "soon" else (awaiting, by_date)
            order = f"{first}, {then}, c.year ASC, c.title_sort ASC, c.id ASC"
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
            if tokens:
                ranked = self._ranked_ids(db, clause, args, order, tokens)
                total = len(ranked)
                pages = max(1, (total + limit - 1) // limit)
                page = min(page, pages)
                wanted = ranked[(page - 1) * limit: page * limit]
                found = {
                    row["id"]: row for row in db.execute(
                        f"SELECT c.id, c.source, c.summary_json, {self.VERIFIED} AS verified FROM cards c "
                        f"WHERE c.id IN ({','.join('?' * len(wanted))})", wanted) if wanted
                }
                items = [self._summary(found[identifier]) for identifier in wanted if identifier in found]
                return {"items": items, "page": page, "limit": limit, "total": total, "pages": pages}
            total = db.execute(f"SELECT COUNT(*) FROM cards c WHERE {clause}", args).fetchone()[0]
            pages = max(1, (total + limit - 1) // limit)
            page = min(page, pages)
            rows = db.execute(
                f"SELECT c.source, c.summary_json, {self.VERIFIED} AS verified FROM cards c WHERE {clause} ORDER BY {order}, c.rowid LIMIT ? OFFSET ?",
                args + [limit, (page - 1) * limit],
            ).fetchall()
            items = [self._summary(row) for row in rows]
        return {"items": items, "page": page, "limit": limit, "total": total, "pages": pages}

    # A person's name is a last resort, and only while it stays cheap to check.
    PEOPLE_CANDIDATE_LIMIT = 4000

    def _ranked_ids(self, db: sqlite3.Connection, clause: str, args: list, order: str, tokens: list[str]) -> list[str]:
        """Ids answering a text query, best title first; ties keep the requested sort order."""
        latin = bool(_LATIN.search(" ".join(tokens)))
        original = ", json_extract(c.summary_json, '$.originalTitle')" if latin else ", NULL"
        rows = db.execute(
            f"SELECT c.id, c.title_sort, c.year{original} FROM cards c WHERE {clause} ORDER BY {order}, c.rowid", args).fetchall()
        scored = []
        for position, (identifier, title, year, original_title) in enumerate(rows):
            tiers = [tier for tier in (title_tier(tokens, title), title_tier(tokens, original_title) if latin else None) if tier is not None]
            if tiers:
                scored.append((min(tiers), position, str(title or ""), year or 0, identifier))
        if scored:
            best = min(entry[0] for entry in scored)
            if best <= 4:  # a match inside a word only counts when no title has the word itself
                scored = [entry for entry in scored if entry[0] <= 4]
            # Franchises read in order: «Лёд», «Лёд 2», «Лёд 3».
            scored.sort(key=lambda entry: (entry[0], entry[2], entry[3]) if entry[0] <= 1 else (entry[0], entry[1]))
            return [entry[4] for entry in scored]
        if len(rows) > self.PEOPLE_CANDIDATE_LIMIT:
            return []
        ids = [row[0] for row in rows]
        people = []
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            people += db.execute(
                "SELECT c.id, json_extract(c.summary_json, '$.actors'), json_extract(c.summary_json, '$.directors') "
                f"FROM cards c WHERE c.id IN ({','.join('?' * len(chunk))})", chunk).fetchall()
        matched = set()
        for identifier, actors, directors in people:
            for names in (actors, directors):
                try:
                    names = json.loads(names) if isinstance(names, str) else names
                except ValueError:
                    continue
                if person_matches(tokens, names):
                    matched.add(identifier)
                    break
        return [identifier for identifier in ids if identifier in matched]

    def facets(self, visibility: Optional[tuple], kind: str = "") -> Dict[str, Any]:
        return self._cached("facets", kind, visibility, lambda: self._facets(visibility, kind))

    def _facets(self, visibility: Optional[tuple], kind: str = "") -> Dict[str, Any]:
        where = self.VISIBLE + (" AND c.kind = ?" if kind else "")
        args = [kind] if kind else []
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            total, movies, series = db.execute(
                f"SELECT COUNT(*), SUM(c.kind = 'movie'), SUM(c.kind = 'series') FROM cards c WHERE {where}", args).fetchone()
            genres = {
                genre: count for genre, count in db.execute(
                    f"SELECT g.genre, COUNT(*) FROM card_genres g JOIN cards c ON c.id = g.card_id WHERE {where} GROUP BY g.genre", args)
                if genre not in EDITORIAL_TAGS
            }
        return {"total": total or 0, "movies": movies or 0, "series": series or 0, "genres": genres}

    def discovery(self, limit: int, visibility: Optional[tuple]) -> list[Dict[str, Any]]:
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            count = max(1, min(1000, int(limit or 500)))
            select = f"SELECT c.source, c.summary_json, {self.VERIFIED} AS verified FROM cards c WHERE {self.VISIBLE} "
            popular = db.execute(select + "AND c.popular_rank IS NOT NULL ORDER BY c.popular_rank, c.id LIMIT ?", ((count + 1) // 2,)).fetchall()
            audience = db.execute(select + "ORDER BY c.votes DESC, c.confidence DESC, c.id LIMIT ?", (count,)).fetchall()
            result = {}
            for row in popular + audience:
                item = self._summary(row)
                result.setdefault(item["id"], item)
            return list(result.values())[:count]

    def item(self, identifier: str, visibility: Optional[tuple], include_hidden: bool = False) -> Dict[str, Any]:
        needle = str(identifier).strip()
        kp = int(needle) if needle.isdigit() else 0
        with self._lock:
            db = self._connection()
            self._load_sets(db, visibility)
            visible = "1" if include_hidden else f"({self.VISIBLE} OR {self.UPCOMING} OR date(json_extract(c.summary_json, '$.premiere')) IS NOT NULL)"
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
