@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.cinevault.android

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Theaters
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.util.Locale

private fun runtimeLabel(minutes: Int): String = if (minutes >= 60) "${minutes / 60} ч ${minutes % 60} мин" else "$minutes мин"

/** The title's page, by TMDB: the frame, facts, one main action, seasons with stills, the cast and similar titles. */
@Composable
fun TvTitleScreen(initial: TvItem, nav: TvNav, startSeason: Int = 0) {
    var item by remember { mutableStateOf(TvState.known[initial.id]?.takeIf { it.detailed } ?: initial) }
    var failed by remember { mutableStateOf(false) }
    var extras by remember { mutableStateOf<List<TvRow>>(emptyList()) }
    val record = TvState.latest(item.id)
    var season by rememberSaveable { mutableIntStateOf(startSeason.takeIf { it > 0 } ?: record?.season?.takeIf { it > 0 } ?: 0) }
    var episodes by remember { mutableStateOf<List<TvEpisode>?>(null) }
    var ratings by remember { mutableStateOf<List<TvRatedSeason>>(emptyList()) }
    var mapOpen by rememberSaveable { mutableStateOf(false) }
    val play = remember { FocusRequester() }
    val list = rememberLazyListState()

    LaunchedEffect(initial.id) {
        if (!item.detailed) runCatching { Tmdb.title(initial.id) }.onSuccess { item = it; TvState.remember(it) }.onFailure { failed = true }
        extras = runCatching { Tmdb.extras(item) }.getOrDefault(emptyList())
    }
    LaunchedEffect(Unit) { delay(120); if (!TvMemory.restore) runCatching { play.requestFocus() } }
    val seasons = item.seasons
    LaunchedEffect(seasons) { if (season == 0 || seasons.none { it.number == season }) seasons.firstOrNull()?.let { season = it.number } }
    LaunchedEffect(item.tmdbId, item.seasons.size) {
        if (item.isSeries && item.seasons.isNotEmpty()) ratings = runCatching { Tmdb.episodeRatings(item) }.getOrDefault(emptyList())
    }
    LaunchedEffect(item.tmdbId, season, item.isSeries) {
        if (!item.isSeries || season == 0) return@LaunchedEffect
        episodes = null
        episodes = runCatching { Tmdb.episodes(item.tmdbId, season) }.getOrDefault(emptyList())
    }

    val today = Tmdb.day()
    val unreleased = item.premiere.isNotBlank() && item.premiere > today
    val resuming = record != null && !record.completed && record.real
    val playLabel = when {
        resuming && record!!.season > 0 -> "Продолжить"
        resuming -> "Продолжить с ${tvClock(record!!.position)}"
        record?.completed == true && record.season > 0 -> "Смотреть дальше"
        else -> "Смотреть"
    }

    Box(Modifier.fillMaxSize().background(Hall.Bg)) {
        Backdrop(Tmdb.image(item.backdrop, "w1280"), strength = 0.75f)
        CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll(top = 0.05f, bottom = 0.05f, target = 0.08f) }, LocalScrollTop provides { list.animateScrollToItem(0) }) {
            LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(bottom = 60.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                item(key = "hero") {
                    Column(Modifier.fillMaxWidth().scrollTopOnFocus().padding(start = Hall.Gutter, end = Hall.Gutter, top = 70.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        HText(if (item.isSeries) "Сериал" else "Фильм", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                        TitleArt(item, height = 96.dp, textSize = Hall.STitle, modifier = Modifier.fillMaxWidth(0.55f))
                        if (item.originalTitle.isNotBlank() && item.originalTitle != item.title) HText(item.originalTitle, size = Hall.S0, color = Hall.Muted, maxLines = 1)
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (item.rating > 0) Badge(String.format(Locale.US, "%.1f", item.rating), color = Hall.OnAccent, background = Hall.Accent)
                            val facts = listOfNotNull(
                                item.year.takeIf { it > 0 }?.toString(),
                                item.genres.take(3).joinToString(", ").ifBlank { null },
                                if (item.isSeries && seasons.isNotEmpty()) countWord(seasons.size, "сезон", "сезона", "сезонов") else item.runtime.takeIf { it > 0 }?.let(::runtimeLabel),
                                item.countries.take(2).joinToString(", ").ifBlank { null },
                                item.age.takeIf(String::isNotBlank)?.let { "$it+" },
                            )
                            HText(facts.joinToString(" · "), size = Hall.S0, color = Hall.Text2, maxLines = 1)
                        }
                        if (unreleased) HText("Премьера ${russianDate(item.premiere)}", size = Hall.S0, color = Hall.Gold, weight = FontWeight.SemiBold)
                        item.next?.let { next -> HText("Следующая серия: ${next.season} сезон, ${next.episode} серия — ${russianDate(next.airDate)}", size = Hall.S0, color = Hall.Gold) }
                        if (item.tagline.isNotBlank()) HText(item.tagline, size = Hall.S0, color = Hall.Text2, maxLines = 1)
                        if (item.overview.isNotBlank()) HText(item.overview, Modifier.fillMaxWidth(0.75f), size = Hall.S0, color = Hall.Text2, maxLines = 4)
                        else if (failed) HText("Описание не загрузилось. Смотреть всё равно можно.", size = Hall.S0, color = Hall.Muted)
                        Spacer(Modifier.height(6.dp))
                        // All the buttons fit, however long «Продолжить · …» is: the row scrolls with the focus.
                        Row(Modifier.offset(x = (-16).dp).horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            HButton(playLabel, {
                                val (s, e) = if (resuming && record!!.season == 0) 0 to 0 else TvState.nextUp(item)
                                nav.push(TvRoute.Watch(item, s, e))
                            }, Modifier.remembered("title-${item.id}", "play"), primary = true, icon = Icons.Default.PlayArrow, focus = play, big = true,
                                note = if (resuming && record!!.season > 0) "${record.season} сезон, ${record.episode} серия · с ${tvClock(record.position)}" else null)
                            HButton("Трейлер", { nav.push(TvRoute.Trailer(item)) }, icon = Icons.Default.Theaters)
                            val favorite = TvState.isFavorite(item.id)
                            HButton(if (favorite) "В избранном" else "В избранное", { TvState.toggleFavorite(item) },
                                Modifier.remembered("title-${item.id}", "fav"), icon = if (favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder)
                            if (item.isSeries || unreleased) {
                                val on = TvState.isSubscribed(item.id)
                                HButton(if (on) "Напомню" else "Напомнить", { TvState.toggleSubscription(item) },
                                    icon = if (on) Icons.Default.Notifications else Icons.Default.NotificationsNone)
                            }
                        }
                        if (item.directors.isNotEmpty()) HText("${if (item.isSeries) "Создатели" else "Режиссёр"}: ${item.directors.joinToString(", ")}", size = Hall.S_1, color = Hall.Muted, maxLines = 1)
                    }
                }
                if (item.isSeries && seasons.isNotEmpty()) item(key = "seasons") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.padding(horizontal = Hall.Gutter)) {
                            HText("Сезоны и серии", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                            HText("${countWord(seasons.size, "сезон", "сезона", "сезонов")} · ${countWord(seasons.sumOf { it.episodes }, "серия", "серии", "серий")}", size = Hall.S_1, color = Hall.Muted)
                        }
                        if (seasons.size > 1) androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = Hall.Gutter, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(seasons, key = { it.number }) { entry -> HChip("Сезон ${entry.number}", entry.number == season, { season = entry.number }) }
                        }
                        val shown = episodes
                        if (shown == null) StatusLine("Загружаю серии сезона…", modifier = Modifier.padding(horizontal = Hall.Gutter))
                        else TvShelf("", "") {
                            items(shown, key = { "${it.season}-${it.number}" }) { episode ->
                                val progress = TvState.progressOf(item.id, episode.season, episode.number)
                                val future = episode.airDate.isNotBlank() && episode.airDate > today
                                WideCard(episode.still, episode.name.ifBlank { "${episode.number} серия" },
                                    if (future) "Выйдет ${russianDate(episode.airDate)}" else if (progress?.completed == true) "Просмотрено" else episode.airDate.takeIf(String::isNotBlank)?.let { russianDate(it, true) }.orEmpty(),
                                    { nav.push(TvRoute.Watch(item, episode.season, episode.number)) },
                                    Modifier.remembered("title-${item.id}", "ep-${episode.season}-${episode.number}"), width = 230.dp,
                                    kicker = "${episode.number} серия", rating = episode.rating, progress = progress?.takeIf { !it.completed }?.share ?: 0.0)
                            }
                        }
                    }
                }
                // The site's episode ratings map, folded by default so the page below stays one press away.
                if (item.isSeries && ratings.isNotEmpty()) item(key = "ratings") {
                    EpisodeRatingsMap(ratings, mapOpen, { mapOpen = !mapOpen }) { s, e -> nav.push(TvRoute.Watch(item, s, e)) }
                }
                // «О фильме», the site's facts block.
                item(key = "about") {
                    val facts = listOf(
                        "Оригинальное название" to item.originalTitle.takeIf { it != item.title }.orEmpty(),
                        "Год" to (if (item.year > 0) "${item.year}" else ""),
                        "Премьера" to (if (item.premiere.length == 10) russianDate(item.premiere, withYear = true) else ""),
                        "Страна" to item.countries.joinToString(", "),
                        (if (item.isSeries) "Создатели" else "Режиссёр") to item.directors.joinToString(", "),
                        "Возраст" to (if (item.age.isNotBlank()) "${item.age}+" else ""),
                        (if (item.isSeries) "Сезоны" else "Хронометраж") to (if (item.isSeries) (if (seasons.isNotEmpty()) "${countWord(seasons.size, "сезон", "сезона", "сезонов")}, ${countWord(seasons.sumOf { it.episodes }, "серия", "серии", "серий")}" else "") else if (item.runtime > 0) runtimeLabel(item.runtime) else ""),
                        "Рейтинг TMDB" to (if (item.rating > 0) "${String.format(Locale.US, "%.1f", item.rating)} · ${countWord(item.votes, "оценка", "оценки", "оценок")}" else ""),
                    ).filter { it.second.isNotBlank() }
                    if (facts.isNotEmpty()) Column(Modifier.padding(horizontal = Hall.Gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        HText(if (item.isSeries) "О сериале" else "О фильме", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                        facts.chunked(2).forEach { pair ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                                pair.forEach { (label, value) ->
                                    Row(Modifier.weight(1f)) {
                                        HText(label, Modifier.width(190.dp), size = Hall.S0, color = Hall.Muted)
                                        HText(value, size = Hall.S0, color = Hall.Text, maxLines = 2)
                                    }
                                }
                                if (pair.size == 1) Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
                if (item.people.isNotEmpty()) item(key = "cast") {
                    TvShelf("В ролях") {
                        items(item.people, key = { it.id }) { person -> PersonCard(person) { nav.push(TvRoute.Person(person.id, person.name)) } }
                    }
                }
                items(extras, key = { "extra-${it.key}" }) { row ->
                    TvShelf(row.title) {
                        items(row.items, key = { it.id }) { other -> TvPosterCard(other, { nav.open(other) }, Modifier.remembered("title-${item.id}", "${row.key}/${other.id}")) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PersonCard(person: TvPerson, onClick: () -> Unit) {
    val (interaction, focused) = rememberFocused()
    Column(Modifier.width(104.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(88.dp).hallFocus(CircleShape.let { RoundedCornerShape(50) }, scale = 1.08f, interaction = interaction, onClick = onClick).background(Hall.Surface2),
            contentAlignment = Alignment.Center) {
            if (person.photo.isNotBlank()) TvImage(person.photo, person.name.take(1), Modifier.fillMaxSize(), titleSize = Hall.S2)
            else HText(person.name.take(1), size = Hall.S2, color = Hall.Muted, display = true)
        }
        HText(person.name, size = Hall.S_1, color = if (focused) Hall.Accent else Hall.Text, weight = FontWeight.SemiBold, maxLines = 2, align = TextAlign.Center)
        if (person.role.isNotBlank()) HText(person.role, size = Hall.S_1, color = Hall.Muted, maxLines = 1, align = TextAlign.Center)
    }
}

/** A person: photo, facts and two rows — «Скоро выйдут» and «Последние роли», newest first, no talk shows or cameos. */
@Composable
fun TvPersonScreen(id: Int, name: String, nav: TvNav) {
    var page by remember { mutableStateOf<TvPersonPage?>(null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) { failed = false; runCatching { Tmdb.person(id) }.onSuccess { page = it }.onFailure { failed = true } }
    val shown = page
    val personList = rememberLazyListState()
    CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll() }, LocalScrollTop provides { personList.animateScrollToItem(0) }) {
        LazyColumn(Modifier.fillMaxSize().background(Hall.Bg), personList, contentPadding = PaddingValues(top = 40.dp, bottom = 60.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            item(key = "head") {
                Row(Modifier.padding(horizontal = Hall.Gutter), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                    Box(Modifier.width(150.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface)) {
                        if (shown != null) TvImage(shown.photo, shown.name, Modifier.fillMaxSize())
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        HText(shown?.department ?: "Персона", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                        HText(shown?.name ?: name, size = Hall.S3, weight = FontWeight.Bold, display = true, maxLines = 2)
                        if (!shown?.dates.isNullOrBlank()) HText(shown!!.dates, size = Hall.S0, color = Hall.Text2)
                        if (!shown?.place.isNullOrBlank()) HText(shown!!.place, size = Hall.S0, color = Hall.Muted)
                        when {
                            failed -> EmptyBlock("Не удалось загрузить", "Попробуйте открыть страницу ещё раз.") { HButton("Повторить", { attempt++ }, primary = true) }
                            shown == null -> StatusLine("Загружаю фильмографию…")
                            shown.bio.isNotBlank() -> HText(shown.bio, size = Hall.S0, color = Hall.Text2, maxLines = 6)
                        }
                    }
                }
            }
            if (shown != null) {
                if (shown.upcoming.isNotEmpty()) item(key = "upcoming") { PosterShelf(TvRow("upcoming", "Скоро выйдут", "", shown.upcoming), nav::open) }
                if (shown.popular.isNotEmpty()) item(key = "popular") { PosterShelf(TvRow("popular", "Известные работы", "Самые популярные фильмы и сериалы", shown.popular), nav::open) }
                if (shown.recent.isNotEmpty()) item(key = "recent") { PosterShelf(TvRow("recent", "Последние роли", "Новые сверху", shown.recent), nav::open) }
                if (shown.all.size > shown.recent.size) item(key = "all") {
                    var open by remember { mutableStateOf(false) }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.padding(horizontal = Hall.Gutter), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            HText("Вся фильмография", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                            HButton(if (open) "Свернуть" else "Показать все: ${shown.all.size}", { open = !open })
                        }
                        if (open) shown.all.chunked(40).forEachIndexed { index, chunk -> PosterShelf(TvRow("all-$index", "", "", chunk), nav::open) }
                    }
                }
                if (shown.upcoming.isEmpty() && shown.recent.isEmpty()) item { EmptyBlock("Ролей нет", "TMDB не знает фильмов и сериалов с этим человеком.", Modifier.padding(horizontal = Hall.Gutter)) }
            }
        }
    }
}

/** Six steps, as the site's map (docs/DESIGN.md «Шкала оценок»): the number is always printed, the colour only helps. */
private val RATE_COLORS = listOf(
    Color(0xFF7D2F34) to Color(0xFFF5F6F7), Color(0xFFE0524A) to Color(0xFFF5F6F7), Color(0xFFEC8B39) to Color(0xFF1F0F02),
    Color(0xFFE3C04D) to Color(0xFF1D1704), Color(0xFF2FBF71) to Color(0xFF04140C), Color(0xFF0F8A4E) to Color(0xFFF5F6F7),
)
private val RATE_NAMES = listOf("Провал", "Плохо", "Средне", "Хорошо", "Отлично", "Шедевр")
private fun rateStep(rating: Double) = when { rating >= 9 -> 5; rating >= 8 -> 4; rating >= 7 -> 3; rating >= 6 -> 2; rating >= 5 -> 1; else -> 0 }

/** «Оценки серий»: a line with the best episode and seasons; the grid of every episode opens on demand. */
@Composable
private fun EpisodeRatingsMap(seasons: List<TvRatedSeason>, open: Boolean, onToggle: () -> Unit, onPick: (Int, Int) -> Unit) {
    val all = seasons.flatMap { season -> season.episodes.map { Triple(season.season, it.first, it) } }
    val trusted = all.filter { it.third.third >= 10 }.ifEmpty { all }
    val best = trusted.maxByOrNull { it.third.second }
    val averages = seasons.map { it.season to it.episodes.map { e -> e.second }.average() }
    val strongest = averages.maxByOrNull { it.second }
    val weakest = averages.minByOrNull { it.second }
    val facts = listOfNotNull(
        best?.let { "Лучшая серия — ${it.first} сезон, ${it.second} серия: ${String.format(Locale.US, "%.1f", it.third.second)}" },
        strongest?.takeIf { seasons.size > 1 }?.let { "сильнее всего ${it.first} сезон (${String.format(Locale.US, "%.1f", it.second)})" },
        weakest?.takeIf { seasons.size > 1 && it.first != strongest?.first }?.let { "слабее всего ${it.first} сезон (${String.format(Locale.US, "%.1f", it.second)})" },
    ).joinToString(", ")
    Column(Modifier.padding(horizontal = Hall.Gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HText("Оценки серий", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
        HText("$facts. Оценки TMDB.", size = Hall.S0, color = Hall.Text2, maxLines = 2)
        HButton(if (open) "Свернуть" else "Показать оценки серий", onToggle)
        if (!open) return@Column
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            RATE_NAMES.indices.reversed().forEach { step ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(RATE_COLORS[step].first))
                    Spacer(Modifier.width(6.dp))
                    HText(RATE_NAMES[step], size = Hall.S_1, color = Hall.Muted)
                }
            }
        }
        val rows = seasons.maxOf { season -> season.episodes.maxOf { it.first } }
        Row {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Box(Modifier.size(width = 30.dp, height = 24.dp))
                (1..rows).forEach { number -> Box(Modifier.size(width = 30.dp, height = 28.dp), contentAlignment = Alignment.CenterEnd) { HText("$number", size = Hall.S_1, color = Hall.Faint) } }
            }
            Spacer(Modifier.width(8.dp))
            CompositionLocalProvider(LocalBringIntoViewSpec provides TvRowScroll) {
                androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(seasons, key = { it.season }) { season ->
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.size(width = 44.dp, height = 24.dp), contentAlignment = Alignment.Center) { HText("С${season.season}", size = Hall.S_1, color = Hall.Muted, weight = FontWeight.SemiBold) }
                            (1..rows).forEach { number ->
                                val entry = season.episodes.firstOrNull { it.first == number }
                                if (entry == null) Box(Modifier.size(width = 44.dp, height = 28.dp))
                                else {
                                    val (fill, ink) = RATE_COLORS[rateStep(entry.second)]
                                    val (interaction, focused) = rememberFocused()
                                    Box(Modifier.size(width = 44.dp, height = 28.dp).hallFocus(RoundedCornerShape(5.dp), scale = 1.15f, interaction = interaction) { onPick(season.season, number) }
                                        .background(fill), contentAlignment = Alignment.Center) {
                                        HText(String.format(Locale.US, "%.1f", entry.second), size = Hall.S_1, color = ink, weight = if (focused) FontWeight.Bold else FontWeight.SemiBold)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
