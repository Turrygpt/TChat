package com.tchat.live.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** REST-клиент к серверу TChat на ПК (LAN, без авторизации — как и весь сервер). */
class TChatApi {

    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()

    /** Жив ли сервер TChat по этому адресу. */
    suspend fun health(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url("$baseUrl/health").build()).execute()
                .use { it.isSuccessful }
        }.getOrDefault(false)
    }

    /** Тестовый донат — прогоняет алерт через весь пайплайн TChat. */
    suspend fun sendTestDonation(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = "{}".toRequestBody(json)
            client.newCall(Request.Builder().url("$baseUrl/remote/demo/donation").post(body).build())
                .execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

}
