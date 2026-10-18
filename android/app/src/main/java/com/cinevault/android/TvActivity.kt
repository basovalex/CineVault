package com.cinevault.android

import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val TvBackground = Color(0xFF071719)
private val TvSurface = Color(0xFF0D292B)
private val TvMuted = Color(0xFFA8B8BA)

private enum class TvSection(val label: String) { HOME("Главная"), CATALOG("Каталог") }
private data class TvPlayback(val title: CatalogTitle, val source: PlaybackSource? = null, val voice: VoiceOption? = null)

class TvActivity : ComponentActivity() {
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(7, 23, 25)
        window.navigationBarColor = android.graphics.Color.rgb(7, 23, 25)
        setContent {
            MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(
                primary = Accent, onPrimary = Color(0xFF00211E), background = TvBackground,
                surface = TvSurface, onBackground = Color.White, onSurface = Color.White,
            )) { TvRoot() }
        }
    }
}

@Composable
private fun TvRoot() {
    var section by remember { mutableStateOf(TvSection.HOME) }
    var selectedTitle by remember { mutableStateOf<CatalogTitle?>(null) }
    var playing by remember { mutableStateOf<TvPlayback?>(null) }
    val activity = LocalContext.current as? ComponentActivity

    androidx.compose.runtime.DisposableEffect(playing != null, activity) {
        val window = activity?.window
        if (playing != null) window?.decorView?.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        onDispose { window?.decorView?.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE }
    }
    BackHandler(enabled = playing != null || selectedTitle != null || section != TvSection.HOME) {
        when {
            playing != null -> playing = null
            selectedTitle != null -> selectedTitle = null
            else -> section = TvSection.HOME
        }
    }

    if (playing != null) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when {
                playing!!.voice != null -> AllohaWebPlayer(playing!!.voice!!.url, tvMode = true)
                playing!!.source?.isEmbed == true -> AllohaWebPlayer(playing!!.source!!.url, tvMode = true)
                playing!!.source != null -> NativeVideoPlayer(playing!!.source!!, tvMode = true)
                else -> Text("Источник не найден", color = Color.White)
            }
            TvFocusButton("←  ${playing!!.title.title}", { playing = null }, Modifier.align(Alignment.TopStart).padding(24.dp))
        }
        return
    }

    Column(Modifier.fillMaxSize().background(TvBackground)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 44.dp, vertical = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("CineVault", fontSize = 29.sp, fontWeight = FontWeight.Black, color = Accent)
            Spacer(Modifier.width(24.dp))
            TvFocusButton("Для вас", { selectedTitle = null; section = TvSection.HOME }, selected = section == TvSection.HOME)
            TvFocusButton("Каталог", { selectedTitle = null; section = TvSection.CATALOG }, selected = section == TvSection.CATALOG)
            Spacer(Modifier.weight(1f))
            Text("Управление пультом · Только онлайн", color = TvMuted, fontSize = 14.sp)
        }

        when {
            selectedTitle != null -> TvDetail(selectedTitle!!, onBack = { selectedTitle = null }, onPlay = { playing = it })
            section == TvSection.HOME -> TvHome(Modifier.weight(1f), onOpen = { selectedTitle = it }, onBrowse = { section = TvSection.CATALOG })
            else -> TvCatalog(Modifier.weight(1f), onOpen = { selectedTitle = it })
        }
    }
}

@Composable
private fun TvFocusButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
) {
    var focused by remember { mutableStateOf(false) }
    Surface(
        modifier = modifier
            .onFocusChanged { focused = it.isFocused }
            .focusable()
            .clickable(onClick = onClick)
            .graphicsLayer { val scale = if (focused) 1.06f else 1f; scaleX = scale; scaleY = scale },
        shape = RoundedCornerShape(14.dp),
        color = if (selected) Accent else TvSurface,
        border = if (focused) BorderStroke(3.dp, Color.White) else null,
    ) {
        Text(label, Modifier.padding(horizontal = 22.dp, vertical = 14.dp), color = if (selected) TvBackground else Color.White, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
    }
}

@Composable
private fun TvHome(modifier: Modifier, onOpen: (CatalogTitle) -> Unit, onBrowse: () -> Unit) {
    var shelves by remember { mutableStateOf<List<Pair<String, List<CatalogTitle>>>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        loading = true
        runCatching {
            coroutineScope {
                listOf(
                    "Популярно у зрителей" to Triple("popular", "popular", ""),
                    "Новое и актуальное" to Triple("new", "new", ""),
                    "На вечер" to Triple("rating", "evening", ""),
                ).map { (label, query) -> async { label to CineVaultApi.catalog(1, "", "", "", query.first, query.second).items } }.awaitAll()
            }
        }.onSuccess { shelves = it }.onFailure { error = it.message ?: "Не удалось связаться с CineVault" }
        loading = false
    }
    LazyColumn(modifier.fillMaxSize().padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(25.dp)) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 52.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Фильмы и сериалы для большого экрана", fontSize = 34.sp, fontWeight = FontWeight.Bold)
                    Text("Каталог CineVault · выбирай пультом, смотри через интернет", color = TvMuted, fontSize = 19.sp)
                }
                TvFocusButton("Открыть каталог", onBrowse)
            }
        }
        if (loading && shelves.isEmpty()) item { Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Accent) } }
        error?.let { item { Text("Не удалось загрузить подборки: $it", color = Color(0xFFFFB36B), modifier = Modifier.padding(horizontal = 52.dp)) } }
        items(shelves, key = { it.first }) { (label, titles) -> TvShelf(label, titles, onOpen) }
    }
}

@Composable
private fun TvShelf(label: String, titles: List<CatalogTitle>, onOpen: (CatalogTitle) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.padding(horizontal = 52.dp), fontSize = 22.sp, fontWeight = FontWeight.Bold)
        if (titles.isEmpty()) Text("Пока нет карточек для этой подборки.", color = TvMuted, modifier = Modifier.padding(horizontal = 52.dp))
        else LazyRow(contentPadding = PaddingValues(horizontal = 52.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            items(titles, key = { it.id }) { title -> TvPosterCard(title, onClick = { onOpen(title) }) }
        }
    }
}

@Composable
private fun TvCatalog(modifier: Modifier, onOpen: (CatalogTitle) -> Unit) {
    var query by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("") }
    var genre by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf("popular") }
    var page by remember { mutableIntStateOf(1) }
    var result by remember { mutableStateOf<CatalogPage?>(null) }
    var genres by remember { mutableStateOf(emptyList<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { runCatching { CineVaultApi.facets() }.onSuccess { genres = it } }
    LaunchedEffect(page, query, type, genre, sort) {
        delay(if (query.isBlank()) 0 else 350)
        loading = true
        runCatching { CineVaultApi.catalog(page, query, type, genre, sort) }
            .onSuccess { result = it; error = null }
            .onFailure { error = it.message ?: "Ошибка каталога" }
        loading = false
    }

    Column(modifier.fillMaxSize().padding(horizontal = 52.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = query, onValueChange = { query = it; page = 1 }, singleLine = true,
                modifier = Modifier.weight(1f), placeholder = { Text("Найти фильм или сериал") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            )
            listOf("Всё" to "", "Фильмы" to "movie", "Сериалы" to "series").forEach { (label, value) ->
                FilterChip(selected = type == value, onClick = { type = value; page = 1 }, label = { Text(label) })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            TvDropdown("Жанр", genre.ifBlank { "Все" }, listOf("Все") + genres) { genre = if (it == "Все") "" else it; page = 1 }
            TvDropdown("Сортировка", tvSortLabel(sort), listOf("По популярности", "По рейтингу", "Сначала новые", "По году", "По названию")) {
                sort = when (it) { "По популярности" -> "popular"; "По рейтингу" -> "rating"; "Сначала новые" -> "new"; "По году" -> "year"; else -> "title" }
                page = 1
            }
            Spacer(Modifier.weight(1f))
            Text("${result?.total ?: 0} карточек", color = TvMuted)
        }
        if (loading && result == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Accent) }
        else if (error != null && result == null) Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Не удалось загрузить каталог: $error", color = Color(0xFFFFB36B))
            TvFocusButton("Повторить", { scope.launch { runCatching { CineVaultApi.catalog(page, query, type, genre, sort) }.onSuccess { result = it; error = null }.onFailure { error = it.message } } })
        }
        else LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 176.dp),
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(vertical = 8.dp, horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) { items(result?.items.orEmpty(), key = { it.id }) { TvPosterCard(it, onClick = { onOpen(it) }) } }
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
            TvFocusButton("Назад", { if ((result?.page ?: 1) > 1) page = (result?.page ?: page) - 1 })
            Text("Страница ${result?.page ?: page} из ${result?.pages ?: 1}", color = TvMuted)
            TvFocusButton("Дальше", { if ((result?.page ?: 1) < (result?.pages ?: 1)) page = (result?.page ?: page) + 1 })
        }
    }
}

@Composable
private fun TvDropdown(label: String, selected: String, options: List<String>, onPick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TvFocusButton("$label: $selected", { expanded = true })
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option -> DropdownMenuItem(text = { Text(option) }, onClick = { expanded = false; onPick(option) }) }
        }
    }
}

private fun tvSortLabel(value: String) = when (value) {
    "popular" -> "По популярности"; "new" -> "Сначала новые"; "year" -> "По году"; "title" -> "По названию"; else -> "По рейтингу"
}

@Composable
private fun TvPosterCard(title: CatalogTitle, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(
        Modifier.width(176.dp)
            .onFocusChanged { focused = it.isFocused }
            .focusable()
            .clickable(onClick = onClick)
            .graphicsLayer { val scale = if (focused) 1.045f else 1f; scaleX = scale; scaleY = scale },
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(
            Modifier.fillMaxWidth().height(248.dp).clip(RoundedCornerShape(14.dp))
                .background(TvSurface)
                .then(if (focused) Modifier.background(Accent.copy(alpha = 0.15f)) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            if (!title.poster.isNullOrBlank()) AsyncImage(model = title.poster, contentDescription = title.title, modifier = Modifier.fillMaxSize())
            else Text(title.title.take(1), color = Accent, fontSize = 42.sp, fontWeight = FontWeight.Bold)
        }
        Text(title.title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text("${title.year} · КП ${"%.1f".format(title.rating)}", color = TvMuted, fontSize = 13.sp, maxLines = 1)
    }
}

@Composable
private fun TvDetail(initial: CatalogTitle, onBack: () -> Unit, onPlay: (TvPlayback) -> Unit) {
    var title by remember(initial.id) { mutableStateOf(initial) }
    var voices by remember(initial.id) { mutableStateOf(emptyList<VoiceOption>()) }
    var loading by remember(initial.id) { mutableStateOf(true) }
    var error by remember(initial.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(initial.id) {
        loading = true
        runCatching { CineVaultApi.title(initial.id) }
            .onSuccess { title = it }
            .onFailure { error = it.message }
        title.kinopoiskId?.let { id -> runCatching { CineVaultApi.allohaOptions(id) }.onSuccess { voices = it } }
        loading = false
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(28.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.width(220.dp).height(320.dp).clip(RoundedCornerShape(18.dp)).background(TvSurface), contentAlignment = Alignment.Center) {
                    if (!title.poster.isNullOrBlank()) AsyncImage(title.poster, title.title, Modifier.fillMaxSize()) else Text(title.title.take(1), color = Accent, fontSize = 52.sp)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(title.title, fontSize = 36.sp, fontWeight = FontWeight.Bold)
                    Text("${title.year} · ${if (title.kind == "series") "Сериал" else "Фильм"} · КП ${"%.1f".format(title.rating)} · ${title.votes} оценок", color = TvMuted, fontSize = 18.sp)
                    if (title.genres.isNotEmpty()) Text(title.genres.joinToString(" · "), color = Accent, fontSize = 17.sp)
                    Text(title.description.ifBlank { "Описание пока не добавлено." }, color = TvMuted, fontSize = 18.sp, maxLines = 5, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvFocusButton("← Назад", onBack)
                        title.kinopoiskId?.let { kinopoiskId ->
                            TvFocusButton(if (loading) "Ищу озвучки…" else "Обновить Alloha", onClick = {
                                scope.launch { loading = true; runCatching { CineVaultApi.allohaOptions(kinopoiskId) }.onSuccess { voices = it }.onFailure { error = it.message }; loading = false }
                            })
                        }
                    }
                    error?.let { Text("Ошибка: $it", color = Color(0xFFFFB36B)) }
                }
            }
        }
        if (title.sources.any { !it.isEmbed }) item { Text("Онлайн-плеер CineVault", fontSize = 24.sp, fontWeight = FontWeight.Bold) }
        items(title.sources.filter { !it.isEmbed }, key = { "native-${it.id}" }) { source ->
            TvFocusButton("Смотреть · ${source.label.ifBlank { "Оригинал" }}", onClick = {
                scope.launch {
                    val latest = title.kinopoiskId?.let { runCatching { CineVaultApi.refreshPlayback(it) }.getOrNull() } ?: title
                    val refreshed = latest.sources.firstOrNull { it.id == source.id }
                        ?: latest.sources.firstOrNull { it.voice == source.voice && it.quality == source.quality }
                        ?: source
                    onPlay(TvPlayback(latest, source = refreshed))
                }
            })
        }
        if (voices.isNotEmpty()) item { Text("Alloha · озвучки", fontSize = 24.sp, fontWeight = FontWeight.Bold) }
        items(voices, key = { "voice-${it.id}" }) { voice -> TvFocusButton("Смотреть · ${voice.name}${voice.quality.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty()}", onClick = { onPlay(TvPlayback(title, voice = voice)) }) }
        if (loading) item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), color = Accent); Text("Загружаю доступные источники…", color = TvMuted) } }
        if (title.sources.isEmpty() && voices.isEmpty() && !loading) item { Text("Для этой карточки пока нет онлайн-источников.", color = TvMuted) }
        item { Spacer(Modifier.height(18.dp)) }
    }
}
