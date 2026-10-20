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

class TvActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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

/** Remote focus: the focused element grows a little and gets a white outline. */
@Composable
private fun Modifier.tvFocus(shape: RoundedCornerShape = RoundedCornerShape(12.dp), onClick: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    return this
        .graphicsLayer { val scale = if (focused) 1.06f else 1f; scaleX = scale; scaleY = scale }
        .border(if (focused) BorderStroke(3.dp, Color.White) else BorderStroke(0.dp, Color.Transparent), shape)
        .clip(shape)
        .clickable(interactionSource = interaction, indication = null, onClick = onClick)
}

@Composable
private fun TvRoot() {
    var section by rememberSaveable { mutableStateOf(TvSection.HOME) }
    val stack = remember { mutableStateListOf<TvRoute>() }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }
    val open: (CatalogTitle) -> Unit = { stack.add(TvRoute.Detail(it)) }
    when (val top = stack.lastOrNull()) {
        is TvRoute.Player -> PlayerScreen(top.request, onBack = { stack.removeAt(stack.lastIndex) }, tvMode = true)
        is TvRoute.Detail -> TvDetail(top.title, onOpen = open) { stack.add(TvRoute.Player(it)) }
        null -> Row(Modifier.fillMaxSize().background(Cine.Background)) {
            Column(
                Modifier.width(196.dp).fillMaxHeight().background(Cine.Surface).padding(vertical = 32.dp, horizontal = 14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.padding(start = 8.dp, bottom = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(Cine.Button), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.PlayArrow, null, tint = Color.White)
                    }
                    Spacer(Modifier.width(10.dp))
                    Text("CineVault", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                }
                TvSection.entries.forEach { item ->
                    val selected = item == section
                    Row(
                        Modifier.fillMaxWidth().tvFocus { section = item }.background(if (selected) Cine.Surface2 else Color.Transparent).padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(item.icon, null, tint = if (selected) Cine.Accent else Cine.Muted)
                        Spacer(Modifier.width(12.dp))
                        Text(item.title, color = if (selected) Color.White else Cine.Muted, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                when (section) {
                    TvSection.HOME -> TvHome(open)
                    TvSection.CATALOG -> TvCatalog(open)
                    TvSection.SEARCH -> TvSearch(open)
                    TvSection.MINE -> TvGrid(CineStore.favorites.map { it.asCatalogTitle() } + CineStore.recentlyWatched.map { it.title.asCatalogTitle() }.filter { w -> CineStore.favorites.none { it.id == w.id } }, "Моё", "Избранное и история с этого устройства", open)
                }
            }
        }
    }
}

@Composable
private fun TvPoster(title: CatalogTitle, onClick: () -> Unit, width: androidx.compose.ui.unit.Dp = 150.dp) {
    Column(Modifier.width(width), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).tvFocus(RoundedCornerShape(Cine.PosterRadius), onClick)) {
            PosterImage(title.poster, title.title, Modifier.fillMaxSize())
            if (title.rating > 0) RatingBadge(title.rating, Modifier.padding(8.dp))
        }
        Text(title.title, color = Color.White, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun TvButton(text: String, primary: Boolean, onClick: () -> Unit, focus: FocusRequester? = null) {
    Row(
        Modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier).tvFocus(RoundedCornerShape(Cine.Radius), onClick)
            .background(if (primary) Cine.Button else Cine.Surface2).padding(horizontal = 26.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (primary) { Icon(Icons.Default.PlayArrow, null, tint = Color.White); Spacer(Modifier.width(8.dp)) }
        Text(text, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun TvHome(onOpen: (CatalogTitle) -> Unit) {
    LaunchedEffect(Unit) { CineStore.loadHome() }
    val hero = CineStore.homeHero.firstOrNull()
    val heroFocus = remember { FocusRequester() }
    LaunchedEffect(hero?.id) { if (hero != null) { delay(150); runCatching { heroFocus.requestFocus() } } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
        item {
            Box(Modifier.fillMaxWidth().height(380.dp)) {
                if (hero == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (CineStore.homeLoading) CircularProgressIndicator(color = Cine.Accent)
                        else Text(CineStore.homeError ?: "", color = Cine.Muted)
                    }
                } else {
                    BackdropArt(hero, Modifier.fillMaxSize())
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.55f to Cine.Background.copy(alpha = 0.4f), 1f to Color.Transparent)))
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.6f to Color.Transparent, 1f to Cine.Background)))
                    Column(Modifier.align(Alignment.BottomStart).padding(start = 48.dp, bottom = 36.dp).width(560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        TitleLogo(hero, maxWidth = 380.dp, maxHeight = 110.dp, fontSize = 44)
                        MetaLine(hero)
                        if (hero.description.isNotBlank()) Text(hero.description, color = Cine.TextSoft, fontSize = 16.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            TvButton("Смотреть", true, { onOpen(hero) }, heroFocus)
                            TvButton(if (CineStore.isFavorite(hero.id)) "В избранном" else "В избранное", false, { CineStore.toggleFavorite(hero) })
                        }
                    }
                }
            }
        }
        val continueWatching = CineStore.recentlyWatched.take(12).map { it.title.asCatalogTitle() }
        if (continueWatching.isNotEmpty()) item { TvShelf("Продолжить просмотр", continueWatching, onOpen) }
        items(CineStore.homeShelves, key = { it.id }) { shelf -> TvShelf(shelf.title, shelf.items, onOpen) }
    }
}

@Composable
private fun TvShelf(label: String, titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(label, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 48.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            items(titles, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
        }
    }
}

@Composable
private fun TvCatalog(onOpen: (CatalogTitle) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("movie") }
    var genre by rememberSaveable { mutableStateOf("") }
    var items by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var page by remember { mutableStateOf(0) }
    var pages by remember { mutableStateOf(1) }
    var loading by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { CineStore.loadFacets("movie"); CineStore.loadFacets("series") }
    LaunchedEffect(kind, genre) {
        items = emptyList(); page = 0; pages = 1
        loading = true
        runCatching { CineVaultApi.catalog(1, "", kind, genre, "rating") }.onSuccess { items = it.items; page = it.page; pages = it.pages }
        loading = false
    }
    val genres = CineStore.facets[kind]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(12).map { it.key }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 32.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text("Каталог", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.SemiBold)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            item { TvChip("Фильмы", kind == "movie") { kind = "movie"; genre = "" } }
            item { TvChip("Сериалы", kind == "series") { kind = "series"; genre = "" } }
            item { Spacer(Modifier.width(18.dp)) }
            item { TvChip("Все жанры", genre.isEmpty()) { genre = "" } }
            items(genres) { name -> TvChip(name, genre == name) { genre = name } }
        }
        LazyVerticalGrid(GridCells.Adaptive(150.dp), contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            items(items, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
            if (page < pages && !loading) item {
                Box(Modifier.width(150.dp).aspectRatio(2f / 3f).tvFocus(RoundedCornerShape(Cine.PosterRadius)) {
                    loading = true
                }.background(Cine.Surface2), contentAlignment = Alignment.Center) { Text("Ещё", color = Color.White, fontSize = 18.sp) }
                LaunchedEffect(loading) {
                    if (!loading) return@LaunchedEffect
                    runCatching { CineVaultApi.catalog(page + 1, "", kind, genre, "rating") }.onSuccess { items = (items + it.items).distinctBy { t -> t.id }; page = it.page; pages = it.pages }
                    loading = false
                }
            }
        }
    }
}

@Composable
private fun TvChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text, color = if (selected) Cine.Background else Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.tvFocus(RoundedCornerShape(50), onClick).background(if (selected) Color.White else Cine.Surface2).padding(horizontal = 18.dp, vertical = 10.dp),
    )
}

@Composable
private fun TvSearch(onOpen: (CatalogTitle) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    LaunchedEffect(query) {
        if (query.trim().length < 2) { results = emptyList(); return@LaunchedEffect }
        delay(400)
        results = runCatching { CineVaultApi.catalog(1, query.trim(), "", "", "popular").items }.getOrDefault(emptyList())
    }
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 32.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text("Поиск", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.SemiBold)
        Box(Modifier.fillMaxWidth(0.6f).clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface2).padding(horizontal = 18.dp, vertical = 14.dp)) {
            if (query.isEmpty()) Text("Название фильма, сериала или актёра", color = Cine.Muted, fontSize = 18.sp)
            BasicTextField(query, { query = it }, singleLine = true, textStyle = TextStyle(color = Color.White, fontSize = 18.sp), cursorBrush = SolidColor(Cine.Accent), modifier = Modifier.fillMaxWidth())
        }
        LazyVerticalGrid(GridCells.Adaptive(150.dp), contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            items(results, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
        }
    }
}

@Composable
private fun TvGrid(titles: List<CatalogTitle>, title: String, subtitle: String, onOpen: (CatalogTitle) -> Unit) {
    Column(Modifier.fillMaxSize().padding(start = 40.dp, top = 32.dp, end = 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.SemiBold)
        Text(subtitle, color = Cine.Muted, fontSize = 16.sp)
        if (titles.isEmpty()) Text("Пока пусто: добавьте фильм в избранное или начните смотреть.", color = Cine.Muted, fontSize = 18.sp, modifier = Modifier.padding(top = 24.dp))
        LazyVerticalGrid(GridCells.Adaptive(150.dp), contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            items(titles, key = { it.id }) { item -> TvPoster(item, { onOpen(item) }) }
        }
    }
}

@Composable
private fun TvDetail(initial: CatalogTitle, onOpen: (CatalogTitle) -> Unit, onPlay: (PlayRequest) -> Unit) {
    var item by remember(initial.id) { mutableStateOf(initial) }
    var providers by remember(initial.id) { mutableStateOf<List<PlayerProvider>>(emptyList()) }
    var loading by remember(initial.id) { mutableStateOf(true) }
    var similar by remember(initial.id) { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    val firstFocus = remember { FocusRequester() }
    LaunchedEffect(initial.id) {
        runCatching { CineVaultApi.title(initial.id) }.onSuccess { item = it }
        item.kinopoiskId?.let { id -> providers = runCatching { CineVaultApi.playerProviders(id) }.getOrDefault(emptyList()) }
        loading = false
        similar = runCatching { CineVaultApi.catalog(1, "", item.kind, item.genres.firstOrNull().orEmpty(), "rating").items.filter { it.id != item.id }.take(15) }.getOrDefault(emptyList())
    }
    // One button per way to watch; Alloha lists its voices, the rest choose inside the player.
    val options = buildList {
        providers.forEach { provider ->
            if (provider.translations.isNotEmpty()) provider.translations.take(6).forEach { t ->
                add("${provider.name} · ${t.name}" to { CineStore.recordOpened(item, provider.id, t.name); onPlay(PlayRequest(item, embedUrl = t.url, providerName = provider.name)) })
            } else if (provider.embedUrl != null) {
                add(provider.name to { CineStore.recordOpened(item, provider.id); onPlay(PlayRequest(item, embedUrl = provider.embedUrl, providerName = provider.name)) })
            }
        }
        item.sources.filter { !it.isEmbed }.take(3).forEach { source ->
            add("CineVault · ${source.label.ifBlank { "Оригинал" }}" to { CineStore.recordOpened(item, "cinevault"); onPlay(PlayRequest(item, source = source, providerName = "CineVault")) })
        }
    }
    LaunchedEffect(options.size) { if (options.isNotEmpty()) { delay(150); runCatching { firstFocus.requestFocus() } } }
    Box(Modifier.fillMaxSize().background(Cine.Background)) {
        BackdropArt(item, Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Cine.Background, 0.6f to Cine.Background.copy(alpha = 0.6f), 1f to Color.Transparent)))
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 56.dp, top = 56.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { TitleLogo(item, maxWidth = 420.dp, maxHeight = 120.dp, fontSize = 44) }
            item { MetaLine(item, withAge = true) }
            if (item.description.isNotBlank()) item { Text(item.description, color = Cine.TextSoft, fontSize = 17.sp, maxLines = 5, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(640.dp)) }
            item {
                if (loading) CircularProgressIndicator(color = Cine.Accent)
                else if (options.isEmpty()) Text("Для этого тайтла сейчас нет плееров.", color = Cine.Muted, fontSize = 17.sp)
                else LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(end = 40.dp, top = 6.dp, bottom = 6.dp)) {
                    items(options.size) { index ->
                        val (label, action) = options[index]
                        TvButton(label, index == 0, action, if (index == 0) firstFocus else null)
                    }
                }
            }
            item { TvButton(if (CineStore.isFavorite(item.id)) "В избранном" else "В избранное", false, { CineStore.toggleFavorite(item) }) }
            if (similar.isNotEmpty()) item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Похожие", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(end = 40.dp, top = 8.dp, bottom = 8.dp)) {
                        items(similar, key = { it.id }) { title -> TvPoster(title, { onOpen(title) }) }
                    }
                }
            }
        }
    }
}
