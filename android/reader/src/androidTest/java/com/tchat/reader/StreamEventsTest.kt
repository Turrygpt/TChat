package com.tchat.reader

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tchat.stream.ChatKind
import com.tchat.stream.ChatMessage
import com.tchat.stream.parseTwitchChatMessage
import com.tchat.stream.parseVkChatPage
import com.tchat.stream.parseYouTubeChatAction
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StreamEventsTest {
    @Test fun publicSubscriptionsGiftsRaidsAndRewardsHaveReadableText() {
        fun twitch(type: String, tags: String, body: String = "") = parseTwitchChatMessage(
            "@id=$type;display-name=Alex;msg-id=$type;$tags :tmi.twitch.tv USERNOTICE #channel" + if (body.isBlank()) "" else " :$body"
        )!!
        assertEquals("продлил подписку (Prime) · месяцев 6 — Ура", twitch("resub", "msg-param-sub-plan=Prime;msg-param-cumulative-months=6", "Ура").text)
        assertTrue(twitch("subgift", "msg-param-recipient-display-name=Maria").text.contains("Maria"))
        assertTrue(twitch("anonsubmysterygift", "msg-param-mass-gift-count=12").text.contains("12"))
        val raid = twitch("raid", "msg-param-displayName=Visitor;msg-param-viewerCount=42")
        assertEquals("Visitor", raid.author)
        assertEquals("привёл рейд · зрителей 42", raid.text)
        assertEquals(ChatKind.RAID, raid.kind)
        val vk = parseVkChatPage("""{"data":[{"id":1,"author":{"id":12529926,"displayName":"ChatBot"},"data":[
           {"type":"mention","displayName":"Иван"},{"type":"text","content":"теперь отслеживает канал"}]},
           {"id":2,"author":{"displayName":"Маша"},"rewardInfo":{"title":"Выделить сообщение","cost":250,"message":"Привет"}},
           {"id":3,"author":{"id":12529926,"displayName":"ChatBot"},"data":[{"type":"mention","displayName":"Канал"},
           {"type":"mention","displayName":"Гость"},{"type":"text","content":"начинает на вас рейд с 12 зрителями!"}]}]}""")
        assertTrue(vk.any { it.author == "Иван" && it.kind == ChatKind.FOLLOW })
        assertTrue(vk.any { it.author == "Гость" && it.kind == ChatKind.RAID && "12" in it.text })
        assertTrue(vk.any { it.kind == ChatKind.REWARD && "250 баллов" in it.text && "Привет" in it.text })
        val gift = parseYouTubeChatAction(JSONObject("""{"addChatItemAction":{"item":{"liveChatSponsorshipsGiftPurchaseAnnouncementRenderer":{
            "id":"gift","header":{"liveChatSponsorshipsHeaderRenderer":{"authorName":{"simpleText":"Лена"},
            "primaryText":{"runs":[{"text":"Подарила 5 спонсорств"}]}}}}}}}"""))!!
        assertEquals(ChatKind.SUBSCRIPTION, gift.kind)
        assertEquals("Лена", gift.author)
        assertEquals("Подарила 5 спонсорств", gift.text)
    }

    @Test fun desktopHistoryAndNewEventsShareIdsAndIgnoreMedia() {
        val event = JSONObject("""{"id":"twitch:subscription:7","platform":"twitch","username":"Kate","message":"оформила подписку"}""")
        val live = desktopRow("chat:event", JSONObject().put("type","subscriber").put("event",event))!!
        val chat = desktopRow("chat:message", JSONObject(event.toString()).put("user","Kate").put("text","оформила подписку")
            .put("systemEvent","twitch-subscription"))!!
        val history = desktopRow("queue", JSONObject().put("kind","subscriber").put("subscriber",event))!!
        val feed = ReaderFeed()
        feed.update(Source.TWITCH, listOf(live.message, history.message, chat.message), false)
        assertEquals(1, feed.items.size)
        val donation = JSONObject("""{"id":"7","username":"Катя","amount":350,"currency":"RUB","message":"Текст доната"}""")
        val row = desktopRow("queue", JSONObject().put("kind","donation").put("donation",donation)
            .put("rule", JSONObject().put("video","ignored.mp4")))!!
        assertEquals("350 ₽", row.message.amountLabel)
        assertEquals("Текст доната", row.message.text)
        assertNull(desktopRow("queue", JSONObject().put("kind","firstMessage")))
        assertNull(desktopRow("donation:alert", donation.put("isTest",true)))
    }

    @Test fun ownerConnectionReceivesFollowsAndRedemptions() = runBlocking {
        val server = MockWebServer()
        val subscriptions = CopyOnWriteArrayList<JSONObject>()
        val peer = CompletableDeferred<WebSocket>()
        val received = mutableListOf<ChatMessage>()
        val done = CompletableDeferred<Unit>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/oauth2/validate" -> MockResponse().setBody("""{"user_id":"123","login":"reader","client_id":"public",
                    "scopes":["moderator:read:followers","channel:read:redemptions"]}""")
                "/ws" -> MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        peer.complete(webSocket)
                        webSocket.send("""{"metadata":{"message_type":"session_welcome"},"payload":{"session":{"id":"session","keepalive_timeout_seconds":10}}}""")
                    }
                })
                "/helix/eventsub/subscriptions" -> {
                    subscriptions.add(JSONObject(request.body.readUtf8()))
                    MockResponse().setResponseCode(202).setBody("{}")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(request.newBuilder().url(server.url(request.url.encodedPath)).build())
        }.build()
        val ready = CompletableDeferred<Unit>()
        val job = launch {
            watchTwitchEvents("reader", "test-only", message = { received.add(it); if (received.size == 2) done.complete(Unit) },
                notice = { if ("подключено" in it) ready.complete(Unit) }, http = http)
        }
        try {
            withTimeout(10_000) {
                ready.await()
                assertEquals(setOf("channel.follow", "channel.channel_points_custom_reward_redemption.add"),
                    subscriptions.map { it.getString("type") }.toSet())
                assertTrue(subscriptions.all { it.getJSONObject("transport").getString("session_id") == "session" })
                val ws = peer.await()
                fun send(type: String, body: String) = ws.send("""{"metadata":{"message_type":"notification"},"payload":{
                    "subscription":{"type":"$type"},"event":$body}}""")
                send("channel.follow", """{"broadcaster_user_id":"123","user_id":"42","user_name":"Ben","followed_at":"2026-10-10T12:00:00Z"}""")
                send("channel.channel_points_custom_reward_redemption.add", """{"broadcaster_user_id":"123","id":"7","user_name":"Ann",
                    "reward":{"title":"Приветствие","cost":350},"user_input":"Добрый вечер","redeemed_at":"2026-10-10T12:01:00Z"}""")
                done.await()
            }
            assertEquals(listOf(ChatKind.FOLLOW, ChatKind.REWARD), received.map(ChatMessage::kind))
            assertTrue(received.last().text.contains("350 баллов · Добрый вечер"))
        } finally {
            job.cancelAndJoin()
            server.shutdown()
        }
    }
}
