# -*- coding: utf-8 -*-
import argparse
import json
import subprocess
import sys
from pathlib import Path

import requests

from media_common import (
    PROJECT_DIR,
    extract_kinopoisk_id,
    fetch_legacy,
    GENERATED_DIR,
    load_config,
    normalize_kinopoisk_url,
    save_json,
    save_config,
)


DEFAULT_DELAY_SECONDS = 7
DEFAULT_RETRY_ATTEMPTS = 1


def detect_kind(value, payload=None):
    raw = str(value).lower()
    if "/film/" in raw:
        return "film"
    if "/series/" in raw:
        return "series"
    data = payload.get("data") if isinstance(payload, dict) else None
    category = data.get("category") if isinstance(data, dict) else None
    return "film" if str(category) == "1" else "series"


def main():
    parser = argparse.ArgumentParser(
        description="Добавить одну или несколько карточек Kinopoisk и обновить только их"
    )
    parser.add_argument(
        "kinopoisk",
        nargs="+",
        help="URL или числовой Kinopoisk ID; можно передать несколько значений",
    )
    parser.add_argument("--no-update", action="store_true")
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        help="Пауза между импортом одной карточки и парсингом следующей (по умолчанию 7 сек.)",
    )
    parser.add_argument(
        "--retry-attempts",
        type=int,
        default=DEFAULT_RETRY_ATTEMPTS,
        help=(
            "Сколько раз повторить временные сетевые ошибки после основного прохода "
            "(по умолчанию 1; 0 отключает повторы)"
        ),
    )
    args = parser.parse_args()
    if args.delay_seconds < 0:
        parser.error("--delay-seconds не может быть отрицательным")
    if args.retry_attempts < 0:
        parser.error("--retry-attempts не может быть отрицательным")

    config = load_config()
    targets = []
    changed = False

    for value in args.kinopoisk:
        kp_id = extract_kinopoisk_id(value)
        if any(target_id == kp_id for target_id, _kind in targets):
            print("Пропущен повтор: Kinopoisk {}".format(kp_id))
            continue

        metadata_path = GENERATED_DIR / str(kp_id) / "response.json"
        metadata = {}
        if metadata_path.exists():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                metadata = {}

        explicit_kind = "/film/" in str(value).lower() or "/series/" in str(value).lower()
        if not metadata and not explicit_kind:
            metadata = fetch_legacy(requests.Session(), kp_id)
            save_json(metadata_path, metadata)

        kind = detect_kind(value, metadata)
        url = normalize_kinopoisk_url(value) if explicit_kind else "https://www.kinopoisk.ru/{}/{}/".format(kind, kp_id)
        targets.append((kp_id, kind))

        existing_index = None
        for index, item in enumerate(config["media"]):
            try:
                if extract_kinopoisk_id(item) == kp_id:
                    existing_index = index
                    break
            except Exception:
                pass

        if existing_index is not None:
            current = config["media"][existing_index]
            current_url = current.get("url") if isinstance(current, dict) else current
            current_kind = detect_kind(current_url, metadata)
            if current_kind != kind:
                if isinstance(current, dict):
                    current["url"] = url
                else:
                    config["media"][existing_index] = url
                changed = True
                print("✓ Тип исправлен: {}".format(url))
            else:
                print("Уже есть: {}".format(url))
        else:
            config["media"].append(url)
            changed = True
            print("✓ Добавлено: {}".format(url))

    if changed:
        save_config(config)

    if args.no_update:
        return

    # Один дочерний процесс обновляет только новые/переданные карточки.
    command = [
        sys.executable,
        str(PROJECT_DIR / "update_media.py"),
        "--delay-seconds",
        "{:g}".format(args.delay_seconds),
        "--retry-attempts",
        str(args.retry_attempts),
    ]
    for kp_id, _kind in targets:
        command.extend(["--only", str(kp_id)])
    print("Запускаю обновление:")
    print(" ".join(command))
    result = subprocess.call(command, cwd=str(PROJECT_DIR))
    if result:
        raise SystemExit(result)

    for kp_id, kind in targets:
        print("✓ Kinopoisk {}: {}".format(kp_id, "фильм" if kind == "film" else "сериал"))


if __name__ == "__main__":
    main()
