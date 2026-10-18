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


def deleted_ids(data_dir: Path) -> Set[int]:
    """IDs confirmed as having no stream: never add or show them again."""
    return read_tombstones(data_dir) | read_audit_ids(data_dir, ("deleted",))


def unplayable_ids(data_dir: Path) -> Set[int]:
    """Deleted IDs plus those whose last stream check failed."""
    return deleted_ids(data_dir) | read_audit_ids(data_dir, ("missing",))


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
