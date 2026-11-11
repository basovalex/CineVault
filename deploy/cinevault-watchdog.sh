#!/usr/bin/env bash
# CineVault watchdog: run every minute by cinevault-watchdog.timer.
#
# - The site answers /api/health inside the server and through Caddy outside.
#   After three failed checks in a row the container is restarted: Docker's own
#   health check only marks a hung container "unhealthy" and leaves it hanging.
# - A Telegram message goes out when the site goes down and when it is back.
# - Low disk space is reported and Docker's build cache is cleared.
#
# Settings live in /etc/cinevault-watchdog.env (chmod 600, never in Git):
#   TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
#   PUBLIC_URL=https://cinevault-aleksandr.duckdns.org/
# Without the Telegram settings the watchdog still restarts, only silently.
set -u

STATE_DIR=${CINEVAULT_WATCHDOG_STATE:-/var/lib/cinevault-watchdog}
SETTINGS=${CINEVAULT_WATCHDOG_ENV:-/etc/cinevault-watchdog.env}
CONTAINER=cinevault-cinevault-1
LOCAL_HEALTH=http://127.0.0.1:8081/api/health
FAILS_BEFORE_RESTART=3
MIN_FREE_MB=1024
# shellcheck disable=SC1090
[ -r "$SETTINGS" ] && . "$SETTINGS"
mkdir -p "$STATE_DIR"

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -fsS -m 10 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" || true
}

site_answers() {
  curl -fsS -m 10 -o /dev/null "$LOCAL_HEALTH" || return 1
  # Through Caddy the site asks for a password: 401 means it is up.
  if [ -n "${PUBLIC_URL:-}" ]; then
    code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$PUBLIC_URL" || echo 000)
    case "$code" in 200|401) ;; *) return 1 ;; esac
  fi
  return 0
}

fails=$(cat "$STATE_DIR/fails" 2>/dev/null || echo 0)
down=$(cat "$STATE_DIR/down" 2>/dev/null || echo 0)

if site_answers; then
  if [ "$down" = 1 ]; then notify "CineVault снова отвечает."; fi
  echo 0 > "$STATE_DIR/fails"; echo 0 > "$STATE_DIR/down"
else
  fails=$((fails + 1)); echo "$fails" > "$STATE_DIR/fails"
  if [ "$fails" -ge "$FAILS_BEFORE_RESTART" ]; then
    if [ "$down" != 1 ]; then notify "CineVault не отвечает ${fails} мин. Перезапускаю контейнер."; fi
    echo 1 > "$STATE_DIR/down"; echo 0 > "$STATE_DIR/fails"
    # A fresh container may still be building its catalogue index (minutes when the
    # schema changes): restarting it again would only loop.
    started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || echo "")
    age=999999
    if [ -n "$started" ]; then age=$(( $(date +%s) - $(date -d "$started" +%s 2>/dev/null || echo 0) )); fi
    if [ "$age" -ge 600 ]; then
      docker restart "$CONTAINER" >/dev/null 2>&1 || notify "CineVault: перезапуск контейнера не удался."
    fi
  fi
fi

free_mb=$(df -Pm / | awk 'NR == 2 {print $4}')
if [ "${free_mb:-0}" -lt "$MIN_FREE_MB" ]; then
  docker builder prune -f >/dev/null 2>&1 || true
  if [ ! -e "$STATE_DIR/disk-warned" ]; then
    notify "CineVault: на диске сервера осталось ${free_mb} МБ. Кеш сборки Docker очищен."
    touch "$STATE_DIR/disk-warned"
  fi
else
  rm -f "$STATE_DIR/disk-warned"
fi
