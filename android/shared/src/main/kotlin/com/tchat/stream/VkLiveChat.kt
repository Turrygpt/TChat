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
private val VK_CHANNEL_SLUG = Regex("[a-zA-Z0-9_.-]{1,100}")
private val FOLLOW = Regex("""^теперь отслеживает канал[.!]?$""", RegexOption.IGNORE_CASE)
private val RAID = Regex("""^начинает на вас рейд с (\d+) зрител\p{L}*[.!]?$""", RegexOption.IGNORE_CASE)

internal enum class VkAlertType(val title: String) {
    FOLLOW("Новый фолловер"),
    RAID("Входящий рейд"),
}

internal data class VkAlert(val type: VkAlertType, val name: String, val viewers: Int? = null)

internal fun vkChannelSlug(value: String): String? {
    val input = value.trim()
    val uri = Uri.parse(input).normalizeScheme()
    val slug = if (uri.scheme == null) input.trim('/') else {
        if (uri.scheme != "https" || !uri.host.equals("live.vkvideo.ru", ignoreCase = true) || uri.userInfo != null) return null
        uri.pathSegments.firstOrNull() ?: return null
    }
    return slug.takeIf { it != "." && it != ".." && VK_CHANNEL_SLUG.matches(it) }
}

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

    suspend fun streamInfo(): JSONObject {
        val payload = JSONObject(fetch(""))
        return if (payload.has("count") || payload.has("isOnline")) payload else payload.optJSONObject("data") ?: payload
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
    val data = item.optJSONArray("data") ?: JSONArray()
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
    val isBot = author.optLong("id") == VK_CHAT_BOT_ID || (!author.has("id") && name.equals("ChatBot", true))
    val alert = if (isBot) parseBotAlert(parts) else null
    val botText = if (isBot) parts.filter { it.optString("type") == "text" }.joinToString(" ", transform = ::decodedText) else ""
    val reward = item.optJSONObject("reward") ?: item.optJSONObject("rewardInfo")
    val rewardName = reward?.let { listOf("name", "title", "rewardName").firstNotNullOfOrNull { field ->
        it.optString(field).takeIf(String::isNotBlank)
    } }
    val kind = when {
        alert?.type == VkAlertType.FOLLOW -> ChatKind.FOLLOW
        alert?.type == VkAlertType.RAID -> ChatKind.RAID
        botText.contains("наград", ignoreCase = true) || rewardName != null -> ChatKind.REWARD
        botText.contains("подпис", ignoreCase = true) -> ChatKind.SUBSCRIPTION
        botText.contains("из портала", ignoreCase = true) -> ChatKind.NOTICE
        isBot -> ChatKind.BOT
        else -> ChatKind.VIEWER
    }
    val createdAt = unixTimeMillis(item.optLong("createdAt"))
    val details = if (rewardName != null) {
        val cost = reward.optInt("price", reward.optInt("cost"))
        listOfNotNull("активировал «$rewardName»", if (cost > 0) "$cost баллов" else null,
            reward.optString("message").ifBlank { content.joinToString("") { it.text } }.takeIf(String::isNotBlank))
            .joinToString(" · ")
    } else null
    val actor = alert?.name ?: if (isBot && kind in setOf(ChatKind.SUBSCRIPTION, ChatKind.REWARD, ChatKind.NOTICE))
        parts.firstOrNull { it.optString("type") == "mention" }?.let(::displayName) else null
    val displayParts = when {
        details != null -> listOf(ChatPart.Text(details))
        actor != null && botText.isNotBlank() -> listOf(ChatPart.Text(botText))
        else -> content
    }
    return ChatMessage(id, actor?.ifBlank { name } ?: name, displayParts, kind, createdAt, alert = alert).takeIf { it.text.isNotEmpty() }
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
