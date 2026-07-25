package com.tchat.live.engine

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.view.Surface
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import com.pedro.encoder.input.gl.render.filters.`object`.ImageObjectFilterRender
import com.pedro.encoder.input.gl.render.filters.`object`.SurfaceFilterRender
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * «Прожигает» виджеты TChat (mobile-overlay.html: чат + алерты + цель + стикеры)
 * в исходящий поток.
 *
 * Основной путь: WebView живёт в Presentation на приватном VirtualDisplay, поверхность
 * которого — это SurfaceFilterRender в GL-пайплайне RootEncoder. GPU-путь, MP4-алерты работают.
 *
 * Запасной путь (useBitmapFallback): webView.draw() в Bitmap ~12 fps → ImageObjectFilterRender.
 * Софтверный canvas не рисует <video>, зато не зависит от капризов VirtualDisplay.
 */
class OverlayRenderer(
    private val context: Context,
    private val engine: StreamEngine,
    private val useBitmapFallback: Boolean = false,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var webView: WebView? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var displaySurface: Surface? = null
    private var drawJob: Job? = null
    private var width = 0
    private var height = 0

    var running = false
        private set

    /** Поднимает оверлей на разрешении потока и добавляет фильтр в движок. */
    fun start(url: String, streamWidth: Int, streamHeight: Int) {
        if (running) return
        running = true
        width = streamWidth
        height = streamHeight
        if (useBitmapFallback) startBitmapPath(url) else startVirtualDisplayPath(url)
    }

    private fun startVirtualDisplayPath(url: String) {
        val filter = SurfaceFilterRender { surfaceTexture ->
            // Мы на GL-потоке: поверхность готова, дальше всё на main.
            surfaceTexture.setDefaultBufferSize(width, height)
            val surface = Surface(surfaceTexture)
            displaySurface = surface
            scope.launch { attachPresentation(url, surface) }
        }
        filter.setScale(100f, 100f)
        engine.setOverlayFilter(filter)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachPresentation(url: String, surface: Surface) {
        if (!running) return
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val density = context.resources.displayMetrics.densityDpi
        val vd = dm.createVirtualDisplay(
            "tchat-overlay", width, height, density, surface,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY,
        )
        virtualDisplay = vd
        val pres = Presentation(context, vd.display).apply {
            // Прозрачное окно, чтобы в кадр попадали только сами виджеты.
            window?.setBackgroundDrawableResource(android.R.color.transparent)
            window?.setFormat(PixelFormat.TRANSLUCENT)
            setContentView(createWebView(url))
        }
        presentation = pres
        pres.show()
    }

    private fun startBitmapPath(url: String) {
        val filter = ImageObjectFilterRender()
        engine.setOverlayFilter(filter)
        val wv = createWebView(url)
        wv.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        wv.layout(0, 0, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawJob = scope.launch {
            while (running) {
                bitmap.eraseColor(Color.TRANSPARENT)
                wv.draw(canvas)
                filter.setImage(bitmap)
                filter.setScale(100f, 100f)
                filter.setPosition(0f, 0f)
                delay(83) // ~12 fps — достаточно для чата и алертов
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(url: String): WebView {
        val wv = WebView(context).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            loadUrl(url)
        }
        webView = wv
        return wv
    }

    fun stop() {
        if (!running) return
        running = false
        drawJob?.cancel()
        drawJob = null
        engine.setOverlayFilter(null)
        scope.launch {
            presentation?.dismiss()
            presentation = null
            webView?.destroy()
            webView = null
            virtualDisplay?.release()
            virtualDisplay = null
            displaySurface?.release()
            displaySurface = null
        }
    }

    fun release() {
        stop()
        scope.cancel()
    }
}
