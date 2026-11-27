package com.tchat.reader

import com.tchat.stream.ChatKind
import com.tchat.stream.ChatMessage
import com.tchat.stream.ChatPart
import com.tchat.stream.FeedHttpError
import com.tchat.stream.chatHttp
import com.tchat.stream.requestText
import java.io.IOException
import java.net.URI
import java.time.Instant
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONException
import org.json.JSONObject

private const val FOLLOW = "channel.follow"
private const val REWARD = "channel.channel_points_custom_reward_redemption.add"
private const val EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws"
private val tokenHttp = chatHttp.newBuilder().followRedirects(false).build()
private class TwitchAccessError(message: String) : IOException(message)
private data class Access(val broadcaster: String, val client: String, val events: Set<String>)

private suspend fun validate(channel: String, token: String, http: OkHttpClient): Access {
    val request = Request.Builder().url("https://id.twitch.tv/oauth2/validate").header("Authorization", "OAuth $token").build()
    val info = JSONObject(requestText(request, http))
    if (!channel.equals(info.optString("login"), true)) throw TwitchAccessError("Нужен токен владельца канала $channel")
    val array = info.optJSONArray("scopes")
    val scopes = (0 until (array?.length() ?: 0)).map { array!!.optString(it) }
    val events = buildSet {
        if ("moderator:read:followers" in scopes) add(FOLLOW)
        if ("channel:read:redemptions" in scopes || "channel:manage:redemptions" in scopes) add(REWARD)
    }
    if (events.isEmpty()) throw TwitchAccessError("У токена нет доступа к фолловерам или наградам")
    return Access(info.getString("user_id"), info.getString("client_id"), events)
}

internal fun twitchEventMessage(payload: JSONObject, broadcaster: String): ChatMessage? {
    val event = payload.optJSONObject("event") ?: return null
    if (event.optString("broadcaster_user_id") != broadcaster) return null
    val author = event.optString("user_name").ifBlank { event.optString("user_login") }.ifBlank { "Зритель" }
    val kind: ChatKind
    val id: String
    val time: String
    val text: String
    when (payload.optJSONObject("subscription")?.optString("type")) {
        FOLLOW -> {
            val user = event.optString("user_id").takeIf(String::isNotBlank) ?: return null
            kind = ChatKind.FOLLOW
            time = event.optString("followed_at")
            id = "twitch:follow:$broadcaster:$user:$time"
            text = "теперь отслеживает канал"
        }
        REWARD -> {
            val redemption = event.optString("id").takeIf(String::isNotBlank) ?: return null
            val reward = event.optJSONObject("reward") ?: return null
            val title = reward.optString("title").takeIf(String::isNotBlank) ?: return null
            kind = ChatKind.REWARD
            time = event.optString("redeemed_at")
            id = "twitch:reward:$redemption"
            text = listOfNotNull("активировал «$title»", reward.optInt("cost").takeIf { it > 0 }?.let { "$it баллов" },
                event.optString("user_input").takeIf(String::isNotBlank)).joinToString(" · ")
        }
        else -> return null
    }
    val millis = try { Instant.parse(time).toEpochMilli() } catch (_: java.time.DateTimeException) { return null }
    return ChatMessage(millis, author, listOf(ChatPart.Text(text)), kind, millis, platformKey = id)
}

internal suspend fun watchTwitchEvents(channel: String, token: String, message: (ChatMessage) -> Unit, notice: (String) -> Unit,
    http: OkHttpClient = tokenHttp) {
    if (token.any { it.code !in 33..126 }) { notice("Проверьте токен Twitch"); return }
    while (currentCoroutineContext().isActive) {
        try {
            val access = validate(channel, token, http)
            readSession(access, token, message, notice, http)
        } catch (error: TwitchAccessError) {
            notice(error.message.orEmpty())
            return
        } catch (error: FeedHttpError) {
            if (error.status == 401 || error.status == 403) { notice("Twitch отклонил токен или его права"); return }
            notice("События Twitch недоступны. Повторяем…")
            delay((error.retryAfterSeconds ?: 5).coerceIn(5, 3600) * 1000)
        } catch (_: IOException) {
            notice("Связь с событиями Twitch потеряна. Повторяем…")
            delay(5000)
        } catch (_: JSONException) {
            notice("Не удалось прочитать события Twitch. Повторяем…")
            delay(5000)
        }
    }
}

private suspend fun subscribe(access: Access, token: String, session: String, http: OkHttpClient) {
    for (type in access.events) {
        val condition = JSONObject().put("broadcaster_user_id", access.broadcaster)
        if (type == FOLLOW) condition.put("moderator_user_id", access.broadcaster)
        val body = JSONObject().put("type", type).put("version", if (type == FOLLOW) "2" else "1").put("condition", condition)
            .put("transport", JSONObject().put("method", "websocket").put("session_id", session))
        val request = Request.Builder().url("https://api.twitch.tv/helix/eventsub/subscriptions")
            .header("Authorization", "Bearer $token").header("Client-Id", access.client)
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        requestText(request, http)
    }
}

private data class Frame(val socket: WebSocket, val text: String?)

private suspend fun readSession(access: Access, token: String, message: (ChatMessage) -> Unit, notice: (String) -> Unit, http: OkHttpClient) {
    val inbox = Channel<Frame>(128)
    val listener = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!inbox.trySend(Frame(webSocket, text)).isSuccess) webSocket.cancel()
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { inbox.trySend(Frame(webSocket, null)) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            response?.close()
            inbox.trySend(Frame(webSocket, null))
        }
    }
    fun open(url: String) = http.newWebSocket(Request.Builder().url(url).build(), listener)
    var active = open(EVENTSUB_URL)
    var successor: WebSocket? = null
    var timeout = 15_000L
    try {
        while (currentCoroutineContext().isActive) {
            val frame = withTimeoutOrNull(timeout) { inbox.receive() } ?: throw IOException("EventSub timeout")
            if (frame.socket !== active && frame.socket !== successor) continue
            if (frame.text == null) {
                if (frame.socket === active && successor != null) continue
                throw IOException("EventSub disconnected")
            }
            val json = JSONObject(frame.text)
            val payload = json.getJSONObject("payload")
            when (json.getJSONObject("metadata").optString("message_type")) {
                "session_welcome" -> {
                    val session = payload.getJSONObject("session")
                    timeout = (session.optLong("keepalive_timeout_seconds", 10).coerceIn(10, 600) + 5) * 1000
                    if (frame.socket === successor) {
                        active.close(1000, null)
                        active = frame.socket
                        successor = null
                    } else subscribe(access, token, session.getString("id"), http)
                    notice(access.events.joinToString(" и ") { if (it == FOLLOW) "Фолловеры" else "Награды" } + " · подключено")
                }
                "notification" -> twitchEventMessage(payload, access.broadcaster)?.let(message)
                "session_reconnect" -> {
                    val url = payload.getJSONObject("session").optString("reconnect_url")
                    val uri = runCatching { URI(url) }.getOrNull()
                    if (uri?.scheme != "wss" || uri.host != "eventsub.wss.twitch.tv" || uri.userInfo != null)
                        throw IOException("Unexpected EventSub reconnect URL")
                    if (successor == null) successor = open(url)
                }
                "revocation" -> throw TwitchAccessError("Twitch отозвал доступ к событиям. Проверьте права токена.")
            }
        }
    } finally {
        active.cancel()
        successor?.cancel()
        inbox.cancel()
    }
}
