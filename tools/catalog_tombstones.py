"""Kinopoisk IDs that must stay out of the CineVault catalog.

The playback refresh and the stream audit decide that a title has no stream.
Metadata syncs run in separate containers and rewrite whole JSON files, so a
deletion made by the server would be undone by the next sync. Both sides read
this shared list instead: the server hides the IDs and the syncs never add
them back.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Iterable, Set

TOMBSTONE_FILENAME = "kinopoisk_deleted_ids.json"
AUDIT_FILENAME = "kinopoisk_stream_audit.sqlite3"
ALLOHA_TABLE = "alloha_cards"


def _positive_ids(values: Iterable) -> Set[int]:
    result = set()
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            result.add(number)
    return result


def read_tombstones(data_dir: Path) -> Set[int]:
    try:
        payload = json.loads((Path(data_dir) / TOMBSTONE_FILENAME).read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return set()
    return _positive_ids(payload if isinstance(payload, list) else [])


def read_audit_ids(data_dir: Path, statuses: Iterable[str]) -> Set[int]:
    path = Path(data_dir) / AUDIT_FILENAME
    wanted = tuple(statuses)
    if not wanted or not path.is_file():
        return set()
    try:
        connection = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5)
    except sqlite3.Error:
        return set()
    try:
        rows = connection.execute(
            "SELECT kinopoisk_id FROM cards WHERE status IN ({})".format(",".join("?" * len(wanted))),
            wanted,
        ).fetchall()
    except sqlite3.Error:
        return set()
    finally:
        connection.close()
    return _positive_ids(row[0] for row in rows)


def alloha_ids(data_dir: Path, available: int) -> Set[int]:
    """IDs some embedded player has (1) or none of them has after a check (0).

    The table started with Alloha only; the "others" column counts the extra
    balancers (Collaps, Veoveo, Turbo) seen in the same players API answer.
    """
    path = Path(data_dir) / AUDIT_FILENAME
    if not path.is_file():
        return set()
    try:
        connection = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5)
    except sqlite3.Error:
        return set()
    try:
        has_others = "others" in {row[1] for row in connection.execute("PRAGMA table_info({})".format(ALLOHA_TABLE))}
        any_player = "(available = 1 OR COALESCE(others, 0) > 0)" if has_others else "(available = 1)"
        condition = any_player if available else "(available = 0 AND NOT {})".format(any_player)
        rows = connection.execute("SELECT kinopoisk_id FROM {} WHERE {}".format(ALLOHA_TABLE, condition)).fetchall()
    except sqlite3.Error:
        return set()
    finally:
        connection.close()
    return _positive_ids(row[0] for row in rows)


def alloha_available_ids(data_dir: Path) -> Set[int]:
    return alloha_ids(data_dir, 1)


def player1_failed_ids(data_dir: Path) -> Set[int]:
    return read_tombstones(data_dir) | read_audit_ids(data_dir, ("deleted", "missing"))


def deleted_ids(data_dir: Path) -> Set[int]:
    """IDs with no stream in either player: never add or show them again.

    Player 1 failing alone is not enough; until Alloha was checked too the
    title stays in the catalog and is verified when someone opens it.
    """
    return player1_failed_ids(data_dir) & alloha_ids(data_dir, 0)


def unplayable_ids(data_dir: Path) -> Set[int]:
    return deleted_ids(data_dir)


def ensure_others_column(connection: sqlite3.Connection) -> None:
    if "others" not in {row[1] for row in connection.execute("PRAGMA table_info({})".format(ALLOHA_TABLE))}:
        connection.execute("ALTER TABLE {} ADD COLUMN others INTEGER".format(ALLOHA_TABLE))


def record_alloha_result(data_dir: Path, kinopoisk_id: int, translations: int, others: int = 0) -> None:
    """Store a player 2 check made while a viewer opened a title."""
    path = Path(data_dir) / AUDIT_FILENAME
    try:
        connection = sqlite3.connect(str(path), timeout=5)
    except sqlite3.Error:
        return
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS {} (kinopoisk_id INTEGER PRIMARY KEY, available INTEGER, translations INTEGER NOT NULL DEFAULT 0, "
            "failures INTEGER NOT NULL DEFAULT 0, checked_at TEXT, priority INTEGER NOT NULL DEFAULT 0)".format(ALLOHA_TABLE))
        ensure_others_column(connection)
        connection.execute(
            "INSERT INTO {0} (kinopoisk_id, available, translations, others, checked_at) VALUES (?, ?, ?, ?, datetime('now')) "
            "ON CONFLICT(kinopoisk_id) DO UPDATE SET available = excluded.available, translations = excluded.translations, "
            "others = excluded.others, failures = 0, checked_at = excluded.checked_at".format(ALLOHA_TABLE),
            (int(kinopoisk_id), 1 if translations else 0, int(translations), int(others)))
        connection.commit()
    except sqlite3.Error:
        pass
    finally:
        connection.close()


def add_tombstone(data_dir: Path, kinopoisk_id: int) -> None:
    path = Path(data_dir) / TOMBSTONE_FILENAME
    ids = read_tombstones(data_dir)
    if int(kinopoisk_id) in ids:
        return
    ids.add(int(kinopoisk_id))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(sorted(ids)) + "\n", encoding="utf-8")
    os.replace(temporary, path)
