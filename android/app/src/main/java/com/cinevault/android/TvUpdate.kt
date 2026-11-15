package com.cinevault.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** A version the server offers (GET /tv/latest.json). */
data class UpdateInfo(val versionCode: Int, val versionName: String, val sha256: String, val size: Long, val notes: String, val url: String)

sealed interface UpdateState {
    data object Idle : UpdateState
    data class Available(val info: UpdateInfo) : UpdateState
    data class Downloading(val info: UpdateInfo, val share: Float) : UpdateState
    data class Ready(val info: UpdateInfo, val file: File, val needsPermission: Boolean = false) : UpdateState
    data class Failed(val info: UpdateInfo?, val message: String) : UpdateState
}

/**
 * Updates from inside the app: on launch it asks the server for the latest version, offers «Обновить»,
 * downloads the APK (checking its sha256) and hands it to the system installer. The first install is still
 * by hand; every one after it is a single button.
 */
object TvUpdate {
    var state by mutableStateOf<UpdateState>(UpdateState.Idle)
        private set
    /** True once the server answered, so «У вас последняя версия» can be said. */
    var checked by mutableStateOf(false)
        private set
    var checking by mutableStateOf(false)
        private set
    /** «Позже»: the offer stays hidden until the next launch. */
    var dismissed by mutableStateOf(false)
    private var lastCheck = 0L
    /** When the app started: only an offer that comes right then takes the remote's focus, never one that interrupts browsing. */
    val startedAt = android.os.SystemClock.elapsedRealtime()

    val installed: String get() = BuildConfig.VERSION_NAME

    suspend fun check(force: Boolean = false) {
        if (checking || state is UpdateState.Downloading) return
        if (!force && System.currentTimeMillis() - lastCheck < 30 * 60_000) return
        checking = true
        try {
            val json = JSONObject(TvNet.get("${TvNet.server}/tv/latest.json", 12_000))
            val info = UpdateInfo(json.optInt("versionCode"), json.optString("versionName"), json.optString("sha256"), json.optLong("size"),
                json.optString("notes"), json.optString("url", "/tv/CineVault-android.apk"))
            lastCheck = System.currentTimeMillis()
            checked = true
            val current = state
            if (info.versionCode > BuildConfig.VERSION_CODE) {
                if (current is UpdateState.Idle || current is UpdateState.Failed || (current is UpdateState.Available && current.info.versionCode != info.versionCode)) state = UpdateState.Available(info)
            } else state = UpdateState.Idle
        } catch (error: HttpError) {
            // 404: nothing published yet. Not an error for the viewer.
            lastCheck = System.currentTimeMillis()
            checked = error.status == 404
        } catch (error: Exception) {
            android.util.Log.w("TvUpdate", "check failed: $error")
        } finally {
            checking = false
        }
    }

    suspend fun download(context: Context) {
        val info = when (val now = state) {
            is UpdateState.Available -> now.info
            is UpdateState.Failed -> now.info ?: return
            else -> return
        }
        state = UpdateState.Downloading(info, 0f)
        try {
            val folder = File(context.cacheDir, "updates").apply { mkdirs() }
            folder.listFiles()?.forEach { it.delete() }
            val target = File(folder, "CineVault-${info.versionCode}.apk")
            withContext(Dispatchers.IO) {
                val url = if (info.url.startsWith("http")) info.url else TvNet.server + info.url
                val builder = Request.Builder().url(url)
                TvNet.serverHeaders(url).forEach { (name, value) -> builder.header(name, value) }
                val digest = MessageDigest.getInstance("SHA-256")
                TvNet.client.newBuilder().readTimeout(60, java.util.concurrent.TimeUnit.SECONDS).build().newCall(builder.build()).execute().use { response ->
                    if (!response.isSuccessful) throw HttpError(response.code, "Сервер ответил ${response.code}")
                    val total = response.body?.contentLength()?.takeIf { it > 0 } ?: info.size
                    var done = 0L
                    var shown = -1
                    response.body!!.byteStream().use { input ->
                        target.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                                done += read
                                val percent = if (total > 0) (done * 100 / total).toInt() else 0
                                if (percent != shown) { shown = percent; state = UpdateState.Downloading(info, percent / 100f) }
                            }
                        }
                    }
                    if (total > 0 && done != total) throw java.io.IOException("файл загрузился не целиком")
                }
                val sum = digest.digest().joinToString("") { "%02x".format(it) }
                if (info.sha256.isNotBlank() && !sum.equals(info.sha256, ignoreCase = true)) {
                    target.delete()
                    throw java.io.IOException("файл повреждён, контрольная сумма не сошлась")
                }
            }
            state = UpdateState.Ready(info, target, needsPermission = !context.packageManager.canRequestPackageInstalls())
        } catch (error: Exception) {
            android.util.Log.w("TvUpdate", "download failed: $error")
            state = UpdateState.Failed(info, if (error is HttpError && error.status == 404) "Обновление пропало с сервера" else "Не удалось загрузить обновление: ${error.message ?: "ошибка сети"}")
        }
    }

    /** Opens the system installer; false when the system first wants the permission to install from this app. */
    fun install(context: Context): Boolean {
        val ready = state as? UpdateState.Ready ?: return false
        if (!context.packageManager.canRequestPackageInstalls()) {
            state = ready.copy(needsPermission = true)
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(settings) }.onFailure {
                runCatching { context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            return false
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", ready.file)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        state = ready.copy(needsPermission = false)
        return runCatching { context.startActivity(intent) }.onFailure { state = UpdateState.Failed(ready.info, "Не удалось открыть установщик: ${it.message}") }.isSuccess
    }
}

/**
 * «Доступна новая версия»: shown on the home page when the server has a newer app, with the one button that
 * downloads and installs it. [always] also shows the quiet «версия … актуальна» line (the account page).
 */
@Composable
fun UpdateBanner(modifier: Modifier = Modifier, always: Boolean = false, focus: FocusRequester? = null) {
    val state = TvUpdate.state
    val context = LocalContext.current.applicationContext
    val scope = rememberCoroutineScope()
    val own = remember { FocusRequester() }
    val target = focus ?: own
    androidx.compose.runtime.LaunchedEffect(state::class) {
        val early = android.os.SystemClock.elapsedRealtime() - TvUpdate.startedAt < 15_000
        if (state is UpdateState.Ready || state is UpdateState.Failed || (state is UpdateState.Available && early && !TvUpdate.dismissed)) {
            kotlinx.coroutines.delay(300)
            runCatching { target.requestFocus() }
        }
    }
    if (state is UpdateState.Idle || TvUpdate.dismissed && !always) {
        if (always) Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            HText(
                when { TvUpdate.checking -> "Проверяю обновления…"; TvUpdate.checked -> "Версия ${TvUpdate.installed} — самая свежая"; else -> "Версия ${TvUpdate.installed}" },
                size = Hall.S0, color = Hall.Muted,
            )
            HButton("Проверить обновления", { scope.launch { TvUpdate.check(force = true) } }, busy = TvUpdate.checking)
        }
        return
    }
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Hall.RLg)).background(Hall.Surface).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(Icons.Default.SystemUpdate, null, tint = Hall.Accent)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            when (state) {
                is UpdateState.Available -> {
                    HText("Доступна новая версия ${state.info.versionName}", size = Hall.S1, weight = FontWeight.SemiBold, maxLines = 1)
                    HText(listOfNotNull(state.info.notes.takeIf(String::isNotBlank), "У вас ${TvUpdate.installed}").joinToString(" · "), size = Hall.S_1, color = Hall.Muted, maxLines = 2)
                }
                is UpdateState.Downloading -> {
                    HText("Загружаю обновление ${state.info.versionName}… ${(state.share * 100).toInt()}%", size = Hall.S1, weight = FontWeight.SemiBold, maxLines = 1)
                    ProgressBar(state.share.toDouble(), Modifier.fillMaxWidth().padding(top = 6.dp))
                }
                is UpdateState.Ready -> {
                    HText("Обновление ${state.info.versionName} загружено", size = Hall.S1, weight = FontWeight.SemiBold, maxLines = 1)
                    HText(
                        if (state.needsPermission) "Телевизор попросит разрешить Lumo Film устанавливать приложения. Разрешите, вернитесь «Назад» и нажмите «Установить» ещё раз."
                        else "Нажмите «Установить» и подтвердите. Приложение перезапустится само.",
                        size = Hall.S_1, color = if (state.needsPermission) Hall.Gold else Hall.Muted, maxLines = 3,
                    )
                }
                is UpdateState.Failed -> HText(state.message, size = Hall.S0, color = Hall.Gold, maxLines = 3)
                UpdateState.Idle -> {}
            }
        }
        when (state) {
            is UpdateState.Available -> {
                HButton("Обновить", { scope.launch { TvUpdate.download(context) } }, primary = true, focus = target)
                if (!always) HButton("Позже", { TvUpdate.dismissed = true })
            }
            is UpdateState.Ready -> HButton("Установить", { TvUpdate.install(context) }, primary = true, focus = target)
            is UpdateState.Failed -> HButton("Повторить", { scope.launch { if (state.info != null) TvUpdate.download(context) else TvUpdate.check(force = true) } }, primary = true, focus = target)
            else -> {}
        }
    }
}
