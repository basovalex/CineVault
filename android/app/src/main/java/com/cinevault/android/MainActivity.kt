package com.cinevault.android

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private enum class AppTab(val title: String, val icon: ImageVector, val selectedIcon: ImageVector) {
    HOME("Главная", Icons.Outlined.Home, Icons.Default.Home),
    CATALOG("Каталог", Icons.Outlined.GridView, Icons.Default.GridView),
    SEARCH("Поиск", Icons.Default.Search, Icons.Default.Search),
    MINE("Моё", Icons.Default.FavoriteBorder, Icons.Default.Favorite),
    DOWNLOADS("Загрузки", Icons.Default.Download, Icons.Default.Download),
}

/** A screen pushed over the tabs. */
private sealed interface Route {
    data class Detail(val title: CatalogTitle) : Route
    data class Player(val request: PlayRequest) : Route
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        // Browsing stays upright on a phone; the player screen unlocks rotation.
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        CineStore.init(this)
        setContent { CineVaultTheme { CineVaultRoot() } }
    }
}

@Composable
private fun CineVaultRoot() {
    var tab by rememberSaveable { mutableStateOf(AppTab.HOME) }
    val stack = remember { mutableStateListOf<Route>() }
    var settings by remember { mutableStateOf(false) }
    var mineOnHistory by remember { mutableStateOf(false) }
    var searchFocus by remember { mutableStateOf(false) }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.isEmpty() && tab != AppTab.HOME) { tab = AppTab.HOME }

    val top = stack.lastOrNull()
    if (top is Route.Player) {
        PlayerScreen(top.request, onBack = { stack.removeAt(stack.lastIndex) })
        return
    }
    Box(Modifier.fillMaxSize().background(Cine.Background)) {
        val barPadding = PaddingValues(bottom = 76.dp)
        if (top is Route.Detail) {
            DetailScreen(
                top.title,
                onBack = { stack.removeAt(stack.lastIndex) },
                onOpen = { stack.add(Route.Detail(it)) },
                onPlay = { stack.add(Route.Player(it)) },
            )
        } else {
            val open: (CatalogTitle) -> Unit = { stack.add(Route.Detail(it)) }
            when (tab) {
                AppTab.HOME -> HomeScreen(barPadding, open, onSearch = { searchFocus = true; tab = AppTab.SEARCH }, onSettings = { settings = true }, onHistory = { mineOnHistory = true; tab = AppTab.MINE })
                AppTab.CATALOG -> CatalogScreen(barPadding, open)
                AppTab.SEARCH -> SearchScreen(barPadding, open, autoFocus = searchFocus)
                AppTab.MINE -> MineScreen(barPadding, open, onSettings = { settings = true }, startOnHistory = mineOnHistory)
                AppTab.DOWNLOADS -> DownloadsScreen(barPadding) { stack.add(Route.Player(it)) }
            }
        }
        CineVaultTabBar(tab, Modifier.align(Alignment.BottomCenter)) { selected ->
            stack.clear()
            if (selected != AppTab.MINE) mineOnHistory = false
            if (selected != AppTab.SEARCH) searchFocus = false
            tab = selected
        }
    }
    if (settings) SettingsDialog { settings = false }
}

@Composable
private fun CineVaultTabBar(selection: AppTab, modifier: Modifier = Modifier, onSelect: (AppTab) -> Unit) {
    Column(modifier.fillMaxWidth().background(Cine.Background.copy(alpha = 0.96f)).windowInsetsPadding(WindowInsets.navigationBars)) {
        HorizontalDivider(color = Cine.Line)
        Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            AppTab.entries.forEach { item ->
                val selected = item == selection
                Column(
                    Modifier.weight(1f).clickable { onSelect(item) }.padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(if (selected) item.selectedIcon else item.icon, item.title, tint = if (selected) Cine.Accent else Cine.Muted, modifier = Modifier.size(24.dp))
                    Text(item.title, color = if (selected) Cine.Accent else Cine.Muted, fontSize = 10.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}
