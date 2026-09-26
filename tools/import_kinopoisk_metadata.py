#!/usr/bin/env python3
"""Import Kinopoisk cards from IDs/links without resolving or storing video streams.

The output is separate from catalog_imports.json so the server's existing cards
and playback sources are never replaced by a bulk metadata run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.sync_kinopoisk_film import build_entry  # noqa: E402


DEFAULT_LINKS = ROOT / "kinopoisk_media_system_fixed" / "media_sources.json"
DEFAULT_GENERATED = ROOT / "kinopoisk_media_system_fixed" / "generated"
DEFAULT_CATALOG = ROOT / "app" / "data" / "catalog_imports.json"
DEFAULT_METADATA = ROOT / "app" / "data" / "catalog_metadata.json"
KINOPOISK_LINK = re.compile(r"^https?://(?:www\.)?kinopoisk\.ru/(film|series)/(\d+)/?(?:[?#].*)?$", re.I)


def parse_target(value: Any) -> Tuple[int, str]:
    raw = str(value.get("url") if isinstance(value, dict) else value or "").strip()
    match = KINOPOISK_LINK.fullmatch(raw)
    if match and int(match.group(2)) > 0:
        return int(match.group(2)), match.group(1).lower()
    if raw.isdigit() and int(raw) > 0:
        return int(raw), ""
    raise ValueError("Ожидался Kinopoisk ID или ссылка /film/ID/ либо /series/ID/")


def read_json(path: Path, fallback: Any) -> Any:
    if not path.is_file():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def read_targets(path: Path) -> List[Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        payload = json.loads(text)
        rows = payload.get("media") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise ValueError("JSON со ссылками должен содержать массив или поле media")
        return rows
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def metadata_entry(payload: Dict[str, Any], kp_id: int, explicit_kind: str) -> Dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or not str(data.get("name") or "").strip():
        raise ValueError("Нет названия карточки в метаданных Kinopoisk")
    kind = explicit_kind or ("film" if str(data.get("category") or "") == "1" else "series")
    entry = build_entry(payload, kp_id, "kinopoisk-{}".format(kp_id))
    entry["kind"] = "movie" if kind == "film" else "series"
    entry["providerUrl"] = "https://www.kinopoisk.ru/{}/{}/".format(kind, kp_id)
    entry["providerNote"] = "Карточка содержит метаданные. Видеопоток запрашивается при открытии."
    entry["tags"] = [tag for tag in entry.get("tags", []) if tag != "для нас"]
    entry["videoSources"] = []
    entry.pop("videoSourcesSkipped", None)
    if kind == "series":
        entry["seasons"] = []
    return entry


def load_legacy_ids(path: Path) -> set:
    rows = read_json(path, [])
    if not isinstance(rows, list):
        raise ValueError("Основной каталог должен содержать массив")
    return {int(item.get("kinopoiskId") or 0) for item in rows if isinstance(item, dict) and str(item.get("kinopoiskId") or "").isdigit()}


def fetch_metadata(session: requests.Session, kp_id: int, token: str) -> Dict[str, Any]:
    if not token:
        raise ValueError("Для новых ID задай CINEVAULT_APBUGALL_TOKEN в окружении")
    response = session.post("https://api.apbugall.org/", params={"token": token, "kp": kp_id}, timeout=40)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Провайдер вернул некорректные метаданные")
    return payload


def import_links(
    targets: Iterable[Any], *, catalog_path: Path, metadata_path: Path,
    generated_dir: Path, dry_run: bool = False, offset: int = 0, limit: int = 0,
    fetch_missing: bool = False, token: str = "", delay_seconds: float = 1.0,
) -> Dict[str, int]:
    legacy_ids = load_legacy_ids(catalog_path)
    existing = read_json(metadata_path, [])
    if not isinstance(existing, list):
        raise ValueError("Каталог метаданных должен содержать массив")
    cards = {int(item["kinopoiskId"]): item for item in existing if isinstance(item, dict) and str(item.get("kinopoiskId") or "").isdigit()}
    counts = {"seen": 0, "created": 0, "updated": 0, "already_in_catalog": 0, "missing_metadata": 0}
    selected = list(targets)[max(0, offset):]
    if limit > 0:
        selected = selected[:limit]
    seen_ids = set()
    with requests.Session() as session:
        for raw in selected:
            kp_id, explicit_kind = parse_target(raw)
            if kp_id in seen_ids:
                continue
            seen_ids.add(kp_id)
            counts["seen"] += 1
            if kp_id in legacy_ids:
                counts["already_in_catalog"] += 1
                continue
            source = generated_dir / str(kp_id) / "response.json"
            try:
                payload = read_json(source, {})
            except json.JSONDecodeError:
                payload = {}
            if not payload and fetch_missing and not dry_run and token:
                try:
                    payload = fetch_metadata(session, kp_id, token)
                except (requests.RequestException, ValueError):
                    payload = {}
                if delay_seconds:
                    time.sleep(delay_seconds)
            if not payload:
                counts["missing_metadata"] += 1
                continue
            try:
                entry = metadata_entry(payload, kp_id, explicit_kind)
            except ValueError:
                counts["missing_metadata"] += 1
                continue
            old = cards.get(kp_id)
            if old is not None and old != entry:
                counts["updated"] += 1
            elif old is None:
                counts["created"] += 1
            cards[kp_id] = entry
    if not dry_run and (counts["created"] or counts["updated"]):
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = metadata_path.with_suffix(metadata_path.suffix + ".tmp")
        temporary.write_text(json.dumps(list(cards.values()), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, metadata_path)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Импортировать только карточки Kinopoisk по списку ссылок/ID")
    parser.add_argument("targets", nargs="*", help="Отдельные Kinopoisk ID или ссылки; если не указаны, используется --links-file")
    parser.add_argument("--links-file", type=Path, default=DEFAULT_LINKS, help="JSON media_sources.json или текстовый файл: ссылка/ID на строку")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--generated-dir", type=Path, default=DEFAULT_GENERATED)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=0, help="Максимум записей за запуск; 0 — весь файл")
    parser.add_argument("--fetch-missing", action="store_true", help="Получить недостающие метаданные у настроенного провайдера; видео не запрашивается")
    parser.add_argument("--delay-seconds", type=float, default=1.0, help="Пауза между сетевыми запросами")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.offset < 0 or args.limit < 0 or args.delay_seconds < 0:
        parser.error("offset, limit и delay-seconds не могут быть отрицательными")
    token = os.environ.get("CINEVAULT_APBUGALL_TOKEN", "").strip()
    try:
        result = import_links(args.targets or read_targets(args.links_file), catalog_path=args.catalog_path,
                              metadata_path=args.metadata_path, generated_dir=args.generated_dir,
                              dry_run=args.dry_run, offset=args.offset, limit=args.limit,
                              fetch_missing=args.fetch_missing, token=token, delay_seconds=args.delay_seconds)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, "Ошибка импорта метаданных: {}\n".format(exc))
    print("{}: просмотрено {seen}, новых {created}, обновлено {updated}, уже в каталоге {already_in_catalog}, без метаданных {missing_metadata}".format(
        "Проверено" if args.dry_run else "Сохранено", **result))
    if args.targets and result["missing_metadata"] and not (result["created"] or result["updated"] or result["already_in_catalog"]):
        print("Карточка не добавлена: нет метаданных. Для сетевого получения задай CINEVAULT_APBUGALL_TOKEN.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
