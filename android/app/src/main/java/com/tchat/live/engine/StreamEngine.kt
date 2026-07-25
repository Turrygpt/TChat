package com.tchat.live.engine

import android.content.Context
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.gl.render.filters.BaseFilterRender
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.audio.MixAudioSource
import com.pedro.encoder.input.sources.video.Camera2Source
import com.pedro.encoder.input.sources.video.NoVideoSource
import com.pedro.encoder.input.sources.video.ScreenSource
import com.pedro.library.generic.GenericStream
import com.pedro.library.util.BitrateAdapter
import com.tchat.live.data.QualityPreset
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

private const val TAG = "StreamEngine"
private const val RETRY_ATTEMPTS = 8
private const val RETRY_DELAY_MS = 2000L

enum class StreamState { IDLE, CONNECTING, LIVE, RETRYING, FAILED }
enum class VideoMode { CAMERA, SCREEN }

data class StreamStats(
    val state: StreamState = StreamState.IDLE,
    val videoMode: VideoMode = VideoMode.CAMERA,
    val bitrateKbps: Int = 0,
    val startedAt: Long = 0L,
    val width: Int = 0,
    val height: Int = 0,
    val fps: Int = 0,
    val frontCamera: Boolean = false,
    val micMuted: Boolean = false,
    val lantern: Boolean = false,
    val error: String = "",
)

/**
 * Обёртка над RootEncoder GenericStream: один движок на приложение,
 * камера и экран меняются на лету, реконнект и адаптивный битрейт внутри.
 */
class StreamEngine(private val context: Context) : ConnectChecker {

    private val _stats = MutableStateFlow(StreamStats())
    val stats: StateFlow<StreamStats> = _stats.asStateFlow()

    private var bitrateAdapter: BitrateAdapter? = null
    private var maxBitrateBps = 2_500_000
    private var micSource = MicrophoneSource()

    // Стартуем без видеоисточника: камера включается только на экране эфира
    // (в режиме захвата экрана разрешение на камеру не нужно вовсе).
    val stream: GenericStream by lazy {
        GenericStream(context, this, NoVideoSource(), micSource).apply {
            getStreamClient().setReTries(RETRY_ATTEMPTS)
        }
    }

    val isStreaming: Boolean get() = stream.isStreaming
    val isOnPreview: Boolean get() = stream.isOnPreview

    /** Готовит энкодеры. Вызывать до превью и до эфира; при эфире — no-op. */
    fun prepare(quality: QualityPreset, portrait: Boolean): Boolean {
        if (stream.isStreaming) return true
        maxBitrateBps = quality.bitrateKbps * 1000
        val rotation = if (portrait) 90 else 0
        val videoOk = stream.prepareVideo(
            quality.width, quality.height, maxBitrateBps,
            fps = quality.fps, rotation = rotation,
        )
        val audioOk = stream.prepareAudio(44100, true, 128 * 1000)
        _stats.update { it.copy(width = quality.width, height = quality.height, fps = quality.fps) }
        if (!videoOk || !audioOk) {
            Log.e(TAG, "prepare failed: video=$videoOk audio=$audioOk")
        }
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
        _stats.update { it.copy(state = StreamState.CONNECTING, error = "") }
        stream.startStream(url)
    }

    fun stopStream() {
        if (stream.isStreaming) stream.stopStream()
        _stats.update { it.copy(state = StreamState.IDLE, bitrateKbps = 0, startedAt = 0L) }
    }

    // --- источники ---------------------------------------------------------

    fun switchCamera() {
        val source = stream.videoSource as? Camera2Source ?: return
        source.switchCamera()
        _stats.update { it.copy(frontCamera = !it.frontCamera) }
    }

    fun toggleLantern() {
        val source = stream.videoSource as? Camera2Source ?: return
        val next = !_stats.value.lantern
        runCatching { if (next) source.enableLantern() else source.disableLantern() }
        _stats.update { it.copy(lantern = next) }
    }

    fun setMicMuted(muted: Boolean) {
        val audio = stream.audioSource
        if (audio is MicrophoneSource) {
            if (muted) audio.mute() else audio.unMute()
        } else if (audio is MixAudioSource) {
            // У MixAudioSource нет отдельного мьюта микрофона — глушим его громкость,
            // звук игры продолжает идти в эфир.
            audio.microphoneVolume = if (muted) 0f else 1f
        }
        _stats.update { it.copy(micMuted = muted) }
    }

    /** Переключает эфир на захват экрана. Проекцию отдаёт ScreenCaptureService. */
    fun switchToScreen(projection: MediaProjection, mixInternalAudio: Boolean) {
        stream.changeVideoSource(ScreenSource(context, projection))
        if (mixInternalAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            stream.changeAudioSource(MixAudioSource(projection))
        }
        _stats.update { it.copy(videoMode = VideoMode.SCREEN) }
    }

    fun switchToCamera() {
        if (stream.videoSource !is Camera2Source) {
            stream.changeVideoSource(Camera2Source(context))
        }
        if (stream.audioSource !is MicrophoneSource) {
            micSource = MicrophoneSource()
            stream.changeAudioSource(micSource)
        }
        _stats.update { it.copy(videoMode = VideoMode.CAMERA, frontCamera = false, lantern = false) }
    }

    // --- фильтры (PiP всегда ниже оверлея, чтобы алерты были поверх) --------

    private var pipFilter: BaseFilterRender? = null
    private var overlayFilter: BaseFilterRender? = null

    fun setPipFilter(filter: BaseFilterRender?) {
        pipFilter = filter
        rebuildFilters()
    }

    fun setOverlayFilter(filter: BaseFilterRender?) {
        overlayFilter = filter
        rebuildFilters()
    }

    private fun rebuildFilters() {
        val gl = stream.getGlInterface()
        gl.clearFilters()
        pipFilter?.let { gl.addFilter(it) }
        overlayFilter?.let { gl.addFilter(it) }
    }

    fun release() {
        runCatching { if (stream.isStreaming) stream.stopStream() }
        runCatching { if (stream.isOnPreview) stream.stopPreview() }
        stream.release()
    }

    // --- ConnectChecker ----------------------------------------------------

    override fun onConnectionStarted(url: String) {
        _stats.update { it.copy(state = StreamState.CONNECTING) }
    }

    override fun onConnectionSuccess() {
        _stats.update { it.copy(state = StreamState.LIVE, startedAt = System.currentTimeMillis(), error = "") }
    }

    override fun onConnectionFailed(reason: String) {
        Log.w(TAG, "connection failed: $reason")
        if (stream.getStreamClient().reTry(RETRY_DELAY_MS, reason, null)) {
            _stats.update { it.copy(state = StreamState.RETRYING, error = reason) }
        } else {
            stream.stopStream()
            _stats.update { it.copy(state = StreamState.FAILED, error = humanizeError(reason), bitrateKbps = 0, startedAt = 0L) }
        }
    }

    override fun onNewBitrate(bitrate: Long) {
        bitrateAdapter?.adaptBitrate(bitrate, stream.getStreamClient().hasCongestion())
        _stats.update { it.copy(bitrateKbps = (bitrate / 1000).toInt()) }
    }

    override fun onDisconnect() {
        _stats.update { it.copy(state = StreamState.IDLE, bitrateKbps = 0, startedAt = 0L) }
    }

    override fun onAuthError() {
        _stats.update { it.copy(state = StreamState.FAILED, error = "Площадка не приняла ключ трансляции") }
    }

    override fun onAuthSuccess() = Unit

    private fun humanizeError(reason: String): String = when {
        reason.contains("refused", true) || reason.contains("ECONNREFUSED", true) ->
            "Площадка не отвечает. Проверьте RTMP-адрес и ключ трансляции."
        reason.contains("resolve", true) || reason.contains("UnknownHost", true) ->
            "Адрес не найден. Проверьте RTMP-адрес и интернет на телефоне."
        else -> reason
    }
}
