#!/usr/bin/env python3
"""Add a Kinopoisk card by ID or link without resolving a video stream."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def kinopoisk_id(value: str) -> int:
    raw = str(value).strip()
    if raw.isdigit():
        return int(raw)
    match = re.search(r"kinopoisk\.ru/(?:film|series)/(\d+)", raw, re.IGNORECASE)
    if not match:
        raise ValueError("Укажи Kinopoisk ID или ссылку вида https://www.kinopoisk.ru/series/412344/")
    return int(match.group(1))


def main() -> int:
    parser = argparse.ArgumentParser(description="Добавить фильм или сериал по Kinopoisk ID в CineVault")
    parser.add_argument("kinopoisk", help="ID или ссылка Kinopoisk")
    parser.add_argument("--no-update", action="store_true", help="Использовать только уже сохранённые метаданные")
    args = parser.parse_args()

    try:
        kinopoisk_id(args.kinopoisk)
    except ValueError as error:
        parser.error(str(error))

    command = [sys.executable, str(Path(__file__).with_name("import_kinopoisk_metadata.py")), str(args.kinopoisk)]
    if not args.no_update:
        command.append("--fetch-missing")
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
