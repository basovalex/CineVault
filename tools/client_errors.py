"""Errors from viewers' browsers: a small JSON-lines journal without personal data.

The site posts an error here when something breaks in a browser, so real
failures are visible on the server. Nothing that identifies a person is kept:
no IP address, no cookies, no query strings, no search text. Every field is
cut to a fixed length, the body is capped, the rate is capped for the whole
server, and the file is rotated once it grows past a megabyte.

Read it on the server with:  tail -n 50 <data-dir>/client-errors.jsonl
"""

from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

JOURNAL_NAME = "client-errors.jsonl"
MAX_BODY = 4096
MAX_FILE_BYTES = 1_000_000
PER_MINUTE = 30
FIELDS = {"kind": 40, "message": 300, "stack": 1200, "source": 200, "path": 120, "version": 60, "ua": 160}
# Query strings and fragments can carry search text or tokens; e-mails and long numbers are personal.
# Stack lines keep their ":line:column" after the address.
_QUERY = re.compile(r"[?#][^\s\"')]*?(?=:\d+:\d+|[\s\"')]|$)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_LONG_NUMBER = re.compile(r"\b\d{9,}\b")

_lock = threading.Lock()
_window = {"started": 0.0, "count": 0}


def clean_text(value: Any, limit: int) -> str:
    text = str(value or "")
    text = _QUERY.sub("", text)
    text = _EMAIL.sub("[email]", text)
    text = _LONG_NUMBER.sub("[number]", text)
    return text.replace("\x00", "").strip()[:limit]


def sanitize(payload: Any) -> Optional[Dict[str, str]]:
    """Keeps only known fields, cut to size; None when there is nothing to record."""
    if not isinstance(payload, dict):
        return None
    record = {name: clean_text(payload.get(name), limit) for name, limit in FIELDS.items()}
    if not record["message"]:
        return None
    # A title page path names a title, not a person, but other paths are reduced to their section.
    record["path"] = re.sub(r"^(/[^/]*/?).*$", r"\1", record["path"]) if not record["path"].startswith("/title/") else record["path"]
    return record


def _allowed(now: float) -> bool:
    with _lock:
        if now - _window["started"] >= 60:
            _window["started"], _window["count"] = now, 0
        if _window["count"] >= PER_MINUTE:
            return False
        _window["count"] += 1
        return True


def record_error(root: Path, payload: Any, now: Optional[float] = None) -> bool:
    """Appends one sanitized error; returns False when it was dropped."""
    entry = sanitize(payload)
    if entry is None or not _allowed(time.monotonic() if now is None else now):
        return False
    journal = Path(root) / JOURNAL_NAME
    line = json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}, ensure_ascii=False)
    with _lock:
        journal.parent.mkdir(parents=True, exist_ok=True)
        if journal.exists() and journal.stat().st_size > MAX_FILE_BYTES:
            journal.replace(journal.with_suffix(".jsonl.1"))
        with journal.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    return True


def handle(handler: Any, parsed: Any) -> bool:
    """Serves POST /api/client-errors; returns False for any other path."""
    if parsed.path != "/api/client-errors":
        return False
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY:
        handler.send_response(413 if length > MAX_BODY else 400)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return True
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8", "replace"))
    except ValueError:
        payload = None
    record_error(Path(handler.server.library.root), payload)
    handler.send_response(204)
    handler.send_header("Content-Length", "0")
    handler.end_headers()
    return True
