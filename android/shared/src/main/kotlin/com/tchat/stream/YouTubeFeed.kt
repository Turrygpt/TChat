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
private val youtubeHost = Regex("^(?:(?:www\\.|m\\.)?youtube\\.com|youtu\\.be)/", RegexOption.IGNORE_CASE)
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
    val uri = Uri.parse(if (youtubeHost.containsMatchIn(input)) "https://$input" else input).normalizeScheme()
    val candidate = if (uri.scheme == null) input.trim('/') else {
        if (uri.scheme != "https" || uri.userInfo != null) return null
        val host = uri.host?.lowercase()
        val path = uri.pathSegments
        when (host) {
            "youtu.be" -> return path.firstOrNull()?.takeIf(videoId::matches)
            "youtube.com", "www.youtube.com", "m.youtube.com" -> {
                when (val start = path.firstOrNull()) {
                    "watch", "live_chat" -> return uri.getQueryParameter("v")?.takeIf(videoId::matches)
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

private data class BroadcastStatus(val id: String?, val viewers: Long? = null, val notice: String = "")
private data class YouTubeChat(val video: String, val version: String, val apiKey: String?, val token: String, val reload: Boolean)
private data class ChatPage(val next: YouTubeChat?, val interval: Long, val messages: List<ChatMessage>)
private class ChatUnavailable(val notice: String) : IOException(notice)

internal suspend fun watchYouTube(
    address: String,
    receiveMessages: Boolean,
    interval: Long,
    updates: ChatFeedUpdates,
    fetch: suspend (Request) -> String = { requestText(it) },
) {
    var liveId: String? = null
    var chat: YouTubeChat? = null
    var nextStatus = 0L
    var nextChat = 0L
    var statusFailures = 0
    while (currentCoroutineContext().isActive) {
        val now = SystemClock.elapsedRealtime()
        if (now >= nextStatus) {
            val found = youtubeAttempt { youtubeStatus(address, fetch) }
            if (found.isSuccess) {
                val video = found.getOrThrow()
                if (video.id != liveId) {
                    liveId = video.id
                    chat = null
                    nextChat = now
                    updates.messages(emptyList(), true)
                }
                updates.viewers?.invoke(if (video.id == null) 0L else video.viewers)
                statusFailures = 0
                if (receiveMessages && video.id == null) updates.notice(video.notice)
            } else {
                if (++statusFailures >= 2) updates.viewers?.invoke(null)
                if (receiveMessages && liveId == null) {
                    // The public chat has its own endpoint and can be available independently of the player.
                    if (videoId.matches(address)) liveId = address else updates.notice("YouTube недоступен. Повторяем…")
                }
            }
            nextStatus = SystemClock.elapsedRealtime() + interval
        }
        val current = liveId
        if (receiveMessages && current != null && now >= nextChat) {
            val session = chat
            val result = youtubeAttempt { if (session == null) openYouTubeChat(current, fetch) else youtubeChatPage(session, fetch) }
            val page = result.getOrNull()
            if (page != null) {
                chat = page.next
                if (page.messages.isNotEmpty()) {
                    if (session == null || session.reload) updates.history(page.messages) else updates.messages(page.messages, false)
                }
                updates.notice(if (chat == null) "Эфирный чат YouTube завершён" else "")
                nextChat = SystemClock.elapsedRealtime() + if (chat != null) page.interval else interval
            } else {
                val error = result.exceptionOrNull()
                // Retry the same cursor after a network interruption so rows received in the meantime can still arrive.
                if (error is JSONException || error is FeedHttpError && error.status in 400..499 && error.status != 429) chat = null
                updates.notice((error as? ChatUnavailable)?.notice ?: "Нет связи с чатом YouTube. Повторяем…")
                val retry = when {
                    error is ChatUnavailable -> interval
                    error is FeedHttpError && error.status == 429 -> (error.retryAfterSeconds ?: 30).coerceIn(1, 3600) * 1000
                    else -> 12_000L
                }
                nextChat = SystemClock.elapsedRealtime() + retry
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

private suspend fun youtubeStatus(address: String, fetch: suspend (Request) -> String): BroadcastStatus {
    val url = Uri.parse(YOUTUBE).buildUpon().apply {
        when {
            videoId.matches(address) -> appendPath("watch").appendQueryParameter("v", address)
            channelId.matches(address) -> appendPath("channel").appendPath(address).appendPath("live")
            else -> appendPath(address).appendPath("live")
        }
        appendQueryParameter("hl", "en")
    }.build()
    val html = fetch(youtubePageRequest(url.toString()).build())
    return withContext(Dispatchers.Default) {
        val player = html.embeddedObject(playerBoundary)
        if (player == null) {
            if (!videoId.matches(address) && dataBoundary.containsMatchIn(html)) return@withContext BroadcastStatus(null, notice = "На YouTube сейчас нет эфира")
            throw IOException("YouTube player unavailable")
        }
        val details = player.optJSONObject("videoDetails")
        val info = player.optJSONObject("microformat")?.optJSONObject("playerMicroformatRenderer")
            ?.optJSONObject("liveBroadcastDetails")
        val playable = player.optJSONObject("playabilityStatus")?.textField("status")
        if (info?.textField("endTimestamp")?.isNotEmpty() == true) return@withContext BroadcastStatus(null, notice = "Эфир YouTube завершён")
        if (playable == "LIVE_STREAM_OFFLINE") return@withContext BroadcastStatus(null, notice = "На YouTube сейчас нет эфира")
        if (playable != "OK") throw IOException("YouTube video unavailable")
        if (info?.optBoolean("isLiveNow", details?.optBoolean("isLive") == true) != true &&
            details?.optBoolean("isLive") != true
        ) return@withContext BroadcastStatus(null, notice = "На YouTube сейчас нет эфира")
        val id = details?.textField("videoId")?.takeIf(videoId::matches) ?: throw IOException("No live video ID")
        BroadcastStatus(id, parseYouTubeLiveViewers(html))
    }
}

private fun parseYouTubeLiveViewers(html: String): Long? {
    liveViewerCount.find(html)?.groupValues?.get(1)?.toLongOrNull()?.let { return it }
    val data = html.embeddedObject(dataBoundary)?.optJSONObject("contents")?.optJSONObject("twoColumnWatchNextResults")
    val primary = data?.optJSONObject("results")?.optJSONObject("results")?.optJSONArray("contents")
        ?.objects()?.firstNotNullOfOrNull { it.optJSONObject("videoPrimaryInfoRenderer") } ?: return null
    val count = primary.optJSONObject("viewCount")?.optJSONObject("videoViewCountRenderer") ?: return null
    if (!count.optBoolean("isLive", true)) return null
    val value = count.optJSONObject("viewCount").formattedText()
    return watchingLabel.find(value)?.groupValues?.get(1)?.filter(Char::isDigit)?.toLongOrNull()
}

private fun chatUrl(id: String) = "$YOUTUBE/live_chat?is_popout=1&v=$id&hl=en"

private suspend fun openYouTubeChat(id: String, fetch: suspend (Request) -> String): ChatPage {
    val html = fetch(youtubePageRequest(chatUrl(id)).build())
    return withContext(Dispatchers.Default) {
        val contents = html.embeddedObject(dataBoundary)?.getJSONObject("contents") ?: throw IOException("Missing YouTube chat page")
        val renderer = contents.optJSONObject("liveChatRenderer") ?: run {
            val reason = contents.optJSONObject("messageRenderer")?.optJSONObject("text").formattedText()
            if (reason.isBlank()) throw IOException("Missing YouTube chat")
            throw ChatUnavailable(if (reason.contains("disabled", ignoreCase = true)) "Чат отключён для этого эфира" else "Чат недоступен для этого эфира")
        }
        if (renderer.optBoolean("isReplay") || renderer.optJSONArray("continuations")?.objects().orEmpty().any { it.has("liveChatReplayContinuationData") }) {
            throw ChatUnavailable("Эфир YouTube завершён")
        }
        // The watch page's filter menu contains placeholders. The pop-out provides working Live chat cursors.
        val filters = renderer.optJSONObject("header")?.optJSONObject("liveChatHeaderRenderer")?.optJSONObject("viewSelector")
            ?.optJSONObject("sortFilterSubMenuRenderer")?.optJSONArray("subMenuItems")
        val fullChat = filters?.objects()?.firstOrNull { it.textField("title").equals("Live chat", ignoreCase = true) }
        val switchTo = fullChat?.takeUnless { it.optBoolean("selected") }?.optJSONObject("continuation")
            ?.optJSONObject("reloadContinuationData")?.textField("continuation")?.takeIf(String::isNotBlank)
        val cursor = continuation(renderer)
        val token = switchTo ?: cursor?.textField("continuation")?.takeIf(String::isNotBlank) ?: throw IOException("Missing chat cursor")
        val version = browserVersion.find(html)?.groupValues?.get(1) ?: throw IOException("Missing YouTube client version")
        val chat = YouTubeChat(id, version, browserKey.find(html)?.groupValues?.get(1), token, switchTo != null || cursor?.has("timeoutMs") != true)
        val interval = if (switchTo == null && cursor?.has("timeoutMs") == true) pollInterval(cursor) else 0L
        ChatPage(chat, interval, chatMessages(renderer))
    }
}

private suspend fun youtubeChatPage(chat: YouTubeChat, fetch: suspend (Request) -> String): ChatPage {
    val client = JSONObject().put("clientName", "WEB").put("clientVersion", chat.version).put("hl", "en")
    val body = JSONObject().put("context", JSONObject().put("client", client)).put("continuation", chat.token)
    val url = Uri.parse("$YOUTUBE/youtubei/v1/live_chat/get_live_chat").buildUpon().apply {
        chat.apiKey?.let { appendQueryParameter("key", it) }
    }.build()
    val request = youtubePageRequest(url.toString())
        .header("Origin", YOUTUBE)
        .header("Referer", chatUrl(chat.video))
        .header("X-YouTube-Client-Name", "1")
        .header("X-YouTube-Client-Version", chat.version)
        .post(body.toString().toRequestBody("application/json".toMediaType()))
        .build()
    val bodyText = fetch(request)
    return withContext(Dispatchers.Default) {
        val json = JSONObject(bodyText).getJSONObject("continuationContents").getJSONObject("liveChatContinuation")
        val cursor = continuation(json)
        val next = cursor?.textField("continuation")?.takeIf(String::isNotBlank)?.let { chat.copy(token = it, reload = false) }
        ChatPage(next, pollInterval(cursor), chatMessages(json))
    }
}

private fun pollInterval(cursor: JSONObject?): Long = cursor?.optLong("timeoutMs", 5_000L)?.coerceIn(3_500L, 30_000L) ?: 5_000L

private fun chatMessages(container: JSONObject): List<ChatMessage> =
    container.optJSONArray("actions")?.objects().orEmpty().mapNotNull(::parseYouTubeChatAction)

private fun continuation(json: JSONObject): JSONObject? =
    json.optJSONArray("continuations")?.objects()?.firstNotNullOfOrNull { item ->
        chatTrackers.firstNotNullOfOrNull(item::optJSONObject)
    }

private fun youtubePageRequest(url: String): Request.Builder =
    Request.Builder().url(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36")
        .header("Accept-Language", "en-US,en;q=0.8")

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
    val gift = item.optJSONObject("liveChatSponsorshipsGiftPurchaseAnnouncementRenderer")
    val received = item.optJSONObject("liveChatSponsorshipsGiftRedemptionAnnouncementRenderer")
    val engagement = item.optJSONObject("liveChatViewerEngagementMessageRenderer")
    // YouTube inserts a fresh copy of its welcome banner for each chat view, with a new ID and timestamp.
    val helpLink = engagement?.optJSONObject("actionButton")?.optJSONObject("buttonRenderer")
        ?.optJSONObject("navigationEndpoint")?.optJSONObject("urlEndpoint")?.textField("url")?.let(Uri::parse)
    if (helpLink?.host == "support.google.com" && helpLink.path == "/youtube/answer/2853856") return null
    val message = text ?: paid ?: membership ?: gift ?: received ?: engagement ?: return null
    val id = message.textField("id").takeIf(String::isNotBlank) ?: return null
    val header = message.optJSONObject("header")?.optJSONObject("liveChatSponsorshipsHeaderRenderer")
    val author = (message.optJSONObject("authorName") ?: header?.optJSONObject("authorName")).formattedText()
        .ifBlank { if (text != null) return null else "YouTube" }
    val time = message.optLong("timestampUsec").takeIf { it > 0L }?.div(1000L) ?: System.currentTimeMillis()
    val eventSummary = listOf(message.optJSONObject("headerPrimaryText"), message.optJSONObject("headerSubtext"),
        header?.optJSONObject("primaryText")).map { it.formattedText() }.filter(String::isNotBlank).distinct().joinToString(" · ")
    val content = message.optJSONObject("message")
    val parts = content?.optJSONArray("runs")?.objects().orEmpty().mapNotNull { run ->
        val emoji = run.optJSONObject("emoji")
        if (emoji == null) run.textField("text").takeIf(String::isNotEmpty)?.let(ChatPart::Text)
        else {
            val emojiId = emoji.textField("emojiId")
            val url = emoji.optJSONObject("image")?.optJSONArray("thumbnails")?.objects()?.firstOrNull()?.textField("url")
            if (!emoji.optBoolean("isCustomEmoji") && emojiId.any { it.code > 127 }) {
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
        membership != null || gift != null || received != null -> ChatKind.SUBSCRIPTION
        engagement != null -> ChatKind.NOTICE
        else -> ChatKind.VIEWER
    }
    val details = buildList {
        if (eventSummary.isNotEmpty()) add(ChatPart.Text(eventSummary))
        val body = parts.ifEmpty { content.formattedText().takeIf(String::isNotBlank)?.let { listOf(ChatPart.Text(it)) }.orEmpty() }
        if (isNotEmpty() && body.isNotEmpty()) add(ChatPart.Text(" — "))
        addAll(body)
        if (isEmpty() && kind == ChatKind.SUBSCRIPTION) add(ChatPart.Text(when {
            gift != null -> "подарил спонсорство"
            received != null -> "получил спонсорство в подарок"
            else -> "оформил спонсорство"
        }))
    }
    return ChatMessage(time, author, details, kind, time, amountLabel = amount, platformKey = "youtube:$id")
        .takeIf { it.text.isNotBlank() || amount.isNotBlank() }
}

private fun JSONObject.textField(name: String): String = if (isNull(name)) "" else optString(name)
