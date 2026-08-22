package com.tchat.screencast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.sources.audio.InternalAudioSource
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.video.NoVideoSource
import com.pedro.encoder.input.sources.video.ScreenSource
import com.pedro.library.generic.GenericStream
import com.pedro.library.util.BitrateAdapter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class CastState { IDLE, CONNECTING, LIVE, RETRYING, FAILED }

data class CastStatus(
    val state: CastState = CastState.IDLE,
    val bitrateKbps: Int = 0,
    val startedAt: Long = 0L,
    val error: String = "",
)

private const val TAG = "CaptureService"
private const val CHANNEL_ID = "screencast"
private const val NOTIFICATION_ID = 4201
private const val RETRIES = 10
private const val MAX_LONG_EDGE = 1920

/**
 * Захват экрана (MediaProjection) + звука приложения (InternalAudioSource, Android 10+)
 * и отдача по RTMP. Живёт как foreground-сервис, чтобы продолжать работу, когда
 * поверх открыта игра — Activity в этот момент обычно свёрнута.
 */
class CaptureService : Service(), ConnectChecker {

    companion object {
        const val ACTION_START = "com.tchat.screencast.START"
        const val ACTION_STOP = "com.tchat.screencast.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        const val EXTRA_RTMP_URL = "rtmpUrl"
        const val EXTRA_FPS = "fps"
        const val EXTRA_BITRATE = "bitrateKbps"
        const val EXTRA_INTERNAL_AUDIO = "internalAudio"

        private val _status = MutableStateFlow(CastStatus())
        val status: StateFlow<CastStatus> = _status.asStateFlow()
    }

    private lateinit var projectionManager: MediaProjectionManager
    private var mediaProjection: MediaProjection? = null
    private val micSource = MicrophoneSource()
    private var bitrateAdapter: BitrateAdapter? = null
    private var overlay: OverlayController? = null

    private val stream: GenericStream by lazy {
        GenericStream(this, this, NoVideoSource(), micSource).apply {
            getStreamClient().setReTries(RETRIES)
        }
    }

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            // Пользователь остановил захват из системной шторки — гасим эфир следом.
            stopCapture()
        }
    }

    override fun onCreate() {
        super.onCreate()
        projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopCapture()
            return START_NOT_STICKY
        }
        if (stream.isStreaming) {
            // Уже в эфире — повторный запуск игнорируем.
            return START_STICKY
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data = intent?.dataExtraCompat()
        if (resultCode == 0 || data == null) {
            Log.e(TAG, "нет разрешения на захват экрана")
            stopSelf()
            return START_NOT_STICKY
        }

        val rtmpUrl = intent.getStringExtra(EXTRA_RTMP_URL).orEmpty()
        val fps = intent.getIntExtra(EXTRA_FPS, 30)
        val bitrateKbps = intent.getIntExtra(EXTRA_BITRATE, DEFAULT_BITRATE_KBPS)
        val useInternalAudio = intent.getBooleanExtra(EXTRA_INTERNAL_AUDIO, true) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

        // На Android 14+ foreground-сервис с типом mediaProjection обязан быть
        // запущен ДО получения MediaProjection — иначе система бросает SecurityException.
        startForegroundCompat()

        val projection = projectionManager.getMediaProjection(resultCode, data)
        if (projection == null) {
            Log.e(TAG, "getMediaProjection вернул null")
            stopCapture()
            return START_NOT_STICKY
        }
        mediaProjection = projection
        projection.registerCallback(projectionCallback, null)

        val (width, height) = captureSize()
        val bitrateBps = bitrateKbps * 1000
        val videoOk = stream.prepareVideo(
            width = width,
            height = height,
            bitrate = bitrateBps,
            fps = fps,
            rotation = 0,
        )
        val audioOk = stream.prepareAudio(
            sampleRate = 44100,
            isStereo = true,
            bitrate = 128_000,
            echoCanceler = false,
            noiseSuppressor = false,
        )
        if (!videoOk || !audioOk) {
            Log.e(TAG, "prepare failed: video=$videoOk audio=$audioOk")
            _status.update { it.copy(state = CastState.FAILED, error = "Кодек не принял параметры захвата") }
            stopCapture()
            return START_NOT_STICKY
        }

        stream.changeVideoSource(ScreenSource(this, projection))
        if (useInternalAudio) {
            stream.changeAudioSource(InternalAudioSource(projection))
        }

        bitrateAdapter = BitrateAdapter { bps -> stream.setVideoBitrateOnFly(bps) }
            .apply { setMaxBitrate(bitrateBps) }
        _status.update { CastStatus(state = CastState.CONNECTING) }
        stream.startStream(rtmpUrl)

        overlay = OverlayController(this) { stopCapture() }.also { it.show() }

        return START_STICKY
    }

    /** Реальное разрешение экрана, пропорционально уменьшенное, если очень большое. */
    private fun captureSize(): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
        val longEdge = maxOf(metrics.widthPixels, metrics.heightPixels)
        val scale = if (longEdge > MAX_LONG_EDGE) MAX_LONG_EDGE.toFloat() / longEdge else 1f
        val w = (metrics.widthPixels * scale).toInt().let { it - it % 2 }
        val h = (metrics.heightPixels * scale).toInt().let { it - it % 2 }
        return w.coerceAtLeast(2) to h.coerceAtLeast(2)
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("TChat: трансляция экрана")
            .setContentText("Идёт захват экрана и звука")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .build()

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(CHANNEL_ID, "Трансляция экрана", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
    }

    private fun stopCapture() {
        runCatching { if (stream.isStreaming) stream.stopStream() }
        runCatching { stream.release() }
        runCatching { mediaProjection?.unregisterCallback(projectionCallback) }
        runCatching { mediaProjection?.stop() }
        mediaProjection = null
        overlay?.hide()
        overlay = null
        _status.update { CastStatus(state = CastState.IDLE) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- ConnectChecker ------------------------------------------------------

    override fun onConnectionStarted(url: String) {
        _status.update { it.copy(state = CastState.CONNECTING) }
    }

    override fun onConnectionSuccess() {
        _status.update { it.copy(state = CastState.LIVE, startedAt = System.currentTimeMillis(), error = "") }
        overlay?.markLive()
    }

    override fun onConnectionFailed(reason: String) {
        if (stream.getStreamClient().reTry(2500, reason, null)) {
            _status.update { it.copy(state = CastState.RETRYING, error = reason) }
        } else {
            _status.update { it.copy(state = CastState.FAILED, error = reason) }
            stopCapture()
        }
    }

    override fun onNewBitrate(bitrate: Long) {
        bitrateAdapter?.adaptBitrate(bitrate, stream.getStreamClient().hasCongestion())
        _status.update { it.copy(bitrateKbps = (bitrate / 1000).toInt()) }
    }

    override fun onDisconnect() {
        _status.update { it.copy(state = CastState.IDLE, bitrateKbps = 0, startedAt = 0L) }
    }

    override fun onAuthError() {
        _status.update { it.copy(state = CastState.FAILED, error = "Площадка не приняла ключ трансляции") }
    }

    override fun onAuthSuccess() = Unit
}

private fun Intent.dataExtraCompat(): Intent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(CaptureService.EXTRA_DATA, Intent::class.java)
    } else {
        @Suppress("DEPRECATION")
        getParcelableExtra(CaptureService.EXTRA_DATA)
    }
