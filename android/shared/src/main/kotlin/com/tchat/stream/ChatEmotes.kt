package com.tchat.stream

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.unit.TextUnit
import coil3.compose.AsyncImage

private val smileys = mapOf(
    ":)" to "🙂", ":-)" to "🙂", ":(" to "🙁", ":-(" to "🙁", ";)" to "😉", ";-)" to "😉",
    ":D" to "😃", ":-D" to "😃", ":P" to "😛", ":p" to "😛", "<3" to "❤️",
    ":smile:" to "😄", ":heart:" to "❤️", ":fire:" to "🔥", ":thumbsup:" to "👍", ":+1:" to "👍",
)
private val smileyToken = Regex("""(?<!\S)(?:${smileys.keys.joinToString("|", transform = Regex::escape)})(?!\S)""")

internal fun AnnotatedString.Builder.appendChatParts(parts: List<ChatPart>) {
    parts.forEachIndexed { index, part ->
        when (part) {
            is ChatPart.Text -> append(smileyToken.replace(part.text) { smileys.getValue(it.value) })
            is ChatPart.Emote -> appendInlineContent(index.toString(), part.name.ifBlank { "Смайлик" })
        }
    }
}

@Composable
internal fun chatInlineEmotes(parts: List<ChatPart>, size: TextUnit): Map<String, InlineTextContent> = remember(parts, size) {
    buildMap {
        parts.forEachIndexed { index, part ->
            if (part is ChatPart.Emote) {
                put(index.toString(), InlineTextContent(Placeholder(size, size, PlaceholderVerticalAlign.TextCenter)) {
                    var failed by remember(part.url) { mutableStateOf(false) }
                    if (failed) Text("🙂", fontSize = size * 0.8f, lineHeight = size)
                    else AsyncImage(model = part.url, contentDescription = part.name, modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit, onError = { failed = true })
                })
            }
        }
    }
}
