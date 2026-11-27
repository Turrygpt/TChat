package com.tchat.stream

import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.os.SystemClock
import android.util.Size
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloseFullscreen
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Opacity
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TextDecrease
import androidx.compose.material.icons.filled.TextIncrease
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        val store = Settings(this)
        requestedOrientation = store.load().orientation.activityValue
        setContent {
            StreamTheme {
                App(store, window) { requestedOrientation = it.activityValue }
            }
        }
    }
}

private val PERMISSIONS = arrayOf(android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO)

private fun hasPermissions(ctx: android.content.Context) = PERMISSIONS.all {
    ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
}

@Composable
private fun App(store: Settings, window: Window, applyOrientation: (StreamOrientation) -> Unit) {
    val context = LocalContext.current
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

    StreamContent(store, window, applyOrientation)
}

@Composable
private fun StreamContent(store: Settings, window: Window, applyOrientation: (StreamOrientation) -> Unit) {
    val context = LocalContext.current
    val profile = remember { DonationProfile.load(context) }
    val uiScope = rememberCoroutineScope()
    val donationAccount = remember { DonationAccount(context, uiScope) }
    val donationToken by donationAccount.token.collectAsState()
    val donationMessages by donationAccount.chat.collectAsState()
    val controller = remember { StreamController(context, profile) }
    val status by controller.status.collectAsState()

    var settings by remember { mutableStateOf(store.load()) }
    fun update(value: StreamSettings) {
        settings = value
        store.save(value)
    }

    var settingsPage by remember { mutableStateOf<SettingsPage?>(null) }
    var surface by remember { mutableStateOf<SurfaceView?>(null) }
    val platform = settings.chatPlatform
    val channel = platform.normalize(settings.chatAddress).orEmpty()
    val publishing = status.isPublishing
    val donationConnected = donationToken.isNotEmpty()
    val hasChat = channel.isNotEmpty() || donationConnected
    val receiveChat = settings.chatEnabled || settings.widgetsEnabled && publishing && platform != ChatPlatform.YOUTUBE
    val watchFeed = channel.isNotEmpty() && (receiveChat || publishing)
    val watchDonations = donationConnected && (settings.widgetsEnabled || settings.chatEnabled)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var feedMessages by remember(channel, platform) { mutableStateOf(emptyList<ChatMessage>()) }
    var liveViewers by remember(channel, platform) { mutableStateOf<Long?>(null) }
    var chatNotice by remember(channel, platform) { mutableStateOf("") }
    val chatMessages = remember(feedMessages, donationMessages) {
        (feedMessages + donationMessages).sortedWith(compareByDescending<ChatMessage> { it.timeMillis }.thenByDescending { it.id })
    }
    val hasDestination = settings.hasRtmpAddress()
    val cameraReady = status.cameraReady
    val frontCamera = status.frontCamera
    val thermal = currentThermalLevel()
    val hot = settings.economy && thermal == ThermalLevel.HOT
    val canChangeQuality = !publishing && status.state != LiveState.STOPPING
    var showControls by remember(publishing) { mutableStateOf(false) }
    var showDetails by remember(publishing) { mutableStateOf(false) }
    var confirmStop by remember(publishing) { mutableStateOf(false) }
    var screenLight by remember(frontCamera) { mutableStateOf(false) }
    val screenLightActive = frontCamera && screenLight && !hot
    var lastControlUse by remember { mutableLongStateOf(0L) }
    var zoomFeedbackAt by remember { mutableLongStateOf(0L) }
    var focusSpot by remember { mutableStateOf<Offset?>(null) }
    var autoFocusNotice by remember { mutableLongStateOf(0L) }
    val controlsVisible = !publishing || showControls
    val previewHidden = hot && publishing && !showControls && !showDetails
    val previewIsHidden by rememberUpdatedState(previewHidden)
    fun keepControlsOpen() { lastControlUse = SystemClock.elapsedRealtime() }
    fun revealControls() {
        if (publishing) {
            showControls = true
            keepControlsOpen()
        }
    }

    LaunchedEffect(showControls, lastControlUse, settingsPage, confirmStop) {
        if (showControls && settingsPage == null && !confirmStop) {
            delay(6_000)
            showControls = false
        }
    }
    LaunchedEffect(zoomFeedbackAt) {
        if (zoomFeedbackAt > 0L) {
            delay(950)
            zoomFeedbackAt = 0L
        }
    }
    LaunchedEffect(focusSpot) {
        if (focusSpot != null) {
            delay(1_100)
            focusSpot = null
        }
    }
    LaunchedEffect(autoFocusNotice) {
        if (autoFocusNotice > 0L) {
            delay(1_100)
            autoFocusNotice = 0L
        }
    }
    LaunchedEffect(hot) { if (hot) screenLight = false }
    BackHandler(enabled = publishing && settingsPage == null && !confirmStop) { confirmStop = true }
    StreamDisplayPower(window, publishing, settings.economy, thermal, screenLightActive)
    if (screenLightActive && foreground) {
        DisposableEffect(window) {
            val bars = WindowCompat.getInsetsController(window, window.decorView)
            val previousBehavior = bars.systemBarsBehavior
            bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            bars.hide(WindowInsetsCompat.Type.systemBars())
            onDispose {
                bars.show(WindowInsetsCompat.Type.systemBars())
                bars.systemBarsBehavior = previousBehavior
            }
        }
    }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ ->
            foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    DisposableEffect(controller) { onDispose { controller.release() } }
    LaunchedEffect(settings.widgetsEnabled, donationConnected) {
        controller.setAlerts(settings.widgetsEnabled, donationConnected)
    }
    LaunchedEffect(lifecycle, platform, channel, watchFeed, receiveChat, settings.economy) {
        if (!watchFeed) {
            liveViewers = null
            return@LaunchedEffect
        }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            chatNotice = if (receiveChat) "Подключение к ${platform.label}…" else ""
            watchChatPlatform(
                platform, channel, receiveChat, settings.economy,
                ChatFeedUpdates(
                    messages = { messages, replace ->
                        val combined = if (replace) messages else messages + feedMessages
                        feedMessages = combined.distinctBy { it.key }.sortedByDescending { it.timeMillis }.take(100)
                    },
                    viewers = { liveViewers = it },
                    notice = { chatNotice = it },
                    alert = controller::showVkAlert,
                ),
            )
        }
    }
    LaunchedEffect(lifecycle, donationToken, watchDonations) {
        if (!watchDonations) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            donationAccount.monitor(donationToken, controller::showDonation)
        }
    }
    LaunchedEffect(settings.rearCameraRotation, settings.frontCameraRotation) {
        controller.setCameraRotationOffsets(settings.rearCameraRotation, settings.frontCameraRotation)
    }
    LaunchedEffect(settings.antiFlicker) {
        controller.setAntiFlicker(settings.antiFlicker)
    }
    LaunchedEffect(settings.economy, settings.streamFps, thermal, publishing) {
        controller.applyCaptureBudget(settings, thermal, publishing)
    }
    LaunchedEffect(settings.orientation) { applyOrientation(settings.orientation) }
    val displayPortrait = LocalConfiguration.current.orientation == Configuration.ORIENTATION_PORTRAIT
    val displayReady = displayPortrait == (settings.orientation == StreamOrientation.PORTRAIT)
    LaunchedEffect(surface, displayReady, foreground, settings.resolution, settings.orientation, settings.streamFps, settings.bitrateKbps) {
        if (foreground && displayReady) surface?.let { controller.startPreview(it, settings) }
        else if (!publishing) controller.closePreview()
    }
    LaunchedEffect(surface, cameraReady, previewHidden) {
        surface?.let { controller.setPreviewRendering(it, !previewHidden) }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                SurfaceView(ctx).apply {
                    holder.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) = Unit

                        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                            controller.setPreviewSize(width, height)
                            surface = this@apply
                        }

                        override fun surfaceDestroyed(holder: SurfaceHolder) {
                            surface = null
                            controller.closePreview()
                        }
                    })
                }
            },
        )
        Box(
            Modifier.matchParentSize()
                .pointerInput(controller) {
                    detectTransformGestures(panZoomLock = true) { _, _, scale, _ ->
                        if (scale != 1f && !previewIsHidden) {
                            controller.zoomBy(scale)
                            zoomFeedbackAt = SystemClock.elapsedRealtime()
                        }
                    }
                }
                .pointerInput(publishing, settings.frameSize) {
                    detectTapGestures(
                        onTap = { point ->
                            revealControls()
                            val onFrame = if (previewIsHidden) null else normalizedPreviewPoint(point, size, settings.frameSize)
                            if (onFrame != null && controller.focusAt(onFrame.x, onFrame.y)) {
                                autoFocusNotice = 0L
                                focusSpot = point
                            }
                        },
                        onDoubleTap = {
                            revealControls()
                            if (controller.resumeAutoFocus()) {
                                focusSpot = null
                                autoFocusNotice = SystemClock.elapsedRealtime()
                            }
                        },
                    )
                },
        )
        focusSpot?.takeIf { cameraReady && !previewHidden }?.let { FocusMark(it) }
        if (screenLightActive) {
            ScreenLightFrame()
        }

        BoxWithConstraints(Modifier.fillMaxSize()) {
            if (cameraReady && !previewHidden) status.insetLayout?.let { layout ->
                CameraInsetDragTarget(
                    layout = layout,
                    frame = previewFrame(IntSize(constraints.maxWidth, constraints.maxHeight), settings.frameSize),
                    onMove = controller::moveInset,
                    onSave = { update(settings.copy(insetPosition = it)) },
                )
            }
            if (settings.chatEnabled && hasChat) {
                ChatWindow(
                    cfg = settings,
                    messages = chatMessages,
                    notice = chatNotice,
                    editing = controlsVisible,
                    availableWidth = maxWidth.value,
                    availableHeight = maxHeight.value,
                    onChange = { update(it); keepControlsOpen() },
                    onClose = { update(settings.copy(chatEnabled = false)) },
                )
            }
        }

        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val compactControls = maxWidth < 376.dp
            val buttonSize = if (compactControls) 40.dp else 46.dp
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        StatusChip(status, settings.resolution, liveViewers, showDetails) {
                            showDetails = !showDetails
                        }
                    }
                    if (publishing && !controlsVisible) {
                        RoundIconButton(Icons.Default.Tune, "Показать управление", size = 44.dp, onClick = ::revealControls)
                    }
                    if (frontCamera && (controlsVisible || screenLightActive)) {
                        RoundIconButton(
                            Icons.Default.LightMode,
                            if (screenLightActive) "Выключить подсветку экрана" else "Включить подсветку экрана",
                            tint = if (screenLightActive) StreamAccent else Color.White,
                            enabled = cameraReady && !hot,
                            size = 44.dp,
                        ) { screenLight = !screenLight }
                    } else if (status.cameraControls.torchAvailable && (controlsVisible || status.cameraControls.torchEnabled)) {
                        val torch = status.cameraControls.torchEnabled
                        RoundIconButton(
                            if (torch) Icons.Default.FlashlightOn else Icons.Default.FlashlightOff,
                            if (torch) "Выключить вспышку" else "Включить вспышку",
                            tint = if (torch) StreamAccent else Color.White,
                            enabled = cameraReady && (!hot || torch),
                            size = 44.dp,
                            onClick = controller::toggleTorch,
                        )
                    }
                }
                val notice = status.cameraError.ifBlank { status.widgetError }
                if (notice.isNotBlank()) {
                    Text(
                        notice,
                        Modifier.background(Color(0xD83C2020), RoundedCornerShape(12.dp)).padding(8.dp),
                        color = Color.White,
                    )
                }
                if (settings.economy && thermal != ThermalLevel.NORMAL && publishing) {
                    Text(
                        "Нагрев · нагрузка снижена",
                        Modifier.background(StreamChrome, RoundedCornerShape(12.dp)).padding(8.dp),
                        color = Color(0xFFFFCA90),
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
            if (!cameraReady && status.cameraError.isBlank() && !publishing) {
                Text("Запуск камеры…", Modifier.align(Alignment.Center), color = Color.White)
            }
            if (previewHidden) {
                Text(
                    "Показать предпросмотр",
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp)
                        .clip(RoundedCornerShape(18.dp)).background(StreamChrome)
                        .clickable(role = Role.Button, onClick = ::revealControls).padding(horizontal = 15.dp, vertical = 11.dp),
                    color = StreamAccent,
                    style = MaterialTheme.typography.labelLarge,
                )
            } else if (autoFocusNotice > 0L) {
                Text(
                    "Автофокус",
                    Modifier.align(Alignment.Center).background(StreamChrome, RoundedCornerShape(16.dp))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = StreamAccent,
                    style = MaterialTheme.typography.labelLarge,
                )
            } else if (zoomFeedbackAt > 0L) {
                val tenths = (status.cameraControls.zoom * 10).roundToInt()
                val label = if (tenths % 10 == 0) "${tenths / 10}×" else "${tenths / 10},${tenths % 10}×"
                Text(
                    label,
                    Modifier.align(Alignment.Center).background(StreamChrome, RoundedCornerShape(16.dp))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = Color.White,
                    style = MaterialTheme.typography.labelLarge,
                )
            }

            AnimatedVisibility(
                visible = controlsVisible,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier.align(Alignment.BottomCenter).padding(start = 7.dp, end = 7.dp, bottom = 10.dp),
            ) {
                Row(
                    Modifier.clip(RoundedCornerShape(26.dp)).background(StreamChrome)
                        .border(1.dp, StreamOutline, RoundedCornerShape(26.dp)).padding(6.dp),
                    horizontalArrangement = Arrangement.spacedBy(if (compactControls) 3.dp else 6.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RoundIconButton(Icons.Default.Settings, "Настройки", size = buttonSize) {
                        settingsPage = SettingsPage.STREAM
                    }
                    RoundIconButton(
                        Icons.Default.Cameraswitch, "Переключить камеру",
                        enabled = controller.canSwitch && (status.cameraReady || status.cameraError.isNotBlank()),
                        size = buttonSize,
                    ) {
                        keepControlsOpen()
                        controller.switchCamera()
                    }
                    if (controller.canUseInset) {
                        RoundIconButton(
                            Icons.Default.PictureInPictureAlt, "Камера в окне",
                            tint = if (status.pictureInPicture) StreamAccent else Color.White,
                            enabled = status.cameraReady && !hot,
                            size = buttonSize,
                        ) {
                            keepControlsOpen()
                            controller.togglePictureInPicture()
                        }
                    }

                    Button(
                        onClick = {
                            when {
                                publishing -> confirmStop = true
                                hasDestination -> controller.startStream(settings.fullUrl)
                                else -> settingsPage = SettingsPage.STREAM
                            }
                        },
                        enabled = status.state != LiveState.STOPPING && (publishing || status.cameraReady || !hasDestination),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (publishing) Color(0xFF842241) else StreamRed,
                        ),
                        shape = RoundedCornerShape(18.dp),
                        contentPadding = PaddingValues(horizontal = 9.dp),
                        modifier = Modifier.widthIn(min = if (compactControls) 76.dp else 88.dp).height(48.dp),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                if (publishing) "СТОП" else "LIVE",
                                fontWeight = FontWeight.Bold, color = Color.White, maxLines = 1,
                                style = MaterialTheme.typography.labelLarge,
                            )
                            if (channel.isNotBlank()) ViewerCount(liveViewers)
                        }
                    }

                    RoundIconButton(
                        if (status.micMuted) Icons.Default.MicOff else Icons.Default.Mic,
                        if (status.micMuted) "Включить микрофон" else "Выключить микрофон",
                        size = buttonSize,
                    ) {
                        keepControlsOpen()
                        controller.setMicMuted(!status.micMuted)
                    }
                    RoundIconButton(
                        Icons.AutoMirrored.Filled.Chat, "Чат на телефоне",
                        tint = if (settings.chatEnabled && hasChat) StreamAccent else Color.White,
                        size = buttonSize,
                    ) {
                        keepControlsOpen()
                        if (!hasChat) {
                            settingsPage = SettingsPage.CHAT
                        } else {
                            update(settings.copy(chatEnabled = !settings.chatEnabled))
                        }
                    }
                }
            }
        }
    }
    settingsPage?.let { page ->
        StreamSettingsDialog(
            initial = settings,
            initialPage = page,
            qualityEnabled = canChangeQuality,
            donationAccount = donationAccount,
            donationClientId = profile.clientId,
            onReplay = { donation ->
                settingsPage = null
                showControls = false
                controller.showDonation(donation)
            },
            onDismiss = { settingsPage = null; showControls = false },
            onSave = { update(it); settingsPage = null; showControls = false },
        )
    }
    if (confirmStop && publishing) {
        AlertDialog(
            title = { Text("Остановить трансляцию?") },
            onDismissRequest = { confirmStop = false },
            dismissButton = {
                TextButton(onClick = { confirmStop = false }) { Text("Продолжить эфир") }
            },
            confirmButton = {
                Button(onClick = {
                    confirmStop = false
                    controller.stopStream()
                }) { Text("Остановить") }
            },
        )
    }
}

private fun previewFrame(viewport: IntSize, frame: Size): Rect {
    val scale = minOf(viewport.width.toFloat() / frame.width, viewport.height.toFloat() / frame.height)
    if (scale <= 0f) return Rect.Zero
    val width = frame.width * scale
    val height = frame.height * scale
    val left = (viewport.width - width) / 2f
    val top = (viewport.height - height) / 2f
    return Rect(left, top, left + width, top + height)
}

private fun normalizedPreviewPoint(point: Offset, viewport: IntSize, frame: Size): Offset? {
    val bounds = previewFrame(viewport, frame)
    if (bounds.isEmpty) return null
    val x = (point.x - bounds.left) / bounds.width
    val y = (point.y - bounds.top) / bounds.height
    return Offset(x, y).takeIf { x in 0f..1f && y in 0f..1f }
}

@Composable
private fun CameraInsetDragTarget(
    layout: CameraInsetFilter.Layout,
    frame: Rect,
    onMove: (InsetPosition) -> Unit,
    onSave: (InsetPosition) -> Unit,
) {
    if (frame.isEmpty) return
    val density = LocalDensity.current
    val start by rememberUpdatedState(layout.position)
    val move by rememberUpdatedState(onMove)
    val save by rememberUpdatedState(onSave)
    Box(
        Modifier
            .absoluteOffset {
                IntOffset(
                    (frame.left + frame.width * layout.left).roundToInt(),
                    (frame.top + frame.height * layout.top).roundToInt(),
                )
            }
            .size(
                with(density) { (frame.width * layout.width).toDp() },
                with(density) { (frame.height * layout.height).toDp() },
            )
            .semantics { contentDescription = "Мини-камера" }
            .pointerInput(frame, layout.width, layout.height) {
                val travelX = frame.width * (1f - layout.width)
                val travelY = frame.height * (1f - layout.height)
                var position = start
                detectDragGestures(
                    onDragStart = { position = start },
                    onDragEnd = { save(position) },
                    onDragCancel = { save(position) },
                ) { change, delta ->
                    change.consume()
                    position = InsetPosition(
                        (position.x + delta.x / travelX).coerceIn(0f, 1f),
                        (position.y + delta.y / travelY).coerceIn(0f, 1f),
                    )
                    move(position)
                }
            },
    )
}

@Composable
private fun FocusMark(at: Offset) {
    Canvas(Modifier.fillMaxSize()) {
        val inset = 24.dp.toPx()
        val length = 9.dp.toPx()
        val width = 2.dp.toPx()
        for (x in listOf(-1f, 1f)) {
            for (y in listOf(-1f, 1f)) {
                val corner = at + Offset(inset * x, inset * y)
                drawLine(StreamAccent, corner, corner - Offset(length * x, 0f), width, StrokeCap.Round)
                drawLine(StreamAccent, corner, corner - Offset(0f, length * y), width, StrokeCap.Round)
            }
        }
    }
}

@Composable
private fun ChatWindow(
    cfg: StreamSettings,
    messages: List<ChatMessage>,
    notice: String,
    editing: Boolean,
    availableWidth: Float,
    availableHeight: Float,
    onChange: (StreamSettings) -> Unit,
    onClose: () -> Unit,
) {
    val density = LocalDensity.current
    var x by remember { mutableFloatStateOf(cfg.chatX) }
    var y by remember { mutableFloatStateOf(cfg.chatY) }
    var w by remember { mutableFloatStateOf(cfg.chatW) }
    var h by remember { mutableFloatStateOf(cfg.chatH) }
    var fullHeight by remember { mutableStateOf(cfg.chatFullHeight) }
    var font by remember { mutableFloatStateOf(cfg.chatFontScale) }
    var alpha by remember { mutableFloatStateOf(cfg.chatAlpha) }
    var filtersOpen by remember { mutableStateOf(false) }
    var selectedMessage by remember { mutableStateOf<ChatMessage?>(null) }
    val visibleMessages = remember(messages, cfg.chatFilters) { messages.filterNot(cfg.chatFilters::hides) }

    val listState = rememberLazyListState()
    val atNewest = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
    LaunchedEffect(visibleMessages.firstOrNull()?.key) {
        if (atNewest && visibleMessages.isNotEmpty()) listState.scrollToItem(0)
    }
    val minWidth = minOf(availableWidth, 214f)
    val minHeight = minOf(availableHeight, 120f)
    val maxX = availableWidth - minWidth
    val maxY = availableHeight - minHeight
    val left = x.coerceIn(0f, maxX)
    val top = if (fullHeight) 0f else y.coerceIn(0f, maxY)
    // A large window can still be dragged to an edge. Fit it to the space at its new position.
    val visibleWidth = w.coerceIn(minWidth, availableWidth - left)
    val visibleHeight = if (fullHeight) availableHeight else h.coerceIn(minHeight, availableHeight - top)
    val persist by rememberUpdatedState {
        onChange(cfg.copy(
            chatX = x, chatY = y, chatW = w, chatH = h, chatFullHeight = fullHeight,
            chatFontScale = font, chatAlpha = alpha,
        ))
    }

    Box(
        Modifier
            .absoluteOffset(left.dp, top.dp)
            .size(visibleWidth.dp, visibleHeight.dp)
            .alpha(alpha)
            .clip(RoundedCornerShape(14.dp)).background(Color(0xB8111924), RoundedCornerShape(14.dp))
            .border(1.dp, StreamOutline.copy(alpha = 0.65f), RoundedCornerShape(14.dp)),
    ) {
        Column(Modifier.fillMaxSize()) {
            if (editing) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(34.dp)
                        .background(StreamChrome, RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp))
                        .pointerInput(availableWidth, availableHeight) {
                            detectDragGestures(onDragEnd = { persist() }) { change, drag ->
                                change.consume()
                                x = (x.coerceIn(0f, maxX) + drag.x / density.density).coerceIn(0f, maxX)
                                if (!fullHeight) {
                                    y = (y.coerceIn(0f, maxY) + drag.y / density.density).coerceIn(0f, maxY)
                                }
                            }
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (cfg.chatAddress.isNotEmpty()) "${cfg.chatPlatform.label} · ${cfg.chatAddress}" else "Чат",
                        color = Color.White, fontSize = 13.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 10.dp).weight(1f),
                    )
                    MiniButton(Icons.Default.TextDecrease, "Меньше") { font = (font - 0.1f).coerceAtLeast(0.8f); persist() }
                    MiniButton(Icons.Default.TextIncrease, "Больше") { font = (font + 0.1f).coerceAtMost(2.6f); persist() }
                    MiniButton(Icons.Default.Opacity, "Прозрачность") {
                        alpha = if (alpha <= 0.35f) 1f else (alpha - 0.25f); persist()
                    }
                    MiniButton(Icons.Default.FilterList, "Фильтры чата") { filtersOpen = true }
                    MiniButton(Icons.Default.Close, "Закрыть") { onClose() }
                }
            }

            val chatStatus = notice.ifEmpty {
                when {
                    messages.isEmpty() -> "Сообщений пока нет"
                    visibleMessages.isEmpty() -> "Нет видимых сообщений"
                    else -> ""
                }
            }
            if (chatStatus.isNotBlank()) {
                Text(chatStatus, Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = Color.White, fontSize = 12.sp)
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = PaddingValues(
                        start = 10.dp, end = if (editing) 34.dp else 10.dp, top = 6.dp, bottom = 6.dp,
                    ),
                ) {
                    items(visibleMessages, key = { it.key }) { message ->
                        ChatMessageLine(message, font) { selectedMessage = message }
                    }
                }

                if (editing) {
                    Box(
                        Modifier
                            .align(Alignment.BottomEnd)
                            .size(30.dp)
                            .background(StreamAccent.copy(alpha = 0.85f), RoundedCornerShape(topStart = 8.dp))
                            .clickable(role = Role.Button) {
                                fullHeight = !fullHeight
                                persist()
                            }
                            .pointerInput(availableWidth, availableHeight) {
                                detectDragGestures(
                                    onDragStart = {
                                        if (fullHeight) {
                                            y = 0f
                                            h = availableHeight
                                            fullHeight = false
                                        }
                                    },
                                    onDragEnd = { persist() },
                                    onDragCancel = { persist() },
                                ) { change, drag ->
                                    change.consume()
                                    val maxW = availableWidth - x.coerceIn(0f, maxX)
                                    val maxH = availableHeight - y.coerceIn(0f, maxY)
                                    w = (w.coerceIn(minWidth, maxW) + drag.x / density.density).coerceIn(minWidth, maxW)
                                    h = (h.coerceIn(minHeight, maxH) + drag.y / density.density).coerceIn(minHeight, maxH)
                                }
                            },
                    ) {
                        Icon(
                            if (fullHeight) Icons.Default.CloseFullscreen else Icons.Default.OpenInFull,
                            if (fullHeight) "Вернуть размер чата" else "Чат на всю высоту",
                            tint = Color(0xFF06222B),
                            modifier = Modifier.align(Alignment.Center).size(16.dp),
                        )
                    }
                }
            }
        }
    }
    if (filtersOpen) {
        ChatFiltersDialog(cfg.chatFilters, { onChange(cfg.copy(chatFilters = it)) }, { filtersOpen = false })
    }
    selectedMessage?.let { message ->
        HideMessageDialog(message, cfg.chatFilters, {
            onChange(cfg.copy(chatFilters = it))
            selectedMessage = null
        }, { selectedMessage = null })
    }
}

@Composable
private fun MiniButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(34.dp)) {
        Icon(icon, label, tint = Color.White, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun StatusChip(status: StreamStatus, resolution: Resolution, viewers: Long?, expanded: Boolean, onToggle: () -> Unit) {
    val (label, tint) = when (status.state) {
        LiveState.IDLE -> "Не в эфире" to StreamMuted
        LiveState.CONNECTING -> "Подключение…" to Color(0xFFFFCB88)
        LiveState.RETRYING -> "Переподключение…" to Color(0xFFFFCB88)
        LiveState.WAITING_NETWORK -> "Ждём сеть…" to Color(0xFFFFCB88)
        LiveState.STOPPING -> "Завершение эфира…" to StreamMuted
        LiveState.FAILED -> status.error.ifBlank { "Ошибка" } to MaterialTheme.colorScheme.error
        LiveState.LIVE -> "LIVE" to Color(0xFFFF5779)
    }
    val shape = RoundedCornerShape(16.dp)
    val chip = Modifier.clip(shape).background(StreamChrome).border(1.dp, StreamOutline, shape)
    val clickableChip = if (status.isPublishing) {
        chip.clickable(
            role = Role.Button,
            onClickLabel = if (expanded) "Скрыть параметры эфира" else "Показать параметры эфира",
            onClick = onToggle,
        )
    } else chip
    Column(clickableChip.padding(horizontal = 11.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(Modifier.size(7.dp).background(tint, CircleShape))
            Text(
                label,
                color = if (status.state == LiveState.LIVE) Color.White else tint,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (status.state == LiveState.LIVE) ViewerCount(viewers)
        }
        if (expanded && status.isPublishing) {
            var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
            LaunchedEffect(status.startedAt) {
                while (status.startedAt > 0L) {
                    now = System.currentTimeMillis()
                    delay(1000)
                }
            }
            val bitrate = status.bitrateKbps.takeIf { it > 0 }?.toString() ?: "—"
            val elapsed = if (status.startedAt > 0L) {
                val seconds = ((now - status.startedAt) / 1000).coerceAtLeast(0)
                "%d:%02d:%02d · ".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
            } else ""
            Text("$elapsed${resolution.label} · $bitrate кбит/с", color = StreamMuted, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun ViewerCount(viewers: Long?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Icons.Default.Visibility, "Зрители", modifier = Modifier.size(13.dp), tint = Color.White.copy(alpha = 0.88f))
        Text(viewers?.toString() ?: "—", color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

@Composable
private fun ScreenLightFrame() {
    Box(Modifier.fillMaxSize().border(22.dp, Color.White))
}

@Composable
private fun RoundIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color = Color.White,
    enabled: Boolean = true,
    size: Dp = 52.dp,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(size).background(StreamChrome, CircleShape)) {
        Icon(icon, label, modifier = Modifier.size(22.dp), tint = if (enabled) tint else tint.copy(alpha = 0.35f))
    }
}

@Composable
internal fun DonationConnection(
    account: DonationAccount,
    clientId: String,
    enabled: Boolean,
    alertsEnabled: Boolean,
    onReplay: (Donation) -> Unit,
) {
    val token by account.token.collectAsState()
    val notice by account.notice.collectAsState()
    val authorizing by account.authorizing.collectAsState()
    val latest by account.latest.collectAsState()
    val context = LocalContext.current
    Column(Modifier.padding(top = 8.dp)) {
        Text("DonationAlerts", style = MaterialTheme.typography.titleSmall, color = Color.White)
        Text(
            if (clientId.isBlank()) "Профиль алертов не добавлен" else notice,
            style = MaterialTheme.typography.bodySmall,
        )
        if (clientId.isNotBlank()) {
            when {
                authorizing -> TextButton(onClick = account::cancelAuthorization) { Text("Отменить вход") }
                token.isNotEmpty() -> {
                    latest?.let { donation ->
                        TextButton(enabled = alertsEnabled, onClick = { onReplay(donation) }) { Text("Повторить последний донат") }
                    }
                    TextButton(enabled = enabled, onClick = account::disconnect) { Text("Отключить") }
                }
                else -> TextButton(
                    enabled = enabled,
                    onClick = { account.authorize(clientId) { context.startActivity(Intent(Intent.ACTION_VIEW, it)) } },
                ) { Text("Подключить DonationAlerts") }
            }
        }
    }
}
