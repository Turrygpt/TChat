package com.tchat.live.ui.components

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/** Чат TChat для самого стримера — снизу поверх превью, в эфир не попадает. */
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ChatSheet(serverBaseUrl: String, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.7f),
            factory = { ctx ->
                WebView(ctx).apply {
                    setBackgroundColor(Color.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = WebViewClient()
                    loadUrl("$serverBaseUrl/widgets/chat.html")
                }
            },
        )
    }
}
