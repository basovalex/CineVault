@echo off
setlocal
cd /d "%~dp0.."

if not exist "data\media-library" mkdir "data\media-library"

where py >nul 2>&1
if errorlevel 1 (
    echo Python 3 не найден. Установите Python и повторите запуск.
    pause
    exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo FFmpeg не найден в PATH. Онлайн HLS и обработка файлов не будут работать.
    pause
    exit /b 1
)

echo CineVault запускается на всех сетевых интерфейсах, порт 8080.
echo Окно оставьте открытым, пока сервер нужен.
py -3.12 "tools\media_library_server.py" --host 0.0.0.0 --port 8080 --data-dir "%cd%\data\media-library"

echo.
echo Сервер остановлен. Код выхода: %ERRORLEVEL%
pause
