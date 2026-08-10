"""Offline-only provider backed by local CineVault fixtures."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence, Union


class FixtureError(ValueError):
    """Raised when a local demo fixture is missing or malformed."""


@dataclass(frozen=True)
class SearchResult:
    title_id: str
    title: str


@dataclass(frozen=True)
class Episode:
    number: int
    title: str
    translations: tuple[str, ...]
    playlist_path: Path


@dataclass(frozen=True)
class Season:
    number: int
    title: str
    episodes: tuple[Episode, ...]


@dataclass(frozen=True)
class MediaTitle:
    title_id: str
    title: str
    description: str
    poster_path: Path
    seasons: tuple[Season, ...]


@dataclass(frozen=True)
class LocalStream:
    title_id: str
    season: int
    episode: int
    translation: str
    playlist_path: Path
    media_type: str = "application/vnd.apple.mpegurl"


class LegalDemoProvider:
    """A provider that never imports or calls a network client."""

    provider_id = "legal-demo"
    display_name = "Legal Demo Provider"

    def __init__(self, fixtures_dir: Union[str, Path]):
        self.root = Path(fixtures_dir).resolve()
        if not self.root.is_dir():
            raise FixtureError(f"Fixture directory not found: {self.root}")

    def _catalog(self) -> dict:
        try:
            return json.loads(
                (self.root / "catalog.json").read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as exc:
            raise FixtureError("Invalid local catalog.json") from exc

    def _entry(self, title_id: str) -> dict:
        for item in self._catalog().get("titles", []):
            if item.get("id") == title_id:
                return item
        raise FixtureError(f"Unknown title: {title_id}")

    def _safe_file(self, relative_path: str, suffixes: set[str]) -> Path:
        candidate = (self.root / relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise FixtureError("Fixture path escapes fixture directory") from exc

        if not candidate.is_file():
            raise FixtureError(f"Fixture file not found: {candidate}")
        if candidate.suffix.lower() not in suffixes:
            raise FixtureError(f"Unsupported fixture type: {candidate.suffix}")
        return candidate

    def search(self, query: str) -> Sequence[SearchResult]:
        normalized = query.strip().casefold()
        if not normalized:
            return []
        return [
            SearchResult(item["id"], item["title"])
            for item in self._catalog().get("titles", [])
            if normalized in item.get("title", "").casefold()
        ]

    def get_title(self, title_id: str) -> MediaTitle:
        item = self._entry(title_id)
        seasons = []
        for raw_season in item.get("seasons", []):
            episodes = []
            for raw_episode in raw_season.get("episodes", []):
                episodes.append(
                    Episode(
                        number=int(raw_episode["number"]),
                        title=str(raw_episode["title"]),
                        translations=tuple(raw_episode["translations"]),
                        playlist_path=self._safe_file(
                            raw_episode["playlist"], {".m3u8", ".mp4"}
                        ),
                    )
                )
            seasons.append(
                Season(
                    number=int(raw_season["number"]),
                    title=str(raw_season["title"]),
                    episodes=tuple(episodes),
                )
            )

        return MediaTitle(
            title_id=item["id"],
            title=item["title"],
            description=item["description"],
            poster_path=self._safe_file(
                item["poster"], {".svg", ".png", ".jpg", ".jpeg"}
            ),
            seasons=tuple(seasons),
        )

    def get_seasons(self, title_id: str) -> Sequence[Season]:
        return self.get_title(title_id).seasons

    def get_episodes(self, title_id: str, season: int) -> Sequence[Episode]:
        for item in self.get_seasons(title_id):
            if item.number == season:
                return item.episodes
        raise FixtureError(f"Unknown season: {season}")

    def get_stream(
        self,
        title_id: str,
        season: int,
        episode: int,
        translation: str,
    ) -> LocalStream:
        selected = next(
            (
                item
                for item in self.get_episodes(title_id, season)
                if item.number == episode
            ),
            None,
        )
        if selected is None:
            raise FixtureError(
                f"Unknown episode: season={season}, episode={episode}"
            )
        if translation not in selected.translations:
            raise FixtureError(f"Unknown translation: {translation}")
        return LocalStream(
            title_id=title_id,
            season=season,
            episode=episode,
            translation=translation,
            playlist_path=selected.playlist_path,
        )
