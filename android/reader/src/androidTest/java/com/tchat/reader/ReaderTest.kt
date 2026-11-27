package com.tchat.reader

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tchat.stream.ChatKind
import com.tchat.stream.ChatPlatform
import com.tchat.stream.ChatFeedUpdates
import com.tchat.stream.ChatMessage
import com.tchat.stream.chatMessage
import com.tchat.stream.parseDonationAlertsPage
import com.tchat.stream.parseTwitchChatMessage
import com.tchat.stream.parseVkChatPage
import com.tchat.stream.parseYouTubeChatAction
import com.tchat.stream.watchYouTube
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okio.Buffer
import org.json.JSONObject
import java.io.IOException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReaderTest {
    @get:Rule val compose = createComposeRule()

    @Test fun allSourcesCoexistAcrossPollsAndFilters() {
        val vk = parseVkChatPage("""{"data":[{"id":7,"createdAt":1760000000,"author":{"displayName":"Ольга"},
            "data":[{"type":"text","content":"Сообщение VK"}]}]}""")
        val cheer = parseTwitchChatMessage(
            "@id=7;bits=25;display-name=Leo;tmi-sent-ts=1760000001000 :leo!leo PRIVMSG #channel :Cheer25"
        )!!
        val superChat = parseYouTubeChatAction(JSONObject("""{"addChatItemAction":{"item":{"liveChatPaidMessageRenderer":{
            "id":"7","authorName":{"simpleText":"Иван"},"purchaseAmountText":{"simpleText":"€5"},
            "timestampUsec":"1760000002000000","message":{"runs":[{"text":"Сообщение YouTube"}]}
        }}}}"""))!!
        val alerts = parseDonationAlertsPage("""{"data":[{"id":7,"username":"Катя","amount":"300.00",
            "currency":"RUB","message":"Спасибо!","created_at_ts":1760000003}]}""").single().chatMessage()
        val pay = parseDonatePayPage("""{"status":"success","data":[
            {"id":"7","type":"donation","status":"success","sum":"500","created_at":"2025-10-09 08:53:24",
             "vars":{"name":"Лена","comment":"Привет!"}},
            {"id":8,"type":"withdraw","sum":300},{"id":9,"type":"donation","status":"cancel","sum":400}]}""")
        val feed = ReaderFeed()
        feed.update(Source.VK, vk, true)
        feed.update(Source.TWITCH, listOf(cheer), false, history = true)
        feed.update(Source.YOUTUBE, listOf(superChat), false, history = true)
        feed.update(Source.DONATION_ALERTS, listOf(alerts), true)
        repeat(2) { feed.update(Source.DONATE_PAY, pay, false) }
        feed.update(Source.VK, vk, true)
        assertEquals(5, feed.items.size)
        assertEquals(5, feed.items.map { it.message.key }.distinct().size)
        assertEquals(4, feed.items.count { it.message.kind == ChatKind.DONATION })
        assertEquals(feed.items.map { it.message.timeMillis }.sortedDescending(), feed.items.map { it.message.timeMillis })
        assertEquals("500 ₽", pay.single().amountLabel)
        assertEquals("300 ₽", alerts.amountLabel)

        compose.setContent {
            MaterialTheme(colorScheme = ReaderColors) {
                FeedScreen(feed.items, feed.items.associate { it.source to "Подключено" }) {}
            }
        }
        compose.onNodeWithContentDescription("YouTube, Подключено").assertExists()
        compose.onNodeWithContentDescription("Настройки").performClick()
        compose.onNodeWithText("Донаты").performClick()
        compose.onNodeWithText("25 Bits", substring = true).assertExists()
        compose.onNodeWithText("€5", substring = true).assertExists()
        compose.onNodeWithText("500 ₽", substring = true).assertExists()
        compose.onNodeWithText("Сообщение VK", substring = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("Настройки").performClick()
        compose.onNodeWithText("Чат").performClick()
        compose.onNodeWithText("Сообщение VK", substring = true).assertExists()
        compose.onNodeWithText("25 Bits", substring = true).assertDoesNotExist()

        compose.runOnIdle {
            feed.update(Source.YOUTUBE, emptyList(), true)
            feed.clear(Source.VK)
            assertEquals(setOf(Source.TWITCH, Source.DONATION_ALERTS, Source.DONATE_PAY), feed.items.map { it.source }.toSet())
        }
    }

    @Test fun canConfigureThreeChannelsAndRejectInvalidLinks() {
        var saved: Map<ChatPlatform, String>? = null
        compose.setContent {
            MaterialTheme(colorScheme = ReaderColors) {
                SourceSettings(ReaderSettings(emptyMap(), ""), emptyMap(), "", false, "Вход не выполнен", false,
                    onAuthorize = {}, onDisconnect = {}, onCancelLogin = {}, onSave = { saved = it.channels },
                    onBack = {})
            }
        }
        fun field(label: String) = compose.onNode(hasSetTextAction() and hasText(label))
        field("VK Видео Live").performTextInput("https://live.vkvideo.ru/test_vk")
        field("Twitch").performTextInput("https://example.com/wrong")
        compose.onNodeWithText("Сохранить").assertIsNotEnabled()
        field("Twitch").performTextReplacement("https://www.twitch.tv/ReaderTest")
        field("YouTube").performTextInput("https://www.youtube.com/watch?v=abcdefghijk")
        compose.onNodeWithText("Сохранить").performClick()
        compose.runOnIdle { assertEquals(mapOf(
            ChatPlatform.VK to "test_vk", ChatPlatform.TWITCH to "readertest", ChatPlatform.YOUTUBE to "abcdefghijk",
        ), saved) }
        field("VK Видео Live").performTextClearance()
        field("Twitch").performTextClearance()
        field("YouTube").performTextClearance()
        compose.onNodeWithText("Сохранить").performClick()
        compose.runOnIdle { assertEquals(emptyMap<ChatPlatform, String>(), saved) }
    }

    @Test fun youtubeFindsNewBroadcastAndReadsChatAndPaidSticker() = runBlocking {
        var channelChecks = 0
        val notices = mutableListOf<String>()
        val incoming = CompletableDeferred<List<ChatMessage>>()
        val job = launch {
            watchYouTube("@reader", receiveMessages = true, interval = 200,
                updates = ChatFeedUpdates(messages = { messages, _ ->
                    if (messages.isNotEmpty()) incoming.complete(messages)
                }, notice = { notices.add(it) }),
            ) { request ->
                when (request.url.pathSegments) {
                    listOf("@reader", "live") -> if (++channelChecks == 1) {
                        """var ytInitialData = {"contents":{}};"""
                    } else {
                        """var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},
                           "videoDetails":{"videoId":"abcdefghijk","isLive":true}};"""
                    }
                    listOf("live_chat") -> {
                        assertEquals("abcdefghijk", request.url.queryParameter("v"))
                        """{"INNERTUBE_CLIENT_VERSION":"2.20260505"}; var ytInitialData = {"contents":{"liveChatRenderer":{
                           "continuations":[{"reloadContinuationData":{"continuation":"first"}}]}}};"""
                    }
                    listOf("youtubei","v1","live_chat","get_live_chat") -> {
                        assertEquals("POST", request.method)
                        """{"continuationContents":{"liveChatContinuation":{"actions":[
                            {"addChatItemAction":{"item":{"liveChatTextMessageRenderer":{"id":"a",
                              "authorName":{"simpleText":"Анна"},"message":{"runs":[{"text":"Всем привет"}]}}}}},
                            {"addChatItemAction":{"item":{"liveChatPaidStickerRenderer":{"id":"b",
                              "authorName":{"simpleText":"Денис"},"purchaseAmountText":{"simpleText":"€3"}}}}}
                           ],"continuations":[{"timedContinuationData":{"continuation":"next","timeoutMs":5000}}]}}}"""
                    }
                    else -> error("Unexpected YouTube request path")
                }
            }
        }
        try {
            val messages = withTimeout(5000) { incoming.await() }
            assertTrue(notices.contains("На YouTube сейчас нет эфира"))
            assertEquals("", notices.last())
            assertEquals(listOf("youtube:a", "youtube:b"), messages.map(ChatMessage::key))
            assertEquals("Всем привет", messages.first().text)
            assertEquals(ChatKind.DONATION, messages.last().kind)
            assertEquals("€3", messages.last().amountLabel)
        } finally {
            job.cancelAndJoin()
        }
    }

    @Test fun publicPopoutReadsInitialRowsAndFollowsFullChatWithoutPlayerAccess() = runBlocking {
        val id = "abcdefghijk"
        assertEquals(id, ChatPlatform.YOUTUBE.normalize("youtube.com/live_chat?is_popout=1&v=$id"))
        assertEquals(id, ChatPlatform.YOUTUBE.normalize("https://youtu.be/$id?si=shared"))
        fun action(key: String) = """{"addChatItemAction":{"item":{"liveChatTextMessageRenderer":{
            "id":"$key","authorName":{"simpleText":"Reader"},"message":{"runs":[{"text":"$key"}]}}}}}"""
        val welcome = """{"addChatItemAction":{"item":{"liveChatViewerEngagementMessageRenderer":{
            "id":"banner","message":{"runs":[{"text":"Welcome to live chat!"}]},
            "actionButton":{"buttonRenderer":{"navigationEndpoint":{"urlEndpoint":{
            "url":"//support.google.com/youtube/answer/2853856?hl=en#safe"}}}}}}}}"""
        val feed = ReaderFeed()
        val batches = mutableListOf<List<String>>()
        val received = CompletableDeferred<Unit>()
        val cursors = mutableListOf<String>()
        val job = launch {
            watchYouTube(id, true, 60_000, ChatFeedUpdates(messages = { batch, replace ->
                feed.update(Source.YOUTUBE, batch, replace)
                if (batch.isNotEmpty()) batches.add(batch.map(ChatMessage::text))
                if (batch.any { it.text == "new" }) received.complete(Unit)
            }, notice = {})) { request ->
                assertEquals("www.youtube.com", request.url.host)
                when (request.url.encodedPath) {
                    "/watch" -> throw IOException("Player unavailable")
                    "/live_chat" -> {
                        assertEquals(id, request.url.queryParameter("v"))
                        assertEquals("1", request.url.queryParameter("is_popout"))
                        """{"INNERTUBE_CLIENT_VERSION":"2.20261125.00.00"}; window["ytInitialData"] = {
                            "contents":{"liveChatRenderer":{
                              "actions":[$welcome,${action("first")}],
                              "continuations":[{"invalidationContinuationData":{"continuation":"filtered","timeoutMs":10000}}],
                              "header":{"liveChatHeaderRenderer":{"viewSelector":{"sortFilterSubMenuRenderer":{"subMenuItems":[
                                {"title":"Top chat","selected":true,"continuation":{"reloadContinuationData":{"continuation":"top"}}},
                                {"title":"Live chat","selected":false,"continuation":{"reloadContinuationData":{"continuation":"all"}}}
                              ]}}}}}}};"""
                    }
                    "/youtubei/v1/live_chat/get_live_chat" -> {
                        assertEquals("POST", request.method)
                        assertEquals("2.20261125.00.00", request.header("X-YouTube-Client-Version"))
                        val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
                        val cursor = JSONObject(body).getString("continuation")
                        cursors.add(cursor)
                        val rows = when (cursor) {
                            "all" -> listOf(action("first"), action("full-only"))
                            "next" -> listOf(action("new"))
                            else -> error("Unexpected cursor $cursor")
                        }
                        """{"continuationContents":{"liveChatContinuation":{"actions":[${rows.joinToString(",")}],
                           "continuations":[{"timedContinuationData":{"continuation":"next","timeoutMs":3500}}]}}}"""
                    }
                    else -> error("Unexpected YouTube path")
                }
            }
        }
        try {
            withTimeout(12_000) { received.await() }
            assertEquals(listOf("all", "next"), cursors)
            assertEquals(listOf(listOf("first"), listOf("first", "full-only"), listOf("new")), batches)
            assertEquals(setOf("first", "full-only", "new"), feed.items.map { it.message.text }.toSet())
            assertEquals(3, feed.items.size)
        } finally { job.cancelAndJoin() }
    }

    @Test fun endedYouTubeBroadcastDoesNotOpenReplayAsLiveChat() = runBlocking {
        val notice = CompletableDeferred<String>()
        val job = launch {
            watchYouTube("abcdefghijk", true, 60_000, ChatFeedUpdates(messages = { _, _ -> }, notice = { notice.complete(it) })) { request ->
                assertEquals("/watch", request.url.encodedPath)
                """var ytInitialPlayerResponse = {"playabilityStatus":{"status":"UNPLAYABLE"},
                   "microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{
                   "isLiveNow":false,"endTimestamp":"2026-05-20T02:11:23+00:00"}}}};"""
            }
        }
        try { assertEquals("Эфир YouTube завершён", withTimeout(5_000) { notice.await() }) }
        finally { job.cancelAndJoin() }
    }
}
