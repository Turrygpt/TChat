'use strict';

// Рассылка анонса стрима в Telegram и MAX (макс).
// Модуль самодостаточный: работает на глобальных fetch/FormData/Blob (Node 18+),
// Electron main-процесс их предоставляет. Все настройки приходят параметром.

const VK_API_BASE = 'https://api.live.vkvideo.ru/v1';
const MAX_API_BASE = 'https://botapi.max.ru';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HTTP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

// Ссылки на каналы — данные пользователя, а не настройки программы: пустые по
// умолчанию, иначе после чистой установки они возвращались бы из кода.
// Адрес и модель Ollama оставляем: это технические значения, одинаковые у всех.
const DEFAULT_CHANNEL_URL = '';
const DEFAULT_TWITCH_URL = '';
const DEFAULT_MAX_CHANNEL_URL = '';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b';

function createDefaultSettings() {
  return {
    telegram: { token: '', chatId: '' },
    max: { token: '', chatId: '', channelUrl: DEFAULT_MAX_CHANNEL_URL },
    anthropic: { apiKey: '' },
    polza: { apiKey: '', model: 'anthropic/claude-opus-4.8' },
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, model: DEFAULT_OLLAMA_MODEL },
    channelUrl: DEFAULT_CHANNEL_URL,
    twitchUrl: DEFAULT_TWITCH_URL,
  };
}

function normalizeSettings(raw) {
  const base = createDefaultSettings();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  return {
    telegram: {
      token: String(raw.telegram?.token || '').trim(),
      chatId: String(raw.telegram?.chatId || '').trim(),
    },
    max: {
      token: String(raw.max?.token || '').trim(),
      chatId: String(raw.max?.chatId || '').trim(),
      channelUrl: String(raw.max?.channelUrl || '').trim() || base.max.channelUrl,
    },
    anthropic: {
      apiKey: String(raw.anthropic?.apiKey || '').trim(),
    },
    polza: {
      apiKey: String(raw.polza?.apiKey || '').trim(),
      model: String(raw.polza?.model || '').trim() || base.polza.model,
    },
    ollama: {
      baseUrl: String(raw.ollama?.baseUrl || '').trim() || base.ollama.baseUrl,
      model: String(raw.ollama?.model || '').trim() || base.ollama.model,
    },
    channelUrl: String(raw.channelUrl || '').trim() || DEFAULT_CHANNEL_URL,
    twitchUrl: String(raw.twitchUrl || '').trim() || base.twitchUrl,
  };
}

// --- HTML-разметка (общая для Telegram parse_mode=HTML и MAX format=html) ----

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// «Человеческие» кликабельные ссылки на площадки вида «Смотри на Twitch».
function buildLinksBlock(settings) {
  const links = [
    { url: settings.channelUrl, label: 'VK Видео Лайв' },
    { url: settings.twitchUrl, label: 'Twitch' },
    { url: settings.max.channelUrl, label: 'MAX' },
  ].filter((item) => item.url);

  return links
    .map((item) => `Смотри на <a href="${escapeHtmlAttr(item.url)}">${escapeHtml(item.label)}</a>`)
    .join('\n');
}

// Обрезает текст под лимит длины, не разрывая незакрытый <a>-тег.
function truncateHtmlSafe(text, limit) {
  if (text.length <= limit) return text;
  let truncated = text.slice(0, limit);
  const lastOpen = truncated.lastIndexOf('<a ');
  const lastClose = truncated.lastIndexOf('</a>');
  if (lastOpen > lastClose) {
    truncated = truncated.slice(0, lastOpen);
  }
  return truncated.trim();
}

// --- сетевые хелперы --------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const response = await fetchWithTimeout(
    url,
    { ...options, headers: { ...HTTP_HEADERS, Accept: 'application/json', ...(options.headers || {}) } },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function parseChannelSlug(channelUrl = '') {
  const raw = String(channelUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    const match = raw.match(/live\.vkvideo\.ru\/([^/?#]+)/i);
    return (match?.[1] || raw.replace(/^\/+|\/+$/g, '')).trim();
  }
}

// --- VK: получить игру/заголовок/картинку -----------------------------------

async function fetchStreamInfo(channelUrl) {
  const slug = parseChannelSlug(channelUrl);
  if (!slug) {
    throw new Error('не удалось определить канал VK из ссылки');
  }

  const url = `${VK_API_BASE}/blog/${encodeURIComponent(slug)}/public_video_stream`;
  const payload = await fetchJson(url, {}, 15000);
  const stream =
    payload && payload.data && typeof payload.data === 'object' && !payload.title
      ? payload.data
      : payload || {};

  const title = String(stream.title || '').trim();
  const game = String(stream.category?.title || '').trim();
  const vkImageUrl = String(stream.category?.coverUrl || stream.previewUrl || '').trim();
  const isOnline = stream.isEnded === false || stream.isOnline === true;

  return { slug, title, game, vkImageUrl, isOnline };
}

// --- поиск картинки в интернете по названию игры -----------------------------

async function steamImageUrl(game) {
  try {
    const data = await fetchJson(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(game)}&cc=ru&l=russian`,
      {},
      8000,
    );
    const item = Array.isArray(data?.items) ? data.items[0] : null;
    if (item?.id) {
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/header.jpg`;
    }
    if (item?.tiny_image) return item.tiny_image;
  } catch {
    /* игнорируем — пробуем следующий источник */
  }
  return '';
}

async function wikipediaImageUrl(game) {
  for (const lang of ['ru', 'en']) {
    try {
      const data = await fetchJson(
        `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&pithumbsize=1000&redirects=1&titles=${encodeURIComponent(
          game,
        )}`,
        {},
        8000,
      );
      const pages = data?.query?.pages || {};
      for (const key of Object.keys(pages)) {
        const source = pages[key]?.thumbnail?.source;
        if (source) return source;
      }
    } catch {
      /* следующий язык / источник */
    }
  }
  return '';
}

// Возвращает упорядоченный список URL-кандидатов картинки.
async function collectImageCandidates(game, vkImageUrl) {
  const candidates = [];
  if (game) {
    const steam = await steamImageUrl(game);
    if (steam) candidates.push(steam);
    const wiki = await wikipediaImageUrl(game);
    if (wiki) candidates.push(wiki);
  }
  if (vkImageUrl) candidates.push(vkImageUrl); // фолбэк из VK
  return candidates;
}

async function downloadImage(url) {
  const response = await fetchWithTimeout(url, { headers: HTTP_HEADERS }, 15000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(contentType)) throw new Error(`не картинка (${contentType})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 512) throw new Error('пустая картинка');
  return { buffer, contentType };
}

async function downloadFirstImage(candidates) {
  for (const url of candidates) {
    try {
      const image = await downloadImage(url);
      return { ...image, sourceUrl: url };
    } catch {
      /* пробуем следующего кандидата */
    }
  }
  return null;
}

// --- текст поста ------------------------------------------------------------

function templatePostText(game, title) {
  const lines = ['🔴 Стрим начался!'];
  if (game) {
    lines.push('', `Сегодня играем в «${game}».`);
  }
  if (title) {
    lines.push(title);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildPostPrompt(game, title) {
  return (
    `Ты — SMM-помощник стримера. Напиши короткий бодрый анонс начала стрима для Telegram и мессенджера MAX на русском языке.\n` +
    `Игра: ${game || 'не указана'}\n` +
    `Заголовок стрима: ${title || 'не указан'}\n\n` +
    `Требования: 2–3 предложения, живой разговорный тон, 1–2 уместных эмодзи, обязательно упомяни игру (если указана) и позови зрителей. ` +
    `Ссылки на площадки добавляются отдельно после текста — сам их не пиши. Без хэштегов, без markdown/html-разметки, верни только текст анонса. ` +
    `Используй только настоящие эмодзи-символы. Никогда не пиши текстовые обозначения эмодзи вроде ":tractor:" или "tractor:" — если не уверен, что вставится реальный символ, просто не используй эмодзи в этом месте.`
  );
}

// polza.ai — OpenAI-совместимый агрегатор моделей (в т.ч. anthropic/claude-*).
async function generateWithPolza({ game, title, apiKey, model }) {
  const data = await postJson('https://polza.ai/api/v1/chat/completions', {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'anthropic/claude-opus-4.8',
      max_tokens: 400,
      messages: [{ role: 'user', content: buildPostPrompt(game, title) }],
    }),
  });

  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('polza.ai вернул пустой ответ');
  return text;
}

// Локальная Ollama — резервный вариант, если polza.ai недоступен. OpenAI-совместимый эндпоинт,
// без ключа. Модель может быть не загружена в VRAM — даём увеличенный таймаут на холодный старт.
async function generateWithOllama({ game, title, baseUrl, model }) {
  const data = await postJson(
    `${baseUrl || DEFAULT_OLLAMA_BASE_URL}/v1/chat/completions`,
    {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || DEFAULT_OLLAMA_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPostPrompt(game, title) }],
      }),
    },
    60000,
  );

  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Ollama вернул пустой ответ');
  return text;
}

async function generateWithAnthropic({ game, title, apiKey }) {
  const AnthropicSDK = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicSDK.default || AnthropicSDK;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 400,
    messages: [{ role: 'user', content: buildPostPrompt(game, title) }],
  });

  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic вернул пустой ответ');
  return text;
}

// Цепочка источников текста: polza.ai (основной) → локальная Ollama (резерв) →
// Anthropic напрямую (если задан ключ) → статичный шаблон, если всё недоступно.
async function generatePostText({ game, title, apiKey, polzaApiKey, polzaModel, ollamaBaseUrl, ollamaModel }) {
  const fallbackText = templatePostText(game, title);
  const params = { game, title };
  const attempts = [];

  if (polzaApiKey) {
    attempts.push(['polza.ai', () => generateWithPolza({ ...params, apiKey: polzaApiKey, model: polzaModel })]);
  }
  attempts.push(['ollama', () => generateWithOllama({ ...params, baseUrl: ollamaBaseUrl, model: ollamaModel })]);
  if (apiKey) {
    attempts.push(['anthropic', () => generateWithAnthropic({ ...params, apiKey })]);
  }

  let lastError = null;
  for (const [, attempt] of attempts) {
    try {
      const text = await attempt();
      return { text, source: 'ai' };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    text: fallbackText,
    source: 'template',
    error: lastError ? lastError.message || String(lastError) : null,
  };
}

// --- отправка ---------------------------------------------------------------

async function sendTelegram({ token, chatId, text, image }) {
  if (!token || !chatId) {
    return { ok: false, skipped: true, error: 'не заданы токен или chat_id Telegram' };
  }

  try {
    if (image?.buffer) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', truncateHtmlSafe(text, 1024));
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([image.buffer], { type: image.contentType }), 'stream.jpg');
      const data = await postJson(`${TELEGRAM_API_BASE}/bot${token}/sendPhoto`, { body: form });
      if (!data.ok) throw new Error(data.description || 'Telegram отклонил sendPhoto');
      return { ok: true };
    }

    const data = await postJson(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: truncateHtmlSafe(text, 4096), parse_mode: 'HTML' }),
    });
    if (!data.ok) throw new Error(data.description || 'Telegram отклонил sendMessage');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// Возвращает payload для attachment: MAX для картинок отдаёт либо плоский
// { token }, либо { photos: { "<id>": { token } } } — поддерживаем обе формы.
async function uploadMaxImage(token, image) {
  const init = await postJson(`${MAX_API_BASE}/uploads?type=image`, {
    headers: { Authorization: token },
  });
  const uploadUrl = init?.url;
  if (!uploadUrl) throw new Error('MAX не вернул URL загрузки');

  const form = new FormData();
  form.append('data', new Blob([image.buffer], { type: image.contentType }), 'stream.jpg');
  const uploaded = await postJson(uploadUrl, { body: form });

  if (uploaded && uploaded.photos && typeof uploaded.photos === 'object') {
    return { photos: uploaded.photos };
  }
  const photoToken = uploaded?.token || init?.token;
  if (!photoToken) throw new Error('MAX не вернул токен картинки');
  return { token: photoToken };
}

async function sendMax({ token, chatId, text, image }) {
  if (!token || !chatId) {
    return { ok: false, skipped: true, error: 'не заданы токен или chat_id MAX' };
  }

  const attachments = [];
  try {
    if (image?.buffer) {
      try {
        const payload = await uploadMaxImage(token, image);
        attachments.push({ type: 'image', payload });
      } catch (uploadError) {
        // Фолбэк: прикрепить по прямой ссылке, если загрузка не удалась.
        if (image.sourceUrl) {
          attachments.push({ type: 'image', payload: { url: image.sourceUrl } });
        } else {
          throw uploadError;
        }
      }
    }

    const body = { text, format: 'html' };
    if (attachments.length) body.attachments = attachments;

    const data = await postJson(`${MAX_API_BASE}/messages?chat_id=${encodeURIComponent(chatId)}`, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (data?.message || data?.recipient || data?.body || data?.timestamp) {
      return { ok: true };
    }
    if (data?.code || data?.error) {
      throw new Error(data.message || data.error || data.code);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function postJson(url, options = {}, timeoutMs = 20000) {
  const response = await fetchWithTimeout(url, { method: 'POST', ...options }, timeoutMs);
  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (/json/i.test(contentType)) {
    data = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const message = data?.description || data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data || {};
}

// --- сборка предпросмотра и рассылка ----------------------------------------

async function buildAnnouncement(rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const info = await fetchStreamInfo(settings.channelUrl);
  const streamUrl = settings.channelUrl;

  const [{ text: bodyText, source, error: textError }, image] = await Promise.all([
    generatePostText({
      game: info.game,
      title: info.title,
      apiKey: settings.anthropic.apiKey,
      polzaApiKey: settings.polza.apiKey,
      polzaModel: settings.polza.model,
      ollamaBaseUrl: settings.ollama.baseUrl,
      ollamaModel: settings.ollama.model,
    }),
    collectImageCandidates(info.game, info.vkImageUrl).then(downloadFirstImage),
  ]);

  const linksBlock = buildLinksBlock(settings);
  const text = [escapeHtml(bodyText), linksBlock].filter(Boolean).join('\n\n');

  return {
    ok: true,
    game: info.game,
    title: info.title,
    isOnline: info.isOnline,
    streamUrl,
    text,
    textSource: source,
    textError: textError || null,
    image: image
      ? {
          b64: image.buffer.toString('base64'),
          contentType: image.contentType,
          sourceUrl: image.sourceUrl,
        }
      : null,
    targets: {
      telegram: Boolean(settings.telegram.token && settings.telegram.chatId),
      max: Boolean(settings.max.token && settings.max.chatId),
    },
  };
}

async function sendAnnouncement(rawSettings, prepared = {}) {
  const settings = normalizeSettings(rawSettings);
  const text = String(prepared.text || '').trim();
  if (!text) {
    return { ok: false, error: 'пустой текст поста' };
  }

  const image =
    prepared.image && prepared.image.b64
      ? {
          buffer: Buffer.from(prepared.image.b64, 'base64'),
          contentType: prepared.image.contentType || 'image/jpeg',
          sourceUrl: prepared.image.sourceUrl || '',
        }
      : null;

  const [telegram, max] = await Promise.all([
    sendTelegram({ ...settings.telegram, text, image }),
    sendMax({ ...settings.max, text, image }),
  ]);

  return { ok: telegram.ok || max.ok, telegram, max };
}

module.exports = {
  createDefaultSettings,
  normalizeSettings,
  fetchStreamInfo,
  buildAnnouncement,
  sendAnnouncement,
};
