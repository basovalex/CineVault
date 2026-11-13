package com.cinevault.android

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** An answer that came back, but not with 2xx. */
class HttpError(val status: Int, message: String) : IOException(message)

/**
 * The network of the TV app, the way the site works: its own server (behind the site password) for TMDB,
 * IntroDB marks, CUB's feed and the account; Lampac directly, with the device id the server hands out in
 * /config.local.js, so that id never lives in the code.
 */
object TvNet {
    val server: String = BuildConfig.SERVER_URL.trimEnd('/')
    val basic: String? = BuildConfig.BASIC_USERNAME.takeIf(String::isNotBlank)?.let {
        "Basic " + Base64.encodeToString("$it:${BuildConfig.BASIC_PASSWORD}".toByteArray(), Base64.NO_WRAP)
    }
    private const val COOKIE = "cinevault_session"
    private lateinit var prefs: SharedPreferences

    val client: OkHttpClient = OkHttpClient.Builder()
        .dispatcher(Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 16 })
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun init(context: Context) {
        if (!::prefs.isInitialized) prefs = context.getSharedPreferences("cinevault.tv.net", Context.MODE_PRIVATE)
    }

    /** The account's session cookie (set by /api/account/login). */
    var session: String
        get() = prefs.getString("session", "").orEmpty()
        set(value) { prefs.edit().putString("session", value).apply() }

    fun isServer(url: String) = url.startsWith(server)

    /** Headers our server wants: the site password and, for the account, its cookie. */
    fun serverHeaders(url: String): Map<String, String> {
        if (!isServer(url)) return emptyMap()
        val headers = mutableMapOf<String, String>()
        basic?.let { headers["Authorization"] = it }
        if (session.isNotBlank()) headers["Cookie"] = "$COOKIE=$session"
        return headers
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { runCatching { cancel() } }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { continuation.resume(response) }
        })
    }

    private suspend fun execute(request: Request, timeoutMs: Long): Pair<Int, String> {
        val call = client.newCall(request)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        val response = call.await()
        return response.use { answer ->
            if (isServer(request.url.toString())) {
                answer.headers("Set-Cookie").firstOrNull { it.startsWith("$COOKIE=") }?.let { cookie ->
                    session = cookie.substringAfter('=').substringBefore(';')
                }
            }
            val text = withContext(Dispatchers.IO) { answer.body?.string().orEmpty() }
            answer.code to text
        }
    }

    suspend fun get(url: String, timeoutMs: Long = 12_000, headers: Map<String, String> = emptyMap()): String {
        val builder = Request.Builder().url(url).header("Accept", "application/json, */*")
        (serverHeaders(url) + headers).forEach { (name, value) -> builder.header(name, value) }
        val (status, text) = execute(builder.build(), timeoutMs)
        if (status !in 200..299) throw HttpError(status, errorText(text, status))
        return text
    }

    suspend fun post(url: String, body: String, timeoutMs: Long = 12_000, headers: Map<String, String> = emptyMap()): String {
        val builder = Request.Builder().url(url).post(body.toRequestBody("application/json".toMediaType())).header("Accept", "application/json")
        (serverHeaders(url) + headers).forEach { (name, value) -> builder.header(name, value) }
        val (status, text) = execute(builder.build(), timeoutMs)
        if (status !in 200..299) throw HttpError(status, errorText(text, status))
        return text
    }

    private fun errorText(text: String, status: Int) =
        runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf(String::isNotBlank) ?: "Сервер ответил $status"

    data class Config(val lampacOrigin: String, val lampacUid: String, val tmdbKey: String)

    private var config: Config? = null
    private val configLock = Mutex()

    /** The site's own config: where Lampac is and the id it lets in. Asked once per launch. */
    suspend fun config(): Config = configLock.withLock {
        config ?: run {
            val text = get("$server/config.local.js", 15_000)
            val json = JSONObject(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1))
            Config(json.optString("lampacOrigin").trimEnd('/'), json.optString("lampacUid"), json.optString("tmdbApiKey"))
                .also { config = it }
        }
    }
}
