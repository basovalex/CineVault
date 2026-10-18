package com.cinevault.android

import android.annotation.SuppressLint
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.focusable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.ui.PlayerView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

@Composable
fun NativeVideoPlayer(source: PlaybackSource, tvMode: Boolean = false) {
    val context = LocalContext.current
    val player = remember(source.url) {
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("CineVault Android/1.0")
            .setDefaultRequestProperties(CineVaultApi.playbackRequestProperties(source.url))
        val exo = ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, httpFactory)))
            .build()
        val itemBuilder = MediaItem.Builder().setUri(source.url)
        if (source.type.contains("hls", ignoreCase = true) || source.url.substringBefore('?').endsWith(".m3u8", true)) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8)
        }
        exo.setMediaItem(itemBuilder.build())
        exo.prepare()
        exo.playWhenReady = true
        exo
    }
    DisposableEffect(player) { onDispose { player.release() } }
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
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AllohaWebPlayer(url: String, tvMode: Boolean = false) {
    val context = LocalContext.current
    var pageStarted by remember(url) { mutableStateOf(false) }
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val container = FrameLayout(viewContext)
                val webView = WebView(viewContext).apply {
                    isFocusable = true
                    isFocusableInTouchMode = true
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.javaScriptCanOpenWindowsAutomatically = false
                    settings.setSupportMultipleWindows(false)
                    isVerticalScrollBarEnabled = false
                    isHorizontalScrollBarEnabled = false
                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, pageUrl: String?, favicon: android.graphics.Bitmap?) {
                            pageStarted = true
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        private var customView: View? = null
                        private var customViewCallback: CustomViewCallback? = null

                        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                            if (view == null) return
                            onHideCustomView()
                            customView = view
                            customViewCallback = callback
                            container.removeView(this@apply)
                            container.addView(view, FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            ))
                        }

                        override fun onHideCustomView() {
                            customView?.let(container::removeView)
                            customView = null
                            container.addView(this@apply, FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            ))
                            customViewCallback?.onCustomViewHidden()
                            customViewCallback = null
                        }
                    }
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    val filterScript = runCatching {
                        context.assets.open("filter.js").bufferedReader().use { it.readText() }
                    }.getOrNull()
                    if (filterScript != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        WebViewCompat.addDocumentStartJavaScript(
                            this,
                            filterScript,
                            setOf("https://theatre.stravers.live"),
                        )
                    }
                    val layoutScript = runCatching {
                        context.assets.open("alloha-layout.js").bufferedReader().use { it.readText() }
                    }.getOrNull()
                    if (layoutScript != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        WebViewCompat.addDocumentStartJavaScript(
                            this,
                            layoutScript,
                            setOf("https://theatre.stravers.live"),
                        )
                    }
                    val safeURL = url.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;")
                    val html = """
                        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
                        <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head>
                        <body><iframe src="$safeURL" allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>
                    """.trimIndent()
                    loadDataWithBaseURL("https://cinevault-aleksandr.duckdns.org/", html, "text/html", "UTF-8", null)
                    if (tvMode) requestFocus()
                }
                container.addView(webView, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ))
                container
            },
            update = { },
        )
        if (!pageStarted) CircularProgressIndicator(color = Accent)
    }
}
