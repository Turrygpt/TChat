package com.tchat.stream

import android.content.Context
import android.content.pm.ActivityInfo
import android.hardware.camera2.CameraMetadata
import android.net.Uri
import android.util.Size

enum class Resolution(val label: String, val width: Int, val height: Int) {
    P720("720p", 1280, 720),
    P1080("1080p", 1920, 1080),
}

enum class StreamOrientation(val label: String, val activityValue: Int, val encoderRotation: Int) {
    LANDSCAPE("Горизонтально", ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, 0),
    PORTRAIT("Вертикально", ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, 90),
}

internal enum class AntiFlicker(val label: String, val cameraMode: Int) {
    AUTO("Авто", CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO),
    HZ50("50 Гц", CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_50HZ),
    HZ60("60 Гц", CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_60HZ),
}

const val MIN_BITRATE_KBPS = 3000
const val MAX_BITRATE_KBPS = 6000
const val DEFAULT_BITRATE_KBPS = 4500

internal data class StreamSettings(
    val rtmpUrl: String = "",
    val streamKey: String = "",
    val resolution: Resolution = Resolution.P720,
    val orientation: StreamOrientation = StreamOrientation.LANDSCAPE,
    val fps: Int = 30,
    val bitrateKbps: Int = DEFAULT_BITRATE_KBPS,
    val antiFlicker: AntiFlicker = AntiFlicker.AUTO,
    val rearCameraRotation: Int = 0,
    val frontCameraRotation: Int = 0,
    val economy: Boolean = true,
    val insetPosition: InsetPosition = InsetPosition(),

    val chatPlatform: ChatPlatform = ChatPlatform.VK,
    val vkChannel: String = "",
    val twitchChannel: String = "",
    val youtubeChannel: String = "",
    val chatEnabled: Boolean = true,
    val widgetsEnabled: Boolean = true,
    val chatFilters: ChatFilters = ChatFilters(),
    // Положение и размер окна чата в dp, прозрачность 0.2..1, масштаб шрифта.
    val chatX: Float = 24f,
    val chatY: Float = 56f,
    val chatW: Float = 260f,
    val chatH: Float = 190f,
    val chatFullHeight: Boolean = false,
    val chatFontScale: Float = 1f,
    val chatAlpha: Float = 0.9f,
) {
    val streamFps: Int get() = if (economy) minOf(fps, 30) else fps
    val chatAddress: String get() = when (chatPlatform) {
        ChatPlatform.VK -> vkChannel
        ChatPlatform.TWITCH -> twitchChannel
        ChatPlatform.YOUTUBE -> youtubeChannel
    }

    fun withChatAddress(address: String): StreamSettings = when (chatPlatform) {
        ChatPlatform.VK -> copy(vkChannel = address)
        ChatPlatform.TWITCH -> copy(twitchChannel = address)
        ChatPlatform.YOUTUBE -> copy(youtubeChannel = address)
    }

    val frameSize: Size
        get() = if (orientation == StreamOrientation.PORTRAIT) Size(resolution.height, resolution.width)
            else Size(resolution.width, resolution.height)

    /** Полный адрес: аккуратно склеиваем сервер и ключ. */
    val fullUrl: String
        get() {
            val base = rtmpUrl.trim()
            val key = streamKey.trim().trimStart('/')
            if (base.isEmpty() || key.isEmpty()) return base
            val address = base.substringBefore('?').trimEnd('/')
            val query = base.substringAfter('?', "")
            return buildString {
                append(address).append('/').append(key)
                if (query.isNotEmpty()) append(if ('?' in key) '&' else '?').append(query)
            }
        }

    fun hasRtmpAddress(): Boolean {
        val url = fullUrl
        return validRtmpUrl(url) && Uri.parse(url).pathSegments.size >= 2
    }

    fun hasRtmpServer(): Boolean = validRtmpUrl(rtmpUrl.trim())

    private fun validRtmpUrl(value: String): Boolean {
        if (value.any(Char::isWhitespace)) return false
        val uri = Uri.parse(value)
        return uri.scheme in listOf("rtmp", "rtmps") && !uri.host.isNullOrBlank()
    }
}

/** Простое хранилище настроек на SharedPreferences. */
internal class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("tchat_stream", Context.MODE_PRIVATE)

    init {
        val channel = vkChannelSlug(BuildConfig.PERSONAL_VK_CHANNEL)
        val url = BuildConfig.PERSONAL_RTMP_URL
        val key = BuildConfig.PERSONAL_STREAM_KEY
        if (channel != null && url.isNotBlank() && key.isNotBlank() && !prefs.getBoolean("personalProfileApplied", false)) {
            prefs.edit()
                .putString("rtmpUrl", url)
                .putString("streamKey", key)
                .putString("vkChannel", channel)
                .putBoolean("personalProfileApplied", true)
                .apply()
        }
    }

    fun load(): StreamSettings = StreamSettings(
        rtmpUrl = prefs.getString("rtmpUrl", "").orEmpty(),
        streamKey = prefs.getString("streamKey", "").orEmpty(),
        resolution = runCatching { Resolution.valueOf(prefs.getString("resolution", null) ?: Resolution.P720.name) }
            .getOrDefault(Resolution.P720),
        orientation = runCatching { StreamOrientation.valueOf(prefs.getString("orientation", "").orEmpty()) }
            .getOrDefault(StreamOrientation.LANDSCAPE),
        fps = prefs.getInt("fps", 30).takeIf { it == 30 || it == 60 } ?: 30,
        bitrateKbps = prefs.getInt("bitrateKbps", DEFAULT_BITRATE_KBPS)
            .coerceIn(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS),
        antiFlicker = runCatching { AntiFlicker.valueOf(prefs.getString("antiFlicker", "").orEmpty()) }
            .getOrDefault(AntiFlicker.AUTO),
        rearCameraRotation = prefs.getInt("rearCameraRotation", 0),
        frontCameraRotation = prefs.getInt("frontCameraRotation", 0),
        economy = prefs.getBoolean("economy", true),
        insetPosition = InsetPosition(
            prefs.getFloat("insetX", InsetPosition().x).coerceIn(0f, 1f),
            prefs.getFloat("insetY", InsetPosition().y).coerceIn(0f, 1f),
        ),
        chatPlatform = ChatPlatform.entries.firstOrNull { it.name == prefs.getString("chatPlatform", null) }
            ?: ChatPlatform.VK,
        vkChannel = prefs.getString("vkChannel", "").orEmpty(),
        twitchChannel = prefs.getString("twitchChannel", "").orEmpty(),
        youtubeChannel = prefs.getString("youtubeChannel", "").orEmpty(),
        chatEnabled = prefs.getBoolean("chatEnabled", true),
        widgetsEnabled = prefs.getBoolean("widgetsEnabled", true),
        chatFilters = ChatFilters(
            kinds = prefs.getStringSet("chatHiddenKinds", null).orEmpty().toSet(),
            authors = prefs.getStringSet("chatHiddenAuthors", null).orEmpty().toSet(),
            messages = prefs.getStringSet("chatHiddenMessages", null).orEmpty().toSet(),
        ),
        chatX = prefs.getFloat("chatX", 24f),
        chatY = prefs.getFloat("chatY", 56f),
        chatW = prefs.getFloat("chatW", 260f),
        chatH = prefs.getFloat("chatH", 190f),
        chatFullHeight = prefs.getBoolean("chatFullHeight", false),
        chatFontScale = prefs.getFloat("chatFontScale", 1f),
        chatAlpha = prefs.getFloat("chatAlpha", 0.9f),
    )

    fun save(s: StreamSettings) {
        prefs.edit()
            .putString("rtmpUrl", s.rtmpUrl.trim())
            .putString("streamKey", s.streamKey.trim())
            .putString("resolution", s.resolution.name)
            .putString("orientation", s.orientation.name)
            .putInt("fps", s.fps)
            .putInt("bitrateKbps", s.bitrateKbps)
            .putString("antiFlicker", s.antiFlicker.name)
            .putInt("rearCameraRotation", s.rearCameraRotation)
            .putInt("frontCameraRotation", s.frontCameraRotation)
            .putBoolean("economy", s.economy)
            .putFloat("insetX", s.insetPosition.x)
            .putFloat("insetY", s.insetPosition.y)
            .putString("chatPlatform", s.chatPlatform.name)
            .putString("vkChannel", s.vkChannel)
            .putString("twitchChannel", s.twitchChannel)
            .putString("youtubeChannel", s.youtubeChannel)
            .putBoolean("chatEnabled", s.chatEnabled)
            .putBoolean("widgetsEnabled", s.widgetsEnabled)
            .putStringSet("chatHiddenKinds", s.chatFilters.kinds)
            .putStringSet("chatHiddenAuthors", s.chatFilters.authors)
            .putStringSet("chatHiddenMessages", s.chatFilters.messages)
            .putFloat("chatX", s.chatX)
            .putFloat("chatY", s.chatY)
            .putFloat("chatW", s.chatW)
            .putFloat("chatH", s.chatH)
            .putBoolean("chatFullHeight", s.chatFullHeight)
            .putFloat("chatFontScale", s.chatFontScale)
            .putFloat("chatAlpha", s.chatAlpha)
            .apply()
    }
}
