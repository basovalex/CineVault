# -*- coding: utf-8 -*-
"""Обновить сериалы и фильмы из media_sources.json."""

import argparse
import re
import shutil
import subprocess
import sys
import time

import requests

from media_common import (
    PROJECT_DIR,
    SERVICE_DIR,
    extract_kinopoisk_id,
    fetch_film_metadata,
    fetch_series_by_kinopoisk,
    load_config,
)


# Не даём внешним API получить плотную серию запросов при пакетном запуске.
# Значение можно переопределить через --delay-seconds 0 или своим интервалом.
DEFAULT_DELAY_SECONDS = 7
DEFAULT_RETRY_ATTEMPTS = 1


UNAVAILABLE_SOURCE_MARKERS = (
    "api не вернул метаданные фильма",
    "api не вернул ни одного видеоварианта фильма",
    "не удалось найти veoveo/movie_id",
)


RETRYABLE_HTTP_STATUSES = {408, 425, 429, 500, 502, 503, 504}
RETRYABLE_ERROR_MARKERS = (
    "ssleoferror",
    "sslerror",
    "max retries exceeded",
    "connection aborted",
    "connection reset",
    "remote disconnected",
    "temporarily unavailable",
    "timed out",
    "timeout",
)


def source_is_unavailable(error):
    """Вернуть True для штатного отсутствия карточки у внешнего источника.

    Это не транспортная ошибка: существующая карточка CineVault остаётся без
    изменений, а обновление остальных карточек продолжается.
    """
    message = str(error).casefold()
    return any(marker in message for marker in UNAVAILABLE_SOURCE_MARKERS)


def error_is_retryable(error):
    """Вернуть True для временных сетевых и серверных ошибок."""
    current = error
    visited = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(
            current,
            (
                requests.exceptions.Timeout,
                requests.exceptions.ConnectionError,
                requests.exceptions.SSLError,
            ),
        ):
            return True
        if isinstance(current, requests.exceptions.HTTPError):
            response = getattr(current, "response", None)
            if response is not None and response.status_code in RETRYABLE_HTTP_STATUSES:
                return True
        current = current.__cause__ or current.__context__

    message = str(error).casefold()
    return any(marker in message for marker in RETRYABLE_ERROR_MARKERS)


def catalog_file_stem(title, kinopoisk_id):
    known_stems = {
        160958: "desperate_housewives",
        412344: "mentalist",
        404900: "во-все-тяжкие",
    }
    if int(kinopoisk_id) in known_stems:
        return known_stems[int(kinopoisk_id)]
    stem = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ]+", "-", str(title or "").strip().lower()).strip("-")
    return stem[:80] or "kinopoisk-{}".format(kinopoisk_id)


def import_into_service(json_path, kinopoisk_id, title):
    importer = SERVICE_DIR / "tools" / "import_episode_links.py"
    if not importer.exists():
        raise RuntimeError("Не найден импортёр сервиса: {}".format(importer))
    output_path = SERVICE_DIR / "app" / "data" / "{}_episode_sources.json".format(catalog_file_stem(title, kinopoisk_id))
    command = [sys.executable, str(importer), str(json_path), "--output", str(output_path), "--merge"]
    print("\n5. Импортирую в сервис:")
    print(" ".join(command))
    result = subprocess.call(command, cwd=str(SERVICE_DIR))
    if result != 0:
        raise RuntimeError("import_episode_links.py завершился с кодом {}".format(result))
    print("✓ Импортировано в {}".format(output_path))


def sync_cinevault_catalog(json_path):
    sync_script = SERVICE_DIR / "tools" / "sync_kinopoisk_catalog.py"
    if not sync_script.exists():
        raise RuntimeError("Не найден синхронизатор карточек CineVault: {}".format(sync_script))
    command = [sys.executable, str(sync_script), str(json_path)]
    print("\n6. Обновляю карточку CineVault:")
    print(" ".join(command))
    result = subprocess.call(command, cwd=str(SERVICE_DIR))
    if result != 0:
        raise RuntimeError("sync_kinopoisk_catalog.py завершился с кодом {}".format(result))


def sync_cinevault_film(json_path, kinopoisk_id, card_id, video_json=None):
    sync_script = SERVICE_DIR / "tools" / "sync_kinopoisk_film.py"
    if not sync_script.exists():
        raise RuntimeError("Не найден синхронизатор фильмов CineVault: {}".format(sync_script))
    command = [
        sys.executable,
        str(sync_script),
        str(json_path),
        "--kinopoisk-id",
        str(kinopoisk_id),
        "--card-id",
        str(card_id),
    ]
    if video_json:
        command.extend(["--video-json", str(video_json)])
    print("\n6. Обновляю карточку фильма CineVault:")
    print(" ".join(command))
    result = subprocess.call(command, cwd=str(SERVICE_DIR))
    if result != 0:
        raise RuntimeError("sync_kinopoisk_film.py завершился с кодом {}".format(result))


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

# Эти карточки уже используют постоянные открытые файлы Archive.org из
# openMediaCatalog. Kinopoisk helper не возвращает для них метаданные/плеер,
# поэтому обновлять их временными provider-ссылками не нужно.
STATIC_FILM_IDS = {
    566766,
    420145,
    313444,
}


def process_target(source_value, kp_id, is_film, no_import=False):
    """Обновить одну уже выбранную карточку."""
    if is_film:
        if kp_id in STATIC_FILM_IDS:
            print(
                "Пропущен Kinopoisk {}: используется постоянный открытый источник".format(
                    kp_id
                )
            )
            return

        result = fetch_film_metadata(source_value)
        card_id = FILM_CARD_IDS.get(
            kp_id,
            "kinopoisk-{}".format(kp_id),
        )

        if not no_import:
            sync_cinevault_film(
                result["output_path"],
                kp_id,
                card_id,
                result.get("video_output_path"),
            )
        return

    result = fetch_series_by_kinopoisk(source_value)
    root_episode_links = PROJECT_DIR / "episode_links.json"
    shutil.copy2(str(result["output_path"]), str(root_episode_links))
    print("✓ Также обновлён: {}".format(root_episode_links))
    if not no_import:
        import_into_service(result["output_path"], result["kinopoisk_id"], result["title"])
    sync_cinevault_catalog(result["output_path"])


def main():
    parser = argparse.ArgumentParser(description="Обновить сериалы и фильмы из media_sources.json")
    parser.add_argument(
        "--only",
        action="append",
        metavar="KINOPOSK_ID",
        help="Обновить только указанный Kinopoisk ID; флаг можно повторять",
    )
    parser.add_argument("--no-import", action="store_true", help="Не импортировать серии/фильмы в сервис")
    parser.add_argument("--films-only", action="store_true", help="Обработать только фильмы")
    parser.add_argument("--series-only", action="store_true", help="Обработать только сериалы")
    parser.add_argument(
        "--delay-seconds",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        help="Пауза между завершением импорта одной карточки и парсингом следующей (по умолчанию 7 сек.)",
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
    if args.films_only and args.series_only:
        parser.error("Нельзя одновременно использовать --films-only и --series-only")
    if args.delay_seconds < 0:
        parser.error("--delay-seconds не может быть отрицательным")
    if args.retry_attempts < 0:
        parser.error("--retry-attempts не может быть отрицательным")

    media = load_config().get("media", [])
    if not media:
        print("В media_sources.json пока нет ссылок.")
        return

    only_ids = {
        extract_kinopoisk_id(value)
        for value in (args.only or [])
    }
    success = 0
    unavailable = 0
    failed = 0
    processed = 0
    retried_success = 0
    retry_queue = []

    for value in media:
        try:
            source_value = value.get("url") if isinstance(value, dict) else value
            kp_id = extract_kinopoisk_id(source_value)
            is_film = "/film/" in str(source_value).lower()
            if args.films_only and not is_film:
                continue
            if args.series_only and is_film:
                continue
            if only_ids and kp_id not in only_ids:
                continue

            if processed and args.delay_seconds:
                print("Пауза {:.1f} сек. перед следующим Kinopoisk ID...".format(args.delay_seconds))
                time.sleep(args.delay_seconds)
            processed += 1

            process_target(source_value, kp_id, is_film, args.no_import)
            success += 1
        except Exception as exc:
            if source_is_unavailable(exc):
                unavailable += 1
                print(
                    "\n⊘ Пропущен {}: источник пока не отдаёт метаданные или видеопоток. "
                    "Существующая карточка не изменена.\n".format(value)
                )
                continue
            if error_is_retryable(exc) and args.retry_attempts:
                retry_queue.append((value, source_value, kp_id, is_film))
                print(
                    "\n↻ Временная ошибка для {}: {}\n"
                    "Карточка будет повторена после основного прохода.\n".format(value, exc)
                )
                continue
            failed += 1
            print("\n✗ Ошибка для {}: {}\n".format(value, exc))

    for attempt in range(1, args.retry_attempts + 1):
        if not retry_queue:
            break

        current_queue = retry_queue
        retry_queue = []
        print("\n========================================")
        print(
            "Повтор временных ошибок: попытка {}/{} (карточек: {})".format(
                attempt,
                args.retry_attempts,
                len(current_queue),
            )
        )
        print("========================================")

        for value, source_value, kp_id, is_film in current_queue:
            if args.delay_seconds:
                print(
                    "Пауза {:.1f} сек. перед повтором Kinopoisk {}...".format(
                        args.delay_seconds,
                        kp_id,
                    )
                )
                time.sleep(args.delay_seconds)
            try:
                process_target(source_value, kp_id, is_film, args.no_import)
                success += 1
                retried_success += 1
                print("✓ Повтор Kinopoisk {} завершён успешно".format(kp_id))
            except Exception as exc:
                if source_is_unavailable(exc):
                    unavailable += 1
                    print(
                        "\n⊘ Пропущен {}: источник пока не отдаёт метаданные или "
                        "видеопоток. Существующая карточка не изменена.\n".format(value)
                    )
                elif error_is_retryable(exc) and attempt < args.retry_attempts:
                    retry_queue.append((value, source_value, kp_id, is_film))
                    print(
                        "\n↻ Временная ошибка сохранилась для {}: {}\n"
                        "Карточка останется в очереди повторов.\n".format(value, exc)
                    )
                else:
                    failed += 1
                    print("\n✗ Ошибка для {} после повторов: {}\n".format(value, exc))

    print("\n========================================")
    print("Готово.")
    print("Успешно: {}".format(success))
    print("Из них успешно после повтора: {}".format(retried_success))
    print("Недоступно у источника: {}".format(unavailable))
    print("Ошибок: {}".format(failed))
    print("========================================")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
