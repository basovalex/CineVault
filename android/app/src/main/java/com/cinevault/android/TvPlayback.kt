package com.cinevault.android

import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import java.util.Locale

/**
 * What the TV controls drive: a provider's page ([EmbedRemote]), Media3 ([MediaPlayback]) or both
 * ([AllohaPlayback]). The controls are the same for all of them; the commands are those of [TV_REMOTE_JS].
 */
interface TvPlayback {
    val state: EmbedState?
    fun send(command: String)
}

/** A stream's rung by its frame, as the page script names them: films wider than 16:9 are shorter than their name says. */
internal fun videoRung(width: Int, height: Int): String = when {
    width >= 3200 || height >= 2000 -> "2160"
    width >= 2300 || height >= 1300 -> "1440"
    width >= 1700 || height >= 1000 -> "1080"
    width >= 1100 || height >= 700 -> "720"
    width >= 800 || height >= 460 -> "480"
    else -> "360"
}

/** Holds Media3 to a rung ("1080"): frames that wide, or the nearest the stream has. "auto" lets it choose. */
internal fun TrackSelectionParameters.withQuality(rung: String?): TrackSelectionParameters {
    val width = mapOf("2160" to 3840, "1440" to 2560, "1080" to 1920, "720" to 1280, "480" to 854, "360" to 640)[rung]
        ?: return buildUpon().clearVideoSizeConstraints().setMinVideoSize(0, 0).build()
    return buildUpon().setMaxVideoSize(width + 64, Int.MAX_VALUE).setMinVideoSize((width * 0.85).toInt(), 0).build()
}

private fun trackName(format: Format, index: Int): String {
    format.label?.takeIf(String::isNotBlank)?.let { return it }
    val language = format.language?.takeIf { it.isNotBlank() && it != C.LANGUAGE_UNDETERMINED }
    return language?.let { Locale.forLanguageTag(it).getDisplayLanguage(Locale("ru")).replaceFirstChar(Char::uppercase) } ?: "Дорожка ${index + 1}"
}

/** A stream Media3 plays: CineVault's own files, or Alloha's stream taken from its page. */
@Stable
class MediaPlayback(val player: ExoPlayer, quality: String? = null) : TvPlayback {
    override var state by mutableStateOf<EmbedState?>(null)
        private set
    private var pinned = quality?.takeIf(String::isNotBlank) ?: "auto"

    init { player.trackSelectionParameters = player.trackSelectionParameters.withQuality(pinned) }

    /** Read from the player twice a second and after every command. */
    fun refresh() {
        val groups = player.currentTracks.groups
        val rungs = groups.filter { it.type == C.TRACK_TYPE_VIDEO }
            .flatMap { group -> (0 until group.length).filter(group::isTrackSupported).map { group.getTrackFormat(it).let { f -> videoRung(f.width, f.height) } } }
            .distinct().sortedByDescending { it.toInt() }
        val audio = groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val text = groups.filter { it.type == C.TRACK_TYPE_TEXT }
        val textOff = C.TRACK_TYPE_TEXT in player.trackSelectionParameters.disabledTrackTypes || text.none { it.isSelected }
        state = EmbedState(
            alloha = false, time = player.currentPosition.coerceAtLeast(0) / 1000.0,
            duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.div(1000.0) ?: 0.0,
            paused = !player.playWhenReady,
            quality = if (rungs.size > 1) pinned else rungs.firstOrNull().orEmpty(),
            qualities = if (rungs.size > 1) listOf("auto") + rungs else rungs,
            seasons = emptyList(), episodes = emptyList(),
            translations = audio.mapIndexed { index, group -> EmbedChoice("$index", trackName(group.getTrackFormat(0), index), group.isSelected) },
            hasNext = false, hasPrev = false, skip = "",
            subtitles = if (text.isEmpty()) emptyList() else listOf(EmbedChoice("off", "Выключены", textOff)) +
                text.mapIndexed { index, group -> EmbedChoice("$index", trackName(group.getTrackFormat(0), index), !textOff && group.isSelected) },
        )
    }

    private fun choose(type: Int, id: String) {
        val group = player.currentTracks.groups.filter { it.type == type }.getOrNull(id.toIntOrNull() ?: return) ?: return
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0)).build()
    }

    override fun send(command: String) {
        val name = command.substringBefore(':')
        val arg = command.substringAfter(':', "")
        val length = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
        fun seekTo(ms: Long) = player.seekTo(ms.coerceAtMost(length?.minus(1_000) ?: Long.MAX_VALUE).coerceAtLeast(0))
        when (name) {
            "toggle" -> { if (player.playbackState == Player.STATE_ENDED) player.seekTo(0); player.playWhenReady = !player.playWhenReady }
            "play" -> player.playWhenReady = true
            "seek" -> seekTo(player.currentPosition + ((arg.toDoubleOrNull() ?: 0.0) * 1000).toLong())
            "seekabs" -> seekTo(((arg.toDoubleOrNull() ?: 0.0) * 1000).toLong())
            "seekto" -> if (length != null) seekTo(((arg.toDoubleOrNull() ?: 0.0) * length).toLong())
            "quality" -> { pinned = arg.ifBlank { "auto" }; player.trackSelectionParameters = player.trackSelectionParameters.withQuality(pinned) }
            "translation" -> choose(C.TRACK_TYPE_AUDIO, arg)
            "subtitle" -> if (arg == "off") player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                else choose(C.TRACK_TYPE_TEXT, arg)
        }
        refresh()
    }
}

/**
 * Alloha on TV. Its page plays the film in a WebView, where the picture goes through the browser's
 * compositor and the sound through its audio stack: on a TV's modest processor even 1080p stutters
 * and crackles there. So the page only stays on as a remote control (voices, seasons, episodes,
 * qualities, intro skip), paused and silent, and the stream it loads is played by Media3 on the TV's
 * hardware decoder. Should Media3 fail with it, the page plays it itself again, as before.
 */
@Stable
class AllohaPlayback(private val page: EmbedRemote, private val media: MediaPlayback) : TvPlayback {
    /** Media3 plays the page's stream; false once it could not, and the page plays it itself. */
    var native by mutableStateOf(true)
    /** The stream Media3 holds now. */
    var playing by mutableStateOf("")
    /** The episode of that stream ("season/episode"). */
    var playingEpisode by mutableStateOf<String?>(null)
    /** A second asked for before Media3 had the stream ("Продолжить"). */
    var startAt: Double? = null

    /** The page has moved to another episode, whose stream Media3 does not have yet. */
    private val switching get() = page.state?.let(::episodeKey) != playingEpisode

    private val timeCommands = setOf("toggle", "play", "seek", "seekabs", "seekto")

    override val state: EmbedState?
        get() {
            val web = page.state ?: return null
            if (!native) return web
            val own = media.state
            if (playing.isEmpty() || own == null || switching) return web.copy(time = startAt ?: 0.0, duration = 0.0, paused = true)
            val duration = own.duration.takeIf { it > 0 } ?: web.duration
            val skip = skipRange(web, own.time)?.let { if (it.start < 1 || it.start < duration / 2) "Пропустить заставку" else "Пропустить титры" }.orEmpty()
            return web.copy(time = own.time, duration = duration, paused = own.paused, skip = skip)
        }

    /** The intro or the credits playing now, from the page's own list; the page shows its buttons only while it plays itself. */
    private fun skipRange(web: EmbedState, time: Double): ClosedFloatingPointRange<Double>? = web.skipTimes.split(',').firstNotNullOfOrNull { part ->
        val bounds = part.split('-').mapNotNull { it.trim().toDoubleOrNull() }
        if (bounds.size == 2 && bounds[1] > bounds[0] && time >= bounds[0] && time < bounds[1] - 2) bounds[0]..bounds[1] else null
    }

    override fun send(command: String) {
        val name = command.substringBefore(':')
        val web = page.state
        val range = if (native && playing.isNotEmpty() && web != null) skipRange(web, media.state?.time ?: 0.0) else null
        when {
            // The credits of an episode lead to the next one; an intro is jumped over.
            name == "skip" && range != null -> if (state?.skip == "Пропустить титры" && web?.hasNext == true) page.send("next") else media.send("seekabs:${range.endInclusive}")
            !native || name !in timeCommands -> page.send(command)
            playing.isNotEmpty() && !switching -> media.send(command)
            // The page loads its stream once asked to play; Media3 takes it over from there.
            name == "play" || name == "toggle" -> page.send("play")
            name == "seekabs" -> startAt = command.substringAfter(':').toDoubleOrNull()
        }
    }
}

/** One [TvPlayback] for the controls while the player behind it is replaced (a fresh link). */
@Stable
private class SwappablePlayback : TvPlayback {
    var target by mutableStateOf<TvPlayback?>(null)
    override val state get() = target?.state
    override fun send(command: String) { target?.send(command) }
}

internal fun episodeKey(state: EmbedState) = "${state.season?.id}/${state.episode?.id}"

/** Media3's picture alone: the controls are the app's own. */
@Composable
private fun MediaSurface(player: Player) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            PlayerView(context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                useController = false
                isFocusable = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                this.player = player
            }
        },
        update = { it.player = player },
    )
}

@Composable
internal fun TvAllohaPlayer(request: PlayRequest, url: String) {
    val context = LocalContext.current
    val remote = remember(url) { EmbedRemote() }
    val player = remember(url) { buildExoPlayer(context, DefaultDataSource.Factory(context)).apply { playWhenReady = true } }
    val media = remember(player) { MediaPlayback(player) }
    val playback = remember(url) { AllohaPlayback(remote, media) }
    // Media3 asks for the stream as the page's own browser does.
    val userAgent = remember { runCatching { WebSettings.getDefaultUserAgent(context) }.getOrDefault("Mozilla/5.0 (Linux; Android)") }

    fun handBack(reason: String) {
        if (!playback.native) return
        android.util.Log.w("CineVaultPlayer", "Alloha in Media3 failed ($reason): the page plays it itself")
        val at = if (playback.playing.isNotEmpty()) player.currentPosition / 1000 else 0
        playback.native = false
        playback.playing = ""
        player.stop()
        remote.send("native:0")
        if (at > 5) remote.send("seekabs:$at")
        remote.send("play")
    }
    // A refused stream is asked for once more with the page's current headers (its tokens may have moved on), from the same second.
    var reopened by remember(url) { mutableIntStateOf(0) }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                if (reopened >= 2 || playback.playing.isEmpty()) return handBack(error.errorCodeName)
                android.util.Log.w("CineVaultPlayer", "Alloha in Media3: ${error.errorCodeName}, opening the stream again")
                playback.startAt = player.currentPosition / 1000.0
                playback.playing = ""
                reopened++
            }
            // The end of an episode opens the next one, as the page itself would.
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && remote.state?.hasNext == true) remote.send("next")
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener); player.release() }
    }
    LaunchedEffect(player) { while (true) { media.refresh(); delay(500) } }

    // Each stream the page loads goes to Media3: the same episode keeps its second (another voice or
    // quality), another episode starts from its beginning.
    // A stream counts once its headers are known: the page reports its address a moment before hls.js asks for it.
    val stream = remote.state?.takeIf { it.headers.isNotEmpty() }?.stream.orEmpty()
    LaunchedEffect(stream, playback.native, reopened) {
        if (stream.isBlank() || !playback.native || stream == playback.playing) return@LaunchedEffect
        if (reopened > 0) delay(1_500)
        val page = remote.state ?: return@LaunchedEffect
        val episode = episodeKey(page)
        val at = playback.startAt ?: if (episode == playback.playingEpisode && playback.playing.isNotEmpty()) player.currentPosition / 1000.0 else 0.0
        val origin = Uri.parse(page.page).let { "${it.scheme}://${it.host}" }
        val http = DefaultHttpDataSource.Factory().setUserAgent(userAgent).setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(page.headers + mapOf("Referer" to page.page, "Origin" to origin))
        player.setMediaSource(DefaultMediaSourceFactory(http).createMediaSource(MediaItem.Builder().setUri(stream).setMimeType(MimeTypes.APPLICATION_M3U8).build()))
        player.prepare()
        if (at > 1) player.seekTo((at * 1000).toLong())
        player.playWhenReady = true
        android.util.Log.i("CineVaultPlayer", "Alloha stream to Media3 from ${at.toInt()} s, headers ${page.headers.keys}")
        playback.startAt = null
        playback.playing = stream
        playback.playingEpisode = episode
        remote.send("native:1")
    }
    // A page that shows no stream in 20 s has changed its ways: it plays the film itself.
    LaunchedEffect(remote) {
        snapshotFlowFirst { remote.state != null }
        delay(20_000)
        if (playback.playing.isEmpty()) handBack("no stream from the page")
    }

    TvPlayerChrome(request, playback, webView = { remote.webView }) {
        EmbedWebPlayer(url, tvMode = true, remote = remote, nativeStream = true)
        if (playback.native && playback.playing.isNotEmpty()) MediaSurface(player)
    }
}

private suspend fun snapshotFlowFirst(condition: () -> Boolean) { androidx.compose.runtime.snapshotFlow(condition).first { it } }

/**
 * CineVault's own streams on TV, with the same controls as the providers' players. A stream that will
 * not play gets one fresh link from the server (the old one may have expired), then a retry button.
 */
@Composable
internal fun TvNativePlayer(request: PlayRequest, source: PlaybackSource) {
    val context = LocalContext.current
    var current by remember(source.url) { mutableStateOf(source) }
    var failure by remember(source.url) { mutableStateOf<String?>(null) }
    var refreshed by remember(source.url) { mutableStateOf(false) }
    var attempt by remember(source.url) { mutableIntStateOf(0) }
    var resumeMs by remember(source.url) { mutableStateOf(0L) }
    val player = remember(current.url, attempt) {
        val http = DefaultHttpDataSource.Factory().setUserAgent("CineVault Android/1.0")
            .setDefaultRequestProperties(CineVaultApi.playbackRequestProperties(current.url))
        buildExoPlayer(context, DefaultDataSource.Factory(context, http)).apply {
            val item = MediaItem.Builder().setUri(current.url)
            if (current.type.contains("hls", ignoreCase = true) || current.url.substringBefore('?').endsWith(".m3u8", true)) item.setMimeType(MimeTypes.APPLICATION_M3U8)
            setMediaItem(item.build())
            prepare()
            if (resumeMs > 0) seekTo(resumeMs)
            playWhenReady = true
        }
    }
    val media = remember(player) { MediaPlayback(player, request.quality) }
    val playback = remember(source.url) { SwappablePlayback() }
    playback.target = media
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) { resumeMs = player.currentPosition; failure = error.errorCodeName }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener); player.release() }
    }
    LaunchedEffect(player) { while (true) { media.refresh(); delay(500) } }
    LaunchedEffect(failure) {
        failure ?: return@LaunchedEffect
        val kinopoiskId = request.title.kinopoiskId
        if (refreshed || kinopoiskId == null || !current.url.startsWith("http")) return@LaunchedEffect
        refreshed = true
        val fresh = runCatching { CineVaultApi.refreshPlayback(kinopoiskId, force = true) }.getOrNull()?.sources?.filter { !it.isEmbed }.orEmpty()
        val replacement = fresh.firstOrNull { it.id == current.id }
            ?: fresh.firstOrNull { it.voice == current.voice && it.quality == current.quality } ?: fresh.firstOrNull()
        if (replacement != null) { current = replacement; failure = null }
    }

    if (failure != null && (refreshed || request.title.kinopoiskId == null || !current.url.startsWith("http"))) {
        val retry = remember { FocusRequester() }
        LaunchedEffect(Unit) { delay(100); runCatching { retry.requestFocus() } }
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Не удалось воспроизвести видео", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                Text(failure.orEmpty(), color = Cine.Muted, fontSize = 15.sp)
                PrimaryButton("Повторить", { failure = null; attempt++ }, Modifier.focusRequester(retry))
            }
        }
        return
    }
    TvPlayerChrome(request, playback) { MediaSurface(player) }
}
