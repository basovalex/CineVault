@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.cinevault.android

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DynamicFeed
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SentimentSatisfied
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import org.json.JSONObject

/** The site's menu, in its order. */
enum class TvView(val title: String, val icon: ImageVector) {
    HOME("Для вас", Icons.Default.Home), FEED("Лента", Icons.Default.DynamicFeed), MOVIES("Фильмы", Icons.Default.Movie),
    SERIES("Сериалы", Icons.Default.Tv), CARTOONS("Мультфильмы", Icons.Default.SentimentSatisfied), ANIME("Аниме", Icons.Default.AutoAwesome),
    CATALOG("Каталог", Icons.Default.GridView), UPCOMING("Скоро", Icons.Default.Event), FAVORITES("Избранное", Icons.Default.Favorite),
    HISTORY("История", Icons.Default.History), SEARCH("Поиск", Icons.Default.Search), ACCOUNT("Аккаунт", Icons.Default.Person),
}

sealed interface TvRoute {
    data class Title(val item: TvItem, val season: Int = 0) : TvRoute
    data class Person(val id: Int, val name: String) : TvRoute
    data class Watch(val item: TvItem, val season: Int = 0, val episode: Int = 0) : TvRoute
    data class Play(val request: LampacPlay) : TvRoute
}

/** Where the remote was on a page, so coming back from a card puts it there again. */
object TvMemory {
    val focus = mutableMapOf<String, String>()
    var restore = false
    val rows = mutableMapOf<String, List<TvRow>>()
    val genreRows = mutableMapOf<String, MutableList<TvRow>>()
    val genreCursor = mutableMapOf<String, Int>()
}

@Composable
fun Modifier.remembered(page: String, key: String): Modifier {
    val requester = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        if (TvMemory.restore && TvMemory.focus[page] == key) {
            delay(60)
            if (runCatching { requester.requestFocus() }.isSuccess) TvMemory.restore = false
        }
    }
    return focusRequester(requester).onFocusChanged { if (it.hasFocus) TvMemory.focus[page] = key }
}

class TvNav {
    val stack = mutableStateListOf<TvRoute>()
    fun open(item: TvItem) { TvState.remember(item); stack.add(TvRoute.Title(item)) }
    fun push(route: TvRoute) { stack.add(route) }
    fun pop() { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex); if (stack.isEmpty()) TvMemory.restore = true }
}

@Composable
fun TvApp(startId: String? = null) {
    val nav = remember { TvNav() }
    // A card opened from outside (an intent's "open" extra, e.g. tmdb-tv-456).
    LaunchedEffect(startId) { startId?.let { id -> runCatching { Tmdb.title(id) }.getOrNull()?.let(nav::open) } }
    var view by rememberSaveable { mutableStateOf(TvView.HOME) }
    val holder = rememberSaveableStateHolder()
    LaunchedEffect(Unit) { TvState.sync() }
    BackHandler(enabled = nav.stack.isNotEmpty()) { nav.pop() }
    BackHandler(enabled = nav.stack.isEmpty() && view != TvView.HOME) { view = TvView.HOME }

    Box(Modifier.fillMaxSize().background(Hall.Bg)) {
        when (val top = nav.stack.lastOrNull()) {
            is TvRoute.Play -> TvLampacPlayer(top.request, onBack = { nav.pop() }, onChooseSource = {
                nav.pop()
                if (nav.stack.lastOrNull() !is TvRoute.Watch) nav.push(TvRoute.Watch(top.request.item, top.request.season, top.request.episode))
            })
            is TvRoute.Watch -> holder.SaveableStateProvider("watch-${top.item.id}") {
                TvWatch(top.item, top.season, top.episode, onClose = { nav.pop() }, onPlay = { request ->
                    nav.pop(); nav.push(TvRoute.Play(request))
                })
            }
            is TvRoute.Title -> holder.SaveableStateProvider("title-${top.item.id}") { TvTitleScreen(top.item, nav, top.season) }
            is TvRoute.Person -> holder.SaveableStateProvider("person-${top.id}") { TvPersonScreen(top.id, top.name, nav) }
            null -> Row(Modifier.fillMaxSize()) {
                TvRail(view) { view = it }
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    holder.SaveableStateProvider(view.name) {
                        when (view) {
                            TvView.HOME -> TvRowsPage("home", nav)
                            TvView.MOVIES -> TvRowsPage("movies", nav)
                            TvView.SERIES -> TvRowsPage("series", nav)
                            TvView.CARTOONS -> TvRowsPage("cartoons", nav)
                            TvView.ANIME -> TvRowsPage("anime", nav)
                            TvView.CATALOG -> TvCatalogPage(nav)
                            TvView.UPCOMING -> TvUpcomingPage(nav)
                            TvView.FEED -> TvFeedPage(nav)
                            TvView.FAVORITES -> TvFavoritesPage(nav)
                            TvView.HISTORY -> TvHistoryPage(nav)
                            TvView.SEARCH -> TvSearchPage(nav)
                            TvView.ACCOUNT -> TvAccountPage()
                        }
                    }
                }
            }
        }
    }
}

/** The site's header menu as a slim rail of icons; it opens with labels while the remote is in it. */
@Composable
private fun TvRail(view: TvView, onSelect: (TvView) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val width by animateDpAsState(if (open) 210.dp else Hall.RailWidth, label = "rail")
    Column(
        Modifier.width(width).fillMaxHeight().onFocusChanged { open = it.hasFocus }
            .background(if (open) Hall.Surface else Hall.Bg).padding(vertical = 18.dp, horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(Modifier.padding(start = 8.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(Hall.Accent), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Hall.OnAccent, modifier = Modifier.size(20.dp))
            }
            if (open) { Spacer(Modifier.width(10.dp)); HText("CineVault", size = Hall.S1, weight = FontWeight.Bold, display = true, maxLines = 1) }
        }
        TvView.entries.forEach { item ->
            val selected = item == view
            val (interaction, focused) = rememberFocused()
            Row(
                Modifier.fillMaxWidth().hallFocus(RoundedCornerShape(Hall.R), scale = 1.03f, interaction = interaction) { onSelect(item) }
                    .background(if (focused) Hall.Text else if (selected) Hall.Surface2 else Color.Transparent)
                    .padding(horizontal = 14.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(item.icon, item.title, tint = when { focused -> Hall.Bg; selected -> Hall.Accent; else -> Hall.Muted }, modifier = Modifier.size(22.dp))
                if (open) {
                    Spacer(Modifier.width(12.dp))
                    HText(item.title, size = Hall.S0, color = if (focused) Hall.Bg else if (selected) Hall.Text else Hall.Muted,
                        weight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Rows pages: «Для вас» and the sections

private fun episodeLine(record: TvProgress): String {
    val place = if (record.season > 0) "${record.season} сезон, ${record.episode} серия · " else ""
    return "$place${tvClock(record.position)} из ${tvClock(record.duration)}"
}

fun tvClock(seconds: Double): String {
    val total = seconds.toLong().coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** The focused title above the rows, as Lampa and the site's hero: its frame, name, facts and a few lines. */
@Composable
private fun FocusInfo(item: TvItem?, modifier: Modifier = Modifier) {
    Column(modifier.height(196.dp).padding(start = Hall.Gutter, end = 240.dp, top = 34.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (item == null) return@Column
        HText(item.title, size = Hall.S3, weight = FontWeight.Bold, display = true, maxLines = 1)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (item.rating > 0) Badge(String.format(java.util.Locale.US, "%.1f", item.rating), color = Hall.OnAccent, background = Hall.Accent)
            val facts = listOfNotNull(item.year.takeIf { it > 0 }?.toString(), if (item.isSeries) "Сериал" else "Фильм", item.genres.take(3).joinToString(", ").ifBlank { null })
            HText(facts.joinToString(" · "), size = Hall.S0, color = Hall.Text2, maxLines = 1)
        }
        if (item.overview.isNotBlank()) HText(item.overview, size = Hall.S0, color = Hall.Text2, maxLines = 3)
    }
}

@Composable
fun TvRowsPage(view: String, nav: TvNav) {
    var rows by remember { mutableStateOf(TvMemory.rows[view]) }
    val genreRows = remember { mutableStateListOf<TvRow>().also { it.addAll(TvMemory.genreRows[view].orEmpty()) } }
    var error by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var focused by remember { mutableStateOf<TvItem?>(null) }
    val list = rememberLazyListState()
    LaunchedEffect(attempt) {
        if (rows != null) return@LaunchedEffect
        error = false
        val loaded = runCatching { if (view == "home") Tmdb.homeRows() else Tmdb.sectionRows(view) }.getOrNull().orEmpty()
        if (loaded.isEmpty()) { error = true; return@LaunchedEffect }
        TvMemory.rows[view] = loaded
        rows = loaded
        if (focused == null) focused = loaded.first().items.firstOrNull()
    }
    // Endless genre rows: the next one comes while the last rows are in view.
    LaunchedEffect(rows) {
        if (rows == null) return@LaunchedEffect
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index to list.layoutInfo.totalItemsCount }
            .distinctUntilChanged().filter { (last, total) -> last != null && last >= total - 3 }
            .collect {
                while ((TvMemory.genreCursor[view] ?: 0) < Tmdb.genreRowCount(view)) {
                    val index = TvMemory.genreCursor[view] ?: 0
                    TvMemory.genreCursor[view] = index + 1
                    val next = runCatching { Tmdb.genreRow(view, index) }.getOrNull()?.takeIf { it.items.isNotEmpty() } ?: continue
                    genreRows.add(next)
                    TvMemory.genreRows.getOrPut(view) { mutableListOf() }.add(next)
                    break
                }
            }
    }
    val meta = Tmdb.SECTION_TITLES[view]
    val continueList = if (view == "home") TvState.continueWatching().mapNotNull { record -> TvState.known[record.titleId]?.let { it to record } }.take(12) else emptyList()
    Box(Modifier.fillMaxSize()) {
        Backdrop(Tmdb.image(focused?.backdrop.orEmpty(), "w1280"), strength = 0.5f)
        Column(Modifier.fillMaxSize()) {
            if (meta != null && focused == null) PageHeading(meta.first, meta.second, Modifier.padding(start = Hall.Gutter, top = 34.dp))
            FocusInfo(focused)
            CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll(top = 0.02f, bottom = 0.02f, target = 0.0f) }) {
                LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 60.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    if (meta != null) item(key = "section-title") {
                        HText(meta.first, Modifier.padding(start = Hall.Gutter), size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                    }
                    if (continueList.isNotEmpty()) item(key = "continue") {
                        TvShelf("Продолжить просмотр") {
                            items(continueList, key = { it.second.key }) { (item, record) ->
                                WideCard(Tmdb.image(item.backdrop.ifBlank { item.poster }, "w780"), item.title, episodeLine(record), {
                                    nav.push(TvRoute.Watch(item, record.season, record.episode))
                                }, Modifier.remembered(view, "continue/${record.key}").onFocusChanged { if (it.hasFocus) focused = item }, progress = record.share)
                            }
                        }
                    }
                    val all = rows.orEmpty() + genreRows
                    items(all, key = { it.key }) { row ->
                        TvShelf(row.title, row.description) {
                            items(row.items, key = { it.id }) { item ->
                                TvPosterCard(item, { nav.open(item) }, Modifier.remembered(view, "${row.key}/${item.id}"), onFocus = { focused = item })
                            }
                        }
                    }
                    if (rows == null) item(key = "loading") {
                        if (error) EmptyBlock("Подборки не загрузились", "TMDB не ответил. Проверьте интернет и повторите.", Modifier.padding(horizontal = Hall.Gutter)) {
                            HButton("Повторить", { attempt++ }, primary = true)
                        } else StatusLine("Загружаю подборки…", modifier = Modifier.padding(horizontal = Hall.Gutter))
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Grids: catalogue, «Скоро», saved lists

@Composable
fun TvPosterGrid(
    items: List<TvItem>, page: String, nav: TvNav, modifier: Modifier = Modifier,
    state: androidx.compose.foundation.lazy.grid.LazyGridState = rememberLazyGridState(), columns: Int = 6,
    badge: (TvItem) -> String? = { null }, onFocus: (TvItem) -> Unit = {}, footer: LazyGridScope.() -> Unit = {}, header: LazyGridScope.() -> Unit = {},
) {
    CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll() }) {
        LazyVerticalGrid(GridCells.Fixed(columns), modifier, state = state,
            contentPadding = PaddingValues(start = Hall.Gutter, end = Hall.Gutter, top = 12.dp, bottom = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            header()
            items(items.size, key = { items[it].id }) { index ->
                val item = items[index]
                Box {
                    TvPosterCard(item, { nav.open(item) }, Modifier.remembered(page, item.id), width = null, onFocus = { onFocus(item) },
                        progress = TvState.latest(item.id)?.takeIf { !it.completed && it.real }?.share ?: 0.0)
                    badge(item)?.let { Badge(it, Modifier.align(Alignment.TopEnd).padding(6.dp), color = Hall.OnAccent, background = Hall.Accent) }
                }
            }
            footer()
        }
    }
}

private fun LazyGridScope.fullWidth(key: String, content: @Composable () -> Unit) {
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }
}

@Composable
private fun ChipRow(content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    CompositionLocalProvider(LocalBringIntoViewSpec provides TvRowScroll) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp), content = content)
    }
}

/** «Каталог»: the grid with collections, kinds, sorts and genres; TMDB pages keep coming, up to 500. */
@Composable
fun TvCatalogPage(nav: TvNav) {
    var collection by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf("") }
    var sort by rememberSaveable { mutableStateOf("now") }
    var genre by rememberSaveable { mutableStateOf("") }
    TvDiscoverGrid(
        page = "catalog", key = "$collection|$kind|$sort|$genre", nav = nav,
        kinds = when (kind) { "movie" -> listOf("movie"); "tv" -> listOf("tv"); else -> listOf("movie", "tv") },
        load = { kinds, number -> Tmdb.catalogPage(kinds, number, genre, sort, collection) },
        header = {
            fullWidth("heading") { PageHeading("Каталог", "Фильмы и сериалы TMDB: жанры, подборки и сортировки.") }
            fullWidth("collections") {
                ChipRow {
                    items(Tmdb.CATALOG_COLLECTIONS) { (value, label) -> HChip(label, collection == value, { collection = value }) }
                    item { Spacer(Modifier.width(18.dp)) }
                    items(listOf("" to "Всё", "movie" to "Фильмы", "tv" to "Сериалы")) { (value, label) -> HChip(label, kind == value, { kind = value }) }
                    item { Spacer(Modifier.width(18.dp)) }
                    items(Tmdb.CATALOG_SORTS) { (value, label) -> HChip(label, sort == value && collection.isBlank(), { sort = value; collection = "" }) }
                }
            }
            fullWidth("genres") {
                ChipRow {
                    item { HChip("Все жанры", genre.isBlank(), { genre = "" }) }
                    items(Tmdb.CATALOG_GENRES) { name -> HChip(name.replaceFirstChar(Char::uppercase), genre == name, { genre = name }) }
                }
            }
        },
    )
}

/** «Скоро»: films still to come, the most awaited or the nearest first. */
@Composable
fun TvUpcomingPage(nav: TvNav) {
    var order by rememberSaveable { mutableStateOf("await") }
    TvDiscoverGrid(
        page = "upcoming", key = order, nav = nav, kinds = listOf("movie"),
        load = { kinds, number -> Tmdb.catalogPage(kinds, number, "", "now", "", upcoming = order) },
        badge = { item -> item.premiere.takeIf(String::isNotBlank)?.let(::russianDate) },
        header = {
            fullWidth("heading") { PageHeading("Скоро", "Ожидаемые премьеры, отдельно от фильмов, которые уже вышли.") }
            fullWidth("order") {
                ChipRow { items(listOf("await" to "Самые ожидаемые", "soon" to "Ближайшие")) { (value, label) -> HChip(label, order == value, { order = value }) } }
            }
        },
    )
}

@Composable
private fun TvDiscoverGrid(
    page: String, key: String, nav: TvNav, kinds: List<String>, load: suspend (List<String>, Int) -> Pair<List<TvItem>, Int>,
    header: LazyGridScope.() -> Unit, badge: (TvItem) -> String? = { null },
) {
    val items = remember(key) { mutableStateListOf<TvItem>() }
    var pages by remember(key) { mutableIntStateOf(1) }
    var loaded by remember(key) { mutableIntStateOf(0) }
    var busy by remember(key) { mutableStateOf(false) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    fun more() {
        if (busy || loaded >= pages) return
        busy = true
        scope.launch {
            runCatching { load(kinds, loaded + 1) }
                .onSuccess { (found, total) -> val known = items.map { it.id }.toSet(); items.addAll(found.filter { it.id !in known }); pages = total; loaded++; error = null }
                .onFailure { error = it.message ?: "ошибка" }
            busy = false
        }
    }
    LaunchedEffect(key) { more() }
    LaunchedEffect(key, items.size) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .filter { it >= grid.layoutInfo.totalItemsCount - 14 }.collect { if (items.isNotEmpty()) more() }
    }
    TvPosterGrid(items, page, nav, Modifier.fillMaxSize(), grid, badge = badge, header = {
        fullWidth("top-space") { Spacer(Modifier.height(18.dp)) }
        header()
    }, footer = {
        fullWidth("status") {
            when {
                error != null -> EmptyBlock("Каталог не загрузился", "TMDB не ответил: ${error}.") { HButton("Повторить", { error = null; more() }, primary = true) }
                busy -> StatusLine(if (items.isEmpty()) "Загружаю каталог…" else "Загружаю ещё…")
                items.isEmpty() && loaded > 0 -> EmptyBlock("Ничего не подошло", "С такими фильтрами ничего нет.")
                loaded >= pages && items.isNotEmpty() -> HText("Это всё: ${countWord(items.size, "карточка", "карточки", "карточек")}", size = Hall.S_1, color = Hall.Muted)
            }
        }
    })
}

/** Cards of saved ids: what this TV already knows draws at once, the rest is asked from TMDB. */
@Composable
private fun rememberSavedItems(ids: List<String>): List<TvItem> {
    LaunchedEffect(ids) {
        ids.filter { TvState.known[it] == null && Tmdb.parseId(it) != null }.take(60).forEach { id ->
            runCatching { Tmdb.title(id) }.getOrNull()?.let(TvState::remember)
        }
    }
    return ids.mapNotNull { TvState.known[it] }
}

@Composable
fun TvFavoritesPage(nav: TvNav) {
    val ids = TvState.favorites.toList().reversed()
    val items = rememberSavedItems(ids)
    if (ids.isEmpty()) {
        Column(Modifier.padding(Hall.Gutter), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            PageHeading("Избранное", "Фильмы и сериалы, отложенные на потом.")
            EmptyBlock("Здесь пока пусто", "Нажмите «В избранное» на странице фильма или сериала — он появится здесь.")
        }
        return
    }
    TvPosterGrid(items, "favorites", nav, Modifier.fillMaxSize(), header = {
        fullWidth("heading") { Column(Modifier.padding(top = 18.dp)) { PageHeading("Избранное", "${countWord(ids.size, "тайтл", "тайтла", "тайтлов")} · ${if (TvState.user != null) "общие с аккаунтом" else "на этом телевизоре"}") } }
    })
}

/** «История»: last watched first, «Продолжить» from the same second, and removal that reaches every device. */
@Composable
fun TvHistoryPage(nav: TvNav) {
    val ids = TvState.history.toList()
    val items = rememberSavedItems(ids)
    val list = rememberLazyListState()
    Column(Modifier.fillMaxSize()) {
        PageHeading("История просмотра", "Последнее просмотренное — сверху. Продолжить можно с того же места.", Modifier.padding(start = Hall.Gutter, top = 34.dp, bottom = 12.dp))
        if (ids.isEmpty()) {
            EmptyBlock("Здесь пока пусто", "Начните смотреть фильм или сериал — он появится в истории.", Modifier.padding(horizontal = Hall.Gutter))
            return
        }
        CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll() }) {
            LazyColumn(state = list, contentPadding = PaddingValues(start = Hall.Gutter, end = Hall.Gutter, bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(items, key = { it.id }) { item ->
                    val record = TvState.latest(item.id)
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(150.dp).height(84.dp).clip(RoundedCornerShape(Hall.R)).background(Hall.Surface2)) {
                            TvImage(Tmdb.image(item.backdrop.ifBlank { item.poster }, "w300"), item.title, Modifier.fillMaxSize(), titleSize = Hall.S_1)
                            if (record != null && !record.completed) ProgressBar(record.share, Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(6.dp))
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            HText(item.title, size = Hall.S1, weight = FontWeight.SemiBold, display = true, maxLines = 1)
                            val note = when {
                                record == null -> listOfNotNull(item.year.takeIf { it > 0 }?.toString(), if (item.isSeries) "Сериал" else "Фильм").joinToString(" · ")
                                record.completed -> "${if (record.season > 0) "${record.season} сезон, ${record.episode} серия · " else ""}Просмотрено"
                                else -> "Остановились: ${episodeLine(record)}"
                            }
                            HText(note, size = Hall.S0, color = Hall.Muted, maxLines = 1)
                        }
                        HButton(if (record != null && !record.completed && record.real) "Продолжить" else "Смотреть", {
                            nav.push(TvRoute.Watch(item, record?.season ?: 0, record?.episode ?: 0))
                        }, Modifier.remembered("history", item.id), primary = true, icon = Icons.Default.PlayArrow)
                        HButton("Карточка", { nav.open(item) })
                        HButton("Удалить", { TvState.removeHistory(item.id) }, icon = Icons.Default.Close)
                    }
                }
                if (items.size < ids.size) item { StatusLine("Загружаю карточки…") }
            }
        }
    }
}

// ---------------------------------------------------------------- Search

@Composable
fun TvField(value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, password: Boolean = false,
            focus: FocusRequester? = null, onDone: () -> Unit = {}) {
    var focused by remember { mutableStateOf(false) }
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    BasicTextField(
        value, onChange, modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier).onFocusChanged { focused = it.isFocused }
            .onPreviewKeyEvent { event ->
                // A text field keeps the arrows to itself; on a remote, up and down must leave it.
                val direction = when (event.key) {
                    Key.DirectionDown -> androidx.compose.ui.focus.FocusDirection.Down
                    Key.DirectionUp -> androidx.compose.ui.focus.FocusDirection.Up
                    else -> null
                }
                if (direction == null) return@onPreviewKeyEvent false
                if (event.type == KeyEventType.KeyDown) focusManager.moveFocus(direction)
                true
            }
            .clip(RoundedCornerShape(Hall.RLg)).background(if (focused) Hall.Surface3 else Hall.Surface)
            .border(if (focused) 3.dp else 1.dp, if (focused) Color.White else Hall.Line, RoundedCornerShape(Hall.RLg))
            .padding(horizontal = 18.dp, vertical = 13.dp),
        singleLine = true, cursorBrush = SolidColor(Hall.Accent),
        textStyle = TextStyle(color = Hall.Text, fontSize = Hall.S1, fontFamily = Hall.Body),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else KeyboardType.Text, imeAction = if (password) ImeAction.Done else ImeAction.Search),
        keyboardActions = KeyboardActions(onAny = { onDone() }),
        decorationBox = { inner ->
            Box { if (value.isEmpty()) HText(placeholder, size = Hall.S1, color = Hall.Faint, maxLines = 1); inner() }
        },
    )
}

@Composable
fun TvSearchPage(nav: TvNav) {
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<TvItem>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var searched by rememberSaveable { mutableStateOf("") }
    val field = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (results.isEmpty() && !TvMemory.restore) { delay(150); runCatching { field.requestFocus() } } }
    LaunchedEffect(query) {
        val text = query.trim()
        if (text.length < 2) { results = emptyList(); searched = ""; return@LaunchedEffect }
        delay(450)
        busy = true
        val first = runCatching { Tmdb.search(text, 1) }.getOrNull()
        results = first?.first.orEmpty()
        searched = text
        busy = false
        val pages = first?.second ?: 1
        for (number in 2..minOf(pages, 3)) {
            val more = runCatching { Tmdb.search(text, number).first }.getOrNull().orEmpty()
            val known = results.map { it.id }.toSet()
            results = results + more.filter { it.id !in known }
        }
    }
    TvPosterGrid(results, "search", nav, Modifier.fillMaxSize(), header = {
        fullWidth("heading") {
            Column(Modifier.padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                PageHeading("Поиск", "По названию на русском или в оригинале. «Ведьмак 3» найдёт сам сериал.")
                TvField(query, { query = it }, "Название фильма или сериала", Modifier.fillMaxWidth(0.7f), focus = field)
                when {
                    busy -> StatusLine("Ищу «${query.trim()}»…")
                    searched.isNotBlank() && results.isEmpty() -> EmptyBlock("Ничего не нашлось", "По запросу «$searched» ничего нет. Попробуйте оригинальное название.")
                    searched.isNotBlank() -> HText("Найдено по запросу «$searched»", size = Hall.S0, color = Hall.Muted)
                }
            }
        }
    })
}

// ---------------------------------------------------------------- Feed

private data class FeedEntry(val type: String, val item: TvItem, val season: Int, val episode: Int, val name: String, val still: String,
                             val quality: String, val time: Long, val label: String)

private val FEED_FILTERS = listOf("all" to "Всё", "subs" to "Подписки", "episode" to "Новые серии", "uhd" to "В высоком качестве", "now" to "Новинки", "now_playing" to "Сейчас смотрят")
private val QUALITY_NAMES = mapOf("4k" to "4K", "webdl" to "WEB-DL", "webrip" to "WEBRip", "ts" to "Экранка", "camrip" to "Экранка", "bdrip" to "BDRip", "hdrip" to "HDRip")

private fun cubEpisode(entry: JSONObject): Triple<Int, Int, Pair<String, String>> {
    val data = entry.optJSONObject("data") ?: JSONObject()
    val text = data.opt("episode")?.toString().orEmpty()
    fun pick(key: String) = Regex("['\"]$key['\"]:\\s*(?:'([^']*)'|\"([^\"]*)\"|(\\d+))").find(text)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }.orEmpty()
    val hash = Regex("s(\\d+);e(\\d+)").find(entry.optString("hash"))
    val season = pick("season_number").toIntOrNull() ?: hash?.groupValues?.get(1)?.toIntOrNull() ?: 0
    val episode = pick("episode_number").toIntOrNull() ?: hash?.groupValues?.get(2)?.toIntOrNull() ?: 0
    return Triple(season, episode, pick("name").replace(Regex("^(Эпизод|Серия|Episode)\\s*\\d+$", RegexOption.IGNORE_CASE), "") to pick("still_path"))
}

private object TvFeed {
    var entries: List<FeedEntry>? = null
    var at = 0L

    suspend fun load(): List<FeedEntry> {
        entries?.takeIf { System.currentTimeMillis() - at < 10 * 60_000 }?.let { return it }
        var json: JSONObject? = null
        for (url in listOf("${TvNet.server}/cub/api/feed/all", "https://cub.red/api/feed/all")) {
            json = runCatching { JSONObject(TvNet.get(url, 10_000)) }.getOrNull()
            if (json != null) break
        }
        val list = json?.optJSONArray("result").objects().filter { it.optJSONObject("data")?.optInt("id", 0) != 0 && it.optJSONObject("data")?.optBoolean("adult") != true }
            .map { entry ->
                val data = JSONObject(entry.optJSONObject("data")!!.toString())
                data.remove("genres")
                val tv = entry.optString("card_type") == "tv"
                data.put("media_type", if (tv) "tv" else "movie")
                val item = Tmdb.item(data, if (tv) "tv" else "movie")
                val type = entry.optString("type")
                val (season, episode, extra) = if (type == "episode") cubEpisode(entry) else Triple(0, 0, "" to "")
                FeedEntry(type, item, season, episode, extra.first, extra.second, QUALITY_NAMES[entry.optJSONObject("data")?.optString("release_quality")?.lowercase()].orEmpty(),
                    entry.optLong("time"), mapOf("episode" to "Новая серия", "uhd" to "В высоком качестве", "now" to "Новинка", "now_playing" to "Сейчас смотрят")[type] ?: "Новое")
            }
        if (json == null) throw IllegalStateException("Лента сейчас недоступна")
        entries = list
        at = System.currentTimeMillis()
        return list
    }

    /** Subscribed series: the last episode out and the next one, from TMDB. */
    suspend fun subscriptions(): List<FeedEntry> = TvState.subscriptions.toList().mapNotNull { id ->
        val (kind, tmdbId) = Tmdb.parseId(id) ?: return@mapNotNull null
        if (kind != "series") return@mapNotNull null
        val raw = runCatching { Tmdb.get("tv/$tmdbId?language=ru-RU") }.getOrNull() ?: return@mapNotNull null
        val item = Tmdb.item(raw, "tv")
        val last = raw.optJSONObject("last_episode_to_air") ?: return@mapNotNull null
        val airDate = last.optString("air_date")
        FeedEntry("subs", item, last.optInt("season_number"), last.optInt("episode_number"), last.optString("name"),
            last.optString("still_path").takeIf { it != "null" }.orEmpty(), "",
            runCatching { java.time.LocalDate.parse(airDate).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli() }.getOrDefault(0L), "Ваша подписка")
    }.sortedByDescending { it.time }
}

private fun timeAgo(ms: Long): String {
    val minutes = maxOf(1, ((System.currentTimeMillis() - ms) / 60_000).toInt())
    if (minutes < 60) return "$minutes мин назад"
    val hours = Math.round(minutes / 60.0).toInt()
    if (hours < 24) return "$hours ч назад"
    val days = Math.round(hours / 24.0).toInt()
    return if (days == 1) "вчера" else "$days дн назад"
}

@Composable
fun TvFeedPage(nav: TvNav) {
    var filter by rememberSaveable { mutableStateOf("all") }
    var entries by remember { mutableStateOf(TvFeed.entries) }
    var subs by remember { mutableStateOf<List<FeedEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) { runCatching { TvFeed.load() }.onSuccess { entries = it; error = null }.onFailure { error = it.message } }
    LaunchedEffect(filter) { if (filter == "subs" && subs == null) subs = TvFeed.subscriptions() }
    val shown = when (filter) {
        "subs" -> subs
        "all" -> entries
        else -> entries?.filter { it.type == filter }
    }
    val grid = rememberLazyGridState()
    CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll() }) {
        LazyVerticalGrid(GridCells.Fixed(3), Modifier.fillMaxSize(), grid, contentPadding = PaddingValues(start = Hall.Gutter, end = Hall.Gutter, top = 30.dp, bottom = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            fullWidth("heading") { PageHeading("Лента", "Новые серии, релизы в высоком качестве и новинки — как в Lampa.") }
            fullWidth("filters") { ChipRow { items(FEED_FILTERS) { (value, label) -> HChip(label, filter == value, { filter = value }) } } }
            when {
                error != null && filter != "subs" -> fullWidth("error") { EmptyBlock("Лента не загрузилась", error.orEmpty()) { HButton("Повторить", { attempt++ }, primary = true) } }
                shown == null -> fullWidth("loading") { StatusLine(if (filter == "subs") "Проверяю новые серии подписок…" else "Загружаю ленту…") }
                shown.isEmpty() -> fullWidth("empty") {
                    EmptyBlock(if (filter == "subs") "Подписок пока нет" else "Здесь пусто",
                        if (filter == "subs") "Нажмите «Напомнить» на странице сериала — здесь появятся его новые серии." else "Загляните позже.")
                }
                else -> items(shown.size, key = { "${shown[it].type}-${shown[it].item.id}-${shown[it].season}-${shown[it].episode}-$it" }) { index ->
                    val entry = shown[index]
                    val line = if (entry.season > 0) "Сезон ${entry.season} · Серия ${entry.episode}${if (entry.name.isNotBlank()) " · ${entry.name}" else ""}"
                    else listOfNotNull(entry.item.year.takeIf { it > 0 }?.toString(), entry.item.genres.take(2).joinToString(", ").ifBlank { null }).joinToString(" · ")
                    val image = if (entry.still.isNotBlank()) Tmdb.image(entry.still, "w780") else Tmdb.image(entry.item.backdrop.ifBlank { entry.item.poster }, "w780")
                    val kicker = listOf(entry.label, entry.quality, if (entry.type == "subs") russianDate(java.time.Instant.ofEpochMilli(entry.time).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()) else timeAgo(entry.time))
                        .filter(String::isNotBlank).joinToString(" · ")
                    WideCard(image, entry.item.title, line, {
                        TvState.remember(entry.item)
                        if (entry.season > 0) nav.push(TvRoute.Title(entry.item, entry.season)) else nav.open(entry.item)
                    }, Modifier.remembered("feed", "$filter/$index"), width = 260.dp, kicker = kicker)
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Account

@Composable
fun TvAccountPage() {
    val scope = rememberCoroutineScope()
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(start = Hall.Gutter, top = 34.dp, end = Hall.Gutter).animateContentSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PageHeading("Аккаунт", "Избранное, история и «Продолжить» общие с сайтом и телефоном, когда вы вошли.")
        val user = TvState.user
        if (user != null) {
            Column(Modifier.clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                HText(user, size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                HText(if (TvState.syncing) "Синхронизирую…" else "Избранное: ${TvState.favorites.size} · История: ${TvState.history.size} · Подписки: ${TvState.subscriptions.size}",
                    size = Hall.S0, color = Hall.Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    HButton("Синхронизировать", { scope.launch { TvState.sync(force = true); message = "Готово" } }, primary = true, busy = TvState.syncing)
                    HButton("Выйти", { scope.launch { TvState.logout(); message = "Вы вышли. Списки остались на телевизоре." } })
                }
            }
        } else {
            Column(Modifier.fillMaxWidth(0.6f).clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                HText("Войти в CineVault", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                TvField(username, { username = it }, "Логин", Modifier.fillMaxWidth())
                TvField(password, { password = it }, "Пароль", Modifier.fillMaxWidth(), password = true)
                HButton("Войти", {
                    busy = true; message = ""
                    scope.launch {
                        runCatching { TvState.login(username.trim(), password) }
                            .onSuccess { message = "Вы вошли. Списки объединены с аккаунтом."; password = "" }
                            .onFailure { message = it.message ?: "Не получилось войти" }
                        busy = false
                    }
                }, primary = true, busy = busy, enabled = username.isNotBlank() && password.isNotBlank())
                HText("Без входа избранное и история хранятся только на этом телевизоре.", size = Hall.S_1, color = Hall.Muted)
            }
        }
        if (message.isNotBlank()) HText(message, size = Hall.S0, color = Hall.Text2)
    }
}

@Composable
fun BoxedBackground(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Hall.Bg, Hall.Surface)))) { content() }
}
