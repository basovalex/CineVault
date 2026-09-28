#!/usr/bin/env python3
"""Import metadata-only cards from a public Kinopoisk year list.

Kinopoisk serves this page through browser JavaScript and may show an anti-bot
screen to plain HTTP clients.  The script therefore uses an installed Chrome
through Playwright, imports only visible public metadata, and never requests a
video provider.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterable, List

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402
from tools.sync_kinopoisk_dev_catalog import positive_int  # noqa: E402


CARD_SELECTOR = '[data-test-id="movie-list-item"]'
LIST_URL = "https://www.kinopoisk.ru/lists/movies/year--{year}/?b=films&page={page}"


def save_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _high_resolution_poster(value: str) -> str:
    """Use a catalogue-sized Kinopoisk poster instead of its tiny list thumbnail."""
    result = str(value or "").strip()
    if result.startswith("//"):
        result = "https:" + result
    return re.sub(
        r"^(https?://avatars\.mds\.yandex\.net/get-kinopoisk-image/[^/]+/[^/]+/)\d+x\d+([?#].*)?$",
        r"\g<1>600x900\2",
        result,
        flags=re.I,
    )


def _poster_from_srcset(value: str, fallback: str) -> str:
    candidates = []
    for item in str(value or "").split(","):
        url = item.strip().split(" ", 1)[0]
        if url:
            candidates.append(url)
    result = candidates[-1] if candidates else str(fallback or "")
    return _high_resolution_poster(result)


def catalog_entry_from_browser_row(row: Dict[str, Any], year: int) -> Dict[str, Any]:
    href = str(row.get("href") or "")
    match = re.search(r"/film/(\d+)/", href)
    lines = [str(value).strip(" ,\xa0") for value in row.get("lines", []) if str(value).strip(" ,\xa0")]
    title = str(row.get("title") or (lines[0] if lines else "")).strip()
    if not match or not title:
        raise ValueError("У карточки нет Kinopoisk ID или названия")

    original_title = ""
    info_index = 1
    if len(lines) > 1 and not re.search(r"\b\d{4}\b", lines[1]):
        original_title = lines[1]
        info_index = 2
    info = lines[info_index] if len(lines) > info_index else ""
    country_genre = lines[info_index + 1] if len(lines) > info_index + 1 else ""
    country_genre = country_genre.split("Режиссёр:", 1)[0].strip()
    parts = [part.strip() for part in re.split(r"\s*[•·]\s*", country_genre) if part.strip()]
    countries = [parts[0]] if parts else []
    genres = []
    if len(parts) > 1:
        genres = [genre.strip() for genre in re.split(r",\s*", parts[1]) if genre.strip()]

    detected_year = year
    year_match = re.search(r"\b(18|19|20)\d{2}\b", info)
    if year_match:
        detected_year = int(year_match.group(0))
    rating_match = re.search(r"Рейтинг Кинопоиска\s+([0-9]+(?:[.,][0-9]+)?)", str(row.get("text") or ""))
    rating = float(rating_match.group(1).replace(",", ".")) if rating_match else None
    kp_id = int(match.group(1))
    return {
        "id": "kinopoisk-{}".format(kp_id),
        "kinopoiskId": kp_id,
        "kind": "movie",
        "title": title,
        "originalTitle": original_title or title,
        "year": detected_year,
        "description": "",
        "genres": genres,
        "tags": genres,
        "countries": countries,
        "rating": rating,
        "ratingKinopoisk": rating,
        "posterImage": _poster_from_srcset(str(row.get("srcset") or ""), str(row.get("src") or "")),
        "providerUrl": "https://www.kinopoisk.ru/film/{}/".format(kp_id),
        "providerName": "Кинопоиск · публичный список",
        "providerNote": "Карточка содержит метаданные. Видеопоток запрашивается при открытии.",
        "videoSources": [],
    }


def merge_entries(entries: Iterable[Dict[str, Any]], cards: Dict[int, Dict[str, Any]], legacy_ids: set[int]) -> Dict[str, int]:
    result = {"seen": 0, "created": 0, "updated": 0, "skipped": 0}
    for entry in entries:
        result["seen"] += 1
        kp_id = positive_int(entry.get("kinopoiskId"))
        if not kp_id or kp_id in legacy_ids:
            result["skipped"] += 1
            continue
        previous = cards.get(kp_id)
        if previous is None:
            cards[kp_id] = entry
            result["created"] += 1
            continue
        preserved = {
            key: previous[key]
            for key in ("description", "directors", "actors", "producers", "imdbRating", "runtime",
                        "ageRating", "premiere", "tagline", "videoSources", "sourceFile",
                        "episodeDataFile", "seasons", "catalogId")
            if previous.get(key)
        }
        cards[kp_id] = {**previous, **entry, **preserved}
        result["updated"] += 1
    return result


def extract_rows(page: Any) -> List[Dict[str, Any]]:
    return page.locator(CARD_SELECTOR).evaluate_all(
        """cards => cards.map(card => {
          const links = [...card.querySelectorAll('a[href]')];
          const link = links.find(a => /^\\/film\\/\\d+\\/$/.test(a.getAttribute('href') || '') && a.innerText.trim())
            || links.find(a => /^\\/film\\/\\d+\\/$/.test(a.getAttribute('href') || ''));
          const image = card.querySelector('img[alt]') || card.querySelector('img');
          return {
            href: link ? link.getAttribute('href') : '',
            title: image ? image.getAttribute('alt') : '',
            lines: link ? link.innerText.split('\\n') : [],
            text: card.innerText,
            src: image ? (image.getAttribute('src') || '') : '',
            srcset: image ? (image.getAttribute('srcset') || '') : ''
          };
        })"""
    )


def discover_last_page(page: Any) -> int:
    hrefs = page.locator('a[href*="page="]').evaluate_all("links => links.map(link => link.href)")
    numbers = [int(value) for href in hrefs for value in re.findall(r"[?&]page=(\d+)", href)]
    return max(numbers, default=1)


def sync(year: int, catalog_path: Path, metadata_path: Path, start_page: int,
         pages: int, delay_seconds: float, headed: bool, dry_run: bool) -> Dict[str, int]:
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Установи Playwright: python3 -m pip install playwright") from exc

    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    if not isinstance(legacy, list) or not isinstance(existing, list):
        raise ValueError("Файлы каталога должны содержать массивы")
    legacy_ids = {positive_int(item.get("kinopoiskId")) for item in legacy if isinstance(item, dict)}
    cards = {
        positive_int(item.get("kinopoiskId")): item
        for item in existing if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))
    }
    totals = {"pages": 0, "seen": 0, "created": 0, "updated": 0, "skipped": 0, "last_page": 0}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not headed, channel="chrome")
        context = browser.new_context(locale="ru-RU")
        page = context.new_page()
        last_page = 0
        try:
            current = start_page
            while True:
                page.goto(LIST_URL.format(year=year, page=current), wait_until="domcontentloaded", timeout=60_000)
                try:
                    page.locator(CARD_SELECTOR).first.wait_for(timeout=60_000)
                except PlaywrightTimeoutError as exc:
                    raise RuntimeError("Кинопоиск не показал список: возможно, включилась антибот-проверка") from exc
                if not last_page:
                    last_page = discover_last_page(page)
                    if pages:
                        last_page = min(last_page, start_page + pages - 1)
                rows = extract_rows(page)
                entries = []
                for row in rows:
                    try:
                        entries.append(catalog_entry_from_browser_row(row, year))
                    except ValueError:
                        continue
                if not entries:
                    raise RuntimeError("На странице {} не найдено ни одной корректной карточки".format(current))
                result = merge_entries(entries, cards, legacy_ids)
                for key in ("seen", "created", "updated", "skipped"):
                    totals[key] += result[key]
                totals["pages"] += 1
                totals["last_page"] = current
                if not dry_run:
                    save_json_atomic(metadata_path, list(cards.values()))
                print("Страница {}/{}: найдено {}, новых {}, обновлено {}, пропущено {}".format(
                    current, last_page, result["seen"], result["created"], result["updated"], result["skipped"]
                ), flush=True)
                if current >= last_page:
                    break
                current += 1
                if delay_seconds:
                    time.sleep(delay_seconds)
        finally:
            context.close()
            browser.close()
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Добавить карточки из публичного списка Кинопоиска по году")
    parser.add_argument("--year", type=int, default=date.today().year)
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--pages", type=int, default=0, help="0 — пройти все страницы до последней")
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--headed", action="store_true", help="Показать окно Chrome")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1900 <= args.year <= date.today().year + 5 or args.start_page < 1 or args.pages < 0 or args.delay_seconds < 0:
        parser.error("Проверь year, start-page, pages и delay-seconds")
    try:
        result = sync(args.year, args.catalog_path, args.metadata_path, args.start_page,
                      args.pages, args.delay_seconds, args.headed, args.dry_run)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        parser.exit(1, "Синхронизация остановлена: {}\n".format(exc))
    print("{}: страниц {pages}, просмотрено {seen}, добавлено {created}, обновлено {updated}, пропущено {skipped}".format(
        "Проверено" if args.dry_run else "Сохранено", **result
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
