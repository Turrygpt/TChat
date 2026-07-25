package com.tchat.live

import android.app.Application
import com.tchat.live.data.SettingsStore
import com.tchat.live.engine.DualCameraController
import com.tchat.live.engine.OverlayRenderer
import com.tchat.live.engine.StreamEngine
import com.tchat.live.net.TChatApi

class App : Application() {

    val settings by lazy { SettingsStore(this) }
    val api by lazy { TChatApi() }
    val engine by lazy { StreamEngine(this) }
    val overlay by lazy { OverlayRenderer(this, engine) }
    val pip by lazy { DualCameraController(this, engine) }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: App
            private set
    }
}
