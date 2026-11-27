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
    val tags = rawTags.split(';').associate { it.substringBefore('=') to it.substringAfter('=', "") }
    val id = tags["id"]?.takeIf(String::isNotBlank) ?: return null
    val time = tags["tmi-sent-ts"]?.toLongOrNull() ?: System.currentTimeMillis()
    val alert = if (tags["msg-id"] == "raid") {
        val raider = tags["msg-param-displayName"]?.takeIf(String::isNotBlank) ?: return null
        VkAlert(VkAlertType.RAID, raider, tags["msg-param-viewerCount"]?.toIntOrNull())
    } else null
    val name = alert?.name ?: tags["display-name"]?.takeIf(String::isNotBlank) ?: prefix.substringBefore('!')
    val kind = when {
        alert != null -> ChatKind.RAID
        command == "USERNOTICE" && tags["msg-id"] in setOf("sub", "resub", "subgift") -> ChatKind.SUBSCRIPTION
        command != "PRIVMSG" -> return null
        tags["custom-reward-id"]?.isNotBlank() == true -> ChatKind.REWARD
        else -> ChatKind.VIEWER
    }
    val content = text.ifBlank {
        if (alert != null) listOfNotNull("Рейд", alert.viewers?.let { "зрителей: $it" }).joinToString(" · ")
        else "Подписка"
    }
    return ChatMessage(
        time, name, twitchMessageParts(content, tags["emotes"].orEmpty()), kind, time,
        alert = alert, platformKey = "twitch:$id",
    )
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
