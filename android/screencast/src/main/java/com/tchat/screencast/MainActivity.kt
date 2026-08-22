package com.tchat.screencast

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) { App() }
        }
    }
}

@Composable
private fun App() {
    val context = LocalContext.current
    val activity = context as Activity
    val store = remember { Settings(context) }
    var settings by remember { mutableStateOf(store.load()) }
    fun update(s: CastSettings) { settings = s; store.save(s) }

    val status by CaptureService.status.collectAsState()
    var error by remember { mutableStateOf("") }

    val audioPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (!granted) error = "Без микрофона звук игры писать некому — включите доступ" }

    val notifPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* уведомление не критично для работы сервиса */ }

    val projectionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val serviceIntent = Intent(context, CaptureService::class.java).apply {
                action = CaptureService.ACTION_START
                putExtra(CaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(CaptureService.EXTRA_DATA, result.data)
                putExtra(CaptureService.EXTRA_RTMP_URL, settings.fullUrl)
                putExtra(CaptureService.EXTRA_FPS, settings.fps)
                putExtra(CaptureService.EXTRA_BITRATE, settings.bitrateKbps)
                putExtra(CaptureService.EXTRA_INTERNAL_AUDIO, !settings.micEnabled)
            }
            ContextCompat.startForegroundService(context, serviceIntent)
            error = ""
        } else {
            error = "Захват экрана не разрешён"
        }
    }

    fun requestStart() {
        if (settings.fullUrl.isBlank()) {
            error = "Укажите RTMP-адрес"
            return
        }
        if (!AndroidSettings.canDrawOverlays(context)) {
            error = "Разрешите показ поверх других приложений и нажмите «Начать» ещё раз"
            activity.startActivity(
                Intent(
                    AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${context.packageName}"),
                ),
            )
            return
        }
        if (settings.micEnabled &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            audioPermission.launch(android.Manifest.permission.RECORD_AUDIO)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        val projectionManager = context.getSystemService(MediaProjectionManager::class.java)
        error = ""
        projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
    }

    fun stop() {
        context.startService(
            Intent(context, CaptureService::class.java).apply { action = CaptureService.ACTION_STOP },
        )
    }

    val live = status.state == CastState.LIVE ||
        status.state == CastState.CONNECTING ||
        status.state == CastState.RETRYING

    Box(Modifier.fillMaxSize().background(Color(0xFF0E1016))) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(20.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("TChat: трансляция экрана", style = MaterialTheme.typography.titleLarge, color = Color.White)
            Text(
                "Передаёт то, что видно на экране (включая игру), и звук приложения в TChat по RTMP. " +
                    "Во время эфира можно свернуть приложение и открыть игру — управляйте плавающей кнопкой.",
                color = Color(0xFFAAB0C0),
                style = MaterialTheme.typography.bodySmall,
            )

            OutlinedTextField(
                value = settings.rtmpUrl,
                onValueChange = { update(settings.copy(rtmpUrl = it)) },
                label = { Text("RTMP-адрес (rtmp://…)") },
                placeholder = { Text("rtmp://192.168.1.2:1936/live") },
                singleLine = true,
                enabled = !live,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = settings.streamKey,
                onValueChange = { update(settings.copy(streamKey = it)) },
                label = { Text("Ключ трансляции") },
                singleLine = true,
                enabled = !live,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )

            Text("Частота кадров", color = Color.White)
            Row(Modifier.fillMaxWidth()) {
                listOf(30, 60).forEach { f ->
                    Row(
                        Modifier
                            .weight(1f)
                            .selectable(selected = settings.fps == f, enabled = !live) { update(settings.copy(fps = f)) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = settings.fps == f, onClick = { update(settings.copy(fps = f)) }, enabled = !live)
                        Text("$f fps", color = Color.White)
                    }
                }
            }

            Text("Битрейт: ${settings.bitrateKbps} кбит/с", color = Color.White)
            Slider(
                value = settings.bitrateKbps.toFloat(),
                onValueChange = { update(settings.copy(bitrateKbps = it.roundToInt())) },
                valueRange = MIN_BITRATE_KBPS.toFloat()..MAX_BITRATE_KBPS.toFloat(),
                enabled = !live,
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = settings.micEnabled, onCheckedChange = { update(settings.copy(micEnabled = it)) }, enabled = !live)
                Spacer(Modifier.width(8.dp))
                Column {
                    Text("Микрофон вместо звука игры", color = Color.White)
                    Text(
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            "Выключено — пишется звук самой игры (Android 10+)."
                        } else {
                            "На этой версии Android доступен только микрофон."
                        },
                        color = Color(0xFFAAB0C0),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            if (error.isNotBlank()) {
                Text(error, color = Color(0xFFFF6B6B))
            }

            StatusLine(status)

            Button(
                onClick = { if (live) stop() else requestStart() },
                colors = ButtonDefaults.buttonColors(containerColor = if (live) Color(0xFF616161) else Color(0xFFE53935)),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Text(if (live) "ОСТАНОВИТЬ" else "НАЧАТЬ ТРАНСЛЯЦИЮ")
            }

            if (live) {
                TextButton(onClick = { activity.moveTaskToBack(true) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Свернуть и переключиться на игру")
                }
            }
        }
    }
}

@Composable
private fun StatusLine(status: CastStatus) {
    val text = when (status.state) {
        CastState.IDLE -> "Не в эфире"
        CastState.CONNECTING -> "Подключение…"
        CastState.RETRYING -> "Переподключение… ${status.error}"
        CastState.FAILED -> "Ошибка: ${status.error}"
        CastState.LIVE -> "● В ЭФИРЕ · ${status.bitrateKbps} кбит/с"
    }
    Text(text, color = Color.White)
}
