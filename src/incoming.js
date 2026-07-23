'use strict';

// Входящие потоки TChat: несколько камер, каждая — отдельный источник для OBS.
//
// Два типа источника:
//  * local (приём) — телефон/второй ПК в той же сети публикует RTMP прямо на
//    этот компьютер; TChat слушает порт (ffmpeg -listen) и даёт адрес для OBS;
//  * pull (забор) — камера вещает на ваш сервер, а TChat забирает поток оттуда
//    по указанному URL (ffmpeg -i rtmp(s)/rtsp…); пароль добавляется к URL.
//
// Любой источник приводится к 720p и раздаётся как MPEG-TS по HTTP. В OBS каждый
// поток добавляется отдельным браузер-источником:
//   http://localhost:3000/widgets/incoming.html?id=<id>
// который играет /streams/<id>/live.ts через mpegts.js (MSE, низкая задержка).
//
// Тот же приём (ffmpeg + раздача MPEG-TS), что и в restream.js/предыдущей камере.

const os = require('node:os');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static');
} catch (error) {
  console.error('[incoming] ffmpeg не загружен:', error && error.message);
}

const DEFAULT_INGEST_PORT = 1936; // 1935 занимает restream
const RESPAWN_DELAY = 2000;
const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;

let configFile = '';
let streams = []; // нормализованный список источников (конфиг)
let statusListener = () => {};

// id -> runner: живой процесс + его клиенты и статистика.
const runners = new Map();

function createDefaultConfig() {
  return { streams: [] };
}

function normalizeStream(raw = {}, index = 0) {
  const type = raw.type === 'pull' ? 'pull' : 'local';
  return {
    id: String(raw.id || `cam-${Date.now()}-${index}`),
    name: String(raw.name || '').trim() || `Камера ${index + 1}`,
    type,
    enabled: raw.enabled !== false,
    ingestPort: Number(raw.ingestPort) || 0,
    streamKey: String(raw.streamKey || '').trim() || 'stream',
    pullUrl: String(raw.pullUrl || '').trim(),
    pullPassword: String(raw.pullPassword || ''),
  };
}

function normalizeStreams(list) {
  return (Array.isArray(list) ? list : []).map(normalizeStream);
}

// Следующий свободный порт приёма для local-источника (1936, 1937, …).
function nextLocalPort() {
  const used = new Set(streams.filter((s) => s.type === 'local' && s.ingestPort).map((s) => s.ingestPort));
  let port = DEFAULT_INGEST_PORT;
  while (used.has(port)) {
    port += 1;
  }
  return port;
}

function load(storageDir) {
  configFile = path.join(storageDir, 'incoming.json');
  if (!fs.existsSync(configFile)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    streams = normalizeStreams(raw.streams);
  } catch (error) {
    console.error(`[incoming] не удалось прочитать конфиг: ${error.message}`);
    streams = [];
  }
}

function save() {
  if (!configFile) {
    return;
  }
  try {
    fs.writeFileSync(configFile, JSON.stringify({ streams }, null, 2));
  } catch (error) {
    console.error(`[incoming] не удалось сохранить конфиг: ${error.message}`);
  }
}

// Первый внешний IPv4 — его вставляют в приложение на телефоне как адрес приёма.
function localLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function ingestUrlFor(stream, host) {
  if (stream.type !== 'local') {
    return '';
  }
  const ip = host || localLanIp();
  return `rtmp://${ip}:${stream.ingestPort}/live/${stream.streamKey}`;
}

// URL забора с сервером: пароль (если задан) добавляем как query-параметр pass.
function pullTarget(stream) {
  let url = stream.pullUrl;
  if (stream.pullPassword) {
    const sep = url.includes('?') ? '&' : '?';
    url += `${sep}pass=${encodeURIComponent(stream.pullPassword)}`;
  }
  return url;
}

// --- статистика/состояние ---------------------------------------------------

function createRunnerState(stream) {
  return {
    stream,
    signature: signatureOf(stream),
    child: null,
    respawnTimer: null,
    clients: new Map(),
    clientSeq: 0,
    live: false,
    startedAt: 0,
    stats: { uptimeSec: 0, fps: 0, width: 0, height: 0, videoCodec: '', audioCodec: '', bitrateKbps: 0 },
    lastStatsEmit: 0,
    lastError: '',
  };
}

function signatureOf(stream) {
  return JSON.stringify([stream.type, stream.ingestPort, stream.streamKey, stream.pullUrl, stream.pullPassword]);
}

function publicStream(stream) {
  const runner = runners.get(stream.id);
  return {
    id: stream.id,
    name: stream.name,
    type: stream.type,
    enabled: stream.enabled,
    ingestPort: stream.ingestPort,
    streamKey: stream.streamKey,
    pullUrl: stream.pullUrl,
    hasPassword: Boolean(stream.pullPassword),
    running: Boolean(runner && runner.child),
    live: Boolean(runner && runner.live),
    lanIp: localLanIp(),
    ingestUrl: ingestUrlFor(stream),
    playPath: `/streams/${stream.id}/live.ts`,
    obsPath: `/widgets/incoming.html?id=${encodeURIComponent(stream.id)}`,
    viewers: runner ? runner.clients.size : 0,
    error: runner ? runner.lastError : '',
    stats: runner && runner.live ? runner.stats : { uptimeSec: 0, fps: 0, width: 0, height: 0, videoCodec: '', audioCodec: '', bitrateKbps: 0 },
  };
}

function getState() {
  return {
    available: Boolean(ffmpegPath),
    lanIp: localLanIp(),
    streams: streams.map(publicStream),
  };
}

function emitStatus() {
  try {
    statusListener(getState());
  } catch {
    /* слушатель не критичен */
  }
}

// --- раздача MPEG-TS по HTTP-клиентам ---------------------------------------

function attach(id, res) {
  const runner = runners.get(id);
  if (!runner) {
    res.status ? res.status(404).end() : res.end();
    return () => {};
  }
  const clientId = ++runner.clientSeq;
  const entry = { res, pending: 0 };
  runner.clients.set(clientId, entry);

  const detach = () => {
    runner.clients.delete(clientId);
    emitStatus();
  };
  res.on('close', detach);
  res.on('error', detach);
  emitStatus();
  return detach;
}

function fanOut(runner, chunk) {
  for (const [clientId, entry] of runner.clients) {
    if (entry.pending > CLIENT_BUFFER_LIMIT) {
      runner.clients.delete(clientId);
      try {
        entry.res.destroy();
      } catch {
        /* уже закрыт */
      }
      continue;
    }
    entry.pending += chunk.length;
    entry.res.write(chunk, () => {
      entry.pending = Math.max(entry.pending - chunk.length, 0);
    });
  }
}

// --- ffmpeg -----------------------------------------------------------------

// Приводим любой вход к 720p и упаковываем в MPEG-TS. Масштабирование требует
// перекодирования — берём быстрый x264 zerolatency, baseline (играется везде,
// включая браузер-источник OBS), звук в AAC.
function encodeTail() {
  return [
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-sc_threshold', '0',
    '-b:v', '3500k',
    '-maxrate', '4000k',
    '-bufsize', '4000k',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-flush_packets', '1',
    '-f', 'mpegts', 'pipe:1',
  ];
}

function buildArgs(stream) {
  const head = ['-loglevel', 'level+info', '-stats'];
  if (stream.type === 'pull') {
    return [
      ...head,
      // Плохую сеть переживаем переподключением: ffmpeg упадёт — мы поднимем.
      '-i', pullTarget(stream),
      ...encodeTail(),
    ];
  }
  return [
    ...head,
    '-fflags', 'nobuffer',
    '-listen', '1',
    '-f', 'flv',
    '-i', `rtmp://0.0.0.0:${stream.ingestPort}/live/${stream.streamKey}`,
    ...encodeTail(),
  ];
}

function spawnRunner(runner) {
  if (!ffmpegPath || runner.child) {
    return;
  }
  const stream = runner.stream;
  const child = spawn(ffmpegPath, buildArgs(stream), { windowsHide: true });
  runner.child = child;
  runner.live = false;
  resetStats(runner);

  child.stdout.on('data', (chunk) => fanOut(runner, chunk));
  child.stderr.on('data', (chunk) => onLog(runner, chunk));

  child.on('exit', () => {
    if (runner.child === child) {
      runner.child = null;
    }
    runner.live = false;
    resetStats(runner);
    emitStatus();
    // Пока источник включён и не удалён — снова встаём на приём/забор.
    const wanted = streams.find((s) => s.id === stream.id);
    if (wanted && wanted.enabled && runners.get(stream.id) === runner) {
      clearTimeout(runner.respawnTimer);
      runner.respawnTimer = setTimeout(() => {
        if (!runner.child && runners.get(stream.id) === runner) {
          spawnRunner(runner);
        }
      }, RESPAWN_DELAY);
    }
  });

  child.on('error', (error) => {
    runner.lastError = error?.message || String(error);
    console.error(`[incoming] ffmpeg (${stream.name}):`, runner.lastError);
  });

  emitStatus();
}

function killRunner(runner) {
  clearTimeout(runner.respawnTimer);
  runner.respawnTimer = null;
  runner.live = false;
  const child = runner.child;
  runner.child = null;
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* уже мёртв */
    }
  }
  for (const [, entry] of runner.clients) {
    try {
      entry.res.end();
    } catch {
      /* уже закрыт */
    }
  }
  runner.clients.clear();
}

function resetStats(runner) {
  runner.startedAt = 0;
  runner.stats = { uptimeSec: 0, fps: 0, width: 0, height: 0, videoCodec: '', audioCodec: '', bitrateKbps: 0 };
}

function onLog(runner, chunk) {
  const text = chunk.toString();
  const st = runner.stats;
  let changed = false;
  let important = false;

  const brMatch = text.match(/bitrate=\s*([\d.]+)\s*kbits\/s/i);
  if (brMatch) {
    st.bitrateKbps = Math.round(Number(brMatch[1]));
    changed = true;
  }
  const timeMatch = text.match(/time=\s*(\d+):(\d\d):(\d\d)/);
  if (timeMatch) {
    st.uptimeSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
    changed = true;
  }
  if (!st.fps || !st.width) {
    const videoLine = text.match(/Stream #\d+:\d+[^\n]*?Video:[^\n]*/i);
    if (videoLine) {
      const line = videoLine[0];
      const size = line.match(/\s(\d{2,5})x(\d{2,5})[\s,[]/);
      const rate = line.match(/([\d.]+)\s*fps/i);
      const codec = line.match(/Video:\s*([\w]+)/i);
      if (size) {
        st.width = Number(size[1]);
        st.height = Number(size[2]);
        changed = true;
      }
      if (rate) {
        st.fps = Math.round(Number(rate[1]));
        changed = true;
      }
      if (codec) {
        st.videoCodec = codec[1];
      }
    }
  }
  if (!st.audioCodec) {
    const audioLine = text.match(/Stream #\d+:\d+[^\n]*?Audio:[^\n]*/i);
    if (audioLine) {
      const codec = audioLine[0].match(/Audio:\s*([\w]+)/i);
      if (codec) {
        st.audioCodec = codec[1];
        changed = true;
      }
    }
  }
  // Ошибки забора/приёма — показываем в статусе источника.
  if (/error|failed|Connection refused|401|403|Unauthorized/i.test(text)) {
    const firstLine = text.split('\n').find((l) => /error|failed|refused|401|403|Unauthorized/i.test(l));
    if (firstLine) {
      runner.lastError = firstLine.trim().slice(0, 200);
    }
  }

  if (!runner.live && timeMatch) {
    runner.live = true;
    runner.startedAt = Date.now();
    runner.lastError = '';
    important = true;
  }

  const now = Date.now();
  if (important || (changed && now - runner.lastStatsEmit >= 1000)) {
    runner.lastStatsEmit = now;
    emitStatus();
  }
}

// Приводит набор процессов к списку включённых источников.
function sync() {
  // Убираем процессы удалённых/выключенных источников.
  for (const [id, runner] of runners) {
    const wanted = streams.find((s) => s.id === id && s.enabled);
    if (!wanted) {
      killRunner(runner);
      runners.delete(id);
    }
  }
  // Поднимаем/перезапускаем включённые.
  for (const stream of streams) {
    if (!stream.enabled) {
      continue;
    }
    const existing = runners.get(stream.id);
    if (!existing) {
      const runner = createRunnerState(stream);
      runners.set(stream.id, runner);
      spawnRunner(runner);
    } else if (existing.signature !== signatureOf(stream)) {
      // Настройки приёма изменились — перезапускаем этот источник.
      existing.stream = stream;
      existing.signature = signatureOf(stream);
      killRunner(existing);
      spawnRunner(existing);
    } else {
      existing.stream = stream;
    }
  }
}

// --- публичный API ----------------------------------------------------------

function init({ storageDir, onStatus } = {}) {
  if (typeof onStatus === 'function') {
    statusListener = onStatus;
  }
  if (storageDir) {
    load(storageDir);
  }
  sync();
  emitStatus();
}

function addStream(partial = {}) {
  const stream = normalizeStream(partial, streams.length);
  if (stream.type === 'local' && !stream.ingestPort) {
    stream.ingestPort = nextLocalPort();
  }
  streams.push(stream);
  save();
  sync();
  emitStatus();
  return getState();
}

function updateStream(id, patch = {}) {
  const idx = streams.findIndex((s) => s.id === id);
  if (idx === -1) {
    return getState();
  }
  const merged = normalizeStream({ ...streams[idx], ...patch, id }, idx);
  if (merged.type === 'local' && !merged.ingestPort) {
    merged.ingestPort = nextLocalPort();
  }
  streams[idx] = merged;
  save();
  sync();
  emitStatus();
  return getState();
}

function removeStream(id) {
  streams = streams.filter((s) => s.id !== id);
  save();
  sync();
  emitStatus();
  return getState();
}

function shutdown() {
  for (const [, runner] of runners) {
    killRunner(runner);
  }
  runners.clear();
}

module.exports = { init, getState, addStream, updateStream, removeStream, attach, shutdown };
