#!/usr/bin/env python3
"""Build a CineVault catalog card from a generated Kinopoisk episode list.

This script only normalizes data that has already been produced by the local
Kinopoisk media helper. It does not resolve URLs, download media, or transcode
anything.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
APP_DATA = ROOT / "app" / "data"
FILE_STEMS = {160958: "desperate_housewives", 412344: "mentalist"}
CARD_ID_OVERRIDES = {
    # Эта карточка уже была в seedCatalog, поэтому импорт должен её заполнить,
    # а не создавать вторую карточку с тем же сериалом.
    253245: "the-office",
}
# Some upstream episode preview images are known to belong to another title.
# Keep the episode grid coherent by falling back to the series poster instead.
EPISODE_POSTER_POLICIES = {
    5304403: "series-poster",
}


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ]+", "-", str(value or "").strip().lower()).strip("-")
    return value[:80] or "title"


def text_list(value: Any) -> List[str]:
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


def build_entry(input_path: Path) -> Dict[str, Any]:
    rows = read_json(input_path, [])
    if not isinstance(rows, list) or not rows:
        raise ValueError("episode_links.json должен быть непустым массивом")
    first = rows[0]
    kinopoisk_id = int(first.get("kinopoisk_id") or 0)
    if kinopoisk_id < 1:
        raise ValueError("В episode_links.json отсутствует kinopoisk_id")

    generated_dir = input_path.parent
    details = read_json(generated_dir / "response2.json", {})
    if not isinstance(details, dict):
        details = {}
    legacy = read_json(generated_dir / "response.json", {})
    legacy_data = legacy.get("data") if isinstance(legacy, dict) else {}
    if not isinstance(legacy_data, dict):
        legacy_data = {}
    title = str(details.get("title") or first.get("series_title") or f"Kinopoisk {kinopoisk_id}").strip()
    original_title = str(details.get("originalTitle") or first.get("original_series_title") or title).strip()
    slug = FILE_STEMS.get(kinopoisk_id, slugify(title))

    metadata_rows: List[Dict[str, Any]] = []
    source_rows: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        season = int(row.get("season") or 0)
        episode = int(row.get("episode") or 0)
        if season < 1 or episode < 1 or (season, episode) in seen:
            continue
        seen.add((season, episode))
        metadata_rows.append({
            "season": season,
            "episode": episode,
            "episode_id": row.get("episode_id"),
            "title": row.get("title") or f"Серия {episode}",
            "original_title": row.get("original_title") or "",
            "poster": row.get("poster") or "",
        })
        raw_sources = row.get("sources") or []
        sources = []

        if isinstance(raw_sources, list):
            for source_index, source in enumerate(raw_sources, start=1):
                if not isinstance(source, dict):
                    continue

                url = str(source.get("url") or "").strip()
                if not url:
                    continue

                label = str(
                    source.get("label")
                    or "Озвучка {}".format(source_index)
                ).strip()

                sources.append({
                    "label": label,
                    "url": url,
                    "variant_id": source.get("variant_id"),
                    "dubbing_studio_id": source.get("dubbing_studio_id"),
                    "quality": source.get("quality"),
                    "has_adv": source.get("has_adv"),
                })

        # Обратная совместимость со старыми episode_links.json,
        # где было только поле url.
        default_url = str(row.get("url") or "").strip()

        if not sources and default_url:
            sources = [{
                "label": "По умолчанию",
                "url": default_url,
                "variant_id": None,
                "dubbing_studio_id": None,
                "quality": None,
                "has_adv": None,
            }]

        source_rows.append({
            "season": season,
            "episode": episode,
            "episode_id": row.get("episode_id"),

            # Старые поля не убираем, чтобы текущий app.js продолжал работать.
            "token": sources[0]["url"] if sources else "",
            "is_full_url": bool(
                sources
                and str(sources[0].get("url") or "").startswith(
                    ("http://", "https://")
                )
            ),

            # Новое поле со всеми вариантами.
            "sources": sources,
        })
    metadata_rows.sort(key=lambda row: (row["season"], row["episode"]))
    source_rows.sort(key=lambda row: (row["season"], row["episode"]))

    seasons = []
    for season in sorted({row["season"] for row in metadata_rows}):
        seasons.append(max(row["episode"] for row in metadata_rows if row["season"] == season))

    tags = details.get("genres") or []
    if not isinstance(tags, list):
        tags = []
    tags = [str(tag.get("name") if isinstance(tag, dict) else tag).strip().lower() for tag in tags if str(tag.get("name") if isinstance(tag, dict) else tag).strip()]
    if "для нас" not in tags:
        tags.append("для нас")

    rating_kp = number(legacy_data.get("rating_kp"))
    rating_imdb = number(legacy_data.get("rating_imdb"))

    entry = {
        "id": CARD_ID_OVERRIDES.get(kinopoisk_id, f"kinopoisk-{kinopoisk_id}"),
        "kind": "series",
        "title": title,
        "originalTitle": original_title,
        "year": details.get("year"),
        "description": details.get("description") or f"Сериал «{title}» с названиями серий и постерами из импортированного каталога.",
        "tags": tags,
        "genres": text_list(legacy_data.get("genre") or tags),
        "countries": text_list(legacy_data.get("country")),
        "directors": text_list(legacy_data.get("directors")),
        "actors": text_list(legacy_data.get("actors")),
        "producers": text_list(legacy_data.get("producers")),
        "ageRating": str(legacy_data.get("age_restrictions") or legacy_data.get("rating_mpaa") or "").strip(),
        "premiere": str(legacy_data.get("premiere_ru") or legacy_data.get("premiere") or "").strip(),
        "tagline": str(legacy_data.get("tagline") or "").strip(),
        "rating": rating_kp,
        "ratingKinopoisk": rating_kp,
        "imdbRating": rating_imdb,
        "seasons": seasons,
        "runtime": round(int(details.get("duration") or 2580) / 60) if int(details.get("duration") or 0) > 180 else int(details.get("duration") or 43),
        "kinopoiskId": kinopoisk_id,
        "catalogId": details.get("id"),
        "poster": "linear-gradient(145deg, #87644f, #1b2338)",
        "posterImage": details.get("posterUrl") or first.get("poster") or "",
        "providerUrl": f"https://www.kinopoisk.ru/series/{kinopoisk_id}/",
        "providerName": "Kinopoisk · импортированные данные",
        "providerNote": "Названия серий, постеры и источники импортированы автоматически. Видеопоток открывается по подключённому источнику.",
        "sourceFile": f"./data/{slug}_episode_sources.json",
        "episodeDataFile": f"./data/{slug}_episode_metadata.json",
        "episodePosterPolicy": EPISODE_POSTER_POLICIES.get(kinopoisk_id, "episode-stills"),
    }
    return {"entry": entry, "source_rows": source_rows, "metadata_rows": metadata_rows}


def update_catalog(entry: Dict[str, Any]) -> None:
    catalog_path = APP_DATA / "catalog_imports.json"
    catalog = read_json(catalog_path, [])
    if not isinstance(catalog, list):
        catalog = []
    key = int(entry.get("kinopoiskId") or 0)
    replaced = False
    updated = []
    for current in catalog:
        if isinstance(current, dict) and int(current.get("kinopoiskId") or 0) == key:
            updated.append(entry)
            replaced = True
        else:
            updated.append(current)
    if not replaced:
        updated.append(entry)
    write_json(catalog_path, updated)


def main() -> int:
    parser = argparse.ArgumentParser(description="Создать карточку CineVault из generated/ID/episode_links.json")
    parser.add_argument("episode_links", type=Path)
    args = parser.parse_args()
    result = build_entry(args.episode_links)
    entry = result["entry"]
    slug = FILE_STEMS.get(int(entry["kinopoiskId"]), slugify(entry["title"]))
    write_json(APP_DATA / f"{slug}_episode_sources.json", result["source_rows"])
    write_json(APP_DATA / f"{slug}_episode_metadata.json", result["metadata_rows"])
    update_catalog(entry)
    print(f"✓ Карточка создана/обновлена: {entry['title']} (Kinopoisk {entry['kinopoiskId']})")
    print(f"✓ Серий в импорте: {len(result['metadata_rows'])}")
    print(f"✓ Источники: app/data/{slug}_episode_sources.json")
    print(f"✓ Метаданные серий: app/data/{slug}_episode_metadata.json")
    print("✓ Каталог: app/data/catalog_imports.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
