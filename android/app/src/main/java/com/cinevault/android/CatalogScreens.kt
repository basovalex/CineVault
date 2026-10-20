package com.cinevault.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private fun formatCount(value: Int): String = String.format("%,d", value).replace(',', ' ')

@Composable
fun CatalogScreen(bottomPadding: PaddingValues, onOpen: (CatalogTitle) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("movie") }
    var genre by rememberSaveable { mutableStateOf("") }
    var items by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var page by remember { mutableStateOf(0) }
    var pages by remember { mutableStateOf(1) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableStateOf(0) }
    val grid = rememberLazyGridState()

    LaunchedEffect(Unit) { CineStore.loadFacets("movie"); CineStore.loadFacets("series"); CineStore.loadFacets("") }
    LaunchedEffect(kind, genre) {
        items = emptyList(); page = 0; pages = 1; error = null; request++
        grid.scrollToItem(0)
    }
    // Next page as the grid nears its end.
    LaunchedEffect(request) {
        val current = request
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
            if (current != request || loading || page >= pages || error != null) return@collect
            if (page > 0 && last < items.size - 12) return@collect
            loading = true
            try {
                val result = CineVaultApi.catalog(page + 1, "", kind, genre, "rating")
                if (current == request) {
                    items = (items + result.items).distinctBy { it.id }; page = result.page; pages = result.pages
                }
            } catch (cancelled: CancellationException) {
                throw cancelled // a newer request replaced this one; that is not an error
            } catch (failure: Exception) {
                error = failure.message ?: "Каталог не загрузился"
            } finally {
                loading = false
            }
        }
    }
    val genres = CineStore.facets[kind]?.genres.orEmpty().entries.sortedByDescending { it.value }.take(16).map { it.key }
    val movies = CineStore.facets[""]?.movies ?: CineStore.facets["movie"]?.total
    val series = CineStore.facets[""]?.series ?: CineStore.facets["series"]?.total

    LazyVerticalGrid(
        columns = GridCells.Fixed(3), state = grid,
        modifier = Modifier.fillMaxSize().background(Cine.Background),
        contentPadding = PaddingValues(start = Cine.Gutter, end = Cine.Gutter, bottom = bottomPadding.calculateBottomPadding() + 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Каталог", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
                CineSegmented(
                    listOf("movie" to ("Фильмы" + (movies?.let { " · " + formatCount(it) } ?: "")), "series" to ("Сериалы" + (series?.let { " · " + formatCount(it) } ?: ""))),
                    kind, { kind = it; genre = "" },
                )
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item { CineChip("Все жанры", genre.isEmpty()) { genre = "" } }
                    items(genres) { name -> CineChip(name, genre == name) { genre = name } }
                }
            }
        }
        items(items, key = { it.id }) { title -> PosterCard(title, { onOpen(title) }) }
        if (loading || error != null) item(span = { GridItemSpan(maxLineSpan) }) {
            Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                if (error != null) {
                    SecondaryButton("Повторить", { error = null; request++ }, Modifier.fillMaxWidth())
                } else CircularProgressIndicator(color = Cine.Accent)
            }
        }
    }
}

@Composable
fun SearchScreen(bottomPadding: PaddingValues, onOpen: (CatalogTitle) -> Unit, autoFocus: Boolean) {
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var popular by remember { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        popular = runCatching { CineVaultApi.catalog(1, "", "", "", "popular", "popular").items.take(20) }.getOrDefault(emptyList())
    }
    LaunchedEffect(autoFocus) { if (autoFocus) runCatching { focus.requestFocus() } }
    LaunchedEffect(query) {
        val text = query.trim()
        if (text.length < 2) { results = emptyList(); searching = false; return@LaunchedEffect }
        delay(350)
        searching = true
        results = runCatching { CineVaultApi.catalog(1, text, "", "", "popular").items }.getOrDefault(emptyList())
        searching = false
    }
    val showing = if (query.trim().length >= 2) results else popular

    LazyColumn(
        Modifier.fillMaxSize().background(Cine.Background),
        contentPadding = PaddingValues(bottom = bottomPadding.calculateBottomPadding() + 16.dp),
    ) {
        item {
            Row(
                Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(Cine.Gutter, 10.dp).fillMaxWidth()
                    .clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface).padding(horizontal = 14.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Default.Search, null, tint = Cine.Muted)
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text("Фильмы, сериалы, актёры", color = Cine.Muted, fontSize = 16.sp)
                    BasicTextField(
                        query, { query = it }, singleLine = true,
                        textStyle = TextStyle(color = Color.White, fontSize = 16.sp), cursorBrush = SolidColor(Cine.Accent),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                if (query.isNotEmpty()) Icon(Icons.Default.Close, "Очистить", tint = Cine.Muted, modifier = Modifier.clickable { query = "" })
            }
        }
        item {
            Text(
                if (query.trim().length >= 2) (if (searching) "Ищу…" else "Найдено: ${results.size}") else "Часто смотрят",
                color = Cine.Muted, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = Cine.Gutter, vertical = 8.dp),
            )
        }
        if (query.trim().length >= 2 && !searching && results.isEmpty()) item {
            EmptyState(Icons.Default.SearchOff, "Ничего не нашлось", "Попробуйте другое название или имя актёра.")
        }
        items(showing, key = { it.id }) { title -> SearchRow(title) { onOpen(title) } }
    }
}

@Composable
private fun SearchRow(title: CatalogTitle, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Cine.Gutter, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        PosterImage(title.poster, title.title, Modifier.width(72.dp).height(108.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(title.title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(title.year.takeIf { it > 0 }?.toString(), title.genres.take(2).joinToString(", ").takeIf(String::isNotBlank),
                if (title.isSeries) title.seasons.size.takeIf { it > 0 }?.let { "$it сез." } else null).joinToString(" · "),
                color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (title.rating > 0) Text("★ " + String.format("%.1f", title.rating), color = Cine.Rating, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(if (title.isSeries) "Сериал" else "Фильм", color = Cine.TextSoft, fontSize = 12.sp,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Cine.Surface2).padding(horizontal = 7.dp, vertical = 2.dp))
            }
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = Cine.Muted, modifier = Modifier.size(22.dp))
    }
}
