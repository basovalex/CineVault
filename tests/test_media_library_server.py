import io
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.media_library_server import MediaLibrary


class MediaLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.library = MediaLibrary(Path(self.temp_dir.name), transcode=False)

    def tearDown(self):
        self.library.close()
        self.temp_dir.cleanup()

    def test_upload_is_stored_and_listed_without_network(self):
        result = self.library.create_upload(
            "Наш сериал",
            1,
            2,
            "Вторая серия",
            "episode.mp4",
            io.BytesIO(b"synthetic media"),
        )
        items = self.library.list_library()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Наш сериал")
        self.assertEqual(items[0]["season"], 1)
        self.assertEqual(items[0]["episode"], 2)
        self.assertEqual(items[0]["status"], "stored")
        self.assertEqual(result["bytes"], len(b"synthetic media"))
        self.assertTrue((self.library.root / "uploads" / result["episode_id"]).is_dir())

    def test_upload_rejects_unsafe_extension(self):
        with self.assertRaises(ValueError):
            self.library.create_upload("Test", 0, 0, "", "secret.exe", io.BytesIO(b"x"))

    def test_progress_is_persisted(self):
        result = self.library.create_upload("Test", 0, 0, "", "movie.mp4", io.BytesIO(b"x"))
        progress = self.library.update_progress(result["episode_id"], {"position": 42.5, "duration": 600, "completed": False})
        self.assertEqual(progress["position"], 42.5)
        self.assertFalse(progress["completed"])
        self.assertEqual(self.library.list_library()[0]["progress"]["duration"], 600)

    def test_history_is_shared_and_sorted_by_latest_progress(self):
        first = self.library.create_upload("Test", 1, 1, "Первая", "first.mp4", io.BytesIO(b"x"))
        second = self.library.create_upload("Test", 1, 2, "Вторая", "second.mp4", io.BytesIO(b"y"))
        self.library.update_progress(first["episode_id"], {"position": 10, "duration": 100, "completed": False})
        self.library.update_progress(second["episode_id"], {"position": 20, "duration": 100, "completed": True})
        history = self.library.list_history()
        self.assertEqual([item["episode"] for item in history], [2, 1])
        self.assertEqual(history[0]["progress"]["position"], 20)

    def test_watch_room_state_is_versioned(self):
        result = self.library.create_upload("Test", 0, 0, "", "movie.mp4", io.BytesIO(b"x"))
        room = self.library.create_room(result["episode_id"])
        updated = self.library.update_room(room["room_id"], {"position": 18, "playing": True})
        self.assertEqual(updated["state"]["position"], 18)
        self.assertTrue(updated["state"]["playing"])
        self.assertEqual(updated["state"]["seq"], 1)

    def test_offline_manifest_contains_only_selected_quality_resources(self):
        result = self.library.create_upload("Test", 1, 1, "Start", "episode.mp4", io.BytesIO(b"x"))
        quality_dir = self.library.hls_dir / result["episode_id"] / "360p"
        quality_dir.mkdir(parents=True)
        (quality_dir / "index.m3u8").write_text("#EXTM3U\n#EXTINF:2,\nsegment-00001.ts\n", encoding="utf-8")
        (quality_dir / "segment-00001.ts").write_bytes(b"segment")
        manifest = self.library.offline_manifest(result["episode_id"], "360p")
        self.assertEqual(manifest["quality"], "360p")
        self.assertTrue(manifest["quality_playlist"].endswith("/360p/index.m3u8"))
        self.assertTrue(manifest["resources"][-1].endswith("segment-00001.ts"))

    def test_offline_manifest_defaults_to_highest_available_quality(self):
        result = self.library.create_upload("Test", 1, 1, "Start", "episode.mp4", io.BytesIO(b"x"))
        for quality in ("360p", "720p"):
            quality_dir = self.library.hls_dir / result["episode_id"] / quality
            quality_dir.mkdir(parents=True)
            (quality_dir / "index.m3u8").write_text("#EXTM3U\n#EXTINF:2,\nsegment-00001.ts\n", encoding="utf-8")
            (quality_dir / "segment-00001.ts").write_bytes(b"segment")
        manifest = self.library.offline_manifest(result["episode_id"])
        self.assertEqual(manifest["quality"], "720p")

    def test_episode_payload_lists_only_existing_quality_variants(self):
        result = self.library.create_upload("Test", 1, 1, "Start", "episode.mp4", io.BytesIO(b"x"))
        for quality in ("360p", "720p"):
            quality_dir = self.library.hls_dir / result["episode_id"] / quality
            quality_dir.mkdir(parents=True)
            (quality_dir / "index.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
        (self.library.hls_dir / result["episode_id"] / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")

        item = self.library.list_library()[0]
        self.assertEqual(item["available_qualities"], ["360p", "720p"])

    def test_import_keeps_selected_catalog_metadata(self):
        metadata = {
            "provider": "tmdb",
            "external_id": "693",
            "kind": "series",
            "title": "Отчаянные домохозяйки",
            "original_title": "Desperate Housewives",
            "year": 2004,
            "overview": "Описание",
            "poster_url": "https://image.tmdb.org/t/p/w780/poster.jpg",
            "seasons": [{"number": 1, "episode_count": 23}],
        }
        result = self.library.create_upload("ignored", 1, 1, "Пилот", "episode.mp4", io.BytesIO(b"x"), metadata=metadata)
        item = self.library.list_library()[0]
        self.assertEqual(item["title"], "Отчаянные домохозяйки")
        self.assertEqual(item["metadata_external_id"], "693")
        self.assertEqual(item["metadata"]["seasons"][0]["episode_count"], 23)

    def test_catalog_request_is_deduplicated(self):
        payload = {
            "catalog_id": "the-holiday",
            "kind": "movie",
            "title": "Отпуск по обмену",
            "original_title": "The Holiday",
            "year": 2006,
        }
        first = self.library.create_catalog_request(payload)
        second = self.library.create_catalog_request(payload)
        self.assertEqual(first["status"], "pending")
        self.assertFalse(first["already_exists"])
        self.assertTrue(second["already_exists"])
        self.assertEqual(first["request_id"], second["request_id"])

    def test_skip_segments_are_cached_for_exact_episode(self):
        metadata = {
            "provider": "tmdb",
            "external_id": "693",
            "kind": "series",
            "title": "Отчаянные домохозяйки",
            "imdb_id": "tt0410975",
        }
        result = self.library.create_upload(
            "Отчаянные домохозяйки",
            1,
            2,
            "Вторая серия",
            "episode.mp4",
            io.BytesIO(b"synthetic media"),
            metadata=metadata,
        )
        calls = []

        def fake_introdb(imdb_id, season, episode):
            calls.append((imdb_id, season, episode))
            return {
                "intro": {"start_sec": 202, "end_sec": 240, "confidence": 1},
                "recap": {"start_sec": 12, "end_sec": 53},
                "outro": None,
            }

        self.library._introdb_request = fake_introdb
        first = self.library.get_skip_segments(result["episode_id"])
        second = self.library.get_skip_segments(result["episode_id"])
        self.assertTrue(first["available"])
        self.assertEqual([segment["type"] for segment in first["segments"]], ["recap", "intro"])
        self.assertEqual(first["segments"], second["segments"])
        self.assertEqual(calls, [("tt0410975", 1, 2)])
        self.assertEqual(self.library.list_library()[0]["skip_segments"], first["segments"])

    def test_skip_segments_are_not_guessed_for_movie(self):
        result = self.library.create_upload(
            "Фильм",
            0,
            0,
            "",
            "movie.mp4",
            io.BytesIO(b"synthetic media"),
            metadata={"provider": "tmdb", "external_id": "123", "imdb_id": "tt1234567"},
        )
        self.library._introdb_request = lambda *args: self.fail("movie must not call episode segments API")
        response = self.library.get_skip_segments(result["episode_id"])
        self.assertFalse(response["available"])
        self.assertEqual(response["segments"], [])

    def test_empty_skip_segment_cache_is_rechecked(self):
        metadata = {"provider": "tmdb", "external_id": "693", "kind": "series", "imdb_id": "tt0410975"}
        result = self.library.create_upload("Сериал", 1, 2, "", "s01e02.mp4", io.BytesIO(b"x"), metadata=metadata)
        calls = []
        self.library._introdb_request = lambda *args: (calls.append(args) or {})
        self.library.get_skip_segments(result["episode_id"])
        old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        self.library._execute("UPDATE episode_segments SET fetched_at = ?", (old_timestamp,))
        self.library.get_skip_segments(result["episode_id"])
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
