import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import tools.media_library_server as server
from tools.catalog_index import build_index, iter_json_array


class IterJsonArrayTests(unittest.TestCase):
    def write(self, text):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        handle.write(text)
        handle.close()
        self.addCleanup(Path(handle.name).unlink)
        return Path(handle.name)

    def test_reads_every_element_whatever_the_chunk_size(self):
        items = [{"id": f"t{i}", "title": "Лёд " * i, "n": [i, i * 1.5, None, True]} for i in range(60)] + [7, "x", []]
        path = self.write(json.dumps(items, ensure_ascii=False, indent=1))
        for chunk in (1, 3, 17, 1 << 20):
            self.assertEqual(list(iter_json_array(path, chunk_size=chunk)), items)

    def test_numbers_split_across_chunks_stay_whole(self):
        path = self.write("[123456789, 42]")
        self.assertEqual(list(iter_json_array(path, chunk_size=4)), [123456789, 42])

    def test_not_an_array_is_empty(self):
        self.assertEqual(list(iter_json_array(self.write('{"items": [1]}'))), [])
        self.assertEqual(list(iter_json_array(self.write("[]"))), [])

    def test_truncated_file_raises(self):
        path = self.write('[{"id": "a"}, {"id": "b"')
        with self.assertRaises(json.JSONDecodeError):
            list(iter_json_array(path, chunk_size=5))


class StreamedBuildTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.catalog = self.dir / "catalog_imports.json"
        imports = [
            {"id": "a", "kinopoiskId": 1, "title": "Альфа", "description": "коротко", "genres": ["драма"]},
            {"id": "b", "kinopoiskId": 2, "title": "Бета"},
            {"id": "a", "kinopoiskId": 1, "title": "Альфа дубль"},
            {"id": "c", "title": "Без кинопоиска", "year": 2001},
            "not a card",
        ]
        metadata = [
            {"id": "kp-1", "kinopoiskId": 1, "description": "д" * 80, "year": 1999, "posterImage": "https://p/1.jpg"},
            {"id": "b", "kinopoiskId": 99, "genres": ["комедия"], "voteCount": 300},
            {"id": "m1", "kinopoiskId": 10, "title": "Только метаданные", "genres": ["ужасы", "триллер"]},
            {"id": "m1", "kinopoiskId": 11, "title": "Повтор id"},
            {"id": "m2", "kinopoiskId": 10, "title": "Повтор кинопоиска"},
            {"id": "", "kinopoiskId": 12},
            {"id": "m3", "kinopoiskId": 13, "title": "Популярный"},
        ]
        popular = {"items": [{"kinopoiskId": 13, "rank": 1, "list": "world", "backdropImage": "https://b/13.jpg"}, {"kinopoiskId": 2, "rank": 2}]}
        self.catalog.write_text(json.dumps(imports, ensure_ascii=False), encoding="utf-8")
        (self.dir / "catalog_metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        (self.dir / server.CATALOG_POPULAR_FILENAME).write_text(json.dumps(popular), encoding="utf-8")

    def test_cards_match_the_in_memory_merge(self):
        server.CATALOG_STATE_DIR = None
        server._catalog_cache.clear()
        expected, seen = [], set()
        for item in server.imported_catalog_entries(self.catalog):
            if item.get("id") and item["id"] not in seen:
                seen.add(item["id"])
                expected.append(item)
        index = self.dir / "index.sqlite3"
        self.assertEqual(build_index(self.catalog, index), len(expected))
        db = sqlite3.connect(str(index))
        payloads = [json.loads(row[0]) for row in db.execute("SELECT p.payload_json FROM cards c JOIN card_payloads p USING (id) ORDER BY c.rowid")]
        sources = dict(db.execute("SELECT id, source FROM cards"))
        genres = sorted(db.execute("SELECT card_id, genre FROM card_genres"))
        db.close()
        self.assertEqual(payloads, expected)
        self.assertEqual(sources, {"a": "imports", "b": "imports", "c": "imports", "m1": "metadata", "m3": "metadata"})
        self.assertEqual(genres, [("a", "драма"), ("b", "комедия"), ("m1", "триллер"), ("m1", "ужасы")])
        self.assertFalse(any(path.suffix in {".staging", ".building"} for path in self.dir.iterdir()))

    def test_found_frames_fill_only_cards_without_one(self):
        from tools.catalog_index import BACKDROPS_FILENAME
        (self.dir / BACKDROPS_FILENAME).write_text(json.dumps({"m1": "https://image.tmdb.org/t/p/w1280/m1.jpg", "a": "https://image.tmdb.org/t/p/w1280/a.jpg", "b": "not-a-url"}), encoding="utf-8")
        catalog = json.loads(self.catalog.read_text(encoding="utf-8"))
        catalog[0]["backdropImage"] = "https://own/a.jpg"
        self.catalog.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
        index = self.dir / "index.sqlite3"
        build_index(self.catalog, index)
        db = sqlite3.connect(str(index))
        frames = {row[0]: json.loads(row[1]).get("backdropImage") for row in db.execute("SELECT id, payload_json FROM card_payloads")}
        db.close()
        self.assertEqual(frames["m1"], "https://image.tmdb.org/t/p/w1280/m1.jpg")
        self.assertEqual(frames["a"], "https://own/a.jpg")
        self.assertIsNone(frames["b"])


if __name__ == "__main__":
    unittest.main()
