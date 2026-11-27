package com.tchat.reader

import androidx.compose.material3.Typography
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.ColorUtils
import com.tchat.stream.ChatKind

internal val ReaderShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(11.dp),
    medium = RoundedCornerShape(15.dp), large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
)

internal val ReaderColors = darkColorScheme(
    primary = Color(0xFFE1CCAA), onPrimary = Color(0xFF282219),
    primaryContainer = Color(0xFF39322A), onPrimaryContainer = Color(0xFFF6EAD7),
    secondary = Color(0xFFBEB8B0), onSecondary = Color(0xFF242321),
    secondaryContainer = Color(0xFF35332E), onSecondaryContainer = Color(0xFFEFE6D6),
    tertiary = Color(0xFF94BBAB), background = Color(0xFF101113), surface = Color(0xFF101113),
    surfaceContainerLow = Color(0xFF18191C), surfaceContainer = Color(0xFF1B1C20),
    surfaceContainerHigh = Color(0xFF202126), surfaceContainerHighest = Color(0xFF292A2E),
    onBackground = Color(0xFFEFEDE8), onSurface = Color(0xFFEFEDE8), onSurfaceVariant = Color(0xFFB1ADA8),
    outline = Color(0xFF6A6865), outlineVariant = Color(0xFF343438),
)

internal const val EVENT_PULSE_MAX_ALPHA = 0.21f

internal fun eventTint(kind: ChatKind): Color = when (kind) {
    ChatKind.DONATION -> Color(0xFFFFC276)
    ChatKind.RAID -> Color(0xFFBD9AFF)
    else -> ReaderColors.primary
}

// Use the same colour for an author on every row, with 8:1 contrast on the feed and 4.5:1 at peak highlight.
private val minimumNickLuminance = run {
    val surface = ReaderColors.surface
    val brightestEvent = listOf(ChatKind.DONATION, ChatKind.RAID, ChatKind.FOLLOW).maxOf { kind ->
        eventTint(kind).copy(alpha = EVENT_PULSE_MAX_ALPHA).compositeOver(surface).luminance()
    }
    maxOf(8f * (surface.luminance() + 0.05f), 4.5f * (brightestEvent + 0.05f)) - 0.05f
}

internal fun readableNickColor(original: Color): Color {
    if (original.luminance() >= minimumNickLuminance) return original
    val hsl = FloatArray(3)
    ColorUtils.colorToHSL(original.toArgb(), hsl)
    var low = (hsl[2] * 255).toInt()
    var high = 255
    while (low < high) {
        val middle = (low + high) / 2
        hsl[2] = middle / 255f
        if (Color(ColorUtils.HSLToColor(hsl)).luminance() >= minimumNickLuminance) {
            high = middle
        } else {
            low = middle + 1
        }
    }
    hsl[2] = high / 255f
    return Color(ColorUtils.HSLToColor(hsl))
}

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
internal val ReaderFont = FontFamily(*listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold).map { weight ->
    Font(R.font.reader_inter, weight, variationSettings = FontVariation.Settings(
        FontVariation.weight(weight.weight), FontVariation.Setting("opsz", 18f)))
}.toTypedArray())

internal val ReaderTypography = Typography().let { base ->
    base.copy(
        bodyLarge = base.bodyLarge.copy(fontFamily = ReaderFont, letterSpacing = (-0.14).sp),
        bodyMedium = base.bodyMedium.copy(fontFamily = ReaderFont, letterSpacing = 0.sp),
        bodySmall = base.bodySmall.copy(fontFamily = ReaderFont),
        titleLarge = base.titleLarge.copy(fontFamily = ReaderFont, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.65).sp),
        titleMedium = base.titleMedium.copy(fontFamily = ReaderFont, fontWeight = FontWeight.SemiBold),
        titleSmall = base.titleSmall.copy(fontFamily = ReaderFont),
        headlineSmall = base.headlineSmall.copy(fontFamily = ReaderFont, letterSpacing = (-0.55).sp),
        labelLarge = base.labelLarge.copy(fontFamily = ReaderFont, fontWeight = FontWeight.Medium, letterSpacing = 0.sp),
        labelMedium = base.labelMedium.copy(fontFamily = ReaderFont),
        labelSmall = base.labelSmall.copy(fontFamily = ReaderFont),
    )
}
