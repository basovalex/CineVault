# CineVault iOS

Нативный SwiftUI-клиент для личного CineVault-сервера.

## Что уже заложено

- подключение к серверу по HTTP/HTTPS;
- viewer-токен через `Authorization: Bearer ...`;
- каталог серий из `GET /api/library`;
- встроенный `AVPlayer` для HLS/исходного файла;
- загрузка исходника в лучшем доступном качестве внутри `Application Support/CineVaultDownloads`;
- продолжение просмотра через `PUT /api/progress/<episode_id>`;
- фоновая `URLSession`-загрузка, рассчитанная на продолжение после сворачивания приложения;
- ночная CineVault-тема, каталог, загрузки и настройки.

## Открытие

1. Открой `CineVault.xcodeproj` в Xcode на Mac с установленным iOS SDK.
2. Выбери iPhone Simulator или подключённый iPhone.
3. В приложении укажи адрес backend и `CINEVAULT_VIEWER_TOKEN`. Для локального Windows-теста адрес выглядит как `http://192.168.0.45:8080`; iPhone и Windows должны быть в одной Wi-Fi сети.
4. Загрузи серии на backend через существующий админский импорт.

`127.0.0.1` в iOS-приложении означает сам iPhone, а не MacBook. Для поездки нужен домен/VPN/Tailscale с HTTPS. Серии должны быть загружены на сервер законным способом.

Пошаговая настройка Windows-сервера: [docs/CineVault-Windows-Deployment.md](../docs/CineVault-Windows-Deployment.md).
