# CineVault на Windows: сервер для iPhone

Эта схема рассчитана на личный локальный тест:

```text
Windows PC
  ├─ C:\CineVault\inbox\             исходные файлы
  ├─ C:\CineVault\data\media-library\ SQLite, исходники и HLS
  └─ http://0.0.0.0:8080              CineVault API + web

iPhone или iOS Simulator
  ├─ онлайн: HLS с Windows
  └─ офлайн: копия серии внутри приложения
```

Сервер принимает только файлы, которые пользователь сам поместил на Windows. Он не скачивает видео с третьих сайтов и не извлекает чужие потоки.

## 1. Подготовить Windows

Установить Python 3 и FFmpeg. В PowerShell можно использовать WinGet:

```powershell
winget install --id Python.Python.3.12 -e
winget install --id Gyan.FFmpeg.Shared -e
```

Закройте и заново откройте PowerShell, затем проверьте:

```powershell
py -3.12 --version
ffmpeg -version
```

## 2. Скопировать проект

Вариант через Git:

```powershell
git clone https://github.com/basovalex/CineVault.git C:\CineVault
cd C:\CineVault
```

Можно также скачать ZIP репозитория и распаковать его в `C:\CineVault`. Папки `data/media-library` в репозитории нет — она создаётся на Windows и не должна отправляться в Git.

Создать папки:

```powershell
New-Item -ItemType Directory -Force C:\CineVault\inbox | Out-Null
New-Item -ItemType Directory -Force C:\CineVault\data\media-library | Out-Null
```

## 3. Положить видео на Windows

Для сериала используй имена:

```text
C:\CineVault\inbox\Отчаянные домохозяйки\
  Desperate.Housewives.S01E01.mp4
  Desperate.Housewives.S01E02.mp4
  Desperate.Housewives.S01E03.mkv
```

Поддерживаются `.mp4`, `.m4v`, `.mov`, `.mkv`, `.webm`, `.avi`. Добавляй только материалы, на которые у тебя есть право просмотра и хранения.

Сначала проверить разбор серий, не импортируя файлы:

```powershell
cd C:\CineVault
powershell -ExecutionPolicy Bypass -File .\tools\import_media_folder_windows.ps1 `
  -Folder "C:\CineVault\inbox\Отчаянные домохозяйки" `
  -Title "Отчаянные домохозяйки" `
  -DryRun
```

Импортировать сезон:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\import_media_folder_windows.ps1 `
  -Folder "C:\CineVault\inbox\Отчаянные домохозяйки" `
  -Title "Отчаянные домохозяйки"
```

Импорт одного фильма:

```powershell
py -3.12 .\tools\import_media.py `
  "C:\CineVault\inbox\Отпуск по обмену.mp4" `
  --kind movie `
  --title "Отпуск по обмену" `
  --data-dir "C:\CineVault\data\media-library"
```

После импорта сервер создаёт карточку, сохраняет исходный файл и запускает HLS-обработку через FFmpeg. Пока HLS строится, серия будет иметь статус обработки; после появления `ready` она доступна для онлайн‑просмотра.

## 4. Запустить Windows-сервер

Самый простой вариант — двойной клик по:

```text
C:\CineVault\tools\start_cinevault_windows.bat
```

Или из PowerShell:

```powershell
cd C:\CineVault
powershell -ExecutionPolicy Bypass -File .\tools\start_cinevault_windows.ps1
```

Проверка на самом Windows:

```powershell
curl.exe http://127.0.0.1:8080/api/health
curl.exe http://127.0.0.1:8080/api/library
```

Ожидается `{"ok":true,...}` для health и JSON с `items` для каталога.

## 5. Разрешить доступ из домашней сети

Если Windows покажет запрос брандмауэра, разреши Python только для **Private networks**. Если запроса нет, PowerShell от имени администратора:

```powershell
New-NetFirewallRule `
  -DisplayName "CineVault local 8080" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8080 `
  -Action Allow `
  -Profile Private
```

Не открывай этот порт для Public profile и не публикуй его напрямую в интернет.

Узнать IPv4 Windows:

```powershell
ipconfig
```

Нужен адрес активного Wi‑Fi/Ethernet, например `192.168.0.45`.

## 6. Проверить с Mac и iPhone

Windows, Mac и iPhone должны быть в одной домашней сети. С Mac:

```bash
curl -fsS http://192.168.0.45:8080/api/health
```

В iOS-приложении открой **Настройки** и укажи:

```text
http://192.168.0.45:8080
```

Затем нажми **«Подключить и обновить»**. Для локального теста viewer-токен можно оставить пустым, если сервер запущен без `CINEVAULT_VIEWER_TOKEN`.

В симуляторе Xcode адрес Windows задаётся тем же способом. Не используй `127.0.0.1`: на физическом iPhone это сам телефон, а не Windows.

## 7. End-to-end тест

1. В каталоге должна появиться импортированная серия.
2. Открой её и проверь онлайн-воспроизведение.
3. Нажми скачать.
4. Дождись `Готово к просмотру`.
5. Отключи сеть у симулятора/телефона или останови Windows-сервер.
6. Открой серию из раздела загрузок и проверь офлайн-воспроизведение.
7. Удали загрузку — удаляется только копия на iPhone, исходник Windows остаётся.

Для поездки через интернет локального IP недостаточно: понадобится защищённый VPN/Tailscale или HTTPS reverse proxy с авторизацией. Для ближайшего теста в домашней сети схема выше достаточна.
