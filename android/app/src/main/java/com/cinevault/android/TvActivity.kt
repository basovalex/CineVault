package com.cinevault.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** The TV app: the site's sections, design and player, driven by the remote alone (see TvApp.kt). */
class TvActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        TvNet.init(this)
        Tmdb.init(this)
        TvState.init(this)
        CineStore.init(this)
        setContent {
            // Every TV gets the same 960-wide layout, whatever its panel (1080p, 4K) and the density it reports.
            val screen = resources.displayMetrics.let { maxOf(it.widthPixels, it.heightPixels) }
            val system = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(screen / 960f, system.fontScale)) {
                CineVaultTheme { TvApp(intent?.getStringExtra("open")) }
            }
        }
    }
}
