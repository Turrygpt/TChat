package com.tchat.stream

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class StreamApkProvider : FileProvider()

internal class StreamUpdateError(message: String) : IOException(message)

private const val CHANNEL_URL = "https://raw.githubusercontent.com/Turrygpt/TChat/main/android/stream-release.json"
private const val RELEASES_URL = "https://github.com/Turrygpt/TChat/releases/download"

internal data class StreamRelease(val code: Int, val name: String, val bytes: Long, val sha256: String) {
    val apkUrl get() = "$RELEASES_URL/stream-v$name/TChat-Stream-$name.apk"

    companion object {
        fun parse(raw: String): StreamRelease {
            val json = JSONObject(raw)
            val release = StreamRelease(
                json.getInt("versionCode"), json.getString("versionName"), json.getLong("size"), json.getString("sha256"),
            )
            require(release.code > 0 && release.bytes in 1L..(512L * 1024 * 1024))
            require(Regex("""[0-9]+\.[0-9]+\.[0-9]+""").matches(release.name))
            require(Regex("[a-f0-9]{64}").matches(release.sha256))
            return release
        }
    }
}

internal class StreamUpdates(private val context: Context) {
    private val directory get() = File(context.cacheDir, "stream-updates")
    private fun apk(release: StreamRelease) = File(directory, "stream-${release.code}-${release.sha256}.apk")

    suspend fun readChannel(): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(CHANNEL_URL).header("Cache-Control", "no-cache").build()
        http.newCall(request).execute().use { response ->
            val source = response.body?.source()
            if (!response.isSuccessful || source == null || source.request(16_385)) {
                throw StreamUpdateError("Не удалось получить сведения о версии с GitHub.")
            }
            source.readUtf8().also { StreamRelease.parse(it) }
        }
    }

    suspend fun download(release: StreamRelease, progress: (Int) -> Unit) = withContext(Dispatchers.IO) {
        check(release.code > BuildConfig.VERSION_CODE)
        if (!directory.isDirectory && !directory.mkdirs()) throw StreamUpdateError("Не удалось открыть папку загрузки.")
        val ready = apk(release)
        if (ready.isFile && ready.inputStream().use { matches(it, null, release) {} }) {
            verifyPackage(ready, release)
            return@withContext
        }
        val part = File.createTempFile("download-", ".apk", directory)
        try {
            val request = Request.Builder().url(release.apkUrl).build()
            http.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) throw StreamUpdateError("GitHub не отдал файл обновления.")
                val valid = part.outputStream().buffered().use { target ->
                    matches(body.byteStream(), target, release, progress)
                }
                if (!valid) throw StreamUpdateError("APK не прошёл проверку SHA-256. Скачайте его ещё раз.")
            }
            verifyPackage(part, release)
            currentCoroutineContext().ensureActive()
            if (!part.renameTo(ready)) throw StreamUpdateError("Не удалось сохранить APK.")
            directory.listFiles()?.filter { it != ready && it.name.startsWith("stream-") && it.extension == "apk" }
                ?.forEach { it.delete() }
        } finally {
            part.delete()
        }
        Unit
    }

    suspend fun installer(release: StreamRelease): Intent = withContext(Dispatchers.IO) {
        val file = apk(release)
        if (!file.isFile || !file.inputStream().use { matches(it, null, release) {} }) {
            throw StreamUpdateError("Файл обновления недоступен. Скачайте APK ещё раз.")
        }
        verifyPackage(file, release)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").apply {
            clipData = ClipData.newRawUri("TChat Stream", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(file: File, release: StreamRelease) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, flags)
        val installed = pm.getPackageInfo(context.packageName, flags)
        val trusted = installed.signers()
        if (archive == null || archive.packageName != context.packageName || archive.versionName != release.name ||
            PackageInfoCompat.getLongVersionCode(archive) != release.code.toLong() ||
            release.code <= PackageInfoCompat.getLongVersionCode(installed) ||
            trusted.isEmpty() || archive.signers() != trusted
        ) throw StreamUpdateError("Версия или подпись APK не совпадает с установленным TChat Stream.")
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.signers() =
        (if (Build.VERSION.SDK_INT >= 28) signingInfo?.apkContentsSigners else signatures).orEmpty().toSet()

    private suspend fun matches(
        input: InputStream, output: OutputStream?, release: StreamRelease, progress: (Int) -> Unit,
    ): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        var lastPercent = -1
        while (true) {
            currentCoroutineContext().ensureActive()
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > release.bytes) return false
            digest.update(buffer, 0, count)
            output?.write(buffer, 0, count)
            val percent = (100 * total / release.bytes).toInt()
            if (percent != lastPercent) {
                lastPercent = percent
                progress(percent)
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        return total == release.bytes && hash == release.sha256
    }

    private companion object {
        val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS).followSslRedirects(false).build()
    }
}
