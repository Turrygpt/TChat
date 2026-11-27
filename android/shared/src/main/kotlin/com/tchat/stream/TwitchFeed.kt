package com.tchat.stream

import android.net.Uri
import java.io.IOException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private const val TWITCH_CHAT = "wss://irc-ws.chat.twitch.tv"
private const val TWITCH_QUERY = "https://gql.twitch.tv/gql"
private const val TWITCH_WEB_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"
private val twitchName = Regex("[a-z0-9_]{1,25}")
private val twitchEmoteId = Regex("[A-Za-z0-9_]+")
private val twitchIrcMessage = Regex("""^(?:@([^ ]+) )?:([^ ]+) (PRIVMSG|USERNOTICE) #[^ ]+(?: :(.*))?$""")
private val twitchSocketHttp by lazy { chatHttp.newBuilder().pingInterval(60, TimeUnit.SECONDS).build() }

internal fun twitchChannelName(value: String): String? {
    val input = value.trim()
    val uri = Uri.parse(input).normalizeScheme()
    val name = if (uri.scheme == null) {
        input.trim('/').trimStart('@', '#')
    } else {
        if (uri.scheme != "https" || uri.userInfo != null ||
            uri.host?.lowercase() !in setOf("www.twitch.tv", "twitch.tv", "m.twitch.tv")
        ) return null
        uri.pathSegments.firstOrNull() ?: return null
    }
    return name.lowercase().takeIf(twitchName::matches)
}

internal suspend fun twitchViewerCount(channel: String): Long? {
    val query = JSONObject()
        .put("operationName", "ChannelShell")
        .put("variables", JSONObject().put("login", channel))
        .put("query", "query ChannelShell(\$login: String!) { user(login: \$login) { stream { viewersCount } } }")
    val request = Request.Builder().url(TWITCH_QUERY)
        .header("Client-ID", TWITCH_WEB_CLIENT)
        .post(query.toString().toRequestBody("application/json".toMediaType()))
        .build()
    val user = JSONObject(requestText(request)).optJSONObject("data")?.optJSONObject("user") ?: return null
    val stream = user.optJSONObject("stream") ?: return 0L
    return stream.optLong("viewersCount", -1L).takeIf { it >= 0L }
}

internal suspend fun watchTwitchChat(channel: String, updates: ChatFeedUpdates) {
    var retry = 2_000L
    while (currentCoroutineContext().isActive) {
        try {
            twitchLines(channel).collect { packet ->
                val messages = ArrayList<ChatMessage>()
                packet.lineSequence().map(String::trimEnd).forEach { line ->
                    if (line.contains(" 366 ") || line.contains(" ROOMSTATE ")) {
                        updates.notice("")
                        retry = 2_000L
                    }
                    parseTwitchChatMessage(line)?.let(messages::add)
                }
                if (messages.isNotEmpty()) {
                    updates.messages(messages, false)
                    messages.forEach { it.alert?.let(updates.alert) }
                }
            }
        } catch (_: IOException) {
            // The socket is reopened below while this source is selected.
        }
        updates.notice("Чат Twitch недоступен. Повторяем…")
        delay(retry)
        retry = minOf(retry * 2, 30_000L)
    }
}

private fun twitchLines(channelName: String) = callbackFlow {
    val request = Request.Builder().url(TWITCH_CHAT).build()
    val guest = "justinfan${Random.nextInt(10_000, 999_999)}"
    val socket = twitchSocketHttp.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
            webSocket.send("PASS SCHMOOPIIE")
            webSocket.send("NICK $guest")
            webSocket.send("JOIN #$channelName")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            for (line in text.lineSequence()) {
                if (line.startsWith("PING ")) webSocket.send("PONG ${line.substringAfter(' ').trimEnd()}")
                if (line.substringAfter(' ', "").startsWith("RECONNECT")) {
                    channel.close()
                    return
                }
            }
            trySend(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            channel.close()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            response?.close()
            channel.close(IOException("Twitch chat disconnected", t))
        }
    })
    awaitClose { socket.cancel() }
}

internal fun parseTwitchChatMessage(line: String): ChatMessage? {
    val match = twitchIrcMessage.matchEntire(line) ?: return null
    val (rawTags, prefix, command, text) = match.destructured
    val tags = rawTags.split(';').associate { it.substringBefore('=') to decodeIrcTag(it.substringAfter('=', "")) }
    val id = tags["id"]?.takeIf(String::isNotBlank) ?: return null
    val time = tags["tmi-sent-ts"]?.toLongOrNull() ?: System.currentTimeMillis()
    val type = if (tags["msg-id"] == "sharedchatnotice") tags["source-msg-id"] else tags["msg-id"]
    val alert = if (type == "raid") {
        val raider = tags["msg-param-displayName"] ?: tags["msg-param-login"] ?: tags["display-name"] ?: "Зритель"
        VkAlert(VkAlertType.RAID, raider, tags["msg-param-viewerCount"]?.toIntOrNull())
    } else null
    val name = if (type?.startsWith("anon") == true) "Аноним" else
        alert?.name ?: tags["display-name"]?.takeIf(String::isNotBlank) ?: tags["login"] ?: prefix.substringBefore('!')
    val bits = tags["bits"]?.toLongOrNull()?.takeIf { it > 0L }
    val plan = when (tags["msg-param-sub-plan"]?.lowercase()) {
        "prime" -> " (Prime)"
        "1000" -> " (Tier 1)"
        "2000" -> " (Tier 2)"
        "3000" -> " (Tier 3)"
        else -> ""
    }
    val eventText = if (command == "USERNOTICE") when (type) {
        "sub" -> "оформил подписку$plan"
        "resub" -> "продлил подписку$plan" + (tags["msg-param-cumulative-months"]?.let { " · месяцев $it" } ?: "")
        "subgift", "anonsubgift" -> "подарил подписку$plan" +
            ((tags["msg-param-recipient-display-name"] ?: tags["msg-param-recipient-user-name"])?.let { " зрителю $it" } ?: "")
        "submysterygift", "anonsubmysterygift" -> "подарил подписки$plan" +
            (tags["msg-param-mass-gift-count"]?.let { " · количество $it" } ?: "")
        "giftpaidupgrade", "anongiftpaidupgrade", "primepaidupgrade" -> "перешёл на платную подписку$plan"
        "raid" -> "привёл рейд" + (alert?.viewers?.let { " · зрителей $it" } ?: "")
        "unraid" -> "отменил рейд"
        "announcement" -> "Объявление"
        else -> tags["system-msg"].orEmpty()
    } else ""
    val kind = when {
        alert != null -> ChatKind.RAID
        command == "USERNOTICE" && type in setOf("sub", "resub", "subgift", "anonsubgift", "submysterygift",
            "anonsubmysterygift", "giftpaidupgrade", "anongiftpaidupgrade", "primepaidupgrade") -> ChatKind.SUBSCRIPTION
        command == "USERNOTICE" -> ChatKind.NOTICE
        bits != null -> ChatKind.DONATION
        tags["custom-reward-id"]?.isNotBlank() == true || type == "highlighted-message" -> ChatKind.REWARD
        else -> ChatKind.VIEWER
    }
    val parts = buildList {
        if (eventText.isNotBlank()) add(ChatPart.Text(eventText + if (text.isBlank()) "" else " — "))
        if (text.isNotBlank()) addAll(twitchMessageParts(text, tags["emotes"].orEmpty()))
    }
    if (parts.isEmpty()) return null
    return ChatMessage(
        time, name, parts, kind, time,
        amountLabel = bits?.let { "$it Bits" }.orEmpty(), alert = alert, platformKey = "twitch:$id",
        authorColor = tags["color"].orEmpty(),
    )
}

private val escapedTag = Regex("""\\(.)""")
private fun decodeIrcTag(value: String) = escapedTag.replace(value) {
    when (val c = it.groupValues[1]) { "s" -> " "; ":" -> ";"; "r", "n" -> " "; else -> c }
}

private fun twitchMessageParts(text: String, tags: String): List<ChatPart> {
    if (tags.isEmpty()) return listOf(ChatPart.Text(text))
    val length = text.codePointCount(0, text.length)
    val emotes = tags.split('/').flatMap { group ->
        val id = group.substringBefore(':').takeIf(twitchEmoteId::matches) ?: return@flatMap emptyList()
        group.substringAfter(':', "").split(',').mapNotNull { range ->
            val first = range.substringBefore('-').toIntOrNull() ?: return@mapNotNull null
            val last = range.substringAfter('-', "").toIntOrNull() ?: return@mapNotNull null
            if (first < 0 || last < first || last >= length) return@mapNotNull null
            Triple(text.offsetByCodePoints(0, first), text.offsetByCodePoints(0, last + 1), id)
        }
    }.sortedBy { it.first }
    return buildList {
        var cursor = 0
        for ((start, end, id) in emotes) {
            if (start < cursor) continue
            if (start > cursor) add(ChatPart.Text(text.substring(cursor, start)))
            add(ChatPart.Emote(text.substring(start, end), "https://static-cdn.jtvnw.net/emoticons/v2/$id/default/dark/1.0"))
            cursor = end
        }
        if (cursor < text.length) add(ChatPart.Text(text.substring(cursor)))
    }
}
