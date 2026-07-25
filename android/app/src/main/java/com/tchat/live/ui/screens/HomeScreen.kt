package com.tchat.live.ui.screens

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.tchat.live.App
import com.tchat.live.Routes
import com.tchat.live.data.AppSettings
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: NavController) {
    val app = App.instance
    val settings by app.settings.settings.collectAsState(initial = AppSettings())
    val scope = rememberCoroutineScope()
    LocalContext.current

    var host by remember(settings.serverHost) { mutableStateOf(settings.serverHost) }
    var port by remember(settings.serverPort) { mutableStateOf(settings.serverPort.toString()) }
    var checking by remember { mutableStateOf(false) }
    var serverOk by remember { mutableStateOf<Boolean?>(null) }
    var donationSent by remember { mutableStateOf<Boolean?>(null) }
    // Автопроверка при входе, если адрес уже сохранён.
    LaunchedEffect(settings.serverHost, settings.serverPort) {
        if (settings.serverHost.isNotBlank()) {
            checking = true
            serverOk = app.api.health(settings.serverBaseUrl)
            checking = false
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("TChat Live", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Стрим с телефона: камера или экран, чат и алерты TChat прямо в кадре.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(4.dp))
        Text("TChat на ПК", style = MaterialTheme.typography.titleMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it.trim() },
                label = { Text("IP компьютера") },
                placeholder = { Text("192.168.1.10") },
                singleLine = true,
                modifier = Modifier.weight(2f),
            )
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit).take(5) },
                label = { Text("Порт") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(
                enabled = host.isNotBlank() && !checking,
                onClick = {
                    scope.launch {
                        app.settings.update { it.copy(serverHost = host, serverPort = port.toIntOrNull() ?: 3000) }
                        checking = true
                        serverOk = app.api.health("http://$host:${port.toIntOrNull() ?: 3000}")
                        checking = false
                    }
                },
            ) { Text("Сохранить и проверить") }
            Spacer(Modifier.width(12.dp))
            when {
                checking -> CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                serverOk == true -> Text("✓ на связи", color = MaterialTheme.colorScheme.secondary)
                serverOk == false -> Text("нет ответа", color = MaterialTheme.colorScheme.error)
            }
        }

        Spacer(Modifier.height(8.dp))
        Text("Эфир", style = MaterialTheme.typography.titleMedium)
        Button(onClick = { nav.navigate(Routes.STREAM_CAMERA) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.Videocam, null)
            Spacer(Modifier.width(8.dp))
            Text("Эфир с камеры")
        }
        Button(onClick = { nav.navigate(Routes.STREAM_SCREEN) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.PhoneAndroid, null)
            Spacer(Modifier.width(8.dp))
            Text("Эфир экрана")
        }

        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { nav.navigate(Routes.REMOTE) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.Tv, null)
            Spacer(Modifier.width(8.dp))
            Text("Пульт TChat")
        }
        OutlinedButton(onClick = { nav.navigate(Routes.SETTINGS) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.Settings, null)
            Spacer(Modifier.width(8.dp))
            Text("Настройки эфира")
        }
        OutlinedButton(
            enabled = serverOk == true,
            onClick = {
                scope.launch { donationSent = app.api.sendTestDonation(settings.serverBaseUrl) }
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Default.Favorite, null)
            Spacer(Modifier.width(8.dp))
            Text(
                when (donationSent) {
                    true -> "Тестовый донат отправлен!"
                    false -> "Не удалось отправить"
                    null -> "Тестовый донат"
                },
            )
        }
    }
}
