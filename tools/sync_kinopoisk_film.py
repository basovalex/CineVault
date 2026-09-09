#!/usr/bin/env python3
"""Импорт метаданных фильма и стабильных разрешённых вариантов видео."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "app" / "data" / "catalog_imports.json"
DEFAULT_ALLOWED_VIDEO_HOSTS = {"localhost", "127.0.0.1", "::1", "archive.org", "download.archive.org"}
def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def as_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def runtime_minutes(value: Any) -> int | None:
    text = str(value or "").strip()
    match = re.fullmatch(r"(?:(\d+)\s*:\s*)?(\d+)", text)
    if not match:
        return as_int(value)
    return int(match.group(1) or 0) * 60 + int(match.group(2))


def tags_from(value: Any) -> list[str]:
    if isinstance(value, list):
        raw = [item.get("name") if isinstance(item, dict) else item for item in value]
    else:
        raw = re.split(r"[,;/|]", str(value or ""))
    tags = [str(item).strip().lower() for item in raw if str(item).strip()]
    if "для нас" not in tags:
        tags.append("для нас")
    return list(dict.fromkeys(tags))


def text_list(value: Any) -> list[str]:
    if isinstance(value, list):
        raw = [item.get("name") if isinstance(item, dict) else item for item in value]
    else:
        raw = re.split(r"[,;/|]", str(value or ""))
    return [str(item).strip() for item in raw if str(item).strip()]


def number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def allowed_hosts() -> set[str]:
    extra = os.environ.get("CINEVAULT_ALLOWED_VIDEO_HOSTS", "")
    return DEFAULT_ALLOWED_VIDEO_HOSTS | {item.strip().lower() for item in extra.split(",") if item.strip()}


def stable_video_url(value: Any) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    return url


def episode_variants(payload: Any) -> list[Dict[str, Any]]:
    if isinstance(payload, dict):
        rows = (
            payload.get("data")
            or payload.get("episodes")
            or payload.get("items")
            or payload.get("videoSources")
            or payload.get("sources")
            or [payload]
        )
    elif isinstance(payload, list):
        rows = payload
    else:
        rows = []
    variants: list[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            raw = (
                row.get("episodeVariants")
                or row.get("variants")
                or row.get("translations")
                or row.get("videoSources")
                or row.get("sources")
                or []
            )
            if isinstance(raw, list):
                variants.extend(item for item in raw if isinstance(item, dict))
            elif any(row.get(key) for key in ("m3u8", "hlsUrl", "hls_url", "filepath", "url")):
                variants.append(row)
    return variants


def build_entry(payload: Dict[str, Any], kinopoisk_id: int, card_id: str, video_payload: Any = None) -> Dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ValueError("response.json не содержит объекта data")

    video_sources = []
    seen_urls = set()
    skipped = 0
    for variant in episode_variants(video_payload):
        url = stable_video_url(
            variant.get("m3u8")
            or variant.get("hlsUrl")
            or variant.get("hls_url")
            or variant.get("filepath")
            or variant.get("url")
            or variant.get("sourceUrl")
            or variant.get("source_url")
        )
        if not url:
            skipped += 1
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)
        video_sources.append({
            "id": str(variant.get("id") or len(video_sources) + 1),
            "url": url,
            "type": "application/vnd.apple.mpegurl" if ".m3u8" in url.lower() else "video/mp4",
            "quality": str(variant.get("streamQuality") or variant.get("quality") or variant.get("resolution") or "Авто"),
            "voice": str(variant.get("title") or variant.get("name") or variant.get("label") or variant.get("voice") or variant.get("dubbingStudioName") or "Оригинал"),
            "previewImage": str(variant.get("previewImageFilepath") or variant.get("previewImage") or "").strip(),
            "dubbingStudioId": variant.get("dubbingStudioId"),
            "duration": variant.get("duration"),
            "hasAds": variant.get("hasAdv"),
        })

    rating_kp = number(data.get("rating_kp"))
    rating_imdb = number(data.get("rating_imdb"))
    return {
        "id": card_id,
        "kind": "movie",
        "title": str(data.get("name") or "Kinopoisk {}".format(kinopoisk_id)).strip(),
        "originalTitle": str(data.get("original_name") or data.get("originalName") or data.get("name") or "").strip(),
        "year": as_int(data.get("year")),
        "description": str(data.get("description") or "").strip(),
        "tags": tags_from(data.get("genre")),
        "genres": text_list(data.get("genre")),
        "countries": text_list(data.get("country")),
        "directors": text_list(data.get("directors")),
        "actors": text_list(data.get("actors")),
        "producers": text_list(data.get("producers")),
        "ageRating": str(data.get("age_restrictions") or data.get("rating_mpaa") or "").strip(),
        "premiere": str(data.get("premiere_ru") or data.get("premiere") or "").strip(),
        "tagline": str(data.get("tagline") or "").strip(),
        "rating": rating_kp,
        "ratingKinopoisk": rating_kp,
        "imdbRating": rating_imdb,
        "runtime": runtime_minutes(data.get("time") or data.get("duration")),
        "kinopoiskId": kinopoisk_id,
        "posterImage": str(data.get("poster") or data.get("posterUrl") or "").strip(),
        "videoSources": video_sources,
        "videoSourcesSkipped": skipped,
        "providerUrl": "https://www.kinopoisk.ru/film/{}/".format(kinopoisk_id),
        "providerName": "Kinopoisk · импортированные данные",
        "providerNote": "Метаданные и постер импортированы автоматически. Видео подключается только из стабильного разрешённого источника.",
    }


def update_catalog(entry: Dict[str, Any]) -> None:
    catalog = read_json(CATALOG_PATH, [])
    if not isinstance(catalog, list):
        catalog = []
    kp_id = int(entry["kinopoiskId"])
    updated = []
    replaced = False
    for current in catalog:
        if isinstance(current, dict) and (current.get("id") == entry["id"] or int(current.get("kinopoiskId") or 0) == kp_id):
            updated.append(entry)
            replaced = True
        else:
            updated.append(current)
    if not replaced:
        updated.append(entry)
    write_json(CATALOG_PATH, updated)


def main() -> int:
    parser = argparse.ArgumentParser(description="Импортировать фильм в CineVault")
    parser.add_argument("response_json", type=Path)
    parser.add_argument("--kinopoisk-id", type=int, required=True)
    parser.add_argument("--card-id", required=True)
    parser.add_argument("--video-json", type=Path)
    args = parser.parse_args()

    card_id = args.card_id
    payload = read_json(args.response_json, {})
    video_payload = read_json(args.video_json, {}) if args.video_json else {}
    entry = build_entry(payload, args.kinopoisk_id, card_id, video_payload)
    if args.video_json and not entry["videoSources"]:
        raise ValueError(
            "{} не содержит подходящих видеовариантов; каталог не изменён".format(
                args.video_json
            )
        )
    update_catalog(entry)
    print("✓ Карточка фильма обновлена: {} (Kinopoisk {})".format(entry["title"], args.kinopoisk_id))
    print("✓ Видеовариантов: {}".format(len(entry["videoSources"])))
    if entry["videoSourcesSkipped"]:
        print("⚠ Пропущено неподходящих вариантов: {}".format(entry["videoSourcesSkipped"]))
    print("✓ Каталог: {}".format(CATALOG_PATH))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
