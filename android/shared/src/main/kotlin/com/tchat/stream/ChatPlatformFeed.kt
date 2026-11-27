package com.tchat.stream

import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal class ChatFeedUpdates(
    val messages: (List<ChatMessage>, replace: Boolean) -> Unit,
    val viewers: ((Long?) -> Unit)? = null,
    val notice: (String) -> Unit,
    val alert: (VkAlert) -> Unit = {},
    val includeVkLikes: Boolean = false,
    val history: (List<ChatMessage>) -> Unit = { messages(it, false) },
)

internal suspend fun watchChatPlatform(
    platform: ChatPlatform,
    address: String,
    receiveMessages: Boolean,
    economy: Boolean,
    updates: ChatFeedUpdates,
) = coroutineScope {
    val countInterval = if (economy) 30_000L else 15_000L
    when (platform) {
        ChatPlatform.VK -> {
            val vk = VkLiveChat(address)
            var lastLikes: Long? = null
            var lastStream = ""
            var page = emptyList<ChatMessage>()
            val likes = ArrayDeque<ChatMessage>()
            updates.viewers?.let { onCount -> launch {
                pollViewerCount(countInterval, onCount) {
                    val stream = vk.streamInfo()
                    if (updates.includeVkLikes && receiveMessages) {
                        val id = stream.optString("id").ifBlank { stream.optString("vid") }
                        val total = stream.optJSONObject("count")?.optLong("likes", -1)?.takeIf { it >= 0 }
                        val before = lastLikes
                        if (before != null && total != null && id == lastStream && total > before && stream.optBoolean("isOnline", true)) {
                            val time = System.currentTimeMillis()
                            likes.addFirst(ChatMessage(time, address, listOf(ChatPart.Text("Отметки «Нравится» · +${total - before}")),
                                ChatKind.NOTICE, time, platformKey = "vk:likes:$id:$total"))
                            if (likes.size > 30) likes.removeLast()
                            updates.messages(page + likes, true)
                        }
                        lastLikes = total
                        lastStream = id
                    }
                    parseVkViewerCount(stream)
                }
            } }
            if (receiveMessages) vk.monitor(
                interval = if (economy) 5_000L else 3_000L,
                onMessages = { page = it; updates.messages(it + likes, true); updates.notice("") },
                onError = { updates.notice("Чат VK недоступен. Повторяем…") },
                onAlert = updates.alert,
            )
        }
        ChatPlatform.TWITCH -> {
            updates.viewers?.let { launch { pollViewerCount(countInterval, it) { twitchViewerCount(address) } } }
            if (receiveMessages) watchTwitchChat(address, updates)
        }
        ChatPlatform.YOUTUBE -> watchYouTube(address, receiveMessages, countInterval, updates)
    }
}

private suspend fun pollViewerCount(interval: Long, onCount: (Long?) -> Unit, request: suspend () -> Long?) {
    var failures = 0
    while (currentCoroutineContext().isActive) {
        try {
            onCount(request())
            failures = 0
        } catch (_: IOException) {
            if (++failures >= 2) onCount(null)
        } catch (_: JSONException) {
            if (++failures >= 2) onCount(null)
        }
        delay(interval)
    }
}

internal val chatHttp = OkHttpClient.Builder()
    .connectTimeout(7, TimeUnit.SECONDS)
    .readTimeout(9, TimeUnit.SECONDS)
    .build()

internal class FeedHttpError(val status: Int, val retryAfterSeconds: Long?) : IOException("HTTP $status")

internal suspend fun requestText(request: Request, client: OkHttpClient = chatHttp): String = suspendCancellableCoroutine { continuation ->
    val call = client.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

        override fun onResponse(call: Call, response: Response) {
            val result = runCatching {
                response.use {
                    if (!it.isSuccessful) throw FeedHttpError(it.code, it.header("Retry-After")?.toLongOrNull())
                    it.body?.string() ?: throw IOException("Empty response")
                }
            }
            result.fold(continuation::resume, continuation::resumeWithException)
        }
    })
}

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull(::optJSONObject)
