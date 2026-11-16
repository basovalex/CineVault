package com.cinevault.android

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Immutable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap

// The TV catalogue is the site's: TMDB, as Lampa uses it. Cards, seasons, people and shelves all come
// from TMDB through the server's /tmdb/3 route; the same rows, filters and rules as app/app.js.

@Immutable
data class TvPerson(val id: Int, val name: String, val role: String, val photo: String)

@Immutable
data class TvSeason(val number: Int, val episodes: Int, val name: String)

@Immutable
data class TvEpisode(val season: Int, val number: Int, val name: String, val still: String, val airDate: String, val overview: String, val runtime: Int,
                     val rating: Double = 0.0, val votes: Int = 0)

/** One season of the episode ratings map: (episode, rating, votes). */
@Immutable
data class TvRatedSeason(val season: Int, val episodes: List<Triple<Int, Double, Int>>)

/** A trailer the server found on Rutube. */
@Immutable
data class TvTrailer(val id: String, val title: String, val author: String, val duration: Int, val previewUrl: String = "", val previewHighUrl: String = "")

@Immutable
data class TvNext(val season: Int, val episode: Int, val name: String, val airDate: String)

@Immutable
data class TvItem(
    val id: String, val tmdbId: Int, val kind: String, val title: String, val originalTitle: String = "",
    val language: String = "", val year: Int = 0, val premiere: String = "", val overview: String = "",
    val poster: String = "", val backdrop: String = "", val genres: List<String> = emptyList(), val isAnime: Boolean = false,
    val rating: Double = 0.0, val votes: Int = 0, val runtime: Int = 0, val seasons: List<TvSeason> = emptyList(),
    val imdbId: String = "", val people: List<TvPerson> = emptyList(), val directors: List<String> = emptyList(),
    val countries: List<String> = emptyList(), val tagline: String = "", val age: String = "", val status: String = "",
    val next: TvNext? = null, val detailed: Boolean = false,
) {
    val isSeries get() = kind == "series"

    /** A short copy kept on the device so saved lists draw at once (the site's "loose titles"). */
    fun brief(): JSONObject = JSONObject().put("id", id).put("tmdbId", tmdbId).put("kind", kind).put("title", title)
        .put("originalTitle", originalTitle).put("year", year).put("premiere", premiere).put("poster", poster).put("backdrop", backdrop)
        .put("rating", rating).put("genres", JSONArray(genres)).put("isAnime", isAnime)

    companion object {
        fun fromBrief(json: JSONObject) = TvItem(
            id = json.optString("id"), tmdbId = json.optInt("tmdbId"), kind = json.optString("kind", "movie"), title = json.optString("title"),
            originalTitle = json.optString("originalTitle"), year = json.optInt("year"), premiere = json.optString("premiere"),
            poster = json.optString("poster"), backdrop = json.optString("backdrop"), rating = json.optDouble("rating", 0.0),
            genres = json.optJSONArray("genres").strings(), isAnime = json.optBoolean("isAnime"),
        )
    }
}

@Immutable
data class TvRow(val key: String, val title: String, val description: String, val items: List<TvItem>)

@Immutable
data class TvPersonPage(val name: String, val department: String, val dates: String, val place: String, val bio: String, val photo: String,
                        val upcoming: List<TvItem>, val recent: List<TvItem>, val popular: List<TvItem> = emptyList(), val all: List<TvItem> = emptyList())

internal fun JSONArray?.strings(): List<String> = (0 until (this?.length() ?: 0)).mapNotNull { this?.optString(it)?.takeIf(String::isNotBlank) }
internal fun JSONArray?.objects(): List<JSONObject> = (0 until (this?.length() ?: 0)).mapNotNull { this?.optJSONObject(it) }
internal fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

object Tmdb {
    val GENRES = mapOf(
        28 to "боевик", 12 to "приключения", 16 to "мультфильм", 35 to "комедия", 80 to "криминал", 99 to "документальный", 18 to "драма",
        10751 to "семейный", 14 to "фэнтези", 36 to "история", 27 to "ужасы", 10402 to "музыка", 9648 to "детектив", 10749 to "мелодрама",
        878 to "фантастика", 10770 to "телефильм", 53 to "триллер", 10752 to "военный", 37 to "вестерн",
        10759 to "боевик", 10762 to "детский", 10763 to "новости", 10764 to "реалити-шоу", 10765 to "фантастика", 10766 to "мыльная опера",
        10767 to "ток-шоу", 10768 to "военный",
    )
    private val COUNTRIES = mapOf(
        "US" to "США", "GB" to "Великобритания", "RU" to "Россия", "FR" to "Франция", "DE" to "Германия", "IT" to "Италия", "ES" to "Испания",
        "JP" to "Япония", "KR" to "Южная Корея", "CN" to "Китай", "CA" to "Канада", "AU" to "Австралия", "IN" to "Индия", "SE" to "Швеция",
        "DK" to "Дания", "NO" to "Норвегия", "BE" to "Бельгия", "NL" to "Нидерланды", "IE" to "Ирландия", "NZ" to "Новая Зеландия",
        "MX" to "Мексика", "BR" to "Бразилия", "TR" to "Турция", "PL" to "Польша", "UA" to "Украина", "BY" to "Беларусь", "KZ" to "Казахстан",
        "CZ" to "Чехия", "FI" to "Финляндия", "AT" to "Австрия", "CH" to "Швейцария", "HK" to "Гонконг", "TW" to "Тайвань", "TH" to "Таиланд",
        "AR" to "Аргентина", "IS" to "Исландия", "HU" to "Венгрия", "RO" to "Румыния", "SU" to "СССР",
    )
    private val MOVIE_GENRE_IDS = setOf(28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37)
    private val TV_GENRE_IDS = setOf(10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37)

    /** The catalogue's genre filter, as on the site's rail. */
    val CATALOG_GENRES = listOf("боевик", "комедия", "драма", "фантастика", "триллер", "ужасы", "мелодрама", "криминал", "приключения",
        "фэнтези", "детектив", "семейный", "мультфильм", "аниме", "документальный", "история", "военный", "вестерн", "музыка")
    val CATALOG_SORTS = listOf("now" to "Популярное", "audience" to "Больше всего оценок", "rating" to "По рейтингу", "year" to "Сначала новые", "title" to "По алфавиту")
    val CATALOG_COLLECTIONS = listOf("" to "Все", "new" to "Последний год", "audience" to "Любимые зрителями")

    private val cache = ConcurrentHashMap<String, JSONObject>()
    private val requestLocks = ConcurrentHashMap<String, Mutex>()
    private lateinit var prefs: SharedPreferences
    private val ruTitles = ConcurrentHashMap<String, String>()

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.getSharedPreferences("cinevault.tv.tmdb", Context.MODE_PRIVATE)
        runCatching { JSONObject(prefs.getString("ruTitles", "{}")!!) }.getOrNull()?.let { json ->
            json.keys().forEach { key -> ruTitles[key] = json.optString(key) }
        }
    }

    private fun rememberRussian(id: String, title: String) {
        if (ruTitles[id] == title) return
        ruTitles[id] = title
        if (ruTitles.size > 2000) ruTitles.keys.take(ruTitles.size - 2000).forEach(ruTitles::remove)
        prefs.edit().putString("ruTitles", JSONObject(ruTitles as Map<*, *>).toString()).apply()
    }

    /** TMDB through our server (the key stays there); straight to TMDB with the site's read token if that fails. */
    suspend fun get(path: String, timeoutMs: Long = 10_000): JSONObject {
        cache[path]?.let { return it }
        val lock = requestLocks.computeIfAbsent(path) { Mutex() }
        return lock.withLock {
            cache[path]?.let { return@withLock it }
            val json = try {
                JSONObject(TvNet.get("${TvNet.server}/tmdb/3/$path", timeoutMs))
            } catch (error: Exception) {
                val key = runCatching { TvNet.config().tmdbKey }.getOrDefault("")
                if (key.isBlank()) throw error
                val url = "https://api.themoviedb.org/3/$path"
                if (key.startsWith("eyJ")) JSONObject(TvNet.get(url, timeoutMs, mapOf("Authorization" to "Bearer $key")))
                else JSONObject(TvNet.get("$url${if ('?' in path) '&' else '?'}api_key=$key", timeoutMs))
            }
            if (cache.size > 400) cache.keys.take(100).forEach(cache::remove)
            cache[path] = json
            json
        }
    }

    fun image(path: String, size: String = "w500"): String = if (path.isBlank()) "" else "${TvNet.server}/tmdb/t/p/$size$path"

    private val logos = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val logoLocks = ConcurrentHashMap<String, Mutex>()
    /** The title's own lettering (TMDB «logos»): Russian first, then English or a wordless one; "" when there is none. */
    fun knownLogo(item: TvItem): String? = logos[item.id]
    suspend fun logo(item: TvItem): String {
        logos[item.id]?.let { return it }
        val lock = logoLocks.computeIfAbsent(item.id) { Mutex() }
        return lock.withLock {
            logos[item.id]?.let { return@withLock it }
            val tmdbLogo = runCatching {
                val all = get("${if (item.isSeries) "tv" else "movie"}/${item.tmdbId}/images?include_image_language=ru,en,null", 8_000).optJSONArray("logos")
                // Only Russian lettering (English only for a title written in Latin in Russian too); «wordless» TMDB logos
                // are left out, they often carry English text. None — the Russian name as text.
                val latin = item.title.none { it in 'а'..'я' || it in 'А'..'Я' || it == 'ё' || it == 'Ё' }
                val list = (0 until (all?.length() ?: 0)).mapNotNull { all!!.optJSONObject(it) }
                    .filter { it.optString("file_path").let { path -> path.isNotBlank() && !path.endsWith(".svg", true) } && (it.optString("iso_639_1") == "ru" || (latin && it.optString("iso_639_1") == "en")) }
                fun rank(logo: JSONObject) = when (logo.optString("iso_639_1")) { "ru" -> 0; "en" -> 1; else -> 2 }
                list.sortedWith(compareBy<JSONObject> { rank(it) }.thenByDescending { it.optDouble("vote_average", 0.0) }).firstOrNull()
                    ?.let { image(it.optString("file_path"), "w500") }.orEmpty()
            }.getOrDefault("")
            val url = tmdbLogo.ifBlank {
                runCatching {
                    val type = if (item.isSeries) "tv" else "movie"
                    JSONObject(TvNet.get("${TvNet.server}/api/title-logo?tmdb=${item.tmdbId}&type=$type", 12_000)).optString("url")
                }.getOrDefault("")
            }
            logos[item.id] = url
            url
        }
    }

    /** The same picture straight from TMDB, for when our server's copy does not come. */
    fun directImage(url: String): String = url.replace("${TvNet.server}/tmdb/t/p", "https://image.tmdb.org/t/p")

    fun day(offset: Long = 0): String = LocalDate.now().plusDays(offset).toString()

    fun itemId(kind: String, tmdbId: Int) = "tmdb-${if (kind == "series") "tv" else "movie"}-$tmdbId"
    fun parseId(id: String): Pair<String, Int>? = Regex("^tmdb-(movie|tv)-(\\d+)$").find(id)?.groupValues?.let { (if (it[1] == "tv") "series" else "movie") to it[2].toInt() }

    private fun ageRating(raw: JSONObject): String {
        fun pick(list: JSONArray?, field: (JSONObject) -> String): String {
            for (country in listOf("RU", "US")) {
                val found = list.objects().firstOrNull { it.optString("iso_3166_1") == country } ?: continue
                field(found).takeIf(String::isNotBlank)?.let { return it }
            }
            return ""
        }
        val value = raw.optJSONObject("content_ratings")?.let { pick(it.optJSONArray("results")) { entry -> entry.optString("rating") } }
            ?: raw.optJSONObject("release_dates")?.let { pick(it.optJSONArray("results")) { entry -> entry.optJSONArray("release_dates").objects().map { d -> d.optString("certification") }.firstOrNull(String::isNotBlank).orEmpty() } }
            ?: ""
        Regex("\\d+").find(value)?.value?.toIntOrNull()?.let { return it.toString() }
        return mapOf("G" to "0", "PG" to "6", "PG-13" to "12", "R" to "18", "NC-17" to "18", "TV-Y" to "0", "TV-Y7" to "6", "TV-G" to "0",
            "TV-PG" to "12", "TV-14" to "16", "TV-MA" to "18")[value].orEmpty()
    }

    fun item(raw: JSONObject, kindHint: String = ""): TvItem {
        val type = raw.optString("media_type").ifBlank { kindHint }
        val kind = if (type == "tv" || type == "series" || (type.isBlank() && raw.has("first_air_date"))) "series" else "movie"
        val date = raw.optString("release_date").ifBlank { raw.optString("first_air_date") }
        val genreObjects = raw.optJSONArray("genres")
        val genreIds = raw.optJSONArray("genre_ids")?.let { list -> (0 until list.length()).map(list::optInt) }.orEmpty()
        val genres = if (genreObjects != null && genreObjects.optJSONObject(0) != null)
            genreObjects.objects().map { GENRES[it.optInt("id")] ?: it.optString("name").lowercase() }
        else genreIds.mapNotNull(GENRES::get)
        val origin = raw.optJSONArray("origin_country").strings()
        // Japanese animation (in Japanese or made in Japan) is anime, not «мультфильм».
        val animated = "мультфильм" in genres || 16 in genreIds || genreObjects.objects().any { it.optInt("id") == 16 }
        val anime = animated && (raw.optString("original_language") == "ja" || "JP" in origin)
        val id = itemId(kind, raw.optInt("id"))
        var title = raw.optString("title").ifBlank { raw.optString("name") }.ifBlank { raw.optString("original_title") }.ifBlank { raw.optString("original_name") }
        // TMDB often has no Russian name for anime and new shows, only a Russian alternative title.
        if (!title.contains(Regex("[а-яёА-ЯЁ]"))) {
            val alternatives = (raw.optJSONObject("alternative_titles")?.let { it.optJSONArray("results").objects() + it.optJSONArray("titles").objects() }.orEmpty())
                .filter { it.optString("iso_3166_1") == "RU" && it.optString("title").contains(Regex("[а-яёА-ЯЁ]")) }
            val russian = (alternatives.firstOrNull { it.optString("type").isBlank() } ?: alternatives.firstOrNull())?.optString("title") ?: ruTitles[id]
            if (!russian.isNullOrBlank()) {
                title = russian
                if (alternatives.isNotEmpty()) rememberRussian(id, russian)
            }
        }
        val credits = raw.optJSONObject("credits")
        val cast = credits?.optJSONArray("cast").objects()
        val crew = credits?.optJSONArray("crew").objects()
        val next = raw.optJSONObject("next_episode_to_air")?.takeIf { it.optString("air_date").isNotBlank() }
        val directors = crew.filter { it.optString("job") == "Director" }.map { it.optString("name") }.take(4)
            .ifEmpty { raw.optJSONArray("created_by").objects().map { it.optString("name") } }
        val countries = raw.optJSONArray("production_countries").objects().map { COUNTRIES[it.optString("iso_3166_1")] ?: it.optString("name") }
            .ifEmpty { origin.map { COUNTRIES[it] ?: it } }
        return TvItem(
            id = id, tmdbId = raw.optInt("id"), kind = kind, title = title,
            originalTitle = raw.optString("original_title").ifBlank { raw.optString("original_name") },
            language = raw.optString("original_language"), year = date.take(4).toIntOrNull() ?: 0, premiere = date,
            overview = raw.optString("overview"), poster = raw.optString("poster_path").takeIf { it != "null" }.orEmpty(),
            backdrop = raw.optString("backdrop_path").takeIf { it != "null" }.orEmpty(),
            genres = (if (anime) genres.map { if (it == "мультфильм") "аниме" else it } else genres).distinct(), isAnime = anime,
            rating = if (raw.optInt("vote_count") >= 5) Math.round(raw.optDouble("vote_average", 0.0) * 10) / 10.0 else 0.0,
            votes = raw.optInt("vote_count"),
            runtime = raw.optInt("runtime").takeIf { it > 0 } ?: raw.optJSONArray("episode_run_time")?.optInt(0) ?: 0,
            seasons = raw.optJSONArray("seasons").objects().filter { it.optInt("season_number") > 0 && it.optInt("episode_count") > 0 }
                .map { TvSeason(it.optInt("season_number"), it.optInt("episode_count"), it.optString("name")) },
            imdbId = raw.optJSONObject("external_ids")?.optString("imdb_id")?.takeIf { it.startsWith("tt") } ?: raw.optString("imdb_id").takeIf { it.startsWith("tt") }.orEmpty(),
            people = cast.take(20).map { TvPerson(it.optInt("id"), it.optString("name"), it.optString("character"), image(it.optString("profile_path").takeIf { p -> p != "null" }.orEmpty(), "w185")) },
            directors = directors, countries = countries, tagline = raw.optString("tagline"), age = ageRating(raw), status = raw.optString("status"),
            next = next?.let { TvNext(it.optInt("season_number"), it.optInt("episode_number"), it.optString("name"), it.optString("air_date")) },
            detailed = raw.has("credits"),
        )
    }

    fun list(json: JSONObject?, kindHint: String = ""): List<TvItem> = json?.optJSONArray("results").objects()
        .filter { it.optString("media_type").ifBlank { kindHint } != "person" && (it.optString("poster_path").let { p -> p.isNotBlank() && p != "null" } || it.optString("backdrop_path").let { p -> p.isNotBlank() && p != "null" }) }
        .map { item(it, kindHint) }

    private suspend fun rowsOf(spec: List<List<String>>, filter: (List<TvItem>) -> List<TvItem> = { it }): List<TvRow> = coroutineScope {
        spec.map { (key, title, description, path, kind) ->
            async {
                val json = runCatching { get("$path${if ('?' in path) '&' else '?'}language=ru-RU") }.getOrNull()
                TvRow(key, title, description, filter(list(json, kind)))
            }
        }.awaitAll().filter { it.items.isNotEmpty() }
    }

    /** «Для вас»: the site's fixed TMDB rows on the home page. */
    suspend fun homeRows(): List<TvRow> {
        val today = day()
        return rowsOf(listOf(
            listOf("now", "Сейчас смотрят", "Вышли в цифре за последние три месяца — не экранки", "discover/movie?with_release_type=4%7C5%7C6&release_date.lte=$today&release_date.gte=${day(-90)}&sort_by=popularity.desc&vote_count.gte=10", "movie"),
            listOf("trend-day", "Тренды дня", "", "trending/all/day", ""),
            listOf("trend-week", "Тренды недели", "", "trending/movie/week", "movie"),
            listOf("upcoming", "Скоро", "Премьеры ближайших двух месяцев", "discover/movie?primary_release_date.gte=${day(1)}&primary_release_date.lte=${day(60)}&sort_by=popularity.desc", "movie"),
            listOf("popular-movies", "Популярные фильмы", "", "movie/popular", "movie"),
            listOf("popular-tv", "Популярные сериалы", "", "trending/tv/week", "tv"),
            listOf("ru-movies", "Российские фильмы", "", "discover/movie?with_origin_country=RU&sort_by=popularity.desc&vote_count.gte=20", "movie"),
            listOf("top-movies", "Топ фильмов", "", "movie/top_rated", "movie"),
            listOf("top-tv", "Топ сериалов", "", "tv/top_rated", "tv"),
        )) { items -> items }.map { row -> if (row.key == "upcoming") row.copy(items = row.items.filter { it.premiere.isBlank() || it.premiere >= today }) else row }
    }

    /** The viewer's «Для вас» and «Похоже на «…»» rows (as on the site): see [TvState.personalSeeds]. */
    suspend fun personalRows(seeds: List<Pair<String, Double>>, titleOf: (String) -> String): List<TvRow> = kotlinx.coroutines.coroutineScope {
        if (seeds.isEmpty()) return@coroutineScope emptyList()
        val seen = seeds.map { it.first }.toSet()
        val lists = seeds.take(24).map { (id, weight) ->
            async {
                val ref = parseId(id) ?: return@async null
                val type = if (ref.first == "series") "tv" else "movie"
                val items = runCatching { list(get("$type/${ref.second}/recommendations?language=ru-RU", 8_000), type) }.getOrDefault(emptyList())
                Triple(id, weight, items)
            }
        }.awaitAll().filterNotNull().filter { it.third.isNotEmpty() }
        val score = HashMap<String, Double>()
        val byId = HashMap<String, TvItem>()
        lists.forEach { (_, weight, items) ->
            items.forEachIndexed { rank, item ->
                if (item.id in seen) return@forEachIndexed
                score[item.id] = (score[item.id] ?: 0.0) + weight * (1 - rank / 25.0)
                byId[item.id] = item
            }
        }
        // A well-rated, widely voted title rises; an obscure or weak one sinks.
        fun quality(item: TvItem): Double {
            val rating = if (item.rating > 0) ((item.rating - 4.5) / 3).coerceIn(0.35, 1.25) else 0.5
            return rating * (1 + 0.08 * kotlin.math.log10(1.0 + item.votes)) * (if (item.votes < 40) 0.5 else 1.0)
        }
        val top = score.entries.sortedByDescending { it.value * quality(byId.getValue(it.key)) }.map { byId.getValue(it.key) }
        buildList {
            if (top.size >= 6) add(TvRow("for-you", "Для вас", "По тому, что вы смотрели", top.take(20)))
            lists.take(3).mapNotNull { (id, _, items) ->
                val name = titleOf(id).ifBlank { return@mapNotNull null }
                items.filter { it.id !in seen && it.votes >= 40 }.take(16).takeIf { it.size >= 5 }?.let { TvRow("because-$id", "Похоже на «$name»", "", it) }
            }.take(2).forEach(::add)
        }
    }

    private val HOME_GENRES = listOf(28 to "Боевики", 35 to "Комедии", 18 to "Драмы", 878 to "Фантастика", 53 to "Триллеры", 16 to "Мультфильмы",
        27 to "Ужасы", 10749 to "Мелодрамы", 80 to "Криминал", 12 to "Приключения", 14 to "Фэнтези", 9648 to "Детективы", 10751 to "Семейные",
        36 to "Исторические", 10752 to "Военные", 99 to "Документальные", 37 to "Вестерны", 10402 to "Музыкальные")

    val SECTION_TITLES = mapOf(
        "movies" to ("Фильмы" to "Новинки в цифре, этого и прошлого года, российские, лучшие и жанры."),
        "series" to ("Сериалы" to "Что выходит сейчас, новинки, российские сериалы, лучшие и жанры."),
        "cartoons" to ("Мультфильмы" to "Мультфильмы и мультсериалы. Аниме — в своём разделе."),
        "anime" to ("Аниме" to "Японская анимация: что выходит сейчас, новинки, популярное, лучшее и жанры."),
    )
    private val SECTION_GENRES = mapOf(
        "movies" to listOf(28 to "Боевики", 35 to "Комедии", 18 to "Драмы", 878 to "Фантастика", 53 to "Триллеры", 27 to "Ужасы", 10749 to "Мелодрамы", 80 to "Криминал", 12 to "Приключения", 14 to "Фэнтези", 9648 to "Детективы", 10751 to "Семейные", 36 to "Исторические", 10752 to "Военные", 99 to "Документальные", 37 to "Вестерны", 10402 to "Музыкальные"),
        "series" to listOf(18 to "Драмы", 35 to "Комедии", 80 to "Криминал", 10765 to "Фантастика и фэнтези", 10759 to "Боевики и приключения", 9648 to "Детективы", 10751 to "Семейные", 99 to "Документальные", 10768 to "Военные", 10764 to "Реалити-шоу", 37 to "Вестерны"),
        "cartoons" to listOf(10751 to "Семейные", 35 to "Комедии", 12 to "Приключения", 14 to "Фэнтези", 878 to "Фантастика", 10402 to "Музыкальные", 28 to "Боевики"),
        "anime" to listOf(10759 to "Экшен и приключения", 10765 to "Фантастика и фэнтези", 35 to "Комедии", 18 to "Драмы", 9648 to "Детективы", 10762 to "Для детей", 80 to "Криминал"),
    )

    /** «Мультфильмы» without anime: it has its own section. */
    private fun sectionItems(view: String, items: List<TvItem>) = if (view == "cartoons") items.filterNot { it.isAnime } else items

    suspend fun sectionRows(view: String): List<TvRow> {
        val year = LocalDate.now().year
        val today = day()
        fun movie(query: String) = listOf("discover/movie?$query", "movie")
        fun tv(query: String) = listOf("discover/tv?$query", "tv")
        val ja = "with_genres=16&with_original_language=ja"
        val jp = "with_genres=16&with_origin_country=JP"
        val spec: List<List<String>> = when (view) {
            "series" -> listOf(
                listOf("on-air", "Сейчас выходят", "Новые серии на этой неделе") + tv("air_date.gte=${day(-7)}&air_date.lte=$today&sort_by=popularity.desc&vote_count.gte=30"),
                listOf("popular", "Популярные", "", "trending/tv/week", "tv"),
                listOf("this-year", "Новинки $year года", "") + tv("first_air_date_year=$year&sort_by=popularity.desc&vote_count.gte=10"),
                listOf("ru", "Российские сериалы", "") + tv("with_origin_country=RU&sort_by=popularity.desc&vote_count.gte=5"),
                listOf("last-year", "Сериалы ${year - 1} года", "") + tv("first_air_date_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=30"),
                listOf("top", "Высокий рейтинг", "") + tv("vote_average.gte=8&vote_count.gte=500&sort_by=vote_average.desc"),
                listOf("rewatch", "Стоит пересмотреть", "Лучшее из 2000–2015") + tv("first_air_date.gte=2000-01-01&first_air_date.lte=2015-12-31&vote_count.gte=800&sort_by=vote_average.desc"),
            )
            "anime" -> listOf(
                listOf("on-air", "Сейчас выходят", "Новые серии на этой неделе") + tv("$jp&air_date.gte=${day(-7)}&air_date.lte=$today&sort_by=popularity.desc"),
                listOf("popular", "Популярное аниме", "") + tv("$jp&sort_by=popularity.desc&vote_count.gte=50"),
                listOf("this-year", "Новинки $year года", "") + tv("$jp&first_air_date_year=$year&sort_by=popularity.desc"),
                listOf("movies", "Аниме-фильмы", "") + movie("$ja&sort_by=popularity.desc&vote_count.gte=100"),
                listOf("last-year", "Аниме ${year - 1} года", "") + tv("$jp&first_air_date_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=20"),
                listOf("top", "Высокий рейтинг", "") + tv("$jp&vote_average.gte=8&vote_count.gte=300&sort_by=vote_average.desc"),
                listOf("top-movies", "Лучшие аниме-фильмы", "") + movie("$ja&vote_average.gte=7.8&vote_count.gte=500&sort_by=vote_average.desc"),
            )
            "cartoons" -> listOf(
                listOf("now", "Сейчас смотрят", "Вышли в цифре за три месяца") + movie("with_genres=16&with_release_type=4%7C5%7C6&release_date.lte=$today&release_date.gte=${day(-90)}&sort_by=popularity.desc"),
                listOf("popular", "Популярные мультфильмы", "") + movie("with_genres=16&sort_by=popularity.desc&vote_count.gte=50"),
                listOf("this-year", "Новинки $year года", "") + movie("with_genres=16&primary_release_year=$year&sort_by=popularity.desc"),
                listOf("series", "Мультсериалы", "") + tv("with_genres=16&sort_by=popularity.desc&vote_count.gte=100&without_genres=10767%2C10764"),
                listOf("ru", "Российские мультфильмы", "") + movie("with_genres=16&with_origin_country=RU&sort_by=popularity.desc"),
                listOf("last-year", "Мультфильмы ${year - 1} года", "") + movie("with_genres=16&primary_release_year=${year - 1}&sort_by=popularity.desc"),
                listOf("top", "Высокий рейтинг", "") + movie("with_genres=16&vote_average.gte=7.8&vote_count.gte=800&sort_by=vote_average.desc"),
                listOf("rewatch", "Стоит пересмотреть", "Классика 1990–2015") + movie("with_genres=16&primary_release_date.gte=1990-01-01&primary_release_date.lte=2015-12-31&vote_count.gte=1500&sort_by=vote_average.desc"),
            )
            else -> listOf(
                listOf("now", "Сейчас смотрят", "Вышли в цифре за три месяца — не экранки") + movie("with_release_type=4%7C5%7C6&release_date.lte=$today&release_date.gte=${day(-90)}&sort_by=popularity.desc&without_genres=16"),
                listOf("popular", "Популярные", "", "movie/popular", "movie"),
                listOf("this-year", "Новинки $year года", "") + movie("primary_release_year=$year&primary_release_date.lte=$today&sort_by=popularity.desc&without_genres=16"),
                listOf("ru", "Российские фильмы", "") + movie("with_origin_country=RU&sort_by=popularity.desc&without_genres=16&vote_count.gte=20"),
                listOf("last-year", "Фильмы ${year - 1} года", "") + movie("primary_release_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=100&without_genres=16"),
                listOf("top", "Высокий рейтинг", "") + movie("vote_average.gte=8&vote_count.gte=2000&sort_by=vote_average.desc&without_genres=16"),
                listOf("rewatch", "Стоит пересмотреть", "Лучшее из 1995–2015") + movie("primary_release_date.gte=1995-01-01&primary_release_date.lte=2015-12-31&vote_count.gte=3000&sort_by=vote_average.desc"),
                listOf("ru-classic", "Российская классика", "") + movie("with_origin_country=RU%7CSU&primary_release_date.lte=2005-12-31&vote_count.gte=50&sort_by=vote_average.desc"),
            )
        }
        return rowsOf(spec.map { listOf("$view-${it[0]}") + it.drop(1) }) { sectionItems(view, it) }
    }

    /** Endless genre rows under a page: a first lap of popular titles per genre, then a lap of the best rated. */
    fun genreRowCount(view: String) = (if (view == "home") HOME_GENRES.size else SECTION_GENRES[view]?.size ?: 0) * 2

    suspend fun genreRow(view: String, index: Int): TvRow? {
        val list = if (view == "home") HOME_GENRES else SECTION_GENRES[view] ?: return null
        if (index >= list.size * 2) return null
        val (genreId, name) = list[index % list.size]
        val second = index >= list.size
        val path = if (view == "home") {
            "discover/movie?with_genres=$genreId&sort_by=${if (second) "vote_average.desc&vote_count.gte=1500" else "popularity.desc&vote_count.gte=50"}&language=ru-RU"
        } else {
            val kind = if (view == "series" || view == "anime") "tv" else "movie"
            val base = when (view) {
                "anime" -> "with_genres=16%2C$genreId&with_origin_country=JP"
                "cartoons" -> "with_genres=16%2C$genreId"
                else -> "with_genres=$genreId${if (view == "movies") "&without_genres=16" else ""}"
            }
            val sort = if (second) "vote_average.desc&vote_count.gte=${if (view == "movies") 1500 else 300}" else "popularity.desc&vote_count.gte=50"
            "discover/$kind?$base&sort_by=$sort&language=ru-RU"
        }
        val kind = if (path.startsWith("discover/tv")) "tv" else "movie"
        val items = sectionItems(view, list(runCatching { get(path) }.getOrNull(), kind))
        return TvRow("$view-genre-$index", if (second) "$name: лучшие" else name, "", items)
    }

    /** One page of the catalogue grid: TMDB discover by kind, genre and sort (as the site's tmdbDiscoverPath). */
    fun discoverPath(kind: String, page: Int, genre: String, sort: String, collection: String, upcoming: String? = null): String {
        val params = linkedMapOf("language" to "ru-RU", "page" to "$page", "include_adult" to "false")
        val dateField = if (kind == "movie") "primary_release_date" else "first_air_date"
        when {
            upcoming != null -> {
                params["$dateField.gte"] = day(1)
                params["sort_by"] = if (upcoming == "soon") "$dateField.asc" else "popularity.desc"
            }
            collection == "new" -> {
                params["$dateField.gte"] = "${LocalDate.now().year - 1}-01-01"; params["$dateField.lte"] = day()
                params["sort_by"] = "popularity.desc"; params["vote_count.gte"] = "20"
            }
            collection == "audience" || sort == "audience" -> params["sort_by"] = "vote_count.desc"
            sort == "rating" -> { params["sort_by"] = "vote_average.desc"; params["vote_count.gte"] = if (kind == "movie") "500" else "200" }
            sort == "year" -> { params["sort_by"] = "$dateField.desc"; params["$dateField.lte"] = day(); params["vote_count.gte"] = "20" }
            sort == "title" -> { params["sort_by"] = if (kind == "movie") "original_title.asc" else "name.asc"; params["vote_count.gte"] = "300" }
            else -> params["sort_by"] = "popularity.desc"
        }
        if (genre.isNotBlank()) {
            val valid = if (kind == "movie") MOVIE_GENRE_IDS else TV_GENRE_IDS
            val ids = GENRES.filter { (id, name) -> name == genre && id in valid }.keys.map(Int::toString).toMutableList()
            if (genre == "мультфильм" || genre == "аниме") ids += "16"
            if (genre == "аниме") params["with_original_language"] = "ja"
            params["with_genres"] = if (ids.isEmpty()) "0" else ids.distinct().joinToString("|")
        }
        return "discover/$kind?" + params.entries.joinToString("&") { (key, value) -> "$key=${enc(value)}" }
    }

    /** A page of the catalogue: films and series side by side, up to 500 pages, as TMDB serves them. */
    suspend fun catalogPage(kinds: List<String>, page: Int, genre: String, sort: String, collection: String, upcoming: String? = null): Pair<List<TvItem>, Int> = coroutineScope {
        val answers = kinds.map { kind -> async { runCatching { get(discoverPath(kind, page, genre, sort, collection, upcoming), 12_000) }.getOrNull() } }.awaitAll()
        val lists = answers.mapIndexed { index, json -> list(json, kinds[index]) }
        val found = mutableListOf<TvItem>()
        for (index in 0 until (lists.maxOfOrNull { it.size } ?: 0)) lists.forEach { list -> list.getOrNull(index)?.let(found::add) }
        val pages = minOf(500, maxOf(1, answers.maxOfOrNull { it?.optInt("total_pages") ?: 1 } ?: 1))
        if (answers.all { it == null }) throw IllegalStateException("TMDB не ответил")
        found.filter { upcoming == null || it.premiere.isBlank() || it.premiere > day() } to pages
    }

    /** «Бегущие по краю 2», «Ведьмак 3 сезон»: a query that finds nothing is asked again without the trailing number. */
    suspend fun search(query: String, page: Int = 1): Pair<List<TvItem>, Int> {
        suspend fun ask(text: String) = get("search/multi?query=${enc(text)}&language=ru-RU&include_adult=false&page=$page", 10_000)
        var json = ask(query)
        val bare = query.replace(Regex("[\\s:,.-]+(\\d{1,2}(\\s*(сезон|season|часть|part))?|(сезон|season|часть|part)\\s*\\d{1,2})\\s*$", RegexOption.IGNORE_CASE), "").trim()
        if (json.optInt("total_results") == 0 && bare.isNotBlank() && bare != query.trim()) json = ask(bare)
        return list(json) to minOf(20, json.optInt("total_pages", 1))
    }

    suspend fun title(id: String): TvItem {
        val (kind, tmdbId) = parseId(id) ?: throw IllegalArgumentException("Не TMDB: $id")
        val path = if (kind == "series") "tv" else "movie"
        val extra = if (kind == "series") "credits,external_ids,content_ratings,alternative_titles" else "credits,external_ids,release_dates,alternative_titles"
        return item(get("$path/$tmdbId?language=ru-RU&append_to_response=$extra", 12_000), kind)
    }

    suspend fun extras(item: TvItem): List<TvRow> = coroutineScope {
        val path = if (item.isSeries) "tv" else "movie"
        val kind = if (item.isSeries) "tv" else "movie"
        val recommended = async { list(runCatching { get("$path/${item.tmdbId}/recommendations?language=ru-RU") }.getOrNull(), kind) }
        val similar = async { list(runCatching { get("$path/${item.tmdbId}/similar?language=ru-RU") }.getOrNull(), kind) }
        listOf(TvRow("rec", "Рекомендуем", "", recommended.await()), TvRow("similar", "Похожие", "", similar.await())).filter { it.items.isNotEmpty() }
    }

    suspend fun episodes(showId: Int, season: Int): List<TvEpisode> {
        val json = get("tv/$showId/season/$season?language=ru-RU")
        return json.optJSONArray("episodes").objects().map {
            TvEpisode(season, it.optInt("episode_number"),
                it.optString("name").replace(Regex("^(Эпизод|Серия|Episode)\\s*\\d+$", RegexOption.IGNORE_CASE), "").trim(),
                image(it.optString("still_path").takeIf { p -> p != "null" }.orEmpty(), "w300"), it.optString("air_date"), it.optString("overview"), it.optInt("runtime"),
                if (it.optInt("vote_count") >= 3) Math.round(it.optDouble("vote_average", 0.0) * 10) / 10.0 else 0.0, it.optInt("vote_count"))
        }
    }

    /** The site's episode ratings map: TMDB's per-episode ratings of every season (3 votes and more), shown from 6 rated episodes. */
    suspend fun episodeRatings(item: TvItem): List<TvRatedSeason> = coroutineScope {
        val seasons = item.seasons.map { it.number }
        val semaphore = kotlinx.coroutines.sync.Semaphore(6)
        val all = seasons.map { number ->
            async { semaphore.acquire(); try { runCatching { episodes(item.tmdbId, number) }.getOrNull() } finally { semaphore.release() } }
        }.awaitAll()
        val rated = all.mapIndexedNotNull { index, list ->
            val episodes = list.orEmpty().filter { it.rating > 0 }.map { Triple(it.number, it.rating, it.votes) }
            if (episodes.isEmpty()) null else TvRatedSeason(seasons[index], episodes)
        }
        if (rated.sumOf { it.episodes.size } >= 6) rated else emptyList()
    }

    /** Trailers, as the site's «Трейлер»: Rutube, found by our server (works without a VPN). */
    suspend fun trailers(item: TvItem, includePreview: Boolean = false): List<TvTrailer> {
        val url = "${TvNet.server}/api/trailers?title=${enc(item.title)}&original=${enc(item.originalTitle)}&year=${if (item.year > 0) item.year else ""}${if (includePreview) "&preview=1" else ""}"
        return JSONObject(TvNet.get(url, 15_000)).optJSONArray("items").objects().filter { it.optString("provider", "rutube") == "rutube" && it.optString("id").isNotBlank() }
            .map { TvTrailer(it.optString("id"), it.optString("title"), it.optString("author").ifBlank { "Rutube" }, it.optInt("duration"), it.optString("previewUrl"), it.optString("previewHighUrl")) }
    }

    /** Rutube's own stream of a video, so Media3 plays it on the TV's decoder instead of Rutube's web player. */
    suspend fun rutubeStream(id: String): String =
        JSONObject(TvNet.get("https://rutube.ru/api/play/options/$id/?format=json&no_404=true", 15_000)).optJSONObject("video_balancer")?.optString("m3u8").orEmpty()

    /** IntroDB knows titles by IMDb id. */
    suspend fun imdbId(item: TvItem): String {
        if (item.imdbId.isNotBlank()) return item.imdbId
        val path = if (item.isSeries) "tv" else "movie"
        return runCatching { get("$path/${item.tmdbId}/external_ids").optString("imdb_id") }.getOrDefault("").takeIf { it.startsWith("tt") }.orEmpty()
    }

    suspend fun person(id: Int): TvPersonPage {
        val person = get("person/$id?language=ru-RU&append_to_response=combined_credits", 12_000)
        var bio = person.optString("biography")
        if (bio.isBlank()) bio = runCatching { get("person/$id?language=en-US").optString("biography") }.getOrDefault("")
        val credits = person.optJSONObject("combined_credits")
        val all = credits?.optJSONArray("cast").objects() + credits?.optJSONArray("crew").objects().filter { it.optString("job") == "Director" }
        // Only real roles, newest first: no talk shows, news, award shows or playing oneself.
        val selfRole = Regex("\\b(himself|herself|themselves|self)\\b|сам(а|и)?\\s*себя|себя|камео|cameo|archive footage|архивн", RegexOption.IGNORE_CASE)
        val notRoles = setOf(10767, 10763, 10764)
        val unique = all.filter { entry ->
            val type = entry.optString("media_type")
            val genres = entry.optJSONArray("genre_ids")?.let { list -> (0 until list.length()).map(list::optInt) }.orEmpty()
            (type == "movie" || type == "tv") && !selfRole.containsMatchIn(entry.optString("character")) && genres.none(notRoles::contains)
        }.associateBy { "${it.optString("media_type")}-${it.optInt("id")}" }.values
        fun dateOf(entry: JSONObject) = entry.optString("release_date").ifBlank { entry.optString("first_air_date") }
        val today = day()
        fun items(list: List<JSONObject>) = list.map { item(it) }.filter { it.poster.isNotBlank() }
        val upcoming = items(unique.filter { dateOf(it).isBlank() || dateOf(it) > today }.sortedBy { dateOf(it).ifBlank { "9999" } })
        val recent = items(unique.filter { dateOf(it).isNotBlank() && dateOf(it) <= today }.sortedByDescending(::dateOf)).take(40)
        // The best-known works: the most voted first, whenever they came out; and the whole filmography, newest first.
        val popular = items(unique.filter { dateOf(it).isNotBlank() && dateOf(it) <= today }.sortedByDescending { it.optInt("vote_count") }).take(40)
        val everything = items(unique.filter { dateOf(it).isNotBlank() && dateOf(it) <= today }.sortedByDescending(::dateOf))
        val birthday = person.optString("birthday").takeIf { it.length == 10 && it != "null" }
        val deathday = person.optString("deathday").takeIf { it.length == 10 && it != "null" }
        val dates = birthday?.let {
            val years = runCatching { java.time.Period.between(LocalDate.parse(it), deathday?.let(LocalDate::parse) ?: LocalDate.now()).years }.getOrDefault(0)
            "${russianDate(it, withYear = true)}${deathday?.let { d -> " — ${russianDate(d, withYear = true)}" }.orEmpty()}${if (years > 0) " · ${countWord(years, "год", "года", "лет")}" else ""}"
        }.orEmpty()
        val department = mapOf("Acting" to "Актёр", "Directing" to "Режиссёр", "Writing" to "Сценарист", "Production" to "Продюсер")[person.optString("known_for_department")] ?: "Персона"
        return TvPersonPage(person.optString("name"), department, dates, person.optString("place_of_birth").takeIf { it != "null" }.orEmpty(),
            bio.replace("**", "").replace("__", "").trim(), image(person.optString("profile_path").takeIf { it != "null" }.orEmpty(), "w500"), upcoming, recent, popular, everything)
    }
}

private val MONTHS = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

/** «15 ноября» this year, «15 ноября 2027» otherwise; «сегодня» and «завтра» close by. */
fun russianDate(date: String, withYear: Boolean = false): String {
    val parsed = runCatching { LocalDate.parse(date.take(10)) }.getOrNull() ?: return ""
    val today = LocalDate.now()
    if (!withYear && parsed == today) return "сегодня"
    if (!withYear && parsed == today.plusDays(1)) return "завтра"
    val base = "${parsed.dayOfMonth} ${MONTHS[parsed.monthValue - 1]}"
    return if (withYear || parsed.year != today.year) "$base ${parsed.year}" else base
}

fun countWord(count: Int, one: String, few: String, many: String): String {
    val mod10 = count % 10
    val mod100 = count % 100
    val word = when {
        mod10 == 1 && mod100 != 11 -> one
        mod10 in 2..4 && mod100 !in 12..14 -> few
        else -> many
    }
    return "$count $word"
}
