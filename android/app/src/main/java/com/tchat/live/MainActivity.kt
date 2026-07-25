package com.tchat.live

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.tchat.live.ui.screens.HomeScreen
import com.tchat.live.ui.screens.RemoteScreen
import com.tchat.live.ui.screens.SettingsScreen
import com.tchat.live.ui.screens.StreamScreen
import com.tchat.live.ui.theme.TChatLiveTheme

object Routes {
    const val HOME = "home"
    const val STREAM_CAMERA = "stream/camera"
    const val STREAM_SCREEN = "stream/screen"
    const val SETTINGS = "settings"
    const val REMOTE = "remote"
}

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            TChatLiveTheme {
                Surface(Modifier.fillMaxSize()) {
                    val nav = rememberNavController()
                    NavHost(navController = nav, startDestination = Routes.HOME) {
                        composable(Routes.HOME) { HomeScreen(nav) }
                        composable(Routes.STREAM_CAMERA) { StreamScreen(nav, screenMode = false) }
                        composable(Routes.STREAM_SCREEN) { StreamScreen(nav, screenMode = true) }
                        composable(Routes.SETTINGS) { SettingsScreen(nav) }
                        composable(Routes.REMOTE) { RemoteScreen(nav) }
                    }
                }
            }
        }
    }
}
