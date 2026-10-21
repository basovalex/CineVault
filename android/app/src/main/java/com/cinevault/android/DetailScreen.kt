package com.cinevault.android

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** A way to watch a title: CineVault's own stream, Alloha with its voices, or another embed. */
private data class PlayerChoice(val id: String, val name: String, val provider: PlayerProvider? = null)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DetailScreen(initial: CatalogTitle, onBack: () -> Unit, onOpen: (CatalogTitle) -> Unit, onPlay: (PlayRequest) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var item by remember(initial.id) { mutableStateOf(initial) }
    var providers by remember(initial.id) { mutableStateOf<List<PlayerProvider>>(emptyList()) }
    var providersLoading by remember(initial.id) { mutableStateOf(true) }
    var similar by remember(initial.id) { mutableStateOf<List<CatalogTitle>>(emptyList()) }
    var choiceId by remember(initial.id) { mutableStateOf<String?>(null) }
    var voiceName by remember(initial.id) { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf(false) }
    var tab by remember(initial.id) { mutableIntStateOf(0) }
    var starting by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(initial.id) {
        runCatching { CineVaultApi.title(initial.id) }.onSuccess { item = it }
        val genre = item.genres.firstOrNull().orEmpty()
        similar = runCatching { CineVaultApi.catalog(1, "", item.kind, genre, "popular").items.filter { it.id != item.id }.take(15) }.getOrDefault(emptyList())
    }
    LaunchedEffect(item.kinopoiskId, reload) {
        val id = item.kinopoiskId ?: run { providersLoading = false; return@LaunchedEffect }
        providersLoading = true
        providers = runCatching { CineVaultApi.playerProviders(id) }.getOrDefault(providers)
        providersLoading = false
    }

    val choices = buildList {
        if (item.sources.any { !it.isEmbed }) add(PlayerChoice("cinevault", "CineVault"))
        providers.forEach { add(PlayerChoice(it.id, it.name, it)) }
    }
    val last = CineStore.lastWatch(item.id)
    val choice = choices.firstOrNull { it.id == choiceId } ?: choices.firstOrNull { it.id == last?.providerId } ?: choices.firstOrNull()
    val voices: List<String> = when {
        choice?.id == "cinevault" -> item.sources.filter { !it.isEmbed }.map { it.label.ifBlank { "Оригинал" } }.distinct()
        choice?.provider?.translations?.isNotEmpty() == true -> choice.provider.translations.map { it.name }
        else -> emptyList()
    }
    val voice = voices.firstOrNull { it == voiceName } ?: voices.firstOrNull { it == last?.translationName } ?: voices.firstOrNull()

    fun play() {
        val selected = choice ?: return
        when {
            selected.id == "cinevault" -> scope.launch {
                starting = true
                // The server may take a while to re-check a link; the one we already have is usually still good,
                // and the player asks for a fresh one itself if it is not. The request is a job of its own because
                // a blocking call cannot be cut short: we simply stop waiting for it.
                val refresh = item.kinopoiskId?.let { id -> async { runCatching { CineVaultApi.refreshPlayback(id) }.getOrNull() } }
                val fresh = refresh?.let { withTimeoutOrNull(4_000) { it.await() } } ?: item
                val sources = fresh.sources.filter { !it.isEmbed }.ifEmpty { item.sources.filter { !it.isEmbed } }
                val source = sources.firstOrNull { it.label.ifBlank { "Оригинал" } == voice } ?: sources.firstOrNull()
                starting = false
                if (source != null) {
                    CineStore.recordOpened(item, "cinevault", voice)
                    onPlay(PlayRequest(item, source = source, providerName = "CineVault"))
                }
            }
            selected.provider?.translations?.isNotEmpty() == true -> {
                val translation = selected.provider.translations.firstOrNull { it.name == voice } ?: selected.provider.translations.first()
                CineStore.recordOpened(item, selected.id, translation.name)
                onPlay(PlayRequest(item, embedUrl = translation.url, providerName = selected.name))
            }
            selected.provider?.embedUrl != null -> {
                CineStore.recordOpened(item, selected.id)
                val voicesText = selected.provider.voices.take(8).joinToString(", ")
                val hint = (if (voicesText.isBlank()) "Озвучка выбирается внутри плеера." else "Озвучки внутри плеера: $voicesText.") + if (item.isSeries) " Сезон и серию — тоже там." else ""
                onPlay(PlayRequest(item, embedUrl = selected.provider.embedUrl, providerName = selected.name, hint = hint))
            }
        }
    }

    // The tab bar floats over the end of the card, so leave room for it.
    LazyColumn(Modifier.fillMaxSize().background(Cine.Background), contentPadding = PaddingValues(bottom = 110.dp)) {
        item {
            Box(Modifier.fillMaxWidth().height(380.dp)) {
                BackdropArt(item, Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Cine.Background.copy(alpha = 0.5f), 0.3f to Color.Transparent, 0.7f to Cine.Background.copy(alpha = 0.6f), 1f to Cine.Background)))
                Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    OverlayButton(Icons.AutoMirrored.Filled.ArrowBack, "Назад", onBack)
                    Spacer(Modifier.weight(1f))
                    val favorite = CineStore.isFavorite(item.id)
                    OverlayButton(if (favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (favorite) "Убрать из избранного" else "В избранное", { CineStore.toggleFavorite(item) })
                    Spacer(Modifier.width(10.dp))
                    OverlayButton(Icons.Default.Share, "Поделиться", {
                        val url = BuildConfig.SERVER_URL.trimEnd('/') + "/title/${item.id}/"
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "${item.title} — $url"), null))
                    })
                }
            }
        }
        item {
            Column(Modifier.offset(y = (-64).dp).padding(horizontal = Cine.Gutter), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                TitleLogo(item, maxWidth = 240.dp, maxHeight = 70.dp, fontSize = 30)
                MetaLine(item, withAge = true)
                if (item.tagline.isNotBlank()) Text(item.tagline, color = Cine.Muted, fontStyle = FontStyle.Italic, fontSize = 15.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    when {
                        choice != null -> PrimaryButton(if (starting) "Загружаю…" else if (last != null) "Продолжить" else "Смотреть", { if (!starting) play() }, Modifier.weight(1f), Icons.Default.PlayArrow)
                        providersLoading -> Box(Modifier.weight(1f).heightIn(min = 50.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Cine.Accent) }
                        else -> SecondaryButton("Нет плееров · обновить", { reload++ }, Modifier.weight(1f), Icons.Default.Refresh)
                    }
                    val favorite = CineStore.isFavorite(item.id)
                    SecondaryButton(if (favorite) "В избранном" else "В избранное", { CineStore.toggleFavorite(item) }, Modifier.weight(1f), if (favorite) Icons.Default.Check else Icons.Default.Add)
                }
                if (choices.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        PickerBox("Плеер", choice?.name ?: "", choices.map { it.name }, Modifier.weight(1f)) { name ->
                            choiceId = choices.firstOrNull { it.name == name }?.id; voiceName = null
                        }
                        PickerBox("Озвучка", voice ?: "В плеере", voices, Modifier.weight(1f)) { voiceName = it }
                    }
                }
                if (item.description.isNotBlank()) {
                    var more by remember { mutableStateOf(false) }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(item.description, color = Cine.TextSoft, fontSize = 15.sp, lineHeight = 21.sp, maxLines = if (more) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis)
                        if (!more && item.description.length > 180) Text("Ещё", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { more = true })
                    }
                }
                if (item.genres.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { item.genres.forEach { GenrePill(it) } }
                if (item.isSeries && item.seasons.isNotEmpty()) {
                    var season by remember(item.id) { mutableIntStateOf(0) }
                    Text("Сезоны", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(item.seasons.indices.toList()) { index -> CineChip("Сезон ${index + 1}", season == index) { season = index } }
                    }
                    Text("${item.seasons.getOrNull(season) ?: 0} серий · выберите серию в плеере", color = Cine.Muted, fontSize = 14.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    listOf("Похожие", "Актёры", if (item.isSeries) "О сериале" else "О фильме").forEachIndexed { index, label ->
                        Column(Modifier.clickable { tab = index }, horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(label, color = if (tab == index) Color.White else Cine.Muted, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                            Box(Modifier.padding(top = 6.dp).width(40.dp).height(2.dp).background(if (tab == index) Cine.Accent else Color.Transparent))
                        }
                    }
                }
                when (tab) {
                    0 -> if (similar.isEmpty()) Text("Подбираю похожие…", color = Cine.Muted) else LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(similar, key = { it.id }) { title -> PosterCard(title, { onOpen(title) }, width = 118.dp) }
                    }
                    1 -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (item.actors.isEmpty()) Text("Нет данных об актёрах", color = Cine.Muted)
                        item.actors.take(15).forEach { name ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Box(Modifier.width(42.dp).height(42.dp).clip(CircleShape).background(Cine.Surface2), contentAlignment = Alignment.Center) {
                                    Text(name.split(" ").mapNotNull { it.firstOrNull()?.toString() }.take(2).joinToString(""), color = Cine.TextSoft, fontWeight = FontWeight.SemiBold)
                                }
                                Text(name, color = Color.White, fontSize = 15.sp)
                            }
                        }
                    }
                    else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        listOfNotNull(
                            item.originalTitle.takeIf { it.isNotBlank() && it != item.title }?.let { "Оригинал" to it },
                            item.year.takeIf { it > 0 }?.let { "Год" to it.toString() },
                            item.countries.takeIf { it.isNotEmpty() }?.let { "Страна" to it.joinToString(", ") },
                            item.directors.takeIf { it.isNotEmpty() }?.let { "Режиссёр" to it.joinToString(", ") },
                            item.runtime.takeIf { it > 0 && !item.isSeries }?.let { "Длительность" to "$it мин" },
                            item.ageRating.takeIf(String::isNotBlank)?.let { "Возраст" to (if (it.endsWith("+")) it else "$it+") },
                            item.votes.takeIf { it > 0 }?.let { "Оценок" to String.format("%,d", it).replace(',', ' ') },
                        ).forEach { (label, value) ->
                            Row { Text(label, color = Cine.Muted, fontSize = 14.sp, modifier = Modifier.width(120.dp)); Text(value, color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerBox(label: String, value: String, options: List<String>, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Cine.Radius)).background(Cine.Surface)
                .border(1.dp, Cine.Line, RoundedCornerShape(Cine.Radius)).clickable(enabled = options.size > 1) { open = true }
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, color = Cine.Muted, fontSize = 12.sp)
                Text(value, color = Color.White, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (options.size > 1) Icon(Icons.Default.KeyboardArrowDown, null, tint = Cine.Muted)
        }
        DropdownMenu(open, { open = false }, Modifier.background(Cine.Surface2)) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option, color = if (option == value) Cine.Accent else Color.White) },
                    onClick = { open = false; onPick(option) },
                    trailingIcon = if (option == value) ({ Icon(Icons.Default.Check, null, tint = Cine.Accent) }) else null,
                )
            }
        }
    }
}
