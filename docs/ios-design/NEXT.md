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

## Сделано во второй заход
- `TitleDetailView.swift` и `MineView.swift`, файлы добавлены в Xcode-проект, сборка проходит.
- Проверено в симуляторе на живых данных: главная, каталог, поиск, «Моё», карточка, «Продолжить просмотр» из общей истории.
- Отладочный параметр запуска: `xcrun simctl launch <device> com.cinevault.personal -cinevault.initialTab catalog`.

## Осталось
1. Проверить касаниями (нужен доступ к симулятору в панели): кнопки баннера после исправления, воспроизведение Alloha/Collaps/Veoveo/Turbo, постеры в подборках главной.
2. Шрифт Rubik (`Font.cine` в Theme.swift) — по желанию.
3. Влить `ios-redesign` в `main`.
