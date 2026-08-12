'use strict';

// Локальный рестрим-сервер TChat.
// OBS публикует один RTMP-поток на этот компьютер, ffmpeg принимает его
// (режим -listen) и раздаёт на все включённые площадки. По умолчанию видео
// уходит как есть, без перекодирования (-c copy) — так убирается крюк через
// VPS и лаг. У каждой площадки можно вместо этого задать своё разрешение
// и/или битрейт видео (см. buildTranscodeVideoArgs) — тогда именно эта
// площадка получает отдельно перекодированную копию, остальные не трогает.
// Звук пережимается всегда, в тот же битрейт, ради совместимости площадок
// (см. buildDestinationArgs).
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

// Разрешение и битрейт видео по площадкам. По умолчанию площадка не задаёт ни
// то, ни другое — тогда видео уходит как в OBS, 1:1, без перекодирования
// (-c copy), как и раньше: без нагрузки на CPU и без потери качества. Как
// только у площадки задано разрешение или битрейт, для НЕЁ ОДНОЙ включается
// перекодирование libx264 — соседей и сам приём это не касается.
//
// Если задано только разрешение, битрейт берётся из этой лесенки — ориентир,
// а не жёсткая норма (примерно как рекомендации YouTube/Twitch для 16:9).
const BITRATE_LADDER = [
  { height: 1080, kbps: 6000 },
  { height: 720, kbps: 4000 },
  { height: 480, kbps: 2000 },
  { height: 360, kbps: 1200 },
  { height: 240, kbps: 800 },
];

function bitrateForHeight(height) {
  const h = Number(height) || 0;
  const found = BITRATE_LADDER.find((row) => h >= row.height);
  return (found || BITRATE_LADDER[BITRATE_LADDER.length - 1]).kbps;
}

// "1920x1080" -> { width, height }; всё остальное (пусто, мусор) — null, что
// в normalizeDestinations() и buildDestinationArgs() значит «как в OBS».
function parseResolution(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width && height ? { width, height } : null;
}

// Площадке нужно собственное кодирование, если задано хотя бы одно из полей —
// иначе она идёт по общему пути -c copy вместе со всеми остальными.
function destinationNeedsTranscode(dest) {
  return Boolean(parseResolution(dest.resolution)) || Number(dest.videoBitrateKbps) > 0;
}

// Отпечаток настроек видео площадки — по нему syncDestinations() решает,
// нужно ли перезапустить именно её процесс (адрес не менялся, но поменяли
// разрешение/битрейт).
function videoSignature(dest) {
  return `${dest.resolution || ''}|${dest.videoBitrateKbps || 0}`;
}

// Ретрансляция через свой сервер. Площадка с флагом viaRelay получает поток не
// напрямую, а через VPS: мы публикуем на MediaMTX, а он уже отдаёт площадке.
// Нужно, когда канал до площадки не тянет 1080p — до своего сервера поток идёт
// по толстому каналу, а дальше площадку кормит сервер.
//
// Ключ площадки в этом режиме живёт на сервере (в его настройке пересылки),
// поэтому из приложения он не уходит: сюда отправляется только путь.
//
// Адреса по умолчанию нет: у каждого свой сервер, поэтому поле пустое, пока
// стример не впишет его в бэкофисе. Пока адрес пуст, ретрансляция не работает
// и площадка отдаётся напрямую — эфир из-за ненастроенного сервера не рвём.
const DEFAULT_RELAY_URL = '';

let configFile = '';
let config = createDefaultConfig();
let proc = null; // текущий ffmpeg-listen
let running = false; // слушатель активен
let live = false; // OBS подключён, кадры идут
// id -> { status: 'idle'|'live'|'error', error, liveSince, failedAt, sentBytes, bitrateKbps }
let destStats = new Map();
let bitrateKbps = 0; // текущий сквозной битрейт (из stats ffmpeg)
let respawnTimer = null;
let statusListener = () => {};
let logFile = '';

const LOG_MAX_BYTES = 5 * 1024 * 1024;

function safeNetworkAddress(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'invalid-address';
  }
}

function redactLogText(value) {
  return String(value || '')
    .replace(/rtmps?:\/\/[^\s"'<>]+/gi, (match) => safeNetworkAddress(match))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function initLogging(storageDir) {
  try {
    const baseDir = path.basename(storageDir).toLowerCase() === 'settings'
      ? path.dirname(storageDir)
      : storageDir;
    const logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'restream.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size >= LOG_MAX_BYTES) {
      const previous = `${logFile}.1`;
      if (fs.existsSync(previous)) {
        fs.unlinkSync(previous);
      }
      fs.renameSync(logFile, previous);
    }
  } catch (error) {
    logFile = '';
    console.error('[restream] cannot initialize log:', error?.message || error);
  }
}

function logEvent(event, details = {}) {
  if (!logFile) {
    return;
  }
  const record = { time: new Date().toISOString(), event, ...details };
  fs.appendFile(logFile, `${JSON.stringify(record)}\n`, (error) => {
    if (error) {
      console.error('[restream] cannot write log:', error.message);
    }
  });
}

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
    relay: createDefaultRelay(),
  };
}

function createDefaultRelay() {
  return { url: DEFAULT_RELAY_URL, user: '', password: '' };
}

function normalizeRelay(raw = {}) {
  return {
    // Пустой адрес — валидное состояние: сервер просто ещё не задан.
    url: String(raw.url || DEFAULT_RELAY_URL).trim(),
    user: String(raw.user || '').trim(),
    password: String(raw.password || ''),
  };
}

// Ретрансляция возможна, только если стример указал адрес своего сервера.
function relayConfigured() {
  return Boolean((config.relay || createDefaultRelay()).url);
}

// Путь на своём сервере: латиница из названия площадки. Для Twitch получается
// `twitch` — именно этот путь и настраивается на сервере на пересылку.
function relayPathFor(dest) {
  const explicit = String(dest.relayPath || '').trim().replace(/^\/+|\/+$/g, '');
  if (explicit) {
    return explicit;
  }
  if (/twitch\.tv/i.test(dest.url || '')) {
    return 'twitch';
  }
  const slug = String(dest.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || String(dest.id || 'dest');
}

function normalizeDestinations(list) {
  return (Array.isArray(list) ? list : [])
    .map((d, i) => ({
      id: String(d.id || `dest-${Date.now()}-${i}`),
      name: String(d.name || '').trim() || `Площадка ${i + 1}`,
      url: String(d.url || '').trim(),
      key: String(d.key || '').trim(),
      enabled: d.enabled !== false,
      // Отдавать эту площадку через свой сервер, а не напрямую.
      viaRelay: Boolean(d.viaRelay),
      relayPath: String(d.relayPath || '').trim(),
      // Пусто — «как в OBS» (без перекодирования). См. buildDestinationArgs().
      resolution: parseResolution(d.resolution) ? String(d.resolution).trim() : '',
      videoBitrateKbps: Math.max(0, Math.min(50000, Math.round(Number(d.videoBitrateKbps) || 0))),
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
      relay: normalizeRelay(raw.relay),
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

// Куда реально уходит поток этой площадки: напрямую на её RTMP или, если включена
// ретрансляция, на свой сервер — логин и пароль публикации подставляем в адрес.
function targetUrl(dest) {
  if (dest.viaRelay && relayConfigured()) {
    const relay = config.relay || createDefaultRelay();
    const base = String(relay.url).replace(/\/+$/, '');
    const withAuth = relay.user
      ? base.replace(
          /^(rtmps?:\/\/)/i,
          `$1${encodeURIComponent(relay.user)}:${encodeURIComponent(relay.password || '')}@`,
        )
      : base;
    return `${withAuth}/${relayPathFor(dest)}`;
  }
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
    // Пароль наружу не отдаём — интерфейсу хватает признака, что он задан.
    relay: {
      url: (config.relay || createDefaultRelay()).url,
      user: (config.relay || createDefaultRelay()).user,
      hasPassword: Boolean((config.relay || createDefaultRelay()).password),
      configured: relayConfigured(),
    },
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
      // Статус ведёт процесс площадки: он живёт отдельно от эфира и отдельно
      // от соседей, поэтому «упала одна» больше не значит «упали все».
      const status = !d.enabled ? 'idle' : stat?.status === 'error' ? 'error' : !live ? 'idle' : stat?.status || 'idle';
      return {
        id: d.id,
        name: d.name,
        url: d.url,
        key: d.key,
        enabled: d.enabled,
        viaRelay: d.viaRelay,
        relayPath: relayPathFor(d),
        status,
        // Пусто — площадка идёт как в OBS (без перекодирования). Заданное
        // значение — своё разрешение/битрейт именно для этой площадки.
        resolution: d.resolution,
        videoBitrateKbps: d.videoBitrateKbps,
        transcoded: destinationNeedsTranscode(d),
        // Битрейт своего процесса площадки (из его stats), а не общий входящий:
        // у площадки со своим перекодированием он отличается от остальных.
        // Пока свежих stats ещё нет (первая секунда), подстраховываемся общим
        // битрейтом эфира — для площадок без перекодирования это и есть их битрейт.
        bitrateKbps: status === 'live' ? (stat?.bitrateKbps || bitrateKbps) : 0,
        // Теперь это честный счётчик своей площадки: считаем то, что реально
        // ушло в её процесс, а не общий размер потока, как было при tee.
        sentBytes: stat ? stat.sentBytes : 0,
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

// Строит аргументы слушателя: принимаем OBS по локальному RTMP и отдаём поток
// в stdout одним куском mpegts. Раздачу по площадкам делает уже не ffmpeg, а мы.
//
// Раньше здесь был муксер tee со списком площадок прямо в аргументах. Из-за
// этого любое изменение списка означало перезапуск ffmpeg: включаешь одну
// площадку — рвётся эфир на всех, OBS переподключается. Теперь слушатель живёт
// сам по себе, а на каждую площадку поднимается отдельный ffmpeg, которому мы
// подкладываем тот же поток в stdin. Включение и выключение площадки трогает
// только её процесс.
//
// mpegts, а не flv: поток идёт по трубе непрерывно, и площадка, подключённая на
// середине, находит в нём точку входа сама (PAT/PMT повторяются). Перекодирования
// по-прежнему нет, везде -c copy.
function buildListenerArgs() {
  const listenUrl = `rtmp://0.0.0.0:${config.ingestPort}/live/${config.streamKey}`;
  return [
    // info нужен ради баннера входного потока: при -c copy ffmpeg не печатает
    // fps= в строке прогресса, и разрешение/fps берутся только оттуда.
    '-loglevel', 'level+info',
    '-stats', // принудительно печатать строку прогресса (size=/bitrate=) в stderr
    '-listen', '1',
    '-f', 'flv',
    '-i', listenUrl,
    '-c', 'copy',
    '-map', '0',
    // A destination can reconnect in the middle of a broadcast. Repeat H.264
    // SPS/PPS and MPEG-TS tables at keyframes so a fresh FFmpeg process can
    // discover the frame dimensions without waiting for OBS to reconnect.
    '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe',
    '-mpegts_flags', '+resend_headers',
    '-f', 'mpegts', 'pipe:1',
  ];
}

// Аргументы кодирования видео для площадки с собственными настройками.
// size — { width, height } из parseResolution() или null (оставить размер
// источника и перекодировать только ради ограничения битрейта).
function buildTranscodeVideoArgs(dest, size) {
  const targetKbps = dest.videoBitrateKbps || bitrateForHeight(size ? size.height : videoHeight || 720);
  // Интервал ключевого кадра ~2с — как и советуем выставлять в OBS (см. подсказку
  // в бэкофисе). fps источника на старте площадки может быть ещё не определён
  // (баннер входа приходит по факту эфира) — берём 30 как безопасный запас.
  const keyframeInterval = Math.max(1, Math.round((fps || 30) * 2));
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    // scale+pad, а не голый scale: у площадки может быть свой фиксированный
    // формат (например, 1920x1080 под вертикальный или обрезанный источник) —
    // так кадр всегда получается точно нужного размера, без искажения пропорций.
    ...(size
      ? ['-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2`]
      : []),
    '-b:v', `${targetKbps}k`,
    '-maxrate', `${targetKbps}k`,
    '-bufsize', `${targetKbps * 2}k`,
    '-g', String(keyframeInterval),
    '-keyint_min', String(keyframeInterval),
    '-pix_fmt', 'yuv420p',
  ];
}

function buildDestinationArgs(dest) {
  const target = targetUrl(dest);
  const networkOutputArgs = /^rtmps?:\/\//i.test(target)
    ? ['-rw_timeout', '15000000']
    : [];
  const size = parseResolution(dest.resolution);
  const videoArgs = destinationNeedsTranscode(dest)
    ? buildTranscodeVideoArgs(dest, size)
    : ['-c:v', 'copy'];
  return [
    '-loglevel', 'level+error',
    '-stats', // прогресс раз в ~0.5с в stderr — оттуда берём фактический битрейт площадки
    // Площадка может подняться в середине эфира (переподключение). Тогда ffmpeg
    // входит в mpegts не с начала и должен успеть выцепить extradata H.264
    // (SPS/PPS), прежде чем писать flv-заголовок — иначе flv-муксер отвечает
    // «Error opening output files: Invalid argument». Даём анализу запас: это
    // верхняя граница, ffmpeg останавливается раньше, как только нашёл параметры,
    // так что на нормальном входе задержки нет.
    '-analyzeduration', '10000000',
    '-probesize', '10000000',
    '-f', 'mpegts',
    '-i', 'pipe:0',
    // Берём ровно одну видео- и одну аудиодорожку, а не `-map 0`. При `-map 0`
    // в выход попадали все потоки TS, включая случайные data/служебные; если
    // хоть один из них не получал пакетов (а площадка вроде YouTube подключается
    // в середине эфира, между ключевыми кадрами), ffmpeg рушил ВЕСЬ выход с
    // «Nothing was written into output file, because at least one of its streams
    // received no packets» и не отдавал площадке ни байта. Явный маппинг убирает
    // лишние дорожки; `?` у аудио — на случай потока без звука, чтобы не падать.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    // По умолчанию видео уходит как есть — ни перекодирования, ни потери
    // качества (videoArgs = ['-c:v', 'copy']). Если у площадки задано своё
    // разрешение или битрейт, videoArgs вместо этого запускает libx264 —
    // см. buildTranscodeVideoArgs(); остальных площадок это не касается.
    ...videoArgs,
    // А вот звук приходится пережимать, и вот почему. В mpegts кадры AAC лежат
    // в ADTS, без отдельного описания потока. Когда ffmpeg с `-c copy` открывает
    // flv-выход, описания звука он ещё не знает и пишет ПУСТОЙ AAC sequence
    // header, а правильный (частота, каналы) — только следующим тегом.
    // Площадка, которая берёт первый заголовок, остаётся без частоты дискретизации
    // и откатывается на 44.1 кГц из заголовка flv-тега. Звук при этом реально
    // 48 кГц: он играет на 8.8% медленнее — голос ниже — и постепенно уезжает от
    // видео, из-за чего рвётся. Так вёл себя YouTube, VK брал второй заголовок и
    // звучал нормально.
    //
    // Пережатие звука своим кодировщиком даёт flv ровно один корректный заголовок
    // с настоящей частотой. Проверено на тестовом потоке 48 кГц: при `-c copy`
    // заголовка два (пустой + 48000), при пережатии — один и сразу верный.
    // Битрейт берём как у входа, чтобы не терять качество сверх необходимого;
    // частоту и каналы ffmpeg наследует от источника сам.
    '-c:a', 'aac',
    '-b:a', `${audioKbps && audioKbps >= 64 ? Math.min(audioKbps, 320) : 160}k`,
    ...networkOutputArgs,
    '-f', 'flv', target,
  ];
}

// --- раздача по площадкам ---------------------------------------------------

// id -> дочерний ffmpeg площадки. Живут независимо от слушателя и друг от друга.
const destProcs = new Map();
// Сколько байт разрешаем накопить в трубе площадки, прежде чем считать её
// затыком. Площадка, которая не успевает принимать, иначе утащила бы в память
// весь эфир: пишем мы быстрее, чем она отдаёт в сеть.
// Twitch can legitimately stop reading the local pipe for several seconds
// while opening RTMP. Keep enough data for that handshake; the 15-second
// network timeout still terminates a genuinely dead platform independently.
const DEST_BUFFER_LIMIT = 16 * 1024 * 1024;
const DEST_STALL_TIMEOUT = 20000;
// Базовая пауза перед повторным подъёмом площадки. При череде неудач растёт
// по экспоненте до потолка: Twitch после обрыва держит ключ «в эфире» ещё
// 10–30 с и отбивает слишком быстрые переподключения тем самым «Invalid
// argument». Долбёжка раз в 4 с только продлевает это состояние.
const DEST_RETRY_DELAY = 4000;
const DEST_RETRY_MAX_DELAY = 30000;
// Если площадка прожила дольше этого, значит связь встала нормально и обрыв
// пришёл позже — сбрасываем счётчик неудач, чтобы первая попытка была быстрой.
const DEST_HEALTHY_MS = 15000;

function ensureDestStat(id) {
  if (!destStats.has(id)) {
    destStats.set(id, {
      status: 'idle', error: '', liveSince: 0, failedAt: 0, sentBytes: 0, failStreak: 0,
      // Битрейт этой площадки конкретно, из её собственного вывода ffmpeg —
      // важно, когда у неё своё перекодирование и битрейт отличается от общего.
      bitrateKbps: 0,
    });
  }
  return destStats.get(id);
}

function spawnDestination(dest) {
  if (!ffmpegPath || destProcs.has(dest.id)) {
    return;
  }

  const stat = ensureDestStat(dest.id);
  const child = spawn(ffmpegPath, buildDestinationArgs(dest), { windowsHide: true });
  // target запоминаем, чтобы заметить смену адреса (например, включили
  // ретрансляцию через свой сервер) и перезапустить только эту площадку.
  const entry = {
    child,
    pending: 0,
    retryTimer: null,
    stallTimer: null,
    lastError: '',
    loggedErrorKinds: new Set(),
    startedAt: Date.now(),
    target: targetUrl(dest),
    videoSig: videoSignature(dest),
  };
  destProcs.set(dest.id, entry);
  logEvent('destination-start', {
    destinationId: dest.id,
    destination: dest.name,
    target: safeNetworkAddress(entry.target),
    viaRelay: Boolean(dest.viaRelay),
  });

  stat.status = live ? 'live' : 'idle';
  stat.error = '';
  stat.bitrateKbps = 0; // старое значение неактуально — ждём свежих stats
  if (live && !stat.liveSince) {
    stat.liveSince = Date.now();
  }

  child.stdin.on('error', () => {
    // Площадка закрылась раньше, чем мы дописали кусок — не наша забота,
    // состояние поправит обработчик exit.
  });

  child.stderr.on('data', (chunk) => {
    for (const rawLine of chunk.toString().split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      // Строка прогресса от -stats: "size=...kB time=... bitrate=1234.5kbits/s
      // speed=...x" (у перекодируемых площадок ещё и "frame="). Не ошибка —
      // это фактический битрейт, который реально уходит на эту площадку.
      if (/\btime=\d/.test(line) && /bitrate=/i.test(line) && /speed=/i.test(line)) {
        const brMatch = line.match(/bitrate=\s*([\d.]+)\s*kbits\/s/i);
        if (brMatch) {
          stat.bitrateKbps = Math.round(Number(brMatch[1]));
        }
        continue;
      }

      entry.lastError = redactLogText(line).slice(0, 200);
      const message = redactLogText(line);
      const errorKind = /Nothing was written/i.test(message)
        ? 'nothing-written'
        : /Could not write header|dimensions not set/i.test(message)
          ? 'invalid-header'
          : /non-existing PPS|decode_slice_header/i.test(message)
            ? 'missing-video-headers'
            : /Connection|Broken pipe|timed out/i.test(message)
              ? 'connection'
              : 'other';
      // FFmpeg can print the same decoder complaint for every frame. One
      // sample of each kind per process plus destination-exit is sufficient.
      if (!entry.loggedErrorKinds.has(errorKind)) {
        entry.loggedErrorKinds.add(errorKind);
        logEvent('destination-error', {
          destinationId: dest.id,
          destination: dest.name,
          target: safeNetworkAddress(entry.target),
          kind: errorKind,
          message,
        });
      }
    }
  });

  child.on('exit', (code, signal) => {
    if (destProcs.get(dest.id) !== entry) {
      return;
    }

    destProcs.delete(dest.id);
    clearTimeout(entry.retryTimer);
    clearTimeout(entry.stallTimer);

    // Выключили руками — процесса быть и не должно, это не ошибка. Заодно
    // обнуляем счётчик неудач, чтобы следующее включение стартовало без паузы.
    const stillWanted = enabledDestinations().some((d) => d.id === dest.id);
    if (!stillWanted || !running) {
      stat.status = 'idle';
      stat.liveSince = 0;
      stat.failStreak = 0;
      stat.bitrateKbps = 0;
      emitStatus();
      return;
    }

    // Площадка отработала долго и упала — это обычный обрыв, а не отказ подъёма:
    // начинаем отсчёт заново, чтобы переподключиться быстро.
    if (Date.now() - entry.startedAt >= DEST_HEALTHY_MS) {
      stat.failStreak = 0;
    }
    stat.failStreak += 1;

    stat.status = 'error';
    stat.error = entry.lastError || 'обрыв связи с площадкой';
    stat.failedAt = Date.now();
    stat.liveSince = 0;
    stat.bitrateKbps = 0;
    emitStatus();

    // Экспоненциальная пауза: 4с → 8с → 16с → … до потолка. Даём Twitch время
    // освободить зависший ключ, вместо того чтобы биться в него каждые 4 секунды.
    const delay = Math.min(DEST_RETRY_DELAY * 2 ** (stat.failStreak - 1), DEST_RETRY_MAX_DELAY);
    logEvent('destination-exit', {
      destinationId: dest.id,
      destination: dest.name,
      target: safeNetworkAddress(entry.target),
      code,
      signal,
      message: entry.lastError,
      retryInMs: delay,
    });

    // Поднимаем только эту площадку: остальные и слушатель ничего не заметят.
    entry.retryTimer = setTimeout(() => {
      const fresh = enabledDestinations().find((d) => d.id === dest.id);
      if (fresh && running && !destProcs.has(dest.id)) {
        spawnDestination(fresh);
        emitStatus();
      }
    }, delay);
  });

  child.on('error', (error) => {
    entry.lastError = redactLogText(error?.message || error);
    logEvent('destination-process-error', {
      destinationId: dest.id,
      destination: dest.name,
      target: safeNetworkAddress(entry.target),
      message: entry.lastError,
    });
    console.error('[restream] площадка не запустилась:', error?.message || error);
  });
  child.stdin.on('drain', () => {
    clearTimeout(entry.stallTimer);
    entry.stallTimer = null;
  });
}

function killDestination(id) {
  const entry = destProcs.get(id);
  if (!entry) {
    return;
  }

  destProcs.delete(id);
  clearTimeout(entry.retryTimer);
  clearTimeout(entry.stallTimer);
  try {
    entry.child.kill('SIGKILL');
  } catch {
    /* уже мёртв */
  }

  const stat = destStats.get(id);
  if (stat) {
    stat.status = 'idle';
    stat.liveSince = 0;
    stat.bitrateKbps = 0;
  }
}

// Приводит набор запущенных площадок к тому, что включено в настройках.
// Вызывается на каждое сохранение конфига — слушатель при этом не трогаем.
function syncDestinations() {
  const wanted = running ? enabledDestinations() : [];
  const wantedIds = new Set(wanted.map((d) => d.id));

  for (const id of [...destProcs.keys()]) {
    if (!wantedIds.has(id)) {
      killDestination(id);
    }
  }

  for (const id of [...destStats.keys()]) {
    if (!config.destinations.some((d) => d.id === id)) {
      destStats.delete(id);
    }
  }

  for (const dest of wanted) {
    ensureDestStat(dest.id);
    const entry = destProcs.get(dest.id);
    if (entry && entry.target && entry.target !== targetUrl(dest)) {
      // Адрес площадки сменился на ходу — поднимаем её заново по новому адресу.
      // Соседей и сам приём это не трогает.
      killDestination(dest.id);
    } else if (entry && entry.videoSig !== videoSignature(dest)) {
      // Поменяли только разрешение/битрейт этой площадки — адрес тот же, но
      // ffmpeg-аргументы другие, без перезапуска её процесса не применятся.
      killDestination(dest.id);
    }
    if (!destProcs.has(dest.id)) {
      spawnDestination(dest);
    }
  }
}

function killAllDestinations() {
  for (const id of [...destProcs.keys()]) {
    killDestination(id);
  }
}

// Раздаёт очередной кусок эфира всем живым площадкам.
function fanOut(chunk) {
  for (const [id, entry] of destProcs) {
    if (entry.pending + chunk.length > DEST_BUFFER_LIMIT) {
      // Площадка не успевает принимать. Роняем её процесс: обработчик exit
      // пометит ошибку и через паузу поднимет заново, с чистой трубой.
      const stat = destStats.get(id);
      if (stat) {
        stat.error = 'площадка не успевает принимать поток';
      }
      entry.lastError = 'destination input buffer exceeded limit';
      logEvent('destination-buffer-overflow', {
        destinationId: id,
        target: safeNetworkAddress(entry.target),
        queuedBytes: entry.pending,
        limitBytes: DEST_BUFFER_LIMIT,
      });
      entry.pending = 0;
      clearTimeout(entry.stallTimer);
      try {
        entry.child.kill('SIGKILL');
      } catch {
        /* уже мёртв */
      }
      continue;
    }

    entry.pending += chunk.length;
    try {
      const accepted = entry.child.stdin.write(chunk, () => {
        entry.pending = Math.max(entry.pending - chunk.length, 0);
      });
      if (!accepted && !entry.stallTimer) {
        entry.stallTimer = setTimeout(() => {
          entry.stallTimer = null;
          if (destProcs.get(id) !== entry || entry.child.stdin.destroyed || entry.pending === 0) {
            return;
          }
          entry.lastError = 'destination input stalled';
          logEvent('destination-stall', {
            destinationId: id,
            target: safeNetworkAddress(entry.target),
            queuedBytes: entry.pending,
          });
          try {
            entry.child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, DEST_STALL_TIMEOUT);
      }
    } catch {
      entry.pending = Math.max(entry.pending - chunk.length, 0);
    }

    const stat = destStats.get(id);
    if (stat && stat.status === 'live') {
      stat.sentBytes += chunk.length;
    }
  }
}

function spawnListener() {
  if (!ffmpegPath || proc) {
    return;
  }

  const child = spawn(ffmpegPath, buildListenerArgs(), { windowsHide: true });
  proc = child;
  logEvent('listener-start', {
    ingestPort: config.ingestPort,
    destinations: enabledDestinations().map((dest) => ({
      id: dest.id,
      name: dest.name,
      target: safeNetworkAddress(targetUrl(dest)),
    })),
  });

  child.stdout.on('data', fanOut);
  syncDestinations();

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
      logEvent('stream-live', {
        destinations: enabledDestinations().map((dest) => dest.name),
      });
      for (const [id, stat] of destStats) {
        if (destProcs.has(id)) {
          stat.status = 'live';
          stat.error = '';
          stat.failStreak = 0; // связь встала — счётчик неудач ни к чему
          if (!stat.liveSince) {
            stat.liveSince = sessionStartedAt;
          }
        }
      }
      important = true;
    }

    const now = Date.now();
    if (important || (statsChanged && now - lastStatsEmit >= 1000)) {
      lastStatsEmit = now;
      emitStatus();
    }

    for (const line of text.split(/\r?\n/)) {
      if (/\b(error|failed|failure|broken pipe|connection reset|timed out)\b/i.test(line)) {
        logEvent('listener-error', { message: redactLogText(line) });
      }
    }
  };
  // stdout занят самим эфиром — в лог идёт только stderr.
  child.stderr.on('data', onLog);

  child.on('exit', (code, signal) => {
    if (proc === child) {
      proc = null;
    }
    // Считаем обрывом только падение живого потока, а не перезапуск слушателя,
    // который OBS ещё ни разу не занял.
    if (live) {
      disconnects += 1;
      lastDisconnectAt = Date.now();
    }
    logEvent('listener-exit', {
      code,
      signal,
      wasLive: live,
      disconnects,
    });
    live = false;
    resetSessionStats();
    // Эфира больше нет — площадкам нечего передавать, гасим их процессы.
    // Поднимутся снова, когда OBS вернётся и слушатель встанет на приём.
    killAllDestinations();
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
    logEvent('listener-process-error', { message: redactLogText(error?.message || error) });
  });

  emitStatus();
}

function killListener() {
  clearTimeout(respawnTimer);
  respawnTimer = null;
  live = false;
  killAllDestinations();
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

// Перезапуск слушателя нужен только под смену ключа или порта: там меняется
// сам сокет, который занял OBS. Список площадок сюда больше не относится —
// его применяет syncDestinations(), не трогая эфир.
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
    initLogging(storageDir);
    load(storageDir);
    logEvent('restream-init', {
      enabled: config.enabled,
      ingestPort: config.ingestPort,
      destinations: config.destinations.map((dest) => ({
        id: dest.id,
        name: dest.name,
        enabled: dest.enabled,
        target: safeNetworkAddress(targetUrl(dest)),
      })),
    });
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
  const prevKey = config.streamKey;
  const prevPort = config.ingestPort;

  if (next.streamKey !== undefined) {
    config.streamKey = String(next.streamKey || '').trim() || DEFAULT_STREAM_KEY;
  }
  if (next.ingestPort !== undefined) {
    config.ingestPort = Number(next.ingestPort) || DEFAULT_INGEST_PORT;
  }
  if (next.destinations !== undefined) {
    config.destinations = normalizeDestinations(next.destinations);
  }
  if (next.relay !== undefined) {
    const prevRelay = config.relay || createDefaultRelay();
    config.relay = normalizeRelay({
      ...next.relay,
      // Пустой пароль в патче не затирает сохранённый: интерфейс его не пересылает.
      password: next.relay?.password ? next.relay.password : prevRelay.password,
    });
  }
  save();

  // Ключ и порт меняют адрес приёма — без перезапуска слушателя никак, OBS
  // придётся переподключиться. Правка списка площадок эфир не трогает.
  if (config.streamKey !== prevKey || config.ingestPort !== prevPort) {
    restartListener();
  } else {
    syncDestinations();
  }

  emitStatus();
  return getState();
}

function shutdown() {
  config.enabled = false;
  running = false;
  killListener();
}

module.exports = { init, start, stop, saveConfig, getState, shutdown };
