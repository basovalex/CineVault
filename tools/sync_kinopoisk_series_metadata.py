#!/usr/bin/env python3
"""Импортировать метаданные сериала, не извлекая сторонние видеоссылки."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "app" / "data" / "catalog_imports.json"
SERIES_CARD_IDS = {
    160958: "desperate-housewives",
    412344: "the-mentalist",
    404900: "kinopoisk-404900",
    253245: "the-office",
}


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
    raw = value if isinstance(value, list) else re.split(r"[,;/|]", str(value or ""))
    tags = [str(item.get("name") if isinstance(item, dict) else item).strip().lower() for item in raw]
    tags = [tag for tag in tags if tag]
    if "для нас" not in tags:
        tags.append("для нас")
    return list(dict.fromkeys(tags))


def season_counts(data: Dict[str, Any]) -> list[int]:
    seasons = data.get("seasons") if isinstance(data, dict) else None
    if not isinstance(seasons, dict):
        return []
    counts = []
    for season_number in sorted(seasons, key=lambda value: int(value) if str(value).isdigit() else 999):
        season = seasons.get(season_number)
        episodes = season.get("episodes") if isinstance(season, dict) else None
        if isinstance(episodes, dict):
            count = sum(1 for episode in episodes.values() if isinstance(episode, dict) and int(episode.get("episode") or 0) > 0)
            if count:
                counts.append(count)
    return counts


def build_entry(payload: Dict[str, Any], kinopoisk_id: int, card_id: str) -> Dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ValueError("response.json не содержит объекта data")
    title = str(data.get("name") or "Kinopoisk {}".format(kinopoisk_id)).strip()
    return {
        "id": card_id,
        "kind": "series",
        "title": title,
        "originalTitle": str(data.get("original_name") or title).strip(),
        "year": as_int(data.get("year")),
        "description": str(data.get("description") or "").strip(),
        "tags": tags_from(data.get("genre")),
        "runtime": runtime_minutes(data.get("time") or data.get("duration")),
        "seasons": season_counts(data) or [1],
        "kinopoiskId": kinopoisk_id,
        "posterImage": str(data.get("poster") or data.get("posterUrl") or "").strip(),
        "providerUrl": "https://www.kinopoisk.ru/series/{}/".format(kinopoisk_id),
        "providerName": "Kinopoisk · импортированные данные",
        "providerNote": "Метаданные и постер импортированы автоматически. Список серий подключается из отдельного разрешённого источника.",
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
            merged = dict(current)
            merged.update(entry)
            for key in ("seasons", "sourceFile", "episodeDataFile"):
                if key in current and key not in entry:
                    merged[key] = current[key]
            updated.append(merged)
            replaced = True
        else:
            updated.append(current)
    if not replaced:
        updated.append(entry)
    write_json(CATALOG_PATH, updated)


def main() -> int:
    parser = argparse.ArgumentParser(description="Импортировать метаданные сериала в CineVault")
    parser.add_argument("response_json", type=Path)
    parser.add_argument("--kinopoisk-id", type=int, required=True)
    parser.add_argument("--card-id")
    args = parser.parse_args()
    card_id = args.card_id or SERIES_CARD_IDS.get(args.kinopoisk_id) or "kinopoisk-{}".format(args.kinopoisk_id)
    entry = build_entry(read_json(args.response_json, {}), args.kinopoisk_id, card_id)
    update_catalog(entry)
    print("✓ Карточка сериала обновлена: {} (Kinopoisk {})".format(entry["title"], args.kinopoisk_id))
    print("✓ Каталог: {}".format(CATALOG_PATH))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
