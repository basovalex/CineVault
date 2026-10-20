package com.cinevault.android

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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
data class WatchEntry(val title: SavedTitle, val providerId: String, val translationName: String?, val updatedAt: Long) {
    fun toJson(): JSONObject = JSONObject().put("title", title.toJson()).put("providerId", providerId).put("translationName", translationName).put("updatedAt", updatedAt)

    companion object {
        fun fromJson(json: JSONObject) = WatchEntry(
            SavedTitle.fromJson(json.optJSONObject("title") ?: JSONObject()), json.optString("providerId"),
            json.optString("translationName").takeIf { it.isNotBlank() && it != "null" }, json.optLong("updatedAt"),
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
    fun recordOpened(title: CatalogTitle, providerId: String, translationName: String? = null) {
        history[title.id] = WatchEntry(SavedTitle.of(title), providerId, translationName, System.currentTimeMillis())
        saveHistory()
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

    suspend fun loadHome(force: Boolean = false) {
        if (homeLoading || (homeLoaded && !force)) return
        homeLoading = true
        homeError = null
        try {
            // Each collection loads on its own: one that fails only leaves its shelf out.
            val pages = coroutineScope {
                listOf(
                    "popular" to "popular", "new" to "new", "rating" to "evening",
                    "rating" to "anime", "rating" to "tense", "rating" to "together",
                ).map { (sort, collection) ->
                    async { runCatching { CineVaultApi.catalog(1, "", "", "", sort, collection) } }
                }.map { it.await() }
            }
            val loaded = pages.map { it.getOrNull()?.items.orEmpty() }
            if (loaded.all { it.isEmpty() }) {
                homeError = pages.firstNotNullOfOrNull { it.exceptionOrNull()?.message } ?: "Подборки пустые"
                return
            }
            val candidates = loaded.flatten().distinctBy { it.id }
            val watchedGenres = recentlyWatched.take(10).flatMap { it.title.genres }.map { it.lowercase() }.groupingBy { it }.eachCount()
            val watchedIds = history.keys
            val personal = candidates.filter { it.id !in watchedIds }
                .sortedByDescending { title -> title.genres.sumOf { watchedGenres[it.lowercase()] ?: 0 } * 2.0 + title.rating }
                .take(20)
            homeShelves = listOf(
                Shelf("personal", "Советуем вам", if (watchedGenres.isEmpty()) "Первые рекомендации — со временем подстроятся под просмотры" else "Похоже на то, что вы уже смотрели", personal),
                Shelf("popular", "Популярное", "Сначала карточки с большим числом оценок Kinopoisk", loaded[0]),
                Shelf("recent", "Новое и обсуждаемое", "Свежие карточки, о которых уже голосуют", loaded[1]),
                Shelf("evening", "На один вечер", "Фильмы, которые удобно включить сегодня", loaded[2]),
                Shelf("anime", "Аниме", "Анимационные фильмы и сериалы", loaded[3]),
                Shelf("together", "Для двоих", "Романтика и истории для совместного вечера", loaded[5]),
                Shelf("tense", "Держит в напряжении", "Триллеры, детективы и криминальные истории", loaded[4]),
            ).filter { it.items.isNotEmpty() }
            val heroPool = (personal.take(3) + loaded[1].take(6)).distinctBy { it.id }
            homeHero = (heroPool.filter { it.backdrop != null }.ifEmpty { heroPool }).take(6)
            homeLoaded = true
        } finally {
            homeLoading = false
        }
    }

    suspend fun loadFacets(type: String) {
        if (facets.containsKey(type)) return
        runCatching { CineVaultApi.catalogFacets(type) }.onSuccess { facets = facets + (type to it) }
    }
}
