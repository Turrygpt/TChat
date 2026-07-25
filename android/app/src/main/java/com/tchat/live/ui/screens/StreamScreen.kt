package com.tchat.live.ui.screens

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.navigation.NavController
import com.tchat.live.App
import com.tchat.live.data.AppSettings
import com.tchat.live.engine.DualCameraController
import com.tchat.live.engine.StreamState
import com.tchat.live.engine.VideoMode
import com.tchat.live.service.ScreenCaptureService
import com.tchat.live.service.StreamService
import com.tchat.live.ui.components.ChatSheet

/** Экран эфира: превью камеры (или карточка захвата экрана) + управление трансляцией. */
@Composable
fun StreamScreen(nav: NavController, screenMode: Boolean) {
    val app = App.instance
    val engine = app.engine
    val context = LocalContext.current
    val settings by app.settings.settings.collectAsState(initial = AppSettings())
    val stats by engine.stats.collectAsState()
    var showChat by remember { mutableStateOf(false) }

    // --- разрешения --------------------------------------------------------
    val neededPermissions = remember(screenMode) {
        buildList {
            if (!screenMode) add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    fun allGranted() = neededPermissions.all {
        // Уведомления не критичны для эфира — не блокируем из-за них.
        it == Manifest.permission.POST_NOTIFICATIONS ||
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
    var permissionsGranted by remember { mutableStateOf(allGranted()) }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { permissionsGranted = allGranted() }
    LaunchedEffect(Unit) { if (!permissionsGranted) permLauncher.launch(neededPermissions.toTypedArray()) }

    // --- ориентация экрана = ориентация эфира ------------------------------
    DisposableEffect(settings.portrait) {
        val activity = context as? Activity
        activity?.requestedOrientation = if (settings.portrait) {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        } else {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        onDispose { activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }

    // --- подготовка движка -------------------------------------------------
    // Превью нельзя запускать до prepare(): RootEncoder кидает исключение.
    // Поэтому SurfaceView появляется только после успешной подготовки, а смена
    // качества сначала останавливает превью.
    val previewReady = remember { mutableStateOf(false) }
    val surfaceViewRef = remember { mutableStateOf<SurfaceView?>(null) }
    var engineError by remember { mutableStateOf("") }
    LaunchedEffect(permissionsGranted, settings.qualityIndex, settings.portrait, screenMode) {
        if (permissionsGranted && !engine.isStreaming) {
            previewReady.value = false
            runCatching {
                if (!screenMode) {
                    engine.stopPreview()
                    engine.switchToCamera()
                }
                check(engine.prepare(settings.quality, settings.portrait)) {
                    "Кодек не принял ${settings.quality.label}"
                }
            }.onSuccess {
                engineError = ""
                if (!screenMode) {
                    previewReady.value = true
                    surfaceViewRef.value?.let { sv ->
                        if (sv.holder.surface?.isValid == true) {
                            runCatching { engine.startPreview(sv) }
                                .onFailure { engineError = it.message ?: "Не удалось запустить превью" }
                        }
                    }
                }
            }.onFailure {
                engineError = it.message ?: "Не удалось запустить камеру"
            }
        }
    }

    fun overlayStreamSize(): Pair<Int, Int> {
        val q = settings.quality
        return if (settings.portrait) q.height to q.width else q.width to q.height
    }

    fun startOverlayIfNeeded() {
        val any = settings.overlayChat || settings.overlayAlerts || settings.overlayGoal || settings.overlayStickers
        if (any && settings.serverHost.isNotBlank()) {
            val (w, h) = overlayStreamSize()
            app.overlay.start(settings.overlayUrl, w, h)
        }
    }

    fun stopLive() {
        engine.stopStream()
        app.overlay.stop()
        app.pip.stop()
        if (screenMode) ScreenCaptureService.stop(context)
    }

    val projectionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            engine.prepare(settings.quality, settings.portrait)
            ScreenCaptureService.start(context, result.resultCode, data, settings.mixInternalAudio)
            StreamService.start(context)
            engine.startStream(settings.rtmpUrl)
            startOverlayIfNeeded()
        }
    }

    fun goLive() {
        if (screenMode) {
            val mpm = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projectionLauncher.launch(mpm.createScreenCaptureIntent())
        } else {
            engine.prepare(settings.quality, settings.portrait)
            StreamService.start(context)
            engine.startStream(settings.rtmpUrl)
            startOverlayIfNeeded()
        }
    }

    // --- тикающий таймер эфира ---------------------------------------------
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(stats.state) {
        while (stats.state == StreamState.LIVE) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        // --- превью ---------------------------------------------------------
        if (!screenMode && permissionsGranted && previewReady.value) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    SurfaceView(ctx).apply {
                        surfaceViewRef.value = this
                        holder.addCallback(object : SurfaceHolder.Callback {
                            override fun surfaceCreated(holder: SurfaceHolder) {
                                if (previewReady.value) {
                                    runCatching { engine.startPreview(this@apply) }
                                }
                            }
                            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) = Unit
                            override fun surfaceDestroyed(holder: SurfaceHolder) {
                                runCatching { engine.stopPreview() }
                            }
                        })
                    }
                },
            )
        } else if (screenMode) {
            Card(
                Modifier.align(Alignment.Center).padding(24.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Эфир экрана", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (stats.state == StreamState.LIVE) {
                            "Идёт трансляция экрана. Сверните приложение — стрим продолжится."
                        } else {
                            "Всё, что происходит на экране телефона, уйдёт в эфир. Чат и алерты TChat лягут поверх."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        } else {
            Text(
                when {
                    !permissionsGranted -> "Нужно разрешение на камеру и микрофон"
                    engineError.isNotBlank() -> engineError
                    else -> "Запуск камеры…"
                },
                Modifier.align(Alignment.Center).padding(24.dp),
                color = Color.White,
            )
        }

        // --- верхняя панель: назад + статус --------------------------------
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { nav.popBackStack() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Назад", tint = Color.White)
            }
            Spacer(Modifier.width(4.dp))
            StatusChip(stats.state, stats.error, stats.bitrateKbps, stats.startedAt, now)
        }

        // --- нижняя панель управления --------------------------------------
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(bottom = 24.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!screenMode) {
                ControlButton(
                    icon = Icons.Default.Cameraswitch,
                    label = "Камера",
                    enabled = !app.pip.running,
                ) { engine.switchCamera() }
                ControlButton(
                    icon = if (stats.lantern) Icons.Default.FlashlightOn else Icons.Default.FlashlightOff,
                    label = "Фонарик",
                    enabled = !stats.frontCamera,
                ) { engine.toggleLantern() }
            }
            ControlButton(
                icon = if (stats.micMuted) Icons.Default.MicOff else Icons.Default.Mic,
                label = if (stats.micMuted) "Вкл. звук" else "Микрофон",
            ) { engine.setMicMuted(!stats.micMuted) }

            Spacer(Modifier.width(12.dp))
            Button(
                onClick = { if (stats.state == StreamState.IDLE || stats.state == StreamState.FAILED) goLive() else stopLive() },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (stats.state == StreamState.IDLE || stats.state == StreamState.FAILED) {
                        Color(0xFFE53935)
                    } else {
                        Color(0xFF616161)
                    },
                ),
                shape = CircleShape,
                modifier = Modifier.size(72.dp),
            ) {
                Text(
                    if (stats.state == StreamState.IDLE || stats.state == StreamState.FAILED) "LIVE" else "СТОП",
                    fontWeight = FontWeight.Bold,
                    color = Color.White,
                )
            }
            Spacer(Modifier.width(12.dp))

            if (!screenMode && DualCameraController.isSupported(context) && stats.videoMode == VideoMode.CAMERA) {
                ControlButton(
                    icon = Icons.Default.PictureInPicture,
                    label = if (app.pip.running) "Убрать PiP" else "Фронталка",
                    enabled = !stats.frontCamera,
                ) { if (app.pip.running) app.pip.stop() else app.pip.start() }
            }
            if (settings.serverHost.isNotBlank()) {
                ControlButton(icon = Icons.AutoMirrored.Filled.Chat, label = "Чат") { showChat = true }
            }
        }

        if (showChat) {
            ChatSheet(serverBaseUrl = settings.serverBaseUrl, onDismiss = { showChat = false })
        }
    }
}

@Composable
private fun StatusChip(state: StreamState, error: String, bitrateKbps: Int, startedAt: Long, now: Long) {
    val (text, color) = when (state) {
        StreamState.IDLE -> "Не в эфире" to Color(0xAA424242)
        StreamState.CONNECTING -> "Подключение…" to Color(0xAAFB8C00)
        StreamState.RETRYING -> "Переподключение…" to Color(0xAAFB8C00)
        StreamState.FAILED -> (error.ifBlank { "Ошибка" }) to Color(0xCCB71C1C)
        StreamState.LIVE -> {
            val sec = ((now - startedAt) / 1000).coerceAtLeast(0)
            "● LIVE %d:%02d:%02d • %d кбит/с".format(sec / 3600, sec / 60 % 60, sec % 60, bitrateKbps) to Color(0xCCC62828)
        }
    }
    Text(
        text,
        Modifier
            .background(color, RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        color = Color.White,
        style = MaterialTheme.typography.labelLarge,
    )
}

@Composable
private fun ControlButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 4.dp)) {
        IconButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.background(Color(0x66000000), CircleShape),
        ) {
            Icon(icon, label, tint = if (enabled) Color.White else Color(0x88FFFFFF))
        }
        Text(label, color = Color.White, style = MaterialTheme.typography.labelSmall)
    }
}
