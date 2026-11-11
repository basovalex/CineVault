import gzip
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

from tools import episode_ratings


def gz(text):
    data = io.BytesIO()
    with gzip.GzipFile(fileobj=data, mode="wb") as handle:
        handle.write(text.encode("utf-8"))
    return data.getvalue()


class EpisodeRatingsTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.datasets = self.root / "datasets"
        self.datasets.mkdir()
        (self.datasets / "title.episode.tsv.gz").write_bytes(gz(
            "tconst\tparentTconst\tseasonNumber\tepisodeNumber\n"
            "tt101\ttt1\t1\t1\n" "tt102\ttt1\t1\t2\n" "tt103\ttt1\t2\t1\n"
            "tt104\ttt1\t0\t1\n"            # a special: left out
            "tt105\ttt1\t\\N\t\\N\n"        # no numbers: left out
            "tt201\ttt2\t1\t1\n"            # a series the catalogue does not show
            "tt301\ttt3\t1\t1\n"            # a popular series without ratings
        ))
        (self.datasets / "title.ratings.tsv.gz").write_bytes(gz(
            "tconst\taverageRating\tnumVotes\n"
            "tt101\t8.0\t5000\n" "tt102\t8.4\t4800\n" "tt103\t9.0\t9000\n"
            "tt104\t7.0\t100\n" "tt201\t6.0\t50\n" "tt1\t8.6\t900000\n"
        ))
        index = sqlite3.connect(str(self.root / episode_ratings.INDEX_NAME))
        index.executescript("CREATE TABLE cards (id TEXT, kind TEXT, votes INTEGER, summary_json TEXT); CREATE TABLE card_payloads (id TEXT, payload_json TEXT);")
        for card_id, kind, votes, imdb in (("kinopoisk-1", "series", 900000, "tt1"), ("kinopoisk-2", "series", 100, "tt2"), ("kinopoisk-3", "series", 80000, "tt3"), ("kinopoisk-4", "movie", 900000, "tt4")):
            index.execute("INSERT INTO cards VALUES (?, ?, ?, '{}')", (card_id, kind, votes))
            index.execute("INSERT INTO card_payloads VALUES (?, ?)", (card_id, json.dumps({"imdbId": imdb})))
        index.commit()
        index.close()

    def test_only_popular_series_and_numbered_episodes_are_kept(self):
        self.assertEqual(episode_ratings.popular_series(self.root / episode_ratings.INDEX_NAME), {"tt1", "tt3"})
        self.assertEqual(episode_ratings.sync(self.root, self.datasets), 3)
        ratings = episode_ratings.series_ratings(self.root, "tt1")
        self.assertEqual([season["season"] for season in ratings["seasons"]], [1, 2])
        self.assertEqual(ratings["seasons"][0]["episodes"], [{"episode": 1, "rating": 8.0, "votes": 5000}, {"episode": 2, "rating": 8.4, "votes": 4800}])
        self.assertEqual(episode_ratings.series_ratings(self.root, "tt3"), {"seasons": [], "updatedAt": ratings["updatedAt"]})
        self.assertFalse((self.root / "episode_ratings.building").exists())

    def test_http_route_finds_the_series_by_catalogue_id(self):
        episode_ratings.sync(self.root, self.datasets)
        sent = {}

        def handler():
            body = io.BytesIO()
            return body, SimpleNamespace(
                server=SimpleNamespace(library=SimpleNamespace(root=str(self.root))), wfile=body,
                send_response=lambda code: sent.setdefault("code", code), send_header=lambda *_: None, end_headers=lambda: None,
            )

        body, request = handler()
        self.assertFalse(episode_ratings.handle(request, urlparse("/api/other")))
        self.assertTrue(episode_ratings.handle(request, urlparse("/api/episode-ratings?title=kinopoisk-1")))
        self.assertEqual(sent["code"], 200)
        self.assertEqual(len(json.loads(body.getvalue())["seasons"]), 2)
        body, request = handler()
        episode_ratings.handle(request, urlparse("/api/episode-ratings?title=unknown"))
        self.assertEqual(json.loads(body.getvalue())["seasons"], [])


if __name__ == "__main__":
    unittest.main()
