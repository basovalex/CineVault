"""Раздача и обновление Android TV приложения.

Файлы лежат в `<data-dir>/apk/`: сам APK (`CineVault-android.apk`) и его описание
`android.json` (`versionCode`, `versionName`, `sha256`, `size`, `notes`). Их кладёт
`tools/publish_android_apk.py`; пересобирать контейнер для новой версии не нужно.

Маршруты (все вне `/api/`, поэтому за ними стоит только пароль сайта):
  GET /tv                          страница со скачиванием и инструкцией (app/tv.html)
  GET /tv/latest.json              описание последней версии; его спрашивает приложение
  GET /tv/CineVault-android.apk    сам файл (с докачкой по Range)
  GET /dl/<токен>/CineVault.apk    то же без пароля сайта, по длинному секретному адресу
                                   для Downloader; включается CINEVAULT_APK_TOKEN
                                   (16+ символов), перед сервером его надо открыть в Caddy.
"""

from __future__ import annotations

import hmac
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

APK_NAME = "CineVault-android.apk"
MANIFEST_NAME = "android.json"
APK_MIME = "application/vnd.android.package-archive"
CHUNK = 256 * 1024
TOKEN_PATH = re.compile(r"^/dl/([A-Za-z0-9_-]{16,128})/CineVault\.apk$")


def apk_dir(root: Path) -> Path:
    return Path(root) / "apk"


def load_manifest(root: Path) -> Optional[Dict[str, Any]]:
    """Описание последней версии или None, если приложение ещё не выложено."""
    manifest_path = apk_dir(root) / MANIFEST_NAME
    apk_path = apk_dir(root) / APK_NAME
    if not manifest_path.is_file() or not apk_path.is_file():
        return None
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        code = int(data["versionCode"])
    except (ValueError, KeyError, TypeError, OSError):
        return None
    return {
        "versionCode": code,
        "versionName": str(data.get("versionName") or code),
        "sha256": str(data.get("sha256") or ""),
        "size": apk_path.stat().st_size,
        "notes": str(data.get("notes") or ""),
        "url": f"/tv/{APK_NAME}",
    }


def parse_range(header: str, size: int) -> Optional[Tuple[int, int]]:
    """`bytes=a-b`, `bytes=a-`, `bytes=-n` → (начало, конец включительно); None — неверный запрос."""
    if not header.startswith("bytes=") or "," in header or size <= 0:
        return None
    first, sep, last = header[6:].strip().partition("-")
    if not sep:
        return None
    try:
        if first == "":
            length = int(last)
            if length <= 0:
                return None
            return max(0, size - length), size - 1
        start = int(first)
        end = int(last) if last else size - 1
    except ValueError:
        return None
    if start < 0 or start >= size or end < start:
        return None
    return start, min(end, size - 1)


def token_matches(path: str, configured: str) -> bool:
    match = TOKEN_PATH.match(path)
    return bool(match) and len(configured) >= 16 and hmac.compare_digest(match.group(1), configured)


def handle(handler, method: str, parsed) -> bool:
    """True, если запрос обработан здесь. Страницу `/tv` отдаёт обычная раздача файлов."""
    path = parsed.path
    if path in ("/tv", "/tv/"):
        handler.path = "/tv.html"
        return False
    if path == "/tv/latest.json":
        manifest = load_manifest(handler.library.root)
        if manifest is None:
            handler.send_json(404, {"error": "Приложение ещё не выложено"})
            return True
        token = os.environ.get("CINEVAULT_APK_TOKEN", "").strip()
        base = str(getattr(handler.server, "public_base_url", "") or "").rstrip("/")
        if len(token) >= 16 and base:
            manifest["shareUrl"] = f"{base}/dl/{token}/CineVault.apk"
        handler.send_json(200, manifest)
        return True
    allowed = path == f"/tv/{APK_NAME}" or token_matches(path, os.environ.get("CINEVAULT_APK_TOKEN", "").strip())
    if not allowed:
        return path.startswith("/dl/") and (handler.send_error(404) or True)
    send_apk(handler, head_only=(method == "HEAD"))
    return True


def send_apk(handler, head_only: bool = False) -> None:
    root = Path(handler.library.root)
    candidate = apk_dir(root) / APK_NAME
    if not candidate.is_file():
        handler.send_json(404, {"error": "Приложение ещё не выложено"})
        return
    size = candidate.stat().st_size
    start, end, status = 0, size - 1, 200
    range_header = handler.headers.get("Range", "")
    if range_header:
        wanted = parse_range(range_header, size)
        if wanted is None:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        (start, end), status = wanted, 206
    handler.send_response(status)
    handler.send_header("Content-Type", APK_MIME)
    handler.send_header("Content-Disposition", f'attachment; filename="{APK_NAME}"')
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Cache-Control", "no-store")
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.send_header("Content-Length", str(end - start + 1))
    handler.end_headers()
    if head_only:
        return
    with candidate.open("rb") as stream:
        stream.seek(start)
        left = end - start + 1
        while left > 0:
            chunk = stream.read(min(CHUNK, left))
            if not chunk:
                break
            try:
                handler.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return
            left -= len(chunk)
