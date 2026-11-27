package com.tchat.stream

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.ColorDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.Window
import android.view.WindowManager.LayoutParams
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.pedro.encoder.input.gl.render.filters.`object`.SurfaceFilterRender
import com.pedro.library.view.GlStreamInterface
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

private const val WIDGET_HOST = "appassets.androidplatform.net"
private const val DONATION_WIDGET_URL = "https://appassets.androidplatform.net/alerts/index.html"

/** Renders the TChat alert card on a transparent surface in the encoded frame. */
internal class BroadcastWidgets(
    private val context: Context,
    private val gl: GlStreamInterface,
    private val profile: DonationProfile,
    private val audio: DonationAudio,
    private val onStatus: (String) -> Unit,
) {
    private data class Target(val size: Size, val preview: Boolean)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pending = ArrayDeque<Donation>()
    private var target: Target? = null
    private var playback: Job? = null
    private var loadTimeout: Job? = null
    private var retry: Job? = null
    private var failures = 0
    private var ready = false
    private var filter: SurfaceFilterRender? = null
    private var surface: Surface? = null
    private var display: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var webView: WebView? = null

    fun show(size: Size, preview: Boolean) {
        val requested = Target(size, preview)
        if (target != requested) {
            hide(keepPending = true)
            target = requested
        }
        if (filter == null && retry?.isActive != true) open(requested)
    }

    private fun open(requested: Target) {
        val size = requested.size
        val overlay = SurfaceFilterRender { texture ->
            val active = filter ?: return@SurfaceFilterRender
            if (active.surfaceTexture !== texture) return@SurfaceFilterRender
            runCatching {
                texture.setDefaultBufferSize(size.width, size.height)
                val target = Surface(texture).also { surface = it }
                attach(size, target, active)
            }.onFailure {
                Log.w("TChatWidgets", "Could not open widget display", it)
                fail("Не удалось вывести виджеты в кадр")
            }
        }
        overlay.setAlpha(0f)
        filter = overlay
        gl.addFilter(overlay)
        loadTimeout = scope.launch {
            delay(12_000)
            if (filter === overlay && !ready) fail("Алерты TChat не загрузились")
        }
    }

    fun enqueue(donation: Donation) {
        if (pending.size == 40) pending.removeFirst()
        pending.addLast(donation)
        playPending()
    }

    private fun playPending() {
        if (!ready || pending.isEmpty() || playback?.isActive == true) return
        val view = webView ?: return
        val destination = target ?: return
        playback = scope.launch {
            while (pending.isNotEmpty()) {
                val donation = pending.first()
                val rule = profile.select(donation)
                val data = JSONObject()
                    .put("username", donation.username)
                    .put("amount", donation.amount)
                    .put("currency", donation.currency)
                    .put("message", donation.message)
                    .put("image", rule.image)
                    .put("video", rule.video)
                if (!showCard(view, data)) {
                    fail("Не удалось показать алерт TChat")
                    return@launch
                }
                pending.remove(donation)
                failures = 0
                val started = SystemClock.elapsedRealtime()
                audio.playSound(rule.sound, rule.volume, destination.preview)
                delay(maxOf(0L, profile.displayMillis - (SystemClock.elapsedRealtime() - started)))
                view.evaluateJavascript("window.hideDonationAlert()", null)
                delay(450)
            }
        }
    }

    private suspend fun showCard(view: WebView, data: JSONObject): Boolean {
        val drawn = CompletableDeferred<Boolean>()
        view.evaluateJavascript("typeof window.showDonationAlert === 'function' && window.showDonationAlert($data)") { result ->
            if (webView !== view || result != "true") {
                drawn.complete(false)
            } else {
                view.postVisualStateCallback(0L, object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        drawn.complete(webView === view)
                    }
                })
            }
        }
        return withTimeoutOrNull(10_000) { drawn.await() } == true
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attach(size: Size, target: Surface, overlay: SurfaceFilterRender) {
        val manager = context.getSystemService(DisplayManager::class.java)
        val virtualDisplay = checkNotNull(manager.createVirtualDisplay(
            "TChat widgets", size.width, size.height, DisplayMetrics.DENSITY_DEFAULT, target,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION,
        )).also { display = it }
        val window = Presentation(context, virtualDisplay.display).also { presentation = it }
        window.requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setFormat(PixelFormat.TRANSLUCENT)
            clearFlags(LayoutParams.FLAG_DIM_BEHIND)
            addFlags(LayoutParams.FLAG_HARDWARE_ACCELERATED or LayoutParams.FLAG_FULLSCREEN or LayoutParams.FLAG_NOT_FOCUSABLE)
        }
        val view = WebView(window.context).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    widgetAsset(request)

                override fun onPageFinished(view: WebView, url: String) {
                    if (filter !== overlay || url != DONATION_WIDGET_URL) return
                    val designWidth = if (size.height > size.width) 1080 else 1920
                    view.evaluateJavascript(
                        "typeof window.placeDonationAlert === 'function' && window.placeDonationAlert(${profile.layout}, $designWidth)",
                    ) { result ->
                        if (filter !== overlay) return@evaluateJavascript
                        if (result != "true") {
                            failIfActive(overlay)
                            return@evaluateJavascript
                        }
                        loadTimeout?.cancel()
                        ready = true
                        overlay.setAlpha(1f)
                        onStatus("")
                        playPending()
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame && filter === overlay) view.post { failIfActive(overlay) }
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (request.isForMainFrame && filter === overlay) view.post { failIfActive(overlay) }
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    failIfActive(overlay)
                    return true
                }
            }
        }
        webView = view
        window.setContentView(view)
        window.show()
        window.window?.setLayout(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        view.loadUrl(DONATION_WIDGET_URL)
    }

    private fun widgetAsset(request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        val path = uri.path.orEmpty()
        if (uri.scheme == "https" && uri.host == WIDGET_HOST && path.startsWith("/alerts/") &&
            uri.pathSegments.none { it == "." || it == ".." }
        ) {
            val extension = path.substringAfterLast('.').lowercase()
            val mime = when (extension) {
                "html" -> "text/html"
                "css" -> "text/css"
                "js" -> "application/javascript"
                "gif" -> "image/gif"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "webp" -> "image/webp"
                "avif" -> "image/avif"
                "svg" -> "image/svg+xml"
                "mp4", "webm" -> "video/$extension"
                else -> "application/octet-stream"
            }
            val encoding = if (extension in listOf("html", "css", "js")) "utf-8" else null
            try {
                return WebResourceResponse(mime, encoding, context.assets.open(path.trimStart('/')))
            } catch (_: IOException) {
                // Media can use its bundled GIF when the preferred video is unavailable.
            }
        }
        return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
    }

    private fun failIfActive(overlay: SurfaceFilterRender) {
        if (filter === overlay) fail("Не удалось открыть алерты TChat")
    }

    private fun fail(message: String) {
        val requested = target ?: return
        closeLayer()
        if (failures >= 2) {
            onStatus(message)
            return
        }
        failures++
        retry = scope.launch {
            delay(750)
            retry = null
            if (target == requested) open(requested)
        }
    }

    fun hide(keepPending: Boolean = false) {
        target = null
        retry?.cancel()
        retry = null
        failures = 0
        if (!keepPending) pending.clear()
        closeLayer()
    }

    private fun closeLayer() {
        ready = false
        loadTimeout?.cancel()
        loadTimeout = null
        playback?.cancel()
        playback = null
        audio.stop()
        filter?.let { gl.removeFilter(it) }
        filter = null
        presentation?.dismiss()
        presentation = null
        webView?.stopLoading()
        webView?.destroy()
        webView = null
        display?.release()
        display = null
        surface?.release()
        surface = null
    }

    fun release() {
        hide()
        scope.cancel()
    }
}
