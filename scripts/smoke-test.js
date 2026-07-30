const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const baseUrl = process.env.TCHAT_URL || 'http://localhost:3000';
const projectRoot = path.join(__dirname, '..');

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-TChat-Internal': '1',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = text;

  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { response, body };
}

function parseVkChatBotMessage(item = {}) {
  const authorName = String(item.author?.displayName || item.author?.nick || item.author?.name || '').trim();
  if (!/chatbot/i.test(authorName)) {
    return null;
  }

  const parts = Array.isArray(item.data) ? item.data : [];
  const mention = parts.find((part) => part?.type === 'mention');
  const textParts = parts
    .filter((part) => part?.type === 'text')
    .map((part) => {
      try {
        const parsed = JSON.parse(part.content || '[]');
        return Array.isArray(parsed) ? String(parsed[0] || '') : String(part.content || '');
      } catch {
        return String(part.content || '');
      }
    })
    .join(' ')
    .trim();

  const username = String(mention?.displayName || mention?.nick || mention?.name || '').trim();
  if (!username) {
    return null;
  }

  return { username, textParts, id: item.id };
}

function parseVkSubscriptionRenewalEvent(item = {}) {
  const base = parseVkChatBotMessage(item);
  if (!base || !/продлил\s+подписку/i.test(base.textParts)) {
    return null;
  }

  const tierMatch = base.textParts.match(/подписку\s+['«"]([^'»"]+)['»"]/i);
  const monthsMatch = base.textParts.match(/подписан\s+уже\s+(\d+)\s+месяц/i);

  return {
    platform: 'vk',
    username: base.username,
    tier: tierMatch?.[1] || '',
    months: monthsMatch ? Number(monthsMatch[1]) : 0,
    message: base.textParts,
    id: `vk:renewal:${base.id}`,
  };
}

function parseVkSubscriberEvent(item = {}) {
  const base = parseVkChatBotMessage(item);
  if (!base || !/отслеживает канал|подпис/i.test(base.textParts)) {
    return null;
  }

  if (/продлил\s+подписку/i.test(base.textParts)) {
    return null;
  }

  return { platform: 'vk', username: base.username, message: base.textParts, id: `vk:sub:${base.id}` };
}

check('health endpoint', async () => {
  const { response, body } = await request('/health');
  if (!response.ok || !body?.ok) {
    throw new Error('health check failed');
  }
  if (!body.widgets?.music) {
    throw new Error('music widget missing in health payload');
  }
});

check('widget pages are served', async () => {
  const pages = ['/widgets/music.html', '/widgets/alerts.html', '/widgets/chat.html', '/widgets/goal.html', '/widgets/giveaway.html', '/widgets/tasks.html', '/widgets/stream.html'];
  for (const page of pages) {
    const { response, body } = await request(page, { method: 'GET', headers: {} });
    if (!response.ok || typeof body !== 'string' || !body.includes('<html')) {
      throw new Error(`page failed: ${page}`);
    }
  }
});

check('stream overlay state endpoint', async () => {
  const { response, body } = await request('/widgets/state', { method: 'GET', headers: {} });
  if (!response.ok || !Array.isArray(body.items) || !body.urls?.stream) {
    throw new Error('stream widget state missing');
  }
  if (!body.items.some((item) => item.id === 'builtin-music' && item.type === 'music') || !body.urls?.music) {
    throw new Error('music widget missing from stream widget state');
  }
  if (!body.items.some((item) => item.id === 'builtin-tasks' && item.type === 'tasks') || !body.urls?.tasks) {
    throw new Error('tasks widget missing from stream widget state');
  }
});

check('backoffice has music tab', async () => {
  const body = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (!body.includes('data-tab="music"') || !body.includes('id="musicSection"')) {
    throw new Error('music tab not found in backoffice');
  }
  if (!body.includes('data-widget-type="music"') || !body.includes('createMusicWidget')) {
    throw new Error('music widget controls not found in backoffice');
  }
});

check('stream overlay embeds music widget', async () => {
  const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
    request('/widgets/stream.html', { method: 'GET', headers: {} }),
    request('/widgets/stream.js', { method: 'GET', headers: {} }),
    request('/widgets/widget.css', { method: 'GET', headers: {} }),
  ]);

  if (!htmlResponse.response.ok || !htmlResponse.body.includes('streamEmbeddedWidgets')) {
    throw new Error('stream embedded widget container missing');
  }
  if (!scriptResponse.response.ok || !scriptResponse.body.includes('/widgets/music.html?embedded=1') || !scriptResponse.body.includes('stream-embedded-widget--')) {
    throw new Error('stream music iframe renderer missing');
  }
  if (!styleResponse.response.ok || !styleResponse.body.includes('stream-embedded-widget--music')) {
    throw new Error('stream embedded music styles missing');
  }
});

check('stream overlay renders task widget', async () => {
  const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
    request('/widgets/stream.html', { method: 'GET', headers: {} }),
    request('/widgets/stream.js', { method: 'GET', headers: {} }),
    request('/widgets/widget.css', { method: 'GET', headers: {} }),
  ]);

  if (!htmlResponse.response.ok || !htmlResponse.body.includes('streamTasks')) {
    throw new Error('stream task container missing');
  }
  if (!scriptResponse.response.ok || !scriptResponse.body.includes("item.type === 'tasks'") || !scriptResponse.body.includes('renderTaskBoardHtml')) {
    throw new Error('stream task renderer missing');
  }
  if (!styleResponse.response.ok || !styleResponse.body.includes('stream-task-panel')) {
    throw new Error('stream task styles missing');
  }
});

check('backoffice has chat direction setting', async () => {
  const body = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (!body.includes('id="chatDirectionSelect"') || !body.includes('value="bottom-up"') || !body.includes('value="top-down"')) {
    throw new Error('chat direction setting not found in backoffice');
  }
});

check('chat widget applies direction settings', async () => {
  const [scriptResponse, styleResponse] = await Promise.all([
    request('/widgets/chat.js', { method: 'GET', headers: {} }),
    request('/widgets/widget.css', { method: 'GET', headers: {} }),
  ]);

  if (!scriptResponse.response.ok || !scriptResponse.body.includes("socket.on('chat:ui-settings'")) {
    throw new Error('chat widget does not listen for ui settings');
  }
  if (!scriptResponse.body.includes("socket.on('chat:music-request'")) {
    throw new Error('chat widget music request listener missing');
  }
  if (!scriptResponse.body.includes("socket.on('chat:history'") || !scriptResponse.body.includes('isAndroidClient')) {
    throw new Error('Android chat history support missing');
  }

  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  if (!mainSource.includes("socket.emit('chat:history'")) {
    throw new Error('chat history is not sent to newly connected widgets');
  }

  if (!styleResponse.response.ok || !styleResponse.body.includes('widget-page--chat-top-down')) {
    throw new Error('chat direction styles missing');
  }
});

check('chat window uses stable nick colors', async () => {
  const body = fs.readFileSync(path.join(projectRoot, 'chat-window.html'), 'utf8');
  if (!body.includes('getNickColor') || !body.includes("message.color || getNickColor")) {
    throw new Error('nick color generator not found');
  }
  if (!body.includes('insertFeedEntry')) {
    throw new Error('chat window feed insert helper missing');
  }
  if (!body.includes('showMusicRequestInChat') || !body.includes('music-line')) {
    throw new Error('chat window music request line missing');
  }
  if (!body.includes('renderPinnedSubscriptionRenewal') || !body.includes('renewal-line')) {
    throw new Error('chat window subscription renewal line missing');
  }
});

check('music widget autostart helpers', async () => {
  const { response, body } = await request('/widgets/music.js', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes('finalizePlayback') || !body.includes('sendYouTubeCommand')) {
    throw new Error('music autostart helpers missing');
  }
  if (!body.includes('startRutubePlayback') || !body.includes('enableRutubeSound')) {
    throw new Error('rutube autostart helpers missing');
  }
  if (!body.includes('JSON.stringify(message)')) {
    throw new Error('rutube postMessage must be stringified');
  }
  if (!body.includes('startVkPlayback') || !body.includes("set('js_api', '1')")) {
    throw new Error('vk autostart helpers missing');
  }
  if (!body.includes("sendYouTubeCommand('unMute')") || !body.includes('enableYouTubeSound')) {
    throw new Error('music widget must unmute YouTube after load');
  }
  if (!body.includes('claimPlaybackLeadership') || !body.includes('canPlayAudio')) {
    throw new Error('music widget playback leader election missing');
  }
  if (!body.includes('initVkVideoPlayer') || !body.includes('scheduleYouTubeProgressPolling')) {
    throw new Error('music playback end detection helpers missing');
  }
});

check('music widget shows titles', async () => {
  const [htmlResponse, scriptResponse, styleResponse] = await Promise.all([
    request('/widgets/music.html', { method: 'GET', headers: {} }),
    request('/widgets/music.js', { method: 'GET', headers: {} }),
    request('/widgets/widget.css', { method: 'GET', headers: {} }),
  ]);

  if (!htmlResponse.response.ok || !htmlResponse.body.includes('musicQueueTitle')) {
    throw new Error('music queue title element missing');
  }

  if (!htmlResponse.body.includes('videoplayer.js')) {
    throw new Error('vk videoplayer sdk missing in music widget');
  }

  if (!scriptResponse.response.ok || !scriptResponse.body.includes('Сейчас играет:') || !scriptResponse.body.includes('В очереди #')) {
    throw new Error('music title rendering missing');
  }
  if (!scriptResponse.body.includes('syncWidgetVisibility')) {
    throw new Error('music widget empty-state visibility missing');
  }

  if (!styleResponse.response.ok || !styleResponse.body.includes('music-widget__queue-title')) {
    throw new Error('music queue title styles missing');
  }
});

check('music widget iframe allows fullscreen playback', async () => {
  const { response, body } = await request('/widgets/music.html', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes('allowfullscreen')) {
    throw new Error('music iframe fullscreen permission missing');
  }
});

check('alerts widget supports subscribers', async () => {
  const { response, body } = await request('/widgets/alerts.js', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes("item.kind === 'subscriber'") || !body.includes('speakSubscriber')) {
    throw new Error('subscriber alerts missing');
  }
  if (!body.includes("item.kind === 'subscriptionRenewal'") || !body.includes('speakSubscriptionRenewal')) {
    throw new Error('subscription renewal alerts missing');
  }
});

check('stream overlay bootstraps pending donation alerts', async () => {
  const { response, body } = await request('/widgets/stream.js', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes('bootstrapAlertQueue(state?.queue)') || !body.includes('enqueueAlertForPlayback')) {
    throw new Error('stream overlay does not replay pending alert queue');
  }
  if (body.includes("socket.emit('alert:played', { id: payload?.id })")) {
    throw new Error('disabled stream alerts still mark alerts as played');
  }
});

check('donation alerts stay visible and use edge tts', async () => {
  const { response, body } = await request('/widgets/alerts.js', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes('MIN_ALERT_DISPLAY_SECONDS = 15')) {
    throw new Error('stream alert minimum display time is not 15 seconds');
  }
  if (!body.includes('/tts/edge') || body.includes('speechSynthesis')) {
    throw new Error('stream alert edge tts missing');
  }
});

check('legacy donation widget queues tts alerts', async () => {
  const { response, body } = await request('/widgets/alert.js', { method: 'GET', headers: {} });
  if (!response.ok || !body.includes('MIN_DONATION_DISPLAY_MS = 15000')) {
    throw new Error('legacy donation alert minimum display time missing');
  }
  if (!body.includes('/tts/edge') || body.includes('speechSynthesis')) {
    throw new Error('legacy donation tts missing');
  }
});

check('demo subscriber alert', async () => {
  const { response, body } = await request('/demo/subscriber', {
    method: 'POST',
    headers: { 'X-TChat-Internal': '1' },
    body: JSON.stringify({ username: 'SmokeSub' }),
  });
  if (!response.ok || !body?.ok || body.item?.kind !== 'subscriber') {
    throw new Error('demo subscriber failed');
  }
});

check('first chat message does not trigger greeting alert', async () => {
  const username = `FirstSmoke${Date.now()}`;
  await request('/demo/chat', {
    method: 'POST',
    body: JSON.stringify({ platform: 'demo', user: username, text: 'hello' }),
  });
  await request('/demo/chat', {
    method: 'POST',
    body: JSON.stringify({ platform: 'demo', user: username, text: 'second hello' }),
  });

  const { response, body } = await request('/alerts/state', { method: 'GET', headers: {} });
  const greetings = (body.queue || []).filter((item) => item.kind === 'firstMessage' && item.firstMessage?.username === username);
  if (!response.ok || greetings.length !== 0) {
    throw new Error(`unexpected first message greetings: ${greetings.length}`);
  }
});

check('first message greeting alert stays disabled', async () => {
  const { response, body } = await request('/alerts/state', { method: 'GET', headers: {} });
  if (!response.ok || body.settings?.systemAlerts?.firstMessage?.enabled !== false) {
    throw new Error('first message alert should stay disabled');
  }
});

check('poll widget accepts one immutable vote per user', async () => {
  const started = await request('/remote/poll/start', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Smoke poll',
      durationSeconds: 60,
      options: ['One', 'Two', 'Three'],
    }),
  });
  if (!started.response.ok || !started.body?.poll || started.body.poll.visible !== true) {
    throw new Error('poll did not start visible');
  }

  await request('/demo/chat', {
    method: 'POST',
    body: JSON.stringify({ platform: 'demo', user: 'PollUserA', text: '1' }),
  });
  await request('/demo/chat', {
    method: 'POST',
    body: JSON.stringify({ platform: 'demo', user: 'PollUserA', text: '2' }),
  });
  await request('/demo/chat', {
    method: 'POST',
    body: JSON.stringify({ platform: 'demo', user: 'PollUserB', text: '2' }),
  });

  const state = await request('/widgets/state', { method: 'GET', headers: {} });
  const poll = state.body?.poll;
  if (!state.response.ok || !poll) {
    throw new Error('poll missing from widgets state');
  }

  const votes = poll.options.map((option) => Number(option.votes || 0));
  if (votes[0] !== 1 || votes[1] !== 1 || votes[2] !== 0) {
    throw new Error(`poll votes are not immutable per user: ${votes.join(',')}`);
  }

  const hidden = await request('/remote/poll/hide', { method: 'POST' });
  if (hidden.body?.poll?.visible !== false) {
    throw new Error('poll hide did not preserve hidden poll state');
  }

  const shown = await request('/remote/poll/show', { method: 'POST' });
  if (shown.body?.poll?.visible !== true) {
    throw new Error('poll show did not restore visible poll state');
  }

  const finished = await request('/remote/poll/finish', { method: 'POST' });
  if (finished.body?.poll?.status !== 'finished') {
    throw new Error('poll did not finish early');
  }

  await request('/remote/poll/clear', { method: 'POST' });
});

check('demo music enqueue', async () => {
  const { response, body } = await request('/demo/music', {
    method: 'POST',
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=rXA-9mWGCXk',
      username: 'Smoke test',
    }),
  });

  if (!response.ok || !body?.ok) {
    throw new Error(`demo music failed: ${body?.error || response.status}`);
  }

  const readyItems = (body.queue?.queue || []).filter((item) => ['ready', 'playing'].includes(item.status) && item.embedUrl);
  if (!readyItems.length) {
    throw new Error('demo music did not produce ready item');
  }
});

check('music does not reject unknown view counts', () => {
  const body = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  // Суть проверки: если просмотры не подтвердились, заявка всё равно проходит.
  // Сверяемся не с точной строкой целиком — перед условием могут появляться
  // новые флаги вроде skipViewsCheck, и тест не должен от этого падать.
  const allowLine = body.match(/const isAllowed = [^\n;]+/);
  if (!allowLine || !allowLine[0].includes('!hasVerifiedViews ||')) {
    throw new Error(`unknown music view counts are still rejected: ${allowLine?.[0] || 'условие не найдено'}`);
  }
  if (!/viewsVerified:/.test(body)) {
    throw new Error('missing unknown view count marker');
  }
});

check('music builds rutube and vk embed fallbacks', () => {
  const body = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  if (!body.includes('function createMusicMetadataFallback') || !body.includes('function buildMusicEmbedUrl')) {
    throw new Error('music metadata fallback missing');
  }
  if (!body.includes('https://rutube.ru/play/embed/') || !body.includes('https://vk.com/video_ext.php')) {
    throw new Error('rutube or vk embed fallback missing');
  }
  if (!body.includes('autoplay=true&autostartmute=false')) {
    throw new Error('rutube embed autoplay params missing');
  }
  if (!body.includes('js_api=1&muted=1')) {
    throw new Error('vk embed js_api params missing');
  }
  if (!body.includes('function extractTitleFromHtml') || !body.includes('function formatFallbackMusicTitle')) {
    throw new Error('music title fallback missing');
  }
  if (!body.includes('broadcastMusicChatRequest')) {
    throw new Error('music chat request broadcast missing');
  }
  if (!body.includes('function extractYouTubeDuration') || !body.includes('function extractVkDuration')) {
    throw new Error('music duration extraction missing');
  }
  if (!body.includes('duration: extractYouTubeDuration(html)') || !body.includes('duration: extractVkDuration(html)')) {
    throw new Error('music metadata duration field missing');
  }
});

check('backoffice exposes giveaway in the active widget toolbar', async () => {
  const body = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    !body.includes('id="quickCreateGiveawayButton"') ||
    !body.includes("addEventListener('click', createGiveawayWidget)")
  ) {
    throw new Error('giveaway quick-create control missing');
  }
});

check('giveaway widget has live state, reveal animation and sound', async () => {
  const [scriptResponse, styleResponse, streamResponse] = await Promise.all([
    request('/widgets/giveaway.js', { method: 'GET', headers: {} }),
    request('/widgets/giveaway.css', { method: 'GET', headers: {} }),
    request('/widgets/stream.js', { method: 'GET', headers: {} }),
  ]);
  if (
    !scriptResponse.response.ok ||
    !scriptResponse.body.includes("socket.on('widgets:state'") ||
    !scriptResponse.body.includes('playFanfare') ||
    !scriptResponse.body.includes('Ник: ваш_ник') ||
    !scriptResponse.body.includes('Ник ваш_ник') ||
    !scriptResponse.body.includes('Обычные сообщения не учитываются')
  ) {
    throw new Error('giveaway live reveal script missing');
  }
  if (!styleResponse.response.ok || !styleResponse.body.includes('@keyframes confetti-fall')) {
    throw new Error('giveaway animation missing');
  }
  if (
    !styleResponse.body.includes('zoom: 0.7') ||
    !styleResponse.body.includes('background-color: rgb(0 0 0 / 0%)')
  ) {
    throw new Error('giveaway scaling or transparent canvas missing');
  }
  if (!streamResponse.response.ok || !streamResponse.body.includes('/widgets/giveaway.html?embedded=1')) {
    throw new Error('giveaway is not embedded in stream overlay');
  }
});

check('giveaway prize settings update from backoffice', async () => {
  const body = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    !body.includes('data-giveaway-save') ||
    !body.includes('data-giveaway-field="collectNicknames"') ||
    !body.includes("event.target.matches('[data-giveaway-field]')") ||
    !body.includes('saveGiveawayFromWorkspace')
  ) {
    throw new Error('giveaway prize update controls missing');
  }
});

check('giveaway auto-hides and grows for all participants', async () => {
  const [scriptResponse, cssResponse, streamResponse] = await Promise.all([
    request('/widgets/giveaway.js', { method: 'GET', headers: {} }),
    request('/widgets/giveaway.css', { method: 'GET', headers: {} }),
    request('/widgets/stream.js', { method: 'GET', headers: {} }),
  ]);
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const backofficeBody = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    !scriptResponse.response.ok ||
    !scriptResponse.body.includes("type: 'tchat:giveaway-size'") ||
    scriptResponse.body.includes('.slice(-60)') ||
    !cssResponse.response.ok ||
    !cssResponse.body.includes('.giveaway__participants') ||
    cssResponse.body.includes('max-height: 150px') ||
    !streamResponse.response.ok ||
    !streamResponse.body.includes("event.data?.type !== 'tchat:giveaway-size'") ||
    !mainBody.includes('const GIVEAWAY_AUTO_HIDE_MS = 5 * 60 * 1000') ||
    !mainBody.includes('scheduleGiveawayHide(next)') ||
    !backofficeBody.includes('class="preview-giveaway-frame"')
  ) {
    throw new Error('giveaway auto-hide, full participant list or dynamic preview height missing');
  }
});

check('giveaway nicknames require an explicit command and persist in profiles', async () => {
  const { parseNicknameCommand } = require(path.join(projectRoot, 'src', 'giveawayNicknames'));
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const profilesBody = fs.readFileSync(path.join(projectRoot, 'src', 'profiles.js'), 'utf8');
  const backofficeBody = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    parseNicknameCommand('Ник: [Impich]') !== 'Impich' ||
    parseNicknameCommand('ник sea_gek') !== 'sea_gek' ||
    parseNicknameCommand('это ты кому?') !== '' ||
    !mainBody.includes('profiles.setNicknameForUser') ||
    mainBody.includes('!winner || widget.winnerNicknames?.[winner.key]') ||
    !profilesBody.includes('nickname: String(profile.nickname') ||
    !backofficeBody.includes('id="pe-nickname"') ||
    !backofficeBody.includes('data-giveaway-reset-all')
  ) {
    throw new Error('strict giveaway nickname/profile/reset integration missing');
  }
});

check('nickname commands update profiles outside giveaways', () => {
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const handler = mainBody.slice(
    mainBody.indexOf('function registerGiveawayWinnerNickname'),
    mainBody.indexOf('// В старой версии', mainBody.indexOf('function registerGiveawayWinnerNickname')),
  );
  if (
    !handler.includes('profiles.setNicknameForUser') ||
    handler.includes('if (!captured.length) return') ||
    !handler.includes('if (captured.length)')
  ) {
    throw new Error('nickname command is still limited to an active finished giveaway');
  }
});

check('updates support regular and critical policy', () => {
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const backofficeBody = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    !mainBody.includes('async function resolveUpdatePolicy') ||
    !mainBody.includes("updateType: critical ? 'critical' : 'regular'") ||
    !backofficeBody.includes('id="updateLaterButton"') ||
    !backofficeBody.includes("updateModal.dataset.critical === 'true'") ||
    !backofficeBody.includes('Без этого обновления продолжить работу нельзя')
  ) {
    throw new Error('regular/critical updater policy missing');
  }
});

check('profiles support full rebuild and incremental extension', () => {
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const preloadBody = fs.readFileSync(path.join(projectRoot, 'src', 'preload.js'), 'utf8');
  const backofficeBody = fs.readFileSync(path.join(projectRoot, 'backoffice.html'), 'utf8');
  if (
    !backofficeBody.includes('id="pe-rebuild"') ||
    !backofficeBody.includes('id="pe-extend"') ||
    !backofficeBody.includes("analyzeProfile(p.id, 'rebuild')") ||
    !backofficeBody.includes("analyzeProfile(p.id, 'extend')") ||
    !preloadBody.includes('{ id, mode }') ||
    !mainBody.includes("payload?.mode === 'rebuild'") ||
    !mainBody.includes("PROFILE_REBUILD_POLZA_MODEL = 'anthropic/claude-sonnet-4.6'") ||
    !mainBody.includes('polzaOnly: rebuild') ||
    !mainBody.includes('PROFILE_GAME_NAMING_RULE') ||
    !mainBody.includes('Не называй её World of Warships') ||
    !mainBody.includes('Текущее саммари профиля') ||
    !mainBody.includes('const shown = fresh.map')
  ) {
    throw new Error('profile rebuild/extend modes missing');
  }
});

check('profiles merge platform accounts by game nickname', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-profile-merge-'));
  try {
    const profileStore = require(path.join(projectRoot, 'src', 'profiles'));
    profileStore.init(dir);
    profileStore.setNicknameForUser({ platform: 'twitch', user: 'sea_gek', nickname: 'sea_gek' });
    profileStore.setNicknameForUser({ platform: 'vk', user: 'sea_gek_vk', nickname: 'sea_gek' });
    const items = profileStore.list();
    const twitch = profileStore.findByUser('twitch', 'sea_gek');
    const vk = profileStore.findByUser('vk', 'sea_gek_vk');
    if (
      items.length !== 1 ||
      items[0].accounts.length !== 2 ||
      twitch?.id !== vk?.id ||
      !profileStore.accountKeys().includes('twitch:sea_gek') ||
      !profileStore.accountKeys().includes('vk:sea_gek_vk')
    ) {
      throw new Error('same game nickname did not merge platform accounts');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('legacy Android chat URL redirects to the chat widget', async () => {
  const paths = ['/widget/chat', '/widget/chat/widgets/chat.html', '/widgets/chat'];
  for (const path of paths) {
    const { response } = await request(path, { method: 'GET', headers: {}, redirect: 'manual' });
    if (response.status !== 302 || response.headers.get('location') !== '/widgets/chat.html') {
      throw new Error(`unexpected ${path} response: ${response.status} ${response.headers.get('location') || ''}`);
    }
  }
});

check('music survives OBS source handoff', () => {
  const musicBody = fs.readFileSync(path.join(projectRoot, 'widgets', 'music.js'), 'utf8');
  const streamBody = fs.readFileSync(path.join(projectRoot, 'widgets', 'stream.js'), 'utf8');

  if (musicBody.includes("socket.emit('music:bootstrap'")) {
    throw new Error('music widget still removes a playing track while bootstrapping');
  }
  if (!musicBody.includes("['ready', 'playing'].includes(item.status)")) {
    throw new Error('a refreshed OBS source cannot resume the playing track');
  }
  if (!streamBody.includes('obsSourceVisibleChanged') || !streamBody.includes('obsSourceActiveChanged')) {
    throw new Error('embedded music does not follow OBS source visibility');
  }
  if (!streamBody.includes("type: 'tchat:obs-playback'")) {
    throw new Error('OBS source state is not forwarded to the embedded music player');
  }
});

check('music uses the title reported by the OBS player', () => {
  const mainBody = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const musicBody = fs.readFileSync(path.join(projectRoot, 'widgets', 'music.js'), 'utf8');
  const proxyBody = fs.readFileSync(path.join(projectRoot, 'src', 'net', 'ytProxy.js'), 'utf8');

  if (!musicBody.includes('data.info.videoData?.title') || !musicBody.includes("socket.emit('music:title'")) {
    throw new Error('music widget ignores the title reported by the embedded player');
  }
  if (!mainBody.includes("socket.on('music:title'") || !mainBody.includes('function updateMusicTitle')) {
    throw new Error('player-reported music titles are not saved in the shared queue');
  }
  if (!proxyBody.includes('canFallbackDirect') || !proxyBody.includes('return origFetch(input, init)')) {
    throw new Error('YouTube metadata has no direct fallback when the local proxy is offline');
  }
});

check('music state after enqueue', async () => {
  const { response, body } = await request('/music/state', { method: 'GET', headers: {} });
  if (!response.ok) {
    throw new Error('music state unavailable');
  }

  const readyItems = (body.queue || []).filter((item) => ['ready', 'playing'].includes(item.status) && item.embedUrl);
  if (!readyItems.length) {
    throw new Error('music queue has no playable items');
  }
});

check('vk subscriber parser', () => {
  const sample = {
    id: 123,
    author: { displayName: 'ChatBot' },
    data: [
      { type: 'mention', displayName: 'ViewerOne' },
      { type: 'text', content: '["теперь отслеживает канал","unstyled",[]]' },
    ],
  };

  const parsed = parseVkSubscriberEvent(sample);
  if (!parsed || parsed.username !== 'ViewerOne') {
    throw new Error('vk subscriber parser failed');
  }

  const renewalSample = {
    id: 456,
    author: { displayName: 'ChatBot' },
    data: [
      { type: 'mention', displayName: 'борисbl4' },
      { type: 'text', content: '["продлил подписку \'Матрос\'. Подписан уже 2 месяцев.","unstyled",[]]' },
    ],
  };

  const renewal = parseVkSubscriptionRenewalEvent(renewalSample);
  if (!renewal || renewal.username !== 'борисbl4' || renewal.tier !== 'Матрос' || renewal.months !== 2) {
    throw new Error('vk subscription renewal parser failed');
  }

  if (parseVkSubscriberEvent(renewalSample)) {
    throw new Error('vk renewal must not trigger subscriber alert');
  }
});

check('VK polling reads the newest chat page', () => {
  const body = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  if (!body.includes('`${VK_API_BASE}${streamPath}/chat?limit=30`')) {
    throw new Error('VK chat polling does not request the newest page');
  }
  if (body.includes('`?limit=30&from_id=${vkConnectionState.lastChatMessageId}`')) {
    throw new Error('VK chat polling still paginates backwards with from_id');
  }
});

check('demo music cleanup', async () => {
  const { response, body } = await request('/demo/music/reset', {
    method: 'POST',
  });

  if (!response.ok || !body?.ok) {
    throw new Error('demo music reset failed');
  }
});

async function run() {
  console.log(`Smoke tests against ${baseUrl}`);
  let failed = 0;

  for (const item of checks) {
    try {
      await item.fn();
      console.log(`PASS  ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${item.name}: ${error.message}`);
    }
  }

  console.log(`\nResult: ${checks.length - failed}/${checks.length} passed`);
  if (failed) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`Smoke tests crashed: ${error.message}`);
  process.exitCode = 1;
});
