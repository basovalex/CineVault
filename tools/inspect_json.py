#!/usr/bin/env python3
"""Pretty-print and inspect a JSON response that was saved locally.

This tool never makes network requests. Use it for JSON exports or responses
obtained from an API you are authorized to use.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def describe(value: Any, path: str = "$", output: list[str] | None = None) -> list[str]:
    output = output if output is not None else []
    if isinstance(value, dict):
        output.append(f"{path}: object ({len(value)} keys)")
        for key, child in value.items():
            describe(child, f"{path}.{key}", output)
    elif isinstance(value, list):
        output.append(f"{path}: array ({len(value)} items)")
        if value:
            describe(value[0], f"{path}[0]", output)
    else:
        output.append(f"{path}: {type(value).__name__}")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Format and inspect a local JSON file")
    parser.add_argument("input", type=Path, help="Path to an already saved JSON response")
    parser.add_argument("--output", type=Path, help="Optional path for formatted JSON")
    args = parser.parse_args()

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    output_path = args.output or args.input.with_name(f"{args.input.stem}.pretty.json")
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Сохранено: {output_path}")
    print("Структура:")
    print("\n".join(describe(payload)))


if __name__ == "__main__":
    main()
