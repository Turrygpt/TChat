package com.tchat.stream

import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color as AndroidColor
import android.os.Bundle
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.WindowManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Opacity
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TextDecrease
import androidx.compose.material.icons.filled.TextIncrease
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme()) {
                App()
            }
        }
    }
}

private val PERMISSIONS = arrayOf(android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO)

private fun hasPermissions(ctx: android.content.Context) = PERMISSIONS.all {
    ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
}

@Composable
private fun App() {
    val context = LocalContext.current
    val store = remember { Settings(context) }
    var granted by remember { mutableStateOf(hasPermissions(context)) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted = hasPermissions(context) }

    LaunchedEffect(Unit) { if (!granted) launcher.launch(PERMISSIONS) }

    if (!granted) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Нужен доступ к камере и микрофону", color = Color.White)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { launcher.launch(PERMISSIONS) }) { Text("Разрешить") }
            }
        }
        return
    }

    StreamContent(store)
}

@Composable
private fun StreamContent(store: Settings) {
    val context = LocalContext.current
    val controller = remember { StreamController(context) }
    val status by controller.status.collectAsState()

    var settings by remember { mutableStateOf(store.load()) }
    fun update(s: StreamSettings) { settings = s; store.save(s) }

    var showSettings by remember { mutableStateOf(false) }
    var previewReady by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val surfaceRef = remember { mutableStateOf<SurfaceView?>(null) }

    // Автоскрытие интерфейса: показываем при касании, прячем через 6 секунд.
    var controlsVisible by remember { mutableStateOf(true) }
    var lastTouch by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lastTouch) {
        kotlinx.coroutines.delay(6000)
        if (System.currentTimeMillis() - lastTouch >= 6000) controlsVisible = false
    }
    fun poke() { controlsVisible = true; lastTouch = System.currentTimeMillis() }

    DisposableEffect(Unit) { onDispose { controller.release() } }

    LaunchedEffect(settings.resolution, settings.fps, settings.bitrateKbps) {
        if (!controller.isStreaming) {
            previewReady = false
            controller.stopPreview()
            val ok = runCatching { controller.prepare(settings) }.getOrDefault(false)
            if (ok) {
                error = ""
                previewReady = true
                surfaceRef.value?.let { sv ->
                    if (sv.holder.surface?.isValid == true) runCatching { controller.startPreview(sv) }
                }
            } else {
                error = "Кодек не принял ${settings.resolution.label} · ${settings.fps} fps"
            }
        }
    }

    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(status.state) {
        while (status.state == LiveState.LIVE) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            // Любое касание пустого места — показать интерфейс и сбросить таймер.
            .pointerInput(Unit) { detectTapGestures { poke() } },
    ) {
        if (previewReady) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    SurfaceView(ctx).apply {
                        surfaceRef.value = this
                        holder.addCallback(object : SurfaceHolder.Callback {
                            override fun surfaceCreated(holder: SurfaceHolder) {
                                if (previewReady) runCatching { controller.startPreview(this@apply) }
                            }
                            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) = Unit
                            override fun surfaceDestroyed(holder: SurfaceHolder) {
                                runCatching { controller.stopPreview() }
                            }
                        })
                    }
                },
            )
        } else {
            Text(
                error.ifBlank { "Запуск камеры…" },
                Modifier.align(Alignment.Center).padding(24.dp),
                color = Color.White,
            )
        }

        // Окно чата живёт независимо от автоскрытия — остаётся, пока включено.
        if (settings.chatEnabled && settings.serverUrl.isNotBlank()) {
            ChatWindow(
                cfg = settings,
                onChange = { update(it) },
                onClose = { update(settings.copy(chatEnabled = false)) },
            )
        }

        // --- интерфейс, который прячется ---
        AnimatedVisibility(visible = controlsVisible, enter = fadeIn(), exit = fadeOut()) {
            StatusChip(status, now, Modifier.padding(12.dp))
        }

        AnimatedVisibility(
            visible = controlsVisible,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(bottom = 20.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RoundIconButton(Icons.Default.Settings, "Настройки") { poke(); showSettings = true }
                Spacer(Modifier.width(14.dp))
                RoundIconButton(Icons.Default.Cameraswitch, "Камера") { poke(); controller.switchCamera() }
                Spacer(Modifier.width(14.dp))

                val live = status.state == LiveState.LIVE || status.state == LiveState.CONNECTING || status.state == LiveState.RETRYING
                Button(
                    onClick = {
                        poke()
                        if (live) {
                            controller.stopStream()
                        } else {
                            val url = settings.fullUrl
                            if (url.isBlank()) {
                                error = "Не задан RTMP-адрес — откройте настройки"
                                showSettings = true
                            } else {
                                if (!controller.isStreaming) controller.prepare(settings)
                                controller.startStream(url)
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (live) Color(0xFF616161) else Color(0xFFE53935),
                    ),
                    shape = CircleShape,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                    modifier = Modifier.size(84.dp),
                ) {
                    Text(
                        if (live) "СТОП" else "LIVE",
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                        maxLines = 1,
                        softWrap = false,
                        fontSize = 18.sp,
                    )
                }

                Spacer(Modifier.width(14.dp))
                RoundIconButton(
                    if (status.micMuted) Icons.Default.MicOff else Icons.Default.Mic,
                    "Микрофон",
                ) { poke(); controller.setMicMuted(!status.micMuted) }
                Spacer(Modifier.width(14.dp))
                RoundIconButton(
                    Icons.Default.Chat,
                    "Чат",
                    tint = if (settings.chatEnabled) Color(0xFF22D3EE) else Color.White,
                ) {
                    poke()
                    if (settings.serverUrl.isBlank()) {
                        error = "Укажите адрес сервера TChat в настройках"
                        showSettings = true
                    } else {
                        update(settings.copy(chatEnabled = !settings.chatEnabled))
                    }
                }
            }
        }

        if (showSettings) {
            SettingsDialog(
                initial = settings,
                onDismiss = { showSettings = false; poke() },
                onSave = { update(it); showSettings = false; poke() },
            )
        }
    }
}

/** Плавающее окно чата: тянем за верхнюю полоску, размер — за угол, шрифт и прозрачность — кнопками. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ChatWindow(cfg: StreamSettings, onChange: (StreamSettings) -> Unit, onClose: () -> Unit) {
    val density = LocalDensity.current
    var x by remember { mutableFloatStateOf(cfg.chatX) }
    var y by remember { mutableFloatStateOf(cfg.chatY) }
    var w by remember { mutableFloatStateOf(cfg.chatW) }
    var h by remember { mutableFloatStateOf(cfg.chatH) }
    var font by remember { mutableFloatStateOf(cfg.chatFontScale) }
    var alpha by remember { mutableFloatStateOf(cfg.chatAlpha) }

    // Сам WebView создаётся в factory (нужен Context), держим ссылку для команд.
    var web by remember { mutableStateOf<WebView?>(null) }
    var loadError by remember { mutableStateOf("") }

    // Живое обновление шрифта без перезагрузки страницы. textZoom масштабирует
    // текст на ЛЮБОЙ версии страницы чата, не завися от CSS на сервере. Плюс
    // выставляем CSS-переменную — на обновлённом сервере она тоже подхватится.
    LaunchedEffect(font, web) {
        web?.settings?.textZoom = (font * 100).roundToInt()
        web?.evaluateJavascript(
            "document.documentElement.style.setProperty('--chat-font-scale','$font')", null,
        )
    }
    // Перезагрузка при смене адреса сервера.
    LaunchedEffect(cfg.serverUrl) {
        loadError = ""
        web?.loadUrl(cfg.chatPageUrl())
    }

    DisposableEffect(web) {
        val current = web
        onDispose {
            current?.stopLoading()
            current?.destroy()
        }
    }

    fun persist() = onChange(cfg.copy(chatX = x, chatY = y, chatW = w, chatH = h, chatFontScale = font, chatAlpha = alpha))

    Box(
        Modifier
            .offset(x.dp, y.dp)
            .size(w.dp, h.dp)
            .alpha(alpha)
            .background(Color(0x22000000), RoundedCornerShape(10.dp)),
    ) {
        Column(Modifier.fillMaxSize()) {
            // Верхняя полоска: перетаскивание + кнопки.
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(34.dp)
                    .background(Color(0xCC1B2030), RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp))
                    .pointerInput(Unit) {
                        detectDragGestures(onDragEnd = { persist() }) { change, drag ->
                            change.consume()
                            x = (x + drag.x / density.density).coerceAtLeast(0f)
                            y = (y + drag.y / density.density).coerceAtLeast(0f)
                        }
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Чат", color = Color.White, fontSize = 13.sp, modifier = Modifier.padding(start = 10.dp).weight(1f))
                MiniButton(Icons.Default.TextDecrease, "Меньше") { font = (font - 0.1f).coerceAtLeast(0.8f); persist() }
                MiniButton(Icons.Default.TextIncrease, "Больше") { font = (font + 0.1f).coerceAtMost(2.6f); persist() }
                MiniButton(Icons.Default.Opacity, "Прозрачность") {
                    alpha = if (alpha <= 0.35f) 1f else (alpha - 0.25f); persist()
                }
                MiniButton(Icons.Default.Close, "Закрыть") { onClose() }
            }

            // Сам чат — прозрачная страница виджета с сервера.
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            setBackgroundColor(AndroidColor.TRANSPARENT)
                            getSettings().javaScriptEnabled = true
                            getSettings().domStorageEnabled = true
                            getSettings().mediaPlaybackRequiresUserGesture = false
                            webViewClient = object : WebViewClient() {
                                override fun onReceivedError(
                                    view: WebView,
                                    request: WebResourceRequest,
                                    error: WebResourceError,
                                ) {
                                    if (request.isForMainFrame) {
                                        loadError = "Сервер чата недоступен: ${error.description}"
                                    }
                                }

                                override fun onReceivedHttpError(
                                    view: WebView,
                                    request: WebResourceRequest,
                                    errorResponse: WebResourceResponse,
                                ) {
                                    if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                                        loadError = "Сервер чата вернул HTTP ${errorResponse.statusCode}"
                                    }
                                }
                            }
                            web = this
                            loadUrl(cfg.chatPageUrl())
                        }
                    },
                )

                if (loadError.isNotBlank()) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .background(Color(0xE6191C26))
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(loadError, color = Color.White, fontSize = 13.sp)
                        Spacer(Modifier.height(10.dp))
                        Button(onClick = {
                            loadError = ""
                            web?.reload()
                        }) {
                            Text("Повторить")
                        }
                    }
                }

                // Уголок для изменения размера.
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(30.dp)
                        .background(Color(0xAA22D3EE), RoundedCornerShape(topStart = 8.dp))
                        .pointerInput(Unit) {
                            detectDragGestures(onDragEnd = { persist() }) { change, drag ->
                                change.consume()
                                w = (w + drag.x / density.density).coerceAtLeast(160f)
                                h = (h + drag.y / density.density).coerceAtLeast(160f)
                            }
                        },
                ) {
                    Icon(Icons.Default.OpenInFull, "Размер", tint = Color(0xFF06222B), modifier = Modifier.align(Alignment.Center).size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun MiniButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(34.dp)) {
        Icon(icon, label, tint = Color.White, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun StatusChip(status: StreamStatus, now: Long, modifier: Modifier = Modifier) {
    val (text, color) = when (status.state) {
        LiveState.IDLE -> "Не в эфире" to Color(0xAA424242)
        LiveState.CONNECTING -> "Подключение…" to Color(0xAAFB8C00)
        LiveState.RETRYING -> "Переподключение…" to Color(0xAAFB8C00)
        LiveState.FAILED -> status.error.ifBlank { "Ошибка" } to Color(0xCCB71C1C)
        LiveState.LIVE -> {
            val sec = ((now - status.startedAt) / 1000).coerceAtLeast(0)
            "● LIVE %d:%02d:%02d · %d кбит/с".format(sec / 3600, sec / 60 % 60, sec % 60, status.bitrateKbps) to Color(0xCCC62828)
        }
    }
    Text(
        text,
        modifier
            .background(color, RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        color = Color.White,
        style = MaterialTheme.typography.labelLarge,
    )
}

@Composable
private fun RoundIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color = Color.White,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(56.dp).background(Color(0x66000000), CircleShape)) {
        Icon(icon, label, tint = tint)
    }
}

@Composable
private fun SettingsDialog(initial: StreamSettings, onDismiss: () -> Unit, onSave: (StreamSettings) -> Unit) {
    var url by remember { mutableStateOf(initial.rtmpUrl) }
    var key by remember { mutableStateOf(initial.streamKey) }
    var server by remember { mutableStateOf(initial.serverUrl) }
    var resolution by remember { mutableStateOf(initial.resolution) }
    var fps by remember { mutableStateOf(initial.fps) }
    var bitrate by remember { mutableFloatStateOf(initial.bitrateKbps.toFloat()) }

    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Color(0xFF15171E), RoundedCornerShape(16.dp))
                .padding(20.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Настройки эфира", style = MaterialTheme.typography.titleLarge, color = Color.White)

            OutlinedTextField(
                value = url, onValueChange = { url = it },
                label = { Text("RTMP-адрес (rtmp://…)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = key, onValueChange = { key = it },
                label = { Text("Ключ трансляции") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = server, onValueChange = { server = it },
                label = { Text("Сервер TChat для чата (IP:порт)") },
                placeholder = { Text("192.168.1.10:3000 или server/tchat") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )

            Text("Разрешение", color = Color.White)
            Row(Modifier.fillMaxWidth()) {
                Resolution.entries.forEach { r ->
                    Row(
                        Modifier.weight(1f).selectable(selected = resolution == r, onClick = { resolution = r }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = resolution == r, onClick = { resolution = r })
                        Text(r.label, color = Color.White)
                    }
                }
            }

            Text("Частота кадров", color = Color.White)
            Row(Modifier.fillMaxWidth()) {
                listOf(30, 60).forEach { f ->
                    Row(
                        Modifier.weight(1f).selectable(selected = fps == f, onClick = { fps = f }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = fps == f, onClick = { fps = f })
                        Text("$f fps", color = Color.White)
                    }
                }
            }

            Text("Битрейт: ${bitrate.toInt()} кбит/с", color = Color.White)
            Slider(
                value = bitrate, onValueChange = { bitrate = it },
                valueRange = MIN_BITRATE_KBPS.toFloat()..MAX_BITRATE_KBPS.toFloat(),
                steps = (MAX_BITRATE_KBPS - MIN_BITRATE_KBPS) / 250 - 1,
            )

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text("Отмена") }
                Spacer(Modifier.width(8.dp))
                Button(onClick = {
                    val step = 250
                    val br = (((bitrate.toInt() + step / 2) / step) * step).coerceIn(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS)
                    onSave(
                        initial.copy(
                            rtmpUrl = url.trim(), streamKey = key.trim(), serverUrl = server.trim(),
                            resolution = resolution, fps = fps, bitrateKbps = br,
                        ),
                    )
                }) { Text("Сохранить") }
            }
        }
    }
}
