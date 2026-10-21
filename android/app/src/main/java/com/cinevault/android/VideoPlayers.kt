package com.cinevault.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent
import android.view.OrientationEventListener
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.delay
import java.io.ByteArrayInputStream

/** What to play: a direct stream from CineVault, or a provider's embedded player. */
data class PlayRequest(
    val title: CatalogTitle,
    val source: PlaybackSource? = null,
    val embedUrl: String? = null,
    val providerName: String = "",
    val hint: String = "",
    /** On TV, what to switch an Alloha series to once its page is up: season, episode, quality ("720"). */
    val season: Int? = null,
    val episode: Int? = null,
    val quality: String? = null,
)

/**
 * Refuses requests to known ad networks inside every embedded player, the way phone ad
 * blockers do. The players themselves and their video servers load as before. The same
 * list lives in the iOS app (PlayerAdBlocker) and the browser extension (rules.json).
 */
object PlayerAdBlocker {
    private val adHosts = listOf(
        "an.yandex.ru", "yabs.yandex.ru", "mc.yandex.ru", "adfox.ru", "adfox.yandex.ru",
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
        "ad.mail.ru", "ads.vk.com", "target.my.com", "r.mradx.net",
        "adriver.ru", "betweendigital.com", "buzzoola.com", "otm-r.com", "mediasniper.ru",
        "videoroll.net", "moevideo.biz", "adhigh.net", "hybrid.ai", "adlook.me", "propellerads.com",
        "exoclick.com", "adsterra.com", "popads.net", "onclickads.net",
        // Seen in Collaps: the pre-roll ad list and its video host
        "distribrey.com", "hg-delivery.b-cdn.net",
        // Collaps pre-roll as of Oct 2026: ad controller, VAST server, VPAID loader, creatives and their pixels
        "vuegenesisvue.com", "ufouxbwn.com", "timing-js-menu.xyz", "agl011.art", "b5c1d2e8c9982e3b965a27ac72ru7284cc.com",
        // Veoveo pre-roll: redirector, VAST list and video host
        "aj2635.bid", "franecki.net", "quickcore.fun", "veselchaga.link", "skorobeyka.link", "sosilapu.org",
    )

    // Ad hosts rotate every few days, the VAST/VPAID plumbing in front of them does not: a video-ad list
    // is an .xml document or a /vast endpoint, and nothing a player needs to show the film is either.
    private val adPaths = listOf("/vast", "/getads", "/vpaid/", "linearvpaid", "/event-init-player", "load-xml")

    fun blocks(host: String?, path: String? = null): Boolean {
        val value = host?.lowercase() ?: return false
        if (adHosts.any { value == it || value.endsWith(".$it") }) return true
        val lowered = path?.lowercase() ?: return false
        return lowered.endsWith(".xml") || adPaths.any { lowered.contains(it) }
    }

    val empty: WebResourceResponse get() = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
}

fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Phone screens stay upright; a player may turn sideways. The full-screen button forces
 * landscape, and once the phone is physically sideways the sensor takes over again, so
 * turning it upright leaves full screen — as in the iOS app.
 */
@Composable
fun PlayerOrientation(tvMode: Boolean, forceLandscape: Int, request: Int) {
    val context = LocalContext.current
    DisposableEffect(tvMode, forceLandscape, request) {
        val activity = context.findActivity()
        if (activity == null || tvMode) return@DisposableEffect onDispose { }
        var listener: OrientationEventListener? = null
        when {
            forceLandscape > 0 -> {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                listener = object : OrientationEventListener(activity) {
                    override fun onOrientationChanged(angle: Int) {
                        if (angle in 60..120 || angle in 240..300) {
                            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                            disable()
                        }
                    }
                }
            }
            forceLandscape < 0 -> {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                listener = object : OrientationEventListener(activity) {
                    override fun onOrientationChanged(angle: Int) {
                        if (angle in 0..25 || angle in 335..359) {
                            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                            disable()
                        }
                    }
                }
            }
            else -> activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        }
        listener?.takeIf { it.canDetectOrientation() }?.enable()
        onDispose {
            listener?.disable()
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
}

@Composable
private fun ImmersiveSystemBars(enabled: Boolean) {
    val context = LocalContext.current
    DisposableEffect(enabled) {
        val window = context.findActivity()?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, it.decorView) }
        if (enabled) {
            controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller?.show(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { if (context.findActivity() !is TvActivity) controller?.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/** A player screen: a slim bar in portrait, the whole display in landscape. */
@Composable
fun PlayerScreen(request: PlayRequest, onBack: () -> Unit, tvMode: Boolean = false) {
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    var forceLandscape by remember { mutableIntStateOf(0) }
    var orientationRequest by remember { mutableIntStateOf(0) }
    var exitVisible by remember { mutableStateOf(false) }
    var touches by remember { mutableIntStateOf(0) }
    PlayerOrientation(tvMode, forceLandscape, orientationRequest)
    ImmersiveSystemBars(landscape || tvMode)
    LaunchedEffect(landscape) { if (landscape) touches++ else exitVisible = false }
    LaunchedEffect(touches) {
        if (touches == 0 || !landscape) return@LaunchedEffect
        exitVisible = true
        delay(3_000)
        exitVisible = false
    }
    val onTouch: () -> Unit = { touches++ }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Column(Modifier.fillMaxSize().then(if (!landscape && !tvMode) Modifier.windowInsetsPadding(WindowInsets.navigationBars) else Modifier)) {
            if (!landscape && !tvMode) {
                Row(
                    Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OverlayButton(Icons.AutoMirrored.Filled.ArrowBack, "Назад", onBack)
                    Spacer(Modifier.width(12.dp))
                    Text(request.title.title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    OverlayButton(Icons.Default.Fullscreen, "На весь экран", { forceLandscape = 1; orientationRequest++ }, tint = Cine.Accent)
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    request.embedUrl != null -> if (tvMode) TvEmbedPlayer(request) else EmbedWebPlayer(request.embedUrl, onTouch = onTouch)
                    request.source != null -> NativeVideoPlayer(request.title, request.source, tvMode)
                }
            }
            if (!landscape && !tvMode && request.hint.isNotBlank()) {
                Text(request.hint, color = Cine.Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().padding(horizontal = Cine.Gutter, vertical = 10.dp))
            }
        }
        // Full screen hides the bar, so it needs a way out of its own. Like the player's own
        // controls, it shows after a tap and fades a few seconds later.
        AnimatedVisibility(
            visible = landscape && !tvMode && exitVisible, enter = fadeIn(), exit = fadeOut(),
            modifier = Modifier.align(Alignment.CenterEnd).windowInsetsPadding(WindowInsets.safeDrawing).padding(6.dp),
        ) {
            OverlayButton(Icons.Default.FullscreenExit, "Выйти из полноэкранного режима", { forceLandscape = -1; orientationRequest++; exitVisible = false })
        }
    }
}

/**
 * The Android emulator's virtual "goldfish" decoders turn many H.264 streams into green or rainbow
 * stripes. On an emulator the software decoder that ships with Android goes first; on a real device
 * the codec list is left exactly as the system gives it.
 */
private val emulatorSafeCodecs = MediaCodecSelector { mimeType, requiresSecureDecoder, requiresTunnelingDecoder ->
    val decoders = MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, requiresSecureDecoder, requiresTunnelingDecoder)
    if (Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish") decoders.sortedBy { it.name.contains("goldfish") } else decoders
}

/**
 * CineVault's own streams, through Media3. A stream that will not play gets one fresh link from the
 * server (the old one may have expired); if that does not help either, a retry button takes over.
 */
@Composable
fun NativeVideoPlayer(title: CatalogTitle, source: PlaybackSource, tvMode: Boolean = false) {
    val context = LocalContext.current
    var current by remember(source.url) { mutableStateOf(source) }
    var failure by remember(source.url) { mutableStateOf<String?>(null) }
    var refreshed by remember(source.url) { mutableStateOf(false) }
    var attempt by remember(source.url) { mutableIntStateOf(0) }
    val retryFocus = remember { FocusRequester() }
    val player = remember(current.url, attempt) {
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("CineVault Android/1.0")
            .setDefaultRequestProperties(CineVaultApi.playbackRequestProperties(current.url))
        val exo = ExoPlayer.Builder(context, DefaultRenderersFactory(context).setMediaCodecSelector(emulatorSafeCodecs))
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, httpFactory)))
            .build()
        val itemBuilder = MediaItem.Builder().setUri(current.url)
        if (current.type.contains("hls", ignoreCase = true) || current.url.substringBefore('?').endsWith(".m3u8", true)) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8)
        }
        exo.setMediaItem(itemBuilder.build())
        exo.prepare()
        exo.playWhenReady = true
        exo
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) { failure = error.errorCodeName }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener); player.release() }
    }
    LaunchedEffect(failure) {
        val reason = failure ?: return@LaunchedEffect
        val kinopoiskId = title.kinopoiskId
        if (!refreshed && kinopoiskId != null && current.url.startsWith("http")) {
            refreshed = true
            val fresh = runCatching { CineVaultApi.refreshPlayback(kinopoiskId, force = true) }.getOrNull()
                ?.sources?.filter { !it.isEmbed }.orEmpty()
            val replacement = fresh.firstOrNull { it.id == current.id }
                ?: fresh.firstOrNull { it.voice == current.voice && it.quality == current.quality } ?: fresh.firstOrNull()
            if (replacement != null) { current = replacement; failure = null; return@LaunchedEffect }
        }
        android.util.Log.w("NativeVideoPlayer", "playback failed: $reason")
        runCatching { retryFocus.requestFocus() }
    }
    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize().then(if (tvMode) Modifier.focusable() else Modifier),
            factory = { viewContext ->
                PlayerView(viewContext).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = true
                    controllerShowTimeoutMs = 4_000
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                    this.player = player
                    if (tvMode) {
                        isFocusable = true
                        isFocusableInTouchMode = true
                        requestFocus()
                    }
                }
            },
            update = { it.player = player },
        )
        if (failure != null && (refreshed || title.kinopoiskId == null || !current.url.startsWith("http"))) {
            Column(
                Modifier.align(Alignment.Center).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Не удалось воспроизвести видео", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(failure.orEmpty(), color = Cine.Muted, fontSize = 13.sp)
                PrimaryButton("Повторить", { failure = null; attempt++ }, Modifier.focusRequester(retryFocus))
            }
        }
    }
}

internal fun tapCenter(view: View) {
    val x = view.width / 2f
    val y = view.height / 2f
    val time = SystemClock.uptimeMillis()
    listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEachIndexed { index, action ->
        val motion = MotionEvent.obtain(time, time + index * 50L, action, x, y, 0)
        view.dispatchTouchEvent(motion)
        motion.recycle()
    }
}

/** Alloha, Collaps, Veoveo, Turbo: the provider's page inside an iframe, as on the website. */
@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
@Composable
fun EmbedWebPlayer(url: String, tvMode: Boolean = false, onTouch: () -> Unit = {}, remote: EmbedRemote? = null) {
    val context = LocalContext.current
    var pageStarted by remember(url) { mutableStateOf(false) }
    // On TV the remote's keys belong to the app's controls (TvEmbedPlayer), never to the page:
    // a page holding the focus would swallow Back, among others.
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val container = FrameLayout(viewContext)
                val webView = WebView(viewContext).apply {
                    isFocusable = !tvMode
                    isFocusableInTouchMode = !tvMode
                    setBackgroundColor(android.graphics.Color.BLACK)
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.javaScriptCanOpenWindowsAutomatically = false
                    settings.setSupportMultipleWindows(false)
                    isVerticalScrollBarEnabled = false
                    isHorizontalScrollBarEnabled = false
                    setOnTouchListener { _, _ -> onTouch(); false }
                    remote?.webView = this
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, pageUrl: String?, favicon: android.graphics.Bitmap?) {
                            pageStarted = true
                        }

                        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                            val blocked = PlayerAdBlocker.blocks(request?.url?.host, request?.url?.path)
                            if (BuildConfig.DEBUG || android.util.Log.isLoggable("PlayerWeb", android.util.Log.DEBUG)) android.util.Log.d("PlayerWeb", "${if (blocked) "BLOCK" else "load "} ${request?.method} ${request?.url?.host}${request?.url?.path?.take(60)}")
                            return if (blocked) PlayerAdBlocker.empty else null
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        private var customView: View? = null
                        private var customViewCallback: CustomViewCallback? = null

                        // The provider's own full-screen button: show its video over everything, sideways.
                        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                            if (view == null) return
                            onHideCustomView()
                            customView = view
                            customViewCallback = callback
                            container.removeView(this@apply)
                            container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                            if (!tvMode) context.findActivity()?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        }

                        override fun onHideCustomView() {
                            val shown = customView ?: return
                            container.removeView(shown)
                            customView = null
                            container.addView(this@apply, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                            customViewCallback?.onCustomViewHidden()
                            customViewCallback = null
                            if (!tvMode) context.findActivity()?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                        }
                    }
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    if (remote != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        WebViewCompat.addWebMessageListener(this, "cvRemote", setOf("*")) { _, message, _, _, reply -> remote.onMessage(message.data, reply) }
                        WebViewCompat.addDocumentStartJavaScript(this, TV_REMOTE_JS, setOf("*"))
                    }
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        // Alloha's ad list is replaced with an empty one (filter.js, shared with iOS and the extension).
                        for (asset in listOf("filter.js", "alloha-layout.js")) {
                            val script = runCatching { context.assets.open(asset).bufferedReader().use { it.readText() } }.getOrNull() ?: continue
                            WebViewCompat.addDocumentStartJavaScript(this, script, setOf("https://*.stravers.live"))
                        }
                    }
                    val safeURL = url.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;")
                    val html = """
                        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
                        <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head>
                        <body><iframe src="$safeURL" allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>
                    """.trimIndent()
                    loadDataWithBaseURL(BuildConfig.SERVER_URL.trimEnd('/') + "/", html, "text/html", "UTF-8", null)
                }
                container.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                container
            },
            onRelease = { container ->
                (container.getChildAt(0) as? WebView)?.apply { stopLoading(); loadUrl("about:blank"); destroy() }
            },
        )
        if (!pageStarted) CircularProgressIndicator(color = Cine.Accent)
    }
}
