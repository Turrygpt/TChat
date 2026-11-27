package com.tchat.stream

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaPlayer
import android.os.SystemClock
import com.pedro.encoder.input.audio.CustomAudioEffect
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal const val STREAM_SAMPLE_RATE = 44_100
private const val MAX_CLIP_SECONDS = 45
private const val MAX_DECODED_BYTES = 18 * 1024 * 1024

/** Mixes the selected alert sound into the same stereo PCM buffers that feed the RTMP encoder. */
internal class DonationAudio(private val context: Context) : CustomAudioEffect() {
    private class Clip(val samples: ShortArray, val volume: Float) {
        var position = 0
        val finished = CompletableDeferred<Unit>()
    }

    private val playing = AtomicReference<Clip?>()

    override fun process(pcmBuffer: ByteArray): ByteArray {
        val clip = playing.get() ?: return pcmBuffer
        var byteIndex = 0
        while (byteIndex + 1 < pcmBuffer.size && clip.position < clip.samples.size) {
            val mic = readSample(pcmBuffer, byteIndex).toInt()
            val alert = (clip.samples[clip.position++] * clip.volume).toInt()
            val sample = (mic + alert).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            pcmBuffer[byteIndex] = sample.toByte()
            pcmBuffer[byteIndex + 1] = (sample shr 8).toByte()
            byteIndex += 2
        }
        if (clip.position == clip.samples.size && playing.compareAndSet(clip, null)) clip.finished.complete(Unit)
        return pcmBuffer
    }

    suspend fun playSound(path: String, volume: Float, preview: Boolean) {
        if (path.isBlank() || volume <= 0f) return
        if (preview) {
            playLocally(volume) {
                context.assets.openFd("alerts/$path").use { fd ->
                    setDataSource(fd.fileDescriptor, fd.startOffset, fd.length)
                }
            }
            return
        }
        val samples = decode {
            context.assets.openFd("alerts/$path").use { fd ->
                setDataSource(fd.fileDescriptor, fd.startOffset, fd.length)
            }
        }
        if (samples != null) play(samples, volume)
    }

    fun stop() {
        playing.getAndSet(null)?.finished?.complete(Unit)
    }

    private suspend fun play(samples: ShortArray, volume: Float) {
        val clip = Clip(samples, volume)
        playing.getAndSet(clip)?.finished?.complete(Unit)
        try {
            val durationMillis = 1000L * samples.size / (2L * STREAM_SAMPLE_RATE)
            withTimeoutOrNull(durationMillis + 3000L) { clip.finished.await() }
        } finally {
            playing.compareAndSet(clip, null)
        }
    }
}

private suspend fun playLocally(volume: Float, open: MediaPlayer.() -> Unit) {
    val finished = CompletableDeferred<Unit>()
    val player = MediaPlayer()
    try {
        player.open()
        player.setOnErrorListener { _, _, _ -> finished.complete(Unit); true }
        player.setOnPreparedListener {
            it.setVolume(volume, volume)
            it.start()
        }
        player.setOnCompletionListener { finished.complete(Unit) }
        player.prepareAsync()
        withTimeoutOrNull(MAX_CLIP_SECONDS * 1000L + 3000L) { finished.await() }
    } catch (_: IOException) {
        // A missing sound leaves the visual alert active.
    } catch (_: IllegalArgumentException) {
        // MediaPlayer can reject an unsupported source on an older device.
    } finally {
        player.release()
    }
}

private fun readSample(bytes: ByteArray, offset: Int): Short =
    ((bytes[offset].toInt() and 255) or (bytes[offset + 1].toInt() shl 8)).toShort()

private suspend fun decode(open: MediaExtractor.() -> Unit): ShortArray? = withContext(Dispatchers.IO) {
    val extractor = MediaExtractor()
    try {
        extractor.open()
        val track = (0 until extractor.trackCount).firstOrNull {
            extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: return@withContext null
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: return@withContext null
        val pcm = if (mime == "audio/raw") readRawAudio(extractor, format) else decodeAudio(extractor, format, mime)
        pcm?.stereoSamples()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    } finally {
        extractor.release()
    }
}

private class Pcm(val bytes: ByteArray, private val format: MediaFormat) {
    fun stereoSamples(): ShortArray? {
        if (format.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
            format.getInteger(MediaFormat.KEY_PCM_ENCODING) != AudioFormat.ENCODING_PCM_16BIT
        ) {
            return null
        }
        val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        if (rate <= 0 || channels !in 1..2) return null
        val sourceFrames = bytes.size / (2 * channels)
        val frames = (sourceFrames * STREAM_SAMPLE_RATE.toLong() / rate)
            .coerceAtMost(STREAM_SAMPLE_RATE.toLong() * MAX_CLIP_SECONDS).toInt()
        if (frames == 0) return null
        return ShortArray(frames * 2).also { result ->
            for (frame in 0 until frames) {
                val source = (frame.toLong() * rate / STREAM_SAMPLE_RATE).toInt() * 2 * channels
                result[frame * 2] = readSample(bytes, source)
                result[frame * 2 + 1] = readSample(bytes, if (channels == 2) source + 2 else source)
            }
        }
    }
}

private suspend fun readRawAudio(extractor: MediaExtractor, format: MediaFormat): Pcm {
    val output = ByteArrayOutputStream()
    val sample = ByteBuffer.allocate(65_536)
    while (output.size() < MAX_DECODED_BYTES && extractor.sampleTime < MAX_CLIP_SECONDS * 1_000_000L) {
        currentCoroutineContext().ensureActive()
        sample.clear()
        val size = extractor.readSampleData(sample, 0)
        if (size <= 0 || size > sample.capacity()) break
        output.write(sample.array(), 0, size)
        extractor.advance()
    }
    return Pcm(output.toByteArray(), format)
}

private suspend fun decodeAudio(extractor: MediaExtractor, format: MediaFormat, mime: String): Pcm? {
    val codec = MediaCodec.createDecoderByType(mime)
    try {
        format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        codec.configure(format, null, null, 0)
        codec.start()
        val output = ByteArrayOutputStream()
        val packet = MediaCodec.BufferInfo()
        val deadline = SystemClock.elapsedRealtime() + 6000L
        var outputFormat: MediaFormat? = null
        var ended = false
        while (SystemClock.elapsedRealtime() < deadline && output.size() < MAX_DECODED_BYTES) {
            currentCoroutineContext().ensureActive()
            if (!ended) {
                val index = codec.dequeueInputBuffer(5_000)
                if (index >= 0) {
                    val buffer = requireNotNull(codec.getInputBuffer(index)).apply { clear() }
                    val time = extractor.sampleTime
                    val size = if (time >= MAX_CLIP_SECONDS * 1_000_000L) -1 else extractor.readSampleData(buffer, 0)
                    ended = size < 0
                    codec.queueInputBuffer(index, 0, maxOf(0, size), maxOf(0L, time), if (ended) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                    if (!ended) extractor.advance()
                }
            }
            when (val index = codec.dequeueOutputBuffer(packet, 5_000)) {
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = codec.outputFormat
                else -> if (index >= 0) {
                    if (packet.size > 0) {
                        val data = ByteArray(packet.size)
                        codec.getOutputBuffer(index)?.apply {
                            position(packet.offset)
                            get(data)
                        }
                        output.write(data)
                    }
                    codec.releaseOutputBuffer(index, false)
                    if ((packet.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
                }
            }
        }
        return outputFormat?.let { Pcm(output.toByteArray(), it) }
    } finally {
        codec.release()
    }
}
