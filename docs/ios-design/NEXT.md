# iOS-редизайн: где остановились (19.10.2026)

Ветка `ios-redesign`. Макеты: `docs/ios-design/mockups/` и холст https://claude.ai/artifact/1fAHfHTgLffGH81B6Xng8u.
Референсы: Movix и LuminaFlix (Figma). Стиль: токены сайта (#0D0C0F, акцент #00A86B, кнопка #00875A, оценки #FFCD1A).

## Готово
- `Theme.swift`: цвета, кнопки, чипы, сегменты, постеры с оценкой, полоска прогресса.
- `Models.swift`: фон, логотип, IMDb, возраст, `CatalogProgressEntry`, `FavoriteTitle`, провайдеры с `embedUrl` и `voices`.
- `APIClient.swift`: `/api/catalog-progress` (GET/PUT), фасеты по типу.
- `AppStore.swift`: избранное на устройстве, общий с сайтом прогресс, догрузка каталога страницами.
- `HomeView.swift`: баннер с листанием, «Продолжить просмотр», подборки.
- `CatalogViews.swift`: каталог (Фильмы/Сериалы, жанры, сетка) и поиск.
- `EmbedPlayers.swift`: плееры вынесены, добавлен `EmbedProviderPlayerView` (Collaps/Veoveo/Turbo).
- `ContentView.swift`: 5 вкладок, новая нижняя панель, «Загрузки» и «Настройки».

## Осталось (сборка пока НЕ проходит)
1. `TitleDetailView.swift`: фон, логотип, «Смотреть», выбор плеера (CineVault → Alloha → Collaps/Veoveo/Turbo) и озвучки, описание, жанры, сезоны, вкладки «Похожие / Актёры / О фильме». Логику взять из старого `CatalogTitleDetailView` (git show main:ios/CineVault/ContentView.swift).
2. `MineView.swift`: «Избранное» и «История» (store.watchedTitles), кнопка настроек.
3. Добавить новые .swift-файлы в `CineVault.xcodeproj/project.pbxproj` (PBXBuildFile, PBXFileReference, группа, Sources). Убрать `pug-mascot.png`.
4. Собрать (`-destination 'generic/platform=iOS Simulator'`), запустить в симуляторе, сверить с макетами.
5. По желанию: подключить шрифт Rubik (`Font.cine` в Theme.swift).
