package com.tchat.reader

import com.tchat.stream.ChatKind
import com.tchat.stream.ChatMessage
import com.tchat.stream.ChatPart
import com.tchat.stream.objects
import com.tchat.stream.requestText
import io.socket.client.IO
import io.socket.client.Socket
import java.io.IOException
import java.text.NumberFormat
import java.time.Instant
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal fun desktopAddress(value: String): String? {
    val input = value.trim().takeIf(String::isNotBlank) ?: return null
    val url = (if ("://" in input) input else "http://$input").toHttpUrlOrNull() ?: return null
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.encodedPath != "/" || url.query != null || url.fragment != null) return null
    return url.toString().trimEnd('/')
}

private data class Packet(val type: String, val body: Any?)
private val liveEvents = listOf("chat:history", "chat:message", "chat:status", "donation:alert",
    "subscriber:alert", "subscription-renewal:alert", "raid:alert", "chat:music-request", "vk:likes", "chat:event", "chat:events")

internal suspend fun watchDesktop(url: String, rows: (List<FeedItem>, history: Boolean) -> Unit, notice: (String) -> Unit,
    platforms: (Map<Source, String>) -> Unit,
    viewers: (Map<Source, Long>) -> Unit) = coroutineScope {
    val socket = IO.socket(url, IO.Options().apply { forceNew = true })
    val inbox = Channel<Packet>(512)
    for (event in liveEvents + listOf(Socket.EVENT_CONNECT, Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR)) {
        socket.on(event) { args ->
            if (!inbox.trySend(Packet(event, args.firstOrNull())).isSuccess) inbox.close(IOException("Desktop feed overflow"))
        }
    }
    var hasTextEvents = false
    suspend fun snapshot(path: String, type: String) {
        try {
            val json = JSONObject(requestText(Request.Builder().url("$url/$path").build()))
            val records = (json.optJSONArray(if (type == "reward") "rewards" else "queue"))?.objects().orEmpty()
            if (!hasTextEvents || type == "chat:music-request") rows(records.mapNotNull { desktopRow(type, it, url) }, true)
        } catch (_: IOException) { /* Standalone TChat may only supply live events. */ }
          catch (_: JSONException) { /* A server may not have this history. */ }
    }
    var snapshots: Job? = null
    try {
        socket.connect()
        for ((type, body) in inbox) {
            when (type) {
                Socket.EVENT_CONNECT -> {
                    notice("")
                    snapshots?.cancel()
                    snapshots = launch {
                        launch { snapshot("music/state", "chat:music-request") }
                        delay(1000)
                        if (!hasTextEvents) snapshot("alerts/state", "queue")
                        while (isActive && !hasTextEvents) { snapshot("stickers/state", "reward"); delay(15_000) }
                    }
                }
                Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR -> {
                    hasTextEvents = false
                    snapshots?.cancel()
                    notice("Нет связи с TChat. Повторяем…")
                }
                "chat:status" -> {
                    val packet = body as? JSONObject ?: continue
                    val raw = packet.optJSONObject("statuses") ?: JSONObject()
                    val states = raw.keys().asSequence().mapNotNull { name ->
                        val source = desktopSource(name)
                        val state = raw.optString(name)
                        if (source == Source.TCHAT || state in setOf("", "канал не задан")) null else source to when (state) {
                            "подключён" -> "Подключено"
                            "подключаем" -> "Подключение…"
                            else -> state
                        }
                    }.toMap()
                    platforms(states)
                    val counts = packet.optJSONObject("viewers") ?: continue
                    viewers(counts.keys().asSequence().mapNotNull { name ->
                        desktopSource(name).takeIf { it != Source.TCHAT && !counts.isNull(name) && (raw.length() == 0 || it in states) }
                            ?.let { it to counts.optLong(name) }
                    }.toMap())
                }
                "chat:history" -> rows((body as? JSONArray)?.objects().orEmpty().mapNotNull { desktopRow("chat:message", it, url) }, true)
                "chat:message" -> if (body is JSONObject && !(hasTextEvents && body.optString("readerEventId").isNotBlank()))
                    desktopRow(type, body, url)?.let { rows(listOf(it), false) }
                "chat:events" -> {
                    hasTextEvents = true
                    rows((body as? JSONArray)?.objects().orEmpty().mapNotNull { desktopRow("chat:event", it, url) }, true)
                }
                "subscriber:alert", "subscription-renewal:alert", "raid:alert", "donation:alert" ->
                    if (!hasTextEvents) (body as? JSONObject)?.let { desktopRow(type, it, url) }?.let { rows(listOf(it), false) }
                else -> (body as? JSONObject)?.let { desktopRow(type, it, url) }?.let { rows(listOf(it), false) }
            }
        }
    } finally {
        snapshots?.cancel()
        socket.off()
        socket.disconnect()
        inbox.cancel()
    }
}

private fun desktopSource(platform: String) = when (platform.lowercase()) {
    "vk" -> Source.VK
    "twitch" -> Source.TWITCH
    "youtube" -> Source.YOUTUBE
    "rutube" -> Source.RUTUBE
    "donatepay" -> Source.DONATE_PAY
    "donationalerts" -> Source.DONATION_ALERTS
    else -> Source.TCHAT
}

private fun money(value: Double, currency: String): String {
    val formatted = NumberFormat.getNumberInstance(Locale.forLanguageTag("ru-RU")).apply { maximumFractionDigits = 2 }.format(value)
    return "$formatted " + if (currency.isBlank() || currency == "RUB") "₽" else currency
}

private fun desktopParts(data: JSONObject, server: String?): List<ChatPart> =
    data.optJSONArray("parts")?.objects().orEmpty().mapNotNull { part ->
        if (part.optString("type") != "image") return@mapNotNull part.optString("text").takeIf(String::isNotEmpty)?.let(ChatPart::Text)
        val raw = part.optString("url")
        val base = server?.toHttpUrlOrNull()
        val address = when {
            raw.startsWith("//") -> "https:$raw".toHttpUrlOrNull()
            raw.startsWith("/assets/") -> base?.resolve(raw)
            else -> raw.toHttpUrlOrNull()
        }
        val url = if (address != null && address.host in setOf("localhost", "127.0.0.1", "::1") && address.encodedPath.startsWith("/assets/"))
            base?.resolve(address.encodedPath) else address
        val name = part.optString("alt").ifBlank { "Смайлик" }
        if (url == null || url.username.isNotEmpty() || url.password.isNotEmpty()) ChatPart.Text("🙂") else ChatPart.Emote(name, url.toString())
    }

internal fun desktopRow(type: String, data: JSONObject, server: String? = null): FeedItem? {
    if (type == "chat:event") {
        val eventType = when (data.optString("type")) {
            "subscriber" -> "subscriber:alert"
            "renewal" -> "subscription-renewal:alert"
            "raid" -> "raid:alert"
            "donation" -> "donation:alert"
            "reward" -> "reward"
            else -> return null
        }
        return data.optJSONObject("event")?.let { desktopRow(eventType, it, server) }
    }
    if (type == "queue") {
        val (event, field) = when (data.optString("kind")) {
            "subscriber" -> "subscriber:alert" to "subscriber"
            "subscriptionRenewal" -> "subscription-renewal:alert" to "renewal"
            "raid" -> "raid:alert" to "raid"
            "donation" -> "donation:alert" to "donation"
            else -> return null
        }
        return data.optJSONObject(field)?.let { desktopRow(event, it, server) }
    }
    val payload = if (type == "chat:music-request") data.optJSONObject("donation") ?: data else data
    if (payload.optBoolean("isTest") && !payload.optBoolean("showInChat")) return null
    val source = if (type == "vk:likes") Source.VK else desktopSource(payload.optString("source").ifBlank { payload.optString("platform") })
    val author = payload.optString("user").ifBlank { payload.optString("username") }
    val stamp = payload.optString("createdAt").ifBlank { data.optString("queuedAt") }
    val time = try { Instant.parse(stamp).toEpochMilli() } catch (_: java.time.DateTimeException) { 0L }
    val note = payload.optString("message")
    var body = note
    var parts = emptyList<ChatPart>()
    var amount = ""
    val kind = when (type) {
        "chat:message" -> {
            parts = desktopParts(data, server)
            body = data.optString("text").ifBlank { parts.joinToString("") { it.text } }
            when {
                data.optString("systemEvent") == "twitch-follow" -> ChatKind.FOLLOW
                data.optString("systemEvent") == "twitch-subscription" -> ChatKind.SUBSCRIPTION
                data.optString("readerEventId").startsWith("vk:reward:") -> ChatKind.REWARD
                data.optString("readerEventId").startsWith("vk:renewal:") -> ChatKind.SUBSCRIPTION
                data.optString("readerEventId").startsWith("vk:sub:") -> if (body.contains("отслежива", true)) ChatKind.FOLLOW else ChatKind.SUBSCRIPTION
                data.optBoolean("highlighted") -> ChatKind.REWARD
                author.equals("ChatBot", true) -> ChatKind.BOT
                else -> ChatKind.VIEWER
            }
        }
        "subscriber:alert" -> if (note.contains("отслежива", true)) ChatKind.FOLLOW else ChatKind.SUBSCRIPTION
        "subscription-renewal:alert" -> ChatKind.SUBSCRIPTION
        "raid:alert" -> {
            body = "привёл рейд" + (data.optInt("viewers").takeIf { it > 0 }?.let { " · зрителей $it" } ?: "")
            ChatKind.RAID
        }
        "donation:alert" -> {
            amount = money(payload.optDouble("amount", 0.0), payload.optString("currency"))
            ChatKind.DONATION
        }
        "chat:music-request" -> {
            if (data.optString("status") == "checking") return null
            amount = payload.optDouble("amount", 0.0).takeIf { it > 0 }?.let { money(it, payload.optString("currency")) }.orEmpty()
            body = listOf(data.optString("title"), data.optString("reason")).filter(String::isNotBlank).joinToString(" — ")
            ChatKind.MUSIC
        }
        "reward" -> {
            body = listOfNotNull(payload.optString("reward").takeIf(String::isNotBlank),
                payload.optInt("price").takeIf { it > 0 }?.let { "$it баллов" }, note.takeIf(String::isNotBlank)).joinToString(" · ")
            ChatKind.REWARD
        }
        "vk:likes" -> { body = "Новые отметки «Нравится» · +${data.optInt("count")}"; ChatKind.NOTICE }
        else -> return null
    }
    if (body.isBlank() && kind == ChatKind.VIEWER) return null
    // Twitch publishes the same follow/subscription through chat and through the alert queue.
    val family = when (kind) {
        ChatKind.FOLLOW, ChatKind.SUBSCRIPTION, ChatKind.VIEWER, ChatKind.BOT, ChatKind.RAID -> "chat"
        else -> kind.name
    }
    val id = data.optString("readerEventId").ifBlank { data.optString("id") }.ifBlank { "$stamp|$author|$body" }
    val message = ChatMessage(time, author.ifBlank { if (kind == ChatKind.DONATION) "Аноним" else source.label },
        parts.ifEmpty { listOf(ChatPart.Text(body)) }, kind, time, amountLabel = amount, platformKey = "desktop:${source.name}:$family:$id",
        authorColor = payload.optString("color"))
    return FeedItem(source, message)
}
