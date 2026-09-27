#!/usr/bin/env python3
"""Backfill CineVault cards from open Wikidata records containing P2603.

Wikidata supplies Kinopoisk IDs and basic metadata. Playback is deliberately
not discovered here; the existing on-demand updater handles one opened title.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.import_kinopoisk_metadata import DEFAULT_CATALOG, DEFAULT_METADATA, read_json  # noqa: E402


DEFAULT_STATE = ROOT / "data" / "media-library" / "wikidata_kinopoisk_catalog_sync.json"
SPARQL_URL = "https://query.wikidata.org/sparql"
ENTITY_API_URL = "https://www.wikidata.org/w/api.php"
USER_AGENT = "CineVault/1.0 (personal media catalog; github.com/basovalex/CineVault)"
SERIES_INSTANCE_IDS = {
    "Q5398426",   # television series
    "Q1259759",   # miniseries
    "Q581714",    # animated series
    "Q3464665",   # television anime
    "Q21664088",  # two-part television series
}


def positive_int(value: Any) -> int:
    try:
        result = int(str(value).strip())
    except (TypeError, ValueError):
        return 0
    return result if result > 0 else 0


def save_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def request_json(session: requests.Session, url: str, *, params: Any, timeout: int = 60) -> Dict[str, Any]:
    last_status = 0
    for attempt in range(4):
        try:
            response = session.get(
                url,
                params=params,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=timeout,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("Wikidata вернула неожиданный JSON")
            return payload
        except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
            response = getattr(exc, "response", None)
            last_status = int(getattr(response, "status_code", 0) or 0)
            if attempt >= 3:
                if last_status:
                    raise RuntimeError("Wikidata HTTP {}".format(last_status)) from exc
                raise
            retry_after = 0
            if response is not None:
                retry_after = positive_int(response.headers.get("Retry-After"))
            time.sleep(max(retry_after, 2 ** attempt))
    raise RuntimeError("Wikidata не ответила{}".format(" (HTTP {})".format(last_status) if last_status else ""))


def fetch_id_batch(session: requests.Session, after_kinopoisk_id: int, limit: int) -> List[Dict[str, Any]]:
    query = """
SELECT ?item ?kpId WHERE {
  ?item wdt:P2603 ?kpId.
  FILTER(REGEX(STR(?kpId), "^[0-9]+$"))
  FILTER(xsd:integer(?kpId) > %d)
}
ORDER BY xsd:integer(?kpId)
LIMIT %d
""" % (after_kinopoisk_id, limit)
    payload = request_json(
        session,
        SPARQL_URL,
        params={"query": query, "format": "json"},
        timeout=90,
    )
    bindings = payload.get("results", {}).get("bindings", [])
    rows: List[Dict[str, Any]] = []
    for binding in bindings if isinstance(bindings, list) else []:
        item_url = str(binding.get("item", {}).get("value") or "")
        kp_id = positive_int(binding.get("kpId", {}).get("value"))
        qid = item_url.rsplit("/", 1)[-1]
        if kp_id and qid.startswith("Q"):
            rows.append({"qid": qid, "kinopoiskId": kp_id})
    return rows


def fetch_entities(session: requests.Session, qids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    identifiers = list(dict.fromkeys(qids))
    result: Dict[str, Dict[str, Any]] = {}
    chunk_size = 50
    for offset in range(0, len(identifiers), chunk_size):
        payload = request_json(
            session,
            ENTITY_API_URL,
            params={
                "action": "wbgetentities",
                "ids": "|".join(identifiers[offset:offset + chunk_size]),
                "props": "labels|descriptions|claims",
                "languages": "ru|en",
                "languagefallback": "1",
                "format": "json",
                "formatversion": "2",
            },
            timeout=45,
        )
        entities = payload.get("entities", {})
        if isinstance(entities, dict):
            result.update({qid: entity for qid, entity in entities.items() if isinstance(entity, dict)})
        time.sleep(0.1)
    return result


def claim_values(entity: Dict[str, Any], property_id: str) -> List[Any]:
    claims = entity.get("claims", {}).get(property_id, []) if isinstance(entity.get("claims"), dict) else []
    values: List[Any] = []
    for claim in claims if isinstance(claims, list) else []:
        snak = claim.get("mainsnak", {}) if isinstance(claim, dict) else {}
        datavalue = snak.get("datavalue", {}) if isinstance(snak, dict) else {}
        if isinstance(datavalue, dict) and "value" in datavalue:
            values.append(datavalue["value"])
    return values


def localized(entity: Dict[str, Any], field: str) -> str:
    values = entity.get(field, {}) if isinstance(entity.get(field), dict) else {}
    for language in ("ru", "en"):
        value = values.get(language, {}) if isinstance(values.get(language), dict) else {}
        text = str(value.get("value") or "").strip()
        if text:
            return text
    return ""


def first_string_claim(entity: Dict[str, Any], property_id: str) -> str:
    for value in claim_values(entity, property_id):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def first_time_claim(entity: Dict[str, Any], property_id: str) -> str:
    for value in claim_values(entity, property_id):
        if isinstance(value, dict):
            timestamp = str(value.get("time") or "").strip()
            if timestamp:
                return timestamp
    return ""


def catalog_entry(entity: Dict[str, Any], kinopoisk_id: int) -> Dict[str, Any]:
    title = localized(entity, "labels")
    if not title:
        raise ValueError("У Wikidata отсутствует название")
    instance_ids = {
        str(value.get("id") or "")
        for value in claim_values(entity, "P31")
        if isinstance(value, dict)
    }
    kind = "series" if instance_ids & SERIES_INSTANCE_IDS or claim_values(entity, "P4983") else "movie"
    date_value = first_time_claim(entity, "P577")
    year = positive_int(date_value.lstrip("+")[:4]) if date_value else 0
    image_name = first_string_claim(entity, "P18")
    url_kind = "series" if kind == "series" else "film"
    entry: Dict[str, Any] = {
        "id": "kinopoisk-{}".format(kinopoisk_id),
        "kinopoiskId": kinopoisk_id,
        "kind": kind,
        "title": title,
        "originalTitle": str(entity.get("labels", {}).get("en", {}).get("value") or title).strip(),
        "year": year or None,
        "description": localized(entity, "descriptions"),
        "genres": [],
        "tags": [],
        "posterImage": "https://commons.wikimedia.org/wiki/Special:Redirect/file/{}".format(quote(image_name)) if image_name else "",
        "providerUrl": "https://www.kinopoisk.ru/{}/{}/".format(url_kind, kinopoisk_id),
        "providerName": "Wikidata · метаданные",
        "providerNote": "Открытые метаданные Wikidata. Видеопоток запрашивается только для открытой карточки.",
        "videoSources": [],
        "wikidataId": str(entity.get("id") or ""),
    }
    if kind == "series":
        entry["seasons"] = []
    imdb_id = first_string_claim(entity, "P345")
    if imdb_id:
        entry["imdbId"] = imdb_id
    tmdb_property = "P4983" if kind == "series" else "P4947"
    tmdb_id = positive_int(first_string_claim(entity, tmdb_property))
    if tmdb_id:
        entry["tmdbId"] = tmdb_id
    return entry


def sync(catalog_path: Path, metadata_path: Path, state_path: Path, batches: int,
         limit: int, delay_seconds: float, dry_run: bool = False) -> Dict[str, int]:
    legacy = read_json(catalog_path, [])
    existing = read_json(metadata_path, [])
    state = read_json(state_path, {})
    if not isinstance(legacy, list) or not isinstance(existing, list) or not isinstance(state, dict):
        raise ValueError("Каталог или контрольная точка имеют неверный формат")
    legacy_ids = {positive_int(item.get("kinopoiskId")) for item in legacy if isinstance(item, dict)}
    cards = {
        positive_int(item.get("kinopoiskId")): item
        for item in existing
        if isinstance(item, dict) and positive_int(item.get("kinopoiskId"))
    }
    cursor = positive_int(state.get("last_kinopoisk_id"))
    totals = {"batches": 0, "seen": 0, "created": 0, "skipped": 0, "last_kinopoisk_id": cursor}
    with requests.Session() as session:
        # Wikimedia is directly reachable from the host. Ignoring ambient
        # HTTP(S)_PROXY variables avoids TLS resets during long entity batches.
        session.trust_env = False
        for _ in range(batches):
            rows = fetch_id_batch(session, cursor, limit)
            if not rows:
                if not dry_run:
                    save_json_atomic(state_path, {**state, "provider": "wikidata-p2603", "last_kinopoisk_id": cursor, "complete": True})
                break
            candidates = [
                row for row in rows
                if row["kinopoiskId"] not in legacy_ids and row["kinopoiskId"] not in cards
            ]
            # Do not request full Wikidata entities for cards already present
            # in either catalog. This makes resumed backfills much faster.
            entities = fetch_entities(session, [row["qid"] for row in candidates])
            for row in rows:
                totals["seen"] += 1
                kp_id = row["kinopoiskId"]
                cursor = max(cursor, kp_id)
                if kp_id in legacy_ids or kp_id in cards:
                    totals["skipped"] += 1
                    continue
                entity = entities.get(row["qid"])
                if not entity:
                    totals["skipped"] += 1
                    continue
                try:
                    cards[kp_id] = catalog_entry(entity, kp_id)
                except ValueError:
                    totals["skipped"] += 1
                    continue
                totals["created"] += 1
            totals["batches"] += 1
            totals["last_kinopoisk_id"] = cursor
            if not dry_run:
                save_json_atomic(metadata_path, list(cards.values()))
                state = {**state, "provider": "wikidata-p2603", "last_kinopoisk_id": cursor, "complete": False}
                save_json_atomic(state_path, state)
            if delay_seconds:
                time.sleep(delay_seconds)
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Добавить карточки с Kinopoisk ID из открытых данных Wikidata")
    parser.add_argument("--catalog-path", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--metadata-path", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--batches", type=int, default=1, help="Число пакетов за запуск (1–100)")
    parser.add_argument("--limit", type=int, default=500, help="Kinopoisk ID в одном пакете (1–1000)")
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.batches <= 100 or not 1 <= args.limit <= 1000 or args.delay_seconds < 0:
        parser.error("Проверь диапазоны batches, limit и delay-seconds")
    try:
        result = sync(args.catalog_path, args.metadata_path, args.state_path,
                      args.batches, args.limit, args.delay_seconds, args.dry_run)
    except (OSError, ValueError, RuntimeError, requests.RequestException, json.JSONDecodeError) as exc:
        parser.exit(1, "Синхронизация Wikidata остановлена: {}\n".format(str(exc) or type(exc).__name__))
    print("{}: пакетов {batches}, просмотрено {seen}, добавлено {created}, пропущено {skipped}, последний Kinopoisk ID {last_kinopoisk_id}".format(
        "Проверено" if args.dry_run else "Сохранено", **result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
