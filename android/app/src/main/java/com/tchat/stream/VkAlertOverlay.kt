package com.tchat.stream

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.TextPaint
import android.text.TextUtils
import android.util.Size
import com.pedro.encoder.input.gl.render.filters.`object`.ImageObjectFilterRender
import com.pedro.library.view.GlStreamInterface

/** Keeps simultaneous VK alerts readable by showing one at a time. */
internal class VkAlertOverlay(private val gl: GlStreamInterface) {
    private val handler = Handler(Looper.getMainLooper())
    private val pending = ArrayDeque<VkAlert>()
    private var filter: ImageObjectFilterRender? = null

    fun enqueue(alert: VkAlert, size: Size) {
        if (pending.size == 10) pending.removeFirst()
        pending.addLast(alert)
        if (filter == null) showNext(size)
    }

    fun clear() {
        handler.removeCallbacksAndMessages(null)
        pending.clear()
        removeFilter()
    }

    private fun showNext(size: Size) {
        val alert = pending.removeFirstOrNull() ?: return
        val bitmap = drawAlert(alert)
        val width = if (size.height > size.width) 78f else 38f
        val height = width * size.width / size.height * bitmap.height / bitmap.width
        val layer = ImageObjectFilterRender().apply {
            setImage(bitmap)
            setScale(width, height)
            setPosition((100f - width) / 2f, 5f)
        }
        filter = layer
        gl.addFilter(layer)
        handler.postDelayed({
            removeFilter()
            showNext(size)
        }, 5000)
    }

    private fun removeFilter() {
        filter?.let { gl.removeFilter(it) }
        filter = null
    }

    private fun drawAlert(alert: VkAlert): Bitmap {
        val bitmap = Bitmap.createBitmap(520, 120, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
        val accent = when (alert.type) {
            VkAlertType.FOLLOW -> Color.rgb(102, 229, 241)
            VkAlertType.RAID -> Color.rgb(197, 176, 255)
        }
        paint.color = Color.argb(235, 16, 23, 36)
        canvas.drawRoundRect(2f, 2f, 518f, 118f, 22f, 22f, paint)
        paint.color = accent
        canvas.drawRoundRect(22f, 23f, 28f, 97f, 3f, 3f, paint)
        paint.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        paint.textSize = 26f
        val title = alert.type.title + (alert.viewers?.let { " · $it зр." } ?: "")
        canvas.drawText(title, 44f, 46f, paint)
        paint.color = Color.WHITE
        paint.typeface = Typeface.DEFAULT_BOLD
        paint.textSize = 39f
        val name = TextUtils.ellipsize(alert.name, paint, 450f, TextUtils.TruncateAt.END).toString()
        canvas.drawText(name, 44f, 94f, paint)
        return bitmap
    }
}
