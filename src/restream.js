'use strict';

// Локальный рестрим-сервер TChat.
// OBS публикует один поток на локальный RTMP-сервер (127.0.0.1), а модуль
// ретранслирует его без перекодирования (-c copy) на все включённые площадки
// (YouTube, Twitch, VK, ...). Так убирается лишний крюк через VPS и лаг.
//
// Ингест: node-media-server (чистый JS). Ретрансляция: ffmpeg (ffmpeg-static).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let NodeMediaServer = null;
let ffmpegPath = '';
try {
  NodeMediaServer = require('node-media-server');
  ffmpegPath = require('ffmpeg-static');
} catch (error) {
  console.error('[restream] зависимости не загружены:', error && error.message);
}

const DEFAULT_INGEST_PORT = 1935;
const DEFAULT_STREAM_KEY = 'tchat';
const RELAY_RESTART_DELAY = 2500;
const RELAY_LIVE_AFTER = 4000;

let configFile = '';
let config = createDefaultConfig();
let nms = null;
let running = false; // ингест-сервер слушает порт
let live = false; // OBS сейчас публикует наш ключ
const relays = new Map(); // destId -> { proc, status, liveTimer }
let statusListener = () => {};

function createDefaultConfig() {
  return {
    enabled: false,
    ingestPort: DEFAULT_INGEST_PORT,
    streamKey: DEFAULT_STREAM_KEY,
    destinations: [],
  };
}

function normalizeDestinations(list) {
  return (Array.isArray(list) ? list : [])
    .map((d, i) => ({
      id: String(d.id || `dest-${Date.now()}-${i}`),
      name: String(d.name || '').trim() || `Площадка ${i + 1}`,
      url: String(d.url || '').trim(),
      key: String(d.key || '').trim(),
      enabled: d.enabled !== false,
    }))
    .filter((d) => d.url);
}

function load(storageDir) {
  configFile = path.join(storageDir, 'restream.json');
  if (!fs.existsSync(configFile)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config = {
      enabled: Boolean(raw.enabled),
      ingestPort: Number(raw.ingestPort) || DEFAULT_INGEST_PORT,
      streamKey: String(raw.streamKey || '').trim() || DEFAULT_STREAM_KEY,
      destinations: normalizeDestinations(raw.destinations),
    };
  } catch (error) {
    console.error(`[restream] не удалось прочитать конфиг: ${error.message}`);
    config = createDefaultConfig();
  }
}

function save() {
  if (!configFile) {
    return;
  }
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`[restream] не удалось сохранить конфиг: ${error.message}`);
  }
}

function ingestBase() {
  return `rtmp://127.0.0.1:${config.ingestPort}/live`;
}

function localSourceUrl() {
  return `${ingestBase()}/${config.streamKey}`;
}

function targetUrl(dest) {
  const base = dest.url.replace(/\/+$/, '');
  return dest.key ? `${base}/${dest.key}` : base;
}

function getState() {
  return {
    available: Boolean(NodeMediaServer && ffmpegPath),
    running,
    live,
    enabled: config.enabled,
    ingestPort: config.ingestPort,
    ingestUrl: ingestBase(),
    streamKey: config.streamKey,
    destinations: config.destinations.map((d) => ({
      id: d.id,
      name: d.name,
      url: d.url,
      key: d.key,
      enabled: d.enabled,
      status: relays.get(d.id)?.status || 'idle',
    })),
  };
}

function emitStatus() {
  try {
    statusListener(getState());
  } catch {
    /* слушатель не критичен */
  }
}

// --- ретрансляция одной площадки -------------------------------------------

function startRelay(dest) {
  if (!ffmpegPath || relays.has(dest.id)) {
    return;
  }

  const args = [
    '-loglevel', 'error',
    '-rw_timeout', '15000000',
    '-i', localSourceUrl(),
    '-c', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    targetUrl(dest),
  ];

  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  const entry = { proc, status: 'connecting', liveTimer: null };
  relays.set(dest.id, entry);

  entry.liveTimer = setTimeout(() => {
    if (relays.get(dest.id) === entry) {
      entry.status = 'live';
      emitStatus();
    }
  }, RELAY_LIVE_AFTER);

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  proc.on('exit', () => {
    clearTimeout(entry.liveTimer);
    relays.delete(dest.id);
    if (stderr.trim()) {
      console.error(`[restream] «${dest.name}» ffmpeg: ${stderr.trim().split('\n').pop()}`);
    }
    // Пока OBS вещает и площадка включена — переподключаемся.
    const stillWanted = live && config.destinations.some((d) => d.id === dest.id && d.enabled);
    if (stillWanted) {
      setTimeout(() => {
        if (live && config.destinations.some((d) => d.id === dest.id && d.enabled)) {
          startRelay(dest);
        }
      }, RELAY_RESTART_DELAY);
    }
    emitStatus();
  });

  emitStatus();
}

function stopRelay(id) {
  const entry = relays.get(id);
  if (!entry) {
    return;
  }
  clearTimeout(entry.liveTimer);
  relays.delete(id);
  try {
    entry.proc.kill('SIGKILL');
  } catch {
    /* уже мертв */
  }
}

function startRelays() {
  if (!config.enabled) {
    return;
  }
  for (const dest of config.destinations) {
    if (dest.enabled) {
      startRelay(dest);
    }
  }
}

function stopRelays() {
  for (const id of [...relays.keys()]) {
    stopRelay(id);
  }
}

// Перезапуск ретрансляции под текущий список площадок (после правок в UI).
function resyncRelays() {
  if (!live || !config.enabled) {
    stopRelays();
    emitStatus();
    return;
  }
  const wanted = new Set(config.destinations.filter((d) => d.enabled).map((d) => d.id));
  for (const id of [...relays.keys()]) {
    if (!wanted.has(id)) {
      stopRelay(id);
    }
  }
  for (const dest of config.destinations) {
    if (dest.enabled && !relays.has(dest.id)) {
      startRelay(dest);
    }
  }
  emitStatus();
}

// --- ингест-сервер ----------------------------------------------------------

function createServer() {
  nms = new NodeMediaServer({ bind: '127.0.0.1', rtmp: { port: config.ingestPort } });

  nms.on('postPublish', (session) => {
    if (session.streamName !== config.streamKey) {
      return;
    }
    live = true;
    startRelays();
    emitStatus();
  });

  nms.on('donePublish', (session) => {
    if (session.streamName !== config.streamKey) {
      return;
    }
    live = false;
    stopRelays();
    emitStatus();
  });

  nms.run();
}

function closeServer() {
  stopRelays();
  live = false;
  if (nms) {
    try {
      nms.rtmpServer?.tcpServer?.close();
    } catch {
      /* уже закрыт */
    }
    try {
      nms.httpServer?.httpServer?.close?.();
    } catch {
      /* http не запускался */
    }
    nms = null;
  }
  running = false;
}

// --- публичный API ----------------------------------------------------------

function init({ storageDir, onStatus } = {}) {
  if (typeof onStatus === 'function') {
    statusListener = onStatus;
  }
  if (storageDir) {
    load(storageDir);
  }
  if (config.enabled) {
    start();
  }
}

function start() {
  if (!NodeMediaServer || !ffmpegPath) {
    return { ok: false, error: 'модуль рестрима недоступен (нет ffmpeg/node-media-server)' };
  }
  config.enabled = true;
  if (!running) {
    try {
      createServer();
      running = true;
    } catch (error) {
      running = false;
      save();
      return { ok: false, error: error?.message || String(error) };
    }
  }
  save();
  emitStatus();
  return { ok: true, state: getState() };
}

function stop() {
  config.enabled = false;
  closeServer();
  save();
  emitStatus();
  return { ok: true, state: getState() };
}

function saveConfig(next = {}) {
  const wasRunning = running;
  if (next.streamKey !== undefined) {
    config.streamKey = String(next.streamKey || '').trim() || DEFAULT_STREAM_KEY;
  }
  if (next.ingestPort !== undefined) {
    config.ingestPort = Number(next.ingestPort) || DEFAULT_INGEST_PORT;
  }
  if (next.destinations !== undefined) {
    config.destinations = normalizeDestinations(next.destinations);
  }
  save();

  // Смена порта/ключа требует перезапуска ингеста; список площадок — только ресинк.
  const needsRestart =
    wasRunning && (next.ingestPort !== undefined || next.streamKey !== undefined);
  if (needsRestart) {
    closeServer();
    start();
  } else {
    resyncRelays();
  }
  return getState();
}

function shutdown() {
  closeServer();
}

module.exports = { init, start, stop, saveConfig, getState, shutdown };
