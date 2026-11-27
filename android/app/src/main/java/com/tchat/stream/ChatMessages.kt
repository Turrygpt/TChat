package com.tchat.stream

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatMessageLine(message: ChatMessage, font: Float, onHide: () -> Unit) {
    val text = remember(message) {
        buildAnnotatedString {
            val accent = if (message.kind == ChatKind.DONATION) Color(0xFFFFCC7A) else Color(0xFF8DE7F3)
            withStyle(SpanStyle(color = accent, fontWeight = FontWeight.SemiBold)) {
                append(listOf(message.author, message.amountLabel).filter { it.isNotEmpty() }.joinToString(" · "))
            }
            if (message.parts.isNotEmpty()) append("  ")
            appendChatParts(message.parts)
        }
    }
    val emotes = chatInlineEmotes(message.parts, (17f * font).sp)
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
