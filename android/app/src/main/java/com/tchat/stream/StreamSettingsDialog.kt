package com.tchat.stream

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlin.math.roundToInt

internal enum class SettingsPage(val label: String) {
    STREAM("Эфир"), CHAT("Чат"), VIDEO("Видео"), ALERTS("Алерты"),
}

@Composable
internal fun StreamSettingsDialog(
    initial: StreamSettings,
    initialPage: SettingsPage,
    qualityEnabled: Boolean,
    donationAccount: DonationAccount,
    donationClientId: String,
    onReplay: (Donation) -> Unit,
    onDismiss: () -> Unit,
    onSave: (StreamSettings) -> Unit,
) {
    var draft by remember { mutableStateOf(initial) }
    var page by remember { mutableStateOf(initialPage) }
    val badRtmp = draft.rtmpUrl.isNotBlank() && !draft.hasRtmpServer()
    val channel = draft.chatPlatform.normalize(draft.chatAddress)
    val badChannel = draft.chatAddress.isNotBlank() && channel == null

    Dialog(onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.safeDrawingPadding().padding(14.dp), contentAlignment = Alignment.Center) {
            val limit = minOf(maxHeight, 510.dp)
            Surface(
                modifier = Modifier.widthIn(max = 468.dp).fillMaxWidth().heightIn(max = limit),
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, StreamOutline),
                shadowElevation = 14.dp,
            ) {
                Column(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 18.dp, end = 9.dp, top = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Настройки", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        IconButton(onDismiss, modifier = Modifier.size(42.dp)) {
                            Icon(Icons.Default.Close, "Закрыть настройки", tint = StreamMuted)
                        }
                    }
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 7.dp)) {
                        ChoiceRail(SettingsPage.entries, page, SettingsPage::label, onChoose = { page = it })
                    }
                    key(page) {
                        Column(
                            Modifier.weight(1f, fill = false).fillMaxWidth()
                                .verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 9.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            when (page) {
                                SettingsPage.STREAM -> {
                                    SettingsField("RTMP-адрес", draft.rtmpUrl, "Адрес сервера из студии",
                                        enabled = qualityEnabled, error = badRtmp) { draft = draft.copy(rtmpUrl = it) }
                                    SettingsField("Ключ трансляции", draft.streamKey, "",
                                        enabled = qualityEnabled, password = true) { draft = draft.copy(streamKey = it) }
                                    if (badRtmp) Text("Проверьте RTMP-адрес.", color = MaterialTheme.colorScheme.error)
                                }
                                SettingsPage.CHAT -> {
                                    ChoiceRail(ChatPlatform.entries, draft.chatPlatform, ChatPlatform::label, onChoose = {
                                        draft = draft.copy(chatPlatform = it)
                                    })
                                    SettingsField("Канал", draft.chatAddress, draft.chatPlatform.addressHint, error = badChannel) {
                                        draft = draft.withChatAddress(it)
                                    }
                                    if (badChannel) Text(draft.chatPlatform.addressHint, color = MaterialTheme.colorScheme.error)
                                    SettingSwitch("Чат на экране", null, draft.chatEnabled) { draft = draft.copy(chatEnabled = it) }
                                }
                                SettingsPage.VIDEO -> {
                                    SettingSwitch("Экономия энергии", "До 30 к/с и ниже яркость в эфире", draft.economy,
                                        enabled = qualityEnabled) { draft = draft.copy(economy = it) }
                                    Text("Кадр", style = MaterialTheme.typography.labelLarge)
                                    ChoiceRail(StreamOrientation.entries, draft.orientation, StreamOrientation::label,
                                        enabled = { qualityEnabled }) { draft = draft.copy(orientation = it) }
                                    ChoiceRail(Resolution.entries, draft.resolution, Resolution::label,
                                        enabled = { qualityEnabled }) { draft = draft.copy(resolution = it) }
                                    ChoiceRail(listOf(30, 60), draft.streamFps, { "$it к/с" },
                                        enabled = { qualityEnabled && (!draft.economy || it == 30) }) { draft = draft.copy(fps = it) }
                                    Text("Битрейт  ${draft.bitrateKbps} кбит/с", style = MaterialTheme.typography.labelLarge)
                                    Slider(
                                        value = draft.bitrateKbps.toFloat(),
                                        onValueChange = { draft = draft.copy(bitrateKbps = it.roundToInt()) },
                                        enabled = qualityEnabled,
                                        valueRange = MIN_BITRATE_KBPS.toFloat()..MAX_BITRATE_KBPS.toFloat(),
                                        steps = (MAX_BITRATE_KBPS - MIN_BITRATE_KBPS) / 250 - 1,
                                    )
                                    Text("Подавление мерцания", style = MaterialTheme.typography.labelLarge)
                                    ChoiceRail(AntiFlicker.entries, draft.antiFlicker, AntiFlicker::label) {
                                        draft = draft.copy(antiFlicker = it)
                                    }
                                }
                                SettingsPage.ALERTS -> {
                                    SettingSwitch("Алерты в эфире", null, draft.widgetsEnabled) { draft = draft.copy(widgetsEnabled = it) }
                                    DonationConnection(donationAccount, donationClientId, qualityEnabled, draft.widgetsEnabled, onReplay)
                                }
                            }
                        }
                    }
                    HorizontalDivider(color = StreamOutline.copy(alpha = 0.66f))
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    ) {
                        TextButton(onDismiss) { Text("Отмена") }
                        Button(onClick = {
                            when {
                                badRtmp -> page = SettingsPage.STREAM
                                badChannel -> page = SettingsPage.CHAT
                                else -> onSave(draft.withChatAddress(channel.orEmpty()))
                            }
                        }) { Text("Сохранить") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsField(
    label: String,
    value: String,
    hint: String,
    enabled: Boolean = true,
    error: Boolean = false,
    password: Boolean = false,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        placeholder = if (hint.isBlank()) null else ({ Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis) }),
        enabled = enabled,
        isError = error,
        singleLine = true,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else KeyboardType.Uri),
        shape = RoundedCornerShape(12.dp),
    )
}

@Composable
private fun SettingSwitch(
    title: String,
    summary: String?,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (summary != null) Text(summary, color = StreamMuted, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked, onChange, enabled = enabled)
    }
}

@Composable
private fun <T> ChoiceRail(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    enabled: (T) -> Boolean = { true },
    onChoose: (T) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(13.dp))
            .padding(3.dp).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        options.forEach { option ->
            val chosen = option == selected
            val interactive = enabled(option)
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(10.dp))
                    .then(if (chosen) Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh) else Modifier)
                    .selectable(chosen, enabled = interactive, role = Role.Tab, onClick = { onChoose(option) })
                    .heightIn(min = 37.dp).padding(horizontal = 3.dp, vertical = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label(option),
                    color = when {
                        chosen -> StreamAccent
                        interactive -> MaterialTheme.colorScheme.onSurface
                        else -> StreamMuted.copy(alpha = 0.42f)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
