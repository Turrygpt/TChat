'use strict';

// Локальный рестрим-сервер TChat.
// OBS публикует один RTMP-поток на этот компьютер, ffmpeg принимает его
// (режим -listen) и раздаёт без перекодирования (-c copy) на все включённые
// площадки через муксер tee. Так убирается крюк через VPS и лаг.
//
// Раньше ингест держал node-media-server, но его RTMP-раздача в v4 «морит»
// ретранслятор (получалось ~40 кбит/с, 0 fps). ffmpeg -listen отдаёт весь поток.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static');
} catch (error) {
  console.error('[restream] ffmpeg не загружен:', error && error.message);
}

const DEFAULT_INGEST_PORT = 1935;
const DEFAULT_STREAM_KEY = 'tchat';
const RESPAWN_DELAY = 1200;

let configFile = '';
let config = createDefaultConfig();
let proc = null; // текущий ffmpeg-listen
let running = false; // слушатель активен
let live = false; // OBS подключён, кадры идут
let destStatus = new Map(); // id -> 'idle'|'live'|'error'
let respawnTimer = null;
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

function enabledDestinations() {
  return config.destinations.filter((d) => d.enabled && d.url);
}

function targetUrl(dest) {
  const base = dest.url.replace(/\/+$/, '');
  return dest.key ? `${base}/${dest.key}` : base;
}

function getState() {
  return {
    available: Boolean(ffmpegPath),
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
      status: !d.enabled ? 'idle' : live ? destStatus.get(d.id) || 'live' : 'idle',
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

// --- ingest + tee -----------------------------------------------------------

// Строит аргументы ffmpeg: слушаем OBS на локальном RTMP и копируем в tee.
function buildArgs() {
  const listenUrl = `rtmp://0.0.0.0:${config.ingestPort}/live/${config.streamKey}`;
  const args = [
    '-loglevel', 'level+warning',
    '-listen', '1',
    '-f', 'flv',
    '-i', listenUrl,
    '-c', 'copy',
    '-map', '0',
  ];

  const dests = enabledDestinations();
  if (dests.length === 0) {
    // Площадок нет — принимаем OBS и отбрасываем, чтобы можно было проверить связь.
    args.push('-f', 'null', '-');
    return { args, dests };
  }

  const slaves = dests
    .map((d) => `[f=flv:onfail=ignore]${targetUrl(d)}`)
    .join('|');
  args.push('-f', 'tee', slaves);
  return { args, dests };
}

function spawnListener() {
  if (!ffmpegPath || proc) {
    return;
  }

  const { args, dests } = buildArgs();
  const orderedIds = dests.map((d) => d.id);
  destStatus = new Map(orderedIds.map((id) => [id, 'live']));

  const child = spawn(ffmpegPath, args, { windowsHide: true });
  proc = child;

  let tail = '';
  const onLog = (chunk) => {
    tail = (tail + chunk.toString()).slice(-4000);
    // Пошли кадры — значит OBS подключился и поток идёт.
    if (/frame=\s*\d+/.test(tail) && !live) {
      live = true;
      emitStatus();
    }
    // Ошибка конкретного приёмника в tee: "Slave muxer #N failed".
    const failMatch = tail.match(/Slave muxer #(\d+)/i);
    if (failMatch) {
      const idx = Number(failMatch[1]);
      const id = orderedIds[idx];
      if (id && destStatus.get(id) !== 'error') {
        destStatus.set(id, 'error');
        emitStatus();
      }
    }
  };
  child.stderr.on('data', onLog);
  child.stdout.on('data', onLog);

  child.on('exit', () => {
    if (proc === child) {
      proc = null;
    }
    live = false;
    emitStatus();
    // OBS отключился (или сбой) — снова встаём на приём, пока рестрим включён.
    if (config.enabled) {
      clearTimeout(respawnTimer);
      respawnTimer = setTimeout(() => {
        if (config.enabled && !proc) {
          spawnListener();
        }
      }, RESPAWN_DELAY);
    }
  });

  child.on('error', (error) => {
    console.error('[restream] ffmpeg error:', error?.message || error);
  });

  emitStatus();
}

function killListener() {
  clearTimeout(respawnTimer);
  respawnTimer = null;
  live = false;
  if (proc) {
    const child = proc;
    proc = null;
    try {
      child.kill('SIGKILL');
    } catch {
      /* уже мёртв */
    }
  }
}

// Перезапуск слушателя, чтобы применить новый список площадок/ключ/порт.
// Не спавним новый процесс сразу (порт ещё занят) — убиваем текущий, а его
// exit-обработчик поднимет новый слушатель с новым конфигом. OBS переподключится.
function restartListener() {
  if (!running) {
    return;
  }
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* уже мёртв — exit-обработчик поднимет заново */
    }
  } else {
    clearTimeout(respawnTimer);
    spawnListener();
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
  if (config.enabled) {
    start();
  }
}

function start() {
  if (!ffmpegPath) {
    return { ok: false, error: 'ffmpeg недоступен в этой сборке' };
  }
  config.enabled = true;
  if (!running) {
    running = true;
    spawnListener();
  }
  save();
  emitStatus();
  return { ok: true, state: getState() };
}

function stop() {
  config.enabled = false;
  running = false;
  killListener();
  save();
  emitStatus();
  return { ok: true, state: getState() };
}

function saveConfig(next = {}) {
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
  restartListener();
  emitStatus();
  return getState();
}

function shutdown() {
  config.enabled = false;
  running = false;
  killListener();
}

module.exports = { init, start, stop, saveConfig, getState, shutdown };
