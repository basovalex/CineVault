package com.cinevault.android

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** One "where it stopped" record, in the site's shape (state.progress), so accounts share it across devices. */
data class TvProgress(val key: String, val titleId: String, val season: Int, val episode: Int, val position: Double, val duration: Double,
                      val completed: Boolean, val updatedAt: Long, val raw: JSONObject) {
    val share get() = if (duration > 0) (position / duration).coerceIn(0.0, 1.0) else 0.0
    val real get() = duration > 0 && position >= 15
}

/**
 * What the viewer keeps, kept like the site keeps it: favourites, history (with removal marks so a removal
 * reaches every device), "continue watching" and reminders. Signed in, it follows the account through
 * /api/account/site-state, the same merge the site uses; signed out, it stays on the TV.
 */
object TvState {
    var pendingCatalogGenre = ""
    private lateinit var prefs: SharedPreferences
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    val favorites = mutableStateListOf<String>()
    val history = mutableStateListOf<String>()
    val subscriptions = mutableStateListOf<String>()
    val progress = mutableStateMapOf<String, TvProgress>()
    val known = mutableStateMapOf<String, TvItem>()
    private var historyAt = mutableMapOf<String, Double>()
    private var historyRemoved = mutableMapOf<String, Double>()
    private var savedMarks = JSONObject()

    var user by mutableStateOf<String?>(null)
        private set
    private var csrf = ""
    var syncing by mutableStateOf(false)
        private set
    var revision by mutableStateOf(0)
        private set

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.getSharedPreferences("cinevault.tv.state", Context.MODE_PRIVATE)
        val json = runCatching { JSONObject(prefs.getString("state", "{}")!!) }.getOrDefault(JSONObject())
        favorites.addAll(json.optJSONArray("favorites").strings())
        history.addAll(json.optJSONArray("history").strings())
        subscriptions.addAll(json.optJSONArray("subscriptions").strings())
        historyAt = json.optJSONObject("historyAt").numbers()
        historyRemoved = json.optJSONObject("historyRemoved").numbers()
        savedMarks = json.optJSONObject("savedMarks") ?: JSONObject()
        json.optJSONObject("progress")?.let(::readProgress)?.let(progress::putAll)
        json.optJSONObject("known")?.let { all -> all.keys().forEach { id -> all.optJSONObject(id)?.let { known[id] = TvItem.fromBrief(it) } } }
        pendingRecovery = prefs.getString("recovery", null)
        user = prefs.getString("user", null)
        csrf = prefs.getString("csrf", "").orEmpty()
    }

    private fun JSONObject?.numbers(): MutableMap<String, Double> {
        val map = mutableMapOf<String, Double>()
        this?.keys()?.forEach { key -> map[key] = optDouble(key, 0.0) }
        return map
    }

    private fun readProgress(json: JSONObject): Map<String, TvProgress> = json.keys().asSequence().mapNotNull { key ->
        val record = json.optJSONObject(key) ?: return@mapNotNull null
        val title = record.optString("titleId").ifBlank { key.replace(Regex("-(s\\d+e\\d+|alt|embed)$"), "") }
        key to TvProgress(key, title, record.optInt("seasonNumber"), record.optInt("episodeNumber"), record.optDouble("position", 0.0),
            record.optDouble("duration", 0.0), record.optBoolean("completed"), record.optLong("updatedAt"), record)
    }.toMap()

    private fun save() {
        val json = JSONObject()
            .put("favorites", JSONArray(favorites.toList())).put("history", JSONArray(history.toList()))
            .put("subscriptions", JSONArray(subscriptions.toList()))
            .put("historyAt", JSONObject(historyAt as Map<*, *>)).put("historyRemoved", JSONObject(historyRemoved as Map<*, *>))
            .put("savedMarks", savedMarks)
            .put("progress", JSONObject().also { all -> progress.values.forEach { all.put(it.key, it.raw) } })
        val wanted = (favorites + history + subscriptions + progress.values.map { it.titleId }).toSet()
        json.put("known", JSONObject().also { all -> known.filterKeys(wanted::contains).forEach { (id, item) -> all.put(id, item.brief()) } })
        prefs.edit().putString("state", json.toString()).apply()
        revision++
        schedulePush()
    }

    fun remember(item: TvItem) {
        val old = known[item.id]
        if (old == null || (old.poster.isBlank() && item.poster.isNotBlank()) || old.title != item.title) known[item.id] = item
    }

    fun isFavorite(id: String) = id in favorites

    fun toggleFavorite(item: TvItem): Boolean {
        remember(item)
        val adding = item.id !in favorites
        if (adding) favorites.add(item.id) else favorites.remove(item.id)
        save()
        return adding
    }

    fun isSubscribed(id: String) = id in subscriptions

    fun toggleSubscription(item: TvItem): Boolean {
        remember(item)
        val adding = item.id !in subscriptions
        if (adding) subscriptions.add(item.id) else subscriptions.remove(item.id)
        save()
        return adding
    }

    fun rememberHistory(item: TvItem) {
        remember(item)
        history.remove(item.id)
        history.add(0, item.id)
        while (history.size > 100) history.removeAt(history.lastIndex)
        historyAt[item.id] = System.currentTimeMillis().toDouble()
        save()
    }

    /** Removed from the history on every device: the account keeps a removal mark, or the next sync brings it back. */
    fun removeHistory(id: String) {
        progress.keys.filter { key -> progress[key]?.titleId == id || key == id || key.startsWith("$id-") }.forEach(progress::remove)
        history.remove(id)
        historyAt.remove(id)
        historyRemoved[id] = System.currentTimeMillis().toDouble()
        save()
        pushNow()
    }

    fun progressKey(id: String, season: Int, episode: Int) = if (season > 0) "$id-s${season}e$episode" else id

    fun progressOf(id: String, season: Int = 0, episode: Int = 0) = progress[progressKey(id, season, episode)]

    fun saveProgress(item: TvItem, season: Int, episode: Int, position: Double, duration: Double, completed: Boolean = false) {
        if (duration <= 0) return
        val key = progressKey(item.id, season, episode)
        val done = completed || duration - position < 60
        val raw = JSONObject().put("titleId", item.id).put("providerId", "lampac").put("position", position).put("duration", duration)
            .put("completed", done).put("updatedAt", System.currentTimeMillis())
        if (season > 0) raw.put("seasonNumber", season).put("episodeNumber", episode)
        progress[key] = TvProgress(key, item.id, season, episode, position, duration, done, raw.optLong("updatedAt"), raw)
        save()
    }

    /** The title's latest record: the episode to go on with. */
    fun latest(id: String): TvProgress? = progress.values.filter { it.titleId == id }.maxByOrNull { it.updatedAt }

    /**
     * Where «Смотреть» goes, as on the site: the unfinished episode, or the one after a finished episode. (0, 0) opens the
     * episode step, which itself offers «Дальше» when the seasons were not known here.
     */
    fun nextUp(item: TvItem): Pair<Int, Int> {
        val record = latest(item.id) ?: return 0 to 0
        if (record.season <= 0) return 0 to 0
        if (!record.completed) return record.season to record.episode
        val seasons = (known[item.id]?.takeIf { it.seasons.isNotEmpty() } ?: item).seasons
        val count = seasons.firstOrNull { it.number == record.season }?.episodes ?: return 0 to 0
        return if (record.episode < count) record.season to record.episode + 1
        else seasons.firstOrNull { it.number > record.season }?.let { it.number to 1 } ?: (0 to 0)
    }

    /** Everything watched, newest first, with weights: finished and favourite titles count more. */
    fun personalSeeds(): List<Pair<String, Double>> {
        val records = progress.values.sortedByDescending { it.updatedAt }
        val finished = records.filter { it.completed || (it.duration > 0 && it.position / it.duration > 0.6) }.map { it.titleId }.toSet()
        val ids = LinkedHashSet<String>().apply { records.forEach { add(it.titleId) }; addAll(history); addAll(favorites) }.toList().take(24)
        return ids.mapIndexed { index, id ->
            id to (1.0 / (1 + index * 0.12)) * (if (id in finished) 1.3 else 1.0) * (if (id in favorites) 1.4 else 1.0)
        }
    }

    /** «Продолжить просмотр»: one card per title with its latest unfinished episode. */
    fun continueWatching(): List<TvProgress> = progress.values.filter { !it.completed && it.real }
        .sortedByDescending { it.updatedAt }.distinctBy { it.titleId }

    // ---- Lampac choice: source and voice per title, the last choice anywhere for a title opened first time.
    fun lampacChoice(id: String): Pair<String, String> {
        val json = runCatching { JSONObject(prefs.getString("lampacChoice", "{}")!!) }.getOrDefault(JSONObject())
        val own = json.optJSONObject("titles")?.optJSONObject(id)
        return if (own != null) own.optString("source") to own.optString("voice") else json.optString("source") to json.optString("voice")
    }

    fun rememberLampacChoice(id: String, source: String? = null, voice: String? = null) {
        val json = runCatching { JSONObject(prefs.getString("lampacChoice", "{}")!!) }.getOrDefault(JSONObject())
        val titles = json.optJSONObject("titles") ?: JSONObject()
        val own = titles.optJSONObject(id) ?: JSONObject()
        source?.let { json.put("source", it); own.put("source", it) }
        voice?.let { json.put("voice", it); own.put("voice", it) }
        own.put("at", System.currentTimeMillis())
        titles.put(id, own)
        if (titles.length() > 500) titles.keys().asSequence().toList().sortedBy { titles.optJSONObject(it)?.optLong("at") ?: 0 }.take(titles.length() - 500).forEach(titles::remove)
        prefs.edit().putString("lampacChoice", json.put("titles", titles).toString()).apply()
    }

    /** The quality chosen last time, in lines (0 = automatic). */
    var preferredLines: Int
        get() = prefs.getInt("lines", 0)
        set(value) { prefs.edit().putInt("lines", value).apply() }

    /** The player's settings, as the site keeps them: speed and how the picture fills the screen. */
    var playerSpeed: Float
        get() = prefs.getFloat("speed", 1f)
        set(value) { prefs.edit().putFloat("speed", value).apply() }
    var playerFit: String
        get() = prefs.getString("fit", "contain").orEmpty()
        set(value) { prefs.edit().putString("fit", value).apply() }

    // ---- Account.
    private fun accountUrl(route: String) = "${TvNet.server}/api/account/$route"

    private fun payload(): JSONObject {
        val now = System.currentTimeMillis()
        val result = JSONObject().put("history", JSONObject()).put("progress", JSONObject().also { all -> progress.values.forEach { all.put(it.key, it.raw) } })
            .put("historyRemoved", JSONObject(historyRemoved as Map<*, *>))
        val marks = JSONObject()
        listOf("favorites" to favorites, "subscriptions" to subscriptions).forEach { (name, list) ->
            val current = list.toSet()
            val own = savedMarks.optJSONObject(name)?.let { JSONObject(it.toString()) } ?: JSONObject()
            current.forEach { id -> if (own.optJSONObject(id)?.optBoolean("on") != true) own.put(id, JSONObject().put("on", true).put("at", now)) }
            own.keys().asSequence().toList().forEach { id -> if (own.optJSONObject(id)?.optBoolean("on") == true && id !in current) own.put(id, JSONObject().put("on", false).put("at", now)) }
            result.put(name, own)
            marks.put(name, own)
        }
        savedMarks.optJSONObject("watchlist")?.let { result.put("watchlist", it); marks.put("watchlist", it) }
        savedMarks = marks
        history.forEachIndexed { index, id -> result.getJSONObject("history").put(id, historyAt[id] ?: (history.size - index).toDouble()) }
        return result
    }

    private fun apply(merged: JSONObject) {
        fun ordered(marks: JSONObject?): List<String> = marks?.keys()?.asSequence()?.toList().orEmpty()
            .mapNotNull { id -> marks?.optJSONObject(id)?.takeIf { it.optBoolean("on") }?.let { id to it.optDouble("at") } }
            .sortedBy { it.second }.map { it.first }
        savedMarks = JSONObject().put("favorites", merged.optJSONObject("favorites") ?: JSONObject())
            .put("subscriptions", merged.optJSONObject("subscriptions") ?: JSONObject()).put("watchlist", merged.optJSONObject("watchlist") ?: JSONObject())
        favorites.clear(); favorites.addAll(ordered(merged.optJSONObject("favorites")))
        subscriptions.clear(); subscriptions.addAll(ordered(merged.optJSONObject("subscriptions")))
        historyRemoved = merged.optJSONObject("historyRemoved").numbers()
        historyAt = merged.optJSONObject("history").numbers()
        history.clear(); history.addAll(historyAt.entries.sortedByDescending { it.value }.map { it.key }.take(100))
        progress.clear(); merged.optJSONObject("progress")?.let(::readProgress)?.let(progress::putAll)
    }

    private fun persistAccount() {
        prefs.edit().putString("user", user).putString("csrf", csrf).apply()
    }

    /** The recovery code of a new account (or after a reset), kept until the viewer says it is written down. */
    var pendingRecovery by mutableStateOf<String?>(null)
        private set

    private suspend fun finishSignIn(answer: JSONObject, fallbackName: String) {
        csrf = answer.optString("csrf")
        user = answer.optJSONObject("user")?.let { it.optString("display_name").ifBlank { it.optString("username") } } ?: fallbackName
        answer.optString("recovery_code").takeIf(String::isNotBlank)?.let { pendingRecovery = it; prefs.edit().putString("recovery", it).apply() }
        persistAccount()
        sync(force = true)
    }

    fun acknowledgeRecovery() { pendingRecovery = null; prefs.edit().remove("recovery").apply() }

    suspend fun login(username: String, password: String) {
        finishSignIn(JSONObject(TvNet.post(accountUrl("login"), JSONObject().put("username", username).put("password", password).toString())), username)
    }

    /** A new account, as the site's «Создать аккаунт»; the answer carries the recovery code shown once. */
    suspend fun register(username: String, displayName: String, password: String) {
        finishSignIn(JSONObject(TvNet.post(accountUrl("register"),
            JSONObject().put("username", username).put("display_name", displayName).put("password", password).toString())), displayName)
    }

    /** A new password with the recovery code; the answer carries a fresh code. */
    suspend fun recover(username: String, recoveryCode: String, newPassword: String) {
        finishSignIn(JSONObject(TvNet.post(accountUrl("recover"),
            JSONObject().put("username", username).put("recovery_code", recoveryCode.trim()).put("new_password", newPassword).toString())), username)
    }

    suspend fun logout() {
        runCatching { TvNet.post(accountUrl("logout"), "{}", headers = mapOf("X-CineVault-CSRF" to csrf)) }
        TvNet.session = ""
        user = null
        csrf = ""
        persistAccount()
    }

    /** Sends this TV's lists to the account and takes the merged result, as the site's syncAccountState. */
    suspend fun sync(force: Boolean = false) {
        if (TvNet.session.isBlank() || (syncing && !force)) return
        syncing = true
        try {
            val session = JSONObject(TvNet.get(accountUrl("session")))
            val account = session.optJSONObject("user")
            if (account == null) { user = null; csrf = ""; TvNet.session = ""; persistAccount(); return }
            user = account.optString("display_name").ifBlank { account.optString("username") }
            csrf = session.optString("csrf")
            persistAccount()
            val answer = JSONObject(TvNet.post(accountUrl("site-state"), JSONObject().put("state", payload()).toString(), headers = mapOf("X-CineVault-CSRF" to csrf)))
            answer.optJSONObject("state")?.let(::apply)
            prefs.edit().putString("state", JSONObject().toString()).apply()
            save()
        } catch (error: Exception) {
            android.util.Log.w("TvState", "sync failed: $error")
        } finally {
            syncing = false
        }
    }

    private var pushJob: Job? = null

    private fun schedulePush() {
        if (user == null || pushJob?.isActive == true) return
        pushJob = scope.launch { delay(4_000); push() }
    }

    private fun pushNow() {
        if (user == null) return
        pushJob?.cancel()
        pushJob = scope.launch { push() }
    }

    private suspend fun push() {
        if (user == null || TvNet.session.isBlank()) return
        runCatching {
            TvNet.post(accountUrl("site-state"), JSONObject().put("state", payload()).toString(), headers = mapOf("X-CineVault-CSRF" to csrf))
        }.onFailure { android.util.Log.w("TvState", "push failed: $it") }
    }
}
