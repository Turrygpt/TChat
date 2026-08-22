package com.tchat.screencast

import android.content.Context

const val MIN_BITRATE_KBPS = 2500
const val MAX_BITRATE_KBPS = 8000
const val DEFAULT_BITRATE_KBPS = 5000

data class CastSettings(
    val rtmpUrl: String = "",
    val streamKey: String = "",
    val fps: Int = 30,
    val bitrateKbps: Int = DEFAULT_BITRATE_KBPS,
    // Выключено — пишем звук игры (Android 10+); включено — микрофон вместо него.
    val micEnabled: Boolean = false,
) {
    /** Полный адрес: аккуратно склеиваем сервер и ключ, как в приложении-камере. */
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
}

/** Простое хранилище настроек на SharedPreferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("tchat_screencast", Context.MODE_PRIVATE)

    fun load(): CastSettings = CastSettings(
        rtmpUrl = prefs.getString("rtmpUrl", "").orEmpty(),
        streamKey = prefs.getString("streamKey", "").orEmpty(),
        fps = prefs.getInt("fps", 30),
        bitrateKbps = prefs.getInt("bitrateKbps", DEFAULT_BITRATE_KBPS)
            .coerceIn(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS),
        micEnabled = prefs.getBoolean("micEnabled", false),
    )

    fun save(s: CastSettings) {
        prefs.edit()
            .putString("rtmpUrl", s.rtmpUrl.trim())
            .putString("streamKey", s.streamKey.trim())
            .putInt("fps", s.fps)
            .putInt("bitrateKbps", s.bitrateKbps)
            .putBoolean("micEnabled", s.micEnabled)
            .apply()
    }
}
