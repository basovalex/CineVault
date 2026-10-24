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
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.foundation.gestures.animateScrollBy
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
        setContent { CineVaultTheme { TvRoot() } }
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
        if (offset >= 0f && offset + size <= containerSize) return 0f
        val target = if (size > containerSize * 0.7f) 0f else containerSize * 0.3f
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
            Box(Modifier.fillMaxSize().padding(start = TvRailWidth)) {
                when (section) {
                    TvSection.HOME -> TvHome(open) { catalogGenre = it; section = TvSection.CATALOG }
                    TvSection.CATALOG -> TvCatalog(open, catalogGenre)
                    TvSection.SEARCH -> TvSearch(open)
                    TvSection.MINE -> TvGrid(CineStore.favorites.map { it.asCatalogTitle() } + CineStore.recentlyWatched.map { it.title.asCatalogTitle() }.filter { w -> CineStore.favorites.none { it.id == w.id } }, "Моё", "Избранное и история с этого устройства", open)
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
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(10.dp)).background(Cine.Button), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Color.White)
            }
            if (open) { Spacer(Modifier.width(12.dp)); Text("CineVault", color = Color.White, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, maxLines = 1) }
        }
        TvSection.entries.forEach { item ->
            val selected = item == section
            val interaction = remember { MutableInteractionSource() }
            val focused by interaction.collectIsFocusedAsState()
            val tint = when { focused -> Cine.Background; selected -> Cine.Accent; else -> Cine.Muted }
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
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.75f))))
            Icon(Icons.Default.PlayArrow, null, tint = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(10.dp).size(28.dp))
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
    // The hero turns to the next title every few seconds, as on Apple TV and Netflix.
    LaunchedEffect(heroes.size, heroIndex) { if (heroes.size > 1) { delay(9_000); heroIndex = (heroIndex + 1) % heroes.size } }
    // On the hero's buttons the page is back at the top, so the title above them is always whole.
    LaunchedEffect(heroFocused) { if (heroFocused) list.animateScrollToItem(0) }
    val genres = CineStore.facets["movie"]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(10).map { it.key }
    CompositionLocalProvider(LocalBringIntoViewSpec provides pageScroll) {
    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(30.dp)) {
        item {
            Box(Modifier.fillMaxWidth().height(430.dp)) {
                if (hero == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (CineStore.homeLoading) CircularProgressIndicator(color = Cine.Accent)
                        else Text(CineStore.homeError ?: "", color = Cine.Muted, fontSize = 18.sp)
                    }
                } else {
                    androidx.compose.animation.Crossfade(hero, label = "hero") { shown -> BackdropArt(shown, Modifier.fillMaxSize()) }
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.5f to Cine.Background.copy(alpha = 0.55f), 1f to Color.Transparent)))
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Cine.Background)))
                    Column(Modifier.align(Alignment.BottomStart).padding(start = 48.dp, bottom = 34.dp).width(580.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
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
        Text(label, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 48.dp))
        CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
            LazyRow(contentPadding = PaddingValues(horizontal = 48.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), content = content)
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
@Composable
private fun TvPosterGrid(
    titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit, modifier: Modifier = Modifier,
    state: androidx.compose.foundation.lazy.grid.LazyGridState = rememberLazyGridState(),
    footer: androidx.compose.foundation.lazy.grid.LazyGridScope.() -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val requesters = remember { mutableMapOf<String, FocusRequester>() }
    LazyVerticalGrid(
        GridCells.Fixed(5), modifier, state = state, contentPadding = PaddingValues(start = 8.dp, end = 24.dp, top = 12.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(22.dp), verticalArrangement = Arrangement.spacedBy(26.dp),
    ) {
        itemsIndexed(titles, key = { _, title -> title.id }) { index, title ->
            val requester = requesters.getOrPut(title.id) { FocusRequester() }
            TvPoster(title, { onOpen(title) }, width = null, modifier = Modifier.focusRequester(requester).onPreviewKeyEvent { event ->
                val step = when (event.key) { Key.DirectionDown -> 1; Key.DirectionUp -> -1; else -> 0 }
                if (step == 0 || event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val columns = (state.layoutInfo.visibleItemsInfo.maxOfOrNull { it.column } ?: 0) + 1
                val target = index + step * columns
                // Above the first row the chips take over; below the last poster there is nowhere to go.
                if (target < 0) return@onPreviewKeyEvent false
                val goal = titles.getOrNull(target.coerceAtMost(titles.lastIndex)) ?: return@onPreviewKeyEvent true
                if (target > titles.lastIndex && index / columns == titles.lastIndex / columns) return@onPreviewKeyEvent false
                scope.launch {
                    val shown = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == goal.id }
                    val viewport = state.layoutInfo.viewportEndOffset
                    if (shown == null || shown.offset.y < 0 || shown.offset.y + shown.size.height > viewport) {
                        val row = state.layoutInfo.visibleItemsInfo.firstOrNull()?.let { it.size.height + 26 } ?: 300
                        state.animateScrollBy((step * row).toFloat())
                    }
                    androidx.compose.runtime.withFrameNanos { }
                    runCatching { requesters[goal.id]?.requestFocus() }
                }
                true
            })
        }
        footer()
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
    val grid = rememberLazyGridState()
    val feed = rememberCatalogFeed(kind, genre, grid)
    val firstPageDone = feed.items.isNotEmpty() || feed.error != null
    LaunchedEffect(firstPageDone, kind) { if (firstPageDone) CineStore.loadFacets(kind) }
    val genres = CineStore.facets[kind]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(14).map { it.key }
        .let { if (genre.isNotBlank() && genre !in it) listOf(genre) + it else it }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        TvPageTitle("Каталог", if (genre.isBlank()) "Сначала популярное" else genre.replaceFirstChar { it.uppercase() })
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp)) {
            item { TvChip("Фильмы", kind == "movie") { kind = "movie"; genre = "" } }
            item { TvChip("Сериалы", kind == "series") { kind = "series"; genre = "" } }
            item { Spacer(Modifier.width(18.dp)) }
            item { TvChip("Все жанры", genre.isEmpty()) { genre = "" } }
            items(genres) { name -> TvChip(name, genre == name) { genre = name } }
        }
        // The next page loads by itself as the focus nears the end of the grid.
        TvPosterGrid(feed.items, onOpen, state = grid) {
            val failure = feed.error
            if (failure != null) item(span = { GridItemSpan(maxLineSpan) }) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    TvButton("Повторить", false, { feed.retry() })
                    Text(failure, color = Cine.Muted, fontSize = 17.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            } else if (feed.loading) item(span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Cine.Accent) }
            } else if (feed.items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                Text("В этом разделе пока ничего нет.", color = Cine.Muted, fontSize = 18.sp)
            }
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
    }
    val typed = query.trim().length >= 2
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        TvPageTitle("Поиск")
        Row(
            Modifier.fillMaxWidth(0.62f).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface2)
                .border(BorderStroke(3.dp, if (fieldFocused) Color.White else Color.Transparent), RoundedCornerShape(Cine.Radius))
                .padding(horizontal = 18.dp, vertical = 15.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Search, null, tint = if (fieldFocused) Color.White else Cine.Muted)
            Spacer(Modifier.width(12.dp))
            Box(Modifier.weight(1f)) {
                if (query.isEmpty()) Text("Название фильма, сериала или актёра", color = Cine.Muted, fontSize = 19.sp)
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
        Text(
            when { !typed -> "Часто смотрят"; searching -> "Ищу…"; results.isEmpty() -> "Ничего не нашлось. Попробуйте другое название или имя актёра."; else -> "Найдено: ${results.size}" },
            color = Cine.Muted, fontSize = 17.sp,
        )
        TvPosterGrid(if (typed) results else popular, onOpen)
    }
}

@Composable
private fun TvGrid(titles: List<CatalogTitle>, title: String, subtitle: String, onOpen: (CatalogTitle) -> Unit) {
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TvPageTitle(title, subtitle)
        if (titles.isEmpty()) {
            Column(Modifier.padding(top = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Default.FavoriteBorder, null, tint = Cine.Muted, modifier = Modifier.size(44.dp))
                Text("Пока пусто", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text("Добавьте фильм в избранное или начните смотреть — он появится здесь.", color = Cine.Muted, fontSize = 18.sp)
            }
        }
        TvPosterGrid(titles, onOpen)
    }
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
    val voice = voices.firstOrNull { it == voiceName } ?: voices.firstOrNull { it == last?.translationName } ?: voices.firstOrNull()
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

    fun start(quality: String?) {
        val chosen = way ?: return
        when {
            chosen.id == "cinevault" -> {
                val sources = voiceSources.ifEmpty { item.sources.filter { !it.isEmbed } }
                val source = sources.firstOrNull { quality != null && rungOf(it.quality) == quality } ?: sources.firstOrNull() ?: return
                CineStore.recordOpened(item, "cinevault", voice)
                // A stream with rungs of its own (HLS) is held to the chosen one by the player itself.
                onPlay(PlayRequest(item, source = source, providerName = "CineVault", quality = quality?.takeIf { rungOf(source.quality) == null }))
            }
            chosen.provider?.translations?.isNotEmpty() == true -> {
                val translation = chosen.provider.translations.firstOrNull { it.name == voice } ?: chosen.provider.translations.first()
                CineStore.recordOpened(item, chosen.id, translation.name, if (canPickEpisode) season else null, if (canPickEpisode) episode else null)
                onPlay(PlayRequest(item, embedUrl = translation.url, providerName = chosen.name,
                    season = if (canPickEpisode) season else null, episode = if (canPickEpisode) episode else null, quality = quality?.takeIf(String::isNotBlank)))
            }
            chosen.provider?.embedUrl != null -> {
                CineStore.recordOpened(item, chosen.id)
                onPlay(PlayRequest(item, embedUrl = chosen.provider.embedUrl, providerName = chosen.name))
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
                Column(Modifier.onFocusChanged { topFocused = it.hasFocus }, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        when {
                            loading -> CircularProgressIndicator(color = Cine.Accent)
                            ways.isEmpty() -> Text("Для этого тайтла сейчас нет плееров.", color = Cine.Muted, fontSize = 17.sp)
                            else -> TvButton(
                                if (last != null) "Продолжить" else "Смотреть", true,
                                { if (way?.id == "alloha" || way?.id == "cinevault") picker = "quality" else start(null) }, playFocus, icon = Icons.Default.PlayArrow,
                            )
                        }
                        val favorite = CineStore.isFavorite(item.id)
                        TvButton(
                            if (favorite) "В избранном" else "В избранное", false, { CineStore.toggleFavorite(item) },
                            if (loading || ways.isEmpty()) playFocus else null,
                            icon = if (favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, iconTint = if (favorite) Cine.Accent else Color.White,
                        )
                    }
                    if (ways.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvSelect("Плеер", way?.name.orEmpty(), { picker = "way" }, enabled = ways.size > 1)
                        TvSelect("Озвучка", voice ?: "Выбирается в плеере", { picker = "voice" }, enabled = voices.size > 1)
                        if (canPickEpisode) {
                            TvSelect("Сезон", "Сезон $season", { picker = "season" }, enabled = episodeCounts.size > 1)
                            TvSelect("Серия", "Серия $episode", { picker = "episode" }, enabled = episodeCount > 1)
                        }
                    }
                    if (item.isSeries && way != null && !canPickEpisode && way.id != "cinevault") {
                        Text(
                            if (way.id == "turbo") "Сезон, серию, озвучку и качество выберете в панели плеера (↓ во время просмотра)."
                            else "Сезон и серию в этом плеере выбирают внутри него.",
                            color = Cine.Muted, fontSize = 15.sp,
                        )
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
