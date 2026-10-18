package com.cinevault.android

import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

private val Canvas = Color(0xFF071719)
private val SurfaceColor = Color(0xFF0D292B)
internal val Accent = Color(0xFF00D7C2)
private val Muted = Color(0xFF9AAEB0)

private enum class Tab(val title: String) { HOME("Для вас"), CATALOG("Каталог"), DOWNLOADS("Скачано"), SETTINGS("Настройки") }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(7, 23, 25)
        window.navigationBarColor = android.graphics.Color.rgb(7, 23, 25)
        setContent { CineVaultTheme { CineVaultRoot() } }
    }
}

@Composable
private fun CineVaultTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = Accent,
            onPrimary = Color(0xFF00211E),
            background = Canvas,
            surface = SurfaceColor,
            onBackground = Color.White,
            onSurface = Color.White,
        ),
        content = content,
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun CineVaultRoot() {
    var tab by rememberSaveable { mutableStateOf(Tab.CATALOG) }
    var title by remember { mutableStateOf<CatalogTitle?>(null) }
    var player by remember { mutableStateOf<PlayRequest?>(null) }
    val activity = LocalContext.current as? ComponentActivity
    DisposableEffect(player != null, activity) {
        val window = activity?.window
        if (player != null) {
            window?.decorView?.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
        onDispose { window?.decorView?.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE }
    }
    BackHandler(enabled = player != null || title != null) {
        if (player != null) player = null else title = null
    }

    if (player != null) {
        PlayerScreen(
            request = player!!,
            onBack = { player = null },
        )
    } else {
        Scaffold(
            containerColor = Canvas,
            topBar = {
                TopAppBar(
                    title = { Text(title?.title ?: if (tab == Tab.HOME) "Для вас" else tab.title, fontWeight = FontWeight.Bold) },
                    navigationIcon = if (title != null) ({ IconButton(onClick = { title = null }) { Icon(Icons.Default.ArrowBack, "Назад") } }) else ({}),
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Canvas, titleContentColor = Color.White),
                )
            },
            bottomBar = { CineVaultBottomBar(tab) { tab = it; title = null } },
        ) { insets ->
            if (title != null) {
                DetailScreen(title!!, Modifier.padding(insets), onPlay = { player = it })
            } else if (tab == Tab.SETTINGS) {
                SettingsScreen(Modifier.padding(insets))
            } else if (tab == Tab.DOWNLOADS) {
                DownloadsScreen(Modifier.padding(insets)) { downloaded ->
                    val title = CatalogTitle(downloaded.id, null, "series", downloaded.title, downloaded.title, 0, "", null, 0.0, 0, emptyList(), emptyList())
                    player = PlayRequest(title, source = PlaybackSource(downloaded.id, downloaded.file.toURI().toString(), "hls", downloaded.quality, "CineVault"))
                }
            } else if (tab == Tab.HOME) {
                ForYouScreen(Modifier.padding(insets), onOpen = { title = it })
            } else {
                CatalogScreen(tab, Modifier.padding(insets), onOpen = { title = it })
            }
        }
    }
}

@Composable
private fun CineVaultBottomBar(tab: Tab, onSelect: (Tab) -> Unit) {
    NavigationBar(containerColor = SurfaceColor, modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBars)) {
        Tab.entries.forEach { item ->
            NavigationBarItem(
                selected = item == tab,
                onClick = { onSelect(item) },
                icon = {
                    Icon(
                        when (item) {
                            Tab.HOME -> Icons.Default.Home
                            Tab.CATALOG -> Icons.Default.Movie
                            Tab.DOWNLOADS -> Icons.Default.Download
                            Tab.SETTINGS -> Icons.Default.Settings
                        }, item.title,
                    )
                },
                label = { Text(item.title) },
            )
        }
    }
}

@Composable
private fun SettingsScreen(modifier: Modifier = Modifier) {
    var status by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(modifier.fillMaxSize().background(Canvas).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Подключение", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Surface(color = SurfaceColor, shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(BuildConfig.SERVER_URL, color = Accent)
                Text("Данные доступа приложения загружаются из приватной конфигурации сборки.", color = Muted)
                Button(enabled = !checking, onClick = {
                    scope.launch {
                        checking = true
                        status = runCatching { CineVaultApi.checkConnection() }
                            .fold({ "Соединение есть · ${it}" }, { "Не удалось подключиться: ${it.message}" })
                        checking = false
                    }
                }) { Text(if (checking) "Проверяю…" else "Проверить сервер") }
                status?.let { Text(it, color = if (it.startsWith("Соединение")) Accent else Color(0xFFFFB36B)) }
            }
        }
    }
}

@Composable
private fun DownloadsScreen(modifier: Modifier = Modifier, onPlay: (DownloadedEpisode) -> Unit) {
    val context = LocalContext.current
    var downloads by remember { mutableStateOf(emptyList<DownloadedEpisode>()) }
    fun reload() { downloads = CineVaultApi.downloadedEpisodes(File(context.filesDir, "offline")) }
    LaunchedEffect(Unit) { reload() }
    LazyColumn(modifier.fillMaxSize().background(Canvas).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Офлайн-загрузки", fontWeight = FontWeight.Bold, fontSize = 22.sp)
            Text("Сохранённые серии из медиатеки CineVault", color = Muted, modifier = Modifier.padding(top = 4.dp))
        }
        if (downloads.isEmpty()) item {
            Surface(color = SurfaceColor, shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Default.Download, null, tint = Accent, modifier = Modifier.size(32.dp))
                    Text("Здесь пока пусто", fontWeight = FontWeight.Bold)
                    Text("Открой карточку с сериями, загруженными в медиатеку CineVault, нажми «Скачать» и выбери качество. Alloha и внешние iframe-плееры не предоставляют приложению файл для офлайн-сохранения.", color = Muted)
                }
            }
        }
        items(downloads, key = { it.id }) { episode ->
            Surface(color = SurfaceColor, shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text(episode.title, fontWeight = FontWeight.Bold)
                    Text("${episode.subtitle} · ${episode.quality}", color = Muted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onPlay(episode) }) { Text("Смотреть офлайн") }
                        TextButton(onClick = { CineVaultApi.deleteDownloadedEpisode(File(context.filesDir, "offline"), episode.id); reload() }) { Text("Удалить") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ForYouScreen(modifier: Modifier, onOpen: (CatalogTitle) -> Unit) {
    var shelves by remember { mutableStateOf<List<Pair<String, List<CatalogTitle>>>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        loading = true
        runCatching {
            coroutineScope {
                listOf(
                    "Популярно у зрителей" to Triple("popular", "popular", ""),
                    "Новое и актуальное" to Triple("new", "new", ""),
                    "На вечер" to Triple("rating", "evening", ""),
                ).map { (label, query) ->
                    async { label to CineVaultApi.catalog(1, "", "", "", query.first, query.second).items }
                }.awaitAll()
            }
        }.onSuccess { shelves = it }
            .onFailure { error = it.message ?: "Не удалось загрузить рекомендации" }
        loading = false
    }
    LazyColumn(modifier.fillMaxSize().background(Canvas), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            Column(Modifier.padding(start = 18.dp, end = 18.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Подобрали для вас", fontSize = 25.sp, fontWeight = FontWeight.Bold)
                Text("Популярное, свежие карточки и подборки из вашей медиатеки.", color = Muted)
            }
        }
        if (loading && shelves.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(36.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        error?.let { item { Text(it, color = Color(0xFFFFB36B), modifier = Modifier.padding(horizontal = 18.dp)) } }
        items(shelves, key = { it.first }) { (label, titles) ->
            CatalogShelf(label, titles, onOpen)
        }
        item { Spacer(Modifier.height(10.dp)) }
    }
}

@Composable
private fun CatalogShelf(label: String, titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, fontWeight = FontWeight.Bold, fontSize = 19.sp, modifier = Modifier.padding(horizontal = 18.dp))
        if (titles.isEmpty()) {
            Text("Пока нет карточек для этой подборки.", color = Muted, modifier = Modifier.padding(horizontal = 18.dp))
        } else {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 18.dp)) {
                items(titles, key = { it.id }) { title ->
                    Column(Modifier.width(132.dp).clickable { onOpen(title) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Poster(title.poster, title.title, Modifier.fillMaxWidth().height(180.dp))
                        Text(title.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${title.year} · КП ${"%.1f".format(title.rating)}", color = Muted, fontSize = 12.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun CatalogScreen(tab: Tab, modifier: Modifier, onOpen: (CatalogTitle) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableStateOf("") }
    var genre by rememberSaveable { mutableStateOf("") }
    var sort by rememberSaveable { mutableStateOf("rating") }
    var page by rememberSaveable { mutableIntStateOf(1) }
    var result by remember { mutableStateOf<CatalogPage?>(null) }
    var genres by remember { mutableStateOf(listOf<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { runCatching { CineVaultApi.facets() }.onSuccess { genres = it } }
    LaunchedEffect(tab, page, query, type, genre, sort) {
        delay(if (query.isBlank()) 0 else 350)
        loading = true
        error = null
        runCatching { CineVaultApi.catalog(page, query, type, genre, sort) }
            .onSuccess { result = it }
            .onFailure { error = it.message ?: "Не удалось загрузить каталог" }
        loading = false
    }

    LazyColumn(modifier.fillMaxSize().background(Canvas).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Spacer(Modifier.height(6.dp))
            Text("Фильмы и сериалы", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("${result?.total ?: 0} карточек · поиск, жанры и сортировка", color = Muted, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
            OutlinedTextField(
                value = query, onValueChange = { query = it; page = 1 },
                modifier = Modifier.fillMaxWidth(), singleLine = true,
                placeholder = { Text("Найти фильм или сериал") },
                leadingIcon = { Icon(Icons.Default.Search, null) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = type.isEmpty(), onClick = { type = ""; page = 1 }, label = { Text("Всё") })
                FilterChip(selected = type == "movie", onClick = { type = "movie"; page = 1 }, label = { Text("Фильмы") })
                FilterChip(selected = type == "series", onClick = { type = "series"; page = 1 }, label = { Text("Сериалы") })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                DropdownFilter("Жанр", genre.ifBlank { "Все" }, genres) { genre = if (it == "Все") "" else it; page = 1 }
                DropdownFilter("Сортировка", sortLabel(sort), listOf("По популярности", "По рейтингу", "Сначала новые", "По году", "По названию")) {
                    sort = when (it) { "По популярности" -> "popular"; "По рейтингу" -> "rating"; "Сначала новые" -> "new"; "По году" -> "year"; else -> "title" }
                    page = 1
                }
            }
        }
        if (loading && result == null) item { Box(Modifier.fillMaxWidth().padding(36.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        if (error != null) item {
            Surface(color = SurfaceColor, shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) {
                    Text("Не получилось загрузить каталог", fontWeight = FontWeight.Bold)
                    Text(error.orEmpty(), color = Muted, modifier = Modifier.padding(vertical = 8.dp))
                    Button(onClick = { scope.launch { runCatching { CineVaultApi.catalog(page, query, type, genre, sort) }.onSuccess { result = it }.onFailure { error = it.message } } }) { Text("Повторить") }
                }
            }
        }
        items(result?.items.orEmpty(), key = { it.id }) { item -> CatalogCard(item) { onOpen(item) } }
        if (loading && result != null) item { Text("Обновляю…", color = Muted) }
        item {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Button(enabled = (result?.page ?: 1) > 1, onClick = { page = (result?.page ?: page) - 1 }) { Text("Назад") }
                Text("${result?.page ?: page} / ${result?.pages ?: 1}", color = Muted)
                Button(enabled = (result?.page ?: 1) < (result?.pages ?: 1), onClick = { page = (result?.page ?: page) + 1 }) { Text("Дальше") }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun DropdownFilter(label: String, selected: String, choices: List<String>, onPick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        FilterChip(selected = selected != "Все", onClick = { expanded = true }, label = { Text("$label: $selected", maxLines = 1, overflow = TextOverflow.Ellipsis) })
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            (if (label == "Жанр") listOf("Все") + choices else choices).forEach { choice ->
                DropdownMenuItem(text = { Text(choice) }, onClick = { expanded = false; onPick(choice) })
            }
        }
    }
}

private fun sortLabel(sort: String) = when (sort) {
    "popular" -> "По популярности"
    "new" -> "Сначала новые"
    "year" -> "По году"
    "title" -> "По названию"
    else -> "По рейтингу"
}

@Composable
private fun CatalogCard(title: CatalogTitle, onClick: () -> Unit) {
    Surface(
        color = SurfaceColor, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Poster(title.poster, title.title, Modifier.width(92.dp).height(132.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title.title, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("${title.year} · ${if (title.kind == "series") "Сериал" else "Фильм"} · КП ${"%.1f".format(title.rating)} · ${title.votes} оценок", color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(title.description.ifBlank { title.genres.joinToString(" · ") }, color = Muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                if (title.seasons.isNotEmpty()) Text("${title.seasons.size} сезонов · ${title.seasons.sum()} серий", color = Color(0xFFA9CBC9), fontSize = 13.sp)
            }
            Icon(Icons.Default.ArrowForward, "Открыть", tint = Muted)
        }
    }
}

@Composable
private fun Poster(url: String?, title: String, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(14.dp)).background(Color(0xFF153638)), contentAlignment = Alignment.Center) {
        if (url != null) AsyncImage(model = url, contentDescription = title, modifier = Modifier.fillMaxSize())
        else Text(title.take(1), color = Accent, fontSize = 28.sp, fontWeight = FontWeight.Bold)
    }
}

private data class PlayRequest(val title: CatalogTitle, val source: PlaybackSource? = null, val voice: VoiceOption? = null)

@Composable
private fun DetailScreen(initialTitle: CatalogTitle, modifier: Modifier, onPlay: (PlayRequest) -> Unit) {
    var title by remember(initialTitle.id) { mutableStateOf(initialTitle) }
    var loading by remember(initialTitle.id) { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var voices by remember { mutableStateOf<List<VoiceOption>>(emptyList()) }
    var loadingVoices by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var libraryEpisodes by remember(initialTitle.id) { mutableStateOf<List<LibraryEpisode>>(emptyList()) }
    var downloadTarget by remember { mutableStateOf<LibraryEpisode?>(null) }
    var downloadStatus by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var selectedDownloadQuality by remember { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(initialTitle.id) {
        loading = true
        runCatching { CineVaultApi.title(initialTitle.id) }
            .onSuccess { title = it }
            .onFailure { error = it.message }
        loading = false
    }

    LaunchedEffect(initialTitle.id) {
        runCatching { CineVaultApi.libraryEpisodes() }.onSuccess { all ->
            val kinopoiskKey = title.kinopoiskId?.toString().orEmpty()
            libraryEpisodes = all.filter { episode ->
                episode.status == "ready" && episode.hlsUrl != null && episode.qualities.isNotEmpty() &&
                    (episode.titleId == title.id || episode.titleId == kinopoiskKey || episode.title.equals(title.title, ignoreCase = true))
            }
        }
    }

    LazyColumn(modifier.fillMaxSize().background(Canvas).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Poster(title.poster, title.title, Modifier.width(124.dp).height(184.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(title.title, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text("${title.year} · ${if (title.kind == "series") "Сериал" else "Фильм"}", color = Muted)
                    if (title.rating > 0) Text("Кинопоиск ${"%.1f".format(title.rating)} · ${title.votes} оценок", color = Muted, fontSize = 13.sp)
                    Text(title.seasons.takeIf { it.isNotEmpty() }?.let { "${it.size} сезонов · ${it.sum()} серий" }.orEmpty(), color = Muted, fontSize = 13.sp)
                }
            }
        }
        item {
            Surface(color = SurfaceColor, shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Подробнее", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    if (title.genres.isNotEmpty()) Text(title.genres.joinToString(" · ") { "#$it" }, color = Accent)
                    Text(title.description.ifBlank { "Описание пока не добавлено." }, color = Muted)
                }
            }
        }
        if (loading) item { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { CircularProgressIndicator(Modifier.size(20.dp)); Text("Загружаю свежие данные…", color = Muted) } }
        error?.let { item { Text("Не удалось загрузить карточку: $it", color = Color(0xFFFFB36B)) } }
        item {
            Text("Варианты просмотра", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            val kinopoiskID = title.kinopoiskId
            if (kinopoiskID != null) {
                Button(enabled = !loadingVoices, onClick = {
                    scope.launch {
                        loadingVoices = true
                        message = null
                        runCatching { CineVaultApi.allohaOptions(kinopoiskID) }
                            .onSuccess { voices = it; if (it.isEmpty()) message = "У Alloha нет доступных озвучек для этого тайтла." }
                            .onFailure { message = it.message ?: "Не удалось получить озвучки" }
                        loadingVoices = false
                    }
                }) { Text(if (loadingVoices) "Ищу озвучки…" else "Другой плеер · Alloha") }
            }
            message?.let { Text(it, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp)) }
        }
        if (title.sources.any { !it.isEmbed }) item {
            Text("Встроенный плеер CineVault", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        if (title.sources.any { it.isEmbed }) item {
            Text("Внешние плееры", fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        items(voices, key = { it.id }) { voice ->
            SourceButton("${voice.name}${voice.quality.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty()}") {
                onPlay(PlayRequest(title, voice = voice))
            }
        }
        items(title.sources, key = { it.id }) { source ->
            val label = source.label.ifBlank { if (source.isEmbed) "Открыть плеер" else "Смотреть" }
            SourceButton(if (source.isEmbed) label else "${label} · CineVault") {
                scope.launch {
                    var latest = title
                    var notice: String? = null
                    title.kinopoiskId?.let { id ->
                        runCatching { CineVaultApi.refreshPlayback(id) }
                            .onSuccess { it?.let { updated -> latest = updated } }
                            .onFailure { notice = "Свежая ссылка не получена, пробую сохранённую" }
                    }
                    val refreshed = latest.sources.firstOrNull { it.id == source.id }
                        ?: latest.sources.firstOrNull { it.voice == source.voice && it.quality == source.quality }
                        ?: source
                    message = notice
                    onPlay(PlayRequest(latest, source = refreshed))
                }
            }
        }
        if (libraryEpisodes.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Медиатека CineVault", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text("Серии с сервера · можно смотреть онлайн и сохранить на устройство", color = Muted, fontSize = 13.sp)
            }
        }
        items(libraryEpisodes, key = { "library-${it.id}" }) { episode ->
            LibraryEpisodeRow(
                episode = episode,
                status = downloadStatus[episode.id],
                onPlay = {
                    val source = PlaybackSource(
                        episode.id, CineVaultApi.absoluteMediaURL(episode.hlsUrl.orEmpty()),
                        "hls", "", "CineVault",
                    )
                    onPlay(PlayRequest(title, source = source))
                },
                onDownload = {
                    selectedDownloadQuality = episode.qualities.lastOrNull().orEmpty()
                    downloadTarget = episode
                },
            )
        }
        if (title.sources.isEmpty() && voices.isEmpty() && !loading) item {
            Text("Плееры появятся, когда для карточки будут доступны источники.", color = Muted)
        }
        item { Spacer(Modifier.height(20.dp)) }
    }

    downloadTarget?.let { episode ->
        AlertDialog(
            onDismissRequest = { downloadTarget = null },
            title = { Text("Скачать серию") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${episode.title} · ${episode.season?.let { "сезон $it" } ?: ""} ${episode.episode?.let { "серия $it" } ?: episode.episodeTitle}", color = Muted)
                    Text("Источник: медиатека CineVault. Внешние плееры и озвучки Alloha не входят в офлайн-загрузки.", color = Muted, fontSize = 13.sp)
                    episode.qualities.forEach { quality ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { selectedDownloadQuality = quality }) {
                            RadioButton(selected = selectedDownloadQuality == quality, onClick = { selectedDownloadQuality = quality })
                            Text(quality)
                        }
                    }
                    downloadStatus[episode.id]?.let { Text(it, color = Accent, fontSize = 13.sp) }
                }
            },
            confirmButton = {
                Button(enabled = selectedDownloadQuality.isNotBlank() && !downloadStatus[episode.id].orEmpty().startsWith("Загружаю"), onClick = {
                    val quality = selectedDownloadQuality
                    downloadStatus = downloadStatus + (episode.id to "Загружаю 0/${episode.qualities.size}…")
                    scope.launch {
                        runCatching {
                            CineVaultApi.downloadLibraryEpisode(episode, quality, File(context.filesDir, "offline")) { done, total ->
                                scope.launch { downloadStatus = downloadStatus + (episode.id to "Загружаю $done/$total…") }
                            }
                        }.onSuccess {
                            downloadStatus = downloadStatus + (episode.id to "Сохранено · $quality")
                        }.onFailure {
                            downloadStatus = downloadStatus + (episode.id to "Ошибка: ${it.message ?: "загрузка не удалась"}")
                        }
                    }
                }) { Text("Скачать") }
            },
            dismissButton = { TextButton(onClick = { downloadTarget = null }) { Text("Закрыть") } },
        )
    }
}

@Composable
private fun LibraryEpisodeRow(
    episode: LibraryEpisode,
    status: String?,
    onPlay: () -> Unit,
    onDownload: () -> Unit,
) {
    Surface(color = SurfaceColor, shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(episode.episodeTitle.ifBlank { "Серия ${episode.episode ?: "—"}" }, fontWeight = FontWeight.SemiBold)
            Text(listOfNotNull(episode.season?.let { "Сезон $it" }, episode.episode?.let { "Серия $it" }, episode.qualities.joinToString(" / ")).joinToString(" · "), color = Muted, fontSize = 12.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onPlay) { Text("Смотреть") }
                TextButton(onClick = onDownload) { Icon(Icons.Default.Download, null); Spacer(Modifier.width(5.dp)); Text("Скачать") }
            }
            status?.let { Text(it, color = if (it.startsWith("Ошибка")) Color(0xFFFFB36B) else Accent, fontSize = 12.sp) }
        }
    }
}

@Composable
private fun SourceButton(label: String, onClick: () -> Unit) {
    Surface(color = SurfaceColor, shape = RoundedCornerShape(15.dp), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Movie, null, tint = Accent)
            Spacer(Modifier.width(12.dp))
            Text(label, color = Accent, fontSize = 16.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.weight(1f))
            Icon(Icons.Default.ArrowForward, null, tint = Muted)
        }
    }
}

@Composable
private fun PlayerScreen(request: PlayRequest, onBack: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when {
                request.voice != null -> AllohaWebPlayer(request.voice.url)
                request.source?.isEmbed == true -> AllohaWebPlayer(request.source.url)
                request.source != null -> NativeVideoPlayer(request.source)
                else -> Text("Источник не найден", color = Color.White)
            }
        }
        Surface(
            color = Color.Black.copy(alpha = 0.58f),
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.align(Alignment.TopStart).padding(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 14.dp)) {
                IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Закрыть плеер", tint = Color.White) }
                Text(request.title.title, color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
