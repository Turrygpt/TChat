package com.tchat.stream

internal enum class ChatPlatform(val label: String, val addressHint: String) {
    VK("VK", "Ник или ссылка на канал"),
    TWITCH("Twitch", "Ник или ссылка на канал"),
    YOUTUBE("YouTube", "@ник канала или ссылка на эфир");

    fun normalize(input: String): String? = when (this) {
        VK -> vkChannelSlug(input)
        TWITCH -> twitchChannelName(input)
        YOUTUBE -> youTubeAddress(input)
    }
}
