package com.tchat.live.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.tchat.live.App
import com.tchat.live.MainActivity
import com.tchat.live.R
import com.tchat.live.engine.StreamState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground-сервис на время эфира: держит процесс живым (экран можно гасить)
 * и показывает уведомление со статистикой. Сам эфир ведёт StreamEngine.
 */
class StreamService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            App.instance.engine.stopStream()
            stopSelf()
            return START_NOT_STICKY
        }

        createChannel()
        val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification("Подключение…"), type)

        scope.launch {
            while (true) {
                val s = App.instance.engine.stats.value
                val text = when (s.state) {
                    StreamState.LIVE -> {
                        val sec = (System.currentTimeMillis() - s.startedAt) / 1000
                        "В эфире %d:%02d:%02d • %d кбит/с".format(sec / 3600, sec / 60 % 60, sec % 60, s.bitrateKbps)
                    }
                    StreamState.CONNECTING -> "Подключение…"
                    StreamState.RETRYING -> "Переподключение…"
                    StreamState.FAILED -> "Ошибка: ${s.error}"
                    StreamState.IDLE -> "Эфир остановлен"
                }
                notificationManager.notify(NOTIFICATION_ID, buildNotification(text))
                if (s.state == StreamState.IDLE || s.state == StreamState.FAILED) {
                    stopSelf()
                    break
                }
                delay(3000)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private val notificationManager: NotificationManager
        get() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "Эфир", NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Статус трансляции TChat Live" }
        notificationManager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): android.app.Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, StreamService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stream)
            .setContentTitle("TChat Live")
            .setContentText(text)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Стоп", stopIntent)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "tchat_stream"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.tchat.live.STOP_STREAM"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, StreamService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StreamService::class.java))
        }
    }
}
