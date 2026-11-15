#!/bin/zsh
# Выпуск новой версии Android TV приложения одной командой.
#
#   tools/release_android.sh "Что нового — одной строкой"
#
# 1. Поднимает версию в android/app/build.gradle.kts (0.4.2 → 0.4.3, versionCode +1).
#    С --no-bump версия остаётся как есть (например, если её уже подняли руками).
# 2. Собирает release APK (JDK 17) и кладёт копию в output/CineVault-android.apk.
# 3. Выкладывает APK и android.json на сервер, в <data-dir>/apk/. Пересобирать сервер не нужно.
# 4. Проверяет, что сервер отдаёт новую версию. Телевизоры предложат «Обновить» при следующем запуске.
#
# Куда выкладывать — из окружения (адрес сервера в репозиторий не кладём):
#   CINEVAULT_DEPLOY_SSH   например root@<сервер>
#   CINEVAULT_DEPLOY_KEY   ключ SSH (по умолчанию ~/.ssh/cinevault_admin)
#   CINEVAULT_DEPLOY_APK_DIR  папка на сервере (по умолчанию /srv/cinevault/data/media-library/apk)

set -euo pipefail
cd "$(dirname "$0")/.."

bump=1
if [[ "${1:-}" == "--no-bump" ]]; then bump=0; shift; fi
notes="${1:-}"
target="${CINEVAULT_DEPLOY_SSH:?Укажите CINEVAULT_DEPLOY_SSH=root@<сервер>}"
key="${CINEVAULT_DEPLOY_KEY:-$HOME/.ssh/cinevault_admin}"
remote_dir="${CINEVAULT_DEPLOY_APK_DIR:-/srv/cinevault/data/media-library/apk}"
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o ConnectTimeout=20)
gradle=android/app/build.gradle.kts

if (( bump )); then
  python3 - "$gradle" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
code = int(re.search(r"versionCode\s*=\s*(\d+)", text).group(1))
name = re.search(r'versionName\s*=\s*"([^"]+)"', text).group(1)
parts = name.split(".")
parts[-1] = str(int(parts[-1]) + 1)
text = re.sub(r"versionCode\s*=\s*\d+", f"versionCode = {code + 1}", text, count=1)
text = re.sub(r'versionName\s*=\s*"[^"]+"', f'versionName = "{".".join(parts)}"', text, count=1)
open(path, "w", encoding="utf-8").write(text)
print(f"Версия {name} → {'.'.join(parts)} (код {code + 1})")
EOF
fi

export JAVA_HOME="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17}"
(cd android && ./gradlew assembleRelease -q)
apk=android/app/build/outputs/apk/release/app-release.apk
mkdir -p output
cp "$apk" output/CineVault-android.apk

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
python3 tools/publish_android_apk.py --data-dir "$staging" --apk "$apk" --notes "$notes"

ssh "${ssh_opts[@]}" "$target" "mkdir -p '$remote_dir'"
# The manifest goes last: a TV never sees a version whose file is not there yet.
scp -q "${ssh_opts[@]}" "$staging/apk/CineVault-android.apk" "$target:$remote_dir/CineVault-android.apk.new"
scp -q "${ssh_opts[@]}" "$staging/apk/android.json" "$target:$remote_dir/android.json.new"
ssh "${ssh_opts[@]}" "$target" "cd '$remote_dir' && chown --reference=. *.new && mv -f CineVault-android.apk.new CineVault-android.apk && mv -f android.json.new android.json && curl -fsS http://127.0.0.1:8081/tv/latest.json"
echo
echo "Готово. Телевизоры предложат обновиться при следующем запуске приложения."
