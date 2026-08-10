#!/usr/bin/env python3
"""Local-only CineVault demo server backed by synthetic fixtures."""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

try:
    from .legal_demo_provider import FixtureError, LegalDemoProvider
except ImportError:  # Running this file directly.
    from legal_demo_provider import FixtureError, LegalDemoProvider


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "app"
FIXTURES_DIR = ROOT / "fixtures" / "legal_demo"
MAX_QUERY_LENGTH = 120


def get_provider() -> LegalDemoProvider:
    return LegalDemoProvider(FIXTURES_DIR)


def search_payload(query: str) -> dict:
    provider = get_provider()
    items = []
    for result in provider.search(query)[:20]:
        title = provider.get_title(result.title_id)
        items.append(
            {
                "id": result.title_id,
                "title": title.title,
                "entity": "LegalDemo",
                "year": "fixture",
                "genre": "offline synthetic data",
            }
        )
    return {"query": query, "provider": provider.provider_id, "items": items}


def probe_payload(query: str, index: int, season: int, episode: int) -> dict:
    provider = get_provider()
    items = list(provider.search(query))
    if index < 0 or index >= len(items):
        raise FixtureError("Результат локального поиска с таким номером не найден")

    result = items[index]
    title = provider.get_title(result.title_id)
    episodes = provider.get_episodes(result.title_id, season)
    selected = next((item for item in episodes if item.number == episode), None)
    if selected is None:
        raise FixtureError(f"Серия {episode} в сезоне {season} не найдена")

    stream = provider.get_stream(
        result.title_id,
        season,
        episode,
        selected.translations[0],
    )
    return {
        "title": title.title,
        "description": title.description,
        "kind": "series",
        "season": season,
        "episode": episode,
        "has_player": True,
        "qualities": ["local-hls"],
        "translators": list(selected.translations),
        "media_type": stream.media_type,
        "source": "local-fixture",
    }


class CineVaultHandler(SimpleHTTPRequestHandler):
    server_version = "CineVaultLegalDemo/1.0"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/hdrezka/"):
            self.handle_hdrezka_api(parsed)
            return
        super().do_GET()

    def handle_hdrezka_api(self, parsed) -> None:
        params = parse_qs(parsed.query)
        query = unquote(params.get("q", [""])[0]).strip()
        if not query or len(query) > MAX_QUERY_LENGTH:
            self.send_json(400, {"error": "Укажи название длиной от 1 до 120 символов"})
            return
        try:
            if parsed.path == "/api/hdrezka/search":
                self.send_json(200, search_payload(query))
                return
            if parsed.path == "/api/hdrezka/probe":
                season = max(1, int(params.get("season", ["1"])[0]))
                episode = max(1, int(params.get("episode", ["1"])[0]))
                index = int(params.get("index", ["0"])[0])
                self.send_json(200, probe_payload(query, index, season, episode))
                return
            self.send_json(404, {"error": "Неизвестный локальный endpoint"})
        except (ValueError, FixtureError) as exc:
            self.send_json(400, {"error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser(description="CineVault offline LegalDemo server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()
    handler = lambda *a, **kw: CineVaultHandler(*a, directory=str(APP_DIR), **kw)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"CineVault demo server: http://{args.host}:{args.port}", flush=True)
    print("LegalDemoProvider uses only local fixtures; network clients are disabled.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
