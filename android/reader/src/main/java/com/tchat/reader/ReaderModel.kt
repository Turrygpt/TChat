package com.tchat.reader

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tchat.stream.ChatFeedUpdates
import com.tchat.stream.ChatFilters
import com.tchat.stream.ChatKind
import com.tchat.stream.ChatMessage
import com.tchat.stream.ChatPlatform
import com.tchat.stream.DonationAccount
import com.tchat.stream.watchChatPlatform
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

internal enum class Source(val label: String, val platform: ChatPlatform? = null) {
    VK("VK Видео Live", ChatPlatform.VK),
    TWITCH("Twitch", ChatPlatform.TWITCH),
    YOUTUBE("YouTube", ChatPlatform.YOUTUBE),
    DONATION_ALERTS("DonationAlerts"),
    DONATE_PAY("DonatePay"),
    RUTUBE("Rutube"),
    TCHAT("TChat"),
}

internal const val HIGHLIGHT_DURATION_MS = 30_000L
internal data class FeedItem(val source: Source, val message: ChatMessage, val arrival: Long = 0, val highlightUntil: Long = 0)

internal class ReaderFeed(private val elapsed: () -> Long = android.os.SystemClock::elapsedRealtime,
    private val wallTime: () -> Long = System::currentTimeMillis) {
    private val pages = mutableStateMapOf<Source, List<FeedItem>>()
    private val seenEvents = mutableMapOf<Source, LinkedHashMap<String, Long>>()
    private val startedAt = wallTime()
    private var sequence = 0L
    private val newestFirst = compareByDescending<FeedItem> { it.message.timeMillis }.thenByDescending { it.arrival }
    val items by derivedStateOf { pages.values.flatten().sortedWith(newestFirst) }

    fun update(source: Source, batch: List<ChatMessage>, replace: Boolean, history: Boolean = false) {
        val previous = pages[source].orEmpty().associateBy { it.message.key }
        val result = if (replace) mutableMapOf() else previous.toMutableMap()
        // History pages arrive newest first. Live action batches arrive in publication order.
        val distinct = batch.distinctBy(ChatMessage::key)
        val snapshot = replace || source == Source.DONATE_PAY || source == Source.DONATION_ALERTS
        val incoming = if (snapshot) distinct.asReversed() else distinct
        val firstSnapshot = snapshot && source !in pages
        val seen = seenEvents.getOrPut(source) { linkedMapOf() }
        for (message in incoming) {
            val old = previous[message.key]
            val highlight = when (message.kind) {
                ChatKind.DONATION, ChatKind.FOLLOW, ChatKind.SUBSCRIPTION, ChatKind.RAID -> seen.getOrPut(message.key) {
                    val fresh = !history && !firstSnapshot && (!snapshot || message.timeMillis == 0L || message.timeMillis >= startedAt - 1000)
                    if (fresh) elapsed() + HIGHLIGHT_DURATION_MS else 0L
                }
                else -> 0L
            }
            result[message.key] = FeedItem(source, message, old?.arrival ?: ++sequence, old?.highlightUntil ?: highlight)
        }
        while (seen.size > 500) seen.remove(seen.keys.first())
        pages[source] = result.values.sortedWith(newestFirst).take(200)
    }

    fun clear(source: Source) { pages.remove(source); seenEvents.remove(source) }
    fun clear() { pages.clear(); seenEvents.clear() }
}

internal data class ReaderSettings(
    val channels: Map<ChatPlatform, String>,
    val donatePayKey: String,
    val twitchToken: String = "",
    val desktopUrl: String = "",
    val useDesktop: Boolean = false,
)

internal class ReaderModel(application: Application) : AndroidViewModel(application) {
    private val prefs = application.getSharedPreferences("reader", Context.MODE_PRIVATE)
    private val saved = MutableStateFlow(ReaderSettings(
        ChatPlatform.entries.mapNotNull { p -> prefs.getString(p.name, null)?.let(p::normalize)?.let { p to it } }.toMap(),
        prefs.getString("donatePayKey", "").orEmpty(),
        prefs.getString("twitchToken", "").orEmpty(),
        prefs.getString("desktopUrl", "").orEmpty(),
        prefs.getBoolean("useDesktop", false),
    ))
    val settings = saved.asStateFlow()
    val feed = ReaderFeed()
    val updater = ReaderUpdater(application, viewModelScope)
    var fontSize by androidx.compose.runtime.mutableFloatStateOf(prefs.getFloat("fontSize", 16f).coerceIn(MIN_FONT, MAX_FONT))
        private set
    fun saveFont(value: Float) {
        fontSize = value.coerceIn(MIN_FONT, MAX_FONT)
        prefs.edit().putFloat("fontSize", fontSize).apply()
    }
    val notices = mutableStateMapOf<Source, String>()
    val viewers = mutableStateMapOf<Source, Long>()
    var twitchEventNotice by mutableStateOf("")
        private set
    var filters by mutableStateOf(ChatFilters(
        kinds = prefs.getStringSet("chatHiddenKinds", null).orEmpty().toSet(),
        authors = prefs.getStringSet("chatHiddenAuthors", null).orEmpty().toSet(),
        messages = prefs.getStringSet("chatHiddenMessages", null).orEmpty().toSet(),
    ))
        private set
    val donationAlerts = DonationAccount(application, viewModelScope, returnUri = Uri.parse("tchat-reader://donations/return"))
    val clientId: String get() = prefs.getString("donationClientId", null).orEmpty().ifBlank { BuildConfig.DONATION_CLIENT_ID }

    fun updateFilters(next: ChatFilters) {
        prefs.edit().putStringSet("chatHiddenKinds", next.kinds).putStringSet("chatHiddenAuthors", next.authors)
            .putStringSet("chatHiddenMessages", next.messages).apply()
        filters = next
    }

    fun save(next: ReaderSettings) {
        if (next == saved.value) return
        val edit = prefs.edit()
        if (next.useDesktop != saved.value.useDesktop || next.useDesktop && next.desktopUrl != saved.value.desktopUrl) {
            feed.clear()
            viewers.clear()
            notices.clear()
        }
        if (next.twitchToken != saved.value.twitchToken || next.channels[ChatPlatform.TWITCH] != saved.value.channels[ChatPlatform.TWITCH]) {
            twitchEventNotice = ""
        }
        edit.putString("twitchToken", next.twitchToken).putString("desktopUrl", next.desktopUrl).putBoolean("useDesktop", next.useDesktop)
        for (source in Source.entries) {
            val platform = source.platform ?: continue
            if (saved.value.channels[platform] != next.channels[platform]) {
                edit.putString(platform.name, next.channels[platform])
                feed.clear(source)
                notices.remove(source)
                viewers.remove(source)
            }
        }
        if (saved.value.donatePayKey != next.donatePayKey) {
            edit.putString("donatePayKey", next.donatePayKey)
            feed.clear(Source.DONATE_PAY)
            notices.remove(Source.DONATE_PAY)
        }
        edit.apply()
        saved.value = next
    }

    fun authorize(clientId: String, openBrowser: (Uri) -> Unit) {
        prefs.edit().putString("donationClientId", clientId).apply()
        donationAlerts.authorize(clientId, openBrowser)
    }

    suspend fun watch() {
        settings.map { if (it.useDesktop) it.desktopUrl else null }.distinctUntilChanged().collectLatest { url ->
            if (url == null) {
                watchDirect()
            } else while (currentCoroutineContext().isActive) {
                notices[Source.TCHAT] = "Подключение…"
                try {
                    watchDesktop(url,
                        rows = { items, history -> items.groupBy(FeedItem::source).forEach { (source, batch) ->
                            feed.update(source, batch.map(FeedItem::message), replace = false, history = history)
                        } },
                        notice = {
                            if (it.isNotEmpty()) { notices.clear(); viewers.clear() }
                            notices[Source.TCHAT] = it
                        },
                        platforms = { states ->
                            notices.keys.filter { it != Source.TCHAT && it !in states }.forEach(notices::remove)
                            notices.putAll(states)
                        },
                        viewers = { counts -> viewers.clear(); viewers.putAll(counts) },
                    )
                } catch (_: java.io.IOException) {
                    notices[Source.TCHAT] = "Нет связи с TChat. Повторяем…"
                }
                delay(5000)
            }
        }
    }

    private suspend fun watchDirect() = coroutineScope {
        for (source in Source.entries) {
            val platform = source.platform ?: continue
            launch {
                settings.map { it.channels[platform] }.distinctUntilChanged().collectLatest { address ->
                    if (address == null) return@collectLatest
                    notices[source] = "Подключение…"
                    watchChatPlatform(platform, address, receiveMessages = true, economy = true,
                        updates = ChatFeedUpdates(
                            includeVkLikes = true,
                            messages = { batch, replace ->
                                if (!settings.value.useDesktop && settings.value.channels[platform] == address) feed.update(source, batch, replace)
                            },
                            history = { batch ->
                                if (!settings.value.useDesktop && settings.value.channels[platform] == address) feed.update(source, batch, false, history = true)
                            },
                            viewers = { count -> if (count == null) viewers.remove(source) else viewers[source] = count },
                            notice = { if (settings.value.channels[platform] == address) notices[source] = it },
                        ),
                    )
                }
            }
        }
        launch {
            settings.map { it.channels[ChatPlatform.TWITCH] to it.twitchToken }.distinctUntilChanged().collectLatest { (channel, token) ->
                if (channel == null || token.isBlank()) return@collectLatest
                twitchEventNotice = "Подключение к событиям…"
                watchTwitchEvents(channel, token, message = {
                    if (!settings.value.useDesktop && settings.value.channels[ChatPlatform.TWITCH] == channel && settings.value.twitchToken == token)
                        feed.update(Source.TWITCH, listOf(it), replace = false)
                }, notice = { twitchEventNotice = it })
            }
        }
        launch {
            settings.map { it.donatePayKey }.distinctUntilChanged().collectLatest { key ->
                if (key.isBlank()) return@collectLatest
                notices[Source.DONATE_PAY] = "Подключение…"
                watchDonatePay(key,
                    onPage = { if (settings.value.donatePayKey == key) feed.update(Source.DONATE_PAY, it, replace = false) },
                    notice = { if (settings.value.donatePayKey == key) notices[Source.DONATE_PAY] = it },
                )
            }
        }
        launch {
            donationAlerts.token.collectLatest { token ->
                if (token.isBlank()) {
                    feed.clear(Source.DONATION_ALERTS)
                    return@collectLatest
                }
                val savedPage = donationAlerts.chat.value
                if (savedPage.isNotEmpty()) feed.update(Source.DONATION_ALERTS, savedPage, false, history = true)
                var firstPage = savedPage.isEmpty()
                donationAlerts.monitor(token, onDonation = {}, onPage = { page ->
                    feed.update(Source.DONATION_ALERTS, page, false, history = firstPage)
                    firstPage = false
                })
            }
        }
    }
}
