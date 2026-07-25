package com.tchat.live.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF9C7BFF),
    onPrimary = Color(0xFF1A1030),
    secondary = Color(0xFF4DD0C7),
    onSecondary = Color(0xFF00201D),
    background = Color(0xFF0E0B16),
    onBackground = Color(0xFFEDE9F7),
    surface = Color(0xFF171226),
    onSurface = Color(0xFFEDE9F7),
    surfaceVariant = Color(0xFF231C38),
    onSurfaceVariant = Color(0xFFBBB3D0),
    error = Color(0xFFFF6B6B),
)

@Composable
fun TChatLiveTheme(content: @Composable () -> Unit) {
    // Стримерское приложение — всегда тёмная тема, как в OBS/Prism.
    MaterialTheme(colorScheme = DarkColors, content = content)
}
