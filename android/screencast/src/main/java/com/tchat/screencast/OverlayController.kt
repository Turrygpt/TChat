package com.tchat.screencast

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

/**
 * Плавающая кнопка поверх всех окон (включая игру): таймер эфира + «Стоп».
 * Живёт в сервисе, а не в Activity — Activity к этому моменту обычно свёрнута.
 */
class OverlayController(private val context: Context, private val onStop: () -> Unit) {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var root: FrameLayout? = null
    private var statusText: TextView? = null
    private val handler = Handler(Looper.getMainLooper())
    private var startedAt = System.currentTimeMillis()

    private val tickRunnable = object : Runnable {
        override fun run() {
            updateStatusText()
            handler.postDelayed(this, 1000)
        }
    }

    fun show() {
        if (root != null) return
        val density = context.resources.displayMetrics.density

        val bubble = FrameLayout(context).apply {
            setBackgroundColor(Color.argb(220, 20, 22, 30))
            setPadding((10 * density).toInt(), (6 * density).toInt(), (10 * density).toInt(), (6 * density).toInt())
        }
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        val status = TextView(context).apply {
            text = "● REC"
            setTextColor(Color.WHITE)
            textSize = 13f
        }
        val stop = TextView(context).apply {
            text = "  СТОП"
            setTextColor(Color.parseColor("#FF5252"))
            textSize = 13f
            setPadding((12 * density).toInt(), 0, 0, 0)
            isClickable = true
            setOnClickListener { onStop() }
        }
        row.addView(status)
        row.addView(stop)
        bubble.addView(row)
        statusText = status
        root = bubble

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (16 * density).toInt()
            y = (80 * density).toInt()
        }

        // Перетаскивание пузыря: клик по «СТОП» не должен восприниматься как драг.
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        bubble.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    startX = params.x
                    startY = params.y
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downX).toInt()
                    val dy = (event.rawY - downY).toInt()
                    if (abs(dx) > 8 || abs(dy) > 8) {
                        params.x = startX + dx
                        params.y = startY + dy
                        runCatching { windowManager.updateViewLayout(bubble, params) }
                    }
                    false
                }
                else -> false
            }
        }

        runCatching { windowManager.addView(bubble, params) }
        startedAt = System.currentTimeMillis()
        handler.post(tickRunnable)
    }

    /** Сбрасывает таймер на момент, когда эфир реально подключился. */
    fun markLive() {
        startedAt = System.currentTimeMillis()
    }

    private fun updateStatusText() {
        val sec = ((System.currentTimeMillis() - startedAt) / 1000).coerceAtLeast(0)
        statusText?.text = "● %d:%02d:%02d".format(sec / 3600, sec / 60 % 60, sec % 60)
    }

    fun hide() {
        handler.removeCallbacks(tickRunnable)
        root?.let { runCatching { windowManager.removeView(it) } }
        root = null
    }
}
