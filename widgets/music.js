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
let playbackStartedAt = 0;
let lastKnownDuration = 0;
const knownReadyIds = new Set();
const MUSIC_VOLUME_PERCENT = 50;
const STARTED_TRACKS_KEY = 'tchat.music.startedTracks';
const MUSIC_LEADER_KEY = 'tchat.music.leader';
const TRACK_END_GUARD_MS = 3000;
const DEFAULT_PLAYBACK_FALLBACK_MS = 15 * 60 * 1000;
const LEADER_TTL_MS = 5000;
const isEmbeddedPlayer = new URLSearchParams(window.location.search).get('embedded') === '1';
const playerInstanceId = `music-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
let canPlayAudio = false;
let leaderHeartbeatTimer = null;
let startingTrackId = '';
let youtubeSoundConfirmed = false; // плеер сам подтвердил, что звук включён
let youtubeSoundRetryTimers = [];

function readStartedTracks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STARTED_TRACKS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rememberStartedTrack(id) {
  if (!id) {
    return;
  }

  const startedTracks = new Set(readStartedTracks());
  startedTracks.add(id);
  localStorage.setItem(STARTED_TRACKS_KEY, JSON.stringify([...startedTracks].slice(-100)));
}

function hasStartedTrack(id) {
  return readStartedTracks().includes(id);
}

function forgetStartedTrack(id) {
  if (!id) {
    return;
  }

  const startedTracks = readStartedTracks().filter((trackId) => trackId !== id);
  localStorage.setItem(STARTED_TRACKS_KEY, JSON.stringify(startedTracks));
}

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
    socket.emit('music:bootstrap', () => {
      fetch('/music/state')
        .then((response) => response.json())
        .then(renderMusicState)
        .catch(() => {});
    });
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

  if (canPlayAudio && !currentId && queue.some((item) => item.status === 'ready' && !item.played && item.embedUrl)) {
    playNextReady();
  }
}

function playNextReady() {
  if (!canPlayAudio || currentId) {
    return;
  }

  const next = queue.find((item) => item.status === 'ready' && !item.played && item.embedUrl);

  if (!next) {
    setNowTitle('');
    musicPlayer.hidden = true;
    musicPlayer.removeAttribute('src');
    musicPlayer.src = '';
    return;
  }

  if (hasStartedTrack(next.id)) {
    socket.emit('music:played', { id: next.id });
    window.setTimeout(playNextReady, 0);
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
  clearRutubeSoundRetries();
  clearYouTubeSoundRetries();

  currentId = item.id;
  playbackStartedAt = Date.now();
  lastKnownDuration = Number(item.duration) || 0;
  rememberStartedTrack(item.id);
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
  forgetStartedTrack(itemId);
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
function enableYouTubeSound() {
  sendYouTubeCommand('unMute');
  sendYouTubeCommand('setVolume', [MUSIC_VOLUME_PERCENT]);
}

function clearYouTubeSoundRetries() {
  youtubeSoundRetryTimers.forEach((timerId) => window.clearTimeout(timerId));
  youtubeSoundRetryTimers = [];
}

function scheduleYouTubeSoundRetries() {
  clearYouTubeSoundRetries();

  for (const delay of [0, 150, 400, 900, 1800, 3000, 5000]) {
    youtubeSoundRetryTimers.push(
      window.setTimeout(() => {
        if (!currentId || youtubeSoundConfirmed) {
          return;
        }

        enableYouTubeSound();
        // Просим плеер отчитаться о громкости — по ответу поймём, снялся ли мут.
        sendYouTubeCommand('getVolume');
      }, delay),
    );
  }
}

function registerYouTubePlayerEvents() {
  const target = musicPlayer.contentWindow;

  if (!target || musicPlayer.dataset.youtubeListening === '1') {
    return;
  }

  musicPlayer.dataset.youtubeListening = '1';
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

    if (Number.isFinite(currentTime) && Number.isFinite(duration) && duration > 0) {
      trackPlaybackProgress(currentTime, duration);
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
  clearRutubeSoundRetries();
  clearYouTubeSoundRetries();
  playbackStartedAt = 0;
  lastKnownDuration = 0;
  currentId = '';
  musicPlayer.onload = null;
  delete musicPlayer.dataset.trackId;
  delete musicPlayer.dataset.embedUrl;
  delete musicPlayer.dataset.youtubeListening;
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
  sendRutubeCommand('player:unMute');
  sendRutubeCommand('player:setVolume', { volume: MUSIC_VOLUME_PERCENT / 100 });
}

function scheduleRutubeSoundRetries() {
  clearRutubeSoundRetries();

  for (const delay of [200, 600, 1500, 3000, 6000]) {
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

function enableVkSound() {
  if (vkSoundEnabled) {
    return;
  }

  vkSoundEnabled = true;
  sendVkCommand('unmute');
  sendVkCommand('set_volume', { volume: MUSIC_VOLUME_PERCENT / 100 });
}

function startVkPlayback() {
  sendVkCommand('init');
  sendVkCommand('play');
  enableVkSound();
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

  if (!currentId) {
    return;
  }

  socket.emit('music:played', { id: currentId });
  forgetStartedTrack(currentId);
});
