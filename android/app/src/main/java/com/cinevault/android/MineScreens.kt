package com.cinevault.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

@Composable
private fun ScreenTitle(title: String, action: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

@Composable
fun MineScreen(bottomPadding: PaddingValues, onOpen: (CatalogTitle) -> Unit, onSettings: () -> Unit, startOnHistory: Boolean) {
    var tab by rememberSaveable(startOnHistory) { mutableStateOf(if (startOnHistory) "history" else "favorites") }
    LazyVerticalGrid(
        columns = GridCells.Fixed(3), modifier = Modifier.fillMaxSize().background(Cine.Background),
        contentPadding = PaddingValues(start = Cine.Gutter, end = Cine.Gutter, bottom = bottomPadding.calculateBottomPadding() + 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                ScreenTitle("Моё") { OverlayButton(Icons.Default.Settings, "Настройки", onSettings) }
                CineSegmented(listOf("favorites" to "Избранное", "history" to "История"), tab, { tab = it })
            }
        }
        if (tab == "favorites") {
            if (CineStore.favorites.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState(Icons.Default.FavoriteBorder, "Здесь будет избранное", "Нажмите «В избранное» на карточке фильма или сериала.")
            }
            items(CineStore.favorites, key = { it.id }) { saved -> PosterCard(saved.asCatalogTitle(), { onOpen(saved.asCatalogTitle()) }) }
        } else {
            val history = CineStore.recentlyWatched
            if (history.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState(Icons.Default.History, "История пуста", "Здесь появится то, что вы открывали на этом телефоне.")
            }
            items(history, key = { it.title.id }, span = { GridItemSpan(maxLineSpan) }) { entry -> HistoryRow(entry, { onOpen(entry.title.asCatalogTitle()) }) { CineStore.removeFromHistory(entry.title.id) } }
        }
    }
}

@Composable
private fun HistoryRow(entry: WatchEntry, onClick: () -> Unit, onRemove: () -> Unit) {
    val date = remember(entry.updatedAt) { SimpleDateFormat("d MMMM, HH:mm", Locale("ru")).format(Date(entry.updatedAt)) }
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        PosterImage(entry.title.poster, entry.title.title, Modifier.width(64.dp).height(96.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(entry.title.title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(providerLabel(entry.providerId), entry.translationName).joinToString(" · "), color = Cine.Muted, fontSize = 13.sp, maxLines = 1)
            Text(date, color = Cine.Muted, fontSize = 12.sp)
        }
        Icon(Icons.Default.Close, "Убрать из истории", tint = Cine.Muted, modifier = Modifier.clickable(onClick = onRemove).padding(8.dp))
    }
}

@Composable
fun DownloadsScreen(bottomPadding: PaddingValues, onPlay: (PlayRequest) -> Unit) {
    val context = LocalContext.current
    val folder = remember { File(context.filesDir, "offline") }
    val scope = rememberCoroutineScope()
    var downloaded by remember { mutableStateOf(emptyList<DownloadedEpisode>()) }
    var library by remember { mutableStateOf(emptyList<LibraryEpisode>()) }
    var target by remember { mutableStateOf<LibraryEpisode?>(null) }
    var quality by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    fun reload() { downloaded = CineVaultApi.downloadedEpisodes(folder) }
    LaunchedEffect(Unit) {
        reload()
        library = runCatching { CineVaultApi.libraryEpisodes() }.getOrDefault(emptyList()).filter { it.sourceType != "external_embed" && it.qualities.isNotEmpty() }
    }
    val savedIds = downloaded.map { it.id }.toSet()

    LazyColumn(
        Modifier.fillMaxSize().background(Cine.Background),
        contentPadding = PaddingValues(start = Cine.Gutter, end = Cine.Gutter, bottom = bottomPadding.calculateBottomPadding() + 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { ScreenTitle("Загрузки") }
        if (downloaded.isNotEmpty()) item { Text("На телефоне", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold) }
        items(downloaded, key = { "d-" + it.id }) { episode ->
            DownloadRow(episode.title, "${episode.subtitle} · ${episode.quality}") {
                TextButton(onClick = {
                    val title = CatalogTitle(episode.id, null, "series", episode.title, episode.title, 0, "", null, 0.0, 0, emptyList(), emptyList())
                    onPlay(PlayRequest(title, source = PlaybackSource(episode.id, episode.file.toURI().toString(), "hls", episode.quality, "CineVault")))
                }) { Text("Смотреть", color = Cine.Accent) }
                TextButton(onClick = { CineVaultApi.deleteDownloadedEpisode(folder, episode.id); reload() }) { Text("Удалить", color = Cine.Muted) }
            }
        }
        if (downloaded.isEmpty()) item {
            EmptyState(Icons.Default.Download, "Пока ничего не скачано", "Нажмите «Скачать» у серии из медиатеки — она сохранится в приложении и будет доступна без интернета.")
        }
        val available = library.filter { it.id !in savedIds }
        if (available.isNotEmpty()) item {
            ShelfHeader("Медиатека на сервере", "${available.size} серий можно скачать")
        }
        items(available, key = { "l-" + it.id }) { episode ->
            val subtitle = listOfNotNull(episode.season?.let { "Сезон $it" }, episode.episode?.let { "Серия $it" }, episode.episodeTitle.takeIf(String::isNotBlank)).joinToString(" · ")
            DownloadRow(episode.title, status[episode.id] ?: subtitle) {
                TextButton(onClick = { quality = episode.qualities.last(); target = episode }) { Text("Скачать", color = Cine.Accent) }
            }
        }
    }

    target?.let { episode ->
        AlertDialog(
            onDismissRequest = { target = null },
            containerColor = Cine.Surface,
            title = { Text("Качество загрузки") },
            text = {
                Column {
                    episode.qualities.forEach { option ->
                        Row(Modifier.fillMaxWidth().clickable { quality = option }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(quality == option, { quality = option }, colors = RadioButtonDefaults.colors(selectedColor = Cine.Accent))
                            Text(option)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val chosen = quality
                    target = null
                    status = status + (episode.id to "Загружаю…")
                    scope.launch {
                        runCatching {
                            CineVaultApi.downloadLibraryEpisode(episode, chosen, folder) { done, total ->
                                scope.launch { status = status + (episode.id to "Загружаю $done/$total…") }
                            }
                        }.onSuccess { status = status - episode.id; reload() }
                            .onFailure { status = status + (episode.id to "Ошибка: ${it.message ?: "загрузка не удалась"}") }
                    }
                }) { Text("Скачать", color = Cine.Accent) }
            },
            dismissButton = { TextButton(onClick = { target = null }) { Text("Отмена", color = Cine.Muted) } },
        )
    }
}

@Composable
private fun DownloadRow(title: String, subtitle: String, actions: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface).padding(start = 14.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = Cine.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}

@Composable
fun SettingsDialog(onDismiss: () -> Unit) {
    var status by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Cine.Surface,
        title = { Text("Настройки") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Сервер CineVault", color = Cine.Muted, fontSize = 13.sp)
                Text(BuildConfig.SERVER_URL, color = Color.White)
                Text(status ?: "Избранное и история просмотра хранятся на этом телефоне. Скачанные серии доступны без интернета.", color = Cine.Muted, fontSize = 13.sp)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                scope.launch {
                    status = "Проверяю…"
                    status = runCatching { CineVaultApi.checkConnection() }.fold({ "Сервер подключён" }, { "Не удалось подключиться: ${it.message}" })
                }
            }) { Text("Проверить сервер", color = Cine.Accent) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Готово", color = Cine.Muted) } },
    )
}
