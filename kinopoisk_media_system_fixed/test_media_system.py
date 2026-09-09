import json
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

import add_media
import media_common
import update_media


class FilmMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.generated_dir = Path(self.temp_dir.name) / "generated"

    def tearDown(self):
        self.temp_dir.cleanup()

    def film_responses(self, variants=None):
        return {
            "legacy": {
                "data": {
                    "name": "Тестовый фильм",
                    "original_name": "Test Film",
                    "category": 1,
                }
            },
            "players": {"data": [{"type": "Veoveo"}]},
            "access": {"content_id": 1234, "dle_token": "test-token"},
            "catalog": {"title": "Тестовый фильм", "originalTitle": "Test Film"},
            "episodes": [
                {
                    "season": {"order": 0},
                    "order": 0,
                    "episodeVariants": variants if variants is not None else [
                        {
                            "id": 7,
                            "filepath": "https://video.example/movie/master.m3u8?fresh=1",
                            "title": "Дубляж",
                        }
                    ],
                }
            ],
        }

    def test_film_fetch_uses_live_pipeline_and_writes_all_generated_files(self):
        responses = self.film_responses()
        with patch.object(media_common, "GENERATED_DIR", self.generated_dir), patch.multiple(
            media_common,
            fetch_legacy=Mock(return_value=responses["legacy"]),
            fetch_players=Mock(return_value=responses["players"]),
            find_veoveo_access=Mock(return_value=responses["access"]),
            fetch_catalog=Mock(return_value=responses["catalog"]),
            fetch_episodes=Mock(return_value=responses["episodes"]),
        ):
            result = media_common.fetch_film_metadata(
                "https://www.kinopoisk.ru/film/999/"
            )

        media_dir = self.generated_dir / "999"
        self.assertEqual(result["content_id"], 1234)
        self.assertEqual(result["video_output_path"], media_dir / "film_video.json")
        for filename in (
            "response.json",
            "response1.json",
            "response2.json",
            "response4.json",
            "film_video.json",
        ):
            self.assertTrue((media_dir / filename).is_file(), filename)

        video = json.loads((media_dir / "film_video.json").read_text(encoding="utf-8"))
        self.assertEqual(len(video["episodeVariants"]), 1)
        self.assertEqual(video["episodeVariants"][0]["title"], "Дубляж")
        self.assertIn("master.m3u8", video["episodeVariants"][0]["filepath"])

    def test_empty_live_film_response_does_not_write_or_replace_generated_data(self):
        responses = self.film_responses(variants=[])
        with patch.object(media_common, "GENERATED_DIR", self.generated_dir), patch.multiple(
            media_common,
            fetch_legacy=Mock(return_value=responses["legacy"]),
            fetch_players=Mock(return_value=responses["players"]),
            find_veoveo_access=Mock(return_value=responses["access"]),
            fetch_catalog=Mock(return_value=responses["catalog"]),
            fetch_episodes=Mock(return_value=responses["episodes"]),
        ):
            with self.assertRaisesRegex(RuntimeError, "ни одного видеоварианта"):
                media_common.fetch_film_metadata(999)

        self.assertFalse((self.generated_dir / "999").exists())

    def test_numeric_media_kind_uses_fetched_metadata(self):
        self.assertEqual(
            add_media.detect_kind("258687", {"data": {"category": 1}}),
            "film",
        )
        self.assertEqual(
            add_media.detect_kind("160958", {"data": {"category": 2}}),
            "series",
        )

    def test_add_media_accepts_batch_and_updates_only_passed_ids(self):
        config = {"media": []}
        argv = [
            "add_media.py",
            "https://www.kinopoisk.ru/film/258687/",
            "https://www.kinopoisk.ru/series/160958/",
            "https://www.kinopoisk.ru/film/258687/",
        ]
        with patch.object(sys, "argv", argv), patch.object(
            add_media, "load_config", return_value=config
        ), patch.object(add_media, "save_config") as save_config, patch.object(
            add_media.subprocess, "call", return_value=0
        ) as subprocess_call:
            add_media.main()

        self.assertEqual(config["media"], [
            "https://www.kinopoisk.ru/film/258687/",
            "https://www.kinopoisk.ru/series/160958/",
        ])
        save_config.assert_called_once_with(config)
        command = subprocess_call.call_args.args[0]
        self.assertEqual(command.count("--only"), 2)
        self.assertIn("258687", command)
        self.assertIn("160958", command)
        self.assertEqual(command[command.index("--delay-seconds") + 1], "7")
        self.assertEqual(command[command.index("--retry-attempts") + 1], "1")

    def test_update_media_waits_between_cards_by_default(self):
        config = {
            "media": [
                "https://www.kinopoisk.ru/film/258687/",
                "https://www.kinopoisk.ru/film/807339/",
            ]
        }
        result = {"output_path": Path("response.json"), "video_output_path": Path("film_video.json")}
        with patch.object(sys, "argv", ["update_media.py", "--films-only"]), patch.object(
            update_media, "load_config", return_value=config
        ), patch.object(
            update_media, "fetch_film_metadata", return_value=result
        ), patch.object(
            update_media, "sync_cinevault_film"
        ), patch.object(update_media.time, "sleep") as sleep:
            update_media.main()

        sleep.assert_called_once_with(update_media.DEFAULT_DELAY_SECONDS)

    def test_update_media_skips_unavailable_source_without_overwriting_card(self):
        config = {"media": ["https://www.kinopoisk.ru/film/5230825/"]}
        output = io.StringIO()
        with patch.object(sys, "argv", ["update_media.py", "--films-only"]), patch.object(
            update_media, "load_config", return_value=config
        ), patch.object(
            update_media, "fetch_film_metadata", side_effect=RuntimeError("API не вернул метаданные фильма")
        ), patch.object(update_media, "sync_cinevault_film") as sync, patch("sys.stdout", output):
            update_media.main()

        self.assertIn("Недоступно у источника: 1", output.getvalue())
        self.assertIn("Ошибок: 0", output.getvalue())
        sync.assert_not_called()

    def test_update_media_retries_temporary_ssl_error_after_main_pass(self):
        first_id = 258687
        second_id = 807339
        config = {
            "media": [
                "https://www.kinopoisk.ru/film/{}/".format(first_id),
                "https://www.kinopoisk.ru/film/{}/".format(second_id),
            ]
        }
        result = {
            "output_path": Path("response.json"),
            "video_output_path": Path("film_video.json"),
        }
        calls = []

        def fetch(value):
            kp_id = media_common.extract_kinopoisk_id(value)
            calls.append(kp_id)
            if kp_id == first_id and calls.count(first_id) == 1:
                raise requests.exceptions.SSLError(
                    "Max retries exceeded: SSLEOFError"
                )
            return result

        output = io.StringIO()
        argv = ["update_media.py", "--films-only", "--delay-seconds", "0"]
        with patch.object(sys, "argv", argv), patch.object(
            update_media, "load_config", return_value=config
        ), patch.object(
            update_media, "fetch_film_metadata", side_effect=fetch
        ), patch.object(
            update_media, "sync_cinevault_film"
        ), patch("sys.stdout", output):
            update_media.main()

        self.assertEqual(calls, [first_id, second_id, first_id])
        self.assertIn("Из них успешно после повтора: 1", output.getvalue())
        self.assertIn("Ошибок: 0", output.getvalue())

    def test_update_media_does_not_retry_unavailable_source(self):
        config = {"media": ["https://www.kinopoisk.ru/film/5230825/"]}
        argv = ["update_media.py", "--films-only", "--delay-seconds", "0"]
        with patch.object(sys, "argv", argv), patch.object(
            update_media, "load_config", return_value=config
        ), patch.object(
            update_media,
            "fetch_film_metadata",
            side_effect=RuntimeError("Не удалось найти Veoveo/movie_id в ответе players API"),
        ) as fetch, patch.object(update_media, "sync_cinevault_film"), patch(
            "sys.stdout", io.StringIO()
        ):
            update_media.main()

        self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
