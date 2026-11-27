package com.tchat.stream

internal sealed interface ChatPart {
    val text: String

    data class Text(override val text: String) : ChatPart
    data class Emote(val name: String, val url: String) : ChatPart {
        override val text = ":$name:"
    }
}

internal data class ChatMessage(
    val id: Long,
    val author: String,
    val parts: List<ChatPart>,
    val kind: ChatKind,
    val timeMillis: Long,
    val amountLabel: String = "",
    val alert: VkAlert? = null,
    val platformKey: String? = null,
) {
    val key = platformKey ?: if (kind == ChatKind.DONATION) "donationalerts:$id" else "vk:$id"
    val text = parts.joinToString("") { it.text }.trim()
}

internal fun unixTimeMillis(value: Long): Long = when {
    value <= 0L -> 0L
    value < 100_000_000_000L -> value * 1000L
    else -> value
}
