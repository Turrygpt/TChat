package com.tchat.stream

internal enum class ChatKind(val label: String) {
    VIEWER("Сообщения зрителей"),
    BOT("Сообщения бота"),
    FOLLOW("Фолловеры"),
    RAID("Рейды"),
    SUBSCRIPTION("Подписки"),
    REWARD("Награды"),
    DONATION("Донаты"),
}

private val whitespace = Regex("\\s+")

internal fun chatFilterKey(value: String) = value.trim().replace(whitespace, " ").lowercase()

internal data class ChatFilters(
    val kinds: Set<String> = emptySet(),
    val authors: Set<String> = emptySet(),
    val messages: Set<String> = emptySet(),
) {
    fun hides(message: ChatMessage): Boolean =
        message.kind.name in kinds || chatFilterKey(message.author) in authors || chatFilterKey(message.text) in messages
}
