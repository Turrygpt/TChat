package com.tchat.stream

import android.content.Context
import java.io.IOException
import org.json.JSONException
import org.json.JSONObject

internal data class DonationRule(
    val type: String = "",
    val nickname: String = "",
    val amount: Double = 0.0,
    val min: Double = 0.0,
    val max: Double = 0.0,
    val image: String = "",
    val video: String = "",
    val sound: String = "",
    val volume: Float = 1f,
)

internal class DonationProfile private constructor(
    val clientId: String,
    val layout: JSONObject,
    val displayMillis: Long,
    private val rules: List<DonationRule>,
) {
    fun select(donation: Donation): DonationRule =
        rules.firstOrNull { it.type == "amount" && it.amount == donation.amount }
            ?: rules.firstOrNull { it.type == "nickname" && it.nickname.isNotEmpty() && it.nickname.equals(donation.username, ignoreCase = true) }
            ?: rules.firstOrNull { it.type == "interval" && donation.amount in it.min..it.max }
            ?: DonationRule()

    companion object {
        fun load(context: Context): DonationProfile {
            val json = try {
                context.assets.open("alerts/profile.json").bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
            } catch (_: IOException) {
                JSONObject()
            } catch (_: JSONException) {
                JSONObject()
            }
            val items = json.optJSONArray("rules")
            val rules = (0 until (items?.length() ?: 0)).mapNotNull { i ->
                val rule = items?.optJSONObject(i) ?: return@mapNotNull null
                DonationRule(
                    type = rule.optString("type"),
                    nickname = rule.optString("nickname").trim(),
                    amount = rule.optDouble("amount", 0.0),
                    min = rule.optDouble("min", 0.0),
                    max = if (rule.opt("max") == "") Double.POSITIVE_INFINITY else rule.optDouble("max", 0.0),
                    image = rule.optString("image"),
                    video = rule.optString("video"),
                    sound = rule.optString("sound"),
                    volume = (rule.optDouble("volume", 100.0) / 100).toFloat().coerceIn(0f, 1f),
                )
            }
            return DonationProfile(
                json.optString("clientId").ifBlank { "19533" },
                json.optJSONObject("layout") ?: JSONObject(),
                maxOf(json.optLong("displaySeconds", 8L), 15L) * 1000L,
                rules,
            )
        }
    }
}
