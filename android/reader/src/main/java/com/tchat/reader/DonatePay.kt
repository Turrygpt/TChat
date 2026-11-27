package com.tchat.reader

import com.tchat.stream.ChatMessage
import com.tchat.stream.Donation
import com.tchat.stream.FeedHttpError
import com.tchat.stream.chatHttp
import com.tchat.stream.chatMessage
import com.tchat.stream.donationTimeMillis
import com.tchat.stream.objects
import com.tchat.stream.requestText
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

private val donatePayClient = chatHttp.newBuilder().followRedirects(false).build()
private class RejectedKey : IOException()

internal suspend fun watchDonatePay(key: String, onPage: (List<ChatMessage>) -> Unit, notice: (String) -> Unit) {
    val url = "https://donatepay.ru/api/v1/transactions".toHttpUrl().newBuilder()
        .addQueryParameter("access_token", key)
        .addQueryParameter("type", "donation")
        .addQueryParameter("status", "success")
        .addQueryParameter("limit", "50")
        .build()
    val request = Request.Builder().url(url).header("Accept", "application/json").build()
    while (currentCoroutineContext().isActive) {
        var waitSeconds = 60L
        try {
            onPage(parseDonatePayPage(requestText(request, donatePayClient)))
            notice("")
        } catch (_: RejectedKey) {
            notice("DonatePay отклонил API-ключ")
            return
        } catch (error: FeedHttpError) {
            if (error.status == 401 || error.status == 403) {
                notice("DonatePay отклонил API-ключ")
                return
            }
            waitSeconds = (error.retryAfterSeconds ?: waitSeconds).coerceIn(60L, 86_400L)
            notice("DonatePay недоступен. Повторяем…")
        } catch (_: IOException) {
            notice("Ошибка связи с DonatePay. Повторяем…")
        } catch (_: JSONException) {
            notice("Не удалось прочитать ответ DonatePay. Повторяем…")
        }
        delay(waitSeconds * 1000)
    }
}

internal fun parseDonatePayPage(body: String): List<ChatMessage> {
    val response = JSONTokener(body).nextValue()
    val rows = when (response) {
        is JSONArray -> response
        is JSONObject -> {
            if (response.optString("status") == "error" || response.field("error") !in setOf("", "false", "0")) {
                val reason = response.optString("message") + " " + response.optString("error")
                if (reason.contains("token", true) || reason.contains("ключ", true)) throw RejectedKey()
                throw IOException("DonatePay API error")
            }
            response.getJSONArray("data")
        }
        else -> throw JSONException("Expected DonatePay transactions")
    }
    return rows.objects().mapNotNull { row ->
        if (row.field("type").ifBlank { "donation" } != "donation" ||
            row.field("status").ifBlank { "success" } != "success"
        ) return@mapNotNull null
        val id = row.optLong("id", row.optLong("transaction_id")).takeIf { it > 0 } ?: return@mapNotNull null
        val vars = when (val value = row.opt("vars")) {
            is JSONObject -> value
            is String -> try { JSONObject(value) } catch (_: JSONException) { null }
            else -> null
        }
        val amount = listOf(vars.field("sum"), vars.field("amount"), row.field("sum"), row.field("amount"))
            .firstNotNullOfOrNull(String::toDoubleOrNull) ?: return@mapNotNull null
        if (!amount.isFinite() || amount <= 0) return@mapNotNull null
        val donation = Donation(
            id = id,
            username = vars.field("name").ifBlank { row.field("name") }.ifBlank { row.field("what") },
            amount = amount,
            currency = row.field("currency").ifBlank { vars.field("currency") }.ifBlank { "RUB" }.uppercase(),
            message = vars.field("comment").ifBlank { row.field("comment") }.ifBlank { vars.field("message") },
            createdAtMillis = row.donationTimeMillis(),
        )
        donation.chatMessage(platformKey = "donatepay:$id")
    }
}

private fun JSONObject?.field(name: String): String =
    if (this == null || isNull(name)) "" else optString(name).trim()
