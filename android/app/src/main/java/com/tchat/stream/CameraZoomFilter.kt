package com.tchat.stream

import android.opengl.Matrix
import com.pedro.encoder.input.gl.render.filters.NoFilterRender

internal data class CameraScale(val x: Float = 1f, val y: Float = 1f) {
    val needsCrop get() = x > 1f || y > 1f
}

/** Centers the cropped camera image before the inset camera and alert overlays are drawn. */
internal class CameraZoomFilter : NoFilterRender() {
    @Volatile var scale = CameraScale()

    override fun drawFilter() {
        val crop = scale
        Matrix.setIdentityM(MVPMatrix, 0)
        Matrix.scaleM(MVPMatrix, 0, crop.x, crop.y, 1f)
        super.drawFilter()
    }
}
