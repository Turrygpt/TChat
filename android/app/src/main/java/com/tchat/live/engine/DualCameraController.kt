package com.tchat.live.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import androidx.core.content.ContextCompat
import com.pedro.encoder.input.gl.render.filters.`object`.SurfaceFilterRender

private const val TAG = "DualCamera"
private const val PIP_WIDTH = 640
private const val PIP_HEIGHT = 480

/**
 * Фронталка картинкой-в-картинке поверх основной (задней) камеры.
 * Работает только там, где Camera2 умеет два открытых устройства сразу
 * (getConcurrentCameraIds, Android 11+); иначе кнопка в UI просто скрыта.
 */
class DualCameraController(private val context: Context, private val engine: StreamEngine) {

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var surface: Surface? = null

    var running = false
        private set

    companion object {
        /** Есть ли пара {фронталка, задняя}, которую можно открыть одновременно. */
        fun isSupported(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
            return runCatching {
                val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                cm.concurrentCameraIds.any { set ->
                    val facings = set.mapNotNull { id ->
                        cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)
                    }
                    CameraCharacteristics.LENS_FACING_FRONT in facings &&
                        CameraCharacteristics.LENS_FACING_BACK in facings
                }
            }.getOrDefault(false)
        }
    }

    fun start() {
        if (running || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val frontId = cm.cameraIdList.firstOrNull { id ->
            cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
        } ?: return

        running = true
        thread = HandlerThread("tchat-pip").also { it.start() }
        handler = Handler(thread!!.looper)

        val filter = SurfaceFilterRender { surfaceTexture ->
            surfaceTexture.setDefaultBufferSize(PIP_WIDTH, PIP_HEIGHT)
            val s = Surface(surfaceTexture)
            surface = s
            openFront(cm, frontId, s)
        }
        // Маленькое окно в правом верхнем углу; алерты рисуются поверх (порядок фильтров в движке).
        filter.setScale(28f, 28f)
        filter.setPosition(70f, 4f)
        engine.setPipFilter(filter)
    }

    private fun openFront(cm: CameraManager, id: String, target: Surface) {
        try {
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    if (!running) { camera.close(); return }
                    device = camera
                    val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                        addTarget(target)
                    }
                    @Suppress("DEPRECATION")
                    camera.createCaptureSession(listOf(target), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            if (!running) { s.close(); return }
                            session = s
                            s.setRepeatingRequest(request.build(), null, handler)
                        }
                        override fun onConfigureFailed(s: CameraCaptureSession) {
                            Log.e(TAG, "PiP session configure failed")
                            stop()
                        }
                    }, handler)
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close(); if (running) stop() }
                override fun onError(camera: CameraDevice, error: Int) {
                    Log.e(TAG, "PiP camera error $error")
                    camera.close()
                    if (running) stop()
                }
            }, handler)
        } catch (e: Exception) {
            Log.e(TAG, "PiP open failed", e)
            stop()
        }
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { session?.close() }
        session = null
        runCatching { device?.close() }
        device = null
        surface?.release()
        surface = null
        thread?.quitSafely()
        thread = null
        handler = null
        engine.setPipFilter(null)
    }
}
