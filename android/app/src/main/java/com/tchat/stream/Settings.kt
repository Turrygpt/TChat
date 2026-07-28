package com.tchat.stream

import android.content.Context

/** Разрешение эфира. Всегда горизонтальное. */
enum class Resolution(val label: String, val width: Int, val height: Int) {
    P720("720p", 1280, 720),
    P1080("1080p", 1920, 1080),
}

const val MIN_BITRATE_KBPS = 3000
const val MAX_BITRATE_KBPS = 6000
const val DEFAULT_BITRATE_KBPS = 4500

data class StreamSettings(
    val rtmpUrl: String = "",
    val streamKey: String = "",
    val resolution: Resolution = Resolution.P1080,
    val fps: Int = 30,
    val bitrateKbps: Int = DEFAULT_BITRATE_KBPS,

    // --- чат с сервера TChat (окно на экране телефона) ---
    val serverUrl: String = "",
    val chatEnabled: Boolean = false,
    // Положение и размер окна чата в dp, прозрачность 0.2..1, масштаб шрифта.
    val chatX: Float = 24f,
    val chatY: Float = 72f,
    val chatW: Float = 300f,
    val chatH: Float = 360f,
    val chatFontScale: Float = 1.3f,
    val chatAlpha: Float = 0.9f,
) {
    /** Полный адрес: аккуратно склеиваем сервер и ключ. */
    val fullUrl: String
        get() {
            val base = rtmpUrl.trim().trimEnd('/')
            val key = streamKey.trim()
            return when {
                base.isEmpty() -> ""
                key.isEmpty() -> base
                else -> "$base/$key"
            }
        }

    /** Прозрачная страница чата с сервера (масштаб шрифта — параметром). */
    fun chatPageUrl(): String {
        val entered = serverUrl.trim().trimEnd('/')
        if (entered.isEmpty()) return ""

        val withScheme = if (
            entered.startsWith("http://", true) || entered.startsWith("https://", true)
        ) {
            entered
        } else {
            "http://$entered"
        }
        val base = withScheme.substringBefore('#').substringBefore('?').trimEnd('/')
        val chatPage = when {
            base.endsWith("/widgets/chat.html", true) -> base
            base.endsWith("/widget/chat.html", true) ->
                base.dropLast("/widget/chat.html".length) + "/widgets/chat.html"
            base.endsWith("/widget/chat", true) ->
                base.dropLast("/widget/chat".length) + "/widgets/chat.html"
            base.endsWith("/widgets", true) -> "$base/chat.html"
            else -> "$base/widgets/chat.html"
        }
        return "$chatPage?font=$chatFontScale&client=android"
    }
}

/** Простое хранилище настроек на SharedPreferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("tchat_stream", Context.MODE_PRIVATE)

    fun load(): StreamSettings = StreamSettings(
        rtmpUrl = prefs.getString("rtmpUrl", "").orEmpty(),
        streamKey = prefs.getString("streamKey", "").orEmpty(),
        resolution = runCatching { Resolution.valueOf(prefs.getString("resolution", null) ?: "P1080") }
            .getOrDefault(Resolution.P1080),
        fps = prefs.getInt("fps", 30),
        bitrateKbps = prefs.getInt("bitrateKbps", DEFAULT_BITRATE_KBPS)
            .coerceIn(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS),
        serverUrl = prefs.getString("serverUrl", "").orEmpty(),
        chatEnabled = prefs.getBoolean("chatEnabled", false),
        chatX = prefs.getFloat("chatX", 24f),
        chatY = prefs.getFloat("chatY", 72f),
        chatW = prefs.getFloat("chatW", 300f),
        chatH = prefs.getFloat("chatH", 360f),
        chatFontScale = prefs.getFloat("chatFontScale", 1.3f),
        chatAlpha = prefs.getFloat("chatAlpha", 0.9f),
    )

    fun save(s: StreamSettings) {
        prefs.edit()
            .putString("rtmpUrl", s.rtmpUrl.trim())
            .putString("streamKey", s.streamKey.trim())
            .putString("resolution", s.resolution.name)
            .putInt("fps", s.fps)
            .putInt("bitrateKbps", s.bitrateKbps)
            .putString("serverUrl", s.serverUrl.trim())
            .putBoolean("chatEnabled", s.chatEnabled)
            .putFloat("chatX", s.chatX)
            .putFloat("chatY", s.chatY)
            .putFloat("chatW", s.chatW)
            .putFloat("chatH", s.chatH)
            .putFloat("chatFontScale", s.chatFontScale)
            .putFloat("chatAlpha", s.chatAlpha)
            .apply()
    }
}
