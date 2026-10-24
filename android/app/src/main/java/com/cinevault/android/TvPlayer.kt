package com.cinevault.android

import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.graphicsLayer
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
  var provider = typeof location !== 'undefined' && /(^|\.)stravers\.live${'$'}/.test(location.hostname);
  // The provider's own controls would flash up before the app's take over: they are hidden from the first
  // frame. What the app presses for the viewer (intro skip) is hidden too but stays in the page, clickable.
  function chrome() {
    if (document.getElementById('cv-tv-chrome')) return;
    var root = document.head || document.documentElement;
    if (!root) return;
    var style = document.createElement('style'); style.id = 'cv-tv-chrome';
    // Alloha's controls and selects; PlayerJS (Turbo): everything over the video but its ad frame.
    style.textContent = '.allplay__controls,.selects,.allplay__control--overlaid,#oframeplayer>pjsdiv:not(:has(video)),[data-cv-hidden]{opacity:0!important;pointer-events:none!important}';
    root.appendChild(style);
  }
  function outer(node) {
    var label = text(node);
    while (node.parentElement && text(node.parentElement) === label) node = node.parentElement;
    return node;
  }
  function hide(node) { if (node && node.setAttribute && !node.hasAttribute('data-cv-hidden')) node.setAttribute('data-cv-hidden', ''); }
  // Harmless where none of those exist, so it goes in before any of them can show.
  chrome();
  // A stream's rungs by their width, since films wider than 16:9 are shorter than their name says (1920×800 is "1080").
  function rung(level) {
    var w = level.width || 0, h = level.height || 0;
    return String(w >= 3200 || h >= 2000 ? 2160 : w >= 2300 || h >= 1300 ? 1440 : w >= 1700 || h >= 1000 ? 1080 : w >= 1100 || h >= 700 ? 720 : w >= 800 || h >= 460 ? 480 : 360);
  }
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
  // PlayerJS (Turbo and others): its API takes a playlist id "xxx-season-episode-voice"; the tree itself
  // only lives in the page's encoded config, read once here.
  function pjs() { var g = window.pljssglobal; return g && g[0] && typeof g[0].api === 'function' ? g[0] : null; }
  var pjsTree = null;
  function pjsPlaylist() {
    if (pjsTree) return pjsTree;
    var scripts = document.scripts || [], encoded = null;
    for (var i = 0; i < scripts.length && !encoded; i++) {
      var m = /new Player(?:js)?\(\s*["']([^"']{200,})["']/.exec(scripts[i].text || '');
      if (m) encoded = m[1];
    }
    if (!encoded) return null;
    var clean = encoded.replace(/\/\/[A-Za-z0-9+\/]{7}=/g, '');
    for (var skip = 0; skip < 160 && !pjsTree; skip++) {
      try {
        var raw = atob(clean.slice(skip).replace(/[^A-Za-z0-9+\/=]/g, '')), at = raw.indexOf('{"');
        if (at < 0 || at > 4) continue;
        var json = JSON.parse(decodeURIComponent(escape(raw.slice(at))));
        if (json && json.file && json.file.length !== undefined) pjsTree = json.file;
      } catch (e) {}
    }
    return pjsTree;
  }
  function pjsValue(label) { return /auto/i.test(label) ? 'auto' : String(parseInt(label, 10) || label); }
  function pjsState(p, s) {
    var call = function (name) { try { return p.api(name); } catch (e) { return null; } };
    var now = String(call('quality') || '');
    s.qualities = (call('qualities') || []).map(pjsValue);
    s.quality = now ? pjsValue(now) : '';
    s.seasons = []; s.episodes = []; s.translations = [];
    var id = String(call('playlist_id') || ''), parts = id.split('-'), prefix = parts.shift(), path = parts.map(Number);
    var tree = pjsPlaylist();
    if (!tree || !path.length) return;
    var chosen = [];
    // The playlist id for picking item [index] at [depth]: the rest of the current path is kept where it still
    // exists (the same voice in the next episode, by name), else it starts at the first item.
    function target(depth, index) {
      var ids = path.slice(0, depth).concat([index]), node = null;
      for (var k = 0; k < ids.length; k++) node = k ? (node && node.folder ? node.folder[ids[k]] : null) : tree[ids[k]];
      for (var r = depth + 1; r < path.length && node && node.folder; r++) {
        var keep = 0;
        for (var q = 0; q < node.folder.length; q++) if (node.folder[q].title === chosen[r]) { keep = q; break; }
        ids.push(keep); node = node.folder[keep];
      }
      return 'pjs:' + prefix + '-' + ids.join('-');
    }
    var level = tree;
    for (var d = 0; d < path.length && level; d++) { chosen[d] = level[path[d]] ? level[path[d]].title : ''; level = level[path[d]] ? level[path[d]].folder : null; }
    // Every level of the current path is offered, named by what its items' titles say they are.
    level = tree;
    for (d = 0; d < path.length && level; d++) {
      var first = (level[0] || {}).title || '';
      var kind = /season|сезон/i.test(first) ? 'seasons' : /episode|серия|эпизод/i.test(first) ? 'episodes' : 'translations';
      s[kind] = level.map(function (item, index) { return {id: target(d, index), name: item.title, active: index === path[d]}; });
      level = level[path[d]] ? level[path[d]].folder : null;
    }
    var eps = s.episodes, at = -1;
    for (var e = 0; e < eps.length; e++) if (eps[e].active) at = e;
    s.hasNext = at >= 0 && at < eps.length - 1; s.hasPrev = at > 0;
    s.pjsNext = s.hasNext ? eps[at + 1].id : ''; s.pjsPrev = s.hasPrev ? eps[at - 1].id : '';
  }
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
      var levels = p.hls && p.hls.levels ? p.hls.levels : [];
      try {
        var level = levels[p.hls ? p.hls.currentLevel : -1];
        // Alloha loads each quality as a stream of its own, a single rung hls.js calls "auto": its own setting tells.
        var adaptive = p.hls && p.hls.autoLevelEnabled && levels.length > 1;
        s.quality = adaptive ? 'auto' : p.quality ? String(p.quality) : level ? rung(level) : '';
      } catch (e) { s.quality = ''; }
      // The provider's own list, plus any rung the stream carries that the list leaves out.
      s.qualities = [].map.call(document.querySelectorAll('[data-allplay=quality]'), function (b) { return b.value; });
      for (var i = 0; i < levels.length; i++) { var r = rung(levels[i]); if (s.qualities.indexOf(r) < 0) s.qualities.push(r); }
      s.qualities.sort(function (a, b) { return Number(b) - Number(a); });
      if (p.hls && levels.length > 1) s.qualities.unshift('auto');
      s.seasons = items('season'); s.episodes = items('episode'); s.translations = items('translation');
      s.hasNext = !!button('next'); s.hasPrev = !!button('prev');
    } else if (pjs()) pjsState(pjs(), s);
    var skip = skipButton();
    if (skip && provider) hide(outer(skip));
    s.skip = skip ? text(skip) : '';
    s.failed = !!find(/^перезагрузить плеер$/, 1);
    return s;
  }
  function report() {
    var s = state();
    // Watching was explicitly requested in the app; Alloha's resume popup must not block the remote.
    var resume = find(/^продолжить просмотр$/, 2);
    if (resume) resume.click();
    if (s && s.alloha) chrome();
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
    else if (name === 'play') { if (p) { if (!v || v.paused) quiet(p.togglePlay()); } else if (pjs()) { try { pjs().api('play'); } catch (e) {} } else if (v && v.paused) quiet(v.play()); }
    else if (name === 'seek' && v) { var to = v.currentTime + Number(arg); v.currentTime = Math.max(0, v.duration ? Math.min(v.duration - 1, to) : to); }
    else if (name === 'seekabs' && v) { v.currentTime = Math.max(0, Number(arg)); }
    else if (name === 'seekto' && v && v.duration) { v.currentTime = Math.max(0, Math.min(v.duration - 1, Number(arg) * v.duration)); }
    else if ((name === 'next' || name === 'prev') && !p && pjs()) {
      var now = {}; pjsState(pjs(), now);
      var to = name === 'next' ? now.pjsNext : now.pjsPrev;
      if (to) pjs().api('find', to.slice(4));
    }
    else if (name === 'next' || name === 'prev') { var b = button(name); if (b) b.click(); }
    else if (name === 'quality' && !p && pjs()) {
      var labels = pjs().api('qualities') || [];
      for (var n = 0; n < labels.length; n++) if (pjsValue(labels[n]) === arg) { pjs().api('quality', n); break; }
    }
    else if ((name === 'season' || name === 'episode' || name === 'translation') && arg.indexOf('pjs:') === 0) { if (pjs()) pjs().api('find', arg.slice(4)); }
    else if (name === 'quality' && (arg === 'auto' || arg === '') && p && p.hls) { p.hls.currentLevel = -1; }
    else if (name === 'quality') {
      var q = document.querySelector('[data-allplay=quality][value="' + arg + '"]'), found = -1, all = p && p.hls && p.hls.levels ? p.hls.levels : [];
      for (var k = 0; k < all.length; k++) if (rung(all[k]) === arg && (found < 0 || (all[k].bitrate || 0) > (all[found].bitrate || 0))) found = k;
      if (q) q.click();
      else if (found >= 0) p.hls.currentLevel = found;
      else if (p) { try { p.quality = Number(arg); } catch (e) {} }
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

internal fun qualityLabel(value: String) = when {
    value == "auto" || value.isBlank() -> "Авто"
    value == "2160" -> "4K"
    value == "1440" -> "2K"
    value.toIntOrNull() != null -> "${value}p"
    else -> value
}

/** The stream's own rung for a wish: the one asked for, else the best below it, else the lowest there is. */
internal fun closestQuality(wanted: String, available: List<String>): String? {
    if (wanted == "auto") return "auto".takeIf { it in available }
    val rungs = available.mapNotNull { it.toIntOrNull() }
    val target = wanted.toIntOrNull() ?: return null
    return (rungs.filter { it <= target }.maxOrNull() ?: rungs.minOrNull())?.toString()
}

/** What sits over the film besides the bar: the episode strip at the bottom or the settings on the right. */
private enum class TvPanel { EPISODES, SETTINGS }

/** The warm accent of the TV screens: progress, ticks, the brand. Focus stays white. */
internal val TvGold = Color(0xFFE9B46A)

/**
 * An embedded player on TV, with controls of the app's own on top: the provider's page is made for a
 * mouse, so everything a viewer needs from it is repeated here, shaped for a remote.
 *
 * Until the film's first frames a loading screen covers the provider's page, which jumps about meanwhile.
 * With the controls hidden: OK brings them up (on "Пропустить заставку" while an intro runs), left/right
 * wind ±10 s (held: ±30 s), 0–9 jump to that tenth of the film, the remote's ⏭/⏮ change the episode.
 * Back closes whatever is open; with nothing open it leaves the film.
 */
@Composable
fun TvEmbedPlayer(request: PlayRequest) {
    val url = request.embedUrl ?: return
    val remote = remember(url) { EmbedRemote() }
    val state = remote.state
    var started by remember(url) { mutableStateOf(false) }
    var controls by remember { mutableStateOf(false) }
    var panel by remember { mutableStateOf<TvPanel?>(null) }
    var touched by remember { mutableLongStateOf(0L) }
    var osd by remember { mutableStateOf("") }
    val rootFocus = remember { FocusRequester() }
    val playFocus = remember { FocusRequester() }
    val skipFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) { delay(100); runCatching { rootFocus.requestFocus() } }
    LaunchedEffect(osd) { if (osd.isNotEmpty()) { delay(1_400); osd = "" } }
    // With the controls up the focus is on "Пропустить заставку" while there is an intro to skip, else on pause.
    LaunchedEffect(controls, panel) {
        if (panel != null) return@LaunchedEffect
        if (controls) {
            val target = if (remote.state?.skip?.isNotEmpty() == true) skipFocus else playFocus
            repeat(20) { delay(50); if (runCatching { target.requestFocus() }.isSuccess) return@LaunchedEffect }
        } else runCatching { rootFocus.requestFocus() }
    }
    // The controls step aside after a while of playing, unless a panel is open or the film is paused.
    LaunchedEffect(controls, touched, panel, state?.paused) {
        if (!controls || panel != null || state?.paused != false) return@LaunchedEffect
        delay(6_000)
        controls = false
    }
    BackHandler(enabled = panel != null) { panel = null }
    BackHandler(enabled = panel == null && controls) { controls = false }

    // "Смотреть" on the title card is the only press needed: the film starts as soon as its page is up, the
    // choices made there (voice, season, episode, quality) are carried out, then it goes on from where it stopped.
    LaunchedEffect(remote) {
        try {
            withTimeoutOrNull(40_000) { snapshotFlow { remote.state }.first { it != null } } ?: return@LaunchedEffect
            delay(500)
            for (attempt in 0 until 3) {
                if (remote.state?.paused == false) break
                remote.send("play")
                withTimeoutOrNull(5_000) { snapshotFlow { remote.state }.first { it?.paused == false } }
            }
            // Alloha must have its stream (a quality chosen) before it takes another episode, or it fails.
            val ready = withTimeoutOrNull(40_000) { snapshotFlow { remote.state }.first { it != null && it.duration > 0 && (!it.alloha || it.quality.isNotBlank() && it.quality != "0") } } ?: return@LaunchedEffect
            delay(600)
            // Alloha's own resume box brings back the voice watched last time; the one chosen on the card wins.
            val voice = request.voice?.lowercase()
            val wanted = voice?.let { name -> ready.translations.firstOrNull { it.name.lowercase() == name } ?: ready.translations.firstOrNull { it.name.lowercase().let { n -> n.contains(name) || name.contains(n) } } }
            if (wanted != null && remote.state?.translation?.id != wanted.id) {
                remote.send("translation:${wanted.id}")
                withTimeoutOrNull(10_000) { snapshotFlow { remote.state }.first { it?.translation?.id == wanted.id && it.duration > 0 } }
                delay(600)
            }
            val season = request.season
            if (season != null && ready.season?.id != season.toString() && ready.seasons.any { it.id == season.toString() }) {
                remote.send("season:$season")
                withTimeoutOrNull(10_000) { snapshotFlow { remote.state }.first { it?.season?.id == season.toString() } }
            }
            val episode = request.episode
            if (episode != null && remote.state?.episode?.id != episode.toString()) {
                remote.send("episode:$episode")
                withTimeoutOrNull(10_000) { snapshotFlow { remote.state }.first { it?.episode?.id == episode.toString() && it.duration > 0 } }
            }
            // The quality wished for, or the best below it the film has: a rung it lacks is never offered.
            val quality = request.quality
            if (quality != null) {
                val listed = withTimeoutOrNull(15_000) { snapshotFlow { remote.state }.first { it?.qualities?.isNotEmpty() == true } }
                val chosen = listed?.let { closestQuality(quality, it.qualities) }
                if (chosen != null && remote.state?.quality != chosen) remote.send("quality:$chosen")
            }
            val resume = request.resumeAt
            val length = remote.state?.duration ?: 0.0
            if (resume != null && resume > 30 && resume < length - 60 && (remote.state?.time ?: 0.0) < resume - 20) {
                delay(800)
                remote.send("seekabs:${resume.toInt()}")
                withTimeoutOrNull(8_000) { snapshotFlow { remote.state }.first { (it?.time ?: 0.0) >= resume - 5 } }
            }
        } finally {
            started = true
        }
    }
    // The loading screen never stays over a film that plays.
    LaunchedEffect(url) { delay(45_000); started = true }
    // Alloha's "Упс. Ошибка!" asks for its own reload button, out of a remote's reach: press it, twice at most.
    var reloads by remember(url) { androidx.compose.runtime.mutableIntStateOf(0) }
    LaunchedEffect(state?.failed) {
        if (state?.failed == true && reloads < 2) { delay(1_000); reloads++; remote.send("reload") }
    }
    // The episode on screen is the one "Продолжить" opens next time, from the second it was left at.
    val seasonNumber = state?.season?.id?.toIntOrNull()
    val episodeNumber = state?.episode?.id?.toIntOrNull()
    LaunchedEffect(seasonNumber, episodeNumber) { if (episodeNumber != null) CineStore.recordEpisode(request.title.id, seasonNumber, episodeNumber, state?.translation?.name) }
    LaunchedEffect(started) {
        while (started) {
            delay(10_000)
            val now = remote.state ?: continue
            if (now.time > 0 && now.duration > 0) CineStore.recordProgress(request.title.id, now.time, now.duration)
        }
    }

    // A held arrow repeats dozens of times a second, and each seek flushes the provider's buffers: sent one by
    // one they can leave its sound and picture apart for the rest of the film. The presses add up and are
    // carried out as a single seek once the keys settle.
    var pendingSeek by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    LaunchedEffect(pendingSeek) {
        if (pendingSeek == 0) return@LaunchedEffect
        delay(350)
        remote.send("seek:$pendingSeek")
        pendingSeek = 0
    }
    fun seek(seconds: Int) { pendingSeek += seconds }
    fun toggle() { if (remote.state == null) remote.webView?.let(::tapCenter) else remote.send("toggle") }
    fun next() { remote.send("next"); osd = "Следующая серия" }
    fun prev() { remote.send("prev"); osd = "Предыдущая серия" }
    fun skip() { remote.send("skip"); osd = "Заставка пропущена"; controls = false }

    Box(
        Modifier.fillMaxSize().background(Color.Black).focusRequester(rootFocus).focusable()
            .onPreviewKeyEvent { event ->
                touched = System.currentTimeMillis()
                val down = event.type == KeyEventType.KeyDown
                if (!started || panel != null) return@onPreviewKeyEvent false
                val digit = event.nativeKeyEvent.keyCode.let { if (it in android.view.KeyEvent.KEYCODE_0..android.view.KeyEvent.KEYCODE_9) it - android.view.KeyEvent.KEYCODE_0 else -1 }
                when {
                    digit >= 0 -> { if (down) { remote.send("seekto:${digit / 10.0}"); osd = "${digit * 10}%" }; true }
                    event.key == Key.MediaNext || event.key == Key.ChannelUp -> { if (down) next(); true }
                    event.key == Key.MediaPrevious || event.key == Key.ChannelDown -> { if (down) prev(); true }
                    event.key == Key.MediaFastForward -> { if (down) seek(30); true }
                    event.key == Key.MediaRewind -> { if (down) seek(-30); true }
                    event.key == Key.MediaPlayPause -> { if (down && event.nativeKeyEvent.repeatCount == 0) { toggle(); controls = true }; true }
                    controls -> false
                    event.key == Key.DirectionLeft || event.key == Key.DirectionRight -> {
                        if (down) {
                            val step = if (event.nativeKeyEvent.repeatCount > 2) 30 else 10
                            seek(if (event.key == Key.DirectionRight) step else -step)
                        }
                        true
                    }
                    // OK, up and down bring the controls; OK never pauses behind the viewer's back.
                    event.key == Key.DirectionCenter || event.key == Key.Enter || event.key == Key.NumPadEnter ||
                        event.key == Key.DirectionUp || event.key == Key.DirectionDown -> { if (down && event.nativeKeyEvent.repeatCount == 0) controls = true; true }
                    else -> false
                }
            },
    ) {
        EmbedWebPlayer(url, tvMode = true, remote = remote)

        // Winding with the controls hidden: the time it lands on, large, over a slim bar.
        val duration = state?.duration ?: 0.0
        if (pendingSeek != 0 && !controls && duration > 0) {
            val target = ((state?.time ?: 0.0) + pendingSeek).coerceIn(0.0, duration)
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
                .padding(horizontal = 56.dp, vertical = 36.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(clock(target), color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
                TvPill(if (pendingSeek > 0) "+$pendingSeek с" else "−${-pendingSeek} с")
                TvTimeline(state?.time ?: 0.0, duration, target)
            }
        }
        AnimatedVisibility(visible = osd.isNotEmpty(), enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 40.dp)) { TvPill(osd) }
        // The provider's "Пропустить заставку" can't be pressed with a remote: OK brings up this one, focused.
        if (!controls && started && state?.skip?.isNotEmpty() == true) {
            Text("OK — пропустить заставку", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.align(Alignment.TopEnd).padding(32.dp).background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(12.dp))
                    .border(1.5.dp, Color.White.copy(alpha = 0.7f), RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 10.dp))
        }

        AnimatedVisibility(visible = controls && panel != TvPanel.EPISODES, enter = fadeIn() + androidx.compose.animation.slideInVertically { it / 6 },
            exit = fadeOut() + androidx.compose.animation.slideOutVertically { it / 6 }, modifier = Modifier.fillMaxSize()) {
            TvPlayerControls(request, state, playFocus, skipFocus, onToggle = ::toggle, onSeek = ::seek, onSkip = ::skip,
                onEpisodes = { panel = TvPanel.EPISODES }, onSettings = { panel = TvPanel.SETTINGS })
        }
        AnimatedVisibility(visible = panel == TvPanel.EPISODES, enter = fadeIn() + androidx.compose.animation.slideInVertically { it / 3 },
            exit = fadeOut() + androidx.compose.animation.slideOutVertically { it / 3 }, modifier = Modifier.align(Alignment.BottomCenter)) {
            if (state != null) TvEpisodeStrip(request.title, state, onSeason = { remote.send("season:$it") }, onEpisode = { remote.send("episode:$it"); panel = null; controls = false })
        }
        AnimatedVisibility(visible = panel == TvPanel.SETTINGS, enter = androidx.compose.animation.slideInHorizontally { it },
            exit = androidx.compose.animation.slideOutHorizontally { it }, modifier = Modifier.align(Alignment.CenterEnd)) {
            if (state != null) TvPlayerSettings(state, request.providerName,
                onVoice = { remote.send("translation:$it"); panel = null },
                onQuality = { value -> remote.send("quality:$value"); CineStore.preferredQuality = value; panel = null; osd = qualityLabel(value) })
        }

        // Until the film shows, a calm loading screen instead of the provider's page assembling itself.
        AnimatedVisibility(visible = !started, enter = fadeIn(), exit = fadeOut(androidx.compose.animation.core.tween(500)), modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                BackdropArt(request.title, Modifier.fillMaxSize().graphicsLayer { alpha = 0.35f })
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.3f), Color.Black.copy(alpha = 0.9f)))))
                Column(Modifier.align(Alignment.BottomStart).padding(56.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text(request.title.title, color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        CircularProgressIndicator(color = TvGold, strokeWidth = 3.dp, modifier = Modifier.size(26.dp))
                        Text(if (request.resumeAt != null && request.resumeAt > 30) "Продолжаем с ${clock(request.resumeAt)}" else "Загружаем…", color = Cine.TextSoft, fontSize = 18.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun TvPill(text: String) {
    Text(text, color = Cine.Background, fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.background(Color.White, RoundedCornerShape(50)).padding(horizontal = 16.dp, vertical = 6.dp))
}

/** The film's line: played part white, a pending jump in gold. */
@Composable
private fun TvTimeline(time: Double, duration: Double, target: Double? = null) {
    val played = if (duration > 0) (time / duration).toFloat().coerceIn(0f, 1f) else 0f
    Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(Color.White.copy(alpha = 0.25f))) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(played).background(Color.White))
        if (target != null && duration > 0) {
            val to = (target / duration).toFloat().coerceIn(0f, 1f)
            Box(Modifier.fillMaxHeight().fillMaxWidth(to).background(TvGold.copy(alpha = 0.85f)))
        }
    }
}

/** A round icon button of the player; white when the remote is on it. */
@Composable
private fun TvRoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit, big: Boolean = false, focus: FocusRequester? = null) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Box(
        Modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(50), scale = 1.08f, interaction = interaction, onClick = onClick)
            .background(if (focused) Color.White else if (big) Color.White.copy(alpha = 0.18f) else Color.Transparent)
            .padding(horizontal = if (big) 30.dp else 14.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = if (focused) Cine.Background else Color.White, modifier = Modifier.size(if (big) 34.dp else 30.dp))
    }
}

/** A text action of the player ("Серии", "Озвучка", "Качество"); filled white in focus. */
@Composable
private fun TvTextAction(text: String, onClick: () -> Unit, focus: FocusRequester? = null, outlined: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Text(
        text, color = if (focused) Cine.Background else Color.White, fontSize = 18.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(12.dp), scale = 1.05f, interaction = interaction, onClick = onClick)
            .background(if (focused) Color.White else if (outlined) Color.Black.copy(alpha = 0.45f) else Color.Transparent)
            .then(if (outlined && !focused) Modifier.border(1.5.dp, Color.White.copy(alpha = 0.75f), RoundedCornerShape(12.dp)) else Modifier)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    )
}

@Composable
private fun TvPlayerControls(
    request: PlayRequest, state: EmbedState?, playFocus: FocusRequester, skipFocus: FocusRequester,
    onToggle: () -> Unit, onSeek: (Int) -> Unit, onSkip: () -> Unit, onEpisodes: () -> Unit, onSettings: () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        // Top: what is playing, and the intro skip where the eye already is.
        Box(Modifier.fillMaxWidth().height(170.dp).background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent))))
        Row(Modifier.fillMaxWidth().padding(horizontal = 48.dp, vertical = 30.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(request.title.title, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val where = listOfNotNull(
                    state?.season?.name?.takeIf { (state.seasons.size) > 1 || state.episodes.isNotEmpty() },
                    state?.episode?.name,
                ).joinToString(" · ").ifBlank { request.providerName }
                Text(where, color = Cine.TextSoft, fontSize = 16.sp)
            }
            if (state?.skip?.isNotEmpty() == true) TvTextAction("Пропустить заставку", onSkip, skipFocus, outlined = true)
        }
        // Bottom: the line, then −10 / pause / +10 in the middle and the film's settings on the right.
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(260.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.88f)))))
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 48.dp, vertical = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            val time = state?.time ?: 0.0
            val duration = state?.duration ?: 0.0
            TvTimeline(time, duration)
            Row(Modifier.fillMaxWidth()) {
                Text(clock(time), color = Color.White, fontSize = 16.sp)
                Spacer(Modifier.weight(1f))
                Text(if (duration > 0) "−" + clock(duration - time) else "--:--", color = Cine.TextSoft, fontSize = 16.sp)
            }
            Box(Modifier.fillMaxWidth()) {
                Row(Modifier.align(Alignment.Center), horizontalArrangement = Arrangement.spacedBy(22.dp), verticalAlignment = Alignment.CenterVertically) {
                    TvRoundButton(Icons.Default.Replay10, "Назад на 10 секунд", { onSeek(-10) })
                    TvRoundButton(if (state?.paused == false) Icons.Default.Pause else Icons.Default.PlayArrow, if (state?.paused == false) "Пауза" else "Смотреть", onToggle, big = true, focus = playFocus)
                    TvRoundButton(Icons.Default.Forward10, "Вперёд на 10 секунд", { onSeek(10) })
                }
                Row(Modifier.align(Alignment.CenterEnd), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (state != null && state.episodes.isNotEmpty()) TvTextAction("Серии", onEpisodes)
                    if (state != null && state.translations.size > 1) TvTextAction("Озвучка", onSettings)
                    if (state != null && state.qualities.size > 1) TvTextAction(qualityLabel(state.quality.takeIf { it.isNotBlank() && it != "0" } ?: "auto").let { if (it == "Авто") "Качество" else it }, onSettings)
                }
            }
        }
    }
}

/** Seasons and episodes in a strip at the bottom; the one playing is marked "Сейчас" and takes the focus. */
@Composable
private fun TvEpisodeStrip(title: CatalogTitle, state: EmbedState, onSeason: (String) -> Unit, onEpisode: (String) -> Unit) {
    val current = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { current.requestFocus() } }
    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.92f))))
            .padding(top = 60.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (state.seasons.size > 1) androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 48.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.seasons.size) { index -> val season = state.seasons[index]; TvChip(season.name, season.active) { onSeason(season.id) } }
        } else Text(state.season?.name ?: "Серии", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 48.dp))
        val start = state.episodes.indexOfFirst { it.active }.coerceAtLeast(0)
        androidx.compose.foundation.lazy.LazyRow(
            state = androidx.compose.foundation.lazy.rememberLazyListState((start - 1).coerceAtLeast(0)),
            contentPadding = PaddingValues(horizontal = 48.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            items(state.episodes.size) { index ->
                val episode = state.episodes[index]
                Column(Modifier.width(220.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.fillMaxWidth().height(124.dp).then(if (episode.active) Modifier.focusRequester(current) else Modifier)
                        .tvFocus(RoundedCornerShape(Cine.PosterRadius), scale = 1.06f, glow = true) { onEpisode(episode.id) }) {
                        BackdropArt(title, Modifier.fillMaxSize().graphicsLayer { alpha = if (episode.active) 1f else 0.7f })
                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.8f))))
                        Text("${index + 1}", color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.BottomStart).padding(12.dp))
                        if (episode.active) Text("Сейчас", color = Cine.Background, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).background(Color.White, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 3.dp))
                    }
                    Text(episode.name, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** "Настройки просмотра": voice and quality in one panel from the right. A tick marks what plays now. */
@Composable
private fun TvPlayerSettings(state: EmbedState, providerName: String, onVoice: (String) -> Unit, onQuality: (String) -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { first.requestFocus() } }
    Column(
        Modifier.width(380.dp).fillMaxHeight().background(Color(0xF0141317)).padding(horizontal = 22.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Настройки просмотра", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 10.dp))
        androidx.compose.foundation.lazy.LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            var focusGiven = false
            if (state.translations.size > 1) {
                item { Text("Озвучка", color = Cine.Muted, fontSize = 15.sp, modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)) }
                val giveFocus = !focusGiven; focusGiven = true
                items(state.translations.size) { index ->
                    val voice = state.translations[index]
                    TvSettingRow(voice.name, voice.active, if (giveFocus && (voice.active || (index == 0 && state.translations.none { it.active }))) first else null) { onVoice(voice.id) }
                }
            }
            if (state.qualities.size > 1) {
                item { Text("Качество", color = Cine.Muted, fontSize = 15.sp, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp)) }
                val giveFocus = !focusGiven; focusGiven = true
                items(state.qualities.size) { index ->
                    val value = state.qualities[index]
                    val active = value == state.quality
                    TvSettingRow(qualityLabel(value), active, if (giveFocus && (active || (index == 0 && state.qualities.none { it == state.quality }))) first else null) { onQuality(value) }
                }
            }
            if (providerName.isNotBlank()) item {
                Text("Плеер · $providerName", color = Cine.Muted, fontSize = 15.sp, modifier = Modifier.padding(top = 18.dp))
            }
        }
    }
}

@Composable
private fun TvSettingRow(text: String, selected: Boolean, focus: FocusRequester?, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        Modifier.fillMaxWidth().then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(12.dp), scale = 1.02f, interaction = interaction, onClick = onClick)
            .background(if (focused) Color.White else Color.White.copy(alpha = 0.06f)).padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = if (focused) Cine.Background else Color.White, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (selected) Icon(Icons.Default.Check, null, tint = if (focused) Cine.Background else TvGold)
    }
}
