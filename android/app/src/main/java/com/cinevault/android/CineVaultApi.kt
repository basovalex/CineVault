package com.cinevault.android

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.io.File

data class PlaybackSource(
    val id: String,
    val url: String,
    val type: String,
    val quality: String,
    val voice: String,
) {
    val isEmbed: Boolean get() = type.contains("embed", ignoreCase = true) || type.contains("iframe", ignoreCase = true)
    val label: String get() = listOf(voice, quality).filter { it.isNotBlank() && it != "Авто" }.joinToString(" · ")
}

data class CatalogTitle(
    val id: String,
    val kinopoiskId: Int?,
    val kind: String,
    val title: String,
    val originalTitle: String,
    val year: Int,
    val description: String,
    val poster: String?,
    val rating: Double,
    val votes: Int,
    val genres: List<String>,
    val seasons: List<Int>,
    val sources: List<PlaybackSource> = emptyList(),
)

data class CatalogPage(
    val items: List<CatalogTitle>,
    val page: Int,
    val pages: Int,
    val total: Int,
)

data class VoiceOption(val id: String, val name: String, val quality: String, val url: String)
data class LibraryEpisode(
    val id: String,
    val titleId: String,
    val title: String,
    val episodeTitle: String,
    val kind: String,
    val season: Int?,
    val episode: Int?,
    val status: String,
    val hlsUrl: String?,
    val qualities: List<String>,
    val sourceType: String,
)
data class DownloadedEpisode(
    val id: String,
    val title: String,
    val subtitle: String,
    val quality: String,
    val file: File,
)

object CineVaultApi {
    private val baseURL get() = BuildConfig.SERVER_URL.trimEnd('/')
    private val authHeader: String? by lazy {
        val username = BuildConfig.BASIC_USERNAME
        val password = BuildConfig.BASIC_PASSWORD
        if (username.isNotBlank()) {
            "Basic " + Base64.encodeToString("$username:$password".toByteArray(), Base64.NO_WRAP)
        } else null
    }

    suspend fun checkConnection(): String = withContext(Dispatchers.IO) {
        request("/api/health").optString("service", "Сервер отвечает")
    }

    suspend fun catalog(
        page: Int, query: String, type: String, genre: String, sort: String, collection: String = "",
    ): CatalogPage = withContext(Dispatchers.IO) {
        val params = linkedMapOf(
            "page" to page.toString(), "limit" to "30", "sort" to sort,
        )
        if (query.isNotBlank()) params["search"] = query.trim()
        if (type.isNotBlank()) params["type"] = type
        if (genre.isNotBlank()) params["genre"] = genre
        if (collection.isNotBlank()) params["collection"] = collection
        val json = request("/api/catalog?" + params.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" })
        CatalogPage(
            items = json.optJSONArray("items").toTitles(),
            page = json.optInt("page", page),
            pages = json.optInt("pages", 1),
            total = json.optInt("total", 0),
        )
    }

    suspend fun facets(): List<String> = withContext(Dispatchers.IO) {
        val json = request("/api/catalog/facets")
        val genres = json.optJSONObject("genres") ?: JSONObject()
        (0 until genres.length()).map { genres.names()?.optString(it).orEmpty() }
            .filter(String::isNotBlank).sorted()
    }

    suspend fun title(id: String): CatalogTitle = withContext(Dispatchers.IO) {
        parseTitle(request("/api/catalog/imported/${enc(id)}"))
    }

    suspend fun refreshPlayback(kinopoiskId: Int, force: Boolean = false): CatalogTitle? = withContext(Dispatchers.IO) {
        val result = request(
            "/api/playback/refresh", "POST",
            JSONObject().put("kinopoisk_id", kinopoiskId).put("force", force).toString(),
        )
        result.optJSONObject("entry")?.let(::parseTitle)
    }

    suspend fun allohaOptions(kinopoiskId: Int): List<VoiceOption> = withContext(Dispatchers.IO) {
        val json = request("/api/player-options?kinopoisk=$kinopoiskId")
        val providers = json.optJSONArray("providers") ?: JSONArray()
        val alloha = (0 until providers.length()).map { providers.optJSONObject(it) }
            .firstOrNull { it?.optString("id") == "alloha" }
        val translations = alloha?.optJSONArray("translations") ?: JSONArray()
        (0 until translations.length()).mapNotNull { index ->
            val item = translations.optJSONObject(index) ?: return@mapNotNull null
            val url = item.optString("embedUrl")
            if (!url.startsWith("https://theatre.stravers.live/")) return@mapNotNull null
            VoiceOption(item.optString("id", "$index"), item.optString("name"), item.optString("quality"), url)
        }
    }

    suspend fun libraryEpisodes(): List<LibraryEpisode> = withContext(Dispatchers.IO) {
        val rows = request("/api/library").optJSONArray("items") ?: JSONArray()
        (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            LibraryEpisode(
                id = row.optString("id"), titleId = row.optString("title_id"),
                title = row.optString("title"), episodeTitle = row.optString("episode_title"),
                kind = row.optString("kind"), season = row.optInt("season").takeIf { it > 0 },
                episode = row.optInt("episode").takeIf { it > 0 }, status = row.optString("status"),
                hlsUrl = row.optString("hls_url").takeIf(String::isNotBlank),
                qualities = row.optJSONArray("available_qualities").let { values ->
                    (0 until (values?.length() ?: 0)).map { values!!.optString(it) }.filter(String::isNotBlank)
                },
                sourceType = row.optString("source_type"),
            ).takeIf { it.id.isNotBlank() }
        }
    }

    suspend fun downloadLibraryEpisode(
        episode: LibraryEpisode,
        quality: String,
        folder: File,
        onProgress: (Int, Int) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        require(episode.sourceType != "external_embed") { "Внешний плеер нельзя сохранить офлайн" }
        val manifest = request("/api/library/episodes/${enc(episode.id)}/offline-manifest?quality=${enc(quality)}")
        val resources = manifest.optJSONArray("resources") ?: JSONArray()
        require(resources.length() > 0) { "Сервер не вернул файлы для загрузки" }
        val safeID = episode.id.replace(Regex("[^A-Za-z0-9_-]"), "_")
        val target = File(folder, safeID)
        val temporary = File(folder, ".$safeID.tmp")
        temporary.deleteRecursively()
        check(temporary.mkdirs()) { "Не удалось создать папку загрузки" }
        try {
            for (index in 0 until resources.length()) {
                val resourcePath = resources.optString(index)
                require(resourcePath.startsWith("/media/hls/${episode.id}/")) {
                    "Сервер вернул недопустимый путь загрузки"
                }
                val fileName = if (index == 0) "index.m3u8" else URL(URL("$baseURL/").toURI().toURL(), resourcePath).path.substringAfterLast('/')
                requestFile(resourcePath, File(temporary, fileName))
                onProgress(index + 1, resources.length())
            }
            check(File(temporary, "index.m3u8").isFile) { "В загруженном наборе нет плейлиста" }
            target.deleteRecursively()
            check(temporary.renameTo(target)) { "Не удалось завершить сохранение" }
            File(target, "download.json").writeText(
                JSONObject().put("id", episode.id).put("title", episode.title)
                    .put("subtitle", listOfNotNull(episode.season?.let { "Сезон $it" }, episode.episode?.let { "Серия $it" }, episode.episodeTitle.takeIf(String::isNotBlank)).joinToString(" · "))
                    .put("quality", quality).toString(),
            )
            File(target, "index.m3u8")
        } catch (error: Throwable) {
            temporary.deleteRecursively()
            throw error
        }
    }

    fun downloadedEpisodes(folder: File): List<DownloadedEpisode> = folder.listFiles().orEmpty()
        .filter { it.isDirectory && File(it, "index.m3u8").isFile && File(it, "download.json").isFile }
        .mapNotNull { directory ->
            runCatching {
                val json = JSONObject(File(directory, "download.json").readText())
                DownloadedEpisode(
                    json.optString("id"), json.optString("title"), json.optString("subtitle"),
                    json.optString("quality"), File(directory, "index.m3u8"),
                )
            }.getOrNull()
        }

    fun deleteDownloadedEpisode(folder: File, id: String) {
        val safeID = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
        File(folder, safeID).deleteRecursively()
    }

    private fun requestFile(path: String, target: File) {
        val connection = URL("$baseURL$path").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 20_000
            connection.readTimeout = 60_000
            connection.setRequestProperty("Accept", "*/*")
            authHeader?.let { connection.setRequestProperty("Authorization", it) }
            val status = connection.responseCode
            if (status !in 200..299) throw IllegalStateException("Сервер ответил HTTP $status при загрузке")
            connection.inputStream.use { input -> target.outputStream().buffered().use(input::copyTo) }
        } finally {
            connection.disconnect()
        }
    }

    private fun request(path: String, method: String = "GET", body: String? = null): JSONObject {
        val connection = URL("$baseURL$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 20_000
            connection.readTimeout = 35_000
            connection.setRequestProperty("Accept", "application/json")
            authHeader?.let { connection.setRequestProperty("Authorization", it) }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IllegalStateException(message?.takeIf(String::isNotBlank) ?: "Сервер ответил HTTP $status")
            }
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    fun playbackRequestProperties(url: String): Map<String, String> {
        val serverHost = runCatching { URL(baseURL).host }.getOrNull()
        val mediaHost = runCatching { URL(url).host }.getOrNull()
        return if (serverHost != null && serverHost == mediaHost && authHeader != null) {
            mapOf("Authorization" to authHeader!!)
        } else emptyMap()
    }

    private fun resolveMediaURL(value: String): String {
        if (value.isBlank()) return value
        return runCatching { URL(URL("$baseURL/").toURI().toURL(), value).toString() }.getOrDefault(value)
    }

    fun absoluteMediaURL(value: String): String = resolveMediaURL(value)

    private fun parseTitle(json: JSONObject): CatalogTitle {
        val tags = json.optJSONArray("genres") ?: json.optJSONArray("tags") ?: JSONArray()
        val seasons = json.optJSONArray("seasons") ?: JSONArray()
        val sources = json.optJSONArray("videoSources") ?: JSONArray()
        if (sources.length() == 0) {
            val legacyURL = json.optString("videoUrl").ifBlank { json.optString("video_url") }
            if (legacyURL.isNotBlank()) {
                sources.put(JSONObject()
                    .put("id", "default")
                    .put("url", legacyURL)
                    .put("type", json.optString("videoType").ifBlank { "video/mp4" })
                    .put("quality", "Источник")
                    .put("voice", "Оригинал"))
            }
        }
        return CatalogTitle(
            id = json.optString("id"),
            kinopoiskId = json.optInt("kinopoiskId").takeIf { it > 0 },
            kind = json.optString("kind", "movie"),
            title = json.optString("title"),
            originalTitle = json.optString("originalTitle"),
            year = json.optInt("year"),
            description = json.optString("description"),
            poster = json.optString("posterImage").takeIf(String::isNotBlank)
                ?: json.optString("poster").takeIf(String::isNotBlank),
            rating = json.optDouble("ratingKinopoisk", json.optDouble("rating", 0.0)),
            votes = json.optInt("voteCount"),
            genres = (0 until tags.length()).map { tags.optString(it) }.filter(String::isNotBlank),
            seasons = (0 until seasons.length()).map { seasons.optInt(it) },
            sources = (0 until sources.length()).mapNotNull { index ->
                val source = sources.optJSONObject(index) ?: return@mapNotNull null
                val url = resolveMediaURL(source.optString("url"))
                if (url.isBlank()) return@mapNotNull null
                PlaybackSource(
                    source.optString("id", url), url, source.optString("type"),
                    source.optString("quality"), source.optString("voice"),
                )
            },
        )
    }

    private fun JSONArray?.toTitles(): List<CatalogTitle> =
        (0 until (this?.length() ?: 0)).mapNotNull { index -> this?.optJSONObject(index)?.let(::parseTitle) }

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")
}
