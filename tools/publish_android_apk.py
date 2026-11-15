#!/usr/bin/env python3
"""Выкладывает собранный Android APK для раздачи и самообновления.

Читает versionCode и versionName из android/app/build.gradle.kts, считает sha256 и
кладёт в <data-dir>/apk/ два файла: CineVault-android.apk и android.json.
Сервер подхватывает их сразу, перезапуск не нужен.

Локально:   python3 tools/publish_android_apk.py --data-dir data/media-library
На сервер:  python3 tools/publish_android_apk.py --data-dir /tmp/cv-apk --notes "Что нового"
            scp /tmp/cv-apk/apk/* <сервер>:/srv/cinevault/data/media-library/apk/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRADLE = ROOT / "android" / "app" / "build.gradle.kts"
DEFAULT_APK = ROOT / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"


def read_version() -> tuple[int, str]:
    text = GRADLE.read_text(encoding="utf-8")
    code = re.search(r"versionCode\s*=\s*(\d+)", text)
    name = re.search(r'versionName\s*=\s*"([^"]+)"', text)
    if not code or not name:
        raise SystemExit("В build.gradle.kts не нашёл versionCode или versionName")
    return int(code.group(1)), name.group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", required=True, help="папка данных сервера (внутри появится apk/)")
    parser.add_argument("--apk", default=str(DEFAULT_APK), help="собранный APK")
    parser.add_argument("--notes", default="", help="что нового, одной строкой")
    args = parser.parse_args()

    apk = Path(args.apk)
    if not apk.is_file():
        raise SystemExit(f"Нет файла {apk}. Сначала ./gradlew assembleRelease")
    code, name = read_version()
    target = Path(args.data_dir) / "apk"
    target.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    shutil.copyfile(apk, target / "CineVault-android.apk")
    (target / "android.json").write_text(
        json.dumps({"versionCode": code, "versionName": name, "sha256": digest, "size": apk.stat().st_size, "notes": args.notes}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Версия {name} (код {code}), {apk.stat().st_size / 1048576:.1f} МБ, sha256 {digest[:12]}…")
    print(f"Положил в {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
