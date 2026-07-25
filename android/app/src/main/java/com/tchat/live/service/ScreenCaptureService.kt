package com.tchat.live.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.tchat.live.App
import com.tchat.live.R

/**
 * Держит MediaProjection для эфира экрана. По требованию Android 14+
 * getMediaProjection() вызывается только ПОСЛЕ startForeground с типом mediaProjection,
 * а сам старт сервиса — только после согласия пользователя (у нас уже есть resultData).
 */
class ScreenCaptureService : Service() {

    private var projection: MediaProjection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            release()
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        @Suppress("DEPRECATION")
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if (resultCode == Int.MIN_VALUE || resultData == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        createChannel()
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
        )

        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = manager.getMediaProjection(resultCode, resultData)
        if (proj == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        projection = proj
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // Пользователь оборвал захват из шторки — возвращаем камеру.
                App.instance.engine.switchToCamera()
                stopSelf()
            }
        }, null)

        val mixInternal = intent.getBooleanExtra(EXTRA_MIX_INTERNAL, false)
        App.instance.engine.switchToScreen(proj, mixInternal)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    private fun release() {
        runCatching { projection?.stop() }
        projection = null
    }

    private fun createChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Захват экрана", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun buildNotification(): android.app.Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stream)
            .setContentTitle("TChat Live")
            .setContentText("Идёт захват экрана")
            .setOngoing(true)
            .build()

    companion object {
        private const val CHANNEL_ID = "tchat_screen"
        private const val NOTIFICATION_ID = 2
        const val ACTION_STOP = "com.tchat.live.STOP_CAPTURE"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_MIX_INTERNAL = "mixInternal"

        fun start(context: Context, resultCode: Int, data: Intent, mixInternal: Boolean) {
            val intent = Intent(context, ScreenCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
                .putExtra(EXTRA_MIX_INTERNAL, mixInternal)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, ScreenCaptureService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
