package com.tchat.stream

import android.content.Context
import android.graphics.SurfaceTexture
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.Looper
import com.pedro.encoder.input.gl.render.filters.`object`.BaseObjectFilterRender
import com.pedro.encoder.utils.gl.GlUtil

internal data class InsetPosition(val x: Float = 0.04f, val y: Float = 0.96f)

/** Uses the same camera buffer transform and rotation as the primary camera. */
internal class CameraInsetFilter(
    private val onSurfaceReady: (SurfaceTexture) -> Unit,
) : BaseObjectFilterRender() {
    data class Layout(val orientation: Int, val width: Float, val height: Float, val position: InsetPosition) {
        val left get() = (1f - width) * position.x
        val top get() = (1f - height) * position.y
    }

    @Volatile var layout: Layout? = null
    @Volatile var visible = false
    var surfaceTexture: SurfaceTexture? = null
        private set

    private var drawnLayout: Layout? = null
    private var transformUniform = -1
    private val textureMatrix = FloatArray(16)
    private val rotationMatrix = FloatArray(16)
    private val transform = FloatArray(16)

    override fun initGlFilter(context: Context) {
        fragment = R.raw.camera_inset
        super.initGlFilter(context)
        GlUtil.createExternalTextures(streamObjectTextureId.size, streamObjectTextureId, 0)
        val texture = SurfaceTexture(streamObjectTextureId[0]).also { surfaceTexture = it }
        Handler(Looper.getMainLooper()).post { onSurfaceReady(texture) }
    }

    override fun drawFilter() {
        val texture = checkNotNull(surfaceTexture)
        texture.updateTexImage()
        val current = layout
        if (current != null && drawnLayout != current) {
            if (drawnLayout?.width != current.width || drawnLayout?.height != current.height) {
                setScale(current.width * 100f, current.height * 100f)
            }
            setPosition(current.left * 100f, current.top * 100f)
            if (drawnLayout?.orientation != current.orientation) {
                Matrix.setIdentityM(rotationMatrix, 0)
                Matrix.translateM(rotationMatrix, 0, 0.5f, 0.5f, 0f)
                Matrix.rotateM(rotationMatrix, 0, current.orientation.toFloat(), 0f, 0f, 1f)
                Matrix.translateM(rotationMatrix, 0, -0.5f, -0.5f, 0f)
            }
            drawnLayout = current
        }
        texture.getTransformMatrix(textureMatrix)
        Matrix.multiplyMM(transform, 0, textureMatrix, 0, rotationMatrix, 0)
        super.drawFilter()
        if (transformUniform == -1) {
            val program = IntArray(1)
            GLES20.glGetIntegerv(GLES20.GL_CURRENT_PROGRAM, program, 0)
            transformUniform = GLES20.glGetUniformLocation(program[0], "uInsetTransform")
        }
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, streamObjectTextureId[0])
        GLES20.glUniformMatrix4fv(transformUniform, 1, false, transform, 0)
        GLES20.glUniform1f(uAlphaHandle, if (visible && current != null && texture.timestamp != 0L) 1f else 0f)
    }

    override fun release() {
        surfaceTexture?.release()
        surfaceTexture = null
        super.release()
    }
}
