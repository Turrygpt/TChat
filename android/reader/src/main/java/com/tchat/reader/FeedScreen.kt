package com.tchat.reader

import android.os.SystemClock
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tchat.stream.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos

private enum class FeedFilter(val label: String) {
    ALL("Все"), CHAT("Чат"), EVENTS("События"), DONATIONS("Донаты");

    fun matches(item: FeedItem) = when (this) {
        ALL -> true
        CHAT -> item.message.kind in setOf(ChatKind.VIEWER, ChatKind.BOT)
        EVENTS -> item.message.kind !in setOf(ChatKind.VIEWER, ChatKind.BOT, ChatKind.DONATION)
        DONATIONS -> item.message.kind == ChatKind.DONATION || item.message.kind == ChatKind.MUSIC && item.message.amountLabel.isNotBlank()
    }
}

private val Source.icon: Int get() = when (this) {
    Source.VK -> R.drawable.ic_vk
    Source.TWITCH -> R.drawable.ic_twitch
    Source.YOUTUBE -> R.drawable.ic_youtube
    Source.DONATION_ALERTS -> R.drawable.ic_donationalerts
    Source.DONATE_PAY -> R.drawable.ic_donatepay
    Source.RUTUBE -> R.drawable.ic_rutube
    Source.TCHAT -> R.drawable.ic_reader
}

private val nickPalette = listOf(
    0xFFff7a90, 0xFF70f0a8, 0xFF82b7ff, 0xFFffd166, 0xFFc792ea, 0xFF4dd8d8,
    0xFFff9f68, 0xFFb8f46a, 0xFFf78cff, 0xFF8ee3ff, 0xFFe06c75, 0xFF98c379,
    0xFF61afef, 0xFFe5c07b, 0xFFc678dd, 0xFF56b6c2, 0xFFd19a66, 0xFF7ec8e3,
    0xFFf4a261, 0xFF2a9d8f, 0xFFe76f51, 0xFFa8dadc, 0xFF457b9d, 0xFFfab283,
).map { readableNickColor(Color(it)) }
private val hexColor = Regex("#[0-9a-fA-F]{6}")

internal fun nickColor(source: Source, author: String, supplied: String): Color {
    if (hexColor.matches(supplied)) return readableNickColor(Color(0xFF000000 or supplied.drop(1).toLong(16)))
    val platform = when (source) {
        Source.DONATION_ALERTS -> "donationalerts"
        Source.DONATE_PAY -> "donatepay"
        Source.TCHAT -> "demo"
        else -> source.name.lowercase()
    }
    val key = "$platform:${author.ifBlank { "Зритель" }}"
    var hash = 0u
    // Match the desktop for-of / charCodeAt(0) hash, including supplementary Unicode characters.
    var index = 0
    while (index < key.length) {
        hash = hash * 33u + key[index].code.toUInt()
        index += Character.charCount(key.codePointAt(index))
    }
    return nickPalette[(hash % nickPalette.size.toUInt()).toInt()]
}

internal const val MIN_FONT = 12f
internal const val MAX_FONT = 36f

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FeedScreen(
    items: List<FeedItem>, statuses: Map<Source, String>, viewers: Map<Source, Long> = emptyMap(),
    filters: ChatFilters = ChatFilters(), onFilters: (ChatFilters) -> Unit = {},
    savedFont: Float = 16f, onFontSize: (Float) -> Unit = {},
    donationAction: (() -> Unit)? = null, donationLabel: String = "Подключить DonationAlerts", donationState: String = "",
    updateControls: @Composable () -> Unit = {}, onSources: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(FeedFilter.ALL) }
    var menu by rememberSaveable { mutableStateOf(false) }
    var editFilters by rememberSaveable { mutableStateOf(false) }
    var chosen by remember { mutableStateOf<ChatMessage?>(null) }
    var font by rememberSaveable { mutableFloatStateOf(savedFont.coerceIn(MIN_FONT, MAX_FONT)) }
    val saveFont by rememberUpdatedState(onFontSize)
    val visible = remember(items, tab, filters) { items.filter { tab.matches(it) && !filters.hides(it.message) } }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().weight(1f).testTag("reader-chat").pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                var pinching = false
                do {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    if (event.changes.count { it.pressed } >= 2) {
                        pinching = true
                        font = (font * event.calculateZoom()).coerceIn(MIN_FONT, MAX_FONT)
                    }
                    if (pinching) event.changes.forEach { it.consume() }
                } while (event.changes.any { it.pressed })
                if (pinching) saveFont(font)
            }
        }) {
            if (visible.isEmpty()) {
                val issue = statuses.entries.firstOrNull { it.value !in setOf("Подключено", "Подключение…") }
                Text(when {
                    statuses.isEmpty() -> "Подключите источники в настройках"
                    items.any(tab::matches) -> "Сообщения скрыты фильтрами"
                    issue != null -> "${issue.key.label} · ${issue.value}"
                    tab == FeedFilter.EVENTS -> "Пока нет событий"
                    tab == FeedFilter.DONATIONS -> "Пока нет донатов"
                    else -> "Пока нет сообщений"
                }, Modifier.align(Alignment.Center).padding(24.dp), textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else key(tab) { MessageList(visible, font) { chosen = it } }
        }
        StatusBar(statuses, viewers, onSettings = { menu = true })
    }
    if (menu) ModalBottomSheet(onDismissRequest = { menu = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 12.dp)) {
            Text("Настройки", Modifier.padding(bottom = 5.dp), style = MaterialTheme.typography.titleLarge)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                FeedFilter.entries.forEachIndexed { index, option ->
                    SegmentedButton(selected = tab == option, onClick = { tab = option; menu = false }, icon = {},
                        contentPadding = PaddingValues(horizontal = 2.dp),
                        shape = SegmentedButtonDefaults.itemShape(index, FeedFilter.entries.size)) {
                        Text(option.label, maxLines = 1)
                    }
                }
            }
            ListItem(colors = ListItemDefaults.colors(containerColor = Color.Transparent), headlineContent = { Text("Источники") }, leadingContent = { Icon(Icons.Outlined.Hub, null) },
                modifier = Modifier.clickable { menu = false; onSources() })
            ListItem(colors = ListItemDefaults.colors(containerColor = Color.Transparent), headlineContent = { Text("Фильтры чата") }, leadingContent = { Icon(Icons.Outlined.Tune, null) },
                modifier = Modifier.clickable { menu = false; editFilters = true })
            if (donationAction != null) ListItem(colors = ListItemDefaults.colors(containerColor = Color.Transparent), headlineContent = { Text(donationLabel) },
                supportingContent = { if (donationState.isNotBlank()) Text(donationState) },
                leadingContent = { Image(painterResource(Source.DONATION_ALERTS.icon), null, Modifier.size(24.dp)) },
                modifier = Modifier.clickable(onClick = donationAction))
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Размер текста", Modifier.weight(1f))
                IconButton(enabled = font > MIN_FONT, onClick = { font = (font - 1).coerceAtLeast(MIN_FONT); saveFont(font) }) {
                    Icon(Icons.Outlined.Remove, "Уменьшить шрифт")
                }
                Text(kotlin.math.round(font).toInt().toString())
                IconButton(enabled = font < MAX_FONT, onClick = { font = (font + 1).coerceAtMost(MAX_FONT); saveFont(font) }) {
                    Icon(Icons.Outlined.Add, "Увеличить шрифт")
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 5.dp), thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
            updateControls()
        }
    }
    if (editFilters) ChatFiltersDialog(filters, onFilters) { editFilters = false }
    chosen?.let { message -> HideMessageDialog(message, filters, { onFilters(it); chosen = null }, { chosen = null }) }
}

@Composable
private fun StatusBar(statuses: Map<Source, String>, viewers: Map<Source, Long>, onSettings: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).padding(horizontal = 10.dp, vertical = 3.dp),
        shape = RoundedCornerShape(18.dp), color = colors.surfaceContainerLow,
        border = BorderStroke(0.75.dp, colors.outlineVariant.copy(alpha = 0.78f))) {
        Row(Modifier.padding(start = 12.dp, end = 1.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f, fill = false).padding(end = 10.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                if (viewers.isNotEmpty()) Icon(Icons.Outlined.Visibility, "Зрители онлайн", Modifier.size(16.dp), tint = colors.onSurfaceVariant)
                val sources = Source.entries.filter { it in statuses || it in viewers }
                if (sources.isEmpty()) Text("Нет подключений", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                sources.forEach { source ->
                    val status = statuses[source] ?: "Нет данных о подключении"
                    val count = viewers[source]
                    val dot = when (status) {
                        "Подключено" -> Color(0xFF88C9A9)
                        "Подключение…" -> Color(0xFFE5BD80)
                        else -> Color(0xFFDE8E87)
                    }
                    Row(Modifier.clearAndSetSemantics { contentDescription = "${source.label}, $status" +
                        (count?.let { ", зрителей $it" } ?: "") }, verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Box(Modifier.size(23.dp)) {
                            Image(painterResource(source.icon), null, Modifier.size(18.dp).align(Alignment.CenterStart))
                            Box(Modifier.align(Alignment.BottomEnd).size(10.dp).background(colors.surfaceContainerLow, CircleShape)
                                .padding(2.dp).background(dot, CircleShape))
                        }
                        if (count != null) Text(count.toString(), style = MaterialTheme.typography.labelLarge.copy(
                            fontFeatureSettings = "tnum", fontWeight = FontWeight.SemiBold))
                    }
                }
            }
            VerticalDivider(Modifier.height(19.dp), thickness = 0.75.dp, color = colors.outlineVariant)
            IconButton(onClick = onSettings) { Icon(Icons.Outlined.Settings, "Настройки", Modifier.size(20.dp), tint = colors.primary) }
        }
    }
}

@Composable
private fun MessageList(messages: List<FeedItem>, font: Float, onSelect: (ChatMessage) -> Unit) {
    val list = rememberLazyListState()
    var follow by rememberSaveable { mutableStateOf(true) }
    LaunchedEffect(list) {
        snapshotFlow { if (list.isScrollInProgress) !list.canScrollBackward else null }
            .collect { atStart -> if (atStart != null) follow = atStart }
    }
    LaunchedEffect(messages.first().message.key) { if (follow) list.requestScrollToItem(0) }
    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 1.dp)) {
        items(messages, key = { it.message.key }) { item -> MessageRow(item, font, onSelect) }
    }
}

private const val PLATFORM_MARK = "reader-platform"

internal fun eventPulseAlpha(remaining: Long): Float {
    if (remaining <= 0L) return 0f
    val age = HIGHLIGHT_DURATION_MS - remaining.coerceAtMost(HIGHLIGHT_DURATION_MS)
    val wave = ((1 + cos(age * 2 * PI / 1800)) / 2).toFloat()
    return 0.04f + (EVENT_PULSE_MAX_ALPHA - 0.04f) * wave
}

@Composable
private fun MessageRow(item: FeedItem, font: Float, onSelect: (ChatMessage) -> Unit) {
    val message = item.message
    val colors = MaterialTheme.colorScheme
    val kind = when (message.kind) {
        ChatKind.DONATION -> "Донат"
        ChatKind.RAID -> "Рейд"
        ChatKind.FOLLOW -> "Фолловер"
        ChatKind.SUBSCRIPTION -> "Подписка"
        ChatKind.REWARD -> "Награда"
        ChatKind.MUSIC -> "Заказ"
        ChatKind.NOTICE -> "Событие"
        else -> ""
    }
    val source = item.source
    val line = remember(message, source, colors, font) { buildAnnotatedString {
        appendInlineContent(PLATFORM_MARK, source.label)
        append('\u00A0')
        withStyle(SpanStyle(color = nickColor(source, message.author, message.authorColor), fontWeight = FontWeight.SemiBold)) {
            append(message.author.ifBlank { "Аноним" })
        }
        if (kind.isNotEmpty()) withStyle(SpanStyle(color = colors.onSurfaceVariant, fontSize = (font * 0.87f).sp)) {
            append(" · $kind")
        }
        if (message.amountLabel.isNotBlank()) withStyle(SpanStyle(color = Color(0xFFE9CCA2), fontWeight = FontWeight.SemiBold)) {
            append(" " + message.amountLabel)
        }
        if (message.text.isNotBlank()) {
            append(": ")
            appendChatParts(message.parts)
        }
    } }
    val iconSize = font.sp
    val emotes = chatInlineEmotes(message.parts, (font * 1.28f).sp)
    val inlineContent = remember(source, iconSize, emotes) {
        emotes + (PLATFORM_MARK to InlineTextContent(Placeholder(iconSize, iconSize, PlaceholderVerticalAlign.TextCenter)) {
            Image(painterResource(source.icon), null, Modifier.fillMaxSize())
        })
    }
    val tint = eventTint(message.kind)
    val intensity = remember(item.highlightUntil) { mutableFloatStateOf(0f) }
    LaunchedEffect(item.highlightUntil) {
        val deadline = item.highlightUntil
        val remaining = (deadline - SystemClock.elapsedRealtime()).coerceIn(0L, HIGHLIGHT_DURATION_MS)
        if (remaining == 0L) return@LaunchedEffect
        if (currentCoroutineContext()[MotionDurationScale]?.scaleFactor == 0f) {
            intensity.floatValue = 0.16f
            delay(remaining)
        } else {
            animate(remaining.toFloat(), 0f, animationSpec = tween(remaining.toInt(), easing = LinearEasing)) { value, _ ->
                intensity.floatValue = eventPulseAlpha(minOf(value.toLong(), deadline - SystemClock.elapsedRealtime()))
            }
        }
        intensity.floatValue = 0f
    }
    Text(line, Modifier.fillMaxWidth().drawBehind {
        val alpha = intensity.floatValue
        if (alpha > 0f) drawRoundRect(Brush.horizontalGradient(listOf(tint.copy(alpha = alpha), tint.copy(alpha = alpha * 0.18f))),
            cornerRadius = CornerRadius(9.dp.toPx()))
    }.combinedClickable(onClick = {}, onLongClickLabel = "Скрыть из чата", onLongClick = { onSelect(message) })
        .padding(vertical = 3.dp), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge,
        fontSize = font.sp, lineHeight = (font * 1.32f).sp, color = colors.onSurface)
    HorizontalDivider(thickness = 0.5.dp, color = colors.outlineVariant.copy(alpha = 0.42f))
}
