const socket = io();
const musicNowTitle = document.querySelector('#musicNowTitle');
const musicWidget = document.querySelector('.music-widget');
const musicPlayer = document.querySelector('#musicPlayer');
const musicQueueTitle = document.querySelector('#musicQueueTitle');
const musicQueue = document.querySelector('#musicQueue');

let queue = [];
let currentId = '';
let playTimer = null;
let finalizeTimer = null;
let youtubeProgressTimer = null;
let vkVideoPlayer = null;
let kickedTrackId = '';
let finishingTrackId = '';
let vkSoundEnabled = false;
let rutubeSoundEnabled = false;
let rutubeSoundRetryTimers = [];
let vkSoundRetryTimers = [];
let playbackStartedAt = 0;
let lastKnownDuration = 0;
const knownReadyIds = new Set();
let musicVolumePercent = 50;
const MUSIC_LEADER_KEY = 'tchat.music.leader';
const TRACK_END_GUARD_MS = 3000;
const DEFAULT_PLAYBACK_FALLBACK_MS = 15 * 60 * 1000;
const LEADER_TTL_MS = 5000;
const isEmbeddedPlayer = new URLSearchParams(window.location.search).get('embedded') === '1';
const playerInstanceId = `music-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
let canPlayAudio = false;
let obsPlaybackAllowed = true;
let leaderHeartbeatTimer = null;
let startingTrackId = '';
let youtubeSoundConfirmed = false; // плеер сам подтвердил, что звук включён
let youtubeSoundRetryTimers = [];
let youtubeSoundWatchdogTimer = null;
let lastReportedTitle = '';

function readPlaybackLeader() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MUSIC_LEADER_KEY) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writePlaybackLeader(record) {
  localStorage.setItem(MUSIC_LEADER_KEY, JSON.stringify(record));
}

// Играет только один плеер на весь браузер — кто владеет ключом лидера. Раньше
// встроенный в оверлей плеер забирал лидерство безусловно, и два таких плеера
// (два источника с stream.html в OBS или два музыкальных виджета в рабочей
// области) играли один и тот же трек одновременно — получалось эхо. Теперь
// встроенный вытесняет только отдельное окно виджета, но не другой встроенный:
// кто занял место первым, тот и играет.
function claimPlaybackLeadership() {
  if (!obsPlaybackAllowed) {
    return false;
  }

  const now = Date.now();
  const current = readPlaybackLeader();
  const leaderAlive = Boolean(current?.id) && now - Number(current.at || 0) < LEADER_TTL_MS;

  if (leaderAlive && current.id !== playerInstanceId && !(isEmbeddedPlayer && !current.embedded)) {
    return false;
  }

  writePlaybackLeader({ id: playerInstanceId, embedded: isEmbeddedPlayer, at: now });
  return true;
}

function releasePlaybackLeadership() {
  if (readPlaybackLeader()?.id !== playerInstanceId) {
    return;
  }

  // Освобождаем место сразу, иначе после перезагрузки страницы новый плеер
  // ждал бы истечения TTL — пять секунд тишины на ровном месте.
  localStorage.removeItem(MUSIC_LEADER_KEY);
}

function refreshPlaybackLeadership() {
  const wasLeader = canPlayAudio;
  canPlayAudio = claimPlaybackLeadership();

  if (wasLeader && !canPlayAudio) {
    stopPlayback(false);
    return;
  }

  if (!wasLeader && canPlayAudio && !currentId) {
    playNextReady();
  }
}

function initPlaybackLeader() {
  canPlayAudio = claimPlaybackLeadership();
  if (leaderHeartbeatTimer) {
    window.clearInterval(leaderHeartbeatTimer);
  }

  leaderHeartbeatTimer = window.setInterval(refreshPlaybackLeadership, 2000);
  window.addEventListener('storage', (event) => {
    if (event.key === MUSIC_LEADER_KEY) {
      refreshPlaybackLeadership();
    }
  });
}

function loadInitialState() {
  const bootstrap = () => {
    fetch('/music/state')
      .then((response) => response.json())
      .then(renderMusicState)
      .catch(() => {});
  };

  if (socket.connected) {
    bootstrap();
  } else {
    socket.once('connect', bootstrap);
  }
}

initPlaybackLeader();
loadInitialState();

window.addEventListener('message', handlePlayerMessage);
window.addEventListener('message', handleObsPlaybackMessage);
window.addEventListener('obsSourceVisibleChanged', (event) => {
  setObsPlaybackAllowed(event.detail?.visible !== false);
});
window.addEventListener('obsSourceActiveChanged', (event) => {
  setObsPlaybackAllowed(event.detail?.active !== false);
});

function handleObsPlaybackMessage(event) {
  if (event.source !== window.parent || event.data?.type !== 'tchat:obs-playback') {
    return;
  }

  setObsPlaybackAllowed(event.data.allowed !== false);
}

function setObsPlaybackAllowed(allowed) {
  const nextAllowed = allowed !== false;
  if (obsPlaybackAllowed === nextAllowed) {
    return;
  }

  obsPlaybackAllowed = nextAllowed;
  if (!obsPlaybackAllowed) {
    releasePlaybackLeadership();
  }
  refreshPlaybackLeadership();
}

socket.on('music:queue', renderMusicState);
socket.on('music:play', (item) => {
  if (!item?.id || item.status !== 'ready' || !item.embedUrl || item.played) {
    return;
  }

  upsertQueueItem(item);

  if (canPlayAudio && !currentId) {
    playNextReady();
  }
});

function upsertQueueItem(item) {
  const index = queue.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    queue.push(item);
    return;
  }

  queue[index] = { ...queue[index], ...item };
}

function renderMusicState(state) {
  const nextVolume = Number(state?.settings?.volume);
  if (Number.isFinite(nextVolume)) {
    const clamped = Math.min(Math.max(Math.round(nextVolume), 0), 100);
    // Состояние очереди прилетает часто, а громкость в нём меняется редко —
    // переспрашиваем плеер только когда значение действительно другое.
    if (clamped !== musicVolumePercent) {
      musicVolumePercent = clamped;
      applyMusicVolume();
    }
  }

  queue = Array.isArray(state?.queue) ? state.queue : [];

  if (currentId && !queue.some((item) => item.id === currentId && (item.status === 'ready' || item.status === 'playing') && !item.played)) {
    stopPlayback(false);
  }

  for (const item of queue) {
    if (item.status === 'ready' && item.embedUrl) {
      knownReadyIds.add(item.id);
    }
  }

  renderQueue();

  if (
    canPlayAudio &&
    !currentId &&
    queue.some((item) => ['ready', 'playing'].includes(item.status) && !item.played && item.embedUrl)
  ) {
    playNextReady();
  }
}

function playNextReady() {
  if (!canPlayAudio || currentId) {
    return;
  }

  const next = queue.find((item) => ['ready', 'playing'].includes(item.status) && !item.played && item.embedUrl);

  if (!next) {
    setNowTitle('');
    musicPlayer.hidden = true;
    musicPlayer.removeAttribute('src');
    musicPlayer.src = '';
    return;
  }

  startPlayback(next);
}

function startPlayback(item) {
  if (!canPlayAudio) {
    return;
  }

  const embedUrl = ensureAutoplayUrl(item.embedUrl, item.platform);

  if (currentId === item.id || startingTrackId === item.id) {
    return;
  }

  if (musicPlayer.dataset.trackId === item.id && musicPlayer.dataset.embedUrl === embedUrl && musicPlayer.src) {
    currentId = item.id;
    return;
  }

  clearTimeout(playTimer);
  clearTimeout(finalizeTimer);
  kickedTrackId = '';
  startingTrackId = item.id;
  vkSoundEnabled = false;
  rutubeSoundEnabled = false;
  youtubeSoundConfirmed = false;
  lastReportedTitle = '';
  clearRutubeSoundRetries();
  clearVkSoundRetries();
  clearYouTubeSoundRetries();

  currentId = item.id;
  playbackStartedAt = Date.now();
  lastKnownDuration = Number(item.duration) || 0;
  socket.emit('music:started', { id: item.id });
  setNowTitle(decodeHtml(item.title || 'Музыкальная заявка'));

  musicPlayer.hidden = false;
  musicPlayer.removeAttribute('hidden');
  renderQueue();

  musicPlayer.dataset.trackId = item.id;
  musicPlayer.dataset.embedUrl = embedUrl;
  musicPlayer.onload = () => {
    startingTrackId = '';
    // Для ютуба цепляемся к плееру сразу, не дожидаясь общей задержки в 900 мс:
    // чем раньше пойдут ответы infoDelivery, тем раньше снимем мут.
    if (isYouTubeItem(item)) {
      registerYouTubePlayerEvents();
      scheduleYouTubeSoundRetries();
    }
    finalizePlayback(item);
  };

  musicPlayer.src = embedUrl;

  playTimer = window.setTimeout(() => {
    if (currentId !== item.id) {
      return;
    }

    finishCurrentTrack();
  }, getPlaybackFallbackMs(item));
}

function finishCurrentTrack() {
  const itemId = currentId;

  if (!itemId || finishingTrackId === itemId) {
    return;
  }

  finishingTrackId = itemId;
  clearTimeout(playTimer);
  clearTimeout(finalizeTimer);
  playTimer = null;
  finalizeTimer = null;
  socket.emit('music:played', { id: itemId });
  stopPlayback(true);
  finishingTrackId = '';
}

function setNowTitle(title = '') {
  const value = String(title || '').trim();
  musicNowTitle.textContent = value ? `Сейчас играет: ${value}` : '';
  musicNowTitle.hidden = !value;
  syncWidgetVisibility();
}

function finalizePlayback(item) {
  if (currentId !== item.id || kickedTrackId === item.id) {
    return;
  }

  kickedTrackId = item.id;
  clearTimeout(finalizeTimer);

  finalizeTimer = window.setTimeout(() => {
    if (currentId !== item.id) {
      return;
    }

    if (isYouTubeItem(item)) {
      registerYouTubePlayerEvents();
      scheduleYouTubeSoundRetries();
      scheduleYouTubeProgressPolling();
    }

    if (isRutubeItem(item)) {
      startRutubePlayback();
    }

    if (isVkItem(item)) {
      initVkVideoPlayer(item);
      startVkPlayback();
    }
  }, 900);
}

function getPlaybackFallbackMs(item = {}) {
  const duration = Number(item.duration);

  if (Number.isFinite(duration) && duration > 0) {
    return Math.max((duration + 45) * 1000, 45000);
  }

  return DEFAULT_PLAYBACK_FALLBACK_MS;
}

function resetPlaybackFallbackTimer(durationSeconds) {
  clearTimeout(playTimer);

  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }

  playTimer = window.setTimeout(() => {
    if (currentId) {
      finishCurrentTrack();
    }
  }, Math.max((duration + 45) * 1000, 45000));
}

function trackPlaybackProgress(currentTime, duration) {
  if (!currentId || !Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return;
  }

  lastKnownDuration = duration;
  resetPlaybackFallbackTimer(duration);

  if (shouldFinishNearEnd(currentTime, duration)) {
    finishCurrentTrack();
  }
}

function shouldFinishNearEnd(currentTime, duration) {
  return duration > 0 && currentTime >= duration - 1.5;
}

function clearYouTubeProgressPolling() {
  if (!youtubeProgressTimer) {
    return;
  }

  window.clearInterval(youtubeProgressTimer);
  youtubeProgressTimer = null;
}

function scheduleYouTubeProgressPolling() {
  clearYouTubeProgressPolling();

  youtubeProgressTimer = window.setInterval(() => {
    if (!currentId || !isYouTubeItem({ embedUrl: musicPlayer.src })) {
      return;
    }

    sendYouTubeCommand('getCurrentTime');
    sendYouTubeCommand('getDuration');
  }, 2500);
}

function destroyVkVideoPlayer() {
  if (!vkVideoPlayer) {
    return;
  }

  try {
    if (typeof vkVideoPlayer.destroy === 'function') {
      vkVideoPlayer.destroy();
    }
  } catch {
    // ignore teardown errors
  }

  vkVideoPlayer = null;
}

function initVkVideoPlayer(item) {
  if (!isVkItem(item) || typeof VK === 'undefined' || !VK?.VideoPlayer) {
    return;
  }

  destroyVkVideoPlayer();

  try {
    vkVideoPlayer = VK.VideoPlayer(musicPlayer);
  } catch {
    vkVideoPlayer = null;
    return;
  }

  const endedEvent = VK.VideoPlayer.Events?.ended || 'ended';
  const timeupdateEvent = VK.VideoPlayer.Events?.timeupdate || 'timeupdate';

  vkVideoPlayer.on(endedEvent, () => {
    if (Date.now() - playbackStartedAt >= TRACK_END_GUARD_MS) {
      finishCurrentTrack();
    }
  });

  vkVideoPlayer.on(timeupdateEvent, (state = {}) => {
    const currentTime = Number(state.time ?? state.currentTime);
    const duration = Number(state.duration ?? item.duration ?? lastKnownDuration);
    trackPlaybackProgress(currentTime, duration);
  });
}

// Автозапуск в браузере разрешён только для немого видео, поэтому в URL стоит
// mute=1, а звук включается командой уже после старта. Плеер принимает команды
// не сразу и молча роняет всё, что пришло до инициализации iframe API — из-за
// одной попытки звук появлялся с задержкой в несколько секунд. Поэтому шлём
// серию попыток и прекращаем, только когда плеер сам отчитается, что не в муте.
//
// Серия попыток раньше заканчивалась через пять секунд после load самого
// iframe. В OBS источник стартует «на холодную» и внутренний скрипт ютуба
// поднимается дольше — все команды падали в пустоту, ответов не приходило,
// и трек доигрывал в муте до конца. Помогало только открыть страницу виджета
// руками: там кеш уже прогрет и плеер успевал в это окно. Поэтому попытки
// теперь не имеют срока — они идут, пока плеер не подтвердит звук или пока
// трек не закончится.
function enableYouTubeSound() {
  if (musicVolumePercent === 0) {
    sendYouTubeCommand('setVolume', [0]);
    sendYouTubeCommand('mute');
    youtubeSoundConfirmed = true;
    clearYouTubeSoundRetries();
  } else {
    sendYouTubeCommand('unMute');
    sendYouTubeCommand('setVolume', [musicVolumePercent]);
  }
  sendYouTubeCommand('getVideoData');
}

function clearYouTubeSoundRetries() {
  youtubeSoundRetryTimers.forEach((timerId) => window.clearTimeout(timerId));
  youtubeSoundRetryTimers = [];

  if (youtubeSoundWatchdogTimer) {
    window.clearInterval(youtubeSoundWatchdogTimer);
    youtubeSoundWatchdogTimer = null;
  }
}

function pokeYouTubeSound() {
  if (!currentId || !isYouTubeItem({ embedUrl: musicPlayer.src })) {
    return;
  }

  if (youtubeSoundConfirmed) {
    clearYouTubeSoundRetries();
    return;
  }

  // Рукопожатие повторяем вместе с командой: без него плеер не шлёт ответов,
  // а значит и подтвердить снятие мута нечем.
  registerYouTubePlayerEvents();
  enableYouTubeSound();
  // Просим плеер отчитаться о громкости — по ответу поймём, снялся ли мут.
  sendYouTubeCommand('getVolume');
}

function scheduleYouTubeSoundRetries() {
  clearYouTubeSoundRetries();

  // Частая серия в первые секунды — чтобы звук появился сразу, когда плеер
  // поднялся быстро.
  for (const delay of [0, 150, 400, 900, 1800, 3000]) {
    youtubeSoundRetryTimers.push(window.setTimeout(pokeYouTubeSound, delay));
  }

  // Дальше — бессрочный дозор на случай медленного старта в OBS.
  youtubeSoundWatchdogTimer = window.setInterval(pokeYouTubeSound, 1000);
}

function registerYouTubePlayerEvents() {
  const target = musicPlayer.contentWindow;

  if (!target) {
    return;
  }

  target.postMessage(JSON.stringify({ event: 'listening' }), '*');
  target.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
}

function isTrackEndEvent(data) {
  if (Date.now() - playbackStartedAt < TRACK_END_GUARD_MS) {
    return false;
  }

  if (data.type === 'player:playComplete') {
    return true;
  }

  if (data.type === 'player:changeState' && String(data.data?.state || '').toLowerCase() === 'stopped') {
    return true;
  }

  if (data.event === 'onStateChange' && Number(data.info) === 0) {
    return true;
  }

  if (data.event === 'infoDelivery' && Number(data.info?.playerState) === 0) {
    return true;
  }

  const eventName = String(data.event || data.type || data.name || '').toLowerCase();

  if (eventName.includes('ad')) {
    return false;
  }

  if (eventName === 'ended' || eventName === 'playbackfinished' || eventName === 'videoend') {
    return true;
  }

  return false;
}

function handlePlayerMessage(event) {
  if (!currentId || event.source !== musicPlayer.contentWindow) {
    return;
  }

  let data = event.data;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      if (Date.now() - playbackStartedAt >= TRACK_END_GUARD_MS && /\bended\b/i.test(data)) {
        finishCurrentTrack();
      }

      return;
    }
  }

  if (!data || typeof data !== 'object') {
    return;
  }

  if (data.event === 'infoDelivery' && data.info) {
    const currentTime = Number(data.info.currentTime);
    const duration = Number(data.info.duration ?? data.info.videoDuration ?? data.info.length);
    const reportedTitle = decodeHtml(data.info.videoData?.title || data.info.title || '').trim();

    if (Number.isFinite(currentTime) && Number.isFinite(duration) && duration > 0) {
      trackPlaybackProgress(currentTime, duration);
    }

    if (isUsableReportedTitle(reportedTitle) && reportedTitle !== lastReportedTitle) {
      lastReportedTitle = reportedTitle;
      const currentItem = queue.find((item) => item.id === currentId);
      if (currentItem) {
        currentItem.title = reportedTitle;
      }
      setNowTitle(reportedTitle);
      renderQueue();
      socket.emit('music:title', { id: currentId, title: reportedTitle });
    }
  }

  if (isYouTubeItem({ embedUrl: musicPlayer.src })) {
    // onReady и переход в PLAYING (1) — самые ранние моменты, когда плеер
    // гарантированно принимает команды.
    if (data.event === 'onReady' || (data.event === 'onStateChange' && Number(data.info) === 1)) {
      enableYouTubeSound();
    }

    const info = data.info;
    if (info && typeof info === 'object' && (info.muted !== undefined || info.volume !== undefined)) {
      const volume = Number(info.volume);
      if (info.muted === false && volume > 0) {
        youtubeSoundConfirmed = true;
        clearYouTubeSoundRetries();
      } else if (info.muted === true || volume === 0) {
        youtubeSoundConfirmed = false;
        enableYouTubeSound();
      }
    }
  }

  if (isRutubeItem({ embedUrl: musicPlayer.src })) {
    if (data.type === 'player:ready' || data.type === 'player:init') {
      startRutubePlayback();
    } else if (data.type === 'player:playStart') {
      enableRutubeSound(true);
    } else if (data.type === 'player:changeState' && String(data.data?.state || '').toLowerCase() === 'playing') {
      enableRutubeSound(true);
    } else if (data.type === 'player:volumeChange' && data.data?.muted) {
      enableRutubeSound(true);
    }
  }

  if (isVkItem({ embedUrl: musicPlayer.src })) {
    const vkEvent = String(data.event || '').toLowerCase();
    if (vkEvent === 'inited' || vkEvent === 'started' || vkEvent === 'resumed' || vkEvent === 'autoplaysoundprohibited') {
      enableVkSound();
    }

    if (vkEvent === 'ended') {
      finishCurrentTrack();
      return;
    }
  }

  if (isTrackEndEvent(data)) {
    finishCurrentTrack();
  }
}

function stopPlayback(continueQueue) {
  clearTimeout(playTimer);
  clearTimeout(finalizeTimer);
  clearYouTubeProgressPolling();
  destroyVkVideoPlayer();
  playTimer = null;
  finalizeTimer = null;
  kickedTrackId = '';
  startingTrackId = '';
  vkSoundEnabled = false;
  rutubeSoundEnabled = false;
  youtubeSoundConfirmed = false;
  lastReportedTitle = '';
  clearRutubeSoundRetries();
  clearVkSoundRetries();
  clearYouTubeSoundRetries();
  playbackStartedAt = 0;
  lastKnownDuration = 0;
  currentId = '';
  musicPlayer.onload = null;
  delete musicPlayer.dataset.trackId;
  delete musicPlayer.dataset.embedUrl;
  musicPlayer.hidden = true;
  musicPlayer.removeAttribute('src');
  musicPlayer.src = '';
  setNowTitle('');
  renderQueue();

  if (continueQueue) {
    window.setTimeout(playNextReady, 150);
  }
}

function isYouTubeItem(item = {}) {
  return item.platform === 'youtube' || /youtube\.com|youtu\.be/i.test(item.embedUrl || item.url || '');
}

function isRutubeItem(item = {}) {
  return item.platform === 'rutube' || /rutube\.ru/i.test(item.embedUrl || item.url || '');
}

function isVkItem(item = {}) {
  return item.platform === 'vk' || /vk\.com\/video|vkvideo\.ru/i.test(item.embedUrl || item.url || '');
}

function sendYouTubeCommand(func, args = []) {
  musicPlayer.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
}

function sendRutubeCommand(type, data) {
  const message = data === undefined ? { type } : { type, data };
  musicPlayer.contentWindow?.postMessage(JSON.stringify(message), '*');
}

function clearRutubeSoundRetries() {
  rutubeSoundRetryTimers.forEach((timerId) => window.clearTimeout(timerId));
  rutubeSoundRetryTimers = [];
}

function enableRutubeSound(force = false) {
  if (rutubeSoundEnabled && !force) {
    return;
  }

  rutubeSoundEnabled = true;
  sendRutubeCommand(musicVolumePercent === 0 ? 'player:mute' : 'player:unMute');
  sendRutubeCommand('player:setVolume', { volume: musicVolumePercent / 100 });
}

function scheduleRutubeSoundRetries() {
  clearRutubeSoundRetries();

  // Верхняя граница здесь тоже растянута: холодный старт источника в OBS
  // спокойно съедает первые секунды, а до инициализации плеер команды теряет.
  for (const delay of [200, 600, 1500, 3000, 6000, 10000, 15000, 20000, 30000]) {
    rutubeSoundRetryTimers.push(
      window.setTimeout(() => {
        if (!currentId || !isRutubeItem({ embedUrl: musicPlayer.src })) {
          return;
        }

        rutubeSoundEnabled = false;
        enableRutubeSound(true);
      }, delay),
    );
  }
}

function startRutubePlayback() {
  sendRutubeCommand('player:play', {});
  enableRutubeSound();
  scheduleRutubeSoundRetries();
}

function sendVkCommand(method, extra = {}) {
  musicPlayer.contentWindow?.postMessage({ method, ...extra }, '*');
}

function enableVkSound(force = false) {
  if (vkSoundEnabled && !force) {
    return;
  }

  vkSoundEnabled = true;
  sendVkCommand(musicVolumePercent === 0 ? 'mute' : 'unmute');
  sendVkCommand('set_volume', { volume: musicVolumePercent / 100 });
}

function clearVkSoundRetries() {
  vkSoundRetryTimers.forEach((timerId) => window.clearTimeout(timerId));
  vkSoundRetryTimers = [];
}

function scheduleVkSoundRetries() {
  clearVkSoundRetries();

  for (const delay of [200, 600, 1500, 3000, 6000, 10000, 15000, 20000, 30000]) {
    vkSoundRetryTimers.push(
      window.setTimeout(() => {
        if (!currentId || !isVkItem({ embedUrl: musicPlayer.src })) {
          return;
        }

        enableVkSound(true);
      }, delay),
    );
  }
}

function applyMusicVolume() {
  if (!currentId || !musicPlayer.contentWindow) {
    return;
  }

  if (isYouTubeItem({ embedUrl: musicPlayer.src })) {
    youtubeSoundConfirmed = false;
    // Новую громкость шлём тем же надёжным путём: одиночная команда так же
    // может потеряться, как и первое снятие мута.
    scheduleYouTubeSoundRetries();
  } else if (isRutubeItem({ embedUrl: musicPlayer.src })) {
    rutubeSoundEnabled = false;
    enableRutubeSound(true);
  } else if (isVkItem({ embedUrl: musicPlayer.src })) {
    vkSoundEnabled = false;
    enableVkSound();
  }
}

function startVkPlayback() {
  sendVkCommand('init');
  sendVkCommand('play');
  enableVkSound();
  scheduleVkSoundRetries();
}

function ensureAutoplayUrl(url = '', platform = '') {
  try {
    const parsed = new URL(url);

    if (isRutubeItem({ platform, embedUrl: url })) {
      parsed.searchParams.set('autoplay', 'true');
      parsed.searchParams.set('autostartmute', 'false');
      return parsed.toString();
    }

    if (isVkItem({ platform, embedUrl: url })) {
      parsed.searchParams.set('autoplay', '1');
      parsed.searchParams.set('js_api', '1');
      parsed.searchParams.set('muted', '1');
      return parsed.toString();
    }

    parsed.searchParams.set('autoplay', '1');

    if (isYouTubeItem({ platform, embedUrl: url })) {
      parsed.searchParams.set('enablejsapi', '1');
      parsed.searchParams.set('playsinline', '1');
      parsed.searchParams.set('mute', '1');
      parsed.searchParams.set('origin', window.location.origin);
      parsed.searchParams.set('rel', '0');
    }

    return parsed.toString();
  } catch {
    if (/autoplay=/i.test(url)) {
      return url;
    }

    if (isRutubeItem({ platform, embedUrl: url })) {
      return `${url}${url.includes('?') ? '&' : '?'}autoplay=true&autostartmute=false`;
    }

    if (isVkItem({ platform, embedUrl: url })) {
      return `${url}${url.includes('?') ? '&' : '?'}autoplay=1&js_api=1&muted=1`;
    }

    return `${url}${url.includes('?') ? '&' : '?'}autoplay=1`;
  }
}

function renderQueue() {
  const waitingItems = queue.filter((item) => item.id !== currentId && item.status !== 'played' && !item.played);

  if (!waitingItems.length) {
    musicQueue.innerHTML = '';
    musicQueue.hidden = true;
    musicQueueTitle.hidden = true;
    syncWidgetVisibility();
    return;
  }

  musicQueueTitle.hidden = false;
  musicQueue.hidden = false;
  musicQueue.innerHTML = waitingItems
    .map((item) => {
      return `
        <li class="music-widget__item music-widget__item--${escapeHtml(item.status || 'checking')}">
          ${escapeHtml(decodeHtml(item.title || 'Музыкальная заявка'))}
        </li>
      `;
    })
    .join('');

  [...musicQueue.children].forEach((element, index) => {
    const item = waitingItems[index] || {};
    const title = decodeHtml(item.title || 'Музыкальная заявка');
    element.innerHTML = `
      <span>В очереди #${index + 1}</span>
      <strong>${escapeHtml(title)}</strong>
    `;
  });

  syncWidgetVisibility();
}

function syncWidgetVisibility() {
  if (!musicWidget) {
    return;
  }

  const waitingItems = queue.filter((item) => item.id !== currentId && item.status !== 'played' && !item.played);
  const hasContent = Boolean(currentId) || waitingItems.length > 0 || !musicNowTitle.hidden || !musicPlayer.hidden;
  musicWidget.hidden = !hasContent;
}

function decodeHtml(value = '') {
  const node = document.createElement('textarea');
  node.innerHTML = String(value);
  return node.value;
}

function isUsableReportedTitle(title = '') {
  const value = String(title || '').trim();
  return Boolean(value) && value.length <= 300 && !/^https?:\/\//i.test(value) && !/^(YouTube|Rutube|VK Видео)$/i.test(value);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.addEventListener('beforeunload', () => {
  releasePlaybackLeadership();
});
