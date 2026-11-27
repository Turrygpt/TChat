package com.tchat.stream

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.provider.Settings as SystemSettings
import android.view.Window
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme

internal val StreamAccent = Color(0xFF89E5D7)
internal val StreamChrome = Color(0xEE121925)
internal val StreamOutline = Color(0xFF354354)
internal val StreamMuted = Color(0xFFACB8CA)
internal val StreamRed = Color(0xFFD90F3F)

private val streamColors = darkColorScheme(
    primary = StreamAccent,
    onPrimary = Color(0xFF063832),
    surface = Color(0xFF111924),
    onSurface = Color(0xFFF4F7FC),
    surfaceContainer = Color(0xFF1A2331),
    surfaceContainerHigh = Color(0xFF212D3D),
    background = Color(0xFF080D15),
    onBackground = Color(0xFFF4F7FC),
    onSurfaceVariant = StreamMuted,
    outline = StreamOutline,
    error = Color(0xFFFFB2B9),
)

@Composable
internal fun StreamTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = streamColors, content = content)
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
