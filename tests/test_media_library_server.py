import io
import http.client
import json
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error
import unittest
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

from tools.media_library_server import (
    KinopoiskCatalogImporter,
    KinopoiskOnDemandUpdater,
    MediaLibrary,
    MediaLibraryHandler,
    build_sitemap_xml,
    catalog_page,
    kinopoisk_import_command,
    kinopoisk_update_command,
    normalize_catalog_source_json,
    parse_external_embed_input,
    parse_kinopoisk_import_input,
    sitemap_title_ids,
    update_catalog_from_source_json,
)
from tools.sync_tmdb_catalog import catalog_entry as tmdb_catalog_entry, merge_catalog as merge_tmdb_catalog


class MediaLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.library = MediaLibrary(Path(self.temp_dir.name), transcode=False)

    def tearDown(self):
        self.library.close()
        self.temp_dir.cleanup()

    def test_catalog_page_filters_explicit_card_ids(self):
        cards = [
            {"id": "first", "title": "Первый", "kind": "movie", "rating": 8},
            {"id": "second", "title": "Второй", "kind": "series", "rating": 7},
        ]
        with patch("tools.media_library_server.imported_catalog_entries", return_value=cards):
            payload = catalog_page({"ids": ["second"]})
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"], [{"id": "second", "title": "Второй", "kind": "series", "rating": 7}])

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

    def test_tmdb_catalog_entry_has_no_video_source(self):
        entry = tmdb_catalog_entry({
            "id": 42,
            "title": "Тестовый фильм",
            "original_title": "Test Film",
            "release_date": "2026-01-02",
            "overview": "Описание",
            "genre_ids": [1],
            "vote_average": 7.4,
            "poster_path": "/poster.jpg",
        }, "movie", {1: "драма"})
        self.assertEqual(entry["id"], "tmdb-movie-42")
        self.assertEqual(entry["year"], 2026)
        self.assertEqual(entry["videoSources"], [])
        self.assertEqual(entry["genres"], ["драма"])

    def test_tmdb_merge_preserves_existing_playback_fields(self):
        existing = [{"id": "tmdb-movie-42", "title": "Старое", "kinopoiskId": 123, "videoSources": [{"url": "https://allowed.example/master.m3u8"}]}]
        fresh = [{"id": "tmdb-movie-42", "title": "Новое", "videoSources": []}]
        merged, created, updated = merge_tmdb_catalog(existing, fresh)
        self.assertEqual((created, updated), (0, 1))
        self.assertEqual(merged[0]["title"], "Новое")
        self.assertEqual(merged[0]["kinopoiskId"], 123)
        self.assertEqual(len(merged[0]["videoSources"]), 1)

    def test_local_mp4_download_is_ready_without_transcoding(self):
        result = self.library.create_upload(
            "Наш фильм",
            0,
            0,
            "",
            "film.mp4",
            io.BytesIO(b"local mp4 bytes"),
        )
        episode_id = result["episode_id"]
        status = self.library.start_mp4_download(episode_id)
        self.assertEqual(status["status"], "ready")
        self.assertTrue(status["download_url"].endswith("/download/file"))
        source, filename = self.library.mp4_download_file(episode_id)
        self.assertEqual(source.read_bytes(), b"local mp4 bytes")
        self.assertEqual(filename, "наш-фильм.mp4")

    def test_mp4_download_endpoint_does_not_start_browser_export(self):
        result = self.library.create_upload("Наш фильм", 0, 0, "", "film.mp4", io.BytesIO(b"download bytes"))
        episode_id = result["episode_id"]
        handler = lambda *args, **kwargs: MediaLibraryHandler(*args, directory=self.temp_dir.name, **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.library = self.library  # type: ignore[attr-defined]
        server.viewer_token = ""  # type: ignore[attr-defined]
        server.admin_token = ""  # type: ignore[attr-defined]
        server.local_open_admin = True  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                opener.open(
                    urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/library/episodes/{episode_id}/download", method="POST"),
                    timeout=3,
                )
            self.assertEqual(rejected.exception.code, 410)
            self.assertEqual(list(self.library.downloads_dir.glob("*.mp4")), [])
            # Existing local uploads can still be served without creating a copy.
            response = opener.open(f"http://127.0.0.1:{server.server_port}/api/library/episodes/{episode_id}/download/file", timeout=3)
            self.assertEqual(response.read(), b"download bytes")
            self.assertEqual(response.headers["Content-Type"], "video/mp4")
            self.assertIn("attachment", response.headers["Content-Disposition"])
            self.assertIn("filename*=UTF-8''", response.headers["Content-Disposition"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_download_ticket_allows_only_its_file_with_viewer_auth(self):
        first = self.library.create_upload("Первый фильм", 0, 0, "", "first.mp4", io.BytesIO(b"first"))
        second = self.library.create_upload("Второй фильм", 0, 0, "", "second.mp4", io.BytesIO(b"second"))
        handler = lambda *args, **kwargs: MediaLibraryHandler(*args, directory=self.temp_dir.name, **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.library = self.library  # type: ignore[attr-defined]
        server.viewer_token = "viewer-test"  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base = f"http://127.0.0.1:{server.server_port}"
            candidate, filename = self.library.mp4_download_file(first["episode_id"])
            ticket = self.library.issue_download_ticket(candidate, filename)
            self.assertEqual(opener.open(f"{base}/api/library/episodes/{first['episode_id']}/download/file?ticket={ticket}", timeout=3).read(), b"first")
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                opener.open(f"{base}/api/library/episodes/{second['episode_id']}/download/file?ticket={ticket}", timeout=3)
            self.assertEqual(rejected.exception.code, 401)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_hls_export_resolves_video_and_audio_after_master_redirect(self):
        source = "https://example.org/original/master.m3u8"
        redirect = MagicMock()
        redirect.__enter__.return_value = redirect
        redirect.status_code = 302
        redirect.headers = {"Location": "https://cdn.example.org/media/master.m3u8"}
        master = MagicMock()
        master.__enter__.return_value = master
        master.status_code = 200
        master.iter_content.return_value = [(
            '#EXTM3U\n'
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Русский",DEFAULT=YES,URI="audio/index.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nvideo/low.m3u8\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=2000,AUDIO="audio"\nvideo/high.m3u8\n'
        ).encode()]
        with patch("tools.media_library_server.requests.Session") as session_factory:
            get = session_factory.return_value.__enter__.return_value.get
            get.side_effect = [redirect, master]
            inputs, maps = self.library._stream_export_inputs(source)
        self.assertEqual(inputs, [
            "https://cdn.example.org/media/video/high.m3u8",
            "https://cdn.example.org/media/audio/index.m3u8",
        ])
        self.assertEqual(maps, ["-map", "0:v:0", "-map", "1:a:0"])
        self.assertEqual(get.call_count, 2)

    def test_hls_export_rejects_redirect_to_private_address(self):
        redirect = MagicMock()
        redirect.__enter__.return_value = redirect
        redirect.status_code = 302
        redirect.headers = {"Location": "https://127.0.0.1/internal.m3u8"}
        with patch("tools.media_library_server.requests.Session") as session_factory:
            get = session_factory.return_value.__enter__.return_value.get
            get.return_value = redirect
            with self.assertRaises(ValueError):
                self.library._stream_export_inputs("https://example.org/master.m3u8")
        self.assertEqual(get.call_count, 1)

    def test_stream_download_status_reports_progress_and_estimate(self):
        payload = self.library._stream_download_payload("job", {
            "status": "processing", "phase": "assembling", "percent": 35,
            "processed_seconds": 35, "duration_seconds": 100,
            "elapsed_seconds": 7, "eta_seconds": 13,
        })
        self.assertEqual(payload["percent"], 35)
        self.assertEqual(payload["phase"], "assembling")
        self.assertEqual(payload["eta_seconds"], 13)
        self.assertIsNone(payload["download_url"])

    def test_stream_download_can_be_cancelled_and_orphaned_job_expires(self):
        job_id = "a" * 32
        cancellation = threading.Event()
        self.library._stream_download_jobs[job_id] = {
            "status": "processing", "phase": "assembling", "cancel_event": cancellation,
            "last_seen_at": time.monotonic(),
        }
        handler = lambda *args, **kwargs: MediaLibraryHandler(*args, directory=self.temp_dir.name, **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.library = self.library  # type: ignore[attr-defined]
        server.viewer_token = ""  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/catalog/downloads/{job_id}/cancel",
                data=b"", method="POST",
            )
            response = json.loads(opener.open(request, timeout=3).read())
            self.assertEqual(response["phase"], "cancelling")
            self.assertTrue(cancellation.is_set())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        cancellation.clear()
        self.library._stream_download_jobs[job_id]["last_seen_at"] = time.monotonic() - 120
        self.assertTrue(self.library._stream_download_cancelled(job_id))
        self.assertTrue(cancellation.is_set())

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required")
    def test_catalog_hls_stream_is_exported_to_mp4(self):
        fixture_dir = Path(self.temp_dir.name) / "stream-fixture"
        fixture_dir.mkdir()
        subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "1",
            "-c:v", "libx264", "-f", "hls", "-hls_time", "0.5", "-hls_list_size", "0",
            str(fixture_dir / "index.m3u8"),
        ], check=True, timeout=20)
        handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(*args, directory=str(fixture_dir), **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        api_handler = lambda *args, **kwargs: MediaLibraryHandler(*args, directory=self.temp_dir.name, **kwargs)
        api_server = ThreadingHTTPServer(("127.0.0.1", 0), api_handler)
        api_server.library = self.library  # type: ignore[attr-defined]
        api_server.viewer_token = ""  # type: ignore[attr-defined]
        api_thread = threading.Thread(target=api_server.serve_forever, daemon=True)
        api_thread.start()
        try:
            item = {"id": "test-film", "kind": "movie", "title": "Тестовый фильм", "videoSources": [
                {"id": "test-source", "url": f"http://127.0.0.1:{server.server_port}/index.m3u8"},
            ]}
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base = f"http://127.0.0.1:{api_server.server_port}"
            with patch("tools.media_library_server.imported_catalog_item", return_value=item), patch.object(self.library, "_validate_stream_url"):
                request = urllib.request.Request(
                    base + "/api/catalog/downloads",
                    data=json.dumps({"title_id": "test-film", "source_key": "test-source"}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as rejected:
                    opener.open(request, timeout=3)
                self.assertEqual(rejected.exception.code, 410)
                self.assertEqual(self.library._stream_download_jobs, {})
                result = self.library.start_stream_download("test-film", source_key="test-source")
                for _ in range(100):
                    result = json.loads(opener.open(f"{base}/api/catalog/downloads/{result['id']}", timeout=3).read())
                    if result["status"] != "processing":
                        break
                    time.sleep(0.05)
            self.assertEqual(result["status"], "ready", result.get("error"))
            self.assertEqual(result["percent"], 100)
            candidate, filename = self.library.stream_download_file(result["id"])
            self.assertEqual(filename, "тестовый-фильм.mp4")
            self.assertIn(b"ftyp", candidate.read_bytes()[:32])
            response = opener.open(base + result["download_url"], timeout=3)
            self.assertIn("attachment", response.headers["Content-Disposition"])
            self.assertEqual(response.read(), candidate.read_bytes())
        finally:
            api_server.shutdown()
            api_server.server_close()
            api_thread.join(timeout=3)
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_watch_room_sse_broadcasts_seek_to_second_client(self):
        room = self.library.create_room(payload={
            "title_id": "test-title",
            "target_key": "test-title-s1e1",
            "season": 1,
            "episode": 1,
            "position": 12.5,
            "playing": False,
        })
        subscribers = set()
        lock = threading.Lock()
        handler = lambda *args, **kwargs: MediaLibraryHandler(*args, directory=self.temp_dir.name, **kwargs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.library = self.library  # type: ignore[attr-defined]
        server.viewer_token = ""  # type: ignore[attr-defined]
        server.admin_token = ""  # type: ignore[attr-defined]
        server.local_open_admin = True  # type: ignore[attr-defined]

        def subscribe(_room_id):
            subscriber = queue.Queue(maxsize=8)
            with lock:
                subscribers.add(subscriber)
            return subscriber

        def unsubscribe(_room_id, subscriber):
            with lock:
                subscribers.discard(subscriber)

        def publish(_room_id, event):
            with lock:
                recipients = list(subscribers)
            for subscriber in recipients:
                subscriber.put_nowait(event)

        server.watch_room_subscribe = subscribe  # type: ignore[attr-defined]
        server.watch_room_unsubscribe = unsubscribe  # type: ignore[attr-defined]
        server.watch_room_publish = publish  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            connection.request("GET", f"/api/watch/rooms/{room['room_id']}/events")
            events = connection.getresponse()
            self.assertEqual(events.status, 200)
            initial = events.readline().decode("utf-8")
            self.assertIn('"position": 12.5', initial)
            self.assertEqual(events.readline(), b"\n")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            payload = json.dumps({"position": 321.25, "playing": True}).encode("utf-8")
            response = opener.open(
                urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/api/watch/rooms/{room['room_id']}",
                    data=payload,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                ),
                timeout=3,
            )
            self.assertEqual(json.loads(response.read())["state"]["seq"], 1)
            broadcast = events.readline().decode("utf-8")
            self.assertIn('"position": 321.25', broadcast)
            self.assertIn('"playing": true', broadcast)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_external_embed_cannot_be_exported_as_mp4(self):
        result = self.library.create_external_embed({
            "title": "Внешняя серия",
            "season": 1,
            "episode": 1,
            "embed_url": "https://rutube.ru/play/embed/abc123",
        })
        with self.assertRaises(ValueError):
            self.library.start_mp4_download(result["episode_id"])

    def test_external_embed_accepts_url_and_curl_referer_without_network(self):
        embed_url = "https://cinemar.cc/embed/117515/demo-token"
        curl = "curl --url 'https://cinemar.cc/api/playlist/load' -H 'referer: " + embed_url + "' --data-raw 'opaque-payload'"
        self.assertEqual(parse_external_embed_input(curl), embed_url)
        result = self.library.create_external_embed({
            "title": "Наш сериал",
            "season": 1,
            "episode": 1,
            "episode_title": "Пилотная серия",
            "embed_url": embed_url,
        })
        item = self.library.list_library()[0]
        self.assertEqual(result["source_type"], "external_embed")
        self.assertEqual(item["source_type"], "external_embed")
        self.assertEqual(item["embed_url"], embed_url)
        self.assertIsNone(item["hls_url"])
        with self.assertRaises(ValueError):
            self.library.offline_manifest(result["episode_id"])

    def test_external_embed_rejects_non_embed_or_unknown_host(self):
        with self.assertRaises(ValueError):
            parse_external_embed_input("https://example.com/embed/video")
        with self.assertRaises(ValueError):
            parse_external_embed_input("https://cinemar.cc/api/playlist/load")

    def test_rutube_video_url_is_normalised_to_official_embed(self):
        self.assertEqual(
            parse_external_embed_input("https://rutube.ru/video/abc123/"),
            "https://rutube.ru/play/embed/abc123",
        )

    def test_kinopoisk_updater_refreshes_only_requested_catalog_id(self):
        updater_dir = Path(self.temp_dir.name) / "kinopoisk_media_system_fixed"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("# test updater\n", encoding="utf-8")
        (updater_dir / ".env").write_text(
            'CINEVAULT_APBUGALL_TOKEN="fixture-token"\n'
            'CINEVAULT_DEVICE_FP="fixture-fingerprint"\n'
            'CINEVAULT_IFRAME_REQUEST_ID="fixture-request"\n', encoding="utf-8",
        )
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(json.dumps([{"id": "film", "kinopoiskId": 689, "videoSources": []}]), encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, delay_seconds=7, catalog_path=catalog_path)
        expected_command = kinopoisk_update_command(updater_dir.resolve(), 689, delay_seconds=7)
        self.assertEqual(expected_command[1], str(updater_dir.resolve() / "update_media.py"))
        self.assertEqual(expected_command[-2:], ["--only", "689"])
        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "Успешно: 1\nОшибок: 0"
            run.return_value.stderr = ""
            result = updater.refresh(689)
        self.assertTrue(result["refreshed"])
        self.assertEqual(result["entry"]["kinopoiskId"], 689)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args[0][0], expected_command)
        self.assertEqual(run.call_args[1]["cwd"], str(updater_dir.resolve()))
        self.assertEqual(run.call_args[1]["env"]["CINEVAULT_SERVICE_DIR"], str(Path(__file__).resolve().parents[1]))
        self.assertEqual(run.call_args[1]["env"]["CINEVAULT_APBUGALL_TOKEN"], "fixture-token")

    def test_kinopoisk_updater_rejects_unknown_catalog_id_without_process(self):
        updater_dir = Path(self.temp_dir.name) / "kinopoisk_media_system_fixed"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("# test updater\n", encoding="utf-8")
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text("[]", encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, catalog_path=catalog_path)
        with patch("tools.media_library_server.subprocess.run") as run, self.assertRaises(KeyError):
            updater.refresh(999999)
        run.assert_not_called()

    def test_kinopoisk_updater_force_bypasses_recent_refresh_cache(self):
        updater_dir = Path(self.temp_dir.name) / "kinopoisk_media_system_fixed"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("# test updater\n", encoding="utf-8")
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(json.dumps([{"id": "series", "kinopoiskId": 160958}]), encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, catalog_path=catalog_path)
        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "Успешно: 1\nОшибок: 0"
            run.return_value.stderr = ""
            updater.refresh(160958)
            refreshed = updater.refresh(160958, force=True)
        self.assertTrue(refreshed["refreshed"])
        self.assertEqual(run.call_count, 2)

    def test_kinopoisk_updater_deletes_streamless_card_after_three_failures(self):
        updater_dir = Path(self.temp_dir.name) / "kinopoisk_media_system_fixed"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("# test updater\n", encoding="utf-8")
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(
            json.dumps([{"id": "missing-film", "kinopoiskId": 4889667, "videoSources": []}]),
            encoding="utf-8",
        )
        metadata_path = catalog_path.with_name("catalog_metadata.json")
        metadata_path.write_text("[]", encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, catalog_path=catalog_path)
        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "Успешно: 0\nНедоступно у источника: 1\nОшибок: 0"
            run.return_value.stderr = ""
            first = updater.refresh(4889667, force=True)
            second = updater.refresh(4889667, force=True)
            third = updater.refresh(4889667, force=True)
        self.assertEqual(first["failures"], 1)
        self.assertEqual(second["failures"], 2)
        self.assertTrue(third["deleted"])
        self.assertEqual(third["failures"], 3)
        self.assertEqual(json.loads(catalog_path.read_text(encoding="utf-8")), [])

    def test_kinopoisk_updater_keeps_card_with_previous_stream_on_refresh_failure(self):
        updater_dir = Path(self.temp_dir.name) / "kinopoisk_media_system_fixed"
        updater_dir.mkdir()
        (updater_dir / "update_media.py").write_text("# test updater\n", encoding="utf-8")
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(json.dumps([{
            "id": "available-film", "kinopoiskId": 689,
            "videoSources": [{"url": "https://video.example/master.m3u8"}],
        }]), encoding="utf-8")
        updater = KinopoiskOnDemandUpdater(updater_dir, catalog_path=catalog_path)
        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "Успешно: 0\nНедоступно у источника: 1\nОшибок: 0"
            run.return_value.stderr = ""
            for _ in range(3):
                result = updater.refresh(689, force=True)
        self.assertNotIn("failures", result)
        self.assertFalse(result.get("deleted", False))
        self.assertEqual(len(json.loads(catalog_path.read_text(encoding="utf-8"))), 1)

    def test_kinopoisk_catalog_import_accepts_id_or_canonical_url(self):
        self.assertEqual(parse_kinopoisk_import_input("689"), 689)
        self.assertEqual(parse_kinopoisk_import_input("https://www.kinopoisk.ru/series/412344/"), 412344)
        with self.assertRaises(ValueError):
            parse_kinopoisk_import_input("https://example.com/film/689/")

    def test_kinopoisk_catalog_import_runs_wrapper_in_background(self):
        script_path = Path(self.temp_dir.name) / "add_kinopoisk_title.py"
        script_path.write_text("# test wrapper\n", encoding="utf-8")
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(json.dumps([{"id": "harry-potter-1", "kinopoiskId": 689}]), encoding="utf-8")
        importer = KinopoiskCatalogImporter(script_path=script_path, catalog_path=catalog_path)
        expected_command = kinopoisk_import_command(script_path.resolve(), 689)

        with patch("tools.media_library_server.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "✓ Kinopoisk 689: фильм"
            run.return_value.stderr = ""
            job = importer.start("https://www.kinopoisk.ru/film/689/")
            deadline = time.monotonic() + 1
            status = importer.status(job["id"])
            while status["status"] in {"queued", "running"} and time.monotonic() < deadline:
                time.sleep(0.01)
                status = importer.status(job["id"])

        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["entry"]["id"], "harry-potter-1")
        run.assert_called_once_with(
            expected_command,
            cwd=str(Path(__file__).resolve().parents[1]),
            check=False,
            capture_output=True,
            text=True,
            timeout=1800,
        )

    def test_sitemap_uses_catalog_ids_and_seed_card_aliases(self):
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        catalog_path.write_text(json.dumps([
            {"id": "kinopoisk-689", "kinopoiskId": 689},
            {"id": "kinopoisk-160958", "kinopoiskId": 160958},
        ]), encoding="utf-8")

        title_ids = sitemap_title_ids(catalog_path)

        self.assertIn("kinopoisk-689", title_ids)
        self.assertIn("desperate-housewives", title_ids)
        self.assertIn("sintel-open", title_ids)

    def test_sitemap_has_absolute_catalog_and_title_routes(self):
        sitemap = build_sitemap_xml("https://cinevault.example/", ["kinopoisk-689", "название с пробелом"])

        self.assertIn("<loc>https://cinevault.example/catalog/</loc>", sitemap)
        self.assertIn("<loc>https://cinevault.example/title/kinopoisk-689/</loc>", sitemap)
        self.assertIn("<loc>https://cinevault.example/title/%D0%BD%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC/</loc>", sitemap)

    def test_source_json_extracts_translation_variants_without_network(self):
        payload = {
            "data": [{
                "iframeUrl": "https://cinemar.cc/embed/movie-main",
                "translations": [
                    {"id": 1, "name": "Русский · дубляж", "quality": "WEB", "iframeUrl": "https://cinemar.cc/embed/movie-dub"},
                    {"id": 2, "name": "English · original", "quality": "WEB", "iframeUrl": "https://cinemar.cc/embed/movie-original"},
                ],
            }],
        }
        result = normalize_catalog_source_json(payload)
        self.assertEqual([item["voice"] for item in result["variants"]], ["Русский · дубляж", "English · original"])
        self.assertEqual(result["variants"][0]["type"], "embed")
        self.assertEqual(result["skipped"], [])

    def test_source_json_rejects_signed_url_and_does_not_write_it(self):
        payload = {"data": [{"translations": [{"name": "Дубляж", "iframeUrl": "https://cinemar.cc/embed/movie?token=temporary"}]}]}
        result = normalize_catalog_source_json(payload)
        self.assertEqual(result["variants"], [])
        self.assertEqual(result["skipped"][0]["reason"], "временный токен")

    def test_source_json_creates_or_updates_catalog_entry(self):
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        payload = {"data": [{"translations": [{"id": 7, "name": "Оригинал", "iframeUrl": "https://cinemar.cc/embed/movie-original"}]}]}
        result = update_catalog_from_source_json(payload, 258687, "Интерстеллар", catalog_path=catalog_path)
        self.assertTrue(result["created"])
        self.assertEqual(result["accepted"], 1)
        saved = json.loads(catalog_path.read_text(encoding="utf-8"))
        self.assertEqual(saved[0]["kinopoiskId"], 258687)
        self.assertEqual(saved[0]["videoSources"][0]["voice"], "Оригинал")

    def test_source_json_accepts_serial_style_m3u8_translation(self):
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        payload = {
            "data": [
                {
                    "translations": [
                        {
                            "id": 17,
                            "name": "Оригинал",
                            "streamQuality": "1080p",
                            "m3u8": "https://localhost/media/interstellar/master.m3u8",
                        }
                    ]
                }
            ]
        }
        result = update_catalog_from_source_json(payload, 258687, "Интерстеллар", catalog_path=catalog_path)
        self.assertEqual(result["accepted"], 1)
        saved = json.loads(catalog_path.read_text(encoding="utf-8"))
        source = saved[0]["videoSources"][0]
        self.assertEqual(source["type"], "application/vnd.apple.mpegurl")
        self.assertEqual(source["quality"], "1080p")
        self.assertTrue(source["url"].endswith("master.m3u8"))

    def test_source_json_keeps_one_video_source_for_repeated_master_hls(self):
        master = "https://localhost/media/interstellar/master.m3u8"
        payload = {"data": [{"translations": [
            {"name": "Дубляж", "quality": "1080p", "m3u8": master},
            {"name": "Original", "quality": "720p", "m3u8": master},
        ]}]}
        result = normalize_catalog_source_json(payload)
        self.assertEqual(len(result["variants"]), 1)
        self.assertEqual(result["variants"][0]["url"], master)

    def test_source_json_accepts_root_video_sources_format(self):
        catalog_path = Path(self.temp_dir.name) / "catalog_imports.json"
        payload = {
            "kinopoiskId": 258687,
            "contentId": 21797,
            "videoSources": [
                {
                    "id": "63620",
                    "url": "https://localhost/media/interstellar/master.m3u8",
                    "quality": "Авто",
                    "voice": "Оригинал",
                    "duration": 10144,
                    "type": "application/vnd.apple.mpegurl",
                }
            ],
        }
        result = update_catalog_from_source_json(payload, 258687, "Интерстеллар", catalog_path=catalog_path)
        self.assertEqual(result["accepted"], 1)
        saved = json.loads(catalog_path.read_text(encoding="utf-8"))
        source = saved[0]["videoSources"][0]
        self.assertEqual(source["id"], "63620")
        self.assertEqual(source["voice"], "Оригинал")
        self.assertEqual(source["type"], "application/vnd.apple.mpegurl")

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

    def test_watch_room_can_sync_external_title_target(self):
        room = self.library.create_room(payload={
            "title_id": "desperate-housewives",
            "target_key": "desperate-housewives-s2e15",
            "season": 2,
            "episode": 15,
            "position": 347.25,
            "playing": True,
        })
        self.assertEqual(room["state"]["target_key"], "desperate-housewives-s2e15")
        self.assertEqual(room["state"]["position"], 347.25)
        self.assertTrue(room["state"]["playing"])
        updated = self.library.update_room(room["room_id"], {
            "position": 31.5,
            "playing": False,
            "season": 3,
            "episode": 6,
            "target_key": "desperate-housewives-s3e6",
        })
        self.assertEqual(updated["state"]["position"], 31.5)
        self.assertFalse(updated["state"]["playing"])
        self.assertEqual(updated["state"]["season"], 3)
        self.assertEqual(updated["state"]["episode"], 6)
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
