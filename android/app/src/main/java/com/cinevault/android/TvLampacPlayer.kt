@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.cinevault.android

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** An IntroDB mark: intro, recap or credits (outro), in seconds. */
data class SkipSegment(val type: String, val start: Double, val end: Double)

private enum class PlayerPanel { LIST, VOICES, QUALITY, SUBTITLES }

private val SEGMENT_LABELS = mapOf("intro" to "Пропустить интро", "recap" to "Пропустить пересказ", "outro" to "Пропустить титры")
private const val NEXT_COUNTDOWN = 10

/** Marks of an episode (a film is season 0, episode 0), through our server, which asks IntroDB and caches. */
private suspend fun skipSegments(imdb: String, season: Int, episode: Int): List<SkipSegment> {
    if (imdb.isBlank()) return emptyList()
    val json = JSONObject(TvNet.get("${TvNet.server}/api/skip-segments?imdb=$imdb&season=$season&episode=$episode", 10_000))
    return json.optJSONArray("segments").objects().map { SkipSegment(it.optString("type"), it.optDouble("start"), it.optDouble("end")) }.filter { it.end > it.start }
}

/** The quality to start on: the one chosen before (or the nearest below), else the best up to 1080p. */
private fun pickQuality(stream: LampacStream): Pair<String, String> {
    val labels = stream.qualities.keys.sortedByDescending(Lampac::lines)
    if (labels.isEmpty()) return "" to stream.url
    val wanted = TvState.preferredLines.takeIf { it > 0 } ?: 1080
    val label = labels.firstOrNull { Lampac.lines(it) <= wanted } ?: labels.last()
    return label to (stream.qualities[label] ?: stream.url)
}

@Composable
private fun PlayerSurface(player: Player) {
    AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
        PlayerView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            useController = false
            isFocusable = false
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(android.graphics.Color.BLACK)
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
            this.player = player
        }
    }, update = { it.player = player })
}

/**
 * The CineVault player on a Lampac list, as the site's lampac-player.js: the stream on Media3 (the TV's
 * hardware decoder), the app's own controls, IntroDB skip buttons that are only offered, the next-episode
 * card with its still from the start of the credits, and the episode list with stills.
 */
@Composable
fun TvLampacPlayer(request: LampacPlay, onBack: () -> Unit, chooseSource: (Int, Int) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val item = request.item
    var index by remember { mutableIntStateOf(request.index) }
    var stream by remember { mutableStateOf(request.first) }
    var voice by remember { mutableStateOf(request.voice) }
    var qualityLabel by remember { mutableStateOf("") }
    var segments by remember { mutableStateOf<List<SkipSegment>>(emptyList()) }
    var stills by remember { mutableStateOf<Map<String, TvEpisode>>(emptyMap()) }
    var connecting by remember { mutableStateOf(true) }
    var buffering by remember { mutableStateOf(true) }
    var slowSource by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var controls by remember { mutableStateOf(false) }
    var panel by remember { mutableStateOf<PlayerPanel?>(null) }
    var touched by remember { mutableLongStateOf(0L) }
    var position by remember { mutableDoubleStateOf(0.0) }
    var duration by remember { mutableDoubleStateOf(0.0) }
    var playing by remember { mutableStateOf(true) }
    var pendingSeek by remember { mutableIntStateOf(0) }
    var nextHiddenFor by remember { mutableIntStateOf(-1) }
    var osd by remember { mutableStateOf("") }
    var subtitle by remember { mutableIntStateOf(-1) }
    val rootFocus = remember { FocusRequester() }
    val timelineFocus = remember { FocusRequester() }
    val nextFocus = remember { FocusRequester() }
    val sourceFocus = remember { FocusRequester() }
    val firstButton = remember { FocusRequester() }

    var entries by remember { mutableStateOf(request.entries) }
    var voices by remember { mutableStateOf(request.voices) }
    var voiceBusy by remember { mutableStateOf(false) }
    /** «Другой источник» opens «Где смотреть» on the episode playing now. */
    val onChooseSource: () -> Unit = { val now = entries[index]; chooseSource(if (request.isMovie) 0 else now.season, if (request.isMovie) 0 else now.episode) }
    val entry = entries[index]
    val hasNext = !request.isMovie && index + 1 < entries.size
    val episodeOf = { at: Int -> entries.getOrNull(at)?.let { stills["${it.season}-${it.episode}"] } }

    val player = remember {
        val http = DefaultHttpDataSource.Factory().setUserAgent("CineVault Android TV/1.0").setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000).setReadTimeoutMs(20_000)
        buildExoPlayer(context, DefaultDataSource.Factory(context, http)).apply { playWhenReady = true }
    }

    fun saveProgress(completed: Boolean = false) {
        val length = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: return
        val now = entries[index]
        TvState.saveProgress(item, if (request.isMovie) 0 else now.season, if (request.isMovie) 0 else now.episode, player.currentPosition / 1000.0, length / 1000.0, completed)
    }

    fun load(url: String, startAt: Double) {
        connecting = true; buffering = true; slowSource = false; failure = null
        val builder = MediaItem.Builder().setUri(url)
        if (url.substringBefore('?').endsWith(".m3u8", true) || url.contains("m3u8")) builder.setMimeType(MimeTypes.APPLICATION_M3U8)
        builder.setSubtitleConfigurations(stream.subtitles.mapIndexed { number, (label, link) ->
            MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(link)).setLabel(label.ifBlank { "Субтитры ${number + 1}" })
                .setMimeType(if (link.substringBefore('?').endsWith(".srt", true)) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT).build()
        })
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subtitle < 0).build()
        player.setMediaItem(builder.build(), (startAt * 1000).toLong().coerceAtLeast(0))
        player.prepare()
        player.playWhenReady = true
    }

    fun startCurrent(resume: Boolean) {
        val (label, url) = pickQuality(stream)
        qualityLabel = label
        val now = entries[index]
        val saved = if (resume) TvState.progressOf(item.id, if (request.isMovie) 0 else now.season, if (request.isMovie) 0 else now.episode) else null
        val startAt = if (request.isMovie && !resume) position else saved?.takeIf { !it.completed && it.position > 15 && it.position < it.duration - 60 }?.position ?: 0.0
        load(url, startAt)
    }

    fun goTo(target: Int) {
        if (target !in entries.indices) return
        saveProgress()
        val keep = if (request.isMovie) player.currentPosition / 1000.0 else 0.0
        index = target
        panel = null; controls = false
        connecting = true; buffering = true; segments = emptyList()
        scope.launch {
            val next = runCatching { Lampac.stream(entries[target].entry) }.getOrNull()
            if (next == null || next.url.isBlank()) { failure = "Не удалось открыть эту серию. Попробуйте ещё раз или выберите другую озвучку."; return@launch }
            stream = next
            if (request.isMovie) { voice = entries[target].label; TvState.rememberLampacChoice(item.id, voice = voice); position = keep }
            startCurrent(resume = !request.isMovie)
        }
    }

    /**
     * Another voice of this source (a series): its episode list replaces this one, so the next episodes
     * follow the new voice, and the same episode goes on from the same second, as on the site.
     */
    fun switchVoice(choice: JSONObject) {
        val url = choice.optString("url")
        val name = choice.optString("name")
        if (url.isBlank() || voiceBusy) return
        val now = entries[index]
        val at = player.currentPosition / 1000.0
        voiceBusy = true
        panel = null; controls = false
        osd = "Переключаю озвучку на «$name»…"
        scope.launch {
            try {
                val node = Lampac.node(url)?.takeIf { it.type == "episode" && it.data.isNotEmpty() } ?: throw IllegalStateException("нет серии")
                val fresh = node.data.mapIndexed { position, raw ->
                    val e = raw.optString("e").toIntOrNull() ?: (position + 1)
                    PlayEntry(raw.optString("name").ifBlank { "$e серия" }, raw.optString("s").toIntOrNull() ?: now.season, e, raw)
                }
                val target = fresh.indexOfFirst { it.season == now.season && it.episode == now.episode }
                if (target < 0) throw IllegalStateException("в этой озвучке нет ${now.episode} серии")
                val next = Lampac.stream(fresh[target].entry)
                if (next.url.isBlank()) throw IllegalStateException("источник не отдал ссылку")
                saveProgress()
                entries = fresh
                index = target
                voices = node.voices
                voice = name
                stream = next
                TvState.rememberLampacChoice(item.id, source = request.sourceId.takeIf(String::isNotBlank), voice = name)
                val (label, link) = pickQuality(next)
                qualityLabel = label
                load(link, at)
                osd = "Озвучка: $name"
            } catch (error: Exception) {
                osd = "Озвучка не переключилась: ${error.message}"
            } finally {
                voiceBusy = false
            }
        }
    }

    // First start, resume from the second it was left at.
    LaunchedEffect(Unit) { TvState.rememberHistory(item); startCurrent(resume = true); delay(100); runCatching { rootFocus.requestFocus() } }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING || state == Player.STATE_IDLE
                if (state == Player.STATE_READY) { connecting = false; slowSource = false }
                if (state == Player.STATE_ENDED) {
                    saveProgress(completed = true)
                    if (!request.isMovie && index + 1 < entries.size) goTo(index + 1) else controls = true
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = player.playWhenReady }
            override fun onPlayerError(error: PlaybackException) {
                // A quality that will not play: the next one down, then the stream as given.
                val labels = stream.qualities.keys.sortedByDescending(Lampac::lines)
                val lower = labels.dropWhile { it != qualityLabel }.drop(1).firstOrNull()
                val at = player.currentPosition / 1000.0
                if (lower != null) { qualityLabel = lower; load(stream.qualities[lower]!!, at); osd = "Пробую $lower" }
                else failure = "Видео не воспроизводится (${error.errorCodeName}). Можно выбрать другой источник или озвучку."
            }
        }
        player.addListener(listener)
        onDispose { saveProgress(); player.removeListener(listener); player.release() }
    }
    LaunchedEffect(player) {
        var lastSave = 0L
        while (true) {
            position = player.currentPosition / 1000.0
            duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.div(1000.0) ?: 0.0
            playing = player.playWhenReady
            if (System.currentTimeMillis() - lastSave > 5_000 && player.isPlaying) { saveProgress(); lastSave = System.currentTimeMillis() }
            delay(400)
        }
    }
    // A source that takes long to connect: say so and offer another one.
    LaunchedEffect(connecting, index, stream) {
        if (!connecting) return@LaunchedEffect
        delay(9_000)
        if (connecting) slowSource = true
    }
    LaunchedEffect(slowSource) { if (slowSource) { delay(100); runCatching { sourceFocus.requestFocus() } } }
    // IntroDB marks for this episode; TMDB names and stills for the list and the next-episode card.
    LaunchedEffect(index) {
        segments = emptyList()
        val imdb = runCatching { Tmdb.imdbId(item) }.getOrDefault("")
        val now = entries[index]
        segments = runCatching { skipSegments(imdb, if (request.isMovie) 0 else now.season, if (request.isMovie) 0 else now.episode) }.getOrDefault(emptyList())
    }
    LaunchedEffect(Unit) {
        if (request.isMovie || item.tmdbId == 0) return@LaunchedEffect
        val all = mutableMapOf<String, TvEpisode>()
        entries.map { it.season }.distinct().forEach { season ->
            runCatching { Tmdb.episodes(item.tmdbId, season) }.getOrNull()?.forEach { all["${it.season}-${it.number}"] = it }
        }
        stills = all
    }
    // A held arrow adds up into one seek once the keys settle.
    LaunchedEffect(pendingSeek) {
        if (pendingSeek == 0) return@LaunchedEffect
        delay(350)
        val length = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: Long.MAX_VALUE
        player.seekTo((player.currentPosition + pendingSeek * 1000L).coerceIn(0, length - 1_000))
        pendingSeek = 0
    }
    LaunchedEffect(controls, touched, panel, playing) {
        if (!controls || panel != null || !playing) return@LaunchedEffect
        delay(6_000)
        controls = false
    }
    LaunchedEffect(controls, panel) {
        if (panel != null) return@LaunchedEffect
        if (controls) { delay(120); runCatching { timelineFocus.requestFocus() } } else runCatching { rootFocus.requestFocus() }
    }

    // Like the site: «Пропустить интро» while the intro runs; credits of a series are covered by the next-episode card.
    val activeSegment = segments.firstOrNull { position >= it.start && position < minOf(it.end, if (duration > 0) duration else it.end) - 1 && !(it.type == "outro" && hasNext) }
    val outro = segments.firstOrNull { it.type == "outro" && it.start > duration * 0.5 }
    val creditsAt = outro?.start ?: (duration - (duration * 0.04).coerceIn(30.0, 90.0))
    val showNext = hasNext && duration > 300 && position >= creditsAt && nextHiddenFor != index && !connecting
    LaunchedEffect(showNext) { if (showNext && !controls) { delay(150); runCatching { nextFocus.requestFocus() } } }

    fun toggle() { player.playWhenReady = !player.playWhenReady; if (player.playbackState == Player.STATE_ENDED) player.seekTo(0) }
    fun skipSegment() {
        val segment = activeSegment ?: return
        player.seekTo((minOf(segment.end, duration - 0.5) * 1000).toLong())
        osd = if (segment.type == "recap") "Пересказ пропущен" else if (segment.type == "outro") "Титры пропущены" else "Интро пропущено"
    }
    LaunchedEffect(osd) { if (osd.isNotEmpty()) { delay(1_600); osd = "" } }

    BackHandler(enabled = panel != null) { panel = null }
    BackHandler(enabled = panel == null && controls) { controls = false }
    BackHandler(enabled = panel == null && !controls && showNext) { nextHiddenFor = index; runCatching { rootFocus.requestFocus() } }
    BackHandler(enabled = panel == null && !controls && !showNext) { onBack() }

    Box(
        Modifier.fillMaxSize().background(Color.Black).focusRequester(rootFocus).focusable().onPreviewKeyEvent { event ->
            touched = System.currentTimeMillis()
            val down = event.type == KeyEventType.KeyDown
            val ok = event.key == Key.DirectionCenter || event.key == Key.Enter || event.key == Key.NumPadEnter
            when {
                panel != null || slowSource || failure != null -> false
                event.key == Key.MediaPlayPause || event.key == Key.MediaPlay || event.key == Key.MediaPause -> { if (down && event.nativeKeyEvent.repeatCount == 0) { toggle(); controls = true }; true }
                event.key == Key.MediaNext || event.key == Key.ChannelUp -> { if (down && hasNext) goTo(index + 1); true }
                event.key == Key.MediaPrevious || event.key == Key.ChannelDown -> { if (down && index > 0 && !request.isMovie) goTo(index - 1); true }
                event.key == Key.MediaFastForward -> { if (down) pendingSeek += 30; true }
                event.key == Key.MediaRewind -> { if (down) pendingSeek -= 30; true }
                controls -> false
                showNext -> false
                event.key == Key.DirectionLeft || event.key == Key.DirectionRight -> {
                    if (down) { val step = if (event.nativeKeyEvent.repeatCount > 2) 30 else 10; pendingSeek += if (event.key == Key.DirectionRight) step else -step }
                    true
                }
                ok && activeSegment != null -> { if (down && event.nativeKeyEvent.repeatCount == 0) skipSegment(); true }
                ok || event.key == Key.DirectionUp || event.key == Key.DirectionDown -> { if (down && event.nativeKeyEvent.repeatCount == 0) controls = true; true }
                else -> false
            }
        },
    ) {
        PlayerSurface(player)

        val place = if (!request.isMovie) "${entry.season} сезон, ${entry.label}" else ""
        val name = episodeOf(index)?.name.orEmpty()

        // Winding with the controls hidden: the time it lands on, large, over a slim bar.
        if (pendingSeek != 0 && !controls && duration > 0) {
            val target = (position + pendingSeek).coerceIn(0.0, duration)
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
                .padding(horizontal = 48.dp, vertical = 30.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                HText(tvClock(target), size = Hall.S3, weight = FontWeight.SemiBold, display = true)
                HText(if (pendingSeek > 0) "+$pendingSeek с" else "−${-pendingSeek} с", size = Hall.S0, color = Hall.Text2)
                Timeline(target, duration)
            }
        }
        // Mid-play waiting for data: a small spinner, not the whole screen.
        if (buffering && !connecting && failure == null) Box(Modifier.align(Alignment.Center)) { Spinner(44.dp) }

        // Skip intro / recap / credits: only offered, OK presses it.
        AnimatedVisibility(activeSegment != null && !controls && !connecting, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomEnd).padding(40.dp)) {
            Row(Modifier.clip(RoundedCornerShape(Hall.RLg)).background(Hall.PlayerGlass).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                HText(SEGMENT_LABELS[activeSegment?.type] ?: "Пропустить", size = Hall.S1, weight = FontWeight.SemiBold)
                Spacer(Modifier.width(10.dp))
                Icon(Icons.Default.SkipNext, null, tint = Hall.Text)
                Spacer(Modifier.width(12.dp))
                Badge("OK", color = Hall.OnAccent, background = Hall.Accent)
            }
        }

        // The next episode, from the start of the credits: its still, counting down only over the last seconds.
        AnimatedVisibility(showNext && !controls && panel == null, enter = fadeIn() + slideInHorizontally { it / 3 }, exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomEnd).padding(36.dp)) {
            val next = entries.getOrNull(index + 1)
            val nextInfo = episodeOf(index + 1)
            val rest = ((duration - position) / (player.playbackParameters.speed.takeIf { it > 0 } ?: 1f)).toInt()
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                val (interaction, focused) = rememberFocused()
                Row(Modifier.width(400.dp).focusRequester(nextFocus).hallFocus(RoundedCornerShape(Hall.RLg), interaction = interaction) { goTo(index + 1) }
                    .background(if (focused) Hall.Surface3 else Hall.PlayerGlass).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(150.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(Hall.R)).background(Hall.Surface2), contentAlignment = Alignment.Center) {
                        TvImage(nextInfo?.still.orEmpty(), "", Modifier.fillMaxSize())
                        Box(Modifier.size(36.dp).clip(RoundedCornerShape(50)).background(Hall.Scrim), contentAlignment = Alignment.Center) { Icon(Icons.Default.PlayArrow, null, tint = Hall.Text) }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        HText(if (rest <= NEXT_COUNTDOWN) "Следующая серия · через ${maxOf(0, rest)} с" else "Следующая серия", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
                        HText(nextInfo?.name?.ifBlank { null } ?: next?.label.orEmpty(), size = Hall.S1, weight = FontWeight.SemiBold, maxLines = 2)
                        if (!nextInfo?.name.isNullOrBlank()) HText("${next?.season} сезон, ${next?.label}", size = Hall.S_1, color = Hall.Muted)
                    }
                }
                val (closeInteraction, closeFocused) = rememberFocused()
                Box(Modifier.size(40.dp).hallFocus(RoundedCornerShape(50), interaction = closeInteraction) { nextHiddenFor = index; runCatching { rootFocus.requestFocus() } }
                    .background(if (closeFocused) Hall.Text else Hall.PlayerGlass), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, "Скрыть", tint = if (closeFocused) Hall.Bg else Hall.Text)
                }
            }
        }

        AnimatedVisibility(osd.isNotEmpty(), enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 32.dp)) {
            HText(osd, Modifier.clip(RoundedCornerShape(50)).background(Hall.PlayerGlass).padding(horizontal = 18.dp, vertical = 8.dp), size = Hall.S0, weight = FontWeight.SemiBold)
        }

        // Controls.
        AnimatedVisibility(controls && panel == null, enter = fadeIn() + slideInVertically { it / 6 }, exit = fadeOut() + slideOutVertically { it / 6 }, modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().height(140.dp).background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent))))
                Column(Modifier.padding(start = 48.dp, top = 30.dp, end = 48.dp)) {
                    HText(if (place.isNotBlank()) "${item.title} · $place" else item.title, size = Hall.S2, weight = FontWeight.SemiBold, display = true, maxLines = 1)
                    HText(listOf(name, voice, request.sourceName, qualityLabel.takeUnless { request.sourceName.contains(it) }.orEmpty()).filter(String::isNotBlank).joinToString(" · "), size = Hall.S0, color = Hall.Text2, maxLines = 1)
                }
                Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f))))
                    .padding(horizontal = 48.dp, vertical = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Scrubber(position, duration, pendingSeek, timelineFocus, firstButton, onSeek = { pendingSeek += it; touched = System.currentTimeMillis() }, onToggle = ::toggle)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        HButton(if (playing) "Пауза" else "Смотреть", ::toggle, icon = if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, focus = firstButton)
                        if (activeSegment != null) HButton(SEGMENT_LABELS[activeSegment.type] ?: "Пропустить", { skipSegment() }, primary = true, icon = Icons.Default.SkipNext)
                        if (!request.isMovie && entries.size > 1) HButton("Серии", { panel = PlayerPanel.LIST }, icon = Icons.Default.List)
                        if (request.isMovie && entries.size > 1 || !request.isMovie && voices.size > 1) HButton("Озвучка", { panel = if (request.isMovie) PlayerPanel.LIST else PlayerPanel.VOICES }, icon = Icons.Default.Mic, busy = voiceBusy)
                        if (stream.qualities.size > 1) HButton("Качество${if (qualityLabel.isNotBlank()) " · $qualityLabel" else ""}", { panel = PlayerPanel.QUALITY })
                        if (stream.subtitles.isNotEmpty()) HButton("Субтитры", { panel = PlayerPanel.SUBTITLES })
                        if (hasNext) HButton("Следующая", { goTo(index + 1) }, icon = Icons.Default.SkipNext)
                        HButton("Источник", onChooseSource)
                    }
                }
            }
        }

        // The list: episodes with stills (a series) or voices (a film).
        AnimatedVisibility(panel == PlayerPanel.LIST, enter = fadeIn() + slideInVertically { it / 3 }, exit = fadeOut() + slideOutVertically { it / 3 }, modifier = Modifier.align(Alignment.BottomCenter)) {
            if (request.isMovie) ChoicePanel("Озвучка", entries.map { it.label to it.name }, index) { goTo(it) }
            else EpisodeStrip(item, entries, index, stills) { goTo(it) }
        }
        AnimatedVisibility(panel == PlayerPanel.VOICES, enter = slideInHorizontally { it }, exit = slideOutHorizontally { it }, modifier = Modifier.align(Alignment.CenterEnd)) {
            ChoicePanel("Озвучка", voices.map { it.optString("name") to "" }, voices.indexOfFirst { it.optString("name") == voice }.takeIf { it >= 0 } ?: voices.indexOfFirst { it.optBoolean("active") }) { picked ->
                val choice = voices[picked]
                if (choice.optString("name") == voice) panel = null else switchVoice(choice)
            }
        }
        AnimatedVisibility(panel == PlayerPanel.QUALITY || panel == PlayerPanel.SUBTITLES, enter = slideInHorizontally { it }, exit = slideOutHorizontally { it }, modifier = Modifier.align(Alignment.CenterEnd)) {
            if (panel == PlayerPanel.QUALITY) {
                val labels = stream.qualities.keys.sortedByDescending(Lampac::lines)
                ChoicePanel("Качество", labels.map { it to "" }, labels.indexOf(qualityLabel)) { picked ->
                    val label = labels[picked]
                    qualityLabel = label
                    TvState.preferredLines = Lampac.lines(label)
                    load(stream.qualities[label]!!, player.currentPosition / 1000.0)
                    panel = null; osd = label
                }
            } else {
                val options = listOf("Выключены" to "") + stream.subtitles.map { it.first.ifBlank { "Субтитры" } to "" }
                ChoicePanel("Субтитры", options, subtitle + 1) { picked ->
                    subtitle = picked - 1
                    val groups = player.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }
                    player.trackSelectionParameters = if (subtitle < 0) player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                    else groups.getOrNull(subtitle)?.let { player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(it.mediaTrackGroup, 0)).build() }
                        ?: player.trackSelectionParameters
                    panel = null
                }
            }
        }

        // «Подключаю видео…» with the episode and voice; after a while, that the source is slow, and another one.
        AnimatedVisibility(connecting || failure != null, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                TvImage(episodeOf(index)?.still?.replace("/w300/", "/w780/")?.ifBlank { null } ?: Tmdb.image(item.backdrop, "w1280"), "", Modifier.fillMaxSize().graphicsLayer { alpha = 0.35f })
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.3f), Color.Black.copy(alpha = 0.92f)))))
                Column(Modifier.align(Alignment.BottomStart).padding(48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    HText(item.title, size = Hall.S3, weight = FontWeight.Bold, display = true, maxLines = 1)
                    if (failure != null) {
                        HText(failure.orEmpty(), size = Hall.S1, color = Hall.Text2)
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            HButton("Другой источник", onChooseSource, primary = true, focus = sourceFocus)
                            HButton("Повторить", { failure = null; startCurrent(resume = true) })
                        }
                        LaunchedEffect(Unit) { delay(100); runCatching { sourceFocus.requestFocus() } }
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Spinner(26.dp); Spacer(Modifier.width(14.dp))
                            HText("Подключаю видео…", size = Hall.S1, weight = FontWeight.SemiBold)
                        }
                        val what = listOf(place, voice).filter(String::isNotBlank).joinToString(" · ")
                        if (what.isNotBlank()) HText(what, size = Hall.S0, color = Hall.Text2)
                        if (slowSource) {
                            HText("Источник отвечает медленно. Можно подождать или выбрать другой.", size = Hall.S0, color = Hall.Gold)
                            HButton("Выбрать другой источник", onChooseSource, primary = true, focus = sourceFocus)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Timeline(position: Double, duration: Double, modifier: Modifier = Modifier, focused: Boolean = false) {
    Box(modifier.fillMaxWidth().height(if (focused) 8.dp else 5.dp).clip(RoundedCornerShape(4.dp)).background(Hall.Track)) {
        Box(Modifier.fillMaxWidth(if (duration > 0) (position / duration).toFloat().coerceIn(0f, 1f) else 0f).fillMaxHeight().background(Hall.Accent))
    }
}

/** The time line with the remote: left and right wind (held, faster), OK plays or pauses. */
@Composable
private fun Scrubber(position: Double, duration: Double, pending: Int, focus: FocusRequester, below: FocusRequester, onSeek: (Int) -> Unit, onToggle: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val shown = (position + pending).coerceIn(0.0, maxOf(duration, 0.0))
    Column(Modifier.focusRequester(focus).onFocusChanged { focused = it.isFocused }.focusable().onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
            Key.DirectionLeft, Key.DirectionRight -> { val step = if (event.nativeKeyEvent.repeatCount > 2) 30 else 10; onSeek(if (event.key == Key.DirectionRight) step else -step); true }
            Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> { if (event.nativeKeyEvent.repeatCount == 0) onToggle(); true }
            // Down goes to the first button, not to whichever lies under the middle of the line.
            Key.DirectionDown -> runCatching { below.requestFocus() }.isSuccess
            else -> false
        }
    }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth()) {
            HText(tvClock(shown), size = Hall.S0, weight = FontWeight.SemiBold, color = if (focused) Hall.Text else Hall.Text2)
            Spacer(Modifier.weight(1f))
            if (duration > 0) HText("${tvClock(duration)} · осталось ${tvClock(duration - shown)}", size = Hall.S0, color = Hall.Muted)
        }
        Timeline(shown, duration, focused = focused)
    }
}

/** Episodes of the voice with their stills, the current one marked; OK plays one. */
@Composable
private fun EpisodeStrip(item: TvItem, entries: List<PlayEntry>, current: Int, stills: Map<String, TvEpisode>, onPick: (Int) -> Unit) {
    val focus = remember { FocusRequester() }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (current - 1).coerceAtLeast(0))
    LaunchedEffect(Unit) { delay(120); runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.92f)))).padding(top = 40.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HText("Серии", Modifier.padding(start = 48.dp), size = Hall.S2, weight = FontWeight.SemiBold, display = true)
        CompositionLocalProvider(LocalBringIntoViewSpec provides TvRowScroll) {
            LazyRow(state = list, contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                itemsIndexed(entries) { position, entry ->
                    val info = stills["${entry.season}-${entry.episode}"]
                    val progress = TvState.progressOf(item.id, entry.season, entry.episode)
                    WideCard(info?.still.orEmpty(), info?.name?.ifBlank { null } ?: entry.label,
                        if (position == current) "Сейчас" else if (progress?.completed == true) "Просмотрено" else "${entry.season} сезон",
                        { onPick(position) }, width = 220.dp, kicker = entry.label, progress = progress?.takeIf { !it.completed }?.share ?: 0.0,
                        focus = if (position == current) focus else null, fallback = entry.label)
                }
            }
        }
    }
}

@Composable
private fun ChoicePanel(title: String, options: List<Pair<String, String>>, selected: Int, onPick: (Int) -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(120); runCatching { focus.requestFocus() } }
    Column(Modifier.width(360.dp).fillMaxHeight().background(Hall.SurfaceGlass).padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HText(title, size = Hall.S2, weight = FontWeight.SemiBold, display = true)
        LazyColumn(state = rememberLazyListState((selected - 2).coerceAtLeast(0)), verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(4.dp)) {
            itemsIndexed(options) { position, (label, note) ->
                val (interaction, focused) = rememberFocused()
                Row(Modifier.fillMaxWidth().then(if (position == selected || (selected !in options.indices && position == 0)) Modifier.focusRequester(focus) else Modifier)
                    .hallFocus(RoundedCornerShape(Hall.R), scale = 1.02f, interaction = interaction) { onPick(position) }
                    .background(if (focused) Hall.Text else if (position == selected) Hall.Surface3 else Color.Transparent).padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        HText(label, size = Hall.S1, color = if (focused) Hall.Bg else Hall.Text, weight = if (position == selected) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
                        if (note.isNotBlank()) HText(note, size = Hall.S_1, color = if (focused) Hall.Bg.copy(alpha = 0.7f) else Hall.Muted, maxLines = 1)
                    }
                    if (position == selected) HText("✓", size = Hall.S1, color = if (focused) Hall.Bg else Hall.Accent)
                }
            }
        }
    }
}
