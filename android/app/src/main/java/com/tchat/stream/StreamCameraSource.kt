package com.tchat.stream

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.MeteringRectangle
import android.hardware.camera2.params.OutputConfiguration
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.Surface
import com.pedro.encoder.input.sources.OrientationConfig
import com.pedro.encoder.input.sources.video.VideoSource
import com.pedro.encoder.input.video.CameraHelper
import kotlin.math.abs
import kotlin.math.roundToInt

private const val MAX_CAMERA_ZOOM = 10f
private const val MIN_CAMERA_ZOOM = 0.5f

internal data class CameraControls(
    val zoom: Float = 1f,
    val torchAvailable: Boolean = false,
    val torchEnabled: Boolean = false,
)

/** A camera change replaces the capture sessions while keeping the encoder and RTMP connection. */
internal class StreamCameraSource(
    private val context: Context,
    private val onReady: (Boolean) -> Unit,
    private val onError: (dualCamera: Boolean) -> Unit,
    private val onLayout: (mainRotation: Int, insetRotation: Int, insetAspect: Float?) -> Unit,
) : VideoSource() {
    private class Camera(
        val id: String,
        val characteristics: CameraCharacteristics,
        val physicalId: String? = null,
    ) {
        val front = characteristics.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
        val rear = characteristics.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val antiFlickerModes = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES)
        val hasTorch = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        val zoomRange = if (physicalId == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            characteristics.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
        } else null
        val sensorArea = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val minimumZoom = zoomRange?.lower?.coerceIn(MIN_CAMERA_ZOOM, 1f) ?: 1f
        val maximumHardwareZoom = if (physicalId != null) 1f else {
            zoomRange?.upper
                ?: sensorArea?.let { characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) }
                ?: 1f
        }
        val focusModes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
        val defaultFocusMode = listOf(
            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO,
            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
            CaptureRequest.CONTROL_AF_MODE_AUTO,
        ).firstOrNull { focusModes?.contains(it) == true }
        val canTapFocus = physicalId == null && sensorArea != null &&
            (characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0) > 0 &&
            focusModes?.contains(CaptureRequest.CONTROL_AF_MODE_AUTO) == true
        val opticalScale: Float? get() {
            val focalLength = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                ?.firstOrNull()?.takeIf { it > 0f } ?: return null
            val sensor = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return null
            return (focalLength / maxOf(sensor.width, sensor.height)).takeIf { it.isFinite() }
        }
    }

    private data class WideLens(val camera: Camera, val relativeZoom: Float)

    private class Input(val camera: Camera, val surface: Surface, val size: Size, val lensZoom: Float) {
        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        val maximumZoom get() = camera.maximumHardwareZoom * lensZoom
    }

    private val manager = context.getSystemService(CameraManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val cameras = runCatching {
        manager.cameraIdList.mapNotNull { id ->
            runCatching { Camera(id, manager.getCameraCharacteristics(id)) }.getOrNull()
        }
    }.getOrDefault(emptyList())
    private val back = cameras.filter { it.rear }.minByOrNull { it.minimumZoom }
    private val front = cameras.filter { it.front }.minByOrNull { it.minimumZoom }
    private val concurrentIds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        runCatching { manager.concurrentCameraIds }.getOrDefault(emptySet())
    } else emptySet()
    private val rejectedPairs = mutableSetOf<Set<Camera>>()
    private var smallerPair = false

    private var inputs: List<Input> = emptyList()
    private var insetTexture: SurfaceTexture? = null
    private var selected = back ?: front ?: cameras.firstOrNull()
    private var wideLenses = findWideLenses()
    private var wideSelected = false
    private var antiFlicker = AntiFlicker.AUTO
    private var zoom = 1f
    private var torchEnabled = false
    private var rearRotation = 0
    private var frontRotation = 0
    private var mainRotation = 0
    private var frameCrop = CameraScale()
    private var focusPoint: PointF? = null
    private var primaryFpsLimit = Int.MAX_VALUE
    private var secondaryFpsLimit = 30
    val canSwitch get() = back != null && front != null
    val canUseInset: Boolean
        get() {
            val primary = currentWideLens()?.camera ?: selected ?: return false
            val secondary = matchingInsetCamera(primary) ?: return false
            return setOf(primary, secondary) !in rejectedPairs
        }
    val isFront get() = selected?.front == true
    private val primaryCamera get() = inputs.firstOrNull()?.camera ?: selected
    val controls get() = CameraControls(
        zoom = zoom,
        torchAvailable = primaryCamera?.hasTorch == true,
        torchEnabled = torchEnabled,
    )
    val compositionScale get() = inputs.firstOrNull()?.let { cropAtZoom(it, zoom) } ?: CameraScale()

    private fun cropAtZoom(input: Input, zoom: Float): CameraScale {
        val digitalZoom = (zoom / input.maximumZoom).coerceAtLeast(1f)
        return CameraScale(frameCrop.x * digitalZoom, frameCrop.y * digitalZoom)
    }

    private fun isAdvertisedPair(primary: Camera, secondary: Camera) =
        concurrentIds.any { primary.id in it && secondary.id in it }

    private fun matchingInsetCamera(primary: Camera): Camera? {
        val preferred = when {
            primary.front -> back
            primary.rear -> front
            else -> null
        } ?: return null
        if (isAdvertisedPair(primary, preferred)) return preferred
        return cameras.firstOrNull { candidate ->
            (if (primary.front) candidate.rear else candidate.front) && isAdvertisedPair(primary, candidate)
        } ?: preferred
    }

    private fun findWideLenses(): List<WideLens> {
        val main = back?.takeIf { it.minimumZoom > MIN_CAMERA_ZOOM } ?: return emptyList()
        val normalScale = main.opticalScale?.takeIf { it > 0f } ?: return emptyList()
        val physical = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            main.characteristics.physicalCameraIds.mapNotNull { id ->
                runCatching { Camera(main.id, manager.getCameraCharacteristics(id), physicalId = id) }.getOrNull()
            }
        } else emptyList()
        return (cameras.filter { it.rear && it.id != main.id } + physical).mapNotNull { candidate ->
            val ratio = candidate.opticalScale?.div(normalScale) ?: return@mapNotNull null
            if (ratio > 0f && ratio <= 0.85f && ratio < main.minimumZoom) WideLens(candidate, ratio) else null
        }.sortedBy { it.relativeZoom }
    }

    private fun availableWideLens() = wideLenses.firstOrNull().takeIf { selected === back }

    private fun currentWideLens() = availableWideLens()?.takeIf { zoom < (back?.minimumZoom ?: 1f) }

    override fun create(width: Int, height: Int, fps: Int, rotation: Int): Boolean = selected != null
    override fun getOrientationConfig() = OrientationConfig(cameraOrientation = 0, isPortrait = rotation % 180 != 0)
    override fun isRunning(): Boolean = surfaceTexture != null

    override fun start(surfaceTexture: SurfaceTexture) {
        this.surfaceTexture = surfaceTexture
        openInputs()
    }

    override fun stop() {
        surfaceTexture = null
        insetTexture = null
        zoom = 1f
        focusPoint = null
        torchEnabled = false
        closeInputs()
        onReady(false)
    }

    override fun release() = stop()

    fun switchCamera() {
        if (!canSwitch) return
        selected = if (isFront) back else front
        zoom = 1f
        torchEnabled = false
        openInputs()
    }

    fun setInset(texture: SurfaceTexture?) {
        if (insetTexture === texture) return
        insetTexture = texture
        smallerPair = false
        openInputs(keepFocus = true)
    }

    fun setRotationOffsets(rear: Int, front: Int) {
        rearRotation = rear
        frontRotation = front
        updateLayout()
    }

    fun setAntiFlicker(mode: AntiFlicker) {
        if (antiFlicker == mode) return
        antiFlicker = mode
        updateActiveCaptures()
    }

    fun setFpsLimits(primary: Int, secondary: Int) {
        if (primaryFpsLimit == primary && secondaryFpsLimit == secondary) return
        primaryFpsLimit = primary
        secondaryFpsLimit = secondary
        updateActiveCaptures()
    }

    private fun updateActiveCaptures() {
        inputs.forEach { input ->
            val session = input.session ?: return@forEach
            updateCapture(input, session)
        }
    }

    fun focusAt(x: Float, y: Float): Boolean {
        val input = inputs.firstOrNull()?.takeIf { it.camera.canTapFocus } ?: return false
        val session = input.session ?: return false
        if (surfaceTexture?.timestamp == 0L) return false
        val before = focusPoint
        focusPoint = PointF(x, y)
        if (updateCapture(input, session, resetFocus = true)) return true
        focusPoint = before
        updateCapture(input, session)
        return false
    }

    fun resumeAutoFocus(): Boolean {
        val input = inputs.firstOrNull()?.takeIf { it.camera.canTapFocus } ?: return false
        val session = input.session ?: return false
        val before = focusPoint
        focusPoint = null
        if (before == null && input.camera.defaultFocusMode != CaptureRequest.CONTROL_AF_MODE_AUTO) return true
        if (updateCapture(input, session, resetFocus = true)) return true
        focusPoint = before
        return false
    }

    fun setZoom(value: Float) {
        val input = inputs.firstOrNull() ?: return
        val wide = availableWideLens()
        val minimum = wide?.let { maxOf(MIN_CAMERA_ZOOM, it.relativeZoom) } ?: input.camera.minimumZoom
        val target = value.coerceIn(minimum, MAX_CAMERA_ZOOM)
        if (target == zoom) return
        val wantsWide = wide != null && target < (back?.minimumZoom ?: 1f)
        val session = input.session
        if (wantsWide != wideSelected) {
            if (session != null) {
                zoom = target
                openInputs()
            }
            return
        }
        if (session == null) {
            zoom = target
            return
        }
        val hardwareLimit = input.maximumZoom
        if (minOf(target, hardwareLimit) == minOf(zoom, hardwareLimit) ||
            updateCapture(input, session, zoom = target)
        ) {
            zoom = target
        }
    }

    fun toggleTorch() {
        val input = inputs.firstOrNull()?.takeIf { it.camera.hasTorch } ?: return
        val session = input.session ?: return
        val enabled = !torchEnabled
        if (updateCapture(input, session, torch = enabled)) torchEnabled = enabled
    }

    private fun openInputs(keepFocus: Boolean = false) {
        closeInputs()
        if (!keepFocus) focusPoint = null
        val texture = surfaceTexture ?: return
        val single = selected ?: return
        val inset = insetTexture
        val wide = currentWideLens()
        val primary = wide?.camera ?: single
        val secondary = if (inset == null) null else matchingInsetCamera(primary)
        wideSelected = wide != null
        onReady(false)

        if (inset != null && (secondary == null || setOf(primary, secondary) in rejectedPairs)) {
            onError(true)
            return
        }

        try {
            val lensZoom = wide?.relativeZoom ?: 1f
            zoom = zoom.coerceAtLeast(maxOf(MIN_CAMERA_ZOOM, lensZoom * primary.minimumZoom))
            if (!primary.hasTorch) torchEnabled = false
            val mainSize = if (secondary != null && smallerPair) smallerPrimarySize(primary, secondary)
                else captureSize(primary, Size(width, height))
            inputs = listOf(makeInput(primary, texture, mainSize, lensZoom))
            if (secondary != null && inset != null) {
                inputs = inputs + makeInput(secondary, inset, captureSize(secondary, Size(640, 480)))
            }
            updateLayout()
            inputs.forEach(::open)
        } catch (error: Exception) {
            fail(error)
        }
    }

    private fun smallerPrimarySize(primary: Camera, secondary: Camera): Size {
        // Advertised pairs support larger capture surfaces. Both branches prefer the encoder aspect.
        val limit = if (isAdvertisedPair(primary, secondary)) Size(1280, 720) else Size(640, 480)
        return captureSize(primary, limit, width.toFloat() / height)
    }

    private fun captureSize(camera: Camera, desired: Size, ratio: Float = desired.width.toFloat() / desired.height): Size {
        val sizes = camera.characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(SurfaceTexture::class.java).orEmpty()
        val available = sizes.filter { it.width <= desired.width && it.height <= desired.height }
        return available.minWithOrNull(compareBy<Size>({ abs(it.width.toFloat() / it.height - ratio) }, { -it.width }))
            ?: sizes.minByOrNull { it.width * it.height }
            ?: error("Camera has no preview sizes")
    }

    private fun updateLayout() {
        val primary = inputs.firstOrNull() ?: return
        val inset = inputs.getOrNull(1)
        // The Camera2 SurfaceTexture already transforms the sensor into the device's natural
        // orientation. Apply the display rotation just as RootEncoder does for Camera2Source.
        val displayCorrection = (CameraHelper.getCameraOrientation(context) + 270) % 360
        fun rotation(camera: Camera): Int =
            (displayCorrection + if (camera.front) frontRotation else rearRotation) % 360

        val insetRotation = inset?.camera?.let(::rotation) ?: 0
        val insetAspect = inset?.displayAspect(insetRotation)
        mainRotation = rotation(primary.camera)
        val sourceAspect = primary.displayAspect(mainRotation)
        val frameAspect = if (this.rotation % 180 == 0) width.toFloat() / height else height.toFloat() / width
        frameCrop = CameraScale(
            (sourceAspect / frameAspect).coerceAtLeast(1f),
            (frameAspect / sourceAspect).coerceAtLeast(1f),
        )
        onLayout(mainRotation, insetRotation, insetAspect)
    }

    private fun Input.displayAspect(rotation: Int) = if ((camera.sensorOrientation + rotation) % 180 == 0) {
        size.width.toFloat() / size.height
    } else size.height.toFloat() / size.width

    private fun makeInput(camera: Camera, texture: SurfaceTexture, size: Size, lensZoom: Float = 1f): Input {
        texture.setDefaultBufferSize(size.width, size.height)
        return Input(camera, Surface(texture), size, lensZoom)
    }

    @SuppressLint("MissingPermission")
    private fun open(input: Input) {
        manager.openCamera(input.camera.id, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                if (input !in inputs) {
                    camera.close()
                    return
                }
                input.device = camera
                // Configure both sessions only after both devices have been opened.
                if (inputs.all { it.device != null }) {
                    runCatching { inputs.forEach(::configure) }.onFailure(::fail)
                }
            }

            override fun onDisconnected(camera: CameraDevice) = onError(camera, CameraDevice.StateCallback.ERROR_CAMERA_DEVICE)

            override fun onError(camera: CameraDevice, error: Int) {
                camera.close()
                if (input in inputs) fail(IllegalStateException("Camera ${input.camera.id} error $error"))
            }
        }, handler)
    }

    private fun updateCapture(
        input: Input,
        session: CameraCaptureSession,
        zoom: Float = this.zoom,
        torch: Boolean = torchEnabled,
        resetFocus: Boolean = false,
    ): Boolean = runCatching { repeatCapture(input, session, zoom, torch, resetFocus) }.onFailure {
        Log.w("TChatCamera", "Could not update camera capture settings", it)
    }.isSuccess

    private fun repeatCapture(
        input: Input,
        session: CameraCaptureSession,
        zoom: Float = this.zoom,
        torch: Boolean = torchEnabled,
        resetFocus: Boolean = false,
    ) {
        val camera = checkNotNull(input.device)
        val characteristics = input.camera.characteristics
        val primary = input === inputs.firstOrNull()
        val hardwareZoom = if (primary) minOf(zoom / input.lensZoom, input.camera.maximumHardwareZoom) else 1f
        val targetFps = if (primary) minOf(fps, primaryFpsLimit) else minOf(fps, secondaryFpsLimit)
        val range = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            ?.minWithOrNull(compareBy({ it.upper > targetFps }, { abs(it.upper - targetFps) }, { abs(it.lower - targetFps) }))
        val cameraMode = antiFlicker.cameraMode
        val region = focusPoint?.takeIf { primary && input.camera.canTapFocus }?.let { focusRegion(input, it, zoom, hardwareZoom) }
        val focusMode = if (region == null) input.camera.defaultFocusMode else CaptureRequest.CONTROL_AF_MODE_AUTO
        val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
            addTarget(input.surface)
            range?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
            if (input.camera.antiFlickerModes?.contains(cameraMode) == true) {
                set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, cameraMode)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && input.camera.zoomRange != null) {
                set(CaptureRequest.CONTROL_ZOOM_RATIO, hardwareZoom)
            } else if (hardwareZoom > 1f) {
                input.camera.sensorArea?.let { set(CaptureRequest.SCALER_CROP_REGION, it.centerCrop(hardwareZoom)) }
            }
            focusMode?.let { set(CaptureRequest.CONTROL_AF_MODE, it) }
            if (input.camera.canTapFocus) {
                val metering = region ?: MeteringRectangle(checkNotNull(input.camera.sensorArea), 0)
                set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(metering))
            }
            if (input.camera.hasTorch) {
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.FLASH_MODE, if (primary && torch) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_ROTATE_AND_CROP_MODES)
                    ?.contains(CaptureRequest.SCALER_ROTATE_AND_CROP_NONE) == true
            ) {
                set(CaptureRequest.SCALER_ROTATE_AND_CROP, CaptureRequest.SCALER_ROTATE_AND_CROP_NONE)
            }
        }
        if (resetFocus) {
            request.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_CANCEL)
            session.capture(request.build(), null, handler)
            request.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE)
        }
        session.setRepeatingRequest(request.build(), null, handler)
        if (resetFocus && focusMode == CaptureRequest.CONTROL_AF_MODE_AUTO) {
            request.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
            session.capture(request.build(), null, handler)
        }
    }

    private fun focusRegion(input: Input, point: PointF, zoom: Float, hardwareZoom: Float): MeteringRectangle {
        // Undo the preview crop and GL rotation before mapping through Camera2's buffer transform.
        val scale = cropAtZoom(input, zoom)
        val x = (point.x - 0.5f) / scale.x
        val y = (0.5f - point.y) / scale.y
        val (u, v) = when ((mainRotation + 360) % 360) {
            90 -> 0.5f - y to 0.5f + x
            180 -> 0.5f - x to 0.5f - y
            270 -> 0.5f + y to 0.5f - x
            else -> 0.5f + x to 0.5f + y
        }
        val transform = FloatArray(16)
        checkNotNull(surfaceTexture).getTransformMatrix(transform)
        val bufferX = (transform[0] * u + transform[4] * v + transform[12]).coerceIn(0f, 1f)
        val bufferY = (transform[1] * u + transform[5] * v + transform[13]).coerceIn(0f, 1f)
        val sensor = checkNotNull(input.camera.sensorArea)
        val crop = if (input.camera.zoomRange == null && hardwareZoom > 1f) sensor.centerCrop(hardwareZoom) else sensor
        val output = crop.fitAspect(input.size.width.toFloat() / input.size.height)
        val span = (minOf(output.width(), output.height()) * 0.12f).roundToInt().coerceAtLeast(1)
        val left = (output.left + output.width() * bufferX - span / 2f).roundToInt().coerceIn(output.left, output.right - span)
        val top = (output.top + output.height() * bufferY - span / 2f).roundToInt().coerceIn(output.top, output.bottom - span)
        return MeteringRectangle(left, top, span, span, MeteringRectangle.METERING_WEIGHT_MAX)
    }

    @Suppress("DEPRECATION")
    private fun configure(input: Input) {
        val camera = checkNotNull(input.device)
        val callback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) {
                if (input !in inputs) {
                    session.close()
                    return
                }
                runCatching {
                    repeatCapture(input, session, resetFocus = input === inputs.firstOrNull() && focusPoint != null)
                    input.session = session
                    if (inputs.all { it.session != null }) onReady(true)
                }.onFailure {
                    session.close()
                    fail(it)
                }
            }

            override fun onConfigureFailed(session: CameraCaptureSession) {
                session.close()
                if (input in inputs) fail(IllegalStateException("Capture configuration failed"))
            }
        }
        val physicalId = input.camera.physicalId
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && physicalId != null) {
            val output = OutputConfiguration(input.surface).apply { setPhysicalCameraId(physicalId) }
            camera.createCaptureSessionByOutputConfigurations(listOf(output), callback, handler)
        } else {
            camera.createCaptureSession(listOf(input.surface), callback, handler)
        }
    }

    private fun fail(error: Throwable) {
        Log.w("TChatCamera", "Camera capture failed", error)
        if (insetTexture != null) {
            val primary = inputs.firstOrNull()
            val secondary = primary?.let { matchingInsetCamera(it.camera) }
            if (primary != null && secondary != null) {
                val smaller = runCatching { smallerPrimarySize(primary.camera, secondary) }.getOrNull()
                if (!smallerPair && smaller != null && smaller != primary.size) {
                    smallerPair = true
                    openInputs(keepFocus = true)
                    return
                }
                rejectedPairs.add(setOf(primary.camera, secondary))
            }
            closeInputs()
            onReady(false)
            onError(true)
            return
        }
        closeInputs()
        if (wideSelected) {
            wideLenses = wideLenses.drop(1)
            if (wideLenses.isEmpty()) zoom = 1f
            openInputs()
            return
        }
        onReady(false)
        onError(false)
    }

    private fun closeInputs() {
        val old = inputs
        inputs = emptyList()
        old.forEach { input ->
            input.session?.close()
            input.device?.close()
            input.surface.release()
        }
    }
}

private fun Rect.fitAspect(aspect: Float): Rect {
    val croppedWidth = minOf(width(), (height() * aspect).roundToInt()).coerceAtLeast(1)
    val croppedHeight = minOf(height(), (width() / aspect).roundToInt()).coerceAtLeast(1)
    val x = left + (width() - croppedWidth) / 2
    val y = top + (height() - croppedHeight) / 2
    return Rect(x, y, x + croppedWidth, y + croppedHeight)
}

private fun Rect.centerCrop(zoom: Float): Rect {
    val cropWidth = (width() / zoom).roundToInt().coerceIn(1, width())
    val cropHeight = (height() / zoom).roundToInt().coerceIn(1, height())
    val x = left + (width() - cropWidth) / 2
    val y = top + (height() - cropHeight) / 2
    return Rect(x, y, x + cropWidth, y + cropHeight)
}
