package com.tchat.stream

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONException
import java.io.IOException

private enum class UpdateTask { CHECK, DOWNLOAD, INSTALL }

@Composable
internal fun StreamUpdatePanel(installEnabled: Boolean) {
    val context = LocalContext.current
    val updates = remember(context) { StreamUpdates(context.applicationContext) }
    val scope = rememberCoroutineScope()
    val mayInstall by rememberUpdatedState(installEnabled)
    var channel by rememberSaveable { mutableStateOf("") }
    val release = remember(channel) { channel.takeIf { it.isNotEmpty() }?.let(StreamRelease::parse) }
    val newer = release?.takeIf { it.code > BuildConfig.VERSION_CODE }
    var ready by rememberSaveable { mutableStateOf(false) }
    var awaitingPermission by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    var task by remember { mutableStateOf<UpdateTask?>(null) }
    var percent by remember { mutableIntStateOf(0) }

    fun run(action: UpdateTask, block: suspend () -> Unit) {
        if (task != null) return
        task = action
        error = ""
        scope.launch {
            try {
                block()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: StreamUpdateError) {
                error = failure.message.orEmpty()
            } catch (_: IOException) {
                error = "Не удалось завершить загрузку. Проверьте подключение к сети и свободное место."
            } catch (_: JSONException) {
                error = "GitHub вернул неполные сведения о версии."
            } catch (_: IllegalArgumentException) {
                error = "Не удалось проверить данные обновления."
            } catch (_: SecurityException) {
                error = "Android не разрешил установку обновления."
            } catch (_: ActivityNotFoundException) {
                error = "Системный установщик Android недоступен."
            } finally {
                task = null
            }
        }
    }

    fun checkVersion() = run(UpdateTask.CHECK) {
        val raw = updates.readChannel()
        if (channel != raw) ready = false
        channel = raw
    }
    fun install(candidate: StreamRelease) = run(UpdateTask.INSTALL) {
        val intent = try {
            updates.installer(candidate)
        } catch (failure: IOException) {
            ready = false
            throw failure
        }
        if (mayInstall) context.startActivity(intent)
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (awaitingPermission) {
            awaitingPermission = false
            if (context.packageManager.canRequestPackageInstalls()) {
                if (newer != null && mayInstall) install(newer)
            } else {
                error = "Для обновления разрешите установку из этого источника в настройках Android."
            }
        }
    }

    val status = when {
        error.isNotEmpty() -> error
        task == UpdateTask.CHECK -> "Проверяем версию на GitHub…"
        task == UpdateTask.DOWNLOAD -> "Скачивание · $percent %"
        task == UpdateTask.INSTALL -> "Проверяем подпись APK…"
        newer != null && ready -> "Версия ${newer.name} готова к установке"
        newer != null -> "Доступна версия ${newer.name} · ${Formatter.formatShortFileSize(context, newer.bytes)}"
        release == null -> ""
        release.code == BuildConfig.VERSION_CODE -> "Установлена последняя версия"
        else -> "Установленная версия новее опубликованной."
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(16.dp))
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StreamMark(Modifier.size(42.dp))
            Column {
                Text("TChat Stream", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface)
                Text("Версия ${BuildConfig.VERSION_NAME} · сборка ${BuildConfig.VERSION_CODE}",
                    style = MaterialTheme.typography.bodySmall, color = StreamMuted)
            }
        }
        if (status.isNotEmpty()) {
            Text(status, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodyMedium,
                color = if (error.isEmpty()) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error)
        }
        if (task == UpdateTask.DOWNLOAD) {
            LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
        } else if (task != null) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (newer != null && !installEnabled) {
            Text("Завершите эфир, чтобы установить обновление.", color = StreamMuted, style = MaterialTheme.typography.bodySmall)
        }
        if (newer == null) {
            Button(onClick = ::checkVersion, enabled = task == null, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Проверить версию")
            }
        } else {
            Button(
                onClick = {
                    when {
                        !ready -> run(UpdateTask.DOWNLOAD) {
                            percent = 0
                            updates.download(newer) { percent = it }
                            ready = true
                        }
                        context.packageManager.canRequestPackageInstalls() -> install(newer)
                        else -> {
                            error = ""
                            awaitingPermission = true
                            try {
                                permission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
                            } catch (_: ActivityNotFoundException) {
                                awaitingPermission = false
                                error = "Откройте настройки Android и разрешите установку из этого источника."
                            } catch (_: SecurityException) {
                                awaitingPermission = false
                                error = "Android не разрешил открыть настройки установки."
                            }
                        }
                    }
                },
                enabled = task == null && installEnabled,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (ready) "Установить обновление" else "Скачать обновление") }
            if (task == null) TextButton(onClick = ::checkVersion) { Text("Проверить ещё раз") }
        }
    }
}
