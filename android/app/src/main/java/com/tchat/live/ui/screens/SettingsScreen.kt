package com.tchat.live.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.tchat.live.App
import com.tchat.live.data.AppSettings
import com.tchat.live.data.DestinationType
import com.tchat.live.data.QUALITY_PRESETS
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavController) {
    val app = App.instance
    val settings by app.settings.settings.collectAsState(initial = AppSettings())
    val scope = rememberCoroutineScope()

    fun save(block: (AppSettings) -> AppSettings) = scope.launch { app.settings.update(block) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { nav.popBackStack() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Назад")
            }
            Text("Настройки эфира", style = MaterialTheme.typography.headlineSmall)
        }

        Text("Куда стримим", style = MaterialTheme.typography.titleMedium)
        DestinationType.entries.forEach { dest ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .selectable(selected = settings.destination == dest, onClick = { save { it.copy(destination = dest) } }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = settings.destination == dest, onClick = { save { it.copy(destination = dest) } })
                Text(
                    when (dest) {
                        DestinationType.TWITCH -> "Twitch"
                        DestinationType.YOUTUBE -> "YouTube"
                        DestinationType.CUSTOM -> "Свой RTMP-адрес (VK, Rutube и др.)"
                    },
                )
            }
        }
        when (settings.destination) {
            DestinationType.TWITCH -> OutlinedTextField(
                value = settings.twitchKey,
                onValueChange = { v -> save { it.copy(twitchKey = v.trim()) } },
                label = { Text("Ключ трансляции Twitch") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            DestinationType.YOUTUBE -> OutlinedTextField(
                value = settings.youtubeKey,
                onValueChange = { v -> save { it.copy(youtubeKey = v.trim()) } },
                label = { Text("Ключ трансляции YouTube") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            DestinationType.CUSTOM -> {
                OutlinedTextField(
                    value = settings.customUrl,
                    onValueChange = { v -> save { it.copy(customUrl = v.trim()) } },
                    label = { Text("RTMP URL (rtmp://…)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = settings.customKey,
                    onValueChange = { v -> save { it.copy(customKey = v.trim()) } },
                    label = { Text("Ключ (если отдельно)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Spacer(Modifier.height(6.dp))
        Text("Качество", style = MaterialTheme.typography.titleMedium)
        QUALITY_PRESETS.forEachIndexed { index, preset ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .selectable(selected = settings.qualityIndex == index, onClick = { save { it.copy(qualityIndex = index) } }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = settings.qualityIndex == index, onClick = { save { it.copy(qualityIndex = index) } })
                Text(preset.label)
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                Text("Вертикальный эфир (9:16)")
                Text(
                    "Для клипов и мобильных зрителей",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(checked = settings.portrait, onCheckedChange = { v -> save { it.copy(portrait = v) } })
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("Звук приложений в эфир экрана")
                    Text(
                        "Микрофон + звук игры (Android 10+)",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = settings.mixInternalAudio, onCheckedChange = { v -> save { it.copy(mixInternalAudio = v) } })
            }
        }

        Spacer(Modifier.height(6.dp))
        Text("Оверлеи в кадре", style = MaterialTheme.typography.titleMedium)
        OverlayToggle("Чат", settings.overlayChat) { v -> save { it.copy(overlayChat = v) } }
        OverlayToggle("Алерты и донаты", settings.overlayAlerts) { v -> save { it.copy(overlayAlerts = v) } }
        OverlayToggle("Цель сбора", settings.overlayGoal) { v -> save { it.copy(overlayGoal = v) } }
        OverlayToggle("Стикеры", settings.overlayStickers) { v -> save { it.copy(overlayStickers = v) } }
        OverlayToggle("Чат слева (иначе справа)", settings.chatOnLeft) { v -> save { it.copy(chatOnLeft = v) } }
    }
}

@Composable
private fun OverlayToggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
        Spacer(Modifier.width(4.dp))
    }
}
