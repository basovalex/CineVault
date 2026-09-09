#!/usr/bin/env python3
"""Import per-episode source tokens without downloading media.

The input is a JSON array with objects such as:
{
  "season": 1,
  "episode": 1,
  "url": "provider-token-or-full-url",
  "episode_id": 1278318
}

Tokens are stored as data only.  The script deliberately does not resolve,
probe, download, or rewrite provider URLs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "app" / "data" / "desperate_housewives_episode_sources.json"


def positive_int(value: Any, field: str, index: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Запись #{index}: поле {field} должно быть числом") from error
    if number < 1:
        raise ValueError(f"Запись #{index}: поле {field} должно быть больше нуля")
    return number


def import_rows(input_path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    try:
        payload = json.loads(input_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Файл не найден: {input_path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"JSON содержит ошибку в строке {error.lineno}, столбце {error.colno}") from error

    if not isinstance(payload, list):
        raise ValueError("Корень JSON должен быть массивом объектов")

    normalized: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    warnings: list[str] = []
    for index, raw in enumerate(payload, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"Запись #{index}: ожидался объект")
        try:
            season_value = int(raw.get("season"))
            episode_value = int(raw.get("episode"))
        except (TypeError, ValueError) as error:
            raise ValueError(f"Запись #{index}: поля season и episode должны быть числами") from error
        if season_value > 0 and episode_value == 0:
            warnings.append(f"Пропущена служебная запись #{index}: S{season_value:02d}E00")
            continue
        season = positive_int(season_value, "season", index)
        episode = positive_int(episode_value, "episode", index)
        token = str(raw.get("url") or "").strip()
        if not token:
            raise ValueError(f"Запись #{index}: пустое поле url")
        key = (season, episode)
        if key in seen:
            raise ValueError(f"Дубликат: сезон {season}, серия {episode}")
        seen.add(key)

        episode_id = raw.get("episode_id")
        if episode_id in (None, ""):
            warnings.append(f"S{season:02d}E{episode:02d}: отсутствует episode_id")

        normalized.append(
            {
                "season": season,
                "episode": episode,
                "episode_id": episode_id,
                "token": token,
                "is_full_url": token.startswith(("http://", "https://")),
            }
        )

    normalized.sort(key=lambda row: (row["season"], row["episode"]))
    return normalized, warnings


def merge_rows(output_path: Path, new_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge new episode sources into the existing generated source file."""
    if not output_path.exists():
        return new_rows

    try:
        existing = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Нельзя прочитать существующий файл {output_path}: {error}") from error
    if not isinstance(existing, list):
        raise ValueError(f"Существующий файл {output_path} должен содержать JSON-массив")

    merged: dict[tuple[int, int], dict[str, Any]] = {}
    for index, row in enumerate(existing, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Существующий файл: запись #{index} должна быть объектом")
        try:
            key = (int(row["season"]), int(row["episode"]))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Существующий файл: запись #{index} повреждена") from error
        merged[key] = row

    for row in new_rows:
        merged[(row["season"], row["episode"])] = row
    return sorted(merged.values(), key=lambda row: (int(row["season"]), int(row["episode"])))


def main() -> int:
    parser = argparse.ArgumentParser(description="Импорт токенов серий в CineVault")
    parser.add_argument("input", type=Path, help="Путь к JSON-массиву с season, episode, url и episode_id")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"Файл результата (по умолчанию: {DEFAULT_OUTPUT})")
    parser.add_argument("--dry-run", action="store_true", help="Только проверить JSON, ничего не записывать")
    parser.add_argument("--merge", action="store_true", help="Добавить/обновить записи, сохранив остальные серии")
    args = parser.parse_args()

    try:
        rows, warnings = import_rows(args.input)
    except ValueError as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1

    output_rows = rows
    if args.merge:
        try:
            output_rows = merge_rows(args.output, rows)
        except ValueError as error:
            print(f"Ошибка: {error}", file=sys.stderr)
            return 1

    print(f"Проверено записей во входном JSON: {len(rows)}")
    print(f"Будет сохранено записей: {len(output_rows)}")
    print(f"Сезонов: {len({row['season'] for row in output_rows})}")
    print(f"Полных URL во входном JSON: {sum(row['is_full_url'] for row in rows)}")
    print(f"Токенов во входном JSON: {sum(not row['is_full_url'] for row in rows)}")
    for warning in warnings:
        print(f"Предупреждение: {warning}")

    if args.dry_run:
        print("Проверка завершена, файл не изменён.")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Сохранено: {args.output}")
    print("Важно: токены сохранены как данные; скрипт не строит из них поток и ничего не скачивает.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
