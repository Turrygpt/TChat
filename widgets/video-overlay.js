const params = new URLSearchParams(window.location.search);
const intervalMinutes = readNumber('interval', 5, 0.1, 1440);
const durationSeconds = readNumber('duration', 15, 1, 3600);
const startImmediately = params.get('start') === 'immediate';
const similarity = readNumber('similarity', 0.075, 0, 1);
const smoothness = readNumber('smoothness', 0.055, 0.001, 1);
const spill = readNumber('spill', 0.35, 0, 1);
const playlist = [
  './video/generated_video.mp4',
  './video/generated_video%20(1).mp4',
];

const canvas = document.querySelector('#videoOverlayCanvas');
const video = document.querySelector('#videoOverlaySource');
const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
let playbackTimer = null;
let stopTimer = null;
let animationFrame = null;
let renderer = null;
let nextVideoIndex = 0;

if (!gl) {
  console.error('Video overlay: WebGL is required for chroma key transparency.');
} else {
  renderer = createRenderer(gl);
  window.addEventListener('resize', resizeCanvas);
  video.addEventListener('loadedmetadata', resizeCanvas);
  video.addEventListener('ended', hideVideo);
  video.addEventListener('error', () => {
    console.error('Video overlay: failed to load the video file.');
    hideVideo();
  });
  resizeCanvas();
  schedulePlayback();
}

function readNumber(name, fallback, min, max) {
  if (!params.has(name)) return fallback;
  const value = Number(params.get(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function schedulePlayback() {
  const intervalMs = intervalMinutes * 60 * 1000;
  if (startImmediately) showVideo();
  playbackTimer = window.setInterval(showVideo, intervalMs);
}

async function showVideo() {
  window.clearTimeout(stopTimer);
  video.src = playlist[nextVideoIndex];
  nextVideoIndex = (nextVideoIndex + 1) % playlist.length;
  video.load();
  try {
    await video.play();
  } catch (error) {
    console.error('Video overlay: playback could not start.', error);
    return;
  }
  canvas.classList.add('is-visible');
  drawFrame();
  stopTimer = window.setTimeout(hideVideo, durationSeconds * 1000);
}

function hideVideo() {
  window.clearTimeout(stopTimer);
  stopTimer = null;
  video.pause();
  canvas.classList.remove('is-visible');
  if (animationFrame !== null) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function drawFrame() {
  if (video.paused || video.ended || !renderer) return;
  renderer.draw(video, canvas, similarity, smoothness, spill);
  animationFrame = window.requestAnimationFrame(drawFrame);
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(Math.round(window.innerWidth * ratio), 1);
  const height = Math.max(Math.round(window.innerHeight * ratio), 1);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function createRenderer(context) {
  const vertexShader = compileShader(context.VERTEX_SHADER, `
    attribute vec2 position;
    attribute vec2 texCoord;
    varying vec2 uv;
    void main() { gl_Position = vec4(position, 0.0, 1.0); uv = texCoord; }
  `);
  const fragmentShader = compileShader(context.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D frame;
    uniform float similarity;
    uniform float smoothness;
    uniform float spill;
    uniform float videoAspect;
    uniform float canvasAspect;
    varying vec2 uv;
    void main() {
      vec2 sampleUv = uv;
      if (canvasAspect > videoAspect) {
        float visibleWidth = videoAspect / canvasAspect;
        if (uv.x < (1.0 - visibleWidth) * 0.5 || uv.x > (1.0 + visibleWidth) * 0.5) discard;
        sampleUv.x = (uv.x - (1.0 - visibleWidth) * 0.5) / visibleWidth;
      } else {
        float visibleHeight = canvasAspect / videoAspect;
        if (uv.y < (1.0 - visibleHeight) * 0.5 || uv.y > (1.0 + visibleHeight) * 0.5) discard;
        sampleUv.y = (uv.y - (1.0 - visibleHeight) * 0.5) / visibleHeight;
      }
      vec4 color = texture2D(frame, sampleUv);
      float total = max(color.r + color.g + color.b, 0.001);
      vec2 chroma = vec2(color.r / total, color.b / total);
      vec2 greenScreenChroma = vec2(0.242, 0.273);
      float colorDistance = distance(chroma, greenScreenChroma);
      float alpha = smoothstep(similarity, similarity + smoothness, colorDistance);
      float despill = (1.0 - alpha) * spill;
      color.g = mix(color.g, max(color.r, color.b), despill);
      if (alpha <= 0.001) color.rgb = vec3(0.0);
      gl_FragColor = vec4(color.rgb, alpha);
    }
  `);
  const program = context.createProgram();
  context.attachShader(program, vertexShader);
  context.attachShader(program, fragmentShader);
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    throw new Error(`Video overlay shader link failed: ${context.getProgramInfoLog(program)}`);
  }
  context.useProgram(program);

  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0,
    -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
  ]), context.STATIC_DRAW);
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  const position = context.getAttribLocation(program, 'position');
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, stride, 0);
  const texCoord = context.getAttribLocation(program, 'texCoord');
  context.enableVertexAttribArray(texCoord);
  context.vertexAttribPointer(texCoord, 2, context.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.clearColor(0, 0, 0, 0);

  const similarityLocation = context.getUniformLocation(program, 'similarity');
  const smoothnessLocation = context.getUniformLocation(program, 'smoothness');
  const spillLocation = context.getUniformLocation(program, 'spill');
  const videoAspectLocation = context.getUniformLocation(program, 'videoAspect');
  const canvasAspectLocation = context.getUniformLocation(program, 'canvasAspect');
  return {
    draw(source, targetCanvas, similarityValue, smoothnessValue, spillValue) {
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source);
      context.uniform1f(similarityLocation, similarityValue);
      context.uniform1f(smoothnessLocation, smoothnessValue);
      context.uniform1f(spillLocation, spillValue);
      context.uniform1f(videoAspectLocation, source.videoWidth / Math.max(source.videoHeight, 1));
      context.uniform1f(canvasAspectLocation, targetCanvas.width / Math.max(targetCanvas.height, 1));
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawArrays(context.TRIANGLES, 0, 6);
    },
  };

  function compileShader(type, source) {
    const shader = context.createShader(type);
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      throw new Error(`Video overlay shader compile failed: ${context.getShaderInfoLog(shader)}`);
    }
    return shader;
  }
}

window.addEventListener('beforeunload', () => {
  window.clearInterval(playbackTimer);
  hideVideo();
});
