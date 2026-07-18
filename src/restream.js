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
// Куда сбрасывать «счётный» выход: он нужен только ради статистики (см. buildArgs).
const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null';

let configFile = '';
let config = createDefaultConfig();
let proc = null; // текущий ffmpeg-listen
let running = false; // слушатель активен
let live = false; // OBS подключён, кадры идут
// id -> { status: 'idle'|'live'|'error', error, liveSince, failedAt, sentBytes }
let destStats = new Map();
let bitrateKbps = 0; // текущий сквозной битрейт (из stats ffmpeg)
let respawnTimer = null;
let statusListener = () => {};

// Статистика текущей сессии (пока OBS подключён) + счётчики за время работы сервера.
let sessionStartedAt = 0;
let uptimeSec = 0; // из time= — точнее часов, считает реально принятый поток
let fps = 0; // из баннера входа: при -c copy ffmpeg не печатает fps= в прогрессе
let videoWidth = 0;
let videoHeight = 0;
let videoCodec = '';
let audioCodec = '';
let audioKbps = 0;
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
  videoWidth = 0;
  videoHeight = 0;
  videoCodec = '';
  audioCodec = '';
  audioKbps = 0;
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
      width: live ? videoWidth : 0,
      height: live ? videoHeight : 0,
      videoCodec: live ? videoCodec : '',
      audioCodec: live ? audioCodec : '',
      audioKbps: live ? audioKbps : 0,
      speed: live ? speed : 0,
      sentBytes: live ? sentBytes : 0,
      bitrateKbps: live ? bitrateKbps : 0,
      peakBitrateKbps,
      avgBitrateKbps: bitrateSamples ? Math.round(bitrateSum / bitrateSamples) : 0,
      droppedFrames,
      disconnects,
      lastDisconnectAt,
      destErrors: [...destStats.values()].filter((s) => s.status === 'error').length,
    },
    destinations: config.destinations.map((d) => {
      const stat = destStats.get(d.id);
      const status = !d.enabled ? 'idle' : !live ? 'idle' : stat?.status || 'live';
      return {
        id: d.id,
        name: d.name,
        url: d.url,
        key: d.key,
        enabled: d.enabled,
        status,
        // Поток на площадки идёт один и тот же (-c copy), поэтому битрейт у всех
        // живых одинаковый; отличаются статус, ошибка и момент обрыва.
        bitrateKbps: status === 'live' ? bitrateKbps : 0,
        sentBytes: d.enabled && stat ? stat.sentBytes : 0,
        liveSince: status === 'live' ? stat?.liveSince || 0 : 0,
        failedAt: stat?.failedAt || 0,
        error: stat?.error || '',
      };
    }),
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
//
// Важно про статистику: муксер tee вообще не считает размер и битрейт — он
// печатает "size=N/A ... bitrate=N/A", и никакой -progress этого не меняет.
// А статистику ffmpeg отдаёт по выходу №0. Поэтому первым идёт «счётный» выход
// в null-устройство (тот же -c copy, тот же поток), и уже по нему мы получаем
// настоящие байты и битрейт; tee идёт вторым и раздаёт на площадки как раньше.
// Проверено на ffmpeg 6.1.1: с tee первым — N/A, со счётчиком первым — реальные
// 4384 kbits/s и 5242880 байт, при этом доставка в слейвы не меняется.
function buildArgs() {
  const listenUrl = `rtmp://0.0.0.0:${config.ingestPort}/live/${config.streamKey}`;
  const args = [
    // info нужен ради баннера входного потока: при -c copy ffmpeg не печатает
    // fps= в строке прогресса, и разрешение/fps берутся только оттуда.
    '-loglevel', 'level+info',
    '-stats', // принудительно печатать строку прогресса (size=/bitrate=) в stderr
    '-listen', '1',
    '-f', 'flv',
    '-i', listenUrl,
    // Выход №0 — только для счётчиков, никуда не пишет.
    '-c', 'copy',
    '-map', '0',
    '-f', 'flv', NULL_SINK,
  ];

  const dests = enabledDestinations();
  if (dests.length === 0) {
    // Площадок нет — счётного выхода достаточно, чтобы принять OBS и проверить связь.
    return { args, dests };
  }

  const slaves = dests
    .map((d) => `[f=flv:onfail=ignore]${targetUrl(d)}`)
    .join('|');
  args.push('-c', 'copy', '-map', '0', '-f', 'tee', slaves);
  return { args, dests };
}

function spawnListener() {
  if (!ffmpegPath || proc) {
    return;
  }

  const { args, dests } = buildArgs();
  const orderedIds = dests.map((d) => d.id);
  destStats = new Map(
    orderedIds.map((id) => [id, { status: 'live', error: '', liveSince: 0, failedAt: 0, sentBytes: 0 }]),
  );

  const child = spawn(ffmpegPath, args, { windowsHide: true });
  proc = child;

  const onLog = (chunk) => {
    const text = chunk.toString();
    let statsChanged = false; // мелочь из stats — отдаём не чаще раза в секунду
    let important = false; // смена состояния — отдаём сразу

    // Строка прогресса выхода-счётчика:
    // "size=    5120kB time=00:00:09.56 bitrate=4384.6kbits/s speed=1.17x".
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
    // ffmpeg 6 пишет kB, семёрка — KiB; в обоих случаях это кибибайты.
    const sizeMatch = text.match(/size=\s*(\d+)\s*(?:KiB|kB)/i);
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

    // Баннер входа — единственное место, где видно fps и разрешение при -c copy:
    // "Stream #0:0: Video: h264 (...), yuv420p, 1280x720 [SAR 1:1], 4000 kb/s, 30 fps, ...".
    if (!fps || !videoWidth) {
      const videoLine = text.match(/Stream #\d+:\d+[^\n]*?Video:[^\n]*/i);
      if (videoLine) {
        const line = videoLine[0];
        const size = line.match(/\s(\d{2,5})x(\d{2,5})[\s,[]/);
        const rate = line.match(/([\d.]+)\s*fps/i);
        const codec = line.match(/Video:\s*([\w]+)/i);
        if (size) {
          videoWidth = Number(size[1]);
          videoHeight = Number(size[2]);
          statsChanged = true;
        }
        if (rate) {
          fps = Math.round(Number(rate[1]));
          statsChanged = true;
        }
        if (codec) {
          videoCodec = codec[1];
        }
      }
    }
    if (!audioCodec) {
      const audioLine = text.match(/Stream #\d+:\d+[^\n]*?Audio:[^\n]*/i);
      if (audioLine) {
        const codec = audioLine[0].match(/Audio:\s*([\w]+)/i);
        const kbps = audioLine[0].match(/([\d.]+)\s*kb\/s/i);
        if (codec) {
          audioCodec = codec[1];
          statsChanged = true;
        }
        if (kbps) {
          audioKbps = Math.round(Number(kbps[1]));
        }
      }
    }

    // Появилась строка прогресса (time=) — значит OBS подключился и поток идёт.
    if (!live && timeMatch) {
      live = true;
      sessionStartedAt = Date.now();
      for (const stat of destStats.values()) {
        if (stat.status === 'live' && !stat.liveSince) {
          stat.liveSince = sessionStartedAt;
        }
      }
      important = true;
    }

    // Байты считаем по каждой живой площадке: пока слейв жив, tee отдаёт ему
    // ровно тот же поток, а у отвалившегося счётчик замирает на моменте обрыва.
    if (sizeMatch) {
      for (const stat of destStats.values()) {
        if (stat.status === 'live') {
          stat.sentBytes = sentBytes;
        }
      }
    }

    // Ошибка приёмника в tee:
    // "Slave muxer #1 failed: <причина>, continuing with 2/3 slaves."
    // Ищем все вхождения в новом куске: упасть может сразу несколько площадок.
    for (const match of text.matchAll(/Slave muxer #(\d+) failed:\s*([^,\n]*)/gi)) {
      const stat = destStats.get(orderedIds[Number(match[1])]);
      if (stat && stat.status !== 'error') {
        stat.status = 'error';
        stat.error = String(match[2] || '').trim() || 'ошибка передачи';
        stat.failedAt = Date.now();
        important = true;
      }
    }
    // Площадка, которую не удалось открыть вообще: тут видно URL и причину.
    for (const match of text.matchAll(/Slave '([^']*)':\s*error opening:\s*([^\n]*)/gi)) {
      const idx = orderedIds.findIndex((id) => {
        const dest = dests.find((d) => d.id === id);
        return dest && match[1].includes(targetUrl(dest));
      });
      const stat = idx >= 0 ? destStats.get(orderedIds[idx]) : null;
      if (stat && stat.status !== 'error') {
        stat.status = 'error';
        stat.error = String(match[2] || '').trim() || 'не удалось подключиться';
        stat.failedAt = Date.now();
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
