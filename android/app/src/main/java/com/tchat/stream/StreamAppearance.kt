package com.tchat.stream

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.provider.Settings as SystemSettings
import android.view.Window
import android.view.WindowManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme

internal val StreamAccent = Color(0xFFD5FA72)
internal val StreamChrome = Color(0xF0171B18)
internal val StreamOutline = Color(0xFF424940)
internal val StreamMuted = Color(0xFFBCC4B7)
internal val StreamInk = Color(0xFF171B18)
internal val StreamRed = Color(0xFFFF786E)

private val streamColors = darkColorScheme(
    primary = StreamAccent,
    onPrimary = StreamInk,
    primaryContainer = Color(0xFF343F26),
    onPrimaryContainer = StreamAccent,
    secondary = StreamMuted,
    surface = Color(0xFF161A17),
    onSurface = Color(0xFFF3F5EF),
    surfaceContainer = Color(0xFF202521),
    surfaceContainerHigh = Color(0xFF2B322B),
    background = Color(0xFF101310),
    onBackground = Color(0xFFF3F5EF),
    onSurfaceVariant = StreamMuted,
    outline = StreamOutline,
    error = StreamRed,
)

@Composable
internal fun StreamTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = streamColors, content = content)
}

@Composable
internal fun StreamMark(modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.ic_stream_mark), null,
        modifier.background(StreamInk, RoundedCornerShape(25)).padding(5.dp))
}

internal enum class ThermalLevel { NORMAL, WARM, HOT }

@Composable
internal fun currentThermalLevel(): ThermalLevel {
    val context = LocalContext.current
    val power = remember(context) { context.getSystemService(PowerManager::class.java) }
    var level by remember(power) {
        mutableStateOf(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) thermalLevel(power.currentThermalStatus) else ThermalLevel.NORMAL)
    }
    DisposableEffect(power) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val listener = PowerManager.OnThermalStatusChangedListener { level = thermalLevel(it) }
            power.addThermalStatusListener(context.mainExecutor, listener)
            onDispose { power.removeThermalStatusListener(listener) }
        } else onDispose {}
    }
    return level
}

private fun thermalLevel(status: Int): ThermalLevel = when {
    status >= PowerManager.THERMAL_STATUS_SEVERE -> ThermalLevel.HOT
    status >= PowerManager.THERMAL_STATUS_MODERATE -> ThermalLevel.WARM
    else -> ThermalLevel.NORMAL
}

@Composable
internal fun StreamDisplayPower(window: Window, publishing: Boolean, economy: Boolean, thermal: ThermalLevel, light: Boolean) {
    DisposableEffect(window, publishing, economy, thermal, light) {
        val attributes = window.attributes
        val beforeBrightness = attributes.screenBrightness
        val beforeRate = attributes.preferredRefreshRate
        val keptAwake = attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        val saving = publishing && economy
        if (light) {
            attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
        } else if (saving) {
            val ceiling = if (thermal == ThermalLevel.HOT) 0.24f else 0.43f
            val brightness = if (beforeBrightness >= 0f) beforeBrightness else {
                val systemLevel = SystemSettings.System.getInt(
                    window.context.contentResolver, SystemSettings.System.SCREEN_BRIGHTNESS, 255,
                )
                (systemLevel / 255f).coerceIn(0.04f, 1f)
            }
            attributes.screenBrightness = minOf(brightness, ceiling)
        }
        if (saving) attributes.preferredRefreshRate = 60f
        window.attributes = attributes
        if (publishing || light) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val power = window.context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (saving && power.isSustainedPerformanceModeSupported) window.setSustainedPerformanceMode(true)
        onDispose {
            window.attributes = window.attributes.apply {
                screenBrightness = beforeBrightness
                preferredRefreshRate = beforeRate
            }
            if (!keptAwake) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (saving && power.isSustainedPerformanceModeSupported) window.setSustainedPerformanceMode(false)
        }
    }
}
