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
let bitrateKbps = 0; // текущий сквозной битрейт (из stats ffmpeg)
let respawnTimer = null;
let statusListener = () => {};

// Статистика текущей сессии (пока OBS подключён) + счётчики за время работы сервера.
let sessionStartedAt = 0;
let uptimeSec = 0; // из time= — точнее часов, считает реально принятый поток
let fps = 0;
let sentBytes = 0;
let speed = 0; // 1.0x = поток уходит в реальном времени
let droppedFrames = 0;
let peakBitrateKbps = 0;
let bitrateSum = 0;
let bitrateSamples = 0;
let disconnects = 0; // сколько раз OBS отваливался с момента включения
let lastDisconnectAt = 0;
let lastStatsEmit = 0; // троттлинг: ffmpeg сыплет stats дважды в секунду

// Обнуляет показатели сессии. Счётчик обрывов живёт дольше — его сбрасывает start().
function resetSessionStats() {
  sessionStartedAt = 0;
  uptimeSec = 0;
  fps = 0;
  sentBytes = 0;
  speed = 0;
  droppedFrames = 0;
  peakBitrateKbps = 0;
  bitrateSum = 0;
  bitrateSamples = 0;
  bitrateKbps = 0;
}

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
    bitrateKbps: live ? bitrateKbps : 0,
    stats: {
      uptimeSec: live ? uptimeSec : 0,
      startedAt: live ? sessionStartedAt : 0,
      fps: live ? fps : 0,
      speed: live ? speed : 0,
      sentBytes: live ? sentBytes : 0,
      bitrateKbps: live ? bitrateKbps : 0,
      peakBitrateKbps,
      avgBitrateKbps: bitrateSamples ? Math.round(bitrateSum / bitrateSamples) : 0,
      droppedFrames,
      disconnects,
      lastDisconnectAt,
      destErrors: [...destStatus.values()].filter((s) => s === 'error').length,
    },
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
    '-stats', // принудительно печатать строку прогресса (frame=/bitrate=) в stderr
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
    const text = chunk.toString();
    tail = (tail + text).slice(-4000);
    let statsChanged = false; // мелочь из stats — отдаём не чаще раза в секунду
    let important = false; // смена состояния — отдаём сразу

    // Строка прогресса ffmpeg при -c copy:
    // "frame=N fps=X q=-1.0 size=NkB time=HH:MM:SS.ms bitrate=N kbits/s speed=Nx".
    // bitrate часто = N/A для copy, поэтому берём число только если оно есть.
    const brMatch = text.match(/bitrate=\s*([\d.]+)\s*kbits\/s/i);
    if (brMatch) {
      bitrateKbps = Math.round(Number(brMatch[1]));
      if (bitrateKbps > peakBitrateKbps) {
        peakBitrateKbps = bitrateKbps;
      }
      bitrateSum += bitrateKbps;
      bitrateSamples += 1;
      statsChanged = true;
    }
    const fpsMatch = text.match(/fps=\s*([\d.]+)/i);
    if (fpsMatch) {
      fps = Math.round(Number(fpsMatch[1]));
      statsChanged = true;
    }
    const sizeMatch = text.match(/size=\s*(\d+)\s*kB/i);
    if (sizeMatch) {
      sentBytes = Number(sizeMatch[1]) * 1024;
      statsChanged = true;
    }
    const speedMatch = text.match(/speed=\s*([\d.]+)x/i);
    if (speedMatch) {
      speed = Number(speedMatch[1]);
      statsChanged = true;
    }
    // drop= появляется только когда кадры реально теряются.
    const dropMatch = text.match(/drop=\s*(\d+)/i);
    if (dropMatch) {
      droppedFrames = Number(dropMatch[1]);
      statsChanged = true;
    }
    // time= — сколько потока принято; надёжнее стенных часов при паузах.
    const timeMatch = text.match(/time=\s*(\d+):(\d\d):(\d\d)/);
    if (timeMatch) {
      uptimeSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
      statsChanged = true;
    }
    // Появилась строка прогресса (time=) — значит OBS подключился и поток идёт.
    if (!live && timeMatch) {
      live = true;
      sessionStartedAt = Date.now();
      important = true;
    }
    // Ошибка конкретного приёмника в tee: "Slave muxer #N failed".
    const failMatch = tail.match(/Slave muxer #(\d+)/i);
    if (failMatch) {
      const idx = Number(failMatch[1]);
      const id = orderedIds[idx];
      if (id && destStatus.get(id) !== 'error') {
        destStatus.set(id, 'error');
        important = true;
      }
    }

    const now = Date.now();
    if (important || (statsChanged && now - lastStatsEmit >= 1000)) {
      lastStatsEmit = now;
      emitStatus();
    }
  };
  child.stderr.on('data', onLog);
  child.stdout.on('data', onLog);

  child.on('exit', () => {
    if (proc === child) {
      proc = null;
    }
    // Считаем обрывом только падение живого потока, а не перезапуск слушателя,
    // который OBS ещё ни разу не занял.
    if (live) {
      disconnects += 1;
      lastDisconnectAt = Date.now();
    }
    live = false;
    resetSessionStats();
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
    // Свой перезапуск обрывом не считаем — поток рвём мы, а не сеть.
    live = false;
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
    disconnects = 0;
    lastDisconnectAt = 0;
    resetSessionStats();
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
