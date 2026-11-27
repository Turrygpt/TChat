package com.tchat.stream

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

@Composable
internal fun ChatMessageLine(message: ChatMessage, font: Float, onHide: () -> Unit) {
    val text = remember(message) {
        buildAnnotatedString {
            val accent = if (message.kind == ChatKind.DONATION) Color(0xFFFFCC7A) else Color(0xFF8DE7F3)
            withStyle(SpanStyle(color = accent, fontWeight = FontWeight.SemiBold)) {
                append(listOf(message.author, message.amountLabel).filter { it.isNotEmpty() }.joinToString(" · "))
            }
            if (message.parts.isNotEmpty()) append("  ")
            message.parts.forEachIndexed { index, part ->
                when (part) {
                    is ChatPart.Text -> append(part.text)
                    is ChatPart.Emote -> appendInlineContent(index.toString(), part.name)
                }
            }
        }
    }
    val emotes = remember(message, font) {
        val size = (17f * font).sp
        buildMap {
            message.parts.forEachIndexed { index, part ->
                if (part is ChatPart.Emote) {
                    put(index.toString(), InlineTextContent(Placeholder(size, size, PlaceholderVerticalAlign.TextCenter)) {
                        AsyncImage(
                            model = part.url,
                            contentDescription = part.name,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Fit,
                        )
                    })
                }
            }
        }
    }
    Text(
        text = text,
        inlineContent = emotes,
        modifier = Modifier.fillMaxWidth()
            .combinedClickable(onClick = {}, onLongClickLabel = "Скрыть из чата", onLongClick = onHide)
            .padding(vertical = 2.dp),
        color = Color.White,
        fontSize = (13f * font).sp,
        lineHeight = (17f * font).sp,
        maxLines = 8,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
internal fun HideMessageDialog(
    message: ChatMessage,
    filters: ChatFilters,
    onChange: (ChatFilters) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Скрыть из чата") },
        text = {
            Column {
                if (message.author.isNotEmpty()) {
                    TextButton(
                        onClick = { onChange(filters.copy(authors = filters.authors + chatFilterKey(message.author))) },
                    ) { Text("Пользователь «${message.author}»") }
                }
                TextButton(
                    onClick = { onChange(filters.copy(kinds = filters.kinds + message.kind.name)) },
                ) { Text("Тип «${message.kind.label}»") }
                if (message.text.isNotEmpty()) {
                    TextButton(
                        onClick = { onChange(filters.copy(messages = filters.messages + chatFilterKey(message.text))) },
                    ) { Text("Сообщения с таким текстом") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}

@Composable
internal fun ChatFiltersDialog(filters: ChatFilters, onChange: (ChatFilters) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Фильтры чата") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                ChatKind.entries.forEach { kind ->
                    val visible = kind.name !in filters.kinds
                    Row(
                        Modifier.fillMaxWidth().toggleable(visible, role = Role.Switch) { show ->
                            onChange(filters.copy(kinds = if (show) filters.kinds - kind.name else filters.kinds + kind.name))
                        }.padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(kind.label, Modifier.weight(1f))
                        Switch(checked = visible, onCheckedChange = null)
                    }
                }
                if (filters.authors.isNotEmpty()) {
                    Text("Скрытые пользователи", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleSmall)
                    filters.authors.sorted().forEach { author ->
                        TextButton(onClick = { onChange(filters.copy(authors = filters.authors - author)) }) {
                            Text("Показать «$author»")
                        }
                    }
                }
                if (filters.messages.isNotEmpty()) {
                    Text("Скрытые сообщения", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleSmall)
                    filters.messages.sorted().forEach { message ->
                        TextButton(onClick = { onChange(filters.copy(messages = filters.messages - message)) }) {
                            Text("Показать «$message»", maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Готово") } },
    )
}
