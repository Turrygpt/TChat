package com.tchat.stream

import android.net.Uri
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private const val VK_API = "https://api.live.vkvideo.ru/v1/blog"
private const val VK_CHAT_BOT_ID = 12529926L
private val FOLLOW = Regex("""^теперь отслеживает канал[.!]?$""", RegexOption.IGNORE_CASE)
private val RAID = Regex("""^начинает на вас рейд с (\d+) зрител\p{L}*[.!]?$""", RegexOption.IGNORE_CASE)

internal enum class VkAlertType(val title: String) {
    FOLLOW("Новый фолловер"),
    RAID("Входящий рейд"),
}

internal data class VkAlert(val type: VkAlertType, val name: String, val viewers: Int? = null)

internal class VkLiveChat(private val channel: String) {
    suspend fun monitor(
        interval: Long,
        onMessages: (List<ChatMessage>) -> Unit,
        onError: () -> Unit,
        onAlert: (VkAlert) -> Unit,
    ) {
        var latestId: Long? = null
        while (currentCoroutineContext().isActive) {
            val messages = try {
                parseVkChatPage(fetch("/chat?limit=30"))
            } catch (_: IOException) {
                null
            } catch (_: JSONException) {
                null
            }
            if (messages == null) {
                onError()
                delay(8000)
                continue
            }

            onMessages(messages)
            val previousId = latestId
            // The first page is history. Alert only for messages arriving after connecting.
            if (previousId != null) {
                messages.asReversed()
                    .filter { it.id > previousId }
                    .forEach { item -> item.alert?.let(onAlert) }
            }
            latestId = maxOf(previousId ?: 0L, messages.firstOrNull()?.id ?: 0L)
            delay(interval)
        }
    }

    suspend fun viewerCount(): Long? {
        val payload = JSONObject(fetch(""))
        val stream = if (payload.has("count") || payload.has("isOnline")) payload else payload.optJSONObject("data") ?: payload
        return parseVkViewerCount(stream)
    }

    private suspend fun fetch(path: String) = requestText(
        Request.Builder().url("$VK_API/$channel/public_video_stream$path")
            .header("Accept", "application/json")
            .header("Referer", "https://live.vkvideo.ru/")
            .build(),
    )
}

internal fun parseVkViewerCount(stream: JSONObject): Long? {
    if (stream.has("isOnline") && !stream.optBoolean("isOnline", true)) return 0L
    val counts = stream.optJSONObject("count") ?: return null
    val total = counts.optLong("viewers", -1L)
    if (total > 0L) return total
    val sources = counts.optJSONArray("sources")?.objects().orEmpty().sumOf { it.optLong("viewers", 0L).coerceAtLeast(0L) }
    return if (sources > 0L) sources else total.takeIf { it >= 0L }
}

internal fun parseVkChatPage(json: String): List<ChatMessage> {
    val items = JSONObject(json).getJSONArray("data")
    return (0 until items.length())
        .mapNotNull { items.optJSONObject(it)?.let(::parseVkChatMessage) }
        .distinctBy { it.id }
        .sortedByDescending { it.id }
}

private fun parseVkChatMessage(item: JSONObject): ChatMessage? {
    if (item.optBoolean("isDeleted") || item.optBoolean("isPrivate")) return null
    val id = item.optLong("id").takeIf { it > 0L } ?: return null
    val author = item.optJSONObject("author") ?: return null
    val name = displayName(author).takeIf(String::isNotEmpty) ?: return null
    val data = item.optJSONArray("data") ?: return null
    val parts = (0 until data.length()).mapNotNull(data::optJSONObject)
    val content = parts.mapNotNull { part ->
        when (part.optString("type")) {
            "mention" -> displayName(part).takeIf(String::isNotEmpty)?.let { ChatPart.Text("$it ") }
            "text" -> ChatPart.Text(decodedText(part))
            "smile", "emoji", "emote" -> decodeEmote(part)
            "link" -> ChatPart.Text(part.optString("url").ifBlank { decodedText(part) })
            else -> null
        }
    }
    val isBot = author.optLong("id") == VK_CHAT_BOT_ID
    val alert = if (isBot) parseBotAlert(parts) else null
    val botText = if (isBot) parts.filter { it.optString("type") == "text" }.joinToString(" ", transform = ::decodedText) else ""
    val kind = when {
        alert?.type == VkAlertType.FOLLOW -> ChatKind.FOLLOW
        alert?.type == VkAlertType.RAID -> ChatKind.RAID
        botText.contains("наград", ignoreCase = true) || item.optJSONObject("reward") != null -> ChatKind.REWARD
        botText.contains("подписк", ignoreCase = true) -> ChatKind.SUBSCRIPTION
        isBot -> ChatKind.BOT
        else -> ChatKind.VIEWER
    }
    val createdAt = unixTimeMillis(item.optLong("createdAt"))
    return ChatMessage(id, name, content, kind, createdAt, alert = alert).takeIf { it.text.isNotEmpty() }
}

private fun decodeEmote(part: JSONObject): ChatPart {
    val name = part.optString("name").ifBlank { "Смайлик" }
    val url = listOf("smallUrl", "mediumUrl", "largeUrl", "imageUrl", "url").firstNotNullOfOrNull { field ->
        if (part.isNull(field)) return@firstNotNullOfOrNull null
        val raw = part.optString(field).trim()
        val candidate = if (raw.startsWith("//")) "https:$raw" else raw
        val address = Uri.parse(candidate)
        candidate.takeIf { address.scheme == "https" && !address.host.isNullOrBlank() && address.userInfo == null }
    }
    return if (url == null) ChatPart.Text("🙂") else ChatPart.Emote(name, url)
}

private fun parseBotAlert(parts: List<JSONObject>): VkAlert? {
    val message = parts.filter { it.optString("type") == "text" }
        .map(::decodedText)
        .joinToString(" ")
        .trim()
    val mentions = parts.filter { it.optString("type") == "mention" }
    if (FOLLOW.matches(message)) {
        val follower = mentions.firstOrNull()?.let(::displayName).orEmpty()
        return follower.takeIf(String::isNotEmpty)?.let { VkAlert(VkAlertType.FOLLOW, it) }
    }
    val viewers = RAID.matchEntire(message)?.groupValues?.get(1)?.toIntOrNull() ?: return null
    // VK lists the receiving channel first and the raider second.
    val raider = mentions.getOrNull(1)?.let(::displayName).orEmpty()
    return raider.takeIf(String::isNotEmpty)?.let { VkAlert(VkAlertType.RAID, it, viewers) }
}

private fun displayName(item: JSONObject): String =
    listOf("displayName", "nick", "name").firstNotNullOfOrNull { field ->
        if (item.isNull(field)) null else item.optString(field).trim().takeIf(String::isNotEmpty)
    }.orEmpty()

private fun decodedText(part: JSONObject): String {
    if (part.isNull("content")) return ""
    val content = part.optString("content")
    if (!content.startsWith('[')) return content
    return try {
        JSONArray(content).optString(0)
    } catch (_: JSONException) {
        content
    }
}
