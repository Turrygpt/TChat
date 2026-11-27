package com.tchat.reader

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model by viewModels<ReaderModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val bar = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = bar, navigationBarStyle = bar)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.statusBars())
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { model.watch() }
        }
        setContent {
            val settings by model.settings.collectAsState()
            val token by model.donationAlerts.token.collectAsState()
            val donationNotice by model.donationAlerts.notice.collectAsState()
            val authorizing by model.donationAlerts.authorizing.collectAsState()
            var editing by rememberSaveable { mutableStateOf(false) }
            val screenState = rememberSaveableStateHolder()
            BackHandler(editing) { editing = false }
            val statuses = buildMap {
                if (settings.useDesktop) {
                    putAll(model.notices)
                    if (model.notices.keys.none { it != Source.TCHAT }) put(Source.TCHAT, model.notices[Source.TCHAT])
                    else remove(Source.TCHAT)
                }
                else for (source in Source.entries) {
                    when (source) {
                        Source.DONATION_ALERTS -> if (token.isNotEmpty()) put(source, donationNotice)
                        Source.DONATE_PAY -> if (settings.donatePayKey.isNotEmpty()) put(source, model.notices[source])
                        else -> if (source.platform in settings.channels) put(source, model.notices[source])
                    }
                }
            }.mapValues { (_, value) -> value?.ifBlank { "Подключено" } ?: "Подключение…" }
            MaterialTheme(colorScheme = ReaderColors, typography = ReaderTypography, shapes = ReaderShapes) {
                Surface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding(), contentAlignment = Alignment.TopCenter) {
                        val screenWidth = if (editing) Modifier.widthIn(max = 680.dp) else Modifier
                        Box(screenWidth.fillMaxSize()) {
                            if (editing) {
                                SourceSettings(
                                    settings = settings,
                                    statuses = statuses,
                                    savedClientId = model.clientId,
                                    signedIn = token.isNotBlank(),
                                    donationNotice = donationNotice,
                                    authorizing = authorizing,
                                    twitchEventNotice = model.twitchEventNotice,
                                    onAuthorize = { id -> model.authorize(id) { startActivity(Intent(Intent.ACTION_VIEW, it)) } },
                                    onDisconnect = model.donationAlerts::disconnect,
                                    onCancelLogin = model.donationAlerts::cancelAuthorization,
                                    onSave = { model.save(it); editing = false },
                                    onBack = { editing = false },
                                )
                            } else {
                                screenState.SaveableStateProvider("feed") {
                                    FeedScreen(model.feed.items, statuses, model.viewers, model.filters, model::updateFilters,
                                        model.fontSize, model::saveFont,
                                        donationAction = if (settings.useDesktop) null else ({
                                            when {
                                                authorizing -> model.donationAlerts.cancelAuthorization()
                                                token.isNotBlank() -> model.donationAlerts.disconnect()
                                                model.clientId.isBlank() -> editing = true
                                                else -> model.authorize(model.clientId) { startActivity(Intent(Intent.ACTION_VIEW, it)) }
                                            }
                                        }),
                                        donationLabel = when {
                                            authorizing -> "Отменить вход в DonationAlerts"
                                            token.isNotBlank() -> "Отключить DonationAlerts"
                                            else -> "Подключить DonationAlerts"
                                        },
                                        donationState = donationNotice,
                                        updateControls = { UpdateSettings(model.updater) },
                                        onSources = { editing = true })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
