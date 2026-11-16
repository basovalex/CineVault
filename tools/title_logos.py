"""Логотипы названий с Кинопоиска — второй источник после TMDB.

Сайт и приложения сначала ищут русский логотип в TMDB (у сервера к TMDB доступа нет,
это делает браузер). Если там его нет, спрашивают сервер:

  GET /api/title-logo?tmdb=<id>&type=movie|tv[&kp=<id кинопоиска>]
  → {"url": "..."} или {"url": ""}

Сервер ищет фильм на poiskkino.dev (бывший kinopoisk.dev) по id TMDB или Кинопоиска и
отдаёт его logo.url. Найденные логотипы сохраняются в <data-dir>/title-logos.json,
пустые ответы повторно проверяются через 14 дней: бесплатный ключ даёт 200 запросов в сутки.
Ключ — CINEVAULT_KINOPOISK_DEV_TOKEN; без него сервер просто отвечает пустым url.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlsplit

import requests

API_URL = "https://api.poiskkino.dev/v1.4/movie"
FANART_API_URL = "https://webservice.fanart.tv/v3.2"
CACHE_NAME = "title-logos.json"
MISS_TTL_SECONDS = 14 * 24 * 60 * 60
_lock = threading.Lock()
_cache: Optional[Dict[str, Any]] = None


def _cache_path(root: Path) -> Path:
    return Path(root) / CACHE_NAME


def _load(root: Path) -> Dict[str, Any]:
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


def lookup_fanart(tmdb: str, kind: str, token: str, session=requests) -> Optional[str]:
    """Return a Russian logo, an empty result, or None for a temporary failure."""
    resource = "tv" if kind == "tv" else "movies"
    try:
        response = session.get(f"{FANART_API_URL}/{resource}/{tmdb}", params={"source": "tmdb"},
                               headers={"api-key": token, "accept": "application/json"}, timeout=10)
    except requests.RequestException:
        return None
    if response.status_code == 404:
        return ""
    if response.status_code != 200:
        return None
    try:
        data = response.json()
        fields = ("hdtvlogo", "clearlogo") if kind == "tv" else ("hdmovielogo", "movielogo")
        for field in fields:
            for logo in data.get(field, []):
                if not isinstance(logo, dict) or logo.get("lang") != "ru":
                    continue
                url = str(logo.get("url") or "")
                parsed = urlsplit(url)
                if parsed.scheme == "https" and parsed.hostname == "assets.fanart.tv":
                    return url
    except (ValueError, TypeError, AttributeError):
        return None
    return ""


def fanart_fallback(root: Path, tmdb: str, kind: str) -> str:
    token = os.environ.get("CINEVAULT_FANART_API_KEY", "").strip()
    if not token or not tmdb:
        return ""
    key = f"fanart:{kind}:{tmdb}"
    with _lock:
        known = _load(root).get(key)
    if isinstance(known, str) and known:
        return known
    if isinstance(known, dict):
        checked = known.get("checked_at", 0)
        if isinstance(checked, (int, float)) and 0 <= time.time() - checked < MISS_TTL_SECONDS:
            return ""
    url = lookup_fanart(tmdb, kind, token)
    if url is not None:
        with _lock:
            _load(root)[key] = url if url else {"checked_at": int(time.time())}
            _save(root)
    return url or ""


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
    if isinstance(known, dict):
        checked = known.get("checked_at", 0)
        if isinstance(checked, (int, float)) and 0 <= time.time() - checked < MISS_TTL_SECONDS:
            handler.send_json(200, {"url": fanart_fallback(root, tmdb, kind)})
            return True
    elif isinstance(known, str) and known:
        handler.send_json(200, {"url": known})
        return True
    token = os.environ.get("CINEVAULT_KINOPOISK_DEV_TOKEN", "").strip()
    url = lookup(tmdb, kind, kp, token) if token else None
    if url is not None:
        with _lock:
            _load(root)[key] = url if url else {"checked_at": int(time.time())}
            _save(root)
    handler.send_json(200, {"url": url or fanart_fallback(root, tmdb, kind)})
    return True
