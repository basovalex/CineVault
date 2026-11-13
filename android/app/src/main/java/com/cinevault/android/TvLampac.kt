package com.cinevault.android

import kotlinx.coroutines.delay
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** A video Lampac gives: the stream, its qualities (label → link) and subtitles. */
data class LampacStream(val url: String, val qualities: Map<String, String>, val subtitles: List<Pair<String, String>>)

/** A source's answer: a film's voices ("movie"), a list of seasons ("season") or a season's episodes ("episode"). */
data class LampacNode(val type: String, val data: List<JSONObject>, val voices: List<JSONObject>)

/**
 * Lampac, as the site uses it (app.js lampac*): a self-hosted server that finds the title on many sources
 * and returns seasons, voices and direct streams; the TV only draws them and plays the stream with Media3.
 */
object Lampac {
    private suspend fun origin() = TvNet.config().lampacOrigin

    /** The public Lampac lets in only known device ids: the server's own one goes on every /lite and /lifeevents call. */
    suspend fun withUid(url: String): String {
        val config = TvNet.config()
        if (config.lampacUid.isBlank() || url.isBlank()) return url
        val target = url.toHttpUrlOrNull() ?: return url
        val home = config.lampacOrigin.toHttpUrlOrNull() ?: return url
        if (target.host != home.host || !Regex("^/(lite|lifeevents)").containsMatchIn(target.encodedPath)) return url
        if (target.queryParameter("uid") != null) return url
        return target.newBuilder().addQueryParameter("uid", config.lampacUid).build().toString()
    }

    private suspend fun absolute(url: String): String = if (url.startsWith("http")) url else origin() + (if (url.startsWith("/")) url else "/$url")

    suspend fun json(url: String, timeoutMs: Long = 15_000): Any? {
        val target = withUid(absolute(url)).toHttpUrlOrNull()?.newBuilder()?.setQueryParameter("rjson", "true")?.build()?.toString() ?: return null
        val text = TvNet.get(target, timeoutMs).trim()
        return when {
            text.startsWith("{") -> JSONObject(text)
            text.startsWith("[") -> JSONArray(text)
            else -> null
        }
    }

    fun query(item: TvItem): List<Pair<String, String>> = buildList {
        add("kinopoisk_id" to "")
        add("title" to item.title)
        add("original_title" to item.originalTitle.ifBlank { item.title })
        add("year" to (if (item.year > 0) "${item.year}" else ""))
        add("serial" to if (item.isSeries) "1" else "0")
        if (item.imdbId.isNotBlank()) add("imdb_id" to item.imdbId)
        add("id" to "${item.tmdbId}")
    }

    private fun queryString(item: TvItem) = query(item).joinToString("&") { (key, value) -> "$key=${enc(value)}" }

    /** A source's address with the title's ids on top, as Lampa does. */
    suspend fun sourceUrl(url: String, item: TvItem): String {
        val builder = absolute(url).toHttpUrlOrNull()?.newBuilder() ?: return url
        val built = builder.build()
        query(item).forEach { (key, value) -> if (built.queryParameter(key) == null) builder.addQueryParameter(key, value) }
        return builder.build().toString()
    }

    /**
     * The list of sources, as Lampa gets it: "life" mode answers at once with a key, then /lifeevents is polled
     * and every source is handed over the moment it is found. Falls back to the one-shot list.
     */
    suspend fun sources(item: TvItem, onEntries: (List<JSONObject>) -> Unit, isClosed: () -> Boolean, onProgress: (Int, Int) -> Unit): Int {
        val query = queryString(item)
        val seen = mutableSetOf<String>()
        fun hand(entries: List<JSONObject>) {
            val fresh = entries.filter { entry ->
                val id = entry.optString("balanser").ifBlank { entry.optString("name") }.ifBlank { entry.optString("url") }
                entry.optBoolean("show", true) && seen.add(id)
            }
            if (fresh.isNotEmpty()) onEntries(fresh)
        }
        fun online(answer: Any?): List<JSONObject> = when (answer) {
            is JSONArray -> answer.objects()
            is JSONObject -> answer.optJSONArray("online").objects()
            else -> emptyList()
        }
        runCatching {
            val start = json("/lite/events?$query&life=true", 10_000)
            val memkey = (start as? JSONObject)?.optString("memkey").orEmpty()
            if (memkey.isNotBlank()) {
                val deadline = System.currentTimeMillis() + 25_000
                var pause = 300L
                while (System.currentTimeMillis() < deadline && !isClosed()) {
                    delay(pause)
                    pause = minOf(1_200, pause + 250)
                    val answer = runCatching { json("/lifeevents?memkey=${enc(memkey)}&$query", 10_000) }.getOrNull() ?: continue
                    val list = online(answer)
                    hand(list)
                    val tasks = (answer as? JSONObject)?.optInt("tasks") ?: 0
                    if (tasks > 0) onProgress(minOf(list.size, tasks), tasks)
                    if ((answer as? JSONObject)?.optBoolean("ready") == true) break
                }
                if (seen.isNotEmpty() || isClosed()) return seen.size
            } else if (start != null) {
                hand(online(start))
                if (seen.isNotEmpty()) return seen.size
            }
        }
        if (isClosed()) return seen.size
        hand(online(runCatching { json("/lite/events?$query&life=false", 30_000) }.getOrNull()))
        return seen.size
    }

    private fun node(answer: Any?): LampacNode? {
        val json = answer as? JSONObject ?: return null
        return LampacNode(json.optString("type"), json.optJSONArray("data").objects(), json.optJSONArray("voice").objects())
    }

    suspend fun node(url: String): LampacNode? = node(json(url))

    /** A source answers with the title itself or with look-alikes; a look-alike is taken only when its year matches. */
    suspend fun resolve(url: String, item: TvItem): LampacNode? {
        var current = node(json(url, 10_000))
        var hop = 0
        while (current?.type == "similar" && hop < 2) {
            val year = if (item.year > 0) "${item.year}" else ""
            val match = current.data.firstOrNull { year.isNotBlank() && it.optString("year") == year } ?: return null
            current = node(json(match.optString("url"), 10_000))
            hop++
        }
        return current?.takeIf { it.type in setOf("movie", "season", "episode") && it.data.isNotEmpty() }
    }

    /** "play" carries the link itself; "call" has to be asked and answers with every quality and the subtitles. */
    suspend fun stream(entry: JSONObject): LampacStream {
        suspend fun pack(source: JSONObject): LampacStream {
            val qualities = linkedMapOf<String, String>()
            source.optJSONObject("quality")?.let { quality -> quality.keys().forEach { label -> quality.optString(label).takeIf(String::isNotBlank)?.let { qualities[label] = withUid(it) } } }
            val subtitles = source.optJSONArray("subtitles").objects().filter { it.optString("url").isNotBlank() }
                .map { it.optString("label").ifBlank { it.optString("name") } to it.optString("url") }
            return LampacStream(withUid(source.optString("url")), qualities, subtitles)
        }
        if (entry.optString("method") == "play") return pack(entry)
        runCatching { (json(entry.optString("url")) as? JSONObject)?.takeIf { it.optString("url").isNotBlank() }?.let { return pack(it) } }
        return LampacStream(withUid(entry.optString("stream")), emptyMap(), emptyList())
    }

    fun number(entry: JSONObject, fallback: Int): Int {
        val value = entry.optString("s").toIntOrNull() ?: entry.optString("id").toIntOrNull() ?: Regex("\\d+").find(entry.optString("name"))?.value?.toIntOrNull()
        return if (value != null && value > 0) value else fallback
    }

    /** Quality as a line count: "1080p" → 1080, "4K" → 2160. */
    fun lines(label: String): Int = when {
        Regex("4k|uhd", RegexOption.IGNORE_CASE).containsMatchIn(label) -> 2160
        Regex("2k", RegexOption.IGNORE_CASE).containsMatchIn(label) -> 1440
        else -> Regex("(\\d{3,4})p?", RegexOption.IGNORE_CASE).find(label)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    }

    fun qualityLabel(lines: Int): String = when {
        lines >= 2000 -> "4K"
        lines >= 1400 -> "2K"
        lines > 0 -> "${lines}p"
        else -> ""
    }

    private fun entryLines(entry: JSONObject): Int {
        val listed = entry.optJSONObject("quality")?.keys()?.asSequence()?.toList().orEmpty()
        return maxOf(lines(entry.optString("maxquality")), listed.maxOfOrNull(::lines) ?: 0)
    }

    /** Best quality a source gives: its own labels first, else what its first video answers. */
    suspend fun sourceQuality(node: LampacNode): Int {
        var entries = node.data
        if (node.type == "season") entries = node(json(entries.firstOrNull()?.optString("url") ?: return 0))?.takeIf { it.type == "episode" }?.data.orEmpty()
        entries.maxOfOrNull(::entryLines)?.takeIf { it > 0 }?.let { return it }
        val entry = entries.firstOrNull() ?: return 0
        if (entry.optString("method") == "call") {
            val answer = runCatching { json(entry.optString("url")) as? JSONObject }.getOrNull()
            answer?.optJSONObject("quality")?.keys()?.asSequence()?.maxOfOrNull(::lines)?.takeIf { it > 0 }?.let { return it }
        }
        return 0
    }
}
