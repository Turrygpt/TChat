package com.tchat.stream

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject

internal data class Donation(
    val id: Long,
    val username: String,
    val amount: Double,
    val currency: String,
    val message: String,
    val createdAtMillis: Long,
)

private const val AUTHORIZE_URL = "https://www.donationalerts.com/oauth/authorize"
private const val DONATIONS_URL = "https://www.donationalerts.com/api/v1/alerts/donations"
private const val CALLBACK_PORT = 3000
private const val CALLBACK_PATH = "/oauth/donationalerts"
private const val CALLBACK_URL = "http://localhost:3000/oauth/donationalerts"
private const val MAX_BODY = 16_384
private const val FIRST_POLL_ALERT_AGE_MS = 120_000L
private const val STORED_DONATION_IDS = 200

internal class DonationAccount(context: Context, private val scope: CoroutineScope) {
    private val prefs = context.getSharedPreferences("tchat_donation_account", Context.MODE_PRIVATE)
    private val _token = MutableStateFlow(prefs.getString("accessToken", "").orEmpty())
    val token = _token.asStateFlow()
    private val _notice = MutableStateFlow(if (_token.value.isEmpty()) "Вход не выполнен" else "Подключено")
    val notice = _notice.asStateFlow()
    private val _authorizing = MutableStateFlow(false)
    val authorizing = _authorizing.asStateFlow()
    private val _latest = MutableStateFlow<Donation?>(null)
    val latest = _latest.asStateFlow()
    private val _chat = MutableStateFlow<List<ChatMessage>>(emptyList())
    val chat = _chat.asStateFlow()
    private var seenIds = prefs.getStringSet("seenDonations", null)?.mapNotNull(String::toLongOrNull)?.toSet()
    private var legacyCheckpoint = prefs.getLong("donationCheckpoint", -1L)
    private var login: Job? = null

    fun authorize(clientId: String, openBrowser: (Uri) -> Unit) {
        if (clientId.isEmpty() || login?.isActive == true) return
        login = scope.launch {
            _authorizing.value = true
            _notice.value = "Подтверди доступ в браузере"
            try {
                val grant = browserGrant(clientId, openBrowser)
                // Check read access before replacing any previously saved session.
                val history = withContext(Dispatchers.IO) { fetchDonations(grant) }
                clearDonations()
                publishDonations(history.distinctBy(Donation::id), emptyList(), System.currentTimeMillis())
                saveToken(grant)
                _notice.value = "Подключено"
            } catch (failure: LoginError) {
                _notice.value = failure.message.orEmpty()
            } catch (_: AccessDenied) {
                _notice.value = "DonationAlerts не предоставил доступ к донатам"
            } catch (_: IOException) {
                _notice.value = "Не удалось подключить DonationAlerts"
            } catch (_: JSONException) {
                _notice.value = "Не удалось проверить доступ к DonationAlerts"
            } finally {
                _authorizing.value = false
            }
        }
    }

    fun cancelAuthorization() {
        login?.cancel()
        _notice.value = if (_token.value.isEmpty()) "Вход не выполнен" else "Подключено"
    }

    fun disconnect() {
        login?.cancel()
        saveToken("")
        clearDonations()
        _notice.value = "Вход не выполнен"
    }

    suspend fun monitor(accessToken: String, onDonation: (Donation) -> Unit) {
        while (currentCoroutineContext().isActive) {
            val page = try {
                withContext(Dispatchers.IO) { fetchDonations(accessToken) }
            } catch (_: AccessDenied) {
                if (_token.value == accessToken) {
                    saveToken("")
                    clearDonations()
                    _notice.value = "Войди в DonationAlerts повторно"
                }
                return
            } catch (_: IOException) {
                null
            } catch (_: JSONException) {
                null
            }
            if (page == null) {
                _notice.value = "Ошибка связи. Повторяем подключение…"
            } else {
                val donations = page.distinctBy(Donation::id)
                val now = System.currentTimeMillis()
                val known = seenIds
                val arriving = donations.filter { donation ->
                    if (known != null) {
                        donation.id !in known
                    } else {
                        donation.createdAtMillis in (now - FIRST_POLL_ALERT_AGE_MS)..(now + 5000L) ||
                            (legacyCheckpoint >= 0 && donation.id > legacyCheckpoint)
                    }
                }.sortedBy(Donation::id)
                publishDonations(donations, arriving, now)
                rememberSeen(donations)
                arriving.forEach(onDonation)
                _notice.value = "Подключено"
            }
            delay(if (page == null) 10_000 else 5000)
        }
    }

    private fun publishDonations(page: List<Donation>, arriving: List<Donation>, now: Long) {
        val incomingIds = arriving.mapTo(HashSet(), Donation::id)
        val oldTimes = _chat.value.associate { it.id to it.timeMillis }
        _latest.value = arriving.lastOrNull()
            ?: page.firstOrNull { it.id == _latest.value?.id }
            ?: page.firstOrNull()
        _chat.value = page.map { donation ->
            donation.chatMessage(if (donation.id in incomingIds) now else oldTimes[donation.id] ?: donation.createdAtMillis)
        }
    }

    private fun rememberSeen(page: List<Donation>) {
        val ids = (page.map(Donation::id) + seenIds.orEmpty()).distinct().take(STORED_DONATION_IDS).toSet()
        if (ids == seenIds) return
        seenIds = ids
        legacyCheckpoint = -1L
        prefs.edit().remove("donationCheckpoint").putStringSet("seenDonations", ids.mapTo(HashSet(), Long::toString)).apply()
    }

    private fun clearDonations() {
        prefs.edit().remove("donationCheckpoint").remove("seenDonations").apply()
        seenIds = null
        legacyCheckpoint = -1L
        _latest.value = null
        _chat.value = emptyList()
    }

    private fun saveToken(token: String) {
        prefs.edit().putString("accessToken", token).apply()
        _token.value = token
    }
}

private class AccessDenied : IOException()
private class LoginError(message: String) : IOException(message)

private fun fetchDonations(token: String): List<Donation> {
    val connection = (URL(DONATIONS_URL).openConnection() as HttpURLConnection).apply {
        connectTimeout = 8000
        readTimeout = 8000
        instanceFollowRedirects = false
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Authorization", "Bearer $token")
    }
    try {
        when (connection.responseCode) {
            401, 403 -> throw AccessDenied()
            200 -> Unit
            else -> throw IOException("DonationAlerts request failed")
        }
        val payload = connection.inputStream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        val rows = payload.getJSONArray("data")
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val id = row.optLong("id", row.optLong("alert_id")).takeIf { it > 0L } ?: return@mapNotNull null
            val amount = row.optDouble("amount", row.optDouble("amount_in_user_currency", 0.0))
                .takeIf(Double::isFinite) ?: 0.0
            Donation(
                id,
                row.string("username"),
                amount,
                row.string("currency").ifEmpty { row.string("currency_code") }.ifEmpty { "RUB" }.uppercase(),
                row.string("message"),
                row.donationTimeMillis(),
            )
        }
    } finally {
        connection.disconnect()
    }
}

private fun JSONObject.string(key: String) = if (isNull(key)) "" else optString(key).trim()

private fun JSONObject.donationTimeMillis(): Long {
    val timestamp = unixTimeMillis(optLong("created_at_ts"))
    if (timestamp > 0L) return timestamp
    val text = string("created_at").replaceFirst(' ', 'T')
    if (text.isEmpty()) return 0L
    return runCatching { Instant.parse(text).toEpochMilli() }
        .recoverCatching { LocalDateTime.parse(text).toInstant(ZoneOffset.UTC).toEpochMilli() }
        .getOrDefault(0L)
}

private fun Donation.chatMessage(timeMillis: Long): ChatMessage {
    val number = NumberFormat.getNumberInstance(Locale.forLanguageTag("ru-RU")).apply { maximumFractionDigits = 2 }
    val symbol = if (currency == "RUB") "₽" else currency
    return ChatMessage(
        id, username, if (message.isEmpty()) emptyList() else listOf(ChatPart.Text(message)),
        ChatKind.DONATION, timeMillis, amountLabel = "${number.format(amount)} $symbol",
    )
}

/** The registered TChat callback runs on the phone only while the browser is authorizing. */
private suspend fun browserGrant(clientId: String, openBrowser: (Uri) -> Unit): String = withContext(Dispatchers.IO) {
    val state = UUID.randomUUID().toString()
    val url = Uri.parse(AUTHORIZE_URL).buildUpon()
        .appendQueryParameter("client_id", clientId)
        .appendQueryParameter("redirect_uri", CALLBACK_URL)
        .appendQueryParameter("response_type", "token")
        .appendQueryParameter("scope", "oauth-donation-index")
        .appendQueryParameter("state", state)
        .build()
    ServerSocket().use { listener ->
        listener.reuseAddress = true
        listener.bind(InetSocketAddress("127.0.0.1", CALLBACK_PORT))
        listener.soTimeout = 1000
        withContext(Dispatchers.Main) {
            try {
                openBrowser(url)
            } catch (_: android.content.ActivityNotFoundException) {
                throw LoginError("На телефоне нет браузера для входа")
            }
        }
        val deadline = SystemClock.elapsedRealtime() + 300_000
        while (SystemClock.elapsedRealtime() < deadline) {
            currentCoroutineContext().ensureActive()
            val callback = try {
                listener.accept().use { it.readGrant(state) }
            } catch (failure: LoginError) {
                throw failure
            } catch (_: IOException) {
                null
            }
            if (callback != null) return@withContext callback
        }
    }
    throw LoginError("Время входа истекло. Открой DonationAlerts ещё раз.")
}

private fun Socket.readGrant(state: String): String? {
    soTimeout = 2500
    val reader = getInputStream().bufferedReader(Charsets.UTF_8)
    val line = reader.readLine()?.split(' ', limit = 3) ?: return null
    if (line.size != 3) return null
    val method = line[0]
    val path = line[1].substringBefore('?')
    val length = reader.contentLength() ?: return null
    if (path != CALLBACK_PATH) {
        respond(404, "Not Found", "")
        return null
    }
    if (method == "GET") {
        respond(200, "OK", CALLBACK_PAGE, "text/html; charset=utf-8")
        return null
    }
    if (method != "POST" || length !in 1..MAX_BODY) {
        respond(400, "Bad Request", "")
        return null
    }
    val body = CharArray(length)
    var offset = 0
    while (offset < length) {
        val read = reader.read(body, offset, length - offset)
        if (read < 0) return null
        offset += read
    }
    val data = try {
        body.concatToString().split('&').associate {
            val field = it.substringBefore('=')
            field to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
        }
    } catch (_: IllegalArgumentException) {
        respond(400, "Bad Request", "")
        return null
    }
    if (data["state"] != state) {
        respond(403, "Forbidden", "Вход не подтверждён")
        return null
    }
    val token = data["access_token"]?.takeUnless { it.isBlank() || it.any(Char::isWhitespace) }
    if (token == null) {
        respond(400, "Bad Request", "Доступ не предоставлен")
        throw LoginError("Вход в DonationAlerts отменён")
    }
    respond(200, "OK", "Вернись в TChat Stream")
    return token
}

private fun BufferedReader.contentLength(): Int? {
    var length = 0
    repeat(40) {
        val header = readLine() ?: return null
        if (header.isEmpty()) return length
        if (header.startsWith("Content-Length:", ignoreCase = true)) {
            length = header.substringAfter(':').trim().toIntOrNull() ?: return null
        }
    }
    return null
}

private fun Socket.respond(code: Int, status: String, body: String, type: String = "text/plain; charset=utf-8") {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val headers = "HTTP/1.1 $code $status\r\nContent-Type: $type\r\nContent-Length: " + bytes.size +
        "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n"
    getOutputStream().apply {
        write(headers.toByteArray(Charsets.US_ASCII))
        write(bytes)
        flush()
    }
}

private const val CALLBACK_PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'">
<title>TChat Stream</title><h1>TChat Stream</h1><p id="result">Проверяем доступ к донатам…</p>
<script>
const result = document.getElementById('result');
const data = new URLSearchParams(location.hash.length > 1 ? location.hash.slice(1) : location.search.slice(1));
history.replaceState(null, '', location.pathname);
if (data.has('state')) {
  fetch(location.pathname, {method: 'POST', body: data})
    .then(response => response.text())
    .then(message => { result.textContent = message; })
    .catch(() => { result.textContent = 'Вернись в TChat Stream и повтори вход.'; });
} else {
  result.textContent = 'Вернись в TChat Stream и повтори вход.';
}
</script></html>"""
