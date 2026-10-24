package com.cinevault.android

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** What the device keeps about a title: enough to draw its poster or backdrop card. */
data class SavedTitle(
    val id: String,
    val kind: String,
    val title: String,
    val year: Int,
    val poster: String?,
    val backdrop: String?,
    val rating: Double,
    val genres: List<String>,
) {
    fun asCatalogTitle() = CatalogTitle(
        id = id, kinopoiskId = null, kind = kind, title = title, originalTitle = title, year = year,
        description = "", poster = poster, rating = rating, votes = 0, genres = genres, seasons = emptyList(), backdrop = backdrop,
    )

    fun toJson(): JSONObject = JSONObject().put("id", id).put("kind", kind).put("title", title).put("year", year)
        .put("poster", poster).put("backdrop", backdrop).put("rating", rating).put("genres", JSONArray(genres))

    companion object {
        fun of(title: CatalogTitle) = SavedTitle(title.id, title.kind, title.title, title.year, title.poster, title.backdrop, title.rating, title.genres)
        fun fromJson(json: JSONObject) = SavedTitle(
            json.optString("id"), json.optString("kind", "movie"), json.optString("title"), json.optInt("year"),
            json.optString("poster").takeIf { it.isNotBlank() && it != "null" }, json.optString("backdrop").takeIf { it.isNotBlank() && it != "null" },
            json.optDouble("rating", 0.0).takeUnless(Double::isNaN) ?: 0.0,
            json.optJSONArray("genres")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty(),
        )
    }
}

/** Which player and voice a title was last opened with, and when. Kept on this device only. */
data class WatchEntry(
    val title: SavedTitle, val providerId: String, val translationName: String?, val updatedAt: Long,
    /** For series watched in Alloha on TV: where the viewer stopped. */
    val season: Int? = null, val episode: Int? = null,
    /** Where the viewer stopped in that film or episode, and how long it is (seconds; 0 when unknown). */
    val position: Double = 0.0, val duration: Double = 0.0,
) {
    val progress: Float get() = if (duration > 0) (position / duration).toFloat().coerceIn(0f, 1f) else 0f

    fun toJson(): JSONObject = JSONObject().put("title", title.toJson()).put("providerId", providerId).put("translationName", translationName)
        .put("updatedAt", updatedAt).put("season", season).put("episode", episode).put("position", position).put("duration", duration)

    companion object {
        fun fromJson(json: JSONObject) = WatchEntry(
            SavedTitle.fromJson(json.optJSONObject("title") ?: JSONObject()), json.optString("providerId"),
            json.optString("translationName").takeIf { it.isNotBlank() && it != "null" }, json.optLong("updatedAt"),
            json.optInt("season").takeIf { it > 0 }, json.optInt("episode").takeIf { it > 0 },
            json.optDouble("position", 0.0).takeUnless(Double::isNaN) ?: 0.0, json.optDouble("duration", 0.0).takeUnless(Double::isNaN) ?: 0.0,
        )
    }
}

data class Shelf(val id: String, val title: String, val subtitle: String, val items: List<CatalogTitle>)

/**
 * App-wide state. Favourites and watch history live on this phone, like the site keeps
 * them per browser; nothing about viewing is sent to the server.
 */
object CineStore {
    private lateinit var prefs: SharedPreferences

    val favorites = mutableStateListOf<SavedTitle>()
    val history = mutableStateMapOf<String, WatchEntry>()

    var homeShelves by mutableStateOf<List<Shelf>>(emptyList())
        private set
    var homeHero by mutableStateOf<List<CatalogTitle>>(emptyList())
        private set
    var homeLoading by mutableStateOf(false)
        private set
    var homeError by mutableStateOf<String?>(null)
        private set
    var facets by mutableStateOf<Map<String, CatalogFacets>>(emptyMap())
        private set

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences("cinevault", Context.MODE_PRIVATE)
        runCatching {
            val stored = JSONArray(prefs.getString("favorites", "[]"))
            favorites.addAll((0 until stored.length()).map { SavedTitle.fromJson(stored.getJSONObject(it)) })
        }
        runCatching {
            val stored = JSONArray(prefs.getString("history", "[]"))
            (0 until stored.length()).map { WatchEntry.fromJson(stored.getJSONObject(it)) }.forEach { history[it.title.id] = it }
        }
    }

    // MARK: Favourites

    fun isFavorite(id: String) = favorites.any { it.id == id }

    fun toggleFavorite(title: CatalogTitle) {
        val index = favorites.indexOfFirst { it.id == title.id }
        if (index >= 0) favorites.removeAt(index) else favorites.add(0, SavedTitle.of(title))
        prefs.edit().putString("favorites", JSONArray(favorites.map { it.toJson() }).toString()).apply()
    }

    // MARK: Watch history

    val recentlyWatched: List<WatchEntry> get() = history.values.sortedByDescending { it.updatedAt }

    fun lastWatch(id: String): WatchEntry? = history[id]

    /** Embedded players keep the position themselves, so only the moment and the choice are recorded. */
    fun recordOpened(title: CatalogTitle, providerId: String, translationName: String? = null, season: Int? = null, episode: Int? = null) {
        val previous = history[title.id]
        history[title.id] = WatchEntry(
            SavedTitle.of(title), providerId, translationName, System.currentTimeMillis(),
            season ?: previous?.season, episode ?: previous?.episode,
        )
        saveHistory()
    }

    /** The episode now playing (reported by the TV player), so that "Продолжить" opens it next time. */
    fun recordEpisode(titleId: String, season: Int?, episode: Int, translationName: String?) {
        val entry = history[titleId] ?: return
        if (entry.season == season && entry.episode == episode && (translationName == null || entry.translationName == translationName)) return
        val sameEpisode = entry.season == season && entry.episode == episode
        history[titleId] = entry.copy(
            season = season, episode = episode, translationName = translationName ?: entry.translationName, updatedAt = System.currentTimeMillis(),
            position = if (sameEpisode) entry.position else 0.0, duration = if (sameEpisode) entry.duration else 0.0,
        )
        saveHistory()
    }

    /** The playing position, reported every few seconds by the TV player: "Продолжить" starts from it. */
    fun recordProgress(titleId: String, position: Double, duration: Double) {
        val entry = history[titleId] ?: return
        if (duration <= 0 || kotlin.math.abs(entry.position - position) < 5) return
        // Seen to the end: next time starts over (or the next episode, which the player knows).
        val stopped = if (duration - position < 90) 0.0 else position
        history[titleId] = entry.copy(position = stopped, duration = duration, updatedAt = System.currentTimeMillis())
        saveHistory()
    }

    /** The video quality last chosen on TV ("720"), offered first next time; empty means automatic. */
    var preferredQuality: String
        get() = prefs.getString("quality", "").orEmpty()
        set(value) { prefs.edit().putString("quality", value).apply() }

    /** The last searches typed or said on this device, newest first. */
    val recentSearches: List<String>
        get() = runCatching { JSONArray(prefs.getString("searches", "[]")).let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrDefault(emptyList())

    fun rememberSearch(query: String) {
        val text = query.trim().takeIf { it.length >= 2 } ?: return
        val list = (listOf(text) + recentSearches.filter { !it.equals(text, ignoreCase = true) }).take(8)
        prefs.edit().putString("searches", JSONArray(list).toString()).apply()
    }

    fun removeFromHistory(id: String) {
        history.remove(id)
        saveHistory()
    }

    private fun saveHistory() {
        val newest = recentlyWatched.take(100)
        prefs.edit().putString("history", JSONArray(newest.map { it.toJson() }).toString()).apply()
    }

    // MARK: Home

    private var homeLoaded = false

    // The collections the home screen is made of, as (sort, collection); the order is the shelves' order.
    private val homeQueries = listOf(
        "popular" to "popular", "new" to "new", "popular" to "evening",
        "popular" to "anime", "popular" to "tense", "popular" to "together",
    )

    suspend fun loadHome(force: Boolean = false) {
        if (homeLoading || (homeLoaded && !force)) return
        homeLoading = true
        homeError = null
        try {
            // Each collection loads on its own and appears as soon as it arrives: a slow or failed
            // one neither holds the others back nor leaves more than its own shelf out.
            val loaded = Array<List<CatalogTitle>?>(homeQueries.size) { null }
            val failures = mutableListOf<Throwable>()
            coroutineScope {
                homeQueries.forEachIndexed { index, (sort, collection) ->
                    launch {
                        runCatching { CineVaultApi.catalog(1, "", "", "", sort, collection).items }
                            .onSuccess { loaded[index] = it; publishHome(loaded) }
                            .onFailure { failures += it }
                    }
                }
            }
            if (loaded.all { it.isNullOrEmpty() }) {
                homeError = failures.firstOrNull()?.message ?: "Подборки пустые"
                return
            }
            homeLoaded = true
        } finally {
            homeLoading = false
        }
    }

    /** Builds the shelves from whatever has arrived so far; the hero is picked once, from the first titles. */
    private fun publishHome(loaded: Array<List<CatalogTitle>?>) {
        fun at(index: Int) = loaded[index].orEmpty()
        val candidates = loaded.flatMap { it.orEmpty() }.distinctBy { it.id }
        val watchedGenres = recentlyWatched.take(10).flatMap { it.title.genres }.map { it.lowercase() }.groupingBy { it }.eachCount()
        val watchedIds = history.keys
        // A new mix every day: the viewer's genres still lead, a daily jitter keeps the same films from sitting on top.
        val day = System.currentTimeMillis() / 86_400_000L
        fun jitter(id: String) = ((id.hashCode().toLong() * 31 + day * 7919).and(0xffff)) / 65_535.0 * 3.0
        val personal = candidates.filter { it.id !in watchedIds }
            .sortedByDescending { title -> title.genres.sumOf { watchedGenres[it.lowercase()] ?: 0 } * 2.0 + title.rating + jitter(title.id) }
            .take(20)
        homeShelves = listOf(
            Shelf("personal", "Советуем вам", if (watchedGenres.isEmpty()) "Первые рекомендации — со временем подстроятся под просмотры" else "Похоже на то, что вы уже смотрели", personal),
            Shelf("popular", "Популярное", "Сначала карточки с большим числом оценок Kinopoisk", at(0)),
            Shelf("recent", "Новое и обсуждаемое", "Свежие карточки, о которых уже голосуют", at(1)),
            Shelf("evening", "На один вечер", "Фильмы, которые удобно включить сегодня", at(2)),
            Shelf("anime", "Аниме", "Анимационные фильмы и сериалы", at(3)),
            Shelf("together", "Для двоих", "Романтика и истории для совместного вечера", at(5)),
            Shelf("tense", "Держит в напряжении", "Триллеры, детективы и криминальные истории", at(4)),
        ).filter { it.items.isNotEmpty() }
        if (homeHero.isEmpty()) {
            val heroPool = (personal.take(3) + at(1).take(6)).distinctBy { it.id }
            homeHero = (heroPool.filter { it.backdrop != null }.ifEmpty { heroPool }).take(6)
        }
    }

    suspend fun loadFacets(type: String) {
        if (facets.containsKey(type)) return
        runCatching { CineVaultApi.catalogFacets(type) }.onSuccess { facets = facets + (type to it) }
    }
}
