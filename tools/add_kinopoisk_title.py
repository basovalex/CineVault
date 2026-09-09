#!/usr/bin/env python3
"""Add a Kinopoisk film or series and build its CineVault card in one command."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


EXTERNAL_MEDIA_PROJECT = Path(
    "/Users/aleksandrbasov/PycharmProjects/parsers/lk_dreamjob_reviews_parser-main/kinopoisk_media_system_fixed"
)
FILM_CARD_IDS = {
    566766: "sintel-open",
    420145: "big-buck-bunny-open",
    313444: "elephants-dream-open",
    44386: "gentlemen-of-fortune-rutube",
    258687: "interstellar",
    662596: "about-time",
    807339: "little-women",
    1188529: "knives-out",
    104927: "the-holiday",
    718811: "arrival",
    326: "shawshank-redemption",
    435: "green-mile",
    448: "forrest-gump",
    301: "the-matrix",
    195334: "prestige",
    1043758: "parasite",
    683999: "grand-budapest",
    328: "lord-of-the-rings",
    689: "harry-potter-1",
}


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
    parser.add_argument("--no-update", action="store_true", help="Использовать уже созданный generated JSON без новых запросов")
    args = parser.parse_args()

    try:
        kp_id = kinopoisk_id(args.kinopoisk)
    except ValueError as error:
        parser.error(str(error))

    if not EXTERNAL_MEDIA_PROJECT.exists():
        print(f"Ошибка: не найден медиапроект {EXTERNAL_MEDIA_PROJECT}", file=sys.stderr)
        return 1

    command = [sys.executable, str(EXTERNAL_MEDIA_PROJECT / "add_media.py"), str(args.kinopoisk)]
    if args.no_update:
        command.append("--no-update")
    print("Запускаю импорт:")
    print(" ".join(command))
    return subprocess.call(command, cwd=str(EXTERNAL_MEDIA_PROJECT))


if __name__ == "__main__":
    raise SystemExit(main())
