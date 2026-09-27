# CineVault MVP + Personal Media Library

В проекте есть каталоговый прототип и общий backend-каталог. Администратор может добавить видеофайл в медиатеку или подключить разрешённый поток к карточке. Для прямого HLS-потока кнопка «Скачать MP4» собирает файл на backend и отправляет его в загрузки браузера. Внешний embed остаётся страницей плеера; его нельзя скачать через эту кнопку.

## Запуск медиатеки

Для локальной работы на этом MacBook ключ не нужен:

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 tools/media_library_server.py --host 127.0.0.1 --port 8081 --open-admin --data-dir data/media-library
```

При локальном запуске сервер не обновляет весь каталог по таймеру. Когда открывают карточку Kinopoisk, backend запускает точечную команду `update_media.py --delay-seconds 0 --only <KINOPOISK_ID>` и только после обновления предлагает просмотр. Для карточки без источника он сначала регистрирует её ID и тип в локальном helper, не скачивая видео. Если источник временно недоступен, карточка остаётся в каталоге. Повторные одновременные запросы одного тайтла объединяются, а на backend действует короткая защита от повторного запуска. По умолчанию helper ищется в `~/PycharmProjects/parsers/lk_dreamjob_reviews_parser-main/kinopoisk_media_system_fixed`; если он лежит в другом месте, укажи путь перед запуском:

```bash
export CINEVAULT_KINOPOISK_UPDATER_DIR='/путь/к/kinopoisk_media_system_fixed'
python3 tools/media_library_server.py --host 127.0.0.1 --port 8081 --open-admin --data-dir data/media-library
```

Для отключения обновления перед просмотром добавь `--disable-kinopoisk-playback-refresh`.

Режим `--open-admin` разрешает добавление только через локальный адрес. Для доступа из интернета используй отдельный админский ключ и не включай `--open-admin`:

```bash
export CINEVAULT_ADMIN_TOKEN='замени-на-длинный-случайный-секрет'
export CINEVAULT_VIEWER_TOKEN='замени-на-секрет-для-приложения'
python3 tools/media_library_server.py --host 0.0.0.0 --port 8081 --data-dir /srv/cinevault/media-library
```

Открыть адрес сервера → «Общий каталог». Пользовательские браузеры получают общий список фильмов и серий; админский ключ нужен только для импорта.

Для совместного просмотра оба устройства должны открывать один и тот же публичный HTTPS-адрес, ведущий на этот backend (для SSH-туннеля пробрасывай порт 8081, а не старый статический 8080). Если интерфейс размещён на одном домене, а API на другом, укажи в окружении backend адрес API и разрешённый origin интерфейса:

```bash
export CINEVAULT_API_BASE_URL='https://api.example.com'
export CINEVAULT_PUBLIC_URL='https://cinevault.example.com'
export CINEVAULT_CORS_ORIGINS='https://cinevault.example.com'
```

### Ссылки на карточки и sitemap

У каталога и карточек теперь есть постоянные пути: `/catalog/`, `/movies/`, `/series/` и `/title/<id>/`. При возврате из карточки CineVault восстанавливает место в списке, а сама карточка всегда открывается сверху. Карта сайта доступна по `/sitemap.xml`; в ней перечислены публичные разделы и текущие карточки из `app/data/catalog_imports.json`. Для абсолютных адресов в sitemap на сервере укажи фактический внешний URL:

```bash
export CINEVAULT_PUBLIC_URL='https://cinevault.example.com'
```

Sitemap помогает навигации и индексации, но не ограничивает доступ: приватность по-прежнему должна обеспечиваться viewer-токеном и HTTPS-прокси.

### Добавить фильм с вариантами озвучки

В карточке фильма нажми «Добавить источник» и выбери JSON с прямыми стабильными HLS-ссылками. Для фильма поддерживается сериаловый формат с другими полями:

```json
{
  "data": [
    {
      "translations": [
        {
          "id": "original",
          "name": "Оригинал",
          "quality": "1080p",
          "m3u8": "https://media.example.com/movies/title/master.m3u8"
        }
      ]
    }
  ]
}
```

Также принимаются `hlsUrl`, `filepath`, `url`, `sources` и `videoSources`. Для автоматически обновляемых Kinopoisk-карточек сохраняется свежий master HLS URL целиком, включая выданный источником временный `?pl=...`: CineVault не извлекает и не генерирует этот параметр самостоятельно. Ручные импорты по-прежнему должны использовать разрешённый источник.

На сайте доступен онлайн-просмотр. Кнопки скачивания MP4 и сохранения видео офлайн в браузере убраны; новые задания сборки MP4 через веб-API отклоняются. Офлайн-загрузку планируется развивать отдельно в мобильных приложениях. Старые файлы в `data/media-library/downloads` автоматически не удаляются — их нужно проверять и очищать отдельно, не прерывая активную сборку или отдачу.

После изменения этих переменных backend нужно перезапустить. Без отдельного домена API оставь `CINEVAULT_API_BASE_URL` пустым: запросы комнат идут на текущий origin.

### Добавить карточку по Kinopoisk ID или ссылке

Команда получает только метаданные и создаёт карточку. Видео, список серий и озвучки не загружаются до первого открытия карточки:

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 tools/add_kinopoisk_title.py 412344
```

Можно передать и ссылку вида `https://www.kinopoisk.ru/series/412344/`. Если метаданные уже есть в `generated/<id>/response.json`, они используются без сетевого запроса; с `--no-update` новые сетевые запросы запрещены. Новые карточки записываются отдельно в `app/data/catalog_metadata.json`: существующий каталог с подключёнными источниками не заменяется.

Для числового ID тип определяется по метаданным:

```bash
python3 tools/add_kinopoisk_title.py 258687
python3 tools/add_kinopoisk_title.py 'https://www.kinopoisk.ru/series/404900/'
```

Для пакетного импорта ссылок можно передать JSON `media_sources.json` либо текстовый файл с одним ID/ссылкой на строку. Сначала проверь результат без записи:

```bash
python3 tools/import_kinopoisk_metadata.py --links-file kinopoisk_media_system_fixed/media_sources.json --dry-run
python3 tools/import_kinopoisk_metadata.py --links-file kinopoisk_media_system_fixed/media_sources.json
```

Без `--fetch-missing` команда использует только локальные `generated/<id>/response.json`. Для недостающих метаданных нужен `CINEVAULT_APBUGALL_TOKEN` в окружении и явный `--fetch-missing`; видеопотоки при этом не запрашиваются. `--offset` и `--limit` позволяют проверять небольшие партии. Список ссылок должен содержать реальные ID: перебор всех чисел не равен полному каталогу Kinopoisk.

Для постепенного расширения за пределы уже известных ссылок подготовлен импорт метаданных из Kinopoisk.dev. Он читает `CINEVAULT_KINOPOISK_DEV_TOKEN` из окружения или локального игнорируемого Git-файла `.env`, не получает видео и не затирает подключённые карточки. Режим `backfill` постранично обходит историческую базу и сохраняет контрольную точку в `data/media-library/kinopoisk_catalog_sync.json`; режим `daily` повторно забирает последние изменения с недельным перекрытием и обновляет названия, постеры и рейтинги:

```bash
python3 tools/sync_kinopoisk_dev_catalog.py --mode backfill --pages 2 --limit 250 --dry-run
python3 tools/sync_kinopoisk_dev_catalog.py --mode backfill --pages 2 --limit 250
python3 tools/sync_kinopoisk_dev_catalog.py --mode backfill --kind series --pages 2 --limit 250
python3 tools/sync_kinopoisk_dev_catalog.py --mode daily --pages 2 --limit 250 --lookback-days 7
```

В Docker тот же ограниченный запуск доступен через `docker compose --profile maintenance run --rm kinopoisk-catalog-sync`. Для сервера добавлены `deploy/cinevault-kinopoisk-catalog-sync.service` и `.timer`; таймер запускает ежедневный режим, а историческое наполнение нужно запускать отдельными небольшими партиями. Это импорт карточек из индекса провайдера, а не гарантия полного совпадения со всем сайтом Kinopoisk. До первого запуска на сервере нужно сверить и сохранить его существующий каталог; локальный файл `catalog_imports.json` нельзя использовать вместо серверного.

Полный каталог отдаётся браузеру только страницами через `/api/catalog`; `/api/catalog/index` возвращает ограниченную подборку для главной. Поэтому рост базы не заставляет браузер скачивать все карточки сразу. Полная карточка загружается при открытии, а поиск видеопотока начинается только после действия «Смотреть» или «Продолжить».

Если постраничный backfill Kinopoisk.dev ограничен тарифом, для массового независимого наполнения можно использовать открытые записи Wikidata со свойством `P2603`. Импортёр получает только Kinopoisk ID и общедоступные метаданные, использует отдельную контрольную точку и не обращается к видеопровайдеру:

```bash
python3 tools/sync_wikidata_kinopoisk_catalog.py --batches 1 --limit 500 --dry-run
python3 tools/sync_wikidata_kinopoisk_catalog.py --batches 10 --limit 500
```

Wikidata не гарантирует полноту всего каталога Kinopoisk, поэтому ежедневное обновление последних карточек остаётся за разрешённым режимом `sync_kinopoisk_dev_catalog.py --mode daily`.

#### Через интерфейс CineVault

В «Моей медиатеке» есть карточка «Добавить фильм или сериал». Вставь Kinopoisk ID или ссылку; backend запустит импорт **только метаданных** в фоне и покажет ссылку на карточку. Новое добавление требует админского ключа (локальный `--open-admin` разрешён только на loopback-адресе).

Массовый импорт на сервере запускай отдельно и по частям, предварительно сохранив копии серверного каталога; не заменяй его локальным файлом с меньшим числом карточек.

### Быстрый запуск на Windows

Для сценария «Windows — сервер, iPhone — плеер» без Docker используй [инструкцию Windows](docs/CineVault-Windows-Deployment.md). После распаковки проекта на Windows достаточно установить Python 3 и FFmpeg, положить свои файлы в `inbox`, запустить `tools/start_cinevault_windows.bat` и указать в iOS-приложении адрес Windows вида `http://192.168.0.45:8080`.

TMDB-ключ вручную указывать не нужно: при запуске из этого проекта backend берёт уже существующий ключ из `app/config.local.js`, не отдаёт его браузеру и не печатает в лог. Если TMDB временно недоступен, поиск сериалов автоматически использует TVmaze. На отдельном удалённом сервере, где нет этого файла, можно задать `CINEVAULT_TMDB_API_TOKEN` через секреты окружения — это опциональный fallback.

### Ежедневное расширение каталога

`tools/sync_tmdb_catalog.py` добавляет только метаданные карточек: названия, постеры, жанры, рейтинг и годы. Он **не** ищет и не скачивает видеопотоки. Это позволяет безопасно расширять каталог и не ломает уже добавленные Kinopoisk-источники: их `videoSources`, сезоны и ID сохраняются при обновлении карточки.

Для теста без записи в каталог:

```bash
CINEVAULT_TMDB_API_TOKEN='TMDB_READ_ACCESS_TOKEN' \
python3 tools/sync_tmdb_catalog.py --mode daily --pages 2 --dry-run
```

Для начального постепенного наполнения запускай `backfill` небольшими порциями: один запуск с `--pages 20` добавляет до 800 популярных фильмов и сериалов. Повторный запуск обновит карточки и не создаст дубликаты.

```bash
CINEVAULT_TMDB_API_TOKEN='TMDB_READ_ACCESS_TOKEN' \
python3 tools/sync_tmdb_catalog.py --mode backfill --pages 20
```

На VPS после добавления `CINEVAULT_TMDB_API_TOKEN` в `.env` включи ежедневный systemd timer. Он запускает отдельный контейнер и не перезапускает плеер:

```bash
sudo cp deploy/cinevault-catalog-sync.service /etc/systemd/system/
sudo cp deploy/cinevault-catalog-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cinevault-catalog-sync.timer
systemctl list-timers cinevault-catalog-sync.timer
```

На backend данные лежат в `/srv/cinevault/media-library/` (SQLite, исходники, HLS). Каталог не нужно коммитить или синхронизировать в Git. Для публичного сервера поставь reverse proxy с HTTPS и авторизацией пользователей; raw Python server не должен быть единственной защитой.

Импорт прямо с диска backend — предпочтительный способ для больших фильмов:

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 tools/import_media.py "/srv/inbox/film.mp4" \
  --title "Наш фильм" \
  --data-dir /srv/cinevault/media-library
```

Для серии добавь `--season 1 --episode 1 --episode-title "Начало"`. Файл не проходит через браузер: backend копирует его в общий storage и запускает FFmpeg.

Для сезона целиком используй авторазбор имён:

```bash
python3 tools/import_media_folder.py "/srv/inbox/Отчаянные домохозяйки" \
  --title "Отчаянные домохозяйки" \
  --data-dir /srv/cinevault/media-library \
  --dry-run
python3 tools/import_media_folder.py "/srv/inbox/Отчаянные домохозяйки" \
  --title "Отчаянные домохозяйки" \
  --data-dir /srv/cinevault/media-library
```

Скрипт сам найдёт точную карточку по названию: сначала через TMDB с уже имеющимся локальным ключом, затем через TVmaze для сериалов; `--tmdb-id` нужен только для принудительного выбора. Поддерживаются файлы `Show.S01E01.mkv`, `Show - S01E02.mp4` и папки `Season 01/01.mkv`. Сначала запускай `--dry-run`, чтобы проверить соответствие серий.

Для HLS-транскодирования установи FFmpeg:

```bash
brew install ffmpeg                 # macOS
# Ubuntu/Debian: sudo apt install ffmpeg
```

### Подключение внешнего embed-плеера

В разделе «Моя медиатека» есть форма «Добавить RUTUBE-видео». В неё можно вставить обычную ссылку `https://rutube.ru/video/...` или `https://rutube.ru/play/embed/...`. CineVault преобразует её в официальный RUTUBE iframe-плеер и не забирает прямой поток. Для одного фильма укажи сезон и серию как `0`; для серии — например, `1` и `1`.

Тот же путь доступен для автоматизации:

```bash
curl -X POST 'http://127.0.0.1:8081/api/library/external-embed' \
  -H 'Content-Type: application/json' \
  -H 'X-CineVault-Admin-Token: замени-на-свой-админский-токен' \
  --data-raw '{"title":"Наш сериал","season":1,"episode":1,"episode_title":"Пилотная серия","embed_url":"https://cinemar.cc/embed/117515/твой-короткоживущий-токен"}'
```

После ответа `201` нажми «Обновить» в медиатеке. У внешних embed-источников нет HLS-транскодирования и офлайн-кнопки: доступность, авторизация, качество и срок действия контролирует исходный сервис.

## Перенос на сервер без изменения приложения

Для переносимого серверного режима используй Docker Compose: контейнер сам содержит FFmpeg, автоматически перезапускается, проверяется health-check и хранит SQLite, исходники и HLS в постоянной папке. Подробная инструкция: [docs/CineVault-Deployment.md](docs/CineVault-Deployment.md).

```bash
cp .env.example .env
mkdir -p inbox data/media-library
docker compose up -d --build
curl -fsS http://127.0.0.1:8081/api/health
```

Для медиатеки с исходниками и HLS лучше брать диск VPS от 10–20 ГБ, даже если первые файлы занимают около 5 ГБ.

## Нативное iOS-приложение

В `ios/CineVault.xcodeproj` добавлен SwiftUI-клиент для поездок: он получает общий каталог с backend, открывает HLS/исходный поток во встроенном AVPlayer, скачивает исходный файл в Application Support приложения и сохраняет прогресс через `/api/progress/<episode_id>`. Viewer-токен передаётся только в заголовке `Authorization: Bearer ...`.

Открой проект в Xcode, укажи публичный HTTPS-адрес сервера и viewer-токен в настройках приложения. `127.0.0.1` на iPhone указывает на сам iPhone, поэтому для Турции нужен домен, VPN/Tailscale или другой защищённый HTTPS-доступ к серверу. Подробности: [ios/README.md](ios/README.md).

Если FFmpeg отсутствует, загрузка сохранит исходник и покажет понятный статус `error`; после установки загрузку нужно повторить.

## Статический каталог

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 -m http.server 8080 --directory app
```

Открыть http://127.0.0.1:8080. В этом режиме upload/API медиатеки недоступны.

## Локальный LegalDemoProvider

Демо-сервер использует только вымышленный сериал и fixtures из `fixtures/legal_demo`; сетевые клиенты, cookies, proxy и внешние источники не используются.

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 tools/hdrezka_dev_server.py --port 8082
```

Открыть http://127.0.0.1:8082 и зайти в «Настройки». Демо ищет «Тестовый сериал», показывает локальные сезоны и серии и проверяет synthetic HLS-fixture без внешних ссылок.

## Что уже работает

- каталог, поиск, избранное, «Наш вечер», сезоны и серии;
- открытые фильмы Archive.org и официальный RUTUBE с локальным resume;
- локальный `LegalDemoProvider` без внешних сетевых источников;
- общий backend-каталог: один импорт фильма доступен всем пользователям;
- админский upload/import с `CINEVAULT_ADMIN_TOKEN`, обычный пользователь только смотрит;
- раздел «Общий каталог» с сезонами/сериями и серверным статусом обработки;
- SQLite progress API и контролируемые `/media/source` и `/media/hls` пути;
- общая серверная история просмотра через `/api/history`; прогресс и продолжение синхронизируются для всех пользователей backend;
- адаптивный HLS master playlist через FFmpeg, native HLS в Safari и Hls.js в Chromium;
- офлайн-кэш выбранной серии в Cache Storage PWA в максимальном доступном качестве;
- room/state API для синхронизации pause/seek между участниками.
- админский `/api/library/external-embed` для официальных iframe/embed-ссылок и cURL с извлечением только `referer`;
- первый нативный SwiftUI-клиент в `ios/`: каталог, встроенный плеер, viewer-токен, фоновые загрузки и офлайн-раздел.

## Точные проверки

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
python3 -m unittest discover -s tests -v
python3 -m py_compile tools/media_library_server.py tools/legal_demo_provider.py tools/hdrezka_dev_server.py
node --check app/app.js
curl -s http://127.0.0.1:8081/api/health
```

## Ограничения текущего MVP

Текущий сервер — MVP для личного доступа: viewer-токен добавлен, но полноценной системы аккаунтов, ACL, TLS и device pairing пока нет. Перед публикацией нужны reverse proxy с HTTPS, отдельные пользовательские сессии, ACL на каждый title/episode/progress/room запрос, quota/rate limit, отдельный worker process и backup policy. Не удаляй исходники при очистке HLS-кэша: HLS можно пересоздать из source.

Сгенерированный ассет мопса хранится в `app/assets/pug-mascot.png`. Целевая архитектура и пошаговое продолжение описаны в [docs/CineVault-Personal-Media-Library.md](docs/CineVault-Personal-Media-Library.md).
