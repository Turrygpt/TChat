package com.tchat.reader

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.net.Uri
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tchat.stream.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MobileReaderTest {
    @get:Rule val compose = createComposeRule()
    private fun line(id: Long, kind: ChatKind, name: String = "Мира", time: Long = 50_000) =
        ChatMessage(id, name, listOf(ChatPart.Text("Строка $id")), kind, time, platformKey = "test:$id")

    @Test fun newestFirstAndOnlyFreshEventsPulseForThirtySeconds() {
        var elapsed = 2000L
        val feed = ReaderFeed({ elapsed }, { 50_000L })
        feed.update(Source.DONATION_ALERTS, listOf(line(90, ChatKind.DONATION)), false, history = true)
        val events = listOf(ChatKind.DONATION, ChatKind.FOLLOW, ChatKind.SUBSCRIPTION, ChatKind.RAID)
        events.forEachIndexed { i, kind -> feed.update(Source.TWITCH, listOf(line(i.toLong(), kind)), false) }
        feed.update(Source.TWITCH, listOf(line(4, ChatKind.VIEWER)), false)
        assertEquals(listOf(4L, 3L, 2L, 1L, 0L, 90L), feed.items.map { it.message.id })
        assertEquals(0L, feed.items.first().highlightUntil)
        assertEquals(0L, feed.items.last().highlightUntil)
        assertTrue(feed.items.subList(1,5).all { it.highlightUntil == 32_000L })
        elapsed += 900
        val deadline = feed.items[1].highlightUntil
        assertTrue(eventPulseAlpha(deadline - elapsed) < eventPulseAlpha(30_000L))
        feed.update(Source.TWITCH, emptyList(), true)
        feed.update(Source.TWITCH, listOf(line(3, ChatKind.RAID)), false, history = true)
        assertEquals(deadline, feed.items.first().highlightUntil)
        assertTrue(eventPulseAlpha(1L) > 0f)
        assertEquals(0f, eventPulseAlpha(0L), 0f)
        assertEquals(0f, eventPulseAlpha(-5000L), 0f)
    }

    @Test fun colorsAndEmotesSurviveTheDesktopConnection() {
        val row = desktopRow("chat:message", JSONObject("""{"id":"9","user":"Spark","platform":"twitch",
            "color":"#AABBCC","parts":[{"type":"text","text":"Привет "},
            {"type":"image","url":"http://localhost:3000/assets/chat/emotes/25.png","alt":"Kappa"}]}"""), "http://192.168.1.2:3100")!!
        assertEquals(ChatPart.Emote("Kappa","http://192.168.1.2:3100/assets/chat/emotes/25.png"), row.message.parts.last())
        assertEquals(Color(0xFFAABBCC), nickColor(row.source, row.message.author, row.message.authorColor))
        assertNotEquals(nickColor(Source.VK,"Мира",""),nickColor(Source.VK,"Лена",""))
        val parsed = parseTwitchChatMessage("@id=x;color=#112233;display-name=Spark;emotes=25:0-4 :spark!s PRIVMSG #c :Kappa")!!
        assertEquals("#112233", parsed.authorColor)
        assertTrue(parsed.parts.first() is ChatPart.Emote)
    }

    @Test fun compactFeedZoomsAndCanHideAndRestoreAnAuthor() {
        var saved = 16f
        val model = ReaderFeed()
        model.update(Source.VK, listOf(line(1,ChatKind.VIEWER,"Мира"),line(2,ChatKind.VIEWER,"Лена")),false)
        compose.setContent {
            var filters by remember { mutableStateOf(ChatFilters()) }
            MaterialTheme(colorScheme = ReaderColors) {
                FeedScreen(model.items, mapOf(Source.VK to "Подключено"), mapOf(Source.VK to 57),
                    filters, { filters=it }, savedFont=16f, onFontSize={saved=it}) {}
            }
        }
        compose.onNodeWithContentDescription("VK Видео Live, Подключено, зрителей 57").assertExists()
        compose.onNodeWithText("Источники").assertDoesNotExist()
        compose.onNodeWithText("Донаты").assertDoesNotExist()
        val top = compose.onNodeWithText("Строка 2", substring = true).getUnclippedBoundsInRoot().top
        assertTrue(top < compose.onNodeWithText("Строка 1", substring = true).getUnclippedBoundsInRoot().top)
        compose.onNodeWithTag("reader-chat").performTouchInput {
            down(0,center-Offset(40f,0f)); down(1,center+Offset(40f,0f))
            for (step in 1..5) {
                updatePointerTo(0,center-Offset(40f+step*9,0f)); updatePointerTo(1,center+Offset(40f+step*9,0f)); move()
            }
            up(1); up(0)
        }
        compose.runOnIdle { assertTrue("Font after pinch: $saved",saved > 23f) }
        compose.onNodeWithText("Строка 1", substring = true).performTouchInput { longClick() }
        compose.onNodeWithText("Пользователь «Мира»").performClick()
        compose.onNodeWithText("Строка 1", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Строка 2", substring = true).assertExists()
        compose.onNodeWithContentDescription("Настройки").performClick()
        compose.onNodeWithText("Фильтры чата").performClick()
        compose.onNodeWithText("Показать «мира»").performScrollTo().performClick()
        compose.onNodeWithText("Готово").performClick()
        compose.onNodeWithText("Строка 1", substring = true).assertExists()
    }

    @Test fun donationConsentReturnsToPhoneAndReadsNewDonations() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val isolatedPrefs = "test-donations-" + UUID.randomUUID()
        val context = object : ContextWrapper(app) {
            override fun getSharedPreferences(name: String, mode: Int) = super.getSharedPreferences(isolatedPrefs, mode)
        }
        val server = MockWebServer()
        fun donation(id: Int) = """{"id":$id,"username":"Дарья","amount":150,"currency":"RUB","message":"Спасибо!",
            "created_at":"2026-11-27 20:00:00"}"""
        server.enqueue(MockResponse().setBody("""{"data":[${donation(1)}]}"""))
        server.enqueue(MockResponse().setBody("""{"data":[${donation(2)},${donation(1)}]}"""))
        server.start()
        val scope = CoroutineScope(SupervisorJob()+Dispatchers.Main)
        val account = DonationAccount(context,scope,Uri.parse("tchat-reader://donations/return"),server.url("/api/v1/alerts/donations").toUrl())
        val opened = CompletableDeferred<Uri>()
        val http = OkHttpClient()
        try {
            account.authorize(BuildConfig.DONATION_CLIENT_ID) { opened.complete(it) }
            withTimeout(12_000) {
                val url = opened.await()
                assertEquals("www.donationalerts.com",url.host)
                assertEquals("oauth-donation-index",url.getQueryParameter("scope"))
                assertEquals("token",url.getQueryParameter("response_type"))
                val callback = url.getQueryParameter("redirect_uri")!!
                val state = url.getQueryParameter("state")!!
                val page = http.newCall(Request.Builder().url(callback).build()).execute().use { it.body!!.string() }
                assertTrue(page.contains("tchat-reader://donations/return"))
                fun deliver(s: String): Int {
                    val body = FormBody.Builder().add("access_token","fixture-read-only").add("state",s).build()
                    return http.newCall(Request.Builder().url(callback).post(body).build()).execute().use { it.code }
                }
                assertEquals(403,deliver("incorrect"))
                assertEquals(200,deliver(state))
                account.token.first { it.isNotBlank() }
                assertEquals("Bearer fixture-read-only",server.takeRequest().getHeader("Authorization"))
                assertEquals("150 ₽",account.chat.value.single().amountLabel)
                val arrived = CompletableDeferred<Donation>()
                val monitor = launch { account.monitor(account.token.value,onDonation={arrived.complete(it)}) }
                try { assertEquals(2L,arrived.await().id) } finally { monitor.cancelAndJoin() }
                assertEquals(listOf(2L,1L),account.chat.value.map { it.id })
                assertEquals("Спасибо!",account.chat.value.first().text)
                assertEquals("fixture-read-only",DonationAccount(context,scope).token.value)
                account.disconnect()
                assertTrue(DonationAccount(context,scope).token.value.isEmpty())
            }
        } finally { scope.cancel(); server.shutdown(); app.deleteSharedPreferences(isolatedPrefs) }
    }

    @Test fun readerOnlyAcceptsStableAndroidReleaseAssets() {
        fun entry(tag: String, version: String, pre: Boolean = false) = JSONObject().put("tag_name",tag).put("prerelease",pre)
            .put("assets",JSONArray().put(JSONObject().put("name","TChat-Reader-$version.apk").put("size",1234)
                .put("browser_download_url","https://github.com/Turrygpt/TChat/releases/download/$tag/TChat-Reader-$version.apk")
                .put("state","uploaded")))
        val page = JSONArray().put(entry("v10.0","10.0")).put(entry("reader-v1.10","1.10")).put(entry("reader-v1.9","1.9"))
            .put(entry("reader-v2.0","2.0",true)).put(entry("reader-v3.0","3.0").put("draft",true))
        assertEquals(listOf("1.9","1.10"),readerReleases(page).sortedBy { it.versionOrder }.map { it.version })
    }
}
