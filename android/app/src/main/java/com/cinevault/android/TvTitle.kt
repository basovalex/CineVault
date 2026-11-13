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
    val play = remember { FocusRequester() }
    val list = rememberLazyListState()

    LaunchedEffect(initial.id) {
        if (!item.detailed) runCatching { Tmdb.title(initial.id) }.onSuccess { item = it; TvState.remember(it) }.onFailure { failed = true }
        extras = runCatching { Tmdb.extras(item) }.getOrDefault(emptyList())
    }
    LaunchedEffect(Unit) { delay(120); if (!TvMemory.restore) runCatching { play.requestFocus() } }
    val seasons = item.seasons
    LaunchedEffect(seasons) { if (season == 0 || seasons.none { it.number == season }) seasons.firstOrNull()?.let { season = it.number } }
    LaunchedEffect(item.tmdbId, season, item.isSeries) {
        if (!item.isSeries || season == 0) return@LaunchedEffect
        episodes = null
        episodes = runCatching { Tmdb.episodes(item.tmdbId, season) }.getOrDefault(emptyList())
    }

    val today = Tmdb.day()
    val unreleased = item.premiere.isNotBlank() && item.premiere > today
    val resuming = record != null && !record.completed && record.real
    val playLabel = when {
        resuming && record!!.season > 0 -> "Продолжить · ${record.season} сезон, ${record.episode} серия"
        resuming -> "Продолжить с ${tvClock(record!!.position)}"
        record?.completed == true && record.season > 0 -> "Смотреть дальше"
        else -> "Смотреть"
    }

    Box(Modifier.fillMaxSize().background(Hall.Bg)) {
        Backdrop(Tmdb.image(item.backdrop, "w1280"), strength = 0.75f)
        CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll(top = 0.05f, bottom = 0.05f, target = 0.08f) }, LocalScrollTop provides { list.animateScrollToItem(0) }) {
            LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(bottom = 60.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                item(key = "hero") {
                    Column(Modifier.fillMaxWidth().scrollTopOnFocus().padding(start = Hall.Gutter, end = 280.dp, top = 70.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        HText(if (item.isSeries) "Сериал" else "Фильм", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                        HText(item.title, size = Hall.STitle, weight = FontWeight.Bold, display = true, maxLines = 2, lineHeight = Hall.STitle * 1.08f)
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
                        if (item.overview.isNotBlank()) HText(item.overview, size = Hall.S0, color = Hall.Text2, maxLines = 4)
                        else if (failed) HText("Описание не загрузилось. Смотреть всё равно можно.", size = Hall.S0, color = Hall.Muted)
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            HButton(playLabel, {
                                val next = record?.takeIf { it.completed && it.season > 0 }?.let { done ->
                                    val count = seasons.firstOrNull { it.number == done.season }?.episodes ?: 0
                                    if (done.episode < count) done.season to done.episode + 1 else seasons.firstOrNull { it.number > done.season }?.let { it.number to 1 }
                                }
                                when {
                                    next != null -> nav.push(TvRoute.Watch(item, next.first, next.second))
                                    resuming -> nav.push(TvRoute.Watch(item, record!!.season, record.episode))
                                    else -> nav.push(TvRoute.Watch(item))
                                }
                            }, Modifier.remembered("title-${item.id}", "play"), primary = true, icon = Icons.Default.PlayArrow, focus = play, big = true,
                                note = if (resuming && record!!.season > 0) "с ${tvClock(record.position)}" else null)
                            val favorite = TvState.isFavorite(item.id)
                            HButton(if (favorite) "В избранном" else "В избранное", { TvState.toggleFavorite(item) },
                                Modifier.remembered("title-${item.id}", "fav"), icon = if (favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, big = true)
                            if (item.isSeries || unreleased) {
                                val on = TvState.isSubscribed(item.id)
                                HButton(if (on) "Напомню" else "Напомнить", { TvState.toggleSubscription(item) },
                                    icon = if (on) Icons.Default.Notifications else Icons.Default.NotificationsNone, big = true)
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
                                    kicker = "${episode.number} серия", progress = progress?.takeIf { !it.completed }?.share ?: 0.0)
                            }
                        }
                    }
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
                if (shown.recent.isNotEmpty()) item(key = "recent") { PosterShelf(TvRow("recent", "Последние роли", "Новые сверху", shown.recent), nav::open) }
                if (shown.upcoming.isEmpty() && shown.recent.isEmpty()) item { EmptyBlock("Ролей нет", "TMDB не знает фильмов и сериалов с этим человеком.", Modifier.padding(horizontal = Hall.Gutter)) }
            }
        }
    }
}
