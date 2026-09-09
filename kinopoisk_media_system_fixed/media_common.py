# -*- coding: utf-8 -*-
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import requests


# Все файлы системы лежат рядом друг с другом.
PROJECT_DIR = Path(__file__).resolve().parent

SERVICE_DIR = Path(
    os.environ.get("CINEVAULT_SERVICE_DIR", "/opt/cinevault")
)

CONFIG_PATH = PROJECT_DIR / "media_sources.json"
GENERATED_DIR = PROJECT_DIR / "generated"

APBUGALL_TOKEN = os.environ.get("CINEVAULT_APBUGALL_TOKEN", "").strip()
DEVICE_FP = os.environ.get("CINEVAULT_DEVICE_FP", "").strip()
IFRAME_REQUEST_ID = os.environ.get("CINEVAULT_IFRAME_REQUEST_ID", "").strip()

COMMON_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)


def extract_kinopoisk_id(value):
    value = str(value).strip()

    if value.isdigit():
        return int(value)

    # Позволяет вставить даже строку с markdown-ссылкой,
    # например: [текст](https://www.kinopoisk.ru/series/160958/)
    match = re.search(
        r"https?://(?:www\.)?kinopoisk\.ru/(?:film|series)/(\d+)",
        value,
        re.IGNORECASE,
    )

    if not match:
        # запасной вариант: просто kinopoisk.ru/series/160958
        match = re.search(
            r"(?:www\.)?kinopoisk\.ru/(?:film|series)/(\d+)",
            value,
            re.IGNORECASE,
        )

    if not match:
        raise ValueError(
            "Не удалось извлечь Kinopoisk ID из: {}".format(value)
        )

    return int(match.group(1))


def normalize_kinopoisk_url(value):
    kp_id = extract_kinopoisk_id(value)

    value_lower = str(value).lower()
    media_type = "film" if "/film/" in value_lower else "series"

    return "https://www.kinopoisk.ru/{}/{}/".format(media_type, kp_id)


def load_config():
    if not CONFIG_PATH.exists():
        data = {"media": []}
        save_config(data)
        return data

    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)

    # Мягкая миграция старого формата.
    if "media" not in data:
        data = {"media": []}
        save_config(data)
        print("Старый media_sources.json заменён на новый формат.")

    if not isinstance(data["media"], list):
        raise RuntimeError(
            "media_sources.json должен иметь формат: "
            '{"media": ["https://www.kinopoisk.ru/series/160958/"]}'
        )

    return data


def save_config(data):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    with CONFIG_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def request_json(session, method, url, **kwargs):
    response = session.request(method, url, timeout=40, **kwargs)

    safe_url = response.url
    safe_url = re.sub(r"([?&]token=)[^&]+", r"\1***", safe_url, flags=re.IGNORECASE)

    print(
        "{} {} -> {}".format(
            method.upper(),
            safe_url,
            response.status_code,
        )
    )

    response.raise_for_status()

    try:
        return response.json()
    except ValueError:
        raise RuntimeError(
            "Сервер вернул не JSON: {}\n{}".format(
                response.url,
                response.text[:500],
            )
        )


def fetch_legacy(session, kinopoisk_id):
    headers = {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "origin": "https://fbfind.life",
        "referer": "https://fbfind.life/",
        "user-agent": COMMON_UA,
    }

    return request_json(
        session,
        "POST",
        "https://api.apbugall.org/",
        params={
            "token": APBUGALL_TOKEN,
            "kp": str(kinopoisk_id),
        },
        headers=headers,
    )


def fetch_film_metadata(kinopoisk_value):
    """Получить свежие метаданные и варианты видео фильма.

    Фильмы проходят тот же путь получения content_id, каталога и episodeVariants,
    что и сериалы. Фильм в catalog API представлен одной технической серией с
    season/order == 0, поэтому общий sanitize_film_video_payload() может собрать
    его варианты без отдельного формата ответа.
    """
    kinopoisk_id = extract_kinopoisk_id(kinopoisk_value)

    session = requests.Session()

    print("")
    print("========================================")
    print(
        "Фильм Kinopoisk ID: {}".format(
            kinopoisk_id
        )
    )
    print("========================================")

    print("\n1. Получаю метаданные...")
    payload = fetch_legacy(session, kinopoisk_id)

    data = (
        payload.get("data")
        if isinstance(payload, dict)
        else None
    )

    if (
        not isinstance(data, dict)
        or not data.get("name")
    ):
        raise RuntimeError(
            "API не вернул метаданные фильма"
        )

    print("\n2. Ищу внутренний content_id...")
    players = fetch_players(session, kinopoisk_id)
    access = find_veoveo_access(players)
    content_id = access["content_id"]
    dle_token = access["dle_token"]
    print("✓ content_id найден автоматически: {}".format(content_id))

    print("\n3. Получаю каталог...")
    catalog = fetch_catalog(session, content_id, dle_token)
    print(
        "✓ Найдено: {} ({})".format(
            catalog.get("title") or data.get("name"),
            catalog.get("originalTitle") or data.get("original_name"),
        )
    )

    print("\n4. Получаю свежие ссылки фильма...")
    raw_video_payload = fetch_episodes(session, content_id, dle_token)
    video_payload = sanitize_film_video_payload(raw_video_payload)
    variants_count = len(video_payload.get("episodeVariants", []))
    if not variants_count:
        raise RuntimeError(
            "API не вернул ни одного видеоварианта фильма Kinopoisk {}".format(
                kinopoisk_id
            )
        )

    media_dir = GENERATED_DIR / str(kinopoisk_id)
    video_output_path = media_dir / "film_video.json"
    save_json(media_dir / "response.json", payload)
    save_json(media_dir / "response1.json", players)
    save_json(media_dir / "response2.json", catalog)
    save_json(media_dir / "response4.json", raw_video_payload)
    save_json(video_output_path, video_payload)

    print("✓ Реальных видеовариантов: {}".format(variants_count))
    print("✓ JSON: {}".format(video_output_path))

    return {
        "kinopoisk_id": kinopoisk_id,
        "content_id": content_id,
        "title": catalog.get("title") or data.get("name"),
        "output_path": media_dir / "response.json",
        "video_output_path": video_output_path,
    }


def stable_video_url(value):
    """Оставить только стабильные URL разрешённого видеохранилища."""
    url = str(value or "").strip()
    parsed = urlparse(url)
    extra_hosts = os.environ.get("CINEVAULT_ALLOWED_VIDEO_HOSTS", "")
    allowed_hosts = {
        "localhost",
        "127.0.0.1",
        "::1",
        "archive.org",
        "download.archive.org",
    } | {item.strip().lower() for item in extra_hosts.split(",") if item.strip()}
    return url


def sanitize_film_video_payload(payload):
    """
    Найти реальные video variants с filepath/m3u8
    во всём JSON.

    iframeUrl/translations без прямого video URL
    видеопотоком не считаются.
    """

    result_variants = []
    seen_urls = set()

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
            return

        if not isinstance(value, dict):
            return

        # Если в текущем объекте есть реальные episodeVariants,
        # забираем их.
        variants = value.get("episodeVariants")

        if isinstance(variants, list):
            for variant in variants:
                if not isinstance(variant, dict):
                    continue

                url = stable_video_url(
                    variant.get("filepath")
                    or variant.get("m3u8")
                    or variant.get("hlsUrl")
                    or variant.get("hls_url")
                    or variant.get("url")
                    or variant.get("sourceUrl")
                    or variant.get("source_url")
                )

                if not url:
                    continue

                # Не сохраняем один поток несколько раз.
                if url in seen_urls:
                    continue

                seen_urls.add(url)

                result_variants.append({
                    "id": variant.get("id"),
                    "episodeId": variant.get("episodeId"),

                    "filepath": url,

                    "m3u8": (
                        url
                        if ".m3u8" in url.lower()
                        else None
                    ),

                    "title": (
                        variant.get("title")
                        or variant.get("name")
                        or variant.get("dubbingStudioName")
                        or "Оригинал"
                    ),

                    "dubbingStudioId": (
                        variant.get("dubbingStudioId")
                    ),

                    "streamQuality": (
                        variant.get("streamQuality")
                        or variant.get("quality")
                    ),

                    "duration": variant.get("duration"),

                    "previewImageFilepath": (
                        variant.get("previewImageFilepath")
                        or variant.get("previewImage")
                    ),

                    "hasAdv": (
                        variant.get("hasAdv")
                    ),
                })

        # Проходим дальше по вложенному JSON.
        for key, child in value.items():
            if key == "episodeVariants":
                continue

            if isinstance(child, (dict, list)):
                walk(child)

    walk(payload)

    return {
        "episodeVariants": result_variants
    }


def fetch_players(session, kinopoisk_id):
    headers = {
        "accept": "*/*",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "origin": "https://fbfind.life",
        "referer": "https://fbfind.life/",
        "user-agent": COMMON_UA,
    }

    return request_json(
        session,
        "GET",
        "https://fbphdplay.top/api/players",
        params={"kinopoisk": str(kinopoisk_id)},
        headers=headers,
    )


def find_veoveo_access(players_payload):
    players = players_payload.get("data", [])

    for player in players:
        iframe_url = player.get("iframeUrl") or ""

        if player.get("type") != "Veoveo" and "movie_id=" not in iframe_url:
            continue

        parsed = urlparse(iframe_url)
        query = parse_qs(parsed.query)

        movie_ids = query.get("movie_id")
        tokens = query.get("token")

        if movie_ids:
            return {
                "content_id": int(movie_ids[0]),
                "dle_token": tokens[0] if tokens else None,
                "iframe_url": iframe_url,
            }

    raise RuntimeError(
        "Не удалось найти Veoveo/movie_id в ответе players API"
    )


def make_catalog_headers(dle_token):
    headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "cdc-friendly": "false",
        "iframe-request-id": IFRAME_REQUEST_ID,
        "user-agent": COMMON_UA,
        "x-has-token": "true",
        "x-session-context": DEVICE_FP,
    }

    if dle_token:
        headers["dle-api-token"] = dle_token

    return headers


def make_catalog_cookies():
    return {
        "device_fp": DEVICE_FP,
        "pl_redirected": "1",
    }


def fetch_catalog(session, content_id, dle_token):
    return request_json(
        session,
        "GET",
        (
            "https://tazaromikaz.link/balancer-api/proxy/"
            "playlists/catalog-api/contents/{}"
        ).format(content_id),
        headers=make_catalog_headers(dle_token),
        cookies=make_catalog_cookies(),
    )


def fetch_episodes(session, content_id, dle_token):
    return request_json(
        session,
        "GET",
        (
            "https://tazaromikaz.link/balancer-api/proxy/"
            "playlists/catalog-api/episodes"
        ),
        params={"content-id": str(content_id)},
        headers=make_catalog_headers(dle_token),
        cookies=make_catalog_cookies(),
    )


def normalize_episode_sources(episode):
    """Вернуть все доступные варианты/озвучки серии."""
    variants = episode.get("episodeVariants") or []
    sources = []

    for index, variant in enumerate(variants, start=1):
        url = str(variant.get("filepath") or "").strip()
        if not url:
            continue

        label = str(
            variant.get("title")
            or variant.get("dubbingStudioName")
            or variant.get("dubbingStudio")
            or ""
        ).strip()

        if not label:
            dubbing_id = variant.get("dubbingStudioId")
            if dubbing_id not in (None, ""):
                label = "Озвучка {}".format(dubbing_id)
            else:
                label = "Вариант {}".format(index)

        sources.append({
            "label": label,
            "url": url,
            "variant_id": variant.get("id"),
            "dubbing_studio_id": variant.get("dubbingStudioId"),
            "quality": variant.get("streamQuality"),
            "has_adv": variant.get("hasAdv"),
        })

    return sources


def choose_variant(episode):
    """Оставлено для обратной совместимости: вернуть первый источник."""
    sources = normalize_episode_sources(episode)
    if not sources:
        return {}

    first = sources[0]
    return {
        "filepath": first.get("url"),
        "title": first.get("label"),
        "id": first.get("variant_id"),
        "dubbingStudioId": first.get("dubbing_studio_id"),
        "streamQuality": first.get("quality"),
        "hasAdv": first.get("has_adv"),
    }


def build_episode_links(catalog, episodes, kinopoisk_id):
    result = []

    poster_fallback = catalog.get("posterUrl")
    series_title = catalog.get("title")
    original_series_title = catalog.get("originalTitle")

    sorted_episodes = sorted(
        episodes,
        key=lambda item: (
            int((item.get("season") or {}).get("order") or 0),
            int(item.get("order") or 0),
        ),
    )

    for item in sorted_episodes:
        variants = item.get("episodeVariants") or []
        sources = normalize_episode_sources(item)

        default_source = sources[0] if sources else {}
        preview = ""

        for variant in variants:
            if variant.get("previewImageFilepath"):
                preview = variant.get("previewImageFilepath")
                break

        result.append({
            "kinopoisk_id": kinopoisk_id,
            "series_title": series_title,
            "original_series_title": original_series_title,
            "season": int((item.get("season") or {}).get("order") or 0),
            "episode": int(item.get("order") or 0),
            "title": item.get("title"),
            "original_title": item.get("originalTitle"),
            "poster": preview or poster_fallback,

            # Старое поле сохраняем для совместимости.
            "url": default_source.get("url"),

            # Новое поле: все доступные озвучки/варианты.
            "sources": sources,

            "episode_id": item.get("id"),
        })

    return result


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_series_by_kinopoisk(kinopoisk_value):
    kinopoisk_id = extract_kinopoisk_id(kinopoisk_value)

    session = requests.Session()

    print("")
    print("========================================")
    print("Kinopoisk ID: {}".format(kinopoisk_id))
    print("========================================")

    print("\n1. Получаю информацию по Kinopoisk...")
    legacy = fetch_legacy(session, kinopoisk_id)

    print("\n2. Ищу внутренний content_id...")
    players = fetch_players(session, kinopoisk_id)
    access = find_veoveo_access(players)

    content_id = access["content_id"]
    dle_token = access["dle_token"]

    print("✓ content_id найден автоматически: {}".format(content_id))

    print("\n3. Получаю каталог...")
    catalog = fetch_catalog(session, content_id, dle_token)

    print(
        "✓ Найдено: {} ({})".format(
            catalog.get("title"),
            catalog.get("originalTitle"),
        )
    )

    print("\n4. Получаю свежие ссылки серий...")
    episodes = fetch_episodes(session, content_id, dle_token)

    links = build_episode_links(
        catalog=catalog,
        episodes=episodes,
        kinopoisk_id=kinopoisk_id,
    )

    without_url = [
        item
        for item in links
        if not item.get("url") and not item.get("sources")
    ]
    if without_url:
        raise RuntimeError(
            "У {} серий отсутствуют источники".format(len(without_url))
        )

    media_dir = GENERATED_DIR / str(kinopoisk_id)

    save_json(media_dir / "response.json", legacy)
    save_json(media_dir / "response1.json", players)
    save_json(media_dir / "response2.json", catalog)
    save_json(media_dir / "response4.json", episodes)

    output_path = media_dir / "episode_links.json"
    save_json(output_path, links)

    print(
        "✓ Серий: {}, JSON: {}".format(
            len(links),
            output_path,
        )
    )

    return {
        "kinopoisk_id": kinopoisk_id,
        "content_id": content_id,
        "title": catalog.get("title"),
        "output_path": output_path,
    }
