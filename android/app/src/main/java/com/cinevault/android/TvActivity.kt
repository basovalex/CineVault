package com.cinevault.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.gestures.scrollBy
import kotlinx.coroutines.launch

class TvActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        }
        CineStore.init(this)
        setContent {
            // Every TV gets the same 960-wide layout, whatever its panel (1080p, 4K) and the density it reports.
            val screen = resources.displayMetrics.let { maxOf(it.widthPixels, it.heightPixels) }
            val system = androidx.compose.ui.platform.LocalDensity.current
            CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(screen / 960f, system.fontScale)) {
                CineVaultTheme { TvRoot() }
            }
        }
    }
}

private enum class TvSection(val title: String, val icon: ImageVector) {
    HOME("Главная", Icons.Default.Home), CATALOG("Каталог", Icons.Default.GridView),
    SEARCH("Поиск", Icons.Default.Search), MINE("Моё", Icons.Default.Favorite),
}

private sealed interface TvRoute {
    data class Detail(val title: CatalogTitle) : TvRoute
    data class Player(val request: PlayRequest) : TvRoute
}

/**
 * How a TV page follows the remote. A focused row that is already fully on screen stays where it is,
 * so the hero and the title card keep their titles in view; one that is not is brought to a third of
 * the way down, like the default. [pinned] holds the page still, for the hero while it is focused.
 */
@OptIn(ExperimentalFoundationApi::class)
private class TvPageScroll(private val pinned: () -> Boolean = { false }) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        if (pinned()) return 0f
        // A poster counts as in view only with its row's heading above and its title below it on screen too.
        val above = containerSize * 0.1f
        val below = containerSize * 0.18f
        if (offset >= above && offset + size + below <= containerSize) return 0f
        val target = if (size > containerSize * 0.7f) 0f else containerSize * 0.17f
        return offset - target
    }
}

@Composable
private fun TvRoot() {
    var section by rememberSaveable { mutableStateOf(TvSection.HOME) }
    // A genre tile on the home screen opens the catalog already narrowed to it.
    var catalogGenre by rememberSaveable { mutableStateOf("") }
    val stack = remember { mutableStateListOf<TvRoute>() }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.isEmpty() && section != TvSection.HOME) { section = TvSection.HOME }
    val open: (CatalogTitle) -> Unit = { stack.add(TvRoute.Detail(it)) }
    when (val top = stack.lastOrNull()) {
        is TvRoute.Player -> PlayerScreen(top.request, onBack = { stack.removeAt(stack.lastIndex) }, tvMode = true)
        is TvRoute.Detail -> TvDetail(top.title, onOpen = open) { stack.add(TvRoute.Player(it)) }
        null -> Box(Modifier.fillMaxSize().background(Cine.Background)) {
            // The page runs edge to edge behind a slim rail of icons; the rail opens with its labels
            // only while the remote is in it, so it never eats a band of the screen.
            // The home page runs under the rail (its artwork reaches the screen's edge); the others start after it.
            Box(Modifier.fillMaxSize().then(if (section == TvSection.HOME) Modifier else Modifier.padding(start = TvRailWidth))) {
                when (section) {
                    TvSection.HOME -> TvHome(open) { catalogGenre = it; section = TvSection.CATALOG }
                    TvSection.CATALOG -> TvCatalog(open, catalogGenre)
                    TvSection.SEARCH -> TvSearch(open)
                    TvSection.MINE -> TvMine(open)
                }
            }
            TvRail(section) { if (it == TvSection.CATALOG) catalogGenre = ""; section = it }
        }
    }
}

private val TvRailWidth = 84.dp

@Composable
private fun TvRail(section: TvSection, onSelect: (TvSection) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val width by androidx.compose.animation.core.animateDpAsState(if (open) 236.dp else TvRailWidth, label = "rail")
    Column(
        Modifier.width(width).fillMaxHeight().onFocusChanged { open = it.hasFocus }
            .background(if (open) Brush.horizontalGradient(0f to Cine.Surface, 0.85f to Cine.Surface, 1f to Cine.Surface.copy(alpha = 0.9f)) else Brush.horizontalGradient(listOf(Cine.Background.copy(alpha = 0.85f), Color.Transparent)))
            .padding(vertical = 32.dp, horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.padding(start = 8.dp, bottom = 28.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(10.dp)).background(TvGold), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Cine.Background)
            }
            if (open) { Spacer(Modifier.width(12.dp)); Text("CINEVAULT", color = TvGold, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 3.sp, maxLines = 1) }
        }
        TvSection.entries.forEach { item ->
            val selected = item == section
            val interaction = remember { MutableInteractionSource() }
            val focused by interaction.collectIsFocusedAsState()
            val tint = when { focused -> Cine.Background; selected -> TvGold; else -> Cine.Muted }
            Row(
                Modifier.fillMaxWidth().tvFocus(scale = 1.04f, interaction = interaction) { onSelect(item) }
                    .background(if (focused) Color.White else if (selected) Cine.Surface2 else Color.Transparent).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(item.icon, item.title, tint = tint)
                if (open) {
                    Spacer(Modifier.width(14.dp))
                    Text(item.title, color = if (focused) Cine.Background else if (selected) Color.White else Cine.Muted, fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                }
            }
        }
    }
}

/** A poster with its title and year below; it lights up when the remote is on it. */
@Composable
private fun TvPoster(title: CatalogTitle, onClick: () -> Unit, width: androidx.compose.ui.unit.Dp? = 156.dp, modifier: Modifier = Modifier) {
    // In a grid (no width) the poster fills its cell.
    Column(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(modifier.fillMaxWidth().aspectRatio(2f / 3f).tvFocus(RoundedCornerShape(Cine.PosterRadius), scale = 1.08f, glow = true, onClick = onClick)) {
            PosterImage(title.poster, title.title, Modifier.fillMaxSize())
            if (title.rating > 0) RatingBadge(title.rating, Modifier.padding(8.dp))
        }
        Text(title.title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val sub = listOfNotNull(title.year.takeIf { it > 0 }?.toString(), title.genres.firstOrNull()).joinToString(" · ")
        if (sub.isNotBlank()) Text(sub, color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "Продолжить просмотр": wide artwork with where the viewer stopped, as on Apple TV. */
@Composable
private fun TvWideCard(entry: WatchEntry, onClick: () -> Unit) {
    val title = entry.title.asCatalogTitle()
    Column(Modifier.width(268.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).tvFocus(RoundedCornerShape(Cine.PosterRadius), scale = 1.08f, glow = true, onClick = onClick)) {
            BackdropArt(title, Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.8f))))
            Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.PlayArrow, null, tint = Color.White, modifier = Modifier.size(24.dp))
                Spacer(Modifier.weight(1f))
                if (entry.duration > 0) Text("${tvClock(entry.position)} / ${tvClock(entry.duration)}", color = Color.White, fontSize = 13.sp)
            }
            if (entry.progress > 0f) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = 0.25f))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(entry.progress).background(TvGold))
            }
        }
        Text(title.title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val where = when {
            entry.episode != null -> listOfNotNull(entry.season?.let { "Сезон $it" }, "Серия ${entry.episode}").joinToString(" · ")
            title.isSeries -> "Сериал"
            else -> "Фильм"
        }
        Text(listOfNotNull(where, entry.translationName).joinToString(" · "), color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private val genreTints = listOf(
    Color(0xFF3A1C71) to Color(0xFF6A3093), Color(0xFF0F3443) to Color(0xFF34E89E), Color(0xFF5B1A1A) to Color(0xFFB33939),
    Color(0xFF1F2A44) to Color(0xFF3B6CB7), Color(0xFF42275A) to Color(0xFF734B6D), Color(0xFF134E5E) to Color(0xFF2F8F6F),
    Color(0xFF4B2C20) to Color(0xFFB0703C), Color(0xFF232526) to Color(0xFF606C88),
)

@Composable
private fun TvGenreTile(name: String, index: Int, onClick: () -> Unit) {
    val (from, to) = genreTints[index % genreTints.size]
    Box(
        Modifier.width(196.dp).height(96.dp).tvFocus(RoundedCornerShape(Cine.Radius), scale = 1.08f, glow = true, onClick = onClick)
            .background(Brush.linearGradient(listOf(from, to))),
        contentAlignment = Alignment.Center,
    ) {
        Text(name.replaceFirstChar { it.uppercase() }, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvHome(onOpen: (CatalogTitle) -> Unit, onGenre: (String) -> Unit) {
    LaunchedEffect(Unit) { CineStore.loadHome() }
    LaunchedEffect(Unit) { CineStore.loadFacets("movie") }
    val heroes = CineStore.homeHero
    var heroIndex by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val hero = heroes.getOrNull(heroIndex % heroes.size.coerceAtLeast(1))
    val heroFocus = remember { FocusRequester() }
    val list = rememberLazyListState()
    var heroFocused by remember { mutableStateOf(false) }
    val rowScroll = LocalBringIntoViewSpec.current
    val pageScroll = remember { TvPageScroll { heroFocused } }
    // Focus goes to the hero once, when the first one arrives; the carousel turning never takes it back.
    LaunchedEffect(heroes.isNotEmpty()) { if (heroes.isNotEmpty()) { delay(150); runCatching { heroFocus.requestFocus() } } }
    // The hero changes only while nobody is choosing in it: after a while away from it, never under the remote.
    LaunchedEffect(heroes.size, heroIndex, heroFocused) { if (heroes.size > 1 && !heroFocused) { delay(12_000); heroIndex = (heroIndex + 1) % heroes.size } }
    // On the hero's buttons the page is back at the top, so the title above them is always whole.
    LaunchedEffect(heroFocused) { if (heroFocused) list.animateScrollToItem(0) }
    val genres = CineStore.facets["movie"]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(10).map { it.key }
    CompositionLocalProvider(LocalBringIntoViewSpec provides pageScroll) {
    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 150.dp), verticalArrangement = Arrangement.spacedBy(30.dp)) {
        item {
            Box(Modifier.fillMaxWidth().height(430.dp)) {
                if (hero == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (CineStore.homeLoading) CircularProgressIndicator(color = TvGold)
                        else Text(CineStore.homeError ?: "", color = Cine.Muted, fontSize = 18.sp)
                    }
                } else {
                    androidx.compose.animation.Crossfade(hero, label = "hero") { shown -> BackdropArt(shown, Modifier.fillMaxSize()) }
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.5f to Cine.Background.copy(alpha = 0.55f), 1f to Color.Transparent)))
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Cine.Background)))
                    Column(Modifier.align(Alignment.BottomStart).padding(start = TvRailWidth + 48.dp, bottom = 34.dp).width(580.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        TitleLogo(hero, maxWidth = 400.dp, maxHeight = 120.dp, fontSize = 46)
                        MetaLine(hero, withAge = true, size = 17)
                        if (hero.description.isNotBlank()) Text(hero.description, color = Cine.TextSoft, fontSize = 17.sp, lineHeight = 24.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Row(Modifier.padding(top = 4.dp).onFocusChanged { heroFocused = it.hasFocus }, horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            TvButton("Смотреть", true, { onOpen(hero) }, heroFocus, icon = Icons.Default.PlayArrow)
                            TvButton(if (CineStore.isFavorite(hero.id)) "В избранном" else "В избранное", false, { CineStore.toggleFavorite(hero) },
                                icon = if (CineStore.isFavorite(hero.id)) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                                iconTint = if (CineStore.isFavorite(hero.id)) Cine.Accent else Color.White)
                        }
                    }
                    // Where the carousel is: one dot per title, the current one long.
                    if (heroes.size > 1) Row(Modifier.align(Alignment.BottomEnd).padding(end = 48.dp, bottom = 44.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        heroes.indices.forEach { index ->
                            val current = index == heroIndex % heroes.size
                            Box(Modifier.height(8.dp).width(if (current) 26.dp else 8.dp).clip(CircleShape).background(if (current) Color.White else Color.White.copy(alpha = 0.35f)))
                        }
                    }
                }
            }
        }
        val continueWatching = CineStore.recentlyWatched.take(12)
        if (continueWatching.isNotEmpty()) item {
            TvRowSection("Продолжить просмотр", rowScroll) {
                items(continueWatching, key = { it.title.id }) { entry -> TvWideCard(entry) { onOpen(entry.title.asCatalogTitle()) } }
            }
        }
        val shelves = CineStore.homeShelves
        shelves.take(2).forEach { shelf -> item(key = shelf.id) { TvShelf(shelf.title, shelf.items, onOpen, rowScroll) } }
        if (genres.isNotEmpty()) item(key = "genres") {
            TvRowSection("Жанры", rowScroll) {
                items(genres.size) { index -> TvGenreTile(genres[index], index) { onGenre(genres[index]) } }
            }
        }
        shelves.drop(2).forEach { shelf -> item(key = shelf.id) { TvShelf(shelf.title, shelf.items, onOpen, rowScroll) } }
    }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvRowSection(label: String, rowScroll: BringIntoViewSpec, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(label, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = TvRailWidth + 48.dp))
        CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
            LazyRow(contentPadding = PaddingValues(start = TvRailWidth + 48.dp, end = 48.dp, top = 12.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), content = content)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvShelf(label: String, titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit, rowScroll: BringIntoViewSpec) {
    TvRowSection(label, rowScroll) {
        items(titles, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
    }
}

/**
 * A grid of posters walked with the remote. Up and Down keep to the column the focus is in: left to itself,
 * a lazy grid sends Down into a row that is not laid out yet to that row's first poster.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvPosterGrid(
    titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit, modifier: Modifier = Modifier,
    state: androidx.compose.foundation.lazy.grid.LazyGridState = rememberLazyGridState(),
    header: androidx.compose.foundation.lazy.grid.LazyGridScope.() -> Unit = {},
    onFocusTitle: (CatalogTitle) -> Unit = {},
    footer: androidx.compose.foundation.lazy.grid.LazyGridScope.() -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val requesters = remember { mutableMapOf<String, FocusRequester>() }
    val gridSpec = remember { TvPageScroll() }
    CompositionLocalProvider(LocalBringIntoViewSpec provides gridSpec) {
    LazyVerticalGrid(
        GridCells.Fixed(5), modifier, state = state, contentPadding = PaddingValues(start = 8.dp, end = 24.dp, top = 12.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(22.dp), verticalArrangement = Arrangement.spacedBy(26.dp),
    ) {
        header()
        itemsIndexed(titles, key = { _, title -> title.id }) { index, title ->
            val requester = requesters.getOrPut(title.id) { FocusRequester() }
            TvPoster(title, { onOpen(title) }, width = null, modifier = Modifier.focusRequester(requester).onFocusChanged { if (it.isFocused) onFocusTitle(title) }.onPreviewKeyEvent { event ->
                val step = when (event.key) { Key.DirectionDown -> 1; Key.DirectionUp -> -1; else -> 0 }
                if (step == 0 || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val columns = (state.layoutInfo.visibleItemsInfo.maxOfOrNull { it.column } ?: 0) + 1
                val target = index + step * columns
                // Above the first row the chips take over; below the last poster there is nowhere to go.
                if (target < 0) return@onPreviewKeyEvent false
                val goal = titles.getOrNull(target.coerceAtMost(titles.lastIndex)) ?: return@onPreviewKeyEvent true
                if (target > titles.lastIndex && index / columns == titles.lastIndex / columns) return@onPreviewKeyEvent false
                scope.launch {
                    // A poster already laid out takes the focus at once and the page follows it in one smooth move;
                    // one that is not yet is brought to where that move would put it, then focused.
                    if (state.layoutInfo.visibleItemsInfo.none { it.key == goal.id }) {
                        val here = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == title.id }
                        val gridIndex = (here?.index ?: index) - index + titles.indexOf(goal)
                        state.animateScrollToItem(gridIndex, -(state.layoutInfo.viewportSize.height * 0.17f).toInt())
                    }
                    runCatching { requesters[goal.id]?.requestFocus() }
                }
                true
            })
        }
        footer()
    }
    }
}

@Composable
private fun TvPageTitle(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
        if (!subtitle.isNullOrBlank()) Text(subtitle, color = Cine.Muted, fontSize = 17.sp)
    }
}

@Composable
private fun TvCatalog(onOpen: (CatalogTitle) -> Unit, startGenre: String = "") {
    var kind by rememberSaveable { mutableStateOf("movie") }
    var genre by rememberSaveable(startGenre) { mutableStateOf(startGenre) }
    var sort by rememberSaveable { mutableStateOf("popular") }
    var picker by remember { mutableStateOf<String?>(null) }
    val grid = rememberLazyGridState()
    val feed = rememberCatalogFeed(kind, genre, grid, sort = sort)
    val firstPageDone = feed.items.isNotEmpty() || feed.error != null
    LaunchedEffect(firstPageDone, kind) { if (firstPageDone) CineStore.loadFacets(kind) }
    val genres = CineStore.facets[kind]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(30).map { it.key }
        .let { if (genre.isNotBlank() && genre !in it) listOf(genre) + it else it }
    var focused by remember { mutableStateOf<CatalogTitle?>(null) }
    Box(Modifier.fillMaxSize()) {
        TvAmbient(focused)
        // The heading and the filters scroll away with the posters: the whole page is one column to walk down.
        TvPosterGrid(feed.items, onOpen, Modifier.fillMaxSize().padding(start = 40.dp, end = 16.dp), state = grid, onFocusTitle = { focused = it }, header = {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(top = 32.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    TvPageTitle("Каталог")
                    // The site's filters, made for a remote: the kind, then a genre and an order from short lists.
                    Row(Modifier.padding(vertical = 4.dp, horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        TvChip("Фильмы", kind == "movie") { kind = "movie"; genre = "" }
                        TvChip("Сериалы", kind == "series") { kind = "series"; genre = "" }
                        Spacer(Modifier.width(10.dp))
                        TvSelect("Жанр", genre.ifBlank { "Все жанры" }.replaceFirstChar { it.uppercase() }, { picker = "genre" })
                        TvSelect("Сортировка", tvSorts.firstOrNull { it.first == sort }?.second ?: "Популярное", { picker = "sort" })
                    }
                }
            }
        }) {
            // The next page loads by itself as the focus nears the end of the grid.
            val failure = feed.error
            if (failure != null) item(span = { GridItemSpan(maxLineSpan) }) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    TvButton("Повторить", false, { feed.retry() })
                    Text(failure, color = Cine.Muted, fontSize = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            } else if (feed.loading) item(span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = TvGold) }
            } else if (feed.items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                Text("В этом разделе пока ничего нет.", color = Cine.Muted, fontSize = 18.sp)
            }
        }
    }
    when (picker) {
        "genre" -> {
            val options = listOf("") + genres.filter { it.isNotBlank() }
            TvPickerDialog("Жанр", options.map { it.ifBlank { "Все жанры" }.replaceFirstChar { c -> c.uppercase() } }, options.indexOf(genre), { genre = options[it]; picker = null }) { picker = null }
        }
        "sort" -> TvPickerDialog("Сортировка", tvSorts.map { it.second }, tvSorts.indexOfFirst { it.first == sort }, { sort = tvSorts[it].first; picker = null }) { picker = null }
    }
}

/** The website's catalog orders. */
private val tvSorts = listOf("popular" to "Популярное", "votes" to "Больше оценок", "rating" to "По рейтингу", "year" to "Сначала новые", "title" to "По алфавиту")

/** The focused title's artwork, faded in behind a grid page (as on Google TV): the page takes the film's mood. */
@Composable
private fun TvAmbient(title: CatalogTitle?) {
    // Only a title the remote rests on changes the picture: running past posters leaves it alone.
    var shown by remember { mutableStateOf(title) }
    LaunchedEffect(title) { delay(450); shown = title }
    androidx.compose.animation.Crossfade(shown, label = "ambient", animationSpec = androidx.compose.animation.core.tween(600)) { shown ->
        if (shown != null) Box(Modifier.fillMaxSize()) {
            BackdropArt(shown, Modifier.fillMaxWidth(0.72f).fillMaxHeight(0.8f).align(Alignment.TopEnd).graphicsLayer { alpha = 0.55f })
            Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.3f to Cine.Background, 0.75f to Cine.Background.copy(alpha = 0.35f), 1f to Color.Transparent)))
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.3f to Color.Transparent, 0.8f to Cine.Background)))
        }
    }
}

@Composable
private fun TvSearch(onOpen: (CatalogTitle) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var popular by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val field = remember { MutableInteractionSource() }
    val fieldFocused by field.collectIsFocusedAsState()
    LaunchedEffect(Unit) {
        popular = runCatching { CineVaultApi.catalog(1, "", "", "", "popular", "popular").items.take(24) }.getOrDefault(emptyList())
    }
    LaunchedEffect(query) {
        if (query.trim().length < 2) { results = emptyList(); searching = false; return@LaunchedEffect }
        searching = true
        delay(400)
        results = runCatching { CineVaultApi.catalog(1, query.trim(), "", "", "popular").items }.getOrDefault(emptyList())
        searching = false
        if (results.isNotEmpty()) { delay(1_500); CineStore.rememberSearch(query) }
    }
    val typed = query.trim().length >= 2
    // Voice search through the TV's own recognizer (the remote's microphone), where the TV has one.
    val context = androidx.compose.ui.platform.LocalContext.current
    val speech = remember {
        android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
            .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Скажите название фильма или сериала")
    }
    val canSpeak = remember { context.packageManager.queryIntentActivities(speech, 0).isNotEmpty() }
    val listen = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { query = it }
    }
    val recent = remember(typed) { CineStore.recentSearches }
    var focused by remember { mutableStateOf<CatalogTitle?>(null) }
    TvAmbient(focused)
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        TvPageTitle("Поиск")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        if (canSpeak) TvButton("Сказать", true, { runCatching { listen.launch(speech) } }, icon = Icons.Default.Mic)
        Row(
            Modifier.fillMaxWidth(0.6f).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface2)
                .border(BorderStroke(3.dp, if (fieldFocused) Color.White else Color.Transparent), RoundedCornerShape(Cine.Radius))
                .padding(horizontal = 18.dp, vertical = 15.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Search, null, tint = if (fieldFocused) Color.White else Cine.Muted)
            Spacer(Modifier.width(12.dp))
            Box(Modifier.weight(1f)) {
                if (query.isEmpty()) Text("Фильм, сериал или актёр", color = Cine.Muted, fontSize = 19.sp, maxLines = 1)
                BasicTextField(
                    query, { query = it }, singleLine = true, textStyle = TextStyle(color = Color.White, fontSize = 19.sp), cursorBrush = SolidColor(Cine.Accent),
                    interactionSource = field,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    // The field keeps the arrow keys for itself; Down and the keyboard's own button hand the focus to the results.
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); focusManager.moveFocus(FocusDirection.Down) }),
                    modifier = Modifier.fillMaxWidth().onPreviewKeyEvent { event ->
                        val down = event.key == Key.DirectionDown
                        if (down && event.type == KeyEventType.KeyDown) focusManager.moveFocus(FocusDirection.Down)
                        down
                    },
                )
            }
        }
        }
        if (!typed && recent.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 4.dp)) {
            items(recent) { text -> TvChip(text, false) { query = text } }
        }
        Text(
            when { !typed -> "Часто смотрят"; searching -> "Ищу…"; results.isEmpty() -> "Ничего не нашлось. Попробуйте другое название или имя актёра."; else -> "Найдено: ${results.size}" },
            color = Cine.Muted, fontSize = 17.sp,
        )
        TvPosterGrid(if (typed) results else popular, onOpen, onFocusTitle = { focused = it })
    }
}

/** "Моё": what was being watched (with where it stopped) and the favourites, apart. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvMine(onOpen: (CatalogTitle) -> Unit) {
    val rowScroll = LocalBringIntoViewSpec.current
    val pageScroll = remember { TvPageScroll() }
    val watched = CineStore.recentlyWatched
    val favorites = CineStore.favorites.map { it.asCatalogTitle() }
    CompositionLocalProvider(LocalBringIntoViewSpec provides pageScroll) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 32.dp, bottom = 150.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
            item { Box(Modifier.padding(start = 40.dp)) { TvPageTitle("Моё", "Хранится на этом телевизоре") } }
            if (watched.isNotEmpty()) item {
                TvMineRow("Продолжить и просмотренное", rowScroll) { items(watched, key = { it.title.id }) { entry -> TvWideCard(entry) { onOpen(entry.title.asCatalogTitle()) } } }
            }
            if (favorites.isNotEmpty()) item {
                TvMineRow("Избранное", rowScroll) { items(favorites, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) } }
            }
            if (watched.isEmpty() && favorites.isEmpty()) item {
                Column(Modifier.padding(start = 40.dp, top = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Default.FavoriteBorder, null, tint = Cine.Muted, modifier = Modifier.size(44.dp))
                    Text("Пока пусто", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    Text("Добавьте фильм в избранное или начните смотреть — он появится здесь.", color = Cine.Muted, fontSize = 18.sp)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvMineRow(label: String, rowScroll: BringIntoViewSpec, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(label, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 40.dp))
        CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
            LazyRow(contentPadding = PaddingValues(start = 40.dp, end = 48.dp, top = 12.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), content = content)
        }
    }
}

@Composable
private fun TvGrid(titles: List<CatalogTitle>, title: String, subtitle: String, onOpen: (CatalogTitle) -> Unit) {
    var focused by remember { mutableStateOf<CatalogTitle?>(null) }
    TvAmbient(focused)
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TvPageTitle(title, subtitle)
        if (titles.isEmpty()) {
            Column(Modifier.padding(top = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Default.FavoriteBorder, null, tint = Cine.Muted, modifier = Modifier.size(44.dp))
                Text("Пока пусто", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text("Добавьте фильм в избранное или начните смотреть — он появится здесь.", color = Cine.Muted, fontSize = 18.sp)
            }
        }
        TvPosterGrid(titles, onOpen, onFocusTitle = { focused = it })
    }
}

/** Dubbing first: "Дублированный" itself, then any dub, then the rest as listed. */
private fun voiceRank(name: String): Int = when {
    name.trim().equals("дублированный", ignoreCase = true) -> 0
    name.contains("дублир", ignoreCase = true) -> 1
    name.contains("дубляж", ignoreCase = true) -> 2
    else -> 3
}

private fun tvClock(seconds: Double): String {
    val total = seconds.toInt().coerceAtLeast(0)
    val h = total / 3600; val m = total % 3600 / 60; val sec = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

/** A way to watch a title: a provider's player, or CineVault's own stream. */
private data class TvWay(val id: String, val name: String, val provider: PlayerProvider? = null)

/** "1080p", "FHD 1080" → "1080"; "Авто" and anything without a height → null. */
private fun rungOf(quality: String): String? = Regex("(2160|1440|1080|720|480|360|240)").find(quality)?.value
    ?: if (quality.contains("4k", ignoreCase = true)) "2160" else null

// A rung the film lacks falls back to the best one below it once the player is up.
private val tvQualities = listOf("auto", "2160", "1440", "1080", "720", "480", "360").map { it to qualityLabel(it) }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TvDetail(initial: CatalogTitle, onOpen: (CatalogTitle) -> Unit, onPlay: (PlayRequest) -> Unit) {
    val rowScroll = LocalBringIntoViewSpec.current
    val list = rememberLazyListState()
    var topFocused by remember { mutableStateOf(false) }
    val pageScroll = remember { TvPageScroll { topFocused } }
    var item by remember(initial.id) { mutableStateOf(initial) }
    var providers by remember(initial.id) { mutableStateOf<List<PlayerProvider>>(emptyList()) }
    var loading by remember(initial.id) { mutableStateOf(true) }
    var similar by remember(initial.id) { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var wayId by remember(initial.id) { mutableStateOf<String?>(null) }
    var voiceName by remember(initial.id) { mutableStateOf<String?>(null) }
    var seasonChoice by remember(initial.id) { mutableStateOf<Int?>(null) }
    var episodeChoice by remember(initial.id) { mutableStateOf<Int?>(null) }
    var picker by remember { mutableStateOf<String?>(null) }
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(initial.id) {
        runCatching { CineVaultApi.title(initial.id) }.onSuccess { item = it }
        item.kinopoiskId?.let { id -> providers = runCatching { CineVaultApi.playerProviders(id) }.getOrDefault(emptyList()) }
        loading = false
        similar = runCatching { CineVaultApi.catalog(1, "", item.kind, item.genres.firstOrNull().orEmpty(), "popular").items.filter { it.id != item.id }.take(15) }.getOrDefault(emptyList())
    }
    // Back on the buttons, the page returns to the top: the title and the description are whole again.
    LaunchedEffect(topFocused) { if (topFocused) list.animateScrollToItem(0) }
    LaunchedEffect(loading) { if (!loading) { delay(150); runCatching { playFocus.requestFocus() } } }

    val last = CineStore.lastWatch(item.id)
    val ways = buildList {
        providers.forEach { if (it.translations.isNotEmpty() || it.embedUrl != null) add(TvWay(it.id, it.name, it)) }
        if (item.sources.any { !it.isEmbed }) add(TvWay("cinevault", "CineVault"))
    }
    val way = ways.firstOrNull { it.id == wayId } ?: ways.firstOrNull { it.id == last?.providerId } ?: ways.firstOrNull()
    val voices: List<String> = when {
        way?.id == "cinevault" -> item.sources.filter { !it.isEmbed }.map { it.voice.ifBlank { "Оригинал" } }.distinct()
        way?.provider?.translations?.isNotEmpty() == true -> way.provider.translations.map { it.name }
        else -> emptyList()
    }
    // Dubbing comes first ("Дублированный" itself before a studio's dub) unless the viewer chose otherwise here or last time.
    val voice = voices.firstOrNull { it == voiceName } ?: voices.firstOrNull { it == last?.translationName } ?: voices.minByOrNull(::voiceRank)
    // CineVault's own sources come one per voice and quality; the qualities offered are the voice's own.
    val voiceSources = if (way?.id == "cinevault") item.sources.filter { !it.isEmbed && it.voice.ifBlank { "Оригинал" } == voice } else emptyList()
    val sourceRungs = voiceSources.mapNotNull { rungOf(it.quality) }.distinct().sortedByDescending { it.toInt() }
    val qualityOptions = if (sourceRungs.size > 1) sourceRungs.map { it to qualityLabel(it) } else tvQualities
    // Season and episode can be chosen ahead only where the app can switch them for the viewer: Alloha.
    val episodeCounts = item.seasons
    val canPickEpisode = item.isSeries && way?.id == "alloha" && episodeCounts.isNotEmpty()
    val season = (seasonChoice ?: last?.season ?: 1).coerceIn(1, episodeCounts.size.coerceAtLeast(1))
    val episodeCount = episodeCounts.getOrNull(season - 1)?.takeIf { it > 0 } ?: 1
    val episode = (episodeChoice ?: last?.episode?.takeIf { season == (last.season ?: 1) } ?: 1).coerceIn(1, episodeCount)

    // "Продолжить" goes on from the second it was left at, in the same player and episode.
    fun resumeFor(s: Int?, e: Int?): Double? = last?.takeIf { it.providerId == way?.id && it.position > 30 && (!item.isSeries || (it.season == s && it.episode == e)) }?.position

    fun start(quality: String?, pickSeason: Int? = null, pickEpisode: Int? = null) {
        val chosen = way ?: return
        val atSeason = pickSeason ?: season
        val atEpisode = pickEpisode ?: episode
        when {
            chosen.id == "cinevault" -> {
                val sources = voiceSources.ifEmpty { item.sources.filter { !it.isEmbed } }
                val source = sources.firstOrNull { quality != null && rungOf(it.quality) == quality } ?: sources.firstOrNull() ?: return
                CineStore.recordOpened(item, "cinevault", voice)
                // A stream with rungs of its own (HLS) is held to the chosen one by the player itself.
                onPlay(PlayRequest(item, source = source, providerName = "CineVault", quality = quality?.takeIf { rungOf(source.quality) == null }, resumeAt = resumeFor(null, null)))
            }
            chosen.provider?.translations?.isNotEmpty() == true -> {
                val translation = chosen.provider.translations.firstOrNull { it.name == voice } ?: chosen.provider.translations.first()
                CineStore.recordOpened(item, chosen.id, translation.name, if (canPickEpisode) atSeason else null, if (canPickEpisode) atEpisode else null)
                onPlay(PlayRequest(item, embedUrl = translation.url, providerName = chosen.name,
                    season = if (canPickEpisode) atSeason else null, episode = if (canPickEpisode) atEpisode else null, quality = quality?.takeIf(String::isNotBlank),
                    voice = translation.name, resumeAt = resumeFor(if (canPickEpisode) atSeason else null, if (canPickEpisode) atEpisode else null)))
            }
            chosen.provider?.embedUrl != null -> {
                CineStore.recordOpened(item, chosen.id)
                onPlay(PlayRequest(item, embedUrl = chosen.provider.embedUrl, providerName = chosen.name, resumeAt = resumeFor(last?.season, last?.episode)))
            }
        }
    }

    Box(Modifier.fillMaxSize().background(Cine.Background)) {
        BackdropArt(item, Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.6f to Cine.Background.copy(alpha = 0.7f), 1f to Color.Transparent)))
        CompositionLocalProvider(LocalBringIntoViewSpec provides pageScroll) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(start = 56.dp, top = 48.dp, bottom = 40.dp, end = 40.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { TitleLogo(item, maxWidth = 420.dp, maxHeight = 110.dp, fontSize = 42) }
            item { MetaLine(item, withAge = true, size = 17) }
            if (item.description.isNotBlank()) item { Text(item.description, color = Cine.TextSoft, fontSize = 18.sp, lineHeight = 26.sp, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(680.dp)) }
            item {
                Column(Modifier.padding(top = 6.dp).onFocusChanged { topFocused = it.hasFocus }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        val resume = resumeFor(if (canPickEpisode) season else last?.season, if (canPickEpisode) episode else last?.episode)
                        when {
                            loading -> CircularProgressIndicator(color = TvGold)
                            ways.isEmpty() -> Text("Для этого тайтла сейчас нет плееров.", color = Cine.Muted, fontSize = 17.sp)
                            else -> TvButton(
                                when { resume != null -> "Продолжить · ${tvClock(resume)}"; last != null -> "Продолжить"; else -> "Смотреть" }, true,
                                // Only CineVault's own files have qualities to choose ahead; players offer theirs once they play.
                                { if (way?.id == "cinevault" && sourceRungs.size > 1) picker = "quality" else start(CineStore.preferredQuality.ifBlank { null }) },
                                playFocus, icon = Icons.Default.PlayArrow,
                            )
                        }
                        val favorite = CineStore.isFavorite(item.id)
                        TvButton(
                            if (favorite) "В избранном" else "В избранное", false, { CineStore.toggleFavorite(item) },
                            if (loading || ways.isEmpty()) playFocus else null,
                            icon = if (favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, iconTint = if (favorite) TvGold else Color.White,
                        )
                        if (ways.size > 1 || voices.size > 1) TvButton("Настройки просмотра", false, { picker = "settings" }, icon = Icons.Default.Tune)
                    }
                    val settingsLine = listOfNotNull(way?.name, voice).joinToString(" · ")
                    if (settingsLine.isNotBlank()) Text(settingsLine, color = Cine.Muted, fontSize = 15.sp)
                    if (item.isSeries && way != null && !canPickEpisode && way.id != "cinevault") {
                        Text(
                            if (way.id == "turbo") "Сезон, серию, озвучку и качество выберете в панели плеера." else "Сезон и серию в этом плеере выбирают внутри него.",
                            color = Cine.Muted, fontSize = 15.sp,
                        )
                    }
                }
            }
            // A series shows its episodes: OK starts the one chosen; the one stopped at is marked.
            if (canPickEpisode) item {
                Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Серии", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        if (episodeCounts.size > 1) episodeCounts.indices.forEach { index -> TvChip("Сезон ${index + 1}", season == index + 1) { seasonChoice = index + 1; episodeChoice = null } }
                    }
                    CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(start = 6.dp, end = 40.dp, top = 10.dp, bottom = 10.dp)) {
                            items((1..episodeCount).toList(), key = { "$season-$it" }) { number ->
                                val here = last?.season == season && last.episode == number
                                Column(Modifier.width(210.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).tvFocus(RoundedCornerShape(Cine.PosterRadius), scale = 1.07f, glow = true) {
                                        episodeChoice = number; start(CineStore.preferredQuality.ifBlank { null }, season, number)
                                    }) {
                                        BackdropArt(item, Modifier.fillMaxSize().graphicsLayer { alpha = if (here) 1f else 0.6f })
                                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.8f))))
                                        Text("$number", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.BottomStart).padding(10.dp))
                                        if (here) Text("Вы здесь", color = Cine.Background, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).background(Color.White, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 3.dp))
                                        if (here && last.progress > 0f) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = 0.25f))) {
                                            Box(Modifier.fillMaxHeight().fillMaxWidth(last.progress).background(TvGold))
                                        }
                                    }
                                    Text("Серия $number", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                                }
                            }
                        }
                    }
                }
            }
            if (similar.isNotEmpty()) item {
                Column(Modifier.padding(top = 12.dp).onPreviewKeyEvent { event ->
                    if (event.key == Key.DirectionUp) {
                        if (event.type == KeyEventType.KeyDown) runCatching { playFocus.requestFocus() }
                        true
                    } else false
                }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Похожие", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                    CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(20.dp), contentPadding = PaddingValues(start = 6.dp, end = 40.dp, top = 12.dp, bottom = 12.dp)) {
                            items(similar, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
                        }
                    }
                }
            }
        }
        }
    }

    when (picker) {
        "settings" -> TvPickerDialog("Настройки просмотра", listOf("Плеер · ${way?.name.orEmpty()}", "Озвучка · ${voice ?: "в плеере"}"), -1,
            { picker = if (it == 0) "way" else "voice" }) { picker = null }
        "way" -> TvPickerDialog("Плеер", ways.map { it.name }, ways.indexOf(way), { wayId = ways[it].id; voiceName = null; picker = null }) { picker = null }
        "voice" -> TvPickerDialog("Озвучка", voices, voices.indexOf(voice), { voiceName = voices[it]; picker = null }) { picker = null }
        "season" -> TvPickerDialog("Сезон", episodeCounts.indices.map { "Сезон ${it + 1} · ${episodeCounts[it]} сер." }, season - 1,
            { seasonChoice = it + 1; episodeChoice = 1; picker = null }) { picker = null }
        "episode" -> TvPickerDialog("Серия", (1..episodeCount).map { "Серия $it" }, episode - 1, { episodeChoice = it + 1; picker = null }) { picker = null }
        "quality" -> {
            val options = qualityOptions
            val preferred = options.indexOfFirst { it.first == CineStore.preferredQuality }.coerceAtLeast(0)
            TvPickerDialog("Качество", options.map { it.second }, preferred, { index ->
                picker = null
                CineStore.preferredQuality = options[index].first
                start(options[index].first)
            }) { picker = null }
        }
    }
}
