package com.cinevault.android

import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

private data class TrailerStream(val high: String, val master: String)
private data class CachedTrailerStream(val stream: TrailerStream?, val savedAt: Long)

private object TvTrailerPreviewCache {
    private val streams = ConcurrentHashMap<String, CachedTrailerStream>()
    private val locks = ConcurrentHashMap<String, Mutex>()
    private const val MAX_AGE_MS = 5 * 60 * 1000L

    suspend fun get(item: TvItem): TrailerStream? {
        val key = "${item.id}|${item.year}"
        streams[key]?.takeIf { System.currentTimeMillis() - it.savedAt < MAX_AGE_MS }?.let { return it.stream }
        val lock = locks.computeIfAbsent(key) { Mutex() }
        return lock.withLock {
            streams[key]?.takeIf { System.currentTimeMillis() - it.savedAt < MAX_AGE_MS }?.let { return@withLock it.stream }
            val trailer = Tmdb.trailers(item, includePreview = true).firstOrNull()
            val master = trailer?.previewUrl.orEmpty().takeIf(::isRutubeStream).orEmpty()
            val high = trailer?.previewHighUrl.orEmpty().takeIf(::isRutubeStream).orEmpty().ifBlank { master }
            val stream = (high.takeIf(String::isNotBlank) ?: master.takeIf(String::isNotBlank))?.let { TrailerStream(it, master) }
            if (streams.size > 100) streams.clear()
            streams[key] = CachedTrailerStream(stream, System.currentTimeMillis())
            stream
        }
    }

    private fun isRutubeStream(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme == "https" && uri.host?.endsWith(".rutube.ru") == true && uri.path?.endsWith(".m3u8") == true
    }.getOrDefault(false)
}

@Composable
internal fun TvTrailerCardPreview(item: TvItem, focused: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var stream by remember(item.id) { mutableStateOf<TrailerStream?>(null) }
    LaunchedEffect(item.id, focused) {
        stream = null
        if (focused) {
            delay(700)
            try {
                stream = TvTrailerPreviewCache.get(item)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                stream = null
            }
        }
    }
    if (focused) stream?.let { TrailerPreviewPlayer(context, it, modifier) }
}

@Composable
private fun TrailerPreviewPlayer(context: Context, stream: TrailerStream, modifier: Modifier) {
    var firstFrame by remember(stream) { mutableStateOf(false) }
    val alpha by animateFloatAsState(if (firstFrame) 1f else 0f, animationSpec = tween(420), label = "trailer-preview-fade")
    val player = remember(stream) {
        val http = DefaultHttpDataSource.Factory().setUserAgent("CineVault Android TV/1.0").setAllowCrossProtocolRedirects(true)
        val source = DefaultDataSource.Factory(context, http)
        val loadControl = DefaultLoadControl.Builder().setBufferDurationsMs(5_000, 15_000, 750, 1_500)
            .setTargetBufferBytes(16 * 1024 * 1024).setPrioritizeTimeOverSizeThresholds(true).build()
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(source)).setLoadControl(loadControl).build().apply { volume = 0f }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() { firstFrame = true }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                if (stream.master.isNotBlank() && stream.high != stream.master && player.currentMediaItem?.localConfiguration?.uri.toString() == stream.high) {
                    player.setMediaItem(MediaItem.Builder().setUri(stream.master).setMimeType(MimeTypes.APPLICATION_M3U8).build())
                    player.prepare()
                    player.playWhenReady = true
                }
            }
        }
        player.addListener(listener)
        player.setMediaItem(MediaItem.Builder().setUri(stream.high).setMimeType(MimeTypes.APPLICATION_M3U8).build())
        player.prepare()
        player.playWhenReady = true
        onDispose { player.removeListener(listener); player.release() }
    }
    Box(modifier.fillMaxSize().clip(RoundedCornerShape(Hall.R)).graphicsLayer { this.alpha = alpha }) {
        PlayerSurface(player, "cover")
    }
}
