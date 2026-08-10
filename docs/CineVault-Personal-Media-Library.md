# CineVault — целевая архитектура личной медиатеки

## Решение для текущего этапа

Первый релиз — PWA + небольшой first-party backend с общей серверной медиатекой. Администратор импортирует каждый фильм один раз на backend, а все пользователи получают общий каталог и поток. Это даёт один интерфейс на телефоне, Mac и Windows и позволяет позже обернуть тот же web-клиент в Tauri/Capacitor.

```text
Администратор: разрешённый исходный файл
        ↓ backend import/upload (лимит и allowlist)
data/uploads + SQLite metadata
        ↓ background FFmpeg job
HLS master: 360p / 720p / 1080p
        ↓ native HLS или Hls.js
PWA player + SQLite progress
        ↓ explicit user action
Cache Storage: выбранная серия в 360p
```

Исходник никогда не удаляется при очистке кэша. HLS хранится отдельно и может быть пересоздан из исходника.

## Что реализовано сейчас

`tools/media_library_server.py` — dependency-free shared backend:

- SQLite tables `titles`, `episodes`, `progress`, `watch_rooms`;
- multipart upload только для разрешённых видео-расширений;
- browser upload закрыт без `CINEVAULT_ADMIN_TOKEN`; обычным пользователям он не нужен;
- `tools/import_media.py` импортирует файл, уже находящийся на backend, без передачи через браузер;
- `tools/import_media_folder.py` массово разбирает `S01E01`/`Season 01` и ставит весь сезон в очередь;
- TMDB backend search/details заполняют существующий сериал вместо ручного ввода названия; для сериалов предусмотрен fallback на TVmaze без ключа;
- нормализация имени и controlled path containment для `/media/source` и `/media/hls`;
- фоновые FFmpeg jobs с понятными статусами `queued`, `processing`, `ready`, `error`;
- master playlist и варианты 360p/720p/1080p;
- `GET /api/library`, `PUT /api/progress/<episode_id>`;
- `GET /api/library/episodes/<episode_id>/offline-manifest` для выбранного качества;
- `POST/GET /api/watch/rooms` и `POST /api/watch/rooms/<room_id>` для минимального polling-based sync state.

`app/`:

- раздел «Моя медиатека» с upload form и сезоном/серией;
- HTML5 player с auto quality, resume и fullscreen;
- Hls.js для Chromium и native HLS для Safari;
- Cache Storage + service worker для explicit offline download;
- создание комнаты и копирование share URL.

## API contract

| Endpoint | Назначение |
|---|---|
| `GET /api/health` | health check |
| `GET /api/library` | серии, статусы, HLS/source URLs, progress |
| `GET /api/catalog/search?q=...&kind=series` | поиск существующего фильма/сериала в TMDB |
| `GET /api/catalog/title/<provider>/<kind>/<external_id>` | полные метаданные и сезоны выбранного тайтла; provider=`tmdb` или `tvmaze` |
| `POST /api/library/upload` | admin-only multipart `title`, `season`, `episode`, `episode_title`, `file` |
| `PUT /api/progress/<id>` | `{position, duration, completed}` |
| `GET /api/library/episodes/<id>/offline-manifest` | URL master/segments выбранного качества |
| `POST /api/watch/rooms` | `{episode_id}` → room id/share code |
| `GET /api/watch/rooms/<id>` | текущая pause/seek state |
| `POST /api/watch/rooms/<id>` | `{position, playing}` → новая state с `seq` |

Текущий room API — минимальный контракт для polling. Для настоящего совместного просмотра следующий шаг — WebSocket/SSE, host authority, clock drift correction и reconnect policy.

## Автоматический формат и экономия места

FFmpeg создаёт несколько HLS quality ladders. В online режиме player выбирает качество по bandwidth и размеру viewport. Для поездки UI запрашивает максимальный реально созданный вариант, не поднимаясь выше исходного разрешения, и сохраняет его сегменты; это даёт лучшее качество без бессмысленного апскейла.

## Безопасность и границы

Текущий сервер — shared-library MVP. Список и потоки общие для пользователей, а прогресс хранится отдельно на уровне выбранного браузера/профиля. Он не имеет полноценной встроенной системы аккаунтов и не должен публиковаться напрямую в интернет. Перед удалённым доступом обязательны:

1. HTTPS reverse proxy.
2. Login/session или device pairing для двух устройств.
3. Авторизация каждого title/episode/progress/room запроса.
4. Rate limit и quota на upload/storage/transcode.
5. Ограничение параллельных FFmpeg jobs и отдельный worker process.
6. Секреты только в server environment, не в `app/config.local.js` и не в Git.
7. Backup SQLite metadata и отдельная lifecycle policy для source/HLS.

В архитектуре отсутствуют scraping, torrent, arbitrary remote URLs, DRM bypass, скрытые HLS tokens, cookies и proxy-цепочки третьих сайтов.

## Пошаговое внедрение после MVP

1. Поставить backend storage и проверить импорт короткого разрешённого MP4; для сезона выбрать папку целиком (`Season 01/01.mp4` или имена `S01E01.mp4`…`S01E18.mp4`).
2. Добавить повторный запуск failed jobs и progress endpoint для jobs.
3. Добавить WebSocket sync и invite/device pairing.
4. Перенести source/HLS в S3-compatible storage только если нужен домашний сервер с несколькими клиентами; SQLite оставить для metadata/progress.
5. Ввести user profiles, auth, quota, encrypted backups и observability.
6. Обернуть PWA в Tauri/Capacitor только после проверки Safari iOS, Android Chrome, macOS Safari/Chrome и Windows Chrome/Edge.
7. Добавить subtitles/audio tracks через собственные разрешённые файлы и `ffprobe`, сохраняя track metadata в БД.

## Старые документы

`CineVault-Online-PRD.md` и `CineVault-Online-Architecture.md` остаются полезными для online catalog/provider boundary, но описывают другой продукт и запрещают user-owned library. Для текущего запроса этот документ имеет приоритет; каталоговый режим и LegalDemoProvider сохранены как отдельные безопасные части.
