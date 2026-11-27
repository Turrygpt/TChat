package com.tchat.stream

import android.net.Uri
import android.os.SystemClock
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

private const val YOUTUBE = "https://www.youtube.com"
private val videoId = Regex("[A-Za-z0-9_-]{11}")
private val channelId = Regex("UC[A-Za-z0-9_-]{22}")
private val handle = Regex("[\\p{L}\\p{M}\\p{N}_.-]{1,80}")
private val browserVersion = Regex("""["'](?:INNERTUBE_CLIENT_VERSION|clientVersion)["']\s*:\s*["']([\d.]+)["']""")
private val browserKey = Regex("""["']INNERTUBE_API_KEY["']\s*:\s*["']([A-Za-z0-9_-]+)["']""")
private val liveViewerCount = Regex("""["']concurrentViewers["']\s*:\s*"?(\d+)""")
private val watchingLabel = Regex("""([\d,.\s\u00a0\u202f]+)\s+(?:watching|смотр)""", RegexOption.IGNORE_CASE)
private val playerBoundary = Regex("""(?:\bytInitialPlayerResponse|\["ytInitialPlayerResponse"])\s*=\s*(?=\{)""")
private val dataBoundary = Regex("""(?:\bytInitialData|\["ytInitialData"])\s*=\s*(?=\{)""")
private val chatTrackers = listOf("invalidationContinuationData", "timedContinuationData", "reloadContinuationData")

internal fun youTubeAddress(value: String): String? {
    val input = value.trim()
    val uri = Uri.parse(input).normalizeScheme()
    val candidate = if (uri.scheme == null) input.trim('/') else {
        if (uri.scheme != "https" || uri.userInfo != null) return null
        val host = uri.host?.lowercase()
        val path = uri.pathSegments
        when (host) {
            "youtu.be" -> return path.firstOrNull()?.takeIf(videoId::matches)
            "youtube.com", "www.youtube.com", "m.youtube.com" -> {
                when (val start = path.firstOrNull()) {
                    "watch" -> return uri.getQueryParameter("v")?.takeIf(videoId::matches)
                    "live" -> return path.getOrNull(1)?.takeIf(videoId::matches)
                    "channel" -> return path.getOrNull(1)?.takeIf(channelId::matches)
                    else -> start?.takeIf { it.startsWith('@') } ?: return null
                }
            }
            else -> return null
        }
    }
    if (videoId.matches(candidate) || channelId.matches(candidate)) return candidate
    return candidate.removePrefix("@").takeIf { handle.matches(it) && it.any(Char::isLetterOrDigit) }?.let { "@$it" }
}

private data class LiveVideo(val id: String, val viewers: Long?, val chat: YouTubeChat?)
private data class YouTubeChat(val version: String, val apiKey: String?, val token: String)
private data class ChatPage(val token: String?, val interval: Long, val messages: List<ChatMessage>)

internal suspend fun watchYouTube(address: String, receiveMessages: Boolean, interval: Long, updates: ChatFeedUpdates) {
    var live: LiveVideo? = null
    var chat: YouTubeChat? = null
    var nextStatus = 0L
    var nextChat = 0L
    var statusFailures = 0
    while (currentCoroutineContext().isActive) {
        val now = SystemClock.elapsedRealtime()
        if (now >= nextStatus) {
            val found = youtubeAttempt { youtubeStatus(address, receiveMessages) }
            if (found.isSuccess) {
                val video = found.getOrNull()
                if (video?.id != live?.id) {
                    chat = video?.chat
                    nextChat = now
                    updates.messages(emptyList(), true)
                }
                live = video
                updates.viewers(if (video == null) 0L else video.viewers)
                statusFailures = 0
                if (receiveMessages && video == null) updates.notice("На YouTube сейчас нет эфира")
            } else {
                if (++statusFailures >= 2) updates.viewers(null)
                if (receiveMessages && live == null) updates.notice("YouTube недоступен. Повторяем…")
            }
            nextStatus = SystemClock.elapsedRealtime() + interval
        }
        val current = live
        if (receiveMessages && current != null && now >= nextChat) {
            val result = youtubeAttempt {
                val session = chat ?: youtubeChat(current.id) ?: return@youtubeAttempt null
                session to youtubeChatPage(session)
            }.getOrNull()
            if (result != null) {
                val (session, page) = result
                updates.notice("")
                if (page.messages.isNotEmpty()) updates.messages(page.messages, false)
                chat = page.token?.let { session.copy(token = it) }
                nextChat = SystemClock.elapsedRealtime() + if (chat != null) page.interval else interval
            } else {
                chat = null
                updates.notice("Чат YouTube недоступен. Повторяем…")
                nextChat = SystemClock.elapsedRealtime() + 12_000L
            }
        }
        val wakeAt = if (receiveMessages && current != null) minOf(nextStatus, nextChat) else nextStatus
        delay((wakeAt - SystemClock.elapsedRealtime()).coerceAtLeast(200L))
    }
}

private suspend fun <T> youtubeAttempt(request: suspend () -> T): Result<T> = try {
    Result.success(request())
} catch (error: IOException) {
    Result.failure(error)
} catch (error: JSONException) {
    Result.failure(error)
}

private suspend fun youtubeStatus(address: String, receiveMessages: Boolean): LiveVideo? {
    val url = Uri.parse(YOUTUBE).buildUpon().apply {
        when {
            videoId.matches(address) -> appendPath("watch").appendQueryParameter("v", address)
            channelId.matches(address) -> appendPath("channel").appendPath(address).appendPath("live")
            else -> appendPath(address).appendPath("live")
        }
        appendQueryParameter("hl", "en")
    }.build()
    val html = youtubePage(url.toString())
    return withContext(Dispatchers.Default) {
        val player = html.embeddedObject(playerBoundary)
        if (player == null) {
            if (!videoId.matches(address) && dataBoundary.containsMatchIn(html)) return@withContext null
            throw IOException("YouTube player unavailable")
        }
        val details = player.optJSONObject("videoDetails")
        val info = player.optJSONObject("microformat")?.optJSONObject("playerMicroformatRenderer")
            ?.optJSONObject("liveBroadcastDetails")
        val playable = player.optJSONObject("playabilityStatus")?.textField("status")
        if (playable !in setOf("OK", "LIVE_STREAM_OFFLINE")) throw IOException("YouTube video unavailable")
        if (playable == "LIVE_STREAM_OFFLINE" || info?.textField("endTimestamp")?.isNotEmpty() == true) return@withContext null
        if (info?.optBoolean("isLiveNow", details?.optBoolean("isLive") == true) != true &&
            details?.optBoolean("isLive") != true
        ) return@withContext null
        val id = details?.textField("videoId")?.takeIf(videoId::matches) ?: throw IOException("No live video ID")
        val data = html.embeddedObject(dataBoundary)?.optJSONObject("contents")?.optJSONObject("twoColumnWatchNextResults")
        val viewers = parseYouTubeLiveViewers(html, data)
        val chat = if (receiveMessages) {
            data?.optJSONObject("conversationBar")?.optJSONObject("liveChatRenderer")?.let { chatSession(html, it) }
        } else null
        LiveVideo(id, viewers, chat)
    }
}

private fun parseYouTubeLiveViewers(html: String, data: JSONObject?): Long? {
    liveViewerCount.find(html)?.groupValues?.get(1)?.toLongOrNull()?.let { return it }
    val primary = data?.optJSONObject("results")?.optJSONObject("results")?.optJSONArray("contents")
        ?.objects()?.firstNotNullOfOrNull { it.optJSONObject("videoPrimaryInfoRenderer") } ?: return null
    val count = primary.optJSONObject("viewCount")?.optJSONObject("videoViewCountRenderer") ?: return null
    if (!count.optBoolean("isLive", true)) return null
    val value = count.optJSONObject("viewCount").formattedText()
    return watchingLabel.find(value)?.groupValues?.get(1)?.filter(Char::isDigit)?.toLongOrNull()
}

private suspend fun youtubeChat(id: String): YouTubeChat? {
    val html = youtubePage("$YOUTUBE/live_chat?v=$id&hl=en")
    val renderer = html.embeddedObject(dataBoundary)?.optJSONObject("contents")?.optJSONObject("liveChatRenderer")
        ?: return null
    return chatSession(html, renderer)
}

private fun chatSession(html: String, renderer: JSONObject): YouTubeChat? {
    val token = continuation(renderer)?.textField("continuation")?.takeIf(String::isNotBlank) ?: return null
    val version = browserVersion.find(html)?.groupValues?.get(1) ?: return null
    val key = browserKey.find(html)?.groupValues?.get(1)
    return YouTubeChat(version, key, token)
}

private suspend fun youtubeChatPage(chat: YouTubeChat): ChatPage {
    val client = JSONObject().put("clientName", "WEB").put("clientVersion", chat.version).put("hl", "en")
    val body = JSONObject().put("context", JSONObject().put("client", client)).put("continuation", chat.token)
    val url = Uri.parse("$YOUTUBE/youtubei/v1/live_chat/get_live_chat").buildUpon().apply {
        chat.apiKey?.let { appendQueryParameter("key", it) }
    }.build()
    val request = Request.Builder().url(url.toString())
        .header("Origin", YOUTUBE)
        .header("Referer", "$YOUTUBE/")
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .build()
    val json = JSONObject(requestText(request)).getJSONObject("continuationContents").getJSONObject("liveChatContinuation")
    val next = continuation(json)
    return ChatPage(
        next?.textField("continuation")?.takeIf(String::isNotBlank),
        next?.optLong("timeoutMs", 5_000L)?.coerceIn(3_500L, 30_000L) ?: 5_000L,
        json.optJSONArray("actions")?.objects().orEmpty().mapNotNull(::parseYouTubeChatAction),
    )
}

private fun continuation(json: JSONObject): JSONObject? =
    json.optJSONArray("continuations")?.objects()?.firstNotNullOfOrNull { item ->
        chatTrackers.firstNotNullOfOrNull(item::optJSONObject)
    }

private suspend fun youtubePage(url: String): String = requestText(
    Request.Builder().url(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36")
        .header("Accept-Language", "en-US,en;q=0.8")
        .build(),
)

private fun String.embeddedObject(boundary: Regex): JSONObject? {
    val start = (boundary.find(this)?.range?.last ?: return null) + 1
    return JSONTokener(substring(start)).nextValue() as? JSONObject
}

private fun JSONObject?.formattedText(): String =
    this?.textField("simpleText").orEmpty().ifBlank {
        this?.optJSONArray("runs")?.objects().orEmpty().joinToString("") { it.textField("text") }
    }

internal fun parseYouTubeChatAction(action: JSONObject): ChatMessage? {
    val item = action.optJSONObject("addChatItemAction")?.optJSONObject("item") ?: return null
    val text = item.optJSONObject("liveChatTextMessageRenderer")
    val paid = item.optJSONObject("liveChatPaidMessageRenderer") ?: item.optJSONObject("liveChatPaidStickerRenderer")
    val membership = item.optJSONObject("liveChatMembershipItemRenderer")
    val message = text ?: paid ?: membership ?: return null
    val id = message.textField("id").takeIf(String::isNotBlank) ?: return null
    val author = message.optJSONObject("authorName").formattedText().takeIf(String::isNotBlank) ?: return null
    val time = message.optLong("timestampUsec").takeIf { it > 0L }?.div(1000L) ?: System.currentTimeMillis()
    val content = message.optJSONObject("message") ?: message.optJSONObject("headerSubtext")
    val parts = content?.optJSONArray("runs")?.objects().orEmpty().mapNotNull { run ->
        val emoji = run.optJSONObject("emoji")
        if (emoji == null) run.textField("text").takeIf(String::isNotEmpty)?.let(ChatPart::Text)
        else {
            val emojiId = emoji.textField("emojiId")
            val url = emoji.optJSONObject("image")?.optJSONArray("thumbnails")?.objects()?.firstOrNull()?.textField("url")
            if (!emoji.optBoolean("isCustomEmoji") && emojiId.isNotBlank() && !emojiId.all { it.isLetterOrDigit() }) {
                ChatPart.Text(emojiId)
            } else {
                val label = emoji.optJSONArray("shortcuts")?.optString(0).orEmpty().ifBlank { "Смайлик" }
                val httpsUrl = url?.let { if (it.startsWith("//")) "https:$it" else it }
                if (httpsUrl?.startsWith("https://") == true) ChatPart.Emote(label, httpsUrl) else ChatPart.Text("🙂")
            }
        }
    }
    val amount = paid?.optJSONObject("purchaseAmountText").formattedText()
    val kind = when {
        paid != null -> ChatKind.DONATION
        membership != null -> ChatKind.SUBSCRIPTION
        else -> ChatKind.VIEWER
    }
    return ChatMessage(time, author, parts, kind, time, amountLabel = amount, platformKey = "youtube:$id")
        .takeIf { it.text.isNotBlank() || amount.isNotBlank() }
}

private fun JSONObject.textField(name: String): String = if (isNull(name)) "" else optString(name)
