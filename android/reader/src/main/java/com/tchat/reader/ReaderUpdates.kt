package com.tchat.reader

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray

private const val REPO = "Turrygpt/TChat"
private const val MAX_APK = 128L * 1024 * 1024
private val stableVersion = Regex("""reader-v(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?)""")

internal data class ReaderRelease(val version: String, val url: String, val bytes: Long, val digest: String?) {
    val versionOrder = version.split('.').map(String::toLong).let { it[0] * 1_000_000_000_000L + it[1] * 1_000_000L + it.getOrElse(2) { 0L } }
}

internal fun readerReleases(page: JSONArray): List<ReaderRelease> = buildList {
    for (i in 0 until page.length()) {
        val release = page.optJSONObject(i) ?: continue
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) continue
        val tag = release.optString("tag_name")
        val version = stableVersion.matchEntire(tag)?.groupValues?.get(1) ?: continue
        val name = "TChat-Reader-$version.apk"
        val url = "https://github.com/$REPO/releases/download/$tag/$name"
        val assets = release.optJSONArray("assets") ?: continue
        for (j in 0 until assets.length()) {
            val asset = assets.optJSONObject(j) ?: continue
            if (asset.optString("name") != name || asset.optString("browser_download_url") != url || asset.optString("state") != "uploaded") continue
            val size = asset.optLong("size")
            if (size !in 1..MAX_APK) continue
            val digest = if (asset.isNull("digest")) null else asset.getString("digest")
            if (digest != null && !Regex("sha256:[0-9a-fA-F]{64}").matches(digest)) continue
            add(ReaderRelease(version, url, size, digest?.substringAfter(':')?.lowercase()))
        }
    }
}

internal sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object Current : UpdateState
    data class Offer(val release: ReaderRelease) : UpdateState
    data class Downloading(val percent: Int) : UpdateState
    data class Ready(val file: File) : UpdateState
    data class Error(val message: String) : UpdateState
}

internal class ReaderUpdater(private val app: Context, private val scope: CoroutineScope,
    private val http: OkHttpClient = OkHttpClient(), private val installedVersion: String = BuildConfig.VERSION_NAME) {
    var state by mutableStateOf<UpdateState>(UpdateState.Idle)
        private set
    private var task: Job? = null
    private val folder get() = File(app.cacheDir, "reader-updates")
    private fun target(release: ReaderRelease) = File(folder, "TChat-Reader-${release.version}.apk")

    private fun run(initial: UpdateState, block: suspend () -> UpdateState) {
        if (task?.isActive == true) return
        state = initial
        task = scope.launch {
            state = try { block() }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { UpdateState.Error((error as? UpdateError)?.message ?: "Не удалось связаться с GitHub. Повторите проверку.") }
        }
    }

    fun check() = run(UpdateState.Checking) {
        withContext(Dispatchers.IO) {
            var page = 1
            var newest: ReaderRelease? = null
            do {
                currentCoroutineContext().ensureActive()
                val url = "https://api.github.com/repos/$REPO/releases?per_page=100&page=$page"
                val request = Request.Builder().url(url).header("Accept", "application/vnd.github+json").build()
                val releases = http.newCall(request).execute().use {
                    if (!it.isSuccessful) throw UpdateError("GitHub вернул HTTP ${it.code}. Повторите проверку позже.")
                    JSONArray(it.body?.string() ?: throw IOException())
                }
                newest = (readerReleases(releases) + listOfNotNull(newest)).maxByOrNull(ReaderRelease::versionOrder)
                page++
            } while (releases.length() == 100)
            val release = newest ?: throw UpdateError("В GitHub Releases пока нет сборки TChat Reader.")
            val installed = ReaderRelease(installedVersion, "", 0, null).versionOrder
            if (release.versionOrder <= installed) UpdateState.Current
            else {
                val cached = target(release)
                if (cached.isFile && runCatching { verify(cached, release) }.isSuccess) UpdateState.Ready(cached)
                else UpdateState.Offer(release)
            }
        }
    }

    fun download(release: ReaderRelease) = run(UpdateState.Downloading(0)) {
        withContext(Dispatchers.IO) {
            folder.mkdirs()
            val partial = File.createTempFile("download-", ".apk", folder)
            try {
                val request = Request.Builder().url(release.url).build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful || !response.request.url.isHttps) throw UpdateError("GitHub не отдал файл обновления.")
                    val body = response.body ?: throw IOException()
                    body.byteStream().use { input -> partial.outputStream().use { out ->
                        val buffer = ByteArray(65536)
                        var received = 0L
                        var lastProgress = 0
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val n = input.read(buffer)
                            if (n < 0) break
                            received += n
                            if (received > release.bytes) throw UpdateError("Размер APK отличается от указанного в релизе.")
                            out.write(buffer, 0, n)
                            val progress = (100 * received / release.bytes).toInt()
                            if (progress - lastProgress >= 3) {
                                withContext(Dispatchers.Main) { state = UpdateState.Downloading(progress) }
                                lastProgress = progress
                            }
                        }
                    } }
                }
                verify(partial, release)
                val apk = target(release)
                Files.move(partial.toPath(), apk.toPath(), StandardCopyOption.REPLACE_EXISTING)
                UpdateState.Ready(apk)
            } finally { partial.delete() }
        }
    }

    @Suppress("DEPRECATION")
    private fun verify(file: File, release: ReaderRelease) {
        if (file.length() != release.bytes) throw UpdateError("APK скачан не полностью. Повторите загрузку.")
        release.digest?.let { expected ->
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input -> val buf = ByteArray(65536)
                while (true) { val n = input.read(buf); if (n < 0) break; digest.update(buf, 0, n) }
            }
            if (digest.digest().joinToString("") { "%02x".format(it) } != expected) throw UpdateError("Контрольная сумма APK не совпадает.")
        }
        val pm = app.packageManager
        val incoming = pm.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNATURES)
            ?: throw UpdateError("Android не смог прочитать APK.")
        val current = pm.getPackageInfo(app.packageName, PackageManager.GET_SIGNATURES)
        fun versionCode(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        val signing = current.signatures?.toSet().orEmpty()
        if (incoming.packageName != app.packageName || incoming.versionName != release.version ||
            versionCode(incoming) <= versionCode(current) || signing.isEmpty() || incoming.signatures?.toSet() != signing) {
            throw UpdateError("Имя приложения, версия или подпись APK не подходят для обновления.")
        }
    }

    private class UpdateError(message: String) : IOException(message)
}

@Composable
internal fun UpdateSettings(updater: ReaderUpdater) {
    val context = LocalContext.current
    val state = updater.state
    var installNotice by remember { mutableStateOf("") }
    fun install() {
        val ready = updater.state as? UpdateState.Ready ?: return
        val uri = FileProvider.getUriForFile(context, context.packageName + ".updates", ready.file)
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (_: android.content.ActivityNotFoundException) { installNotice = "Системный установщик Android недоступен" }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (context.packageManager.canRequestPackageInstalls()) install() else installNotice = "Разрешите установку обновлений для TChat Reader"
    }
    val label = when (state) {
        UpdateState.Idle, UpdateState.Current -> "Проверить обновления"
        UpdateState.Checking -> "Проверяем GitHub…"
        is UpdateState.Offer -> "Скачать версию ${state.release.version}"
        is UpdateState.Downloading -> "Скачивание · ${state.percent}%"
        is UpdateState.Ready -> "Установить обновление"
        is UpdateState.Error -> "Повторить проверку"
    }
    val detail = when (state) {
        UpdateState.Current -> "Установлена последняя версия · ${BuildConfig.VERSION_NAME}"
        is UpdateState.Error -> state.message
        is UpdateState.Ready -> installNotice.ifEmpty { "APK проверен. Установку подтвердит Android." }
        else -> "TChat Reader ${BuildConfig.VERSION_NAME}"
    }
    ListItem(headlineContent = { Text(label) }, supportingContent = { Text(detail) },
        leadingContent = { Icon(Icons.Outlined.SystemUpdate, null) },
        modifier = Modifier.clickable(enabled = state !is UpdateState.Downloading && state != UpdateState.Checking) {
            when (state) {
                is UpdateState.Offer -> updater.download(state.release)
                is UpdateState.Ready -> if (context.packageManager.canRequestPackageInstalls()) install() else {
                    try { permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName))) }
                    catch (_: android.content.ActivityNotFoundException) { installNotice = "Откройте разрешение на установку в настройках Android" }
                }
                else -> updater.check()
            }
        })
}
