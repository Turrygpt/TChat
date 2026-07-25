package com.tchat.live.ui.screens

import android.annotation.SuppressLint
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.navigation.NavController
import com.tchat.live.App
import com.tchat.live.R
import com.tchat.live.data.AppSettings

/** Мобильный пульт TChat — тот самый WebView, который раньше был всем приложением. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun RemoteScreen(nav: NavController) {
    val appSettings by App.instance.settings.settings.collectAsState(initial = AppSettings())
    val context = LocalContext.current
    val webView = remember { mutableStateOf<WebView?>(null) }

    BackHandler {
        val wv = webView.value
        if (wv?.canGoBack() == true) wv.goBack() else nav.popBackStack()
    }

    val url = if (appSettings.serverHost.isNotBlank()) {
        "${appSettings.serverBaseUrl}/widgets/remote.html"
    } else {
        context.getString(R.string.default_remote_url)
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                webViewClient = WebViewClient()
                webChromeClient = WebChromeClient()
                loadUrl(url)
                webView.value = this
            }
        },
        update = { wv -> if (wv.url == null) wv.loadUrl(url) },
    )
}
