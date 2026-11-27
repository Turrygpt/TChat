package com.tchat.reader

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.tchat.stream.ChatPlatform

@Composable
internal fun SourceSettings(
    settings: ReaderSettings,
    statuses: Map<Source, String>,
    savedClientId: String,
    signedIn: Boolean,
    donationNotice: String,
    authorizing: Boolean,
    twitchEventNotice: String = "",
    onAuthorize: (String) -> Unit,
    onDisconnect: () -> Unit,
    onCancelLogin: () -> Unit,
    onSave: (ReaderSettings) -> Unit,
    onBack: () -> Unit,
) {
    val fields = ChatPlatform.entries.associateWith { platform ->
        rememberSaveable(platform) { mutableStateOf(settings.channels[platform].orEmpty()) }
    }
    var payKey by remember { mutableStateOf(settings.donatePayKey) }
    var twitchToken by remember { mutableStateOf(settings.twitchToken) }
    var useDesktop by rememberSaveable { mutableStateOf(settings.useDesktop) }
    var server by rememberSaveable { mutableStateOf(settings.desktopUrl) }
    val serverUrl = desktopAddress(server)
    var clientId by rememberSaveable { mutableStateOf(savedClientId) }
    val channels = fields.mapNotNull { (platform, field) -> platform.normalize(field.value)?.let { platform to it } }.toMap()
    val valid = if (useDesktop) serverUrl != null else fields.all { (platform, field) -> field.value.isBlank() || platform in channels }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, top = 8.dp, end = 12.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("Источники", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold)
            TextButton(onClick = onBack) { Text("Назад") }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("Площадки", "Из TChat").forEachIndexed { index, label ->
                    SegmentedButton(selected = useDesktop == (index == 1), onClick = { useDesktop = index == 1 },
                        shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(label) }
                }
            }
            if (useDesktop) {
                Text("Укажите адрес запущенного TChat в вашей сети. Телефон получит чат и события его подключённых каналов.",
                    style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text("Адрес TChat") }, placeholder = { Text("http://192.168.1.10:3000") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    isError = server.isNotBlank() && serverUrl == null,
                    supportingText = { Text(if (server.isNotBlank() && serverUrl == null) "Введите адрес сервера и порт"
                        else statuses[Source.TCHAT] ?: "Используйте IP компьютера, на котором открыт TChat.") })
            } else {
                Text("Чаты", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("Укажите нужные каналы. Очистите поле, чтобы отключить источник.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (source in Source.entries) {
                    val platform = source.platform ?: continue
                    val field = fields.getValue(platform)
                    val invalid = field.value.isNotBlank() && platform !in channels
                    val saved = platform in channels && channels[platform] == settings.channels[platform]
                    val hint = when {
                        invalid -> "Проверьте адрес · ${platform.addressHint}"
                        saved -> statuses[source].orEmpty()
                        else -> platform.addressHint
                    }
                    OutlinedTextField(field.value, { field.value = it }, Modifier.fillMaxWidth(),
                        singleLine = true, isError = invalid, label = { Text(source.label) },
                        supportingText = { Text(hint) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                    if (platform == ChatPlatform.TWITCH && field.value.isNotBlank()) {
                        OutlinedTextField(twitchToken, { twitchToken = it }, Modifier.fillMaxWidth(), singleLine = true,
                            label = { Text("Токен Twitch для событий") }, visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            supportingText = { Text(if (saved && twitchToken == settings.twitchToken && twitchEventNotice.isNotEmpty())
                                twitchEventNotice else "Для фолловеров нужно право moderator:read:followers, для наград — channel:read:redemptions. Для чата и рейдов достаточно имени канала.") })
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.outlineVariant)
                Text("Донаты", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("DonationAlerts", style = MaterialTheme.typography.bodyLarge)
                Text(donationNotice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!signedIn && BuildConfig.DONATION_CLIENT_ID.isBlank()) {
                    OutlinedTextField(clientId, { if (it.all { char -> char in '0'..'9' }) clientId = it },
                        Modifier.fillMaxWidth(), singleLine = true, label = { Text("ID приложения DonationAlerts") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        supportingText = { Text("Укажите ID из раздела «Приложения» DonationAlerts.") })
                }
                when {
                    authorizing -> OutlinedButton(onClick = onCancelLogin) { Text("Отменить вход") }
                    signedIn -> OutlinedButton(onClick = onDisconnect) { Text("Отключить DonationAlerts") }
                    else -> OutlinedButton(onClick = { onAuthorize(clientId) }, enabled = clientId.isNotBlank()) {
                        Text("Войти в DonationAlerts")
                    }
                }
                OutlinedTextField(payKey, { payKey = it }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text("API-ключ DonatePay") }, visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    supportingText = {
                        val status = statuses[Source.DONATE_PAY]?.takeIf { settings.donatePayKey == payKey.trim() }
                        Text(status ?: "Ключ находится в разделе API личного кабинета DonatePay.")
                    })
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Button(onClick = {
            val next = if (useDesktop) settings.copy(useDesktop = true, desktopUrl = serverUrl.orEmpty())
                else settings.copy(channels = channels, donatePayKey = payKey.trim(),
                    twitchToken = twitchToken.trim().removePrefix("oauth:"), useDesktop = false)
            onSave(next)
        }, enabled = valid,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
            Text("Сохранить")
        }
    }
}
