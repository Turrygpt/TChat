package com.tchat.stream

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.common.socket.base.SocketType
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.utils.CodecUtil.CodecType
import com.pedro.library.rtmp.RtmpStream
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal enum class LiveState { IDLE, CONNECTING, LIVE, RETRYING, WAITING_NETWORK, STOPPING, FAILED }

internal data class StreamStatus(
    val state: LiveState = LiveState.IDLE,
    val bitrateKbps: Int = 0,
    val startedAt: Long = 0L,
    val micMuted: Boolean = false,
    val cameraReady: Boolean = false,
    val frontCamera: Boolean = false,
    val pictureInPicture: Boolean = false,
    val insetLayout: CameraInsetFilter.Layout? = null,
    val cameraControls: CameraControls = CameraControls(),
    val cameraError: String = "",
    val widgetError: String = "",
    val error: String = "",
) {
    val isPublishing get() = when (state) {
        LiveState.CONNECTING, LiveState.LIVE, LiveState.RETRYING, LiveState.WAITING_NETWORK -> true
        else -> false
    }
}

private const val TAG = "TChatStream"
private const val FIRST_RETRY_MS = 1_000L
private const val MAX_RETRY_MS = 30_000L
private const val CONNECTION_TIMEOUT_MS = 20_000L
private const val NO_VIDEO_TIMEOUT_MS = 10_000L
private const val STABLE_CONNECTION_MS = 30_000L
private const val RECOVERY_START_BITRATE = 2_500_000
private const val MIN_RECOVERY_BITRATE = 1_000_000

/** Owns the preview, camera composition and RTMP session on the main thread. */
internal class StreamController(context: Context, private val donationProfile: DonationProfile) : ConnectChecker {
    private class Broadcast(val url: String, initialBitrate: Int, var network: Network?) {
        var networkCallback: ConnectivityManager.NetworkCallback? = null
        var nextDelay = FIRST_RETRY_MS
        var attemptAt = 0L
        var connectionStarted = false
        var liveAt = 0L
        var lastVideoAt = 0L
        var sentVideo = 0L
        var videoBitrate = initialBitrate
        var clearSamples = 0
    }

    private val _status = MutableStateFlow(StreamStatus())
    val status = _status.asStateFlow()

    private val handler = Handler(Looper.getMainLooper())
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val donationAudio = DonationAudio(context)
    private val micSource = MicrophoneSource().apply { setAudioEffect(donationAudio) }
    private val camera = StreamCameraSource(context, ::cameraReady, ::cameraFailed, ::layoutCameras)
    private val stream by lazy {
        RtmpStream(context, this, camera, micSource).apply {
            getStreamClient().apply {
                setReTries(Int.MAX_VALUE)
                setSocketType(SocketType.KTOR)
                // Ktor applies this timeout to reads too. An RTMP server can stay silent while it accepts video.
                // The watchdog limits the handshake and checks video progress independently.
                setSocketTimeout(Long.MAX_VALUE)
                shouldFailOnRead(true)
                setLogs(false)
            }
        }
    }
    private val gl get() = stream.getGlInterface()
    private val widgets by lazy {
        BroadcastWidgets(context, gl, donationProfile, donationAudio) { message -> _status.update { it.copy(widgetError = message) } }
    }
    private val vkAlerts by lazy { VkAlertOverlay(gl) }
    private var alertsEnabled = false
    private var donationConnected = false
    private var inset: CameraInsetFilter? = null
    private var insetPosition = InsetPosition()
    private var zoomFilter: CameraZoomFilter? = null
    private var frameSize = Size(Resolution.P720.width, Resolution.P720.height)
    private var maxBitrateBps = DEFAULT_BITRATE_KBPS * 1000
    private var hot = false
    private val bitrateCeiling get() = if (hot) minOf(maxBitrateBps, 3_000_000) else maxBitrateBps
    private var previewRendering = false
    private var broadcast: Broadcast? = null
    private var prepared = false
    private var pendingError = ""
    private var released = false
    private val reconnect = Runnable { connect() }
    private val stopTimeout = Runnable { if (_status.value.state == LiveState.STOPPING) showStopped() }
    private val watchdog = object : Runnable {
        override fun run() {
            val active = broadcast ?: return
            if (active.networkCallback == null) updateNetwork(active, connectivity.activeNetwork)
            val now = SystemClock.elapsedRealtime()
            if (active.liveAt != 0L) {
                val sent = stream.getStreamClient().getSentVideoFrames()
                if (sent != active.sentVideo) {
                    active.sentVideo = sent
                    active.lastVideoAt = now
                    if (now - active.liveAt >= STABLE_CONNECTION_MS) active.nextDelay = FIRST_RETRY_MS
                } else if (now - active.lastVideoAt >= NO_VIDEO_TIMEOUT_MS) {
                    scheduleRetry(active)
                }
            } else if (active.attemptAt != 0L && now - active.attemptAt >= CONNECTION_TIMEOUT_MS) {
                scheduleRetry(active)
            }
            if (broadcast === active) handler.postDelayed(this, 1_000L)
        }
    }

    val canSwitch get() = camera.canSwitch
    val canUseInset get() = camera.canUseInset

    fun startPreview(view: SurfaceView, settings: StreamSettings) {
        if (released || !view.holder.surface.isValid || stream.isStreaming) return
        closePreview()
        _status.update { it.copy(cameraError = "") }
        frameSize = settings.frameSize
        insetPosition = settings.insetPosition
        maxBitrateBps = settings.bitrateKbps * 1000
        prepared = runCatching {
            check(prepareVideo(settings))
            check(stream.prepareAudio(STREAM_SAMPLE_RATE, true, 128_000))
            stream.startPreview(view)
            previewRendering = true
        }.onFailure { Log.w(TAG, "Preview setup failed", it) }.isSuccess
        if (!prepared) {
            closePreview()
            _status.update { it.copy(cameraError = "Камера или кодек не поддерживают выбранный режим") }
        }
    }

    private fun prepareVideo(settings: StreamSettings): Boolean {
        fun prepare() = stream.prepareVideo(
            settings.resolution.width, settings.resolution.height, bitrateCeiling, settings.streamFps,
            rotation = settings.orientation.encoderRotation,
        )
        stream.forceCodecType(CodecType.HARDWARE, CodecType.FIRST_COMPATIBLE_FOUND)
        if (runCatching { prepare() }.getOrDefault(false)) return true
        stream.forceCodecType(CodecType.FIRST_COMPATIBLE_FOUND, CodecType.FIRST_COMPATIBLE_FOUND)
        return prepare()
    }

    fun setPreviewSize(width: Int, height: Int) = gl.setPreviewResolution(width, height)

    fun setPreviewRendering(view: SurfaceView, enabled: Boolean) {
        if (!stream.isOnPreview || previewRendering == enabled || !view.holder.surface.isValid) return
        if (enabled) {
            gl.attachPreview(view.holder.surface)
            gl.setPreviewResolution(view.width, view.height)
            showQueuedDonations()
        } else {
            gl.deAttachPreview()
        }
        previewRendering = enabled
    }

    fun applyCaptureBudget(settings: StreamSettings, thermal: ThermalLevel, publishing: Boolean) {
        hot = settings.economy && thermal == ThermalLevel.HOT
        val ceiling = when {
            !settings.economy -> settings.streamFps
            hot -> 20
            thermal == ThermalLevel.WARM || !publishing -> 24
            else -> settings.streamFps
        }
        val secondary = if (settings.economy) 15 else 30
        camera.setFpsLimits(ceiling, secondary)
        gl.forceFpsLimit(ceiling)
        broadcast?.let { applyBitrate(it, minOf(it.videoBitrate, bitrateCeiling)) }
        if (hot && inset != null) {
            removeInset()
            camera.setInset(null)
        }
    }

    fun closePreview() {
        if (released) return
        if (broadcast != null || stream.isStreaming) stopStream()
        widgets.hide(keepPending = true)
        removeInset()
        zoomFilter?.let { gl.removeFilter(it) }
        zoomFilter = null
        if (stream.isOnPreview) runCatching { stream.stopPreview() }
        previewRendering = false
    }

    fun startStream(url: String) {
        if (released || broadcast != null || stream.isStreaming || _status.value.state == LiveState.STOPPING) return
        if (!prepared || !_status.value.cameraReady) {
            _status.update { it.copy(error = "Камера ещё не готова", state = LiveState.FAILED) }
            return
        }
        widgets.hide(keepPending = true)
        _status.update { it.copy(error = "", widgetError = "") }
        val active = Broadcast(url, bitrateCeiling, connectivity.activeNetwork)
        broadcast = active
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = updateNetwork(active, network)
            override fun onLost(network: Network) {
                if (active.network == network) updateNetwork(active, null)
            }
        }
        runCatching { connectivity.registerDefaultNetworkCallback(callback, handler) }
            .onSuccess { active.networkCallback = callback }
        connect()
        if (broadcast === active) handler.postDelayed(watchdog, 1_000L)
    }

    private fun updateNetwork(active: Broadcast, network: Network?) {
        if (broadcast !== active || active.network == network) return
        active.network = network
        when {
            network == null -> scheduleRetry(active)
            active.attemptAt == 0L && active.liveAt == 0L -> {
                handler.removeCallbacks(reconnect)
                connect()
            }
        }
    }

    private fun connect() {
        val active = broadcast ?: return
        if (active.network == null) {
            scheduleRetry(active)
            return
        }
        active.attemptAt = SystemClock.elapsedRealtime()
        active.connectionStarted = false
        val retrying = stream.isStreaming
        _status.update { it.copy(state = if (retrying) LiveState.RETRYING else LiveState.CONNECTING, bitrateKbps = 0) }
        runCatching {
            if (retrying) {
                applyBitrate(active, minOf(active.videoBitrate, RECOVERY_START_BITRATE))
                // This restarts the RTMP transport while the camera and codecs keep running.
                check(stream.getStreamClient().reTry(0L, "Connection interrupted", null))
            } else {
                stream.startStream(active.url)
                stream.setVideoBitrateOnFly(active.videoBitrate)
            }
        }.onFailure {
            Log.w(TAG, "Could not start the stream transport")
            finishStream("Не удалось запустить эфир")
        }
    }

    private fun scheduleRetry(active: Broadcast) {
        handler.removeCallbacks(reconnect)
        if (active.liveAt != 0L) widgets.hide(keepPending = true)
        active.attemptAt = 0L
        active.connectionStarted = false
        active.liveAt = 0L
        active.clearSamples = 0
        if (active.network == null) {
            _status.update { it.copy(state = LiveState.WAITING_NETWORK, bitrateKbps = 0) }
            return
        }
        _status.update { it.copy(state = LiveState.RETRYING, bitrateKbps = 0) }
        handler.postDelayed(reconnect, active.nextDelay)
        active.nextDelay = minOf(active.nextDelay * 2, MAX_RETRY_MS)
    }

    fun stopStream() = finishStream("")

    private fun finishStream(error: String) {
        if (_status.value.state == LiveState.STOPPING) return
        val previous = broadcast
        broadcast = null
        handler.removeCallbacks(reconnect)
        handler.removeCallbacks(watchdog)
        previous?.networkCallback?.let { callback -> runCatching { connectivity.unregisterNetworkCallback(callback) } }
        widgets.hide(keepPending = true)
        vkAlerts.clear()
        pendingError = error
        if (stream.isStreaming) {
            _status.update { it.copy(state = LiveState.STOPPING, bitrateKbps = 0, startedAt = 0L, widgetError = "") }
            prepared = runCatching { stream.stopStream() }.getOrDefault(false)
            if (_status.value.state == LiveState.STOPPING) handler.postDelayed(stopTimeout, CONNECTION_TIMEOUT_MS)
        } else {
            showStopped()
        }
    }

    fun switchCamera() {
        if (!camera.isRunning()) return
        _status.update { it.copy(cameraError = "") }
        camera.switchCamera()
    }

    fun setCameraRotationOffsets(rear: Int, front: Int) = camera.setRotationOffsets(rear, front)

    fun setAntiFlicker(mode: AntiFlicker) = camera.setAntiFlicker(mode)

    fun focusAt(x: Float, y: Float) = camera.focusAt(x, y)

    fun resumeAutoFocus() = camera.resumeAutoFocus()

    fun zoomBy(factor: Float) {
        camera.setZoom(_status.value.cameraControls.zoom * factor)
        updateCameraControls()
    }

    fun toggleTorch() {
        camera.toggleTorch()
        updateCameraControls()
    }

    private fun updateCameraControls() {
        val scale = camera.compositionScale
        val filter = zoomFilter
        if (filter != null && !scale.needsCrop) {
            gl.removeFilter(filter)
            zoomFilter = null
        } else if (filter != null) {
            filter.scale = scale
        } else if (scale.needsCrop && stream.isOnPreview) {
            val layer = CameraZoomFilter().apply { this.scale = scale }
            zoomFilter = layer
            gl.addFilter(0, layer)
        }
        _status.update { it.copy(cameraControls = camera.controls) }
    }

    fun togglePictureInPicture() {
        if (!canUseInset || !_status.value.cameraReady || hot) return
        _status.update { it.copy(cameraError = "") }
        if (inset != null) {
            removeInset()
            camera.setInset(null)
            return
        }
        val layer = CameraInsetFilter { texture ->
            if (inset?.surfaceTexture === texture) camera.setInset(texture)
        }
        inset = layer
        gl.addFilter(if (zoomFilter == null) 0 else 1, layer)
        _status.update { it.copy(pictureInPicture = true) }
    }

    fun moveInset(position: InsetPosition) {
        val layer = inset ?: return
        val layout = layer.layout ?: return
        if (position == insetPosition) return
        insetPosition = position
        val moved = layout.copy(position = position)
        layer.layout = moved
        _status.update { it.copy(insetLayout = moved) }
    }

    private fun layoutCameras(mainRotation: Int, insetRotation: Int, insetAspect: Float?) {
        gl.setCameraOrientation(mainRotation)
        updateCameraControls()
        val layout = insetAspect?.let {
            val frameAspect = frameSize.width.toFloat() / frameSize.height
            val insetHeight = minOf(0.38f, 0.23f * frameAspect / it)
            val insetWidth = insetHeight * it / frameAspect
            CameraInsetFilter.Layout(insetRotation, insetWidth, insetHeight, insetPosition)
        }
        inset?.layout = layout
        _status.update { it.copy(insetLayout = layout) }
    }

    private fun cameraReady(ready: Boolean) {
        inset?.visible = ready
        _status.update { it.copy(cameraReady = ready, frontCamera = camera.isFront, cameraControls = camera.controls) }
        if (ready) {
            updateCameraControls()
            showQueuedDonations()
        }
    }

    private fun cameraFailed(dualCamera: Boolean) {
        if (dualCamera) {
            removeInset()
            _status.update { it.copy(cameraError = "Android не открыл две камеры одновременно") }
            camera.setInset(null)
        } else {
            _status.update { it.copy(cameraError = "Камера недоступна") }
            if (broadcast != null || stream.isStreaming) finishStream("Камера недоступна")
        }
    }

    private fun removeInset() {
        inset?.let {
            it.visible = false
            gl.removeFilter(it)
        }
        inset = null
        _status.update { it.copy(pictureInPicture = false, insetLayout = null) }
    }

    fun setAlerts(enabled: Boolean, donationConnected: Boolean) {
        alertsEnabled = enabled
        this.donationConnected = donationConnected
        if (!enabled) vkAlerts.clear()
        if (!enabled || !donationConnected) widgets.hide()
        _status.update { it.copy(widgetError = "") }
        if (enabled) showQueuedDonations()
    }

    fun showVkAlert(alert: VkAlert) {
        if (alertsEnabled && _status.value.isPublishing && stream.isStreaming) vkAlerts.enqueue(alert, frameSize)
    }

    fun showDonation(donation: Donation) {
        if (!alertsEnabled || !donationConnected || released) return
        widgets.enqueue(donation)
        showQueuedDonations()
    }

    private fun showQueuedDonations() {
        val status = _status.value
        if (!alertsEnabled || !donationConnected || !status.cameraReady || !stream.isOnPreview ||
            status.state in setOf(LiveState.CONNECTING, LiveState.RETRYING, LiveState.WAITING_NETWORK, LiveState.STOPPING)
        ) return
        widgets.show(frameSize, preview = status.state != LiveState.LIVE)
    }

    fun setMicMuted(muted: Boolean) {
        micSource.microphoneVolume = if (muted) 0f else 1f
        _status.update { it.copy(micMuted = muted) }
    }

    fun release() {
        if (released) return
        closePreview()
        released = true
        handler.removeCallbacks(stopTimeout)
        widgets.release()
        runCatching { stream.release() }
    }

    override fun onConnectionStarted(url: String) = onMain {
        val active = broadcast ?: return@onMain
        if (active.url == url && active.attemptAt != 0L) active.connectionStarted = true
    }

    override fun onConnectionSuccess() = onMain {
        val active = broadcast?.takeIf { it.connectionStarted && it.network != null } ?: return@onMain
        val now = SystemClock.elapsedRealtime()
        active.attemptAt = 0L
        active.liveAt = now
        active.lastVideoAt = now
        active.sentVideo = 0L
        active.clearSamples = 0
        _status.update {
            it.copy(state = LiveState.LIVE, startedAt = if (it.startedAt == 0L) System.currentTimeMillis() else it.startedAt)
        }
        handler.post {
            if (broadcast === active && active.liveAt == now) stream.requestKeyframe()
        }
        showQueuedDonations()
    }

    override fun onConnectionFailed(reason: String) = onMain {
        val active = broadcast?.takeIf { it.connectionStarted } ?: return@onMain
        when {
            reason.contains("Endpoint malformed", true) -> finishStream("Проверьте RTMP-адрес")
            reason.contains("NetConnection.Connect.Rejected", true) ->
                finishStream("Площадка отклонила подключение. Проверьте адрес и ключ")
            else -> scheduleRetry(active)
        }
    }

    override fun onNewBitrate(bitrate: Long) = onMain {
        val active = broadcast?.takeIf { it.liveAt != 0L } ?: return@onMain
        if (stream.getStreamClient().hasCongestion()) {
            active.clearSamples = 0
            applyBitrate(active, maxOf(MIN_RECOVERY_BITRATE, active.videoBitrate * 4 / 5))
        } else if (++active.clearSamples >= 8) {
            active.clearSamples = 0
            applyBitrate(active, minOf(bitrateCeiling, active.videoBitrate * 9 / 8))
        }
        _status.update { it.copy(bitrateKbps = (bitrate / 1000).toInt()) }
    }

    private fun applyBitrate(active: Broadcast, bitrate: Int) {
        val target = bitrate.coerceAtMost(bitrateCeiling)
        if (active.videoBitrate == target) return
        runCatching { stream.setVideoBitrateOnFly(target) }.onSuccess { active.videoBitrate = target }
    }

    override fun onDisconnect() = onMain {
        if (_status.value.state == LiveState.STOPPING) showStopped()
    }

    override fun onAuthError() = onMain {
        if (broadcast?.connectionStarted == true) finishStream("Площадка не приняла ключ трансляции")
    }

    override fun onAuthSuccess() = Unit

    private fun showStopped() {
        handler.removeCallbacks(stopTimeout)
        val error = pendingError
        val state = if (error.isEmpty()) LiveState.IDLE else LiveState.FAILED
        _status.update { it.copy(state = state, error = error, bitrateKbps = 0, startedAt = 0L) }
        showQueuedDonations()
    }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            if (!released) action()
        } else {
            handler.post { if (!released) action() }
        }
    }
}
