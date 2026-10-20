package com.cinevault.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun HomeScreen(
    bottomPadding: PaddingValues,
    onOpen: (CatalogTitle) -> Unit,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
    onHistory: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { CineStore.loadHome() }
    val continueWatching = CineStore.recentlyWatched.take(12)
    val list = rememberLazyListState()
    // The pager inside the hero nudges the list when its pages first appear; keep the top in view.
    LaunchedEffect(CineStore.homeHero.isNotEmpty()) { if (list.firstVisibleItemIndex == 0) list.scrollToItem(0) }

    LazyColumn(
        Modifier.fillMaxSize().background(Cine.Background), state = list,
        contentPadding = bottomPadding,
        verticalArrangement = Arrangement.spacedBy(30.dp),
    ) {
        item { Hero(onOpen, onSearch, onSettings) }
        if (continueWatching.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ShelfHeader("Продолжить просмотр", action = "Все", onAction = onHistory)
                LazyRow(contentPadding = PaddingValues(horizontal = Cine.Gutter), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(continueWatching, key = { it.title.id }) { entry -> ContinueCard(entry) { onOpen(entry.title.asCatalogTitle()) } }
                }
            }
        }
        val error = CineStore.homeError
        if (error != null && CineStore.homeShelves.isEmpty()) item {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                EmptyState(Icons.Default.WifiOff, "Не удалось загрузить подборки", error)
                SecondaryButton("Повторить", { scope.launch { CineStore.loadHome(force = true) } }, Modifier.padding(horizontal = Cine.Gutter).fillMaxWidth())
            }
        }
        items(CineStore.homeShelves, key = { it.id }) { shelf ->
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ShelfHeader(shelf.title, shelf.subtitle)
                LazyRow(contentPadding = PaddingValues(horizontal = Cine.Gutter), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(shelf.items, key = { it.id }) { title -> PosterCard(title, { onOpen(title) }, width = 128.dp) }
                }
            }
        }
    }
}

@Composable
private fun Hero(onOpen: (CatalogTitle) -> Unit, onSearch: () -> Unit, onSettings: () -> Unit) {
    val items = CineStore.homeHero
    Box(Modifier.fillMaxWidth().height(560.dp)) {
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Cine.Surface, Cine.Background))), contentAlignment = Alignment.Center) {
                if (CineStore.homeLoading) CircularProgressIndicator(color = Color.White)
            }
        } else {
            val pager = rememberPagerState { items.size }
            HorizontalPager(pager, Modifier.fillMaxSize()) { page ->
                HeroPage(items[page], if (page == 0) "Советуем" else "Новинка", onOpen)
            }
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(items.size) { index ->
                    val selected = index == pager.currentPage
                    Box(Modifier.size(width = if (selected) 18.dp else 5.dp, height = 5.dp).clip(CircleShape).background(if (selected) Color.White else Color.White.copy(alpha = 0.3f)))
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = Cine.Gutter, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(30.dp).clip(RoundedCornerShape(10.dp)).background(Cine.Button), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Color.White, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(9.dp))
            Text("CineVault", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            OverlayButton(Icons.Default.Search, "Поиск", onSearch)
            Spacer(Modifier.width(10.dp))
            OverlayButton(Icons.Default.Settings, "Настройки", onSettings)
        }
    }
}

@Composable
private fun HeroPage(title: CatalogTitle, label: String, onOpen: (CatalogTitle) -> Unit) {
    val favorite = CineStore.isFavorite(title.id)
    Box(Modifier.fillMaxSize()) {
        BackdropArt(title, Modifier.fillMaxSize())
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Cine.Background.copy(alpha = 0.55f), 0.22f to Color.Transparent, 0.42f to Color.Transparent,
                    0.76f to Cine.Background.copy(alpha = 0.85f), 1f to Cine.Background,
                ),
            ),
        )
        Column(Modifier.align(Alignment.BottomStart).padding(start = Cine.Gutter, end = Cine.Gutter, bottom = 26.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Cine.Surface.copy(alpha = 0.8f)).padding(horizontal = 10.dp, vertical = 5.dp))
            TitleLogo(title)
            MetaLine(title)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton("Смотреть", { onOpen(title) }, Modifier.weight(1f), Icons.Default.PlayArrow)
                IconSquareButton(if (favorite) Icons.Default.Check else Icons.Default.Add, if (favorite) "Убрать из избранного" else "В избранное", { CineStore.toggleFavorite(title) })
                IconSquareButton(Icons.Default.Info, "Подробнее", { onOpen(title) })
            }
        }
    }
}

@Composable
private fun ContinueCard(entry: WatchEntry, onClick: () -> Unit) {
    Column(Modifier.width(244.dp).clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
            BackdropArt(entry.title.asCatalogTitle(), Modifier.fillMaxSize())
            Box(Modifier.size(44.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, null, tint = Color.White)
            }
        }
        Text(entry.title.title, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(listOfNotNull(providerLabel(entry.providerId), entry.translationName).joinToString(" · "), color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

fun providerLabel(id: String): String = when (id) {
    "alloha" -> "Alloha"
    "collaps" -> "Collaps"
    "veoveo" -> "Veoveo"
    "turbo" -> "Turbo"
    "cinevault" -> "CineVault"
    else -> id.replaceFirstChar { it.uppercase() }
}
