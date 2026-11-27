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
    val viewers: (Long?) -> Unit,
    val notice: (String) -> Unit,
    val alert: (VkAlert) -> Unit,
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
            launch { pollViewerCount(countInterval, updates.viewers, vk::viewerCount) }
            if (receiveMessages) vk.monitor(
                interval = if (economy) 5_000L else 3_000L,
                onMessages = { updates.messages(it, true); updates.notice("") },
                onError = { updates.notice("Чат VK недоступен. Повторяем…") },
                onAlert = updates.alert,
            )
        }
        ChatPlatform.TWITCH -> {
            launch { pollViewerCount(countInterval, updates.viewers) { twitchViewerCount(address) } }
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

internal suspend fun requestText(request: Request): String = suspendCancellableCoroutine { continuation ->
    val call = chatHttp.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

        override fun onResponse(call: Call, response: Response) {
            val result = runCatching {
                response.use {
                    if (!it.isSuccessful) throw IOException("HTTP ${it.code}")
                    it.body?.string() ?: throw IOException("Empty response")
                }
            }
            result.fold(continuation::resume, continuation::resumeWithException)
        }
    })
}

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull(::optJSONObject)
