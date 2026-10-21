package com.cinevault.android

import android.webkit.WebView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.filled.FastRewind
import androidx.compose.material.icons.filled.HighQuality
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.Redo
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.webkit.JavaScriptReplyProxy
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/** One entry of a provider's own list: a season, an episode or a voice. */
data class EmbedChoice(val id: String, val name: String, val active: Boolean)

/** What the page script reports about the player it found, once a second. */
data class EmbedState(
    val alloha: Boolean,
    val time: Double,
    val duration: Double,
    val paused: Boolean,
    val quality: String,
    val qualities: List<String>,
    val seasons: List<EmbedChoice>,
    val episodes: List<EmbedChoice>,
    val translations: List<EmbedChoice>,
    val hasNext: Boolean,
    val hasPrev: Boolean,
    val skip: String,
    /** The provider's own "Упс. Ошибка!" box is on screen. */
    val failed: Boolean = false,
) {
    val season get() = seasons.firstOrNull { it.active }
    val episode get() = episodes.firstOrNull { it.active }
    val translation get() = translations.firstOrNull { it.active }

    companion object {
        private fun JSONArray?.choices() = (0 until (this?.length() ?: 0)).mapNotNull { index ->
            this?.optJSONObject(index)?.let { EmbedChoice(it.optString("id"), it.optString("name"), it.optBoolean("active")) }
        }

        fun parse(text: String): EmbedState? = runCatching {
            val json = JSONObject(text)
            EmbedState(
                alloha = json.optBoolean("alloha"), time = json.optDouble("time", 0.0).takeUnless(Double::isNaN) ?: 0.0,
                duration = json.optDouble("duration", 0.0).takeUnless { it.isNaN() || it.isInfinite() } ?: 0.0,
                paused = json.optBoolean("paused", true), quality = json.optString("quality"),
                qualities = json.optJSONArray("qualities")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty().filter(String::isNotBlank),
                seasons = json.optJSONArray("seasons").choices(), episodes = json.optJSONArray("episodes").choices(),
                translations = json.optJSONArray("translations").choices(),
                hasNext = json.optBoolean("hasNext"), hasPrev = json.optBoolean("hasPrev"), skip = json.optString("skip"),
                failed = json.optBoolean("failed"),
            )
        }.getOrNull()
    }
}

/**
 * The line between the TV controls and the provider's page. Every frame of the page runs
 * [TV_REMOTE_JS]; the frame holding the film reports its state here and takes the commands.
 */
@Stable
class EmbedRemote {
    var state by mutableStateOf<EmbedState?>(null)
        private set
    var webView: WebView? = null
    private var active: JavaScriptReplyProxy? = null
    private var activeSeen = 0L
    private val frames = mutableListOf<JavaScriptReplyProxy>()

    private val log = android.util.Log.isLoggable("PlayerWeb", android.util.Log.DEBUG)

    fun onMessage(text: String?, reply: JavaScriptReplyProxy) {
        if (log) android.util.Log.d("PlayerWeb", "bridge <- ${text?.take(160)}")
        if (frames.none { it === reply }) { frames.add(reply); if (frames.size > 24) frames.removeAt(0) }
        if (text == null || text == "ready") return
        val next = EmbedState.parse(text) ?: return
        val now = System.currentTimeMillis()
        val current = state
        // Ads and previews have videos too: the film's frame wins, and keeps winning while it reports.
        val take = current == null || reply === active || now - activeSeen > 3_000 ||
            (next.alloha && !current.alloha) || (!current.alloha && next.duration > current.duration + 60)
        if (!take) return
        active = reply; activeSeen = now; state = next
    }

    fun send(command: String) {
        if (log) android.util.Log.d("PlayerWeb", "bridge -> $command (active=${active != null}, frames=${frames.size})")
        val target = active
        (if (target != null) listOf(target) else frames.toList()).forEach { runCatching { it.postMessage(command) } }
    }
}

/**
 * Runs inside every frame of an embedded player on TV. It reports the frame's video (and, in Alloha,
 * its seasons, episodes, voices and qualities) through the cvRemote channel, and carries out the
 * commands the TV controls send back: toggle, seek:±s, seekto:fraction, next, prev, quality:v,
 * season:id, episode:id, translation:id, skip.
 */
internal const val TV_REMOTE_JS = """
(function () {
  if (window.__cvRemote || !window.cvRemote) return;
  window.__cvRemote = true;
  var channel = window.cvRemote;
  function video() {
    var p = allplay();
    if (p && p.media && p.media.tagName === 'VIDEO') return p.media;
    var list = document.getElementsByTagName('video'), best = null, size = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i], area = (v.videoWidth || v.clientWidth || 0) * (v.videoHeight || v.clientHeight || 0);
      if ((v.duration > 0 || area > 0) && area >= size) { best = v; size = area; }
    }
    return best;
  }
  function allplay() { return window.player && document.getElementById('allplay') ? window.player : null; }
  function text(node) { return ((node && (node.innerText || node.textContent)) || '').trim(); }
  function visible(node) { var box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; }
  function items(name) {
    return [].map.call(document.querySelectorAll('[data-select^=' + name + '] .select__drop-item'), function (b) {
      return {id: b.getAttribute('data-id') || '', name: text(b), active: b.classList.contains('active')};
    });
  }
  function find(pattern, maxChildren) {
    var nodes = document.querySelectorAll('button, a, [role=button], div, span'), candidates = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.children.length > maxChildren) continue;
      var label = text(node).toLowerCase();
      if (label && label.length < 48 && pattern.test(label) && visible(node)) candidates.push(node);
    }
    // A wrapper can have exactly the same text as its button but no click handler.
    // Prefer the interactive element, then the deepest text leaf whose click bubbles to its control.
    candidates.sort(function (a, b) {
      function interactive(n) { return /^(BUTTON|A)$/.test(n.tagName || '') || (n.getAttribute && n.getAttribute('role') === 'button') ? 1 : 0; }
      return interactive(b) - interactive(a) || a.children.length - b.children.length;
    });
    return candidates[0] || null;
  }
  function skipButton() { return find(/^(пропустить (заставку|титры|вступление|интро)|skip intro|skip recap)/, 2); }
  function button(name) { var b = document.querySelector('[data-allplay=' + name + ']'); return b && !b.classList.contains('disabled') && !b.disabled && visible(b) ? b : null; }
  function state() {
    var v = video(), p = allplay();
    if (!v && !p) return null;
    var s = {alloha: !!p, time: v ? v.currentTime : 0, duration: v && isFinite(v.duration) ? v.duration : 0, paused: v ? v.paused : true};
    if (p) {
      try { s.quality = p.hls && p.hls.autoLevelEnabled ? 'auto' : String(p.quality || ''); } catch (e) { s.quality = ''; }
      s.qualities = [].map.call(document.querySelectorAll('[data-allplay=quality]'), function (b) { return b.value; });
      if (p.hls) s.qualities.unshift('auto');
      s.seasons = items('season'); s.episodes = items('episode'); s.translations = items('translation');
      s.hasNext = !!button('next'); s.hasPrev = !!button('prev');
    }
    var skip = skipButton();
    s.skip = skip ? text(skip) : '';
    s.failed = !!find(/^перезагрузить плеер$/, 1);
    return s;
  }
  function report() {
    var s = state();
    // Watching was explicitly requested in the app; Alloha's resume popup must not block the remote.
    var resume = find(/^продолжить просмотр$/, 2);
    if (resume) resume.click();
    if (s && s.alloha && !document.getElementById('cv-tv-chrome')) {
      var style = document.createElement('style'); style.id = 'cv-tv-chrome';
      // Keep the controls in the DOM for the bridge; only the app's remote-friendly panel is visible.
      style.textContent = '.allplay__controls,.selects,.allplay__control--overlaid{opacity:0!important;pointer-events:none!important}';
      (document.head || document.documentElement).appendChild(style);
    }
    if (s) { try { channel.postMessage(JSON.stringify(s)); } catch (e) {} }
  }
  function pick(name, id) {
    var b = document.querySelector('[data-select^=' + name + '] .select__drop-item[data-id="' + id + '"]');
    if (b) b.click();
  }
  function quiet(promise) { if (promise && promise.catch) promise.catch(function () {}); }
  setInterval(report, 1000);
  // A pre-roll's own Skip button comes alive after a few seconds and a remote cannot press it:
  // press it as soon as it is.
  setInterval(function () {
    var ad = find(/^(skip|skip ad|skip ads|пропустить|пропустить рекламу)$/, 1);
    if (ad) ad.click();
  }, 1000);
  channel.onmessage = function (event) {
    var command = String(event.data), at = command.indexOf(':');
    var name = at < 0 ? command : command.slice(0, at), arg = at < 0 ? '' : command.slice(at + 1);
    var v = video(), p = allplay();
    if (name === 'toggle') { if (p) quiet(p.togglePlay()); else if (v) { if (v.paused) quiet(v.play()); else v.pause(); } }
    else if (name === 'seek' && v) { var to = v.currentTime + Number(arg); v.currentTime = Math.max(0, v.duration ? Math.min(v.duration - 1, to) : to); }
    else if (name === 'seekto' && v && v.duration) { v.currentTime = Math.max(0, Math.min(v.duration - 1, Number(arg) * v.duration)); }
    else if (name === 'next' || name === 'prev') { var b = button(name); if (b) b.click(); }
    else if (name === 'quality' && (arg === 'auto' || arg === '') && p && p.hls) { p.hls.currentLevel = -1; }
    else if (name === 'quality') {
      var q = document.querySelector('[data-allplay=quality][value="' + arg + '"]');
      if (q) q.click(); else if (p) { try { p.quality = Number(arg); } catch (e) {} }
    }
    else if (name === 'season' || name === 'episode' || name === 'translation') pick(name, arg);
    else if (name === 'skip') { var s = skipButton(); if (s) s.click(); }
    else if (name === 'reload') { var r = find(/^перезагрузить плеер$/, 1); if (r) r.click(); }
    setTimeout(report, 300);
  };
  channel.postMessage('ready');
})();
"""

private fun clock(seconds: Double): String {
    val total = seconds.toInt().coerceAtLeast(0)
    val h = total / 3600; val m = total % 3600 / 60; val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

private fun qualityLabel(value: String) = if (value == "auto" || value.isBlank()) "Авто" else if (value.toIntOrNull() != null) "${value}p" else value

private enum class TvPanel { SEASON, EPISODE, VOICE, QUALITY }

/**
 * An embedded player on TV, with controls of the app's own on top: the provider's page is made for a
 * mouse, so everything a viewer needs from it is repeated here as remote-friendly buttons.
 *
 * With the controls hidden: OK pauses, left/right wind ±10 s (held: ±30 s), up skips the intro, down
 * shows the controls, 0–9 jump to that tenth of the film, the remote's ⏭/⏮ change the episode.
 * Back always leaves the player at once.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TvEmbedPlayer(request: PlayRequest) {
    val url = request.embedUrl ?: return
    val remote = remember(url) { EmbedRemote() }
    val state = remote.state
    var controls by remember { mutableStateOf(true) }
    var panel by remember { mutableStateOf<TvPanel?>(null) }
    var touched by remember { mutableLongStateOf(0L) }
    var osd by remember { mutableStateOf("") }
    val rootFocus = remember { FocusRequester() }
    val playFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) { delay(100); runCatching { rootFocus.requestFocus() } }
    LaunchedEffect(osd) { if (osd.isNotEmpty()) { delay(1_100); osd = "" } }
    LaunchedEffect(controls) {
        if (controls) { delay(60); runCatching { playFocus.requestFocus() } } else runCatching { rootFocus.requestFocus() }
    }
    // The controls step aside after a while of playing, unless a list is open or the film is paused.
    LaunchedEffect(controls, touched, panel, state?.paused) {
        if (!controls || panel != null || state?.paused != false) return@LaunchedEffect
        delay(6_000)
        controls = false
    }
    // Choices made on the title card (season, episode, quality) are carried out once Alloha is up.
    LaunchedEffect(remote) {
        // Alloha must have its stream (a quality chosen) before it takes another episode, or it fails.
        val ready = withTimeoutOrNull(40_000) { snapshotFlow { remote.state }.first { it != null && it.alloha && it.duration > 0 && it.quality.isNotBlank() && it.quality != "0" } } ?: return@LaunchedEffect
        delay(800)
        val season = request.season
        if (season != null && ready.season?.id != season.toString() && ready.seasons.any { it.id == season.toString() }) {
            remote.send("season:$season")
            withTimeoutOrNull(10_000) { snapshotFlow { remote.state }.first { it?.season?.id == season.toString() } }
        }
        val episode = request.episode
        if (episode != null && remote.state?.episode?.id != episode.toString()) {
            remote.send("episode:$episode")
            withTimeoutOrNull(10_000) { snapshotFlow { remote.state }.first { it?.episode?.id == episode.toString() } }
        }
        val quality = request.quality
        if (quality != null) {
            withTimeoutOrNull(30_000) { snapshotFlow { remote.state }.first { (it?.duration ?: 0.0) > 0 && it?.qualities?.contains(quality) == true } }
            if (remote.state?.quality != quality) remote.send("quality:$quality")
        }
    }
    // Alloha's "Упс. Ошибка!" asks for its own reload button, out of a remote's reach: press it, twice at most.
    var reloads by remember(url) { androidx.compose.runtime.mutableIntStateOf(0) }
    LaunchedEffect(state?.failed) {
        if (state?.failed == true && reloads < 2) { delay(1_000); reloads++; remote.send("reload") }
    }
    // The episode on screen is the one "Продолжить" opens next time.
    val season = state?.season?.id?.toIntOrNull()
    val episode = state?.episode?.id?.toIntOrNull()
    LaunchedEffect(season, episode) { if (episode != null) CineStore.recordEpisode(request.title.id, season, episode, state?.translation?.name) }

    fun seek(seconds: Int) { remote.send("seek:$seconds"); osd = if (seconds > 0) "+$seconds с" else "−${-seconds} с" }
    fun toggle() { if (remote.state == null) remote.webView?.let(::tapCenter) else remote.send("toggle") }
    fun next() { remote.send("next"); osd = "Следующая серия" }
    fun prev() { remote.send("prev"); osd = "Предыдущая серия" }
    fun skip() { remote.send("skip"); osd = "Пропускаю заставку" }

    Box(
        Modifier.fillMaxSize().background(Color.Black).focusRequester(rootFocus).focusable()
            .onPreviewKeyEvent { event ->
                touched = System.currentTimeMillis()
                val down = event.type == KeyEventType.KeyDown
                val digit = event.nativeKeyEvent.keyCode.let { if (it in android.view.KeyEvent.KEYCODE_0..android.view.KeyEvent.KEYCODE_9) it - android.view.KeyEvent.KEYCODE_0 else -1 }
                when {
                    digit >= 0 -> { if (down) { remote.send("seekto:${digit / 10.0}"); osd = "${digit * 10}%" }; true }
                    event.key == Key.MediaNext || event.key == Key.ChannelUp -> { if (down) next(); true }
                    event.key == Key.MediaPrevious || event.key == Key.ChannelDown -> { if (down) prev(); true }
                    event.key == Key.MediaFastForward -> { if (down) seek(30); true }
                    event.key == Key.MediaRewind -> { if (down) seek(-30); true }
                    controls -> false
                    event.key == Key.DirectionCenter || event.key == Key.Enter || event.key == Key.NumPadEnter || event.key == Key.MediaPlayPause -> {
                        if (down && event.nativeKeyEvent.repeatCount == 0) { toggle(); controls = true }
                        true
                    }
                    event.key == Key.DirectionLeft || event.key == Key.DirectionRight -> {
                        if (down) {
                            val step = if (event.nativeKeyEvent.repeatCount > 2) 30 else 10
                            seek(if (event.key == Key.DirectionRight) step else -step)
                        }
                        true
                    }
                    event.key == Key.DirectionUp -> { if (down) { if (state?.skip?.isNotEmpty() == true) skip() else controls = true }; true }
                    event.key == Key.DirectionDown -> { if (down) controls = true; true }
                    else -> false
                }
            },
    ) {
        EmbedWebPlayer(url, tvMode = true, remote = remote)

        AnimatedVisibility(visible = osd.isNotEmpty(), enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 36.dp)) {
            Text(osd, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.background(Color.Black.copy(alpha = 0.65f), RoundedCornerShape(12.dp)).padding(horizontal = 20.dp, vertical = 10.dp))
        }
        // The provider's own "Пропустить заставку" can't be pressed with a remote; this one can (or ↑).
        if (!controls && state?.skip?.isNotEmpty() == true) {
            Text("↑  ${state.skip}", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.BottomEnd).padding(36.dp).background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(12.dp))
                    .border(2.dp, Color.White.copy(alpha = 0.7f), RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 10.dp))
        }

        AnimatedVisibility(visible = controls, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().fillMaxHeight(0.55f).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.92f)))))
                Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 48.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(request.title.title, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val details = listOfNotNull(
                        state?.season?.name?.takeIf { (state.seasons.size) > 1 || state.episodes.isNotEmpty() },
                        state?.episode?.name, state?.translation?.name ?: request.providerName.takeIf(String::isNotBlank),
                        state?.quality?.takeIf { it.isNotBlank() && it != "0" }?.let(::qualityLabel),
                    )
                    if (details.isNotEmpty()) Text(details.joinToString(" · "), color = Cine.TextSoft, fontSize = 18.sp)
                    TvProgress(state, onSeek = ::seek)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        TvButton(if (state?.paused == false) "Пауза" else "Смотреть", true, { toggle() }, playFocus, icon = if (state?.paused == false) Icons.Default.Pause else Icons.Default.PlayArrow)
                        TvButton("10 с", false, { seek(-10) }, icon = Icons.Default.FastRewind)
                        TvButton("10 с", false, { seek(10) }, icon = Icons.Default.FastForward)
                        if (state?.alloha == true && state.episodes.isNotEmpty()) {
                            if (state.hasPrev) TvButton("Пред.", false, { prev() }, icon = Icons.Default.SkipPrevious)
                            if (state.hasNext) TvButton("След. серия", false, { next() }, icon = Icons.Default.SkipNext)
                            if (state.seasons.size > 1) TvButton(state.season?.name ?: "Сезон", false, { panel = TvPanel.SEASON }, icon = Icons.Default.VideoLibrary)
                            TvButton(state.episode?.name ?: "Серия", false, { panel = TvPanel.EPISODE }, icon = Icons.Default.ViewList)
                        }
                        if (state?.alloha == true && state.translations.size > 1) TvButton("Озвучка", false, { panel = TvPanel.VOICE }, icon = Icons.Default.ClosedCaption)
                        if (state?.alloha == true && state.qualities.isNotEmpty()) TvButton(qualityLabel(state.quality.takeIf { it.isNotBlank() && it != "0" } ?: "Качество"), false, { panel = TvPanel.QUALITY }, icon = Icons.Default.HighQuality)
                        if (state?.skip?.isNotEmpty() == true) TvButton("Пропустить", false, { skip() }, icon = Icons.Default.Redo)
                    }
                    Text("Стрелки — выбрать · OK — нажать · 0–9 — к 0–90% · ↓ — показать панель при просмотре · Назад — выйти", color = Cine.Muted, fontSize = 14.sp)
                }
            }
        }
    }

    val current = state
    when (panel) {
        TvPanel.SEASON -> if (current != null) TvPickerDialog("Сезон", current.seasons.map { it.name }, current.seasons.indexOfFirst { it.active },
            { remote.send("season:${current.seasons[it].id}"); panel = null }) { panel = null }
        TvPanel.EPISODE -> if (current != null) TvPickerDialog("Серия", current.episodes.map { it.name }, current.episodes.indexOfFirst { it.active },
            { remote.send("episode:${current.episodes[it].id}"); panel = null; osd = current.episodes[it].name }) { panel = null }
        TvPanel.VOICE -> if (current != null) TvPickerDialog("Озвучка", current.translations.map { it.name }, current.translations.indexOfFirst { it.active },
            { remote.send("translation:${current.translations[it].id}"); panel = null }) { panel = null }
        TvPanel.QUALITY -> if (current != null) TvPickerDialog("Качество", current.qualities.map(::qualityLabel), current.qualities.indexOf(current.quality),
            { remote.send("quality:${current.qualities[it]}"); CineStore.preferredQuality = current.qualities[it]; panel = null; osd = qualityLabel(current.qualities[it]) }) { panel = null }
        null -> Unit
    }
}

/** The film's progress; focused, left and right wind it. */
@Composable
private fun TvProgress(state: EmbedState?, onSeek: (Int) -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val duration = state?.duration ?: 0.0
    val fraction = if (duration > 0) ((state?.time ?: 0.0) / duration).toFloat().coerceIn(0f, 1f) else 0f
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(clock(state?.time ?: 0.0), color = Color.White, fontSize = 16.sp)
        Box(
            Modifier.weight(1f).height(if (focused) 10.dp else 6.dp).clip(RoundedCornerShape(5.dp)).background(Color.White.copy(alpha = 0.25f))
                .focusable(interactionSource = interaction)
                .onPreviewKeyEvent { event ->
                    val step = when (event.key) { Key.DirectionRight -> 1; Key.DirectionLeft -> -1; else -> 0 }
                    if (step != 0 && event.type == KeyEventType.KeyDown) onSeek(step * if (event.nativeKeyEvent.repeatCount > 2) 30 else 10)
                    step != 0
                },
        ) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(if (focused) Cine.Accent else Color.White))
        }
        Text(if (duration > 0) clock(duration) else "--:--", color = Color.White, fontSize = 16.sp)
        Spacer(Modifier.width(4.dp))
    }
}
