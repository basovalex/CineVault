"""Ratchet for app/styles.css: raw values may only go down.

Colours and font sizes belong in custom properties. The stylesheet is far from
that today, so the budgets below record the current debt and the test fails as
soon as a change adds to it. Lower a budget whenever the real number drops.

Print the current numbers: python3 tests/test_site_styles.py --report
"""
from __future__ import annotations

import re
import sys
import unittest
from collections import Counter
from pathlib import Path

STYLES = Path(__file__).resolve().parents[1] / "app" / "styles.css"

BUDGET = {
    "important": 17,
    "raw_colors": 128,
    "distinct_raw_colors": 77,
    "raw_font_sizes": 91,
    "distinct_font_sizes": 28,
    "distinct_radii": 21,
    "width_breakpoints": 3,
}

COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^()]*\)")
DECLARATION_RE = re.compile(r"(?:^|[;{}])\s*(--[\w-]+|[\w-]+)\s*:\s*([^;{}]+)")
WIDTH_QUERY_RE = re.compile(r"\((?:max|min)-width:\s*(\d+)px\)")


def read_styles() -> str:
    return re.sub(r"/\*.*?\*/", "", STYLES.read_text(encoding="utf-8"), flags=re.S)


def normalise(value: str) -> str:
    return re.sub(r"\s+", "", value.replace("!important", "")).lower()


def breakpoint_edges(css: str) -> set[int]:
    edges = set()
    for query in re.findall(r"@media[^{]+", css):
        for kind_width in re.finditer(r"\((max|min)-width:\s*(\d+)px\)", query):
            width = int(kind_width.group(2))
            edges.add(width - 1 if kind_width.group(1) == "min" else width)
    return edges


def measure(css: str | None = None) -> dict[str, object]:
    css = read_styles() if css is None else css
    raw_colors: list[str] = []
    font_sizes: list[str] = []
    radii: list[str] = []
    for name, value in DECLARATION_RE.findall(css):
        if name.startswith("--"):
            continue
        raw_colors += [normalise(color) for color in COLOR_RE.findall(value)]
        if name == "font-size" and "var(" not in value:
            font_sizes.append(normalise(value))
        if name == "border-radius" and "var(" not in value:
            radii.append(normalise(value))
    edges = breakpoint_edges(css)
    return {
        "important": css.count("!important"),
        "raw_colors": len(raw_colors),
        "distinct_raw_colors": len(set(raw_colors)),
        "raw_font_sizes": len(font_sizes),
        "distinct_font_sizes": len(set(font_sizes)),
        "distinct_radii": len(set(radii)),
        "width_breakpoints": len(edges),
        "_breakpoints": sorted(edges),
        "_top_colors": Counter(raw_colors).most_common(12),
        "_top_font_sizes": Counter(font_sizes).most_common(12),
    }


class StyleDebtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.numbers = measure()

    def check(self, key: str, hint: str) -> None:
        actual = self.numbers[key]
        self.assertLessEqual(actual, BUDGET[key], f"{key}: стало {actual}, было {BUDGET[key]}. {hint}")

    def test_important_does_not_grow(self) -> None:
        self.check("important", "Не добавляй !important: подними специфичность или поправь порядок правил.")

    def test_raw_colors_do_not_grow(self) -> None:
        self.check("raw_colors", "Цвет бери из переменной в :root, новые значения заводи там.")
        self.check("distinct_raw_colors", "Появился новый оттенок мимо токенов.")

    def test_raw_font_sizes_do_not_grow(self) -> None:
        self.check("raw_font_sizes", "Размер шрифта бери из шкалы токенов.")
        self.check("distinct_font_sizes", "Появился новый размер шрифта мимо шкалы.")

    def test_radii_do_not_grow(self) -> None:
        self.check("distinct_radii", "Радиус бери из токенов.")

    def test_breakpoints_do_not_grow(self) -> None:
        self.check("width_breakpoints", f"Сейчас: {self.numbers['_breakpoints']}. Новый брейкпоинт не заводи.")

    def test_measure_counts_only_values_outside_tokens(self) -> None:
        sample = ":root{--accent:#f00;--size:14px}.a{color:var(--accent);font-size:var(--size)}.b{color:#0f0 !important;font-size:15px;border-radius:7px}@media (max-width: 620px){.c{background:rgba(0, 0, 0, .5)}}@media (min-width: 621px){.c{color:#0F0}}"
        numbers = measure(sample)
        self.assertEqual(numbers["important"], 1)
        self.assertEqual(numbers["raw_colors"], 3)
        self.assertEqual(numbers["distinct_raw_colors"], 2)
        self.assertEqual(numbers["raw_font_sizes"], 1)
        self.assertEqual(numbers["distinct_radii"], 1)
        self.assertEqual(numbers["width_breakpoints"], 1)


if __name__ == "__main__":
    if "--report" in sys.argv:
        for key, value in measure().items():
            print(f"{key}: {value}")
    else:
        unittest.main()
