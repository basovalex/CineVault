package com.cinevault.android

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import kotlinx.coroutines.delay

/**
 * «Трейлер», as on the site: Rutube trailers found by our server. Rutube's own stream plays on Media3,
 * so the remote works as in the film player: OK pauses, arrows wind, down shows the other trailers.
 */
@Composable
fun TvTrailerScreen(item: TvItem, onBack: () -> Unit) {
    val context = LocalContext.current
    var trailers by remember { mutableStateOf<List<TvTrailer>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var current by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var controls by remember { mutableStateOf(false) }
    var touched by remember { mutableLongStateOf(0L) }
    var position by remember { mutableDoubleStateOf(0.0) }
    var duration by remember { mutableDoubleStateOf(0.0) }
    var playing by remember { mutableStateOf(true) }
    val rootFocus = remember { FocusRequester() }
    val listFocus = remember { FocusRequester() }
    val player = remember {
        val http = DefaultHttpDataSource.Factory().setUserAgent("CineVault Android TV/1.0").setAllowCrossProtocolRedirects(true)
        buildExoPlayer(context, DefaultDataSource.Factory(context, http)).apply { playWhenReady = true }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) loading = false
                if (state == Player.STATE_ENDED) {
                    val next = current + 1
                    if (next < (trailers?.size ?: 0)) current = next else controls = true
                }
            }
            override fun onPlayerError(failure: PlaybackException) { loading = false; error = "Этот трейлер не воспроизводится. Выберите другой ниже." ; controls = true }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener); player.release() }
    }
    LaunchedEffect(item.id) {
        trailers = runCatching { Tmdb.trailers(item) }.onFailure { failed = true }.getOrDefault(emptyList())
        delay(100); runCatching { rootFocus.requestFocus() }
    }
    LaunchedEffect(trailers, current) {
        val list = trailers ?: return@LaunchedEffect
        val trailer = list.getOrNull(current) ?: return@LaunchedEffect
        loading = true; error = null
        val stream = runCatching { Tmdb.rutubeStream(trailer.id) }.getOrDefault("")
        if (stream.isBlank()) { loading = false; error = "Rutube не отдал этот трейлер. Выберите другой ниже."; controls = true; return@LaunchedEffect }
        player.setMediaItem(MediaItem.Builder().setUri(stream).setMimeType(MimeTypes.APPLICATION_M3U8).build())
        player.prepare()
        player.playWhenReady = true
    }
    LaunchedEffect(player) {
        while (true) {
            position = player.currentPosition / 1000.0
            duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.div(1000.0) ?: 0.0
            playing = player.playWhenReady
            delay(400)
        }
    }
    LaunchedEffect(controls, touched, playing) {
        if (!controls || !playing || error != null) return@LaunchedEffect
        delay(5_000); controls = false
    }
    LaunchedEffect(controls) {
        if (controls) { delay(120); runCatching { listFocus.requestFocus() } } else runCatching { rootFocus.requestFocus() }
    }
    BackHandler(enabled = controls) { controls = false }
    BackHandler(enabled = !controls) { onBack() }

    Box(
        Modifier.fillMaxSize().background(Color.Black).focusRequester(rootFocus).focusable().onPreviewKeyEvent { event ->
            touched = System.currentTimeMillis()
            if (controls) return@onPreviewKeyEvent false
            val down = event.type == KeyEventType.KeyDown
            when (event.key) {
                Key.DirectionLeft, Key.DirectionRight, Key.MediaFastForward, Key.MediaRewind -> {
                    if (down) {
                        val step = if (event.key == Key.DirectionRight || event.key == Key.MediaFastForward) 10_000L else -10_000L
                        player.seekTo((player.currentPosition + step).coerceAtLeast(0))
                    }
                    true
                }
                Key.DirectionCenter, Key.Enter, Key.NumPadEnter, Key.MediaPlayPause -> {
                    if (down && event.nativeKeyEvent.repeatCount == 0) { player.playWhenReady = !player.playWhenReady; controls = true }
                    true
                }
                Key.DirectionUp, Key.DirectionDown -> { if (down) controls = true; true }
                else -> false
            }
        },
    ) {
        PlayerSurface(player, "contain")
        val list = trailers
        when {
            list == null || (loading && error == null) -> Column(Modifier.fillMaxSize().background(Color.Black)) {
                Box(Modifier.fillMaxSize()) {
                    TvImage(Tmdb.image(item.backdrop, "w1280"), "", Modifier.fillMaxSize().graphicsLayer { alpha = 0.3f })
                    Column(Modifier.align(Alignment.BottomStart).padding(48.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        HText("Трейлер", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                        HText(item.title, size = Hall.S3, weight = FontWeight.Bold, display = true, maxLines = 1)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Spinner(24.dp); Spacer(Modifier.width(12.dp))
                            HText(if (list == null) "Ищу трейлер на Rutube…" else "Загружаю трейлер: ${list.getOrNull(current)?.title.orEmpty()}", size = Hall.S1, color = Hall.Text2, maxLines = 1)
                        }
                    }
                }
            }
            list.isEmpty() -> Box(Modifier.fillMaxSize().background(Hall.Bg)) {
                EmptyBlock("Трейлер не нашёлся", if (failed) "Сервер с трейлерами не ответил. Попробуйте позже." else "На Rutube нет трейлера к «${item.title}».",
                    Modifier.align(Alignment.Center).padding(48.dp)) { HButton("Назад", onBack, primary = true, focus = listFocus) }
                LaunchedEffect(Unit) { delay(100); runCatching { listFocus.requestFocus() } }
            }
        }
        if (!list.isNullOrEmpty()) AnimatedVisibility(controls, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomCenter)) {
            Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.9f)))).padding(top = 60.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.padding(horizontal = 48.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    HText("Трейлер · ${item.title}", size = Hall.S2, weight = FontWeight.SemiBold, display = true, maxLines = 1)
                    error?.let { HText(it, size = Hall.S0, color = Hall.Gold) }
                    if (duration > 0) {
                        Row { HText(tvClock(position), size = Hall.S0, weight = FontWeight.SemiBold); Spacer(Modifier.weight(1f)); HText(tvClock(duration), size = Hall.S0, color = Hall.Muted) }
                        Timeline(position, duration)
                    }
                }
                LazyRow(contentPadding = PaddingValues(horizontal = 48.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        HButton(if (playing) "Пауза" else "Смотреть", { player.playWhenReady = !player.playWhenReady },
                            icon = if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, focus = if (list.size == 1 || error == null) listFocus else null)
                    }
                    itemsIndexed(list) { index, trailer ->
                        val (interaction, focused) = rememberFocused()
                        Column(Modifier.width(260.dp).then(if (list.size > 1 && error != null && index == (current + 1) % list.size) Modifier.focusRequester(listFocus) else Modifier)
                            .hallFocus(RoundedCornerShape(Hall.R), interaction = interaction) { current = index; controls = false }
                            .background(if (focused) Hall.Text else if (index == current) Hall.Surface3 else Hall.SurfaceGlass).padding(12.dp)) {
                            HText(trailer.title, size = Hall.S0, color = if (focused) Hall.Bg else Hall.Text, weight = FontWeight.SemiBold, maxLines = 2)
                            HText(listOfNotNull(trailer.author, trailer.duration.takeIf { it > 0 }?.let { tvClock(it.toDouble()) }, if (index == current) "сейчас" else null).joinToString(" · "),
                                size = Hall.S_1, color = if (focused) Hall.Bg.copy(alpha = 0.7f) else Hall.Muted, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}
