@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.cinevault.android

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** One video of a list handed to the player: an episode of a voice, or a voice of a film. */
data class PlayEntry(val label: String, val season: Int, val episode: Int, val entry: JSONObject, val name: String = "", val still: String = "")

/** What the player opens: the list, where to start, the first stream and what to call it. */
data class LampacPlay(
    val item: TvItem, val entries: List<PlayEntry>, val index: Int, val first: LampacStream, val voice: String, val isMovie: Boolean,
    val sourceName: String, val season: Int = 0, val episode: Int = 0,
    /** The source's other voices of a series ("name", "url", "active"), switched in the player itself. */
    val voices: List<JSONObject> = emptyList(), val sourceId: String = "",
)

private data class WatchSource(val id: String, val name: String, val node: LampacNode, val lines: Int = 0)

private sealed interface WatchBody {
    data object Skeleton : WatchBody
    data class Message(val text: String, val retry: Boolean = false) : WatchBody
    data class Movie(val voices: List<PlayEntry>, val chosen: Int) : WatchBody
    data class Episodes(val list: List<PlayEntry>, val start: Int, val voices: List<JSONObject>, val activeVoice: String,
                        val seasons: List<JSONObject>, val seasonNumber: Int, val picked: Boolean, val missing: Boolean, val voiceLines: Int = 0) : WatchBody
}

/**
 * «Где смотреть», as on the site (openLampacChooser). A series opens in two steps: first season and episode
 * (from TMDB, at once), then source, voice and quality, with one «Смотреть» button. Sources are searched in
 * the background while the episode is picked, and every wait says what is loading and, when it drags on,
 * that the source is slow and another one can be chosen.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TvWatch(initial: TvItem, season: Int, episode: Int, onClose: () -> Unit, onPlay: (LampacPlay) -> Unit) {
    val scope = rememberCoroutineScope()
    var item by remember { mutableStateOf(initial) }
    var ready by remember { mutableStateOf(initial.detailed && (initial.imdbId.isNotBlank() || initial.seasons.isNotEmpty() || !initial.isSeries)) }
    val series = initial.isSeries
    val saved = remember { TvState.lampacChoice(initial.id) }
    val record = remember { TvState.latest(initial.id) }
    var wantSeason by remember { mutableIntStateOf(season.takeIf { it > 0 } ?: record?.season?.takeIf { it > 0 } ?: 1) }
    var wantEpisode by remember { mutableIntStateOf(episode) }
    var step by remember { mutableStateOf(if (series && episode == 0) "episode" else "source") }
    var stepSeason by remember { mutableIntStateOf(wantSeason) }
    var stepNames by remember { mutableStateOf<Map<Int, TvEpisode>>(emptyMap()) }
    var pickedName by remember { mutableStateOf("") }

    val sources = remember { mutableStateListOf<WatchSource>() }
    var pending by remember { mutableIntStateOf(0) }
    var finished by remember { mutableStateOf(false) }
    var listFailed by remember { mutableStateOf(false) }
    var searchDone by remember { mutableIntStateOf(0) }
    var searchTotal by remember { mutableIntStateOf(0) }
    var searchStarted by remember { mutableStateOf(System.currentTimeMillis()) }
    var attempt by remember { mutableIntStateOf(0) }
    var active by remember { mutableStateOf("") }
    var touched by remember { mutableStateOf(false) }
    var body by remember { mutableStateOf<WatchBody>(WatchBody.Skeleton) }
    var status by remember { mutableStateOf("") }
    var statusBusy by remember { mutableStateOf(false) }
    var slow by remember { mutableStateOf("") }
    var token by remember { mutableIntStateOf(0) }
    var busyJob by remember { mutableStateOf<Job?>(null) }
    var lines by remember { mutableIntStateOf(TvState.preferredLines) }
    var closed by remember { mutableStateOf(false) }
    val startFocus = remember { FocusRequester() }
    val firstFocus = remember { FocusRequester() }

    fun setStatus(text: String, busy: Boolean = false) { status = text; statusBusy = busy; slow = "" }

    /** Something asked for is loading: the status says what, and after a while that the source is just slow. */
    fun busy(text: String) {
        busyJob?.cancel()
        setStatus(text, busy = true)
        busyJob = scope.launch {
            delay(7_000)
            if (statusBusy && status == text) slow = "Источник отвечает медленно. Можно подождать или выбрать другой источник выше."
        }
    }
    fun done() { busyJob?.cancel(); busyJob = null; setStatus("") }

    DisposableCloser { closed = true }

    LaunchedEffect(initial.id) {
        if (!ready) {
            runCatching { Tmdb.title(initial.id) }.onSuccess { item = it; TvState.remember(it) }
            ready = true
        }
    }

    fun sourceName() = sources.firstOrNull { it.id == active }?.name.orEmpty()

    fun play(list: List<PlayEntry>, index: Int, voiceName: String, isMovie: Boolean, voices: List<JSONObject> = emptyList()) {
        val mine = ++token
        val target = list[index]
        busy("Открываю видео: ${target.label}${if (voiceName.isNotBlank() && !isMovie) ", $voiceName" else ""}…")
        scope.launch {
            val first = runCatching { Lampac.stream(target.entry) }.getOrNull()
            if (closed || mine != token) return@launch
            done()
            if (first == null || first.url.isBlank()) {
                setStatus("Видео не открылось: источник не отдал ссылку. Попробуйте другую озвучку или источник.")
                return@launch
            }
            TvState.rememberLampacChoice(item.id, source = active, voice = voiceName)
            onPlay(LampacPlay(item, list, index, first, voiceName, isMovie, sourceName(), target.season, target.episode, voices, active))
        }
    }

    fun renderEpisodes(node: LampacNode, seasons: List<JSONObject>, seasonNumber: Int) {
        val voices = node.voices
        val activeVoice = voices.firstOrNull { it.optBoolean("active") }?.optString("name").orEmpty()
        val list = node.data.mapIndexed { index, entry ->
            val s = entry.optString("s").toIntOrNull() ?: seasonNumber
            val e = entry.optString("e").toIntOrNull() ?: (index + 1)
            PlayEntry(entry.optString("name").ifBlank { "$e серия" }, s, e, entry)
        }
        val picked = series && step == "source" && wantEpisode > 0
        var start = list.indexOfFirst { it.season == wantSeason && it.episode == wantEpisode }
        if (picked && start < 0) {
            body = WatchBody.Episodes(list, 0, voices, activeVoice, seasons, seasonNumber, picked = true, missing = true)
            return
        }
        val startRecord = list.getOrNull(start)?.let { TvState.progressOf(item.id, it.season, it.episode) }
        if (!picked && start >= 0 && startRecord?.completed == true && start + 1 < list.size) start += 1
        if (start < 0) start = 0
        body = WatchBody.Episodes(list, start, voices, activeVoice, seasons, seasonNumber, picked, missing = false)
        // The source badge is its best; what this voice really gives is checked on its first episode.
        val mine = token
        scope.launch {
            val voiceLines = runCatching { Lampac.sourceQuality(LampacNode("episode", listOf(list.first().entry), emptyList())) }.getOrDefault(0)
            val now = body
            if (voiceLines > 0 && mine == token && now is WatchBody.Episodes) body = now.copy(voiceLines = voiceLines)
        }
    }

    fun loadNode(url: String, seasons: List<JSONObject>, seasonNumber: Int, preferSavedVoice: Boolean = false, text: String = "Загружаю серии и озвучки…") {
        val mine = ++token
        busy(text)
        scope.launch {
            try {
                var node = Lampac.node(url)
                if (preferSavedVoice && node?.type == "episode" && saved.second.isNotBlank()) {
                    val voice = node.voices.firstOrNull { it.optString("name") == saved.second && !it.optBoolean("active") && it.optString("url").isNotBlank() }
                    if (voice != null) node = Lampac.node(voice.optString("url"))
                }
                if (closed || mine != token) return@launch
                done()
                when {
                    node?.type == "episode" && node.data.isNotEmpty() -> renderEpisodes(node, seasons, seasonNumber)
                    node?.type == "season" && node.data.isNotEmpty() -> openSeasonsLater(node) { url2, list2, number2 -> loadNode(url2, list2, number2, true) }
                    else -> body = WatchBody.Message("Здесь пусто. Выберите другой источник.")
                }
            } catch (error: Exception) {
                if (closed || mine != token) return@launch
                done()
                setStatus("Источник не ответил. Выберите другой источник выше или нажмите ещё раз.")
            }
        }
    }

    fun openSeasons(node: LampacNode) {
        // A source may glue a spin-off on as an extra season: only seasons TMDB knows are offered.
        val maxSeason = item.seasons.maxOfOrNull { it.number } ?: 0
        val fitting = if (maxSeason > 0) node.data.filterIndexed { index, entry -> Lampac.number(entry, index + 1) <= maxSeason } else node.data
        val seasons = fitting.ifEmpty { node.data }
        val index = seasons.indexOfFirst { entry -> Lampac.number(entry, seasons.indexOf(entry) + 1) == wantSeason }.coerceAtLeast(0)
        loadNode(seasons[index].optString("url"), seasons, Lampac.number(seasons[index], index + 1), preferSavedVoice = true)
    }

    fun select(id: String) {
        val source = sources.firstOrNull { it.id == id } ?: return
        active = id
        token++
        busyJob?.cancel()
        if (step == "episode") return
        setStatus(if (finished) "" else "Ищу ещё источники… найдено ${sources.size}", busy = !finished)
        when (source.node.type) {
            "movie" -> {
                val voices = source.node.data.mapIndexed { index, entry ->
                    PlayEntry(entry.optString("translate").ifBlank { entry.optString("title") }.ifBlank { "Вариант ${index + 1}" }, 0, 0, entry,
                        name = listOf(entry.optString("maxquality"), entry.optString("voice_name")).filter(String::isNotBlank).distinct().joinToString(" · ")).let { voice -> if (voice.name == voice.label) voice.copy(name = "") else voice }
                }
                body = WatchBody.Movie(voices, voices.indexOfFirst { saved.second.isNotBlank() && it.label == saved.second }.coerceAtLeast(0))
            }
            "season" -> { body = WatchBody.Skeleton; busy("Загружаю серии и озвучки: ${source.name}…"); openSeasons(source.node) }
            else -> renderEpisodes(source.node, emptyList(), wantSeason)
        }
    }

    fun goToSource(s: Int, e: Int, name: String = "") {
        wantSeason = s
        wantEpisode = e
        pickedName = name
        step = "source"
        if (active.isNotBlank()) select(active) else { body = WatchBody.Skeleton; setStatus(if (sources.isEmpty()) "Ищу источники…" else "", busy = sources.isEmpty()) }
    }

    // The search for sources, in the background from the first second.
    LaunchedEffect(ready, attempt) {
        if (!ready) return@LaunchedEffect
        sources.clear(); pending = 0; finished = false; listFailed = false; searchDone = 0; searchTotal = 0; searchStarted = System.currentTimeMillis()
        if (step == "source") { body = WatchBody.Skeleton; setStatus("Ищу источники…", busy = true) }
        val lookups = mutableListOf<Job>()
        val listed = runCatching {
            Lampac.sources(item, onEntries = { entries ->
                entries.forEach { entry ->
                    lookups += scope.launch {
                        val id = entry.optString("balanser").ifBlank { entry.optString("name") }.ifBlank { entry.optString("url") }
                        pending++
                        val node = runCatching { Lampac.resolve(Lampac.sourceUrl(entry.optString("url"), item), item) }.getOrNull()
                        pending--
                        if (closed || node == null) return@launch
                        val source = WatchSource(id, entry.optString("name").ifBlank { id }, node)
                        sources.add(source)
                        scope.launch {
                            val best = runCatching { Lampac.sourceQuality(node) }.getOrDefault(0)
                            val position = sources.indexOfFirst { it.id == id }
                            if (best > 0 && position >= 0) sources[position] = sources[position].copy(lines = best)
                        }
                        if (active.isBlank() || (id == saved.first && !touched)) select(id)
                        else if (step == "source" && !finished && (status.startsWith("Ищу") || status.isBlank())) setStatus("Ищу ещё источники… найдено ${sources.size}", busy = true)
                    }
                }
            }, isClosed = { closed }, onProgress = { doneCount, total -> searchDone = doneCount; searchTotal = total })
        }.getOrDefault(0)
        if (closed) return@LaunchedEffect
        if (listed == 0) {
            finished = true; listFailed = true
            setStatus("Сервер с источниками не отвечает.")
            body = WatchBody.Message("Сервер с источниками не отвечает.", retry = true)
            return@LaunchedEffect
        }
        lookups.toList().forEach { it.join() }
        finished = true
        if (sources.isEmpty()) {
            setStatus("")
            body = WatchBody.Message("Ни один источник пока не нашёл «${item.title}». Новинки обычно появляются в течение нескольких дней.", retry = true)
        } else if (status.startsWith("Ищу ещё")) setStatus("")
    }
    // While sources are being checked the viewer sees how far it got, not a frozen spinner.
    LaunchedEffect(searchDone, searchTotal, sources.size, finished) {
        if (finished || active.isNotBlank() || step != "source") return@LaunchedEffect
        val counted = if (searchTotal > 0) "проверено $searchDone из $searchTotal" else ""
        setStatus(if (searchTotal > 0 && searchDone >= searchTotal) "Жду ответа от источников…" else "Проверяю источники${if (counted.isNotBlank()) ": $searchDone из $searchTotal" else "…"}", busy = true)
        delay(maxOf(0, 8_000 - (System.currentTimeMillis() - searchStarted)))
        if (!finished && active.isBlank()) slow = "Источники иногда отвечают до полуминуты — окно не зависло."
    }
    // Step 1: episode names and stills of the season shown, from TMDB.
    LaunchedEffect(step, stepSeason, item.tmdbId) {
        if (step != "episode" || item.tmdbId == 0) return@LaunchedEffect
        stepNames = runCatching { Tmdb.episodes(item.tmdbId, stepSeason) }.getOrDefault(emptyList()).associateBy { it.number }
    }
    LaunchedEffect(step, ready) {
        if (step == "episode" && ready && item.seasons.isEmpty()) goToSource(wantSeason, wantEpisode)
    }
    LaunchedEffect(step, body::class, active) {
        delay(150)
        runCatching { if (step == "source" && (body is WatchBody.Movie || body is WatchBody.Episodes)) startFocus.requestFocus() else firstFocus.requestFocus() }
    }

    val bgNote = when {
        pending > 0 || !finished -> "Пока выбираете — ищу источники и озвучки${if (sources.isNotEmpty()) ": уже ${countWord(sources.size, "источник", "источника", "источников")}" else "…"}"
        sources.isNotEmpty() -> "✓ Готово: ${countWord(sources.size, "источник", "источника", "источников")}"
        else -> "Источники не нашли этот ${if (series) "сериал" else "фильм"}."
    }

    Box(Modifier.fillMaxSize().background(Hall.Bg)) {
        Backdrop(Tmdb.image(item.backdrop, "w1280"), strength = 0.3f)
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Hall.Bg.copy(alpha = 0.2f), Hall.Bg.copy(alpha = 0.9f)))))
        Column(
            Modifier.align(Alignment.CenterEnd).width(720.dp).fillMaxHeight().background(Hall.SurfaceGlass).padding(horizontal = 34.dp, vertical = 26.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            HText("Где смотреть", size = Hall.S_1, color = Hall.Accent, weight = FontWeight.SemiBold)
            HText(item.title, size = Hall.S3, weight = FontWeight.Bold, display = true, maxLines = 1)
            CompositionLocalProvider(LocalBringIntoViewSpec provides remember { TvPageScroll(top = 0.05f, bottom = 0.08f, target = 0.1f) }) {
                LazyColumn(Modifier.fillMaxWidth().weight(1f), rememberLazyListState(), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp)) {
                    if (step == "episode") {
                        item(key = "step1") {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                HText("Шаг 1 из 2", size = Hall.S_1, color = Hall.Muted)
                                HText("Выберите серию", size = Hall.S2, weight = FontWeight.SemiBold, display = true)
                            }
                        }
                        val seasons = item.seasons
                        val resumeS = record?.season ?: 0
                        val resumeE = record?.episode ?: 0
                        val resume: Pair<Pair<Int, Int>, Pair<String, String>>? = when {
                            resumeS > 0 && resumeE > 0 && record?.completed == false ->
                                (resumeS to resumeE) to ("Продолжить · $resumeS сезон, $resumeE серия" to if (record.real) "Остановились на ${tvClock(record.position)}" else "")
                            resumeS > 0 && resumeE > 0 -> {
                                val inSeason = seasons.firstOrNull { it.number == resumeS }?.episodes ?: 0
                                val nextSeason = seasons.firstOrNull { it.number > resumeS }
                                val next = if (resumeE < inSeason) resumeS to resumeE + 1 else nextSeason?.let { it.number to 1 }
                                next?.let { it to ("Дальше · ${it.first} сезон, ${it.second} серия" to "$resumeS сезон, $resumeE серия просмотрена") }
                            }
                            else -> null
                        }
                        if (resume != null) item(key = "resume") {
                            HButton(resume.second.first, { goToSource(resume.first.first, resume.first.second) }, primary = true, icon = Icons.Default.PlayArrow,
                                focus = firstFocus, note = resume.second.second, big = true)
                        }
                        if (seasons.size > 1) item(key = "seasons") {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                HText("Сезон", size = Hall.S_1, color = Hall.Muted)
                                FlowRow(Modifier.padding(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    seasons.forEach { entry -> HChip("${entry.number}", entry.number == stepSeason, { stepSeason = entry.number }) }
                                }
                            }
                        }
                        val count = seasons.firstOrNull { it.number == stepSeason }?.episodes ?: 0
                        item(key = "count-$stepSeason") { HText("$stepSeason сезон · ${countWord(count, "серия", "серии", "серий")}", size = Hall.S_1, color = Hall.Muted) }
                        item(key = "cells-$stepSeason") {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                (1..count).forEach { number ->
                                    val progress = TvState.progressOf(item.id, stepSeason, number)
                                    val current = stepSeason == resumeS && number == resumeE
                                    val name = stepNames[number]?.name.orEmpty()
                                    val future = stepNames[number]?.airDate?.let { it.isNotBlank() && it > Tmdb.day() } == true
                                    EpisodeCell(number, name.ifBlank { "$number серия" }, current, progress?.completed == true, progress?.takeIf { !it.completed }?.share ?: 0.0, future,
                                        if (resume == null && number == 1 || (resume != null && false)) firstFocus else null) { goToSource(stepSeason, number, name) }
                                }
                            }
                        }
                        item(key = "bg") { StatusLine(bgNote, busy = pending > 0 || !finished) }
                    } else {
                        if (series && wantEpisode > 0) item(key = "picked") {
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    HText("Шаг 2 из 2 · источник и озвучка", size = Hall.S_1, color = Hall.Muted)
                                    HText("$wantSeason сезон, $wantEpisode серия${if (pickedName.isNotBlank()) " «$pickedName»" else ""}", size = Hall.S1, weight = FontWeight.SemiBold, maxLines = 1)
                                }
                                if (item.seasons.isNotEmpty()) HButton("Сменить серию", { token++; done(); stepSeason = wantSeason; step = "episode" })
                            }
                        }
                        item(key = "sources") {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                HText("Источник", size = Hall.S_1, color = Hall.Muted)
                                if (sources.isEmpty()) HText(if (finished) "Источников нет" else "Ищу…", size = Hall.S0, color = Hall.Faint)
                                else FlowRow(Modifier.padding(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    sources.forEach { source ->
                                        HChip(source.name, source.id == active, { touched = true; select(source.id) },
                                            focus = if (body !is WatchBody.Movie && body !is WatchBody.Episodes && source == sources.first()) firstFocus else null,
                                            badge = source.lines.takeIf { it > 0 }?.let { "до ${Lampac.qualityLabel(it)}" })
                                    }
                                }
                            }
                        }
                        if (status.isNotBlank()) item(key = "status") { StatusLine(status, busy = statusBusy, slow = slow.ifBlank { null }) }
                        when (val shown = body) {
                            WatchBody.Skeleton -> item(key = "skeleton") { Skeleton() }
                            is WatchBody.Message -> item(key = "message") {
                                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                    HText(shown.text, size = Hall.S0, color = Hall.Text2)
                                    if (shown.retry) HButton("Повторить", { attempt++ }, focus = firstFocus)
                                }
                            }
                            is WatchBody.Movie -> {
                                val chosen = shown.voices[shown.chosen]
                                val resumeRecord = TvState.progressOf(item.id)
                                val resuming = resumeRecord != null && !resumeRecord.completed && resumeRecord.real
                                item(key = "start") {
                                    HButton("${if (resuming) "Продолжить" else "Смотреть"} · ${chosen.label}", { touched = true; play(shown.voices, shown.chosen, chosen.label, true) },
                                        primary = true, icon = Icons.Default.PlayArrow, focus = startFocus, big = true, busy = statusBusy && status.startsWith("Открываю"),
                                        note = listOfNotNull(sourceName(), resumeRecord?.takeIf { resuming }?.let { "остановились на ${tvClock(it.position)}" }).joinToString(" · "))
                                }
                                item(key = "quality") { QualityPick(sources.firstOrNull { it.id == active }?.lines ?: 0, lines) { lines = it; TvState.preferredLines = it } }
                                item(key = "voices") {
                                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        HText("Озвучка", size = Hall.S_1, color = Hall.Muted)
                                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            shown.voices.forEachIndexed { index, voice ->
                                                HChip(voice.label, index == shown.chosen, { touched = true; body = shown.copy(chosen = index) }, badge = voice.name.ifBlank { null })
                                            }
                                        }
                                    }
                                }
                            }
                            is WatchBody.Episodes -> {
                                if (shown.missing) item(key = "missing") {
                                    HText("В этом источнике${if (shown.activeVoice.isNotBlank()) " с озвучкой «${shown.activeVoice}»" else ""} нет $wantEpisode серии $wantSeason сезона. Выберите другую озвучку или источник выше.",
                                        size = Hall.S0, color = Hall.Text2)
                                } else item(key = "start") {
                                    val start = shown.list[shown.start]
                                    val progress = TvState.progressOf(item.id, start.season, start.episode)
                                    val resuming = progress != null && !progress.completed && progress.real
                                    HButton("${if (resuming) "Продолжить" else "Смотреть"} · ${start.season} сезон, ${start.label}${if (shown.activeVoice.isNotBlank()) ", ${shown.activeVoice}" else ""}",
                                        { touched = true; play(shown.list, shown.start, shown.activeVoice, false, shown.voices) }, primary = true, icon = Icons.Default.PlayArrow,
                                        focus = startFocus, big = true, busy = statusBusy && status.startsWith("Открываю"),
                                        note = listOfNotNull(sourceName(), progress?.takeIf { resuming }?.let { "остановились на ${tvClock(it.position)}" }).joinToString(" · "))
                                }
                                if (!shown.missing) item(key = "quality") { QualityPick(shown.voiceLines.takeIf { it > 0 } ?: sources.firstOrNull { it.id == active }?.lines ?: 0, lines) { lines = it; TvState.preferredLines = it } }
                                if (shown.voices.isNotEmpty()) item(key = "voices") {
                                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        HText(if (shown.missing) "Другие озвучки этого источника" else "Озвучка", size = Hall.S_1, color = Hall.Muted)
                                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            shown.voices.forEachIndexed { index, voice ->
                                                val name = voice.optString("name")
                                                HChip(name, voice.optBoolean("active"), {
                                                    touched = true
                                                    TvState.rememberLampacChoice(item.id, voice = name)
                                                    voice.optString("url").takeIf(String::isNotBlank)?.let { loadNode(it, shown.seasons, shown.seasonNumber, text = "Переключаю озвучку на «$name»…") }
                                                }, focus = if (shown.missing && index == 0) startFocus else null)
                                            }
                                        }
                                    }
                                }
                                if (!shown.picked && !shown.missing) {
                                    if (shown.seasons.size > 1) item(key = "lampac-seasons") {
                                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(4.dp)) {
                                            items(shown.seasons.size) { index ->
                                                val entry = shown.seasons[index]
                                                val number = Lampac.number(entry, index + 1)
                                                HChip(entry.optString("name").ifBlank { "$number сезон" }, number == shown.seasonNumber, {
                                                    loadNode(entry.optString("url"), shown.seasons, number, text = "Загружаю серии: $number сезон…")
                                                })
                                            }
                                        }
                                    }
                                    item(key = "lampac-episodes") {
                                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                            shown.list.forEachIndexed { index, entry ->
                                                val progress = TvState.progressOf(item.id, entry.season, entry.episode)
                                                EpisodeCell(entry.episode, entry.label, index == shown.start, progress?.completed == true, progress?.takeIf { !it.completed }?.share ?: 0.0, false, null) {
                                                    play(shown.list, index, shown.activeVoice, false, shown.voices)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            HText("«Назад» — закрыть", size = Hall.S_1, color = Hall.Faint)
        }
    }
}

/** Runs [onDispose] when the window goes, so late answers do nothing. */
@Composable
private fun DisposableCloser(onDispose: () -> Unit) {
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { onDispose() } }
}

private fun openSeasonsLater(node: LampacNode, load: (String, List<JSONObject>, Int) -> Unit) {
    val seasons = node.data
    if (seasons.isEmpty()) return
    load(seasons.first().optString("url"), seasons, Lampac.number(seasons.first(), 1))
}

@Composable
private fun EpisodeCell(number: Int, name: String, current: Boolean, watched: Boolean, share: Double, future: Boolean, focus: FocusRequester?, onClick: () -> Unit) {
    val (interaction, focused) = rememberFocused()
    Column(
        Modifier.width(150.dp).then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .hallFocus(RoundedCornerShape(Hall.R), interaction = interaction, onClick = onClick)
            .background(if (focused) Hall.Text else if (current) Hall.AccentSoft else Hall.Surface).padding(horizontal = 12.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            HText("$number", size = Hall.S1, weight = FontWeight.Bold, display = true, color = if (focused) Hall.Bg else if (current) Hall.Accent else Hall.Text)
            Spacer(Modifier.width(8.dp))
            if (watched) HText("✓", size = Hall.S_1, color = if (focused) Hall.Bg else Hall.Accent)
            if (future) HText("скоро", size = Hall.S_1, color = if (focused) Hall.Bg else Hall.Gold)
        }
        HText(name, size = Hall.S_1, color = if (focused) Hall.Bg else Hall.Text2, maxLines = 1)
        if (share > 0) { Spacer(Modifier.height(3.dp)); ProgressBar(share, Modifier.fillMaxWidth()) }
    }
}

/** «Качество» before starting: Авто, or a rung up to what the source gives; remembered for next time. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QualityPick(maxLines: Int, chosen: Int, onPick: (Int) -> Unit) {
    val steps = listOf(2160, 1440, 1080, 720, 480).filter { maxLines == 0 || it <= maxLines }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        HText("Качество", size = Hall.S_1, color = Hall.Muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HChip("Авто", chosen == 0, { onPick(0) })
            steps.forEach { value -> HChip(Lampac.qualityLabel(value), chosen == value, { onPick(value) }) }
        }
    }
}

@Composable
private fun Skeleton() {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.width(320.dp).height(52.dp).clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface))
        Box(Modifier.width(90.dp).height(14.dp).clip(RoundedCornerShape(4.dp)).background(Hall.Surface))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { repeat(4) { Box(Modifier.width(110.dp).height(36.dp).clip(RoundedCornerShape(50)).background(Hall.Surface)) } }
    }
}
