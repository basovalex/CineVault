"""Логотипы названий с Кинопоиска — второй источник после TMDB.

Сайт и приложения сначала ищут русский логотип в TMDB (у сервера к TMDB доступа нет,
это делает браузер). Если там его нет, спрашивают сервер:

  GET /api/title-logo?tmdb=<id>&type=movie|tv[&kp=<id кинопоиска>]
  → {"url": "..."} или {"url": ""}

Сервер ищет фильм на poiskkino.dev (бывший kinopoisk.dev) по id TMDB или Кинопоиска и
отдаёт его logo.url. Ответ, в том числе пустой, запоминается навсегда в
<data-dir>/title-logos.json: бесплатный ключ даёт 200 запросов в сутки, а логотипы не меняются.
Ключ — CINEVAULT_KINOPOISK_DEV_TOKEN; без него сервер просто отвечает пустым url.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import parse_qs

import requests

API_URL = "https://api.poiskkino.dev/v1.4/movie"
CACHE_NAME = "title-logos.json"
_lock = threading.Lock()
_cache: Optional[Dict[str, str]] = None


def _cache_path(root: Path) -> Path:
    return Path(root) / CACHE_NAME


def _load(root: Path) -> Dict[str, str]:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_cache_path(root).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save(root: Path) -> None:
    path = _cache_path(root)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def cache_key(tmdb: str, kind: str, kp: str) -> str:
    return f"kp:{kp}" if kp else f"{kind}:{tmdb}"


def lookup(tmdb: str, kind: str, kp: str, token: str, session=requests) -> Optional[str]:
    """logo.url from poiskkino; "" when the film has none; None when the service did not answer."""
    params = [("selectFields", "logo"), ("selectFields", "externalId"), ("limit", "5")]
    if kp:
        params.append(("id", kp))
    else:
        params.append(("externalId.tmdb", tmdb))
    try:
        response = session.get(API_URL, params=params, headers={"X-API-KEY": token, "accept": "application/json"}, timeout=12)
    except requests.RequestException:
        return None
    if response.status_code != 200:
        return None
    try:
        docs = response.json().get("docs") or []
    except ValueError:
        return None
    # The same TMDB id can belong to a film and a series: take the one of the asked kind when it says.
    series = kind == "tv"
    for doc in docs:
        if not kp and doc.get("isSeries") is not None and bool(doc.get("isSeries")) != series:
            continue
        url = str((doc.get("logo") or {}).get("url") or "")
        # A TMDB-hosted logo here is TMDB's (usually English) one, already checked by the site: not Kinopoisk's own.
        if url and "image.tmdb.org" not in url:
            return url
    return ""


def handle(handler, parsed) -> bool:
    if parsed.path != "/api/title-logo":
        return False
    query = parse_qs(parsed.query)
    tmdb = "".join(ch for ch in (query.get("tmdb") or [""])[0] if ch.isdigit())[:12]
    kp = "".join(ch for ch in (query.get("kp") or [""])[0] if ch.isdigit())[:12]
    kind = "tv" if (query.get("type") or [""])[0] == "tv" else "movie"
    if not tmdb and not kp:
        handler.send_json(400, {"error": "нужен tmdb или kp"})
        return True
    root = Path(handler.library.root)
    key = cache_key(tmdb, kind, kp)
    with _lock:
        known = _load(root).get(key)
    if known is not None:
        handler.send_json(200, {"url": known})
        return True
    token = os.environ.get("CINEVAULT_KINOPOISK_DEV_TOKEN", "").strip()
    url = lookup(tmdb, kind, kp, token) if token else ""
    if url is not None:
        with _lock:
            _load(root)[key] = url
            _save(root)
    handler.send_json(200, {"url": url or ""})
    return True
