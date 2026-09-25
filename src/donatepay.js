'use strict';

// Подключение DonatePay.
//
// Донаты приходят двумя путями сразу, и это намеренно:
//   1) веб-сокет Centrifugo — мгновенно, ради алертов в эфире;
//   2) опрос /transactions раз в минуту — подстраховка, если сокет отвалился
//      или мы прозевали событие: донат всё равно доедет, просто не мгновенно.
// Дубли отсекаются по id транзакции, так что один донат не сыграет дважды.
//
// Ключ API живёт в userData/settings/donatepay.json — рядом с остальными
// токенами, в репозиторий не попадает.

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const API_BASE = 'https://donatepay.ru/api';
const SOCKET_URL = 'wss://centrifugo.donatepay.ru:443/connection/websocket';
// Команды протокола v1 Centrifugo — числами, не строками.
const CMD = { connect: 0, subscribe: 1, ping: 7 };
const POLL_INTERVAL = 60000;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 60000;
// Сколько id обработанных донатов помним, чтобы не проигрывать их повторно.
const SEEN_LIMIT = 500;

let configFile = '';
let config = { apiKey: '', enabled: false };
let socket = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;
let commandId = 0;
let stopped = true;

let user = null; // { id, name }
let connected = false;
let lastError = '';
let lastEventAt = 0;
const seen = new Set();
const seenOrder = [];
let primed = false;

let onDonation = () => {};
let onStatus = () => {};

function remember(id) {
  const key = String(id);
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  seenOrder.push(key);
  if (seenOrder.length > SEEN_LIMIT) {
    seen.delete(seenOrder.shift());
  }
  return true;
}

function load(storageDir) {
  configFile = path.join(storageDir, 'donatepay.json');
  if (!fs.existsSync(configFile)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config = { apiKey: String(raw.apiKey || ''), enabled: Boolean(raw.enabled) };
  } catch (error) {
    console.error(`[donatepay] не удалось прочитать настройки: ${error.message}`);
  }
}

function save() {
  if (!configFile) {
    return;
  }
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`[donatepay] не удалось сохранить настройки: ${error.message}`);
  }
}

function getState() {
  return {
    enabled: config.enabled,
    // Сам ключ наружу не отдаём — интерфейсу хватает признака, что он задан.
    hasKey: Boolean(config.apiKey),
    connected,
    user: user ? { id: user.id, name: user.name } : null,
    lastEventAt,
    error: lastError,
  };
}

function emitStatus() {
  try {
    onStatus(getState());
  } catch {
    /* слушатель не критичен */
  }
}

function setError(message) {
  lastError = String(message || '');
  emitStatus();
}

// --- REST -------------------------------------------------------------------

// DonatePay бьёт по рукам за частые запросы (429), поэтому все обращения идут
// друг за другом с паузой, а на 429 ждём и повторяем. Иначе включение
// подключения само себя роняло: проверка ключа и старт шли подряд.
// У DonatePay лимит на последовательные API-вызовы; короткая пауза приводила
// к 429 сразу после проверки пользователя и мешала получить токен сокета.
const MIN_REQUEST_GAP = 21000;
let lastRequestAt = 0;
let requestChain = Promise.resolve();

function schedule(task) {
  const run = requestChain.then(async () => {
    const wait = Math.max(0, MIN_REQUEST_GAP - (Date.now() - lastRequestAt));
    if (wait) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  // Цепочку не рвём ошибкой одного запроса.
  requestChain = run.catch(() => {});
  return run;
}

async function apiGet(method, params = {}, attempt = 0, apiKey = config.apiKey) {
  const query = new URLSearchParams({ access_token: apiKey, ...params });
  const response = await schedule(() =>
    fetch(`${API_BASE}/v1/${method}?${query}`, { signal: AbortSignal.timeout(15000) }),
  );
  if (response.status === 429) {
    if (attempt >= 2) {
      throw new Error('сервис просит не частить (429)');
    }
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 || MIN_REQUEST_GAP * (attempt + 1)));
    return apiGet(method, params, attempt + 1, apiKey);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data?.status === 'error' || data?.error) {
    throw new Error(data.message || data.error || 'ошибка DonatePay');
  }
  return data;
}

// Кто мы — нужен id, из него собирается имя канала Centrifugo ($public:<id>).
// Результат кешируется: id не меняется, а лишний запрос стоит нам 429.
async function fetchUser(apiKey = config.apiKey) {
  if (apiKey === config.apiKey && user?.id) {
    return user;
  }
  const data = await apiGet('user', {}, 0, apiKey);
  const info = data?.data?.user || data?.data || data?.user || data;
  const id = info?.id ?? info?.user_id;
  if (!id) {
    throw new Error('DonatePay не вернул id пользователя');
  }
  return { id: String(id), name: String(info.name || info.login || '') };
}

// Токены Centrifugo выдаёт один и тот же эндпоинт, но в два захода:
//   без client — токен подключения;
//   с client и списком каналов — токен подписки на приватный $public:<id>.
// Просить токен подписки до подключения бессмысленно: сервер отдаёт HTML.
async function fetchSocketToken(body, attempt = 0) {
  const response = await schedule(() =>
    fetch(`${API_BASE}/v2/socket/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: config.apiKey, ...body }),
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (response.status === 429 && attempt < 2) {
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 || MIN_REQUEST_GAP * (attempt + 1)));
    return fetchSocketToken(body, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`токен: HTTP ${response.status}`);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('сервер вернул не JSON (проверьте ключ)');
  }
  if (data?.status === 'error' || data?.error) {
    throw new Error(data.message || data.error || 'ошибка токена');
  }
  return data.data || data;
}

// --- разбор события ---------------------------------------------------------

// DonatePay присылает донат в нескольких обёртках в зависимости от источника
// (сокет, /transactions, /notifications), поэтому разбираем терпимо.
function normalizeDonation(raw = {}) {
  const payload = raw.notification || raw.data?.notification || raw.data || raw;
  const vars = payload.vars || payload.data || payload;
  const type = String(payload.type || vars.type || 'donation').toLowerCase();
  if (type && !type.includes('donation')) {
    return null;
  }

  const amount = Number(vars.sum ?? vars.amount ?? payload.sum ?? payload.amount ?? 0);
  const id = String(payload.id ?? vars.id ?? payload.transaction_id ?? `dp-${Date.now()}`);
  const username = String(vars.name || vars.username || payload.name || 'Аноним').trim() || 'Аноним';
  const message = String(vars.comment ?? vars.message ?? payload.comment ?? '').trim();
  const currency = String(vars.currency || payload.currency || 'RUB').toUpperCase();
  const createdAt = payload.created_at || payload.createdAt || new Date().toISOString();

  if (!amount) {
    return null;
  }
  return { id, username, amount, currency, message, createdAt, source: 'donatepay' };
}

function handleDonation(raw) {
  const donation = normalizeDonation(raw);
  if (!donation || !remember(donation.id)) {
    return;
  }
  lastEventAt = Date.now();
  emitStatus();
  try {
    onDonation(donation);
  } catch (error) {
    console.error(`[donatepay] обработчик доната упал: ${error.message}`);
  }
}

// --- опрос транзакций -------------------------------------------------------

async function pollTransactions({ silent = false } = {}) {
  if (!config.apiKey) {
    return;
  }
  try {
    const data = await apiGet('transactions', { limit: 20 });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    if (!primed) {
      for (const item of list) {
        const donation = normalizeDonation(item);
        if (donation) remember(donation.id);
      }
      primed = true;
      return;
    }
    // Идём от старых к новым, чтобы алерты играли в правильном порядке.
    for (const item of [...list].reverse()) {
      handleDonation(item);
    }
    if (!silent) {
      setError('');
    }
  } catch (error) {
    if (!silent) {
      setError(`опрос транзакций: ${error.message}`);
    }
  }
}

// При первом запуске просто запоминаем последние транзакции как «уже видели»,
// иначе включение подключения выстрелит очередью старых алертов в эфир.
async function primeSeen() {
  if (primed) return;
  try {
    const data = await apiGet('transactions', { limit: 50 });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    for (const item of list) {
      const donation = normalizeDonation(item);
      if (donation) {
        remember(donation.id);
      }
    }
    primed = true;
  } catch {
    /* первый успешный опрос запомнит историю без показа старых алертов */
  }
}

// --- Centrifugo -------------------------------------------------------------

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) {
    return;
  }
  const delay = Math.min(RECONNECT_BASE * 2 ** reconnectAttempt, RECONNECT_MAX);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket().catch((error) => {
      setError(String(error.message || error));
      scheduleReconnect();
    });
  }, delay);
}

function closeSocket() {
  clearInterval(pingTimer);
  pingTimer = null;
  if (socket) {
    const old = socket;
    socket = null;
    try {
      old.removeAllListeners();
      old.close();
    } catch {
      /* уже закрыт */
    }
  }
  connected = false;
}

async function openSocket() {
  if (stopped || !config.apiKey) {
    return;
  }
  const activeKey = config.apiKey;
  closeSocket();

  if (!user) {
    const fetchedUser = await fetchUser(activeKey);
    if (stopped || config.apiKey !== activeKey) return;
    user = fetchedUser;
  }
  if (stopped || config.apiKey !== activeKey) return;
  const channel = `$public:${user.id}`;
  const { token: connectToken } = await fetchSocketToken({});
  if (stopped || config.apiKey !== activeKey) return;
  if (!connectToken) {
    throw new Error('сервер не выдал токен подключения');
  }

  const ws = new WebSocket(SOCKET_URL, { headers: { Origin: 'https://donatepay.ru' } });
  socket = ws;

  ws.on('open', () => {
    commandId = 0;
    // Протокол v1: method — число (0 connect, 1 subscribe, 7 ping). Именно его
    // ждёт Centrifugo 3.2.0 у DonatePay: на новый формат он отвечает «bad request».
    send({ id: (commandId += 1), method: CMD.connect, params: { token: connectToken, name: 'tchat' } });
    pingTimer = setInterval(() => send({ id: (commandId += 1), method: CMD.ping }), 25000);
  });

  let subscriptionCommandId = 0;
  ws.on('message', async (buffer) => {
    const text = buffer.toString().trim();
    if (!text) {
      return;
    }
    // Сервер может прислать несколько кадров одной посылкой — по кадру на строку.
    for (const line of text.split('\n')) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      const err = frame.error || frame.result?.error;
      if (err) {
        setError(`Centrifugo: ${err.message || err.reason || err.code || 'ошибка'}`);
        scheduleReconnect();
        continue;
      }

      if (subscriptionCommandId && frame.id === subscriptionCommandId) {
        connected = true;
        reconnectAttempt = 0;
        setError('');
        continue;
      }

      // Ответ на connect: получили client id — только теперь можно просить
      // токен подписки на приватный канал.
      const client = frame.result?.client;
      if (client) {
        try {
          const sub = await fetchSocketToken({ client, channels: [channel] });
          const channelToken = Array.isArray(sub.channels)
            ? sub.channels.find((c) => c.channel === channel)?.token
            : sub.channels?.[channel]?.token;
          if (!channelToken) throw new Error('DonatePay не выдал токен подписки');
          subscriptionCommandId = ++commandId;
          send({
            id: subscriptionCommandId,
            method: CMD.subscribe,
            params: { channel, token: channelToken },
          });
        } catch (error) {
          setError(`подписка: ${error.message}`);
          scheduleReconnect();
        }
        continue;
      }

      // Публикация в канал: сам донат лежит в result.data.data.
      const payload = frame.result?.data?.data ?? frame.result?.data;
      if (frame.result?.channel && payload) {
        handleDonation(payload);
      }
    }
  });

  ws.on('close', () => {
    connected = false;
    emitStatus();
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    setError(`сокет: ${error.message}`);
  });

  emitStatus();
}

// --- управление -------------------------------------------------------------

async function start() {
  if (!config.apiKey) {
    setError('не задан ключ DonatePay');
    return getState();
  }
  stopped = false;
  reconnectAttempt = 0;
  lastError = '';

  try {
    user = await fetchUser();
  } catch (error) {
    const message = String(error.message || error);
    const invalidKey = /incorrect token|invalid token|неверн.*ключ|недействител.*ключ/i.test(message);
    setError(invalidKey ? `ключ не принят: ${message}` : `проверка DonatePay: ${message}`);
    if (!user && invalidKey) {
      stopped = true;
      return getState();
    }
    if (!user) scheduleReconnect();
  }

  if (user) {
    await primeSeen();
    await openSocket().catch((error) => {
      setError(String(error.message || error));
      scheduleReconnect();
    });
  }

  clearInterval(pollTimer);
  pollTimer = setInterval(() => pollTransactions({ silent: true }), POLL_INTERVAL);

  emitStatus();
  return getState();
}

function stop() {
  stopped = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pollTimer);
  pollTimer = null;
  closeSocket();
  emitStatus();
  return getState();
}

function init({ storageDir, onDonation: donationHandler, onStatus: statusHandler } = {}) {
  if (typeof donationHandler === 'function') {
    onDonation = donationHandler;
  }
  if (typeof statusHandler === 'function') {
    onStatus = statusHandler;
  }
  if (storageDir) {
    load(storageDir);
  }
  if (config.enabled && config.apiKey) {
    start().catch((error) => console.error(`[donatepay] запуск не удался: ${error.message}`));
  }
}

// Сохранение настроек: пустой ключ в патче не затирает сохранённый.
async function saveSettings(patch = {}) {
  const nextKey = patch.apiKey !== undefined && patch.apiKey !== '' ? String(patch.apiKey).trim() : config.apiKey;
  const keyChanged = nextKey !== config.apiKey;
  config = {
    apiKey: nextKey,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : config.enabled,
  };
  save();

  if (keyChanged) {
    user = null;
    primed = false;
    seen.clear();
    seenOrder.length = 0;
  }
  if (config.enabled && config.apiKey) {
    await start();
  } else {
    stop();
  }
  return getState();
}

// Проверка ключа из интерфейса: кто мы по этому ключу.
async function checkKey(apiKey) {
  const candidate = String(apiKey || '').trim() || config.apiKey;
  if (!candidate) return { ok: false, error: 'Введите API-ключ DonatePay' };
  try {
    const info = await fetchUser(candidate);
    if (candidate === config.apiKey) user = info;
    return { ok: true, user: info };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { init, start, stop, getState, saveSettings, checkKey, pollTransactions };
