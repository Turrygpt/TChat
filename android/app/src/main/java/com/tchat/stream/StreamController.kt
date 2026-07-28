package com.tchat.stream

import android.content.Context
import android.util.Log
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.video.Camera2Source
import com.pedro.library.generic.GenericStream
import com.pedro.library.util.BitrateAdapter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class LiveState { IDLE, CONNECTING, LIVE, RETRYING, FAILED }

data class StreamStatus(
    val state: LiveState = LiveState.IDLE,
    val bitrateKbps: Int = 0,
    val startedAt: Long = 0L,
    val micMuted: Boolean = false,
    val frontCamera: Boolean = false,
    val error: String = "",
)

private const val TAG = "StreamController"
private const val RETRIES = 10

/** Тонкая обёртка над RootEncoder GenericStream: камера → RTMP. */
class StreamController(context: Context) : ConnectChecker {

    private val _status = MutableStateFlow(StreamStatus())
    val status: StateFlow<StreamStatus> = _status.asStateFlow()

    private var maxBitrateBps = DEFAULT_BITRATE_KBPS * 1000
    private var bitrateAdapter: BitrateAdapter? = null
    private val micSource = MicrophoneSource()

    val stream: GenericStream by lazy {
        GenericStream(context, this, Camera2Source(context), micSource).apply {
            getStreamClient().setReTries(RETRIES)
        }
    }

    val isStreaming: Boolean get() = stream.isStreaming
    val isOnPreview: Boolean get() = stream.isOnPreview

    /** Готовит энкодеры под настройки. Горизонтально → rotation 0. */
    fun prepare(s: StreamSettings): Boolean {
        if (stream.isStreaming) return true
        maxBitrateBps = s.bitrateKbps * 1000
        val videoOk = stream.prepareVideo(s.resolution.width, s.resolution.height, maxBitrateBps, s.fps, 0)
        val audioOk = stream.prepareAudio(44100, true, 128 * 1000)
        if (!videoOk || !audioOk) Log.e(TAG, "prepare failed: video=$videoOk audio=$audioOk")
        return videoOk && audioOk
    }

    fun startPreview(view: SurfaceView) {
        if (!stream.isOnPreview) stream.startPreview(view)
    }

    fun stopPreview() {
        if (stream.isOnPreview) stream.stopPreview()
    }

    fun startStream(url: String) {
        if (stream.isStreaming) return
        bitrateAdapter = BitrateAdapter { bps -> stream.setVideoBitrateOnFly(bps) }
            .apply { setMaxBitrate(maxBitrateBps) }
        _status.update { it.copy(state = LiveState.CONNECTING, error = "") }
        stream.startStream(url)
    }

    fun stopStream() {
        if (stream.isStreaming) stream.stopStream()
        _status.update { it.copy(state = LiveState.IDLE, bitrateKbps = 0, startedAt = 0L) }
    }

    fun switchCamera() {
        (stream.videoSource as? Camera2Source)?.switchCamera()
        _status.update { it.copy(frontCamera = !it.frontCamera) }
    }

    fun setMicMuted(muted: Boolean) {
        if (muted) micSource.mute() else micSource.unMute()
        _status.update { it.copy(micMuted = muted) }
    }

    fun release() {
        runCatching { if (stream.isStreaming) stream.stopStream() }
        runCatching { if (stream.isOnPreview) stream.stopPreview() }
        runCatching { stream.release() }
    }

    // --- ConnectChecker ----------------------------------------------------

    override fun onConnectionStarted(url: String) {
        _status.update { it.copy(state = LiveState.CONNECTING) }
    }

    override fun onConnectionSuccess() {
        _status.update { it.copy(state = LiveState.LIVE, startedAt = System.currentTimeMillis(), error = "") }
    }

    override fun onConnectionFailed(reason: String) {
        if (stream.getStreamClient().reTry(2500, reason, null)) {
            _status.update { it.copy(state = LiveState.RETRYING, error = reason) }
        } else {
            stopStream()
            _status.update { it.copy(state = LiveState.FAILED, error = humanize(reason)) }
        }
    }

    override fun onNewBitrate(bitrate: Long) {
        bitrateAdapter?.adaptBitrate(bitrate, stream.getStreamClient().hasCongestion())
        _status.update { it.copy(bitrateKbps = (bitrate / 1000).toInt()) }
    }

    override fun onDisconnect() {
        _status.update { it.copy(state = LiveState.IDLE, bitrateKbps = 0, startedAt = 0L) }
    }

    override fun onAuthError() {
        _status.update { it.copy(state = LiveState.FAILED, error = "Площадка не приняла ключ трансляции") }
    }

    override fun onAuthSuccess() = Unit

    private fun humanize(reason: String): String = when {
        reason.contains("refused", true) || reason.contains("ECONNREFUSED", true) ->
            "Площадка не отвечает. Проверьте RTMP-адрес и ключ."
        reason.contains("resolve", true) || reason.contains("UnknownHost", true) ->
            "Адрес не найден. Проверьте RTMP-адрес и интернет."
        else -> reason
    }
}
