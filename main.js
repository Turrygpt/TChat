const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const express = require('express');
const { Server } = require('socket.io');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, globalShortcut } = require('electron');
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat');
const { EdgeTTS } = require('node-edge-tts');
const announce = require('./src/announce');
const restream = require('./src/restream');
const incoming = require('./src/incoming');
const profiles = require('./src/profiles');
const { parseNicknameCommand } = require('./src/giveawayNicknames');
const donatepay = require('./src/donatepay');

// Автообновление с нашего сервера (адрес — в package.json, поле build.publish).
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Дифференциальная докачка по blockmap на нашей раздаче собирает битый файл —
  // качаем установщик целиком, это надёжно.
  autoUpdater.disableDifferentialDownload = true;
} catch (error) {
  console.error('[updater] модуль не загружен:', error && error.message);
}

// Точечный обход только для YouTube и только для TChat (плеер + чат + метаданные).
// Всё остальное (VK, Twitch, Rutube, DonationAlerts, localhost) идёт напрямую.
try {
  require('./src/net/ytProxy').install({ app });
} catch (error) {
  console.error('[ytProxy] не удалось инициализировать:', error && error.message);
}

// Настройка обхода YouTube из бэкофиса: получить/сохранить vless-ссылку.
let vlessConfig = null;
try {
  vlessConfig = require('./src/net/vlessConfig');
} catch (error) {
  console.error('[vless] модуль не загружен:', error && error.message);
}

if (vlessConfig) {
  ipcMain.handle('youtube-proxy:get', () => {
    try {
      return { ok: true, ...vlessConfig.getState() };
    } catch (error) {
      return { ok: false, error: error && error.message };
    }
  });

  ipcMain.handle('youtube-proxy:save', (_event, payload) => {
    try {
      return vlessConfig.saveLink(payload || {});
    } catch (error) {
      return { ok: false, error: (error && error.message) || 'Не удалось сохранить' };
    }
  });
}

function installBrokenPipeGuard() {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.on !== 'function') {
      continue;
    }

    stream.on('error', (error) => {
      if (error?.code === 'EPIPE') {
        return;
      }
    });
  }
}

function logInfo(...args) {
  try {
    console.log(...args);
  } catch (error) {
    if (error?.code !== 'EPIPE') {
      throw error;
    }
  }
}

installBrokenPipeGuard();

const SERVER_HOST = '0.0.0.0';
const SERVER_PORT = Number(process.env.TCHAT_PORT || 3000);
const DONATION_ALERTS_REDIRECT_PATH = '/oauth/donationalerts';
// Public base URL for OAuth redirects. On a hosted (headless) copy set
// TCHAT_PUBLIC_URL, e.g. http://195.62.49.244:3100 — desktop keeps localhost.
const PUBLIC_BASE_URL = (process.env.TCHAT_PUBLIC_URL || `http://localhost:${SERVER_PORT}`).replace(/\/+$/, '');
const DONATION_ALERTS_REDIRECT_URI = `${PUBLIC_BASE_URL}${DONATION_ALERTS_REDIRECT_PATH}`;
// Права запрашиваем минимальные — только чтение списка донатов.
const DONATION_ALERTS_SCOPE = 'oauth-donation-index';
// Здесь пользователь регистрирует своё приложение и получает Client ID/secret.
const DONATION_ALERTS_APPS_URL = 'https://www.donationalerts.com/application/clients';
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const EDGE_TTS_DEFAULT_VOICE = 'ru-RU-SvetlanaNeural';
const FIRST_MESSAGE_BELL_IMAGE =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 128 128%22%3E%3Crect width=%22128%22 height=%22128%22 rx=%2228%22 fill=%22%2313191f%22/%3E%3Cpath d=%22M64 112a14 14 0 0 0 13.6-10.7H50.4A14 14 0 0 0 64 112Z%22 fill=%22%23ffd166%22/%3E%3Cpath d=%22M104 91H24c7.5-7.2 11.3-17.2 11.3-30V51c0-17.2 10.7-31.8 25.8-36.1V9h5.8v5.9C82 19.2 92.7 33.8 92.7 51v10c0 12.8 3.8 22.8 11.3 30Z%22 fill=%22%23ffd166%22/%3E%3Cpath d=%22M91.2 24.8 99.8 16l6.2 6.1-8.6 8.8-6.2-6.1ZM22 22.1l6.2-6.1 8.6 8.8-6.2 6.1L22 22.1Z%22 fill=%22%23f77f00%22/%3E%3C/svg%3E';

// Дефолтные картинки и звуки алертов — лежат в assets/alerts/defaults/ и входят
// в сборку. Раздаются локальным сервером по /assets/... (работают из коробки).
const DEFAULT_ALERT_ASSETS = {
  donation: { image: '/assets/alerts/defaults/donation.png', sound: '/assets/alerts/defaults/donation.mp3' },
  subscriber: { image: '/assets/alerts/defaults/subscriber.png', sound: '/assets/alerts/defaults/subscriber.mp3' },
  raid: { image: '/assets/alerts/defaults/raid.png', sound: '/assets/alerts/defaults/raid.mp3' },
  portal: { image: '/assets/alerts/defaults/portal.png', sound: '/assets/alerts/defaults/portal.mp3' },
};

let mainWindow = null;
let chatWindow = null;
let httpServer = null;
let socketServer = null;
let twitchClient = null;
let youtubeClient = null;
let vkPollTimer = null;
let viewerPollTimer = null;
let vkChatBootstrapped = false;
let vkConnectionState = {
  consecutiveFailures: 0,
  lastSuccessAt: 0,
  lastViewers: 0,
  lastChatAvailable: false,
  lastError: '',
  lastChatMessageId: 0,
};
let donationAlertsTimer = null;
let donationAlertsToken = '';
let donationAlertsRefreshToken = '';
let donationAlertsClientId = '';
let donationAlertsClientSecret = '';
let donationAlertsBootstrapped = false;
let donationAlertsSettingsFile = '';
let alertSettingsFile = '';
let stickerSettingsFile = '';
let windowStateFile = '';
let chatUiSettingsFile = '';
let goalStateFile = '';
let streamWidgetsFile = '';
let giveawayWinnersFile = '';
let announceSettingsFile = '';
let musicSettingsFile = '';
let announceSettings = announce.createDefaultSettings();
let musicSettings = { volume: 50 };
let botConfigFile = '';
let botConfigKey = '';
let windowState = createDefaultWindowState();
let chatUiSettings = createDefaultChatUiSettings();
// Скрытые в окне чата отправители/сообщения. Источник правды — localStorage окна
// чата; сюда прилетают через chat:update-filters и раздаются виджетам, чтобы
// скрытое в чате не появлялось в overlay.
let chatHiddenFilters = { senders: [], messages: [] };
let alertSettings = createDefaultAlertSettings();
let stickerSettings = createDefaultStickerSettings();
let goalState = createDefaultGoalState();
let streamWidgets = [];
let activePoll = null;
let pollFinishTimer = null;
let giveawayFinishTimers = new Map();
let giveawayWinnerLog = [];
let countdownTickTimer = null;
const DEFAULT_COUNTDOWN_SECONDS = 7200;
const DEFAULT_TEXTS_FONT_SIZE = 32;
let alertQueue = [];
let musicQueue = [];
let firstMessageGreetingDay = getChatDayKey();
let firstMessageGreetingUsers = new Set();
const startedMusicIds = new Set();
let donationAlertsState = {
  status: 'токен не задан',
  lastSyncAt: '',
  error: '',
  donations: [],
};
const donationAlertsIds = new Set();
// Каналы не зашиты в приложение: подтягиваются из настроек (channels.json)
// или задаются в бэкофисе / импортом конфига.
let currentChannels = {
  twitch: '',
  vk: '',
  youtube: '',
  rutube: '',
};
let channelsFile = '';
let chatStats = {
  messages: 0,
  users: new Set(),
  vkMessageIds: new Set(),
  viewers: {
    twitch: 0,
    vk: 0,
    youtube: 0,
    rutube: 0,
  },
  platformStatus: {
    twitch: 'подключаем',
    vk: 'подключаем',
    youtube: 'ожидает подключения',
    rutube: 'ожидает подключения',
  },
};
let chatHistory = [];
let chatHistoryFile = '';
let serverStatus = {
  isReady: false,
  host: SERVER_HOST,
  port: SERVER_PORT,
  url: `http://localhost:${SERVER_PORT}`,
  error: null,
};

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const windowToFocus = chatWindow && !chatWindow.isDestroyed() ? chatWindow : mainWindow;
    if (!windowToFocus || windowToFocus.isDestroyed()) {
      return;
    }

    if (windowToFocus.isMinimized()) {
      windowToFocus.restore();
    }
    windowToFocus.focus();
  });
}

// --- чистая установка -------------------------------------------------------
// Стереть данные на лету нельзя: файлы заняты работающим приложением. Поэтому
// перед перезапуском кладём метку, а чистим на следующем старте — до того, как
// хоть что-то прочитано. Метка лежит в userData, но вне удаляемых папок.
const CLEAN_INSTALL_MARKER = 'clean-install.flag';

function getCleanInstallMarkerPath() {
  return path.join(app.getPath('userData'), CLEAN_INSTALL_MARKER);
}

function requestCleanInstall() {
  try {
    fs.writeFileSync(getCleanInstallMarkerPath(), new Date().toISOString());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function isCleanInstallPending() {
  try {
    return fs.existsSync(getCleanInstallMarkerPath());
  } catch {
    return false;
  }
}

// Вызывается самой первой, до setupChatStorage/setupDonationAlertsStorage.
function applyPendingCleanInstall() {
  if (!isCleanInstallPending()) {
    return false;
  }

  const userData = app.getPath('userData');
  // settings/ — токены, адреса каналов и правила; chat-history/ — переписка.
  // Local Storage / Session Storage — хранилище бэкоффиса: там лежат токен
  // DonationAlerts, client id/secret и адреса каналов. Без них «чистая»
  // установка оставляла бы токены на месте.
  for (const name of ['settings', 'chat-history', 'Local Storage', 'Session Storage']) {
    try {
      fs.rmSync(path.join(userData, name), { recursive: true, force: true });
    } catch (error) {
      console.error(`[clean-install] не удалось удалить ${name}: ${error.message}`);
    }
  }

  try {
    fs.rmSync(path.join(userData, 'updater.log'), { force: true });
  } catch {
    /* лог не критичен */
  }

  // Кеш смайлов и аватарок из чата — чистый кеш, скачается заново.
  // Картинки алертов и стикеров рядом (assets/alerts, assets/stickers) не трогаем:
  // там же лежат дефолтные звуки и картинки, идущие в комплекте.
  try {
    fs.rmSync(path.join(__dirname, 'assets', 'chat'), { recursive: true, force: true });
  } catch (error) {
    console.error(`[clean-install] кеш чата не удалился: ${error.message}`);
  }

  try {
    fs.rmSync(getCleanInstallMarkerPath(), { force: true });
  } catch (error) {
    console.error(`[clean-install] метка не удалилась: ${error.message}`);
  }

  logInfo('Выполнена чистая установка: данные стёрты');
  return true;
}

// Что именно потеряет пользователь при чистой установке — показываем до того,
// как он согласится.
function getUserDataSummary() {
  const userData = app.getPath('userData');
  const settingsDir = path.join(userData, 'settings');

  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(settingsDir, name), 'utf8'));
    } catch {
      return null;
    }
  };

  const donation = readJson('donationalerts.json') || {};
  const announce = readJson('announce.json') || {};
  const channels = readJson('channels.json') || {};

  const tokens = [
    donation.token && 'DonationAlerts',
    (announce.telegramToken || announce.tgToken) && 'Telegram',
    (announce.maxToken || announce.max?.token) && 'MAX',
    (announce.aiKey || announce.anthropicKey) && 'ИИ',
  ].filter(Boolean);

  const addresses = ['twitch', 'vk', 'youtube', 'rutube'].filter((key) => String(channels[key] || '').trim());

  let messages = 0;
  try {
    const raw = fs.readFileSync(path.join(userData, 'chat-history', 'chat.jsonl'), 'utf8');
    messages = raw.split('\n').filter((line) => line.trim()).length;
  } catch {
    messages = 0;
  }

  let rules = 0;
  try {
    rules = (readJson('alert-rules.json')?.rules || []).length + (readJson('stickers.json')?.rules || []).length;
  } catch {
    rules = 0;
  }

  return {
    hasData: Boolean(tokens.length || addresses.length || messages || rules),
    tokens,
    addresses,
    messages,
    rules,
  };
}

// --- первый запуск ----------------------------------------------------------
function getSetupStatePath() {
  return path.join(app.getPath('userData'), 'settings', 'setup.json');
}

function getSetupState() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSetupStatePath(), 'utf8'));
    return { completed: Boolean(saved.completed), completedAt: saved.completedAt || '' };
  } catch {
    // Настройка не пройдена. Но если каналы уже заданы — это апгрейд со старой
    // версии, а не чистый первый запуск: мастером человека дёргать не надо.
    const hasChannels = ['twitch', 'vk', 'youtube', 'rutube'].some((key) => String(currentChannels[key] || '').trim());
    return { completed: hasChannels, completedAt: '' };
  }
}

function saveSetupState(completed = true) {
  try {
    fs.mkdirSync(path.dirname(getSetupStatePath()), { recursive: true });
    fs.writeFileSync(getSetupStatePath(), JSON.stringify({ completed, completedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить состояние мастера: ${error.message}`);
  }

  return getSetupState();
}

function setupChatStorage() {
  const storageDir = path.join(app.getPath('userData'), 'chat-history');
  fs.mkdirSync(storageDir, { recursive: true });
  chatHistoryFile = path.join(storageDir, 'chat.jsonl');
  loadChatHistory();
}

function setupDonationAlertsStorage() {
  const storageDir = path.join(app.getPath('userData'), 'settings');
  fs.mkdirSync(storageDir, { recursive: true });
  donationAlertsSettingsFile = path.join(storageDir, 'donationalerts.json');
  alertSettingsFile = path.join(storageDir, 'alert-rules.json');
  stickerSettingsFile = path.join(storageDir, 'stickers.json');
  windowStateFile = path.join(storageDir, 'window-state.json');
  chatUiSettingsFile = path.join(storageDir, 'chat-ui.json');
  goalStateFile = path.join(storageDir, 'goal-state.json');
  streamWidgetsFile = path.join(storageDir, 'stream-widgets.json');
  giveawayWinnersFile = path.join(storageDir, 'giveaway-winners.jsonl');
  announceSettingsFile = path.join(storageDir, 'announce.json');
  musicSettingsFile = path.join(storageDir, 'music.json');
  botConfigFile = path.join(storageDir, 'bot-config.json');
  channelsFile = path.join(storageDir, 'channels.json');
  loadDonationAlertsToken();
  loadAlertSettings();
  loadStickerSettings();
  loadWindowState();
  loadChatUiSettings();
  loadGoalState();
  loadStreamWidgets();
  loadGiveawayWinnerLog();
  scheduleAllGiveawayFinishes();
  loadAnnounceSettings();
  loadMusicSettings();
  loadChatChannels();
  writeBotConfig();
}

function loadChatChannels() {
  if (!channelsFile || !fs.existsSync(channelsFile)) {
    return;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(channelsFile, 'utf8'));
    currentChannels = {
      twitch: String(saved.twitch || '').trim(),
      vk: String(saved.vk || '').trim(),
      youtube: String(saved.youtube || '').trim(),
      rutube: String(saved.rutube || '').trim(),
    };
  } catch (error) {
    console.error(`Не удалось прочитать каналы чата: ${error.message}`);
  }
}

function saveChatChannels() {
  if (!channelsFile) {
    return;
  }

  try {
    fs.writeFileSync(channelsFile, JSON.stringify(currentChannels, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить каналы чата: ${error.message}`);
  }
}

function loadAnnounceSettings() {
  if (!announceSettingsFile || !fs.existsSync(announceSettingsFile)) {
    announceSettings = announce.createDefaultSettings();
    return;
  }

  try {
    announceSettings = announce.normalizeSettings(JSON.parse(fs.readFileSync(announceSettingsFile, 'utf8')));
  } catch (error) {
    console.error(`Не удалось прочитать настройки оповещения: ${error.message}`);
    announceSettings = announce.createDefaultSettings();
  }
}

function saveAnnounceSettings(settings) {
  announceSettings = announce.normalizeSettings(settings);

  if (announceSettingsFile) {
    try {
      fs.writeFileSync(announceSettingsFile, JSON.stringify(announceSettings, null, 2));
    } catch (error) {
      console.error(`Не удалось сохранить настройки оповещения: ${error.message}`);
    }
  }

  writeBotConfig();
  return announceSettings;
}

// Конфиг для внешнего бота: все ключи и токены одним файлом.
// Раздаётся сервером по /config/bot.json только с верным секретным ключом.
function getBotConfigPayload() {
  return {
    updatedAt: new Date().toISOString(),
    telegram: { token: announceSettings.telegram.token, chatId: announceSettings.telegram.chatId },
    max: {
      token: announceSettings.max.token,
      chatId: announceSettings.max.chatId,
      channelUrl: announceSettings.max.channelUrl,
    },
    polza: { apiKey: announceSettings.polza.apiKey, model: announceSettings.polza.model },
    anthropic: { apiKey: announceSettings.anthropic.apiKey },
    ollama: { baseUrl: announceSettings.ollama.baseUrl, model: announceSettings.ollama.model },
    channels: { vk: announceSettings.channelUrl, twitch: announceSettings.twitchUrl },
  };
}

function writeBotConfig() {
  if (!botConfigFile) {
    return;
  }

  if (!botConfigKey) {
    try {
      botConfigKey = String(JSON.parse(fs.readFileSync(botConfigFile, 'utf8')).key || '').trim();
    } catch {
      botConfigKey = '';
    }
    if (!botConfigKey) {
      botConfigKey = crypto.randomBytes(24).toString('hex');
    }
  }

  try {
    fs.writeFileSync(botConfigFile, JSON.stringify({ key: botConfigKey, ...getBotConfigPayload() }, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить конфиг бота: ${error.message}`);
  }
}

function isValidBotConfigKey(candidate) {
  const expected = Buffer.from(String(botConfigKey || ''));
  const actual = Buffer.from(String(candidate || ''));
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createDefaultWindowState() {
  return {
    chatWindow: {
      width: 520,
      height: 760,
      x: null,
      y: null,
      isMaximized: false,
    },
    backoffice: {
      width: 920,
      height: 680,
      x: null,
      y: null,
      isMaximized: false,
    },
  };
}

function createDefaultChatUiSettings() {
  return {
    fontSize: 20,
    gap: 4,
    direction: 'top-down',
  };
}

function createDefaultGoalState() {
  return normalizeGoal({
    title: 'Сбор',
    current: 0,
    target: 10000,
    currency: 'RUB',
  });
}

function loadGoalState() {
  if (!fs.existsSync(goalStateFile)) {
    goalState = createDefaultGoalState();
    saveGoalState(goalState);
    return;
  }

  try {
    goalState = normalizeGoal(JSON.parse(fs.readFileSync(goalStateFile, 'utf8')));
  } catch (error) {
    console.error(`Не удалось прочитать настройки сбора: ${error.message}`);
    goalState = createDefaultGoalState();
  }
}

function saveGoalState(nextState = goalState) {
  goalState = normalizeGoal(nextState);

  if (!goalStateFile) {
    return goalState;
  }

  try {
    fs.writeFileSync(goalStateFile, JSON.stringify(goalState, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить настройки сбора: ${error.message}`);
  }

  return goalState;
}

function createDefaultStreamWidgets() {
  return [
    {
      id: 'builtin-alerts',
      type: 'alerts',
      title: 'Оповещения',
      enabled: true,
      x: 34,
      y: 34,
      width: 42,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-chat',
      type: 'chat',
      title: 'Чат на экране',
      enabled: false,
      x: 4,
      y: 48,
      width: 30,
      opacity: 0,
      hideSeconds: 0,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-music',
      type: 'music',
      title: 'Музыка',
      enabled: true,
      x: 68,
      y: 10,
      width: 28,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-poll',
      type: 'poll',
      title: 'Голосование',
      enabled: true,
      x: 60,
      y: 56,
      width: 34,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-countdown',
      type: 'countdown',
      title: 'До конца стрима',
      enabled: true,
      x: 72,
      y: 4,
      width: 18,
      status: 'paused',
      remainingSeconds: DEFAULT_COUNTDOWN_SECONDS,
      totalSeconds: DEFAULT_COUNTDOWN_SECONDS,
      setupMode: 'duration',
      targetEndsAt: '',
      endsAt: '',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-texts',
      type: 'texts',
      title: 'Тексты',
      enabled: false,
      x: 8,
      y: 18,
      width: 44,
      fontSize: DEFAULT_TEXTS_FONT_SIZE,
      textItems: [
        {
          id: 'builtin-text-welcome',
          content: 'Донат от 500 открывает карточку с призом',
          createdAt: new Date().toISOString(),
        },
      ],
      activeTextId: 'builtin-text-welcome',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'builtin-tasks',
      type: 'tasks',
      title: 'Задачи на стрим',
      enabled: false,
      x: 4,
      y: 8,
      width: 26,
      subtitle: 'План на эфир',
      footer: 'Live overlay',
      skin: 'farming-simulator-25',
      taskItems: [
        { id: 'task-1', text: 'Сбор урожая', done: false },
        { id: 'task-2', text: 'Запустить ресторан', done: false },
        { id: 'task-3', text: 'Сделать моцареллу', done: false },
      ],
      createdAt: new Date().toISOString(),
    },
  ];
}

function loadStreamWidgets() {
  if (!fs.existsSync(streamWidgetsFile)) {
    streamWidgets = createDefaultStreamWidgets();
    saveStreamWidgets(streamWidgets);
    return;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(streamWidgetsFile, 'utf8'));
    streamWidgets = mergeDefaultStreamWidgets(Array.isArray(saved?.items) ? saved.items.map(normalizeStreamWidget).filter(Boolean) : []);
    saveStreamWidgets(streamWidgets);
  } catch (error) {
    console.error(`Не удалось прочитать настройки виджетов: ${error.message}`);
    streamWidgets = createDefaultStreamWidgets();
  }
}

function mergeDefaultStreamWidgets(items = []) {
  const existingIds = new Set(items.map((item) => item.id));
  const defaults = createDefaultStreamWidgets().filter((item) => !existingIds.has(item.id));
  return [...defaults, ...items];
}

function saveStreamWidgets(items = streamWidgets) {
  streamWidgets = (Array.isArray(items) ? items : []).map(normalizeStreamWidget).filter(Boolean);

  if (!streamWidgetsFile) {
    return streamWidgets;
  }

  try {
    fs.writeFileSync(streamWidgetsFile, JSON.stringify({ items: streamWidgets }, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить настройки виджетов: ${error.message}`);
  }

  return streamWidgets;
}

function normalizeMusicSettings(settings = {}) {
  const rawVolume = Number(settings.volume);
  return {
    volume: Number.isFinite(rawVolume) ? Math.min(Math.max(Math.round(rawVolume), 0), 100) : 50,
  };
}

function loadMusicSettings() {
  if (!musicSettingsFile || !fs.existsSync(musicSettingsFile)) {
    saveMusicSettings(musicSettings, false);
    return;
  }

  try {
    musicSettings = normalizeMusicSettings(JSON.parse(fs.readFileSync(musicSettingsFile, 'utf8')));
  } catch (error) {
    console.error(`Не удалось прочитать настройки музыки: ${error.message}`);
    musicSettings = { volume: 50 };
  }
}

function saveMusicSettings(settings = {}, shouldBroadcast = true) {
  musicSettings = normalizeMusicSettings({ ...musicSettings, ...settings });

  if (musicSettingsFile) {
    try {
      fs.writeFileSync(musicSettingsFile, JSON.stringify(musicSettings, null, 2));
    } catch (error) {
      console.error(`Не удалось сохранить настройки музыки: ${error.message}`);
    }
  }

  if (shouldBroadcast) {
    broadcastMusicQueue();
  }

  return getMusicQueuePayload();
}

function loadGiveawayWinnerLog() {
  giveawayWinnerLog = [];
  if (!giveawayWinnersFile || !fs.existsSync(giveawayWinnersFile)) return;

  try {
    const rows = fs
      .readFileSync(giveawayWinnersFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    giveawayWinnerLog = rows.filter((entry) => entry.type !== 'winner-nickname').slice(-200);
    rows
      .filter((entry) => entry.type === 'winner-nickname')
      .forEach((event) => {
        const draw = giveawayWinnerLog.find((entry) => entry.id === event.drawId);
        if (!draw) return;
        draw.winnerNicknames = {
          ...(draw.winnerNicknames || {}),
          [event.winnerKey]: {
            nickname: event.nickname,
            capturedAt: event.capturedAt,
            source: event.source || '',
          },
        };
      });
  } catch (error) {
    console.error(`Не удалось прочитать журнал розыгрышей: ${error.message}`);
  }
}

function appendGiveawayNicknameLog(drawId, widgetId, winner, nickname, capturedAt, source = 'chat-command') {
  giveawayWinnerLog = giveawayWinnerLog.map((entry) =>
    entry.id === drawId
      ? {
          ...entry,
          winnerNicknames: {
            ...(entry.winnerNicknames || {}),
            [winner.key]: { nickname, capturedAt, source },
          },
        }
      : entry,
  );
  if (!giveawayWinnersFile) return;

  const event = {
    type: 'winner-nickname',
    drawId,
    widgetId,
    winnerKey: winner.key,
    winner,
    nickname,
    capturedAt,
    source,
  };
  fs.appendFile(giveawayWinnersFile, `${JSON.stringify(event)}\n`, (error) => {
    if (error) console.error(`Не удалось записать ник победителя: ${error.message}`);
  });
}

function appendGiveawayWinnerLog(entry) {
  giveawayWinnerLog.push(entry);
  giveawayWinnerLog = giveawayWinnerLog.slice(-200);
  if (!giveawayWinnersFile) return;

  fs.appendFile(giveawayWinnersFile, `${JSON.stringify(entry)}\n`, (error) => {
    if (error) console.error(`Не удалось записать победителей розыгрыша: ${error.message}`);
  });
}

function normalizeTextItem(item = {}, index = 0) {
  const id = String(item.id || `text-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`);
  return {
    id,
    content: String(item.content || ''),
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

function normalizeTextsWidget(widget = {}) {
  const textItems = (Array.isArray(widget.textItems) ? widget.textItems : []).map((item, index) =>
    normalizeTextItem(item, index),
  );
  const migratedItems = textItems.map((item) => {
    if (
      item.id === 'builtin-text-welcome' &&
      ['Добро пожаловать на стрим!', 'Сегодня играем вместе — заходите в чат'].includes(String(item.content || '').trim())
    ) {
      return {
        ...item,
        content: 'Донат от 500 открывает карточку с призом',
      };
    }

    return item;
  });
  let activeTextId = String(widget.activeTextId || '').trim();

  if (!migratedItems.some((item) => item.id === activeTextId)) {
    activeTextId = migratedItems[0]?.id || '';
  }

  const normalized = {
    ...widget,
    textItems: migratedItems,
    activeTextId,
    fontSize: Math.min(Math.max(Number(widget.fontSize || DEFAULT_TEXTS_FONT_SIZE), 14), 96),
  };

  delete normalized.height;

  return normalized;
}

function normalizeTaskItem(item = {}, index = 0) {
  const id = String(item.id || `task-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`);
  return {
    id,
    text: String(item.text || '').trim(),
    done: item.done === true,
  };
}

function normalizeTasksWidget(widget = {}) {
  const taskItems = (Array.isArray(widget.taskItems) ? widget.taskItems : [])
    .map((item, index) => normalizeTaskItem(item, index))
    .filter((item) => item.text)
    .slice(0, 12);

  return {
    ...widget,
    title: String(widget.title || 'Задачи на стрим').trim() || 'Задачи на стрим',
    subtitle: String(widget.subtitle || 'План на эфир').trim() || 'План на эфир',
    footer: String(widget.footer || 'Live overlay').trim() || 'Live overlay',
    skin: ['cities', 'farming-simulator-25', 'mir-korabley'].includes(widget.skin) ? widget.skin : 'farming-simulator-25',
    taskItems: taskItems.length
      ? taskItems
      : [
          { id: 'task-1', text: 'Задача 1', done: false },
          { id: 'task-2', text: 'Задача 2', done: false },
          { id: 'task-3', text: 'Задача 3', done: false },
        ],
  };
}

function normalizeWidgetCoord(value, fallback = 0) {
  const num = Number(value ?? fallback);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : fallback;
}

function normalizeWidgetHeight(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : null;
}

function normalizeGiveawayParticipant(participant = {}) {
  const platform = String(participant.platform || 'chat').trim().toLowerCase();
  const user = String(participant.user || 'Зритель').trim() || 'Зритель';
  return {
    key: String(participant.key || `${platform}:${user}`).toLowerCase(),
    platform,
    user,
    joinedAt: participant.joinedAt || new Date().toISOString(),
  };
}

function normalizeGiveawayWidget(widget = {}) {
  const participants = (Array.isArray(widget.participants) ? widget.participants : [])
    .map(normalizeGiveawayParticipant)
    .filter((participant, index, items) => items.findIndex((item) => item.key === participant.key) === index)
    .slice(0, 10000);
  const participantKeys = new Set(participants.map((participant) => participant.key));
  const winners = (Array.isArray(widget.winners) ? widget.winners : [])
    .map(normalizeGiveawayParticipant)
    .filter((winner) => participantKeys.has(winner.key));
  const winnerKeys = new Set(winners.map((winner) => winner.key));
  const winnerNicknames = Object.fromEntries(
    Object.entries(widget.winnerNicknames && typeof widget.winnerNicknames === 'object' ? widget.winnerNicknames : {})
      .filter(([key, value]) => winnerKeys.has(key) && String(value?.nickname || '').trim())
      .map(([key, value]) => [
        key,
        {
          nickname: String(value.nickname).trim().slice(0, 120),
          capturedAt: String(value.capturedAt || ''),
          source: ['chat-command', 'profile', 'manual-repair'].includes(value.source) ? value.source : '',
        },
      ]),
  );

  return {
    ...widget,
    title: String(widget.title || 'Розыгрыш').trim() || 'Розыгрыш',
    prize: String(widget.prize || 'Приз').trim() || 'Приз',
    prizeCount: Math.min(Math.max(Math.round(Number(widget.prizeCount || 1)), 1), 100),
    keyword: String(widget.keyword || '!участвую').trim() || '!участвую',
    durationSeconds: Math.min(Math.max(Math.round(Number(widget.durationSeconds || 0)), 0), 604800),
    status: ['idle', 'running', 'finished'].includes(widget.status) ? widget.status : 'idle',
    startedAt: String(widget.startedAt || ''),
    endsAt: String(widget.endsAt || ''),
    finishedAt: String(widget.finishedAt || ''),
    participants,
    winners,
    collectNicknames: widget.collectNicknames !== false,
    winnerNicknames,
    revealId: String(widget.revealId || ''),
  };
}

function normalizeStreamWidget(widget = {}) {
  const knownTypes = new Set(['alerts', 'chat', 'music', 'goal', 'poll', 'giveaway', 'countdown', 'texts', 'tasks', 'custom']);
  const type = knownTypes.has(widget.type) ? widget.type : 'goal';
  const id = String(widget.id || `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const minWidgetWidth = ['countdown', 'texts'].includes(type) ? 5 : 14;
  const height = normalizeWidgetHeight(widget.height);
  const base = {
    id,
    type,
    title: String(widget.title || widgetTitleByType(type)).trim() || widgetTitleByType(type),
    enabled: widget.enabled !== false,
    x: normalizeWidgetCoord(widget.x, defaultWidgetPosition(type).x),
    y: normalizeWidgetCoord(widget.y, defaultWidgetPosition(type).y),
    width: Math.max(Number(widget.width ?? defaultWidgetPosition(type).width), minWidgetWidth),
    createdAt: widget.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (height != null) {
    base.height = height;
  }

  const widgetSource = { ...widget };
  if (height != null) {
    widgetSource.height = height;
  } else {
    delete widgetSource.height;
  }

  if (type === 'goal') {
    return {
      ...base,
      current: Math.max(Number(widget.current || 0), 0),
      target: Math.max(Number(widget.target || 10000), 1),
      currency: String(widget.currency || 'RUB').trim() || 'RUB',
    };
  }

  if (type === 'countdown') {
    return normalizeCountdownWidget({
      ...base,
      ...widgetSource,
      id: base.id,
      type: 'countdown',
      title: String(widget.title || 'До конца стрима').trim() || 'До конца стрима',
      createdAt: widget.createdAt || base.createdAt,
    });
  }

  if (type === 'texts') {
    return normalizeTextsWidget({
      ...base,
      ...widgetSource,
      id: base.id,
      type: 'texts',
      title: String(widget.title || 'Тексты').trim() || 'Тексты',
      createdAt: widget.createdAt || base.createdAt,
    });
  }

  if (type === 'tasks') {
    return normalizeTasksWidget({
      ...base,
      ...widgetSource,
      id: base.id,
      type: 'tasks',
      title: String(widget.title || 'Задачи на стрим').trim() || 'Задачи на стрим',
      createdAt: widget.createdAt || base.createdAt,
    });
  }

  if (type === 'giveaway') {
    return normalizeGiveawayWidget({
      ...base,
      ...widgetSource,
      id: base.id,
      type: 'giveaway',
      createdAt: widget.createdAt || base.createdAt,
    });
  }

  if (type === 'chat') {
    // opacity — прозрачность панели в процентах (0 — непрозрачная, 100 — полностью
    // прозрачная). hideSeconds — через сколько секунд сообщение исчезает (0 — не исчезает).
    return {
      ...base,
      opacity: Math.min(Math.max(Number(widget.opacity) || 0, 0), 100),
      hideSeconds: Math.max(Math.round(Number(widget.hideSeconds) || 0), 0),
    };
  }

  return base;
}

function getCountdownRemainingSeconds(widget = {}) {
  if (widget.status === 'running' && widget.endsAt) {
    return Math.max(Math.ceil((new Date(widget.endsAt).getTime() - Date.now()) / 1000), 0);
  }

  if (widget.status === 'finished') {
    return 0;
  }

  return Math.max(Number(widget.remainingSeconds || 0), 0);
}

function parseCountdownEndAt(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function normalizeCountdownWidget(widget = {}) {
  const setupMode = widget.setupMode === 'datetime' ? 'datetime' : 'duration';
  const status = ['running', 'paused', 'finished'].includes(widget.status) ? widget.status : 'paused';
  let remainingSeconds = Math.max(Number(widget.remainingSeconds ?? DEFAULT_COUNTDOWN_SECONDS), 0);
  const totalSeconds = Math.max(Number(widget.totalSeconds || remainingSeconds || DEFAULT_COUNTDOWN_SECONDS), 1);
  let endsAt = String(widget.endsAt || '').trim();
  let targetEndsAt = setupMode === 'datetime' ? String(widget.targetEndsAt || endsAt || '').trim() : '';

  if (status === 'running') {
    if (setupMode === 'datetime' && targetEndsAt) {
      endsAt = targetEndsAt;
    } else if (!endsAt || Number.isNaN(new Date(endsAt).getTime())) {
      endsAt = new Date(Date.now() + remainingSeconds * 1000).toISOString();
    }

    const liveRemaining = getCountdownRemainingSeconds({ status: 'running', endsAt });
    return {
      ...widget,
      setupMode,
      targetEndsAt: setupMode === 'datetime' ? endsAt : '',
      status: liveRemaining > 0 ? 'running' : 'finished',
      endsAt: liveRemaining > 0 ? endsAt : '',
      remainingSeconds: liveRemaining > 0 ? liveRemaining : 0,
      totalSeconds,
    };
  }

  if (setupMode === 'datetime' && targetEndsAt && status === 'paused') {
    const targetRemaining = Math.max(Math.ceil((new Date(targetEndsAt).getTime() - Date.now()) / 1000), 0);
    if (targetRemaining > 0) {
      remainingSeconds = targetRemaining;
    }
  }

  return {
    ...widget,
    setupMode,
    targetEndsAt,
    status,
    endsAt: '',
    remainingSeconds: status === 'finished' ? 0 : remainingSeconds,
    totalSeconds,
  };
}

function updateCountdownWidget(id, patch = {}) {
  const widgetId = String(id || patch.id || '');
  const current = streamWidgets.find((item) => item.id === widgetId && item.type === 'countdown');
  if (!current) {
    throw new Error('Виджет таймера не найден.');
  }

  return updateStreamWidget(widgetId, normalizeCountdownWidget({ ...current, ...patch, id: widgetId }));
}

function adjustCountdownWidget(id, deltaSeconds = 0) {
  const widget = streamWidgets.find((item) => item.id === id && item.type === 'countdown');
  if (!widget) {
    throw new Error('Виджет таймера не найден.');
  }

  const delta = Number(deltaSeconds || 0);

  if (widget.setupMode === 'datetime') {
    const savedTargetMs = widget.targetEndsAt || widget.endsAt
      ? new Date(widget.targetEndsAt || widget.endsAt).getTime()
      : NaN;
    const baseTargetMs = Number.isFinite(savedTargetMs) && savedTargetMs > Date.now()
      ? savedTargetMs
      : Date.now() + getCountdownRemainingSeconds(widget) * 1000;
    const nextTargetMs = baseTargetMs + delta * 1000;
    const nextRemaining = Math.max(Math.ceil((nextTargetMs - Date.now()) / 1000), 0);
    const nextTargetIso = new Date(nextTargetMs).toISOString();

    return updateCountdownWidget(id, {
      enabled: true,
      setupMode: 'datetime',
      targetEndsAt: nextTargetIso,
      status: nextRemaining > 0 ? (widget.status === 'finished' ? 'paused' : widget.status) : 'finished',
      endsAt: widget.status === 'running' && nextRemaining > 0 ? nextTargetIso : '',
      remainingSeconds: nextRemaining,
      totalSeconds: Math.max(Number(widget.totalSeconds || nextRemaining), nextRemaining, 1),
    });
  }

  const nextRemaining = Math.max(getCountdownRemainingSeconds(widget) + delta, 0);
  const nextTotal = Math.max(Number(widget.totalSeconds || nextRemaining), nextRemaining, 1);

  if (widget.status === 'running') {
    return updateCountdownWidget(id, {
      enabled: true,
      setupMode: 'duration',
      targetEndsAt: '',
      status: nextRemaining > 0 ? 'running' : 'finished',
      endsAt: nextRemaining > 0 ? new Date(Date.now() + nextRemaining * 1000).toISOString() : '',
      remainingSeconds: nextRemaining,
      totalSeconds: nextTotal,
    });
  }

  return updateCountdownWidget(id, {
    enabled: true,
    setupMode: 'duration',
    targetEndsAt: '',
    status: nextRemaining > 0 ? widget.status : 'finished',
    remainingSeconds: nextRemaining,
    totalSeconds: nextTotal,
  });
}

function setCountdownWidgetTime(id, payload = {}) {
  const widget = streamWidgets.find((item) => item.id === id && item.type === 'countdown');
  if (!widget) {
    throw new Error('Виджет таймера не найден.');
  }

  const mode = payload.mode === 'datetime' ? 'datetime' : 'duration';

  if (mode === 'datetime') {
    const targetDate = parseCountdownEndAt(payload.endAt || payload.targetEndsAt);
    if (!targetDate) {
      throw new Error('Укажите корректные дату и время окончания.');
    }

    const remaining = Math.max(Math.ceil((targetDate.getTime() - Date.now()) / 1000), 0);
    if (remaining <= 0) {
      throw new Error('Время окончания должно быть в будущем.');
    }

    const targetEndsAt = targetDate.toISOString();
    const patch = {
      enabled: true,
      setupMode: 'datetime',
      targetEndsAt,
      remainingSeconds: remaining,
      totalSeconds: remaining,
      status: widget.status === 'finished' ? 'paused' : widget.status,
    };

    if (widget.status === 'running') {
      patch.endsAt = targetEndsAt;
    }

    if (payload.title) {
      patch.title = String(payload.title).trim();
    }

    return updateCountdownWidget(id, patch);
  }

  const hours = Math.max(Number(payload.hours || 0), 0);
  const minutes = Math.min(Math.max(Number(payload.minutes || 0), 0), 59);
  const seconds = Math.min(Math.max(Number(payload.seconds || 0), 0), 59);
  const total = hours * 3600 + minutes * 60 + seconds;

  if (total <= 0) {
    throw new Error('Укажите длительность больше нуля.');
  }

  const patch = {
    enabled: true,
    setupMode: 'duration',
    targetEndsAt: '',
    remainingSeconds: total,
    totalSeconds: total,
    status: widget.status === 'finished' ? 'paused' : widget.status,
  };

  if (widget.status === 'running') {
    patch.endsAt = new Date(Date.now() + total * 1000).toISOString();
  }

  if (payload.title) {
    patch.title = String(payload.title).trim();
  }

  return updateCountdownWidget(id, patch);
}

function startCountdownWidget(id) {
  const widget = streamWidgets.find((item) => item.id === id && item.type === 'countdown');
  if (!widget) {
    throw new Error('Виджет таймера не найден.');
  }

  let endsAtIso = '';
  let remainingSeconds = 0;
  let targetEndsAt = '';

  if (widget.setupMode === 'datetime' && (widget.targetEndsAt || widget.endsAt)) {
    targetEndsAt = widget.targetEndsAt || widget.endsAt;
    const targetMs = new Date(targetEndsAt).getTime();
    remainingSeconds = Math.max(Math.ceil((targetMs - Date.now()) / 1000), 0);
    if (remainingSeconds <= 0) {
      throw new Error('Время окончания уже прошло. Задайте новое.');
    }
    endsAtIso = new Date(targetMs).toISOString();
  } else {
    remainingSeconds = Math.max(getCountdownRemainingSeconds(widget), 1);
    endsAtIso = new Date(Date.now() + remainingSeconds * 1000).toISOString();
  }

  const result = updateCountdownWidget(id, {
    enabled: true,
    status: 'running',
    endsAt: endsAtIso,
    remainingSeconds,
    totalSeconds: Math.max(Number(widget.totalSeconds || remainingSeconds), remainingSeconds),
    setupMode: widget.setupMode === 'datetime' ? 'datetime' : 'duration',
    targetEndsAt: widget.setupMode === 'datetime' ? endsAtIso : '',
  });
  ensureCountdownTicking();
  return result;
}

function pauseCountdownWidget(id) {
  const widget = streamWidgets.find((item) => item.id === id && item.type === 'countdown');
  if (!widget) {
    throw new Error('Виджет таймера не найден.');
  }

  const remainingSeconds = getCountdownRemainingSeconds(widget);

  return updateCountdownWidget(id, {
    status: 'paused',
    endsAt: '',
    remainingSeconds,
    targetEndsAt:
      widget.setupMode === 'datetime' && remainingSeconds > 0
        ? new Date(Date.now() + remainingSeconds * 1000).toISOString()
        : widget.targetEndsAt || '',
  });
}

function resumeCountdownWidget(id) {
  return startCountdownWidget(id);
}

function resetCountdownWidget(id, seconds = DEFAULT_COUNTDOWN_SECONDS) {
  const total = Math.max(Number(seconds || DEFAULT_COUNTDOWN_SECONDS), 1);
  return updateCountdownWidget(id, {
    enabled: true,
    status: 'paused',
    endsAt: '',
    remainingSeconds: total,
    totalSeconds: total,
    setupMode: 'duration',
    targetEndsAt: '',
  });
}

function tickCountdownWidgets() {
  let changed = false;

  streamWidgets = streamWidgets.map((widget) => {
    if (widget.type !== 'countdown' || widget.status !== 'running' || !widget.endsAt) {
      return widget;
    }

    const remaining = getCountdownRemainingSeconds(widget);
    if (remaining > 0) {
      return normalizeCountdownWidget({
        ...widget,
        remainingSeconds: remaining,
      });
    }

    changed = true;
    return normalizeCountdownWidget({
      ...widget,
      status: 'finished',
      endsAt: '',
      remainingSeconds: 0,
    });
  });

  if (changed) {
    saveStreamWidgets(streamWidgets);
    broadcastStreamWidgets();
  }
}

function ensureCountdownTicking() {
  const hasRunningCountdown = streamWidgets.some((widget) => widget.type === 'countdown' && widget.status === 'running');
  if (!hasRunningCountdown) {
    if (countdownTickTimer) {
      clearInterval(countdownTickTimer);
      countdownTickTimer = null;
    }
    return;
  }

  if (countdownTickTimer) {
    return;
  }

  countdownTickTimer = setInterval(() => {
    tickCountdownWidgets();
    const stillRunning = streamWidgets.some((widget) => widget.type === 'countdown' && widget.status === 'running');
    if (!stillRunning && countdownTickTimer) {
      clearInterval(countdownTickTimer);
      countdownTickTimer = null;
    }
  }, 1000);
}

function widgetTitleByType(type) {
  return {
    alerts: 'Оповещения',
    chat: 'Чат на экране',
    music: 'Музыка',
    goal: 'Сбор',
    poll: 'Голосование',
    giveaway: 'Розыгрыш',
    countdown: 'Обратный отсчёт',
    texts: 'Тексты',
    tasks: 'Задачи на стрим',
    custom: 'Кастомный виджет',
  }[type] || 'Виджет';
}

function defaultWidgetPosition(type) {
  return {
    alerts: { x: 34, y: 34, width: 42 },
    chat: { x: 4, y: 48, width: 30 },
    music: { x: 68, y: 10, width: 28 },
    goal: { x: 18, y: 6, width: 64 },
    poll: { x: 60, y: 56, width: 34 },
    giveaway: { x: 28, y: 20, width: 44 },
    countdown: { x: 72, y: 4, width: 18 },
    texts: { x: 8, y: 18, width: 44 },
    tasks: { x: 4, y: 8, width: 26 },
    custom: { x: 12, y: 18, width: 32 },
  }[type] || { x: 10, y: 10, width: 32 };
}

function getStreamWidgetsPayload() {
  return {
    items: streamWidgets,
    poll: activePoll,
    giveawayLog: giveawayWinnerLog.slice(-50).reverse(),
    urls: {
      stream: `http://localhost:${SERVER_PORT}/widgets/stream.html`,
      alerts: `http://localhost:${SERVER_PORT}/widgets/alerts.html`,
      stickers: `http://localhost:${SERVER_PORT}/widgets/stickers.html`,
      chat: `http://localhost:${SERVER_PORT}/widgets/chat.html`,
      goal: `http://localhost:${SERVER_PORT}/widgets/goal.html`,
      music: `http://localhost:${SERVER_PORT}/widgets/music.html`,
      giveaway: `http://localhost:${SERVER_PORT}/widgets/giveaway.html`,
      countdown: `http://localhost:${SERVER_PORT}/widgets/countdown.html`,
      texts: `http://localhost:${SERVER_PORT}/widgets/texts.html`,
      tasks: `http://localhost:${SERVER_PORT}/widgets/tasks.html`,
    },
  };
}

function broadcastStreamWidgets() {
  const payload = getStreamWidgetsPayload();
  mainWindow?.webContents.send('widgets:state', payload);
  chatWindow?.webContents.send('widgets:state', payload);
  socketServer?.emit('widgets:state', payload);
}

function createStreamWidget(payload = {}) {
  const widget = normalizeStreamWidget(payload);
  streamWidgets.unshift(widget);
  streamWidgets = mergeDefaultStreamWidgets(streamWidgets);
  saveStreamWidgets(streamWidgets);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function updateStreamWidget(id, payload = {}) {
  const widgetId = String(id || payload.id || '');
  streamWidgets = streamWidgets.map((widget) => {
    if (widget.id !== widgetId) {
      return widget;
    }

    const merged = { ...widget, ...payload, id: widget.id, createdAt: widget.createdAt };
    if ('height' in payload && normalizeWidgetHeight(payload.height) == null) {
      delete merged.height;
    }

    return normalizeStreamWidget(merged);
  });
  streamWidgets = mergeDefaultStreamWidgets(streamWidgets);
  saveStreamWidgets(streamWidgets);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function deleteStreamWidget(id) {
  const widgetId = String(id || '');
  clearTimeout(giveawayFinishTimers.get(widgetId));
  giveawayFinishTimers.delete(widgetId);
  streamWidgets = streamWidgets.filter((widget) => widget.id !== widgetId);
  saveStreamWidgets(streamWidgets);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function getGiveawayWidget(id) {
  return streamWidgets.find((widget) => widget.id === String(id || '') && widget.type === 'giveaway');
}

function scheduleGiveawayFinish(widget) {
  clearTimeout(giveawayFinishTimers.get(widget?.id));
  giveawayFinishTimers.delete(widget?.id);
  if (!widget || widget.status !== 'running' || !widget.endsAt) return;

  const delay = Math.max(new Date(widget.endsAt).getTime() - Date.now(), 0);
  giveawayFinishTimers.set(widget.id, setTimeout(() => finishGiveaway(widget.id), delay));
}

function scheduleAllGiveawayFinishes() {
  streamWidgets.filter((widget) => widget.type === 'giveaway').forEach((widget) => {
    if (widget.status === 'running' && widget.endsAt && new Date(widget.endsAt).getTime() <= Date.now()) {
      finishGiveaway(widget.id);
    } else {
      scheduleGiveawayFinish(widget);
    }
  });
}

function startGiveaway(id, payload = {}) {
  const current = getGiveawayWidget(id);
  if (!current) throw new Error('Виджет розыгрыша не найден.');

  const configured = normalizeGiveawayWidget({ ...current, ...payload });
  const startedAt = new Date().toISOString();
  const next = normalizeStreamWidget({
    ...configured,
    enabled: true,
    status: 'running',
    participants: [],
    winners: [],
    winnerNicknames: {},
    startedAt,
    endsAt: configured.durationSeconds > 0 ? new Date(Date.now() + configured.durationSeconds * 1000).toISOString() : '',
    finishedAt: '',
    revealId: '',
  });
  streamWidgets = streamWidgets.map((widget) => (widget.id === current.id ? next : widget));
  saveStreamWidgets(streamWidgets);
  scheduleGiveawayFinish(next);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function chooseGiveawayWinners(participants, count) {
  const pool = [...participants];
  const winners = [];
  while (pool.length && winners.length < count) {
    winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  }
  return winners;
}

function finishGiveaway(id) {
  const current = getGiveawayWidget(id);
  if (!current || current.status !== 'running') return getStreamWidgetsPayload();

  clearTimeout(giveawayFinishTimers.get(current.id));
  giveawayFinishTimers.delete(current.id);
  const winners = chooseGiveawayWinners(current.participants, current.prizeCount);
  const finishedAt = new Date().toISOString();
  const revealId = `giveaway-reveal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const winnerNicknames = Object.fromEntries(
    winners
      .map((winner) => {
        const profile = profiles.findByUser(winner.platform, winner.user);
        const nickname = String(profile?.nickname || '').trim();
        return nickname ? [winner.key, { nickname, capturedAt: finishedAt, source: 'profile' }] : null;
      })
      .filter(Boolean),
  );
  const next = normalizeStreamWidget({
    ...current,
    status: 'finished',
    endsAt: '',
    finishedAt,
    winners,
    winnerNicknames,
    revealId,
  });
  streamWidgets = streamWidgets.map((widget) => (widget.id === current.id ? next : widget));
  saveStreamWidgets(streamWidgets);
  appendGiveawayWinnerLog({
    id: revealId,
    widgetId: current.id,
    title: current.title,
    prize: current.prize,
    prizeCount: current.prizeCount,
    keyword: current.keyword,
    participantCount: current.participants.length,
    winners,
    collectNicknames: current.collectNicknames,
    winnerNicknames,
    startedAt: current.startedAt,
    finishedAt,
  });
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function resetGiveaway(id) {
  const current = getGiveawayWidget(id);
  if (!current) throw new Error('Виджет розыгрыша не найден.');
  clearTimeout(giveawayFinishTimers.get(current.id));
  giveawayFinishTimers.delete(current.id);
  streamWidgets = streamWidgets.map((widget) =>
    widget.id === current.id
      ? normalizeStreamWidget({
          ...current,
          status: 'idle',
          participants: [],
          winners: [],
          winnerNicknames: {},
          startedAt: '',
          endsAt: '',
          finishedAt: '',
          revealId: '',
        })
      : widget,
  );
  saveStreamWidgets(streamWidgets);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

// Полный сброс оставляет настройки и расположение виджетов, но удаляет все
// запуски, участников, победителей, собранные ники и журнал розыгрышей.
function resetAllGiveaways() {
  giveawayFinishTimers.forEach((timer) => clearTimeout(timer));
  giveawayFinishTimers.clear();
  streamWidgets = streamWidgets.map((widget) =>
    widget.type === 'giveaway'
      ? normalizeStreamWidget({
          ...widget,
          status: 'idle',
          participants: [],
          winners: [],
          winnerNicknames: {},
          startedAt: '',
          endsAt: '',
          finishedAt: '',
          revealId: '',
        })
      : widget,
  );
  giveawayWinnerLog = [];
  if (giveawayWinnersFile) {
    try {
      fs.writeFileSync(giveawayWinnersFile, '');
    } catch (error) {
      console.error(`Не удалось очистить журнал розыгрышей: ${error.message}`);
    }
  }
  saveStreamWidgets(streamWidgets);
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function registerGiveawayParticipant(message = {}) {
  const text = String(message.text || '').trim().toLocaleLowerCase('ru-RU');
  let changed = false;
  streamWidgets = streamWidgets.map((widget) => {
    if (
      widget.type !== 'giveaway' ||
      widget.status !== 'running' ||
      text !== String(widget.keyword || '').trim().toLocaleLowerCase('ru-RU')
    ) {
      return widget;
    }

    const participant = normalizeGiveawayParticipant({
      platform: message.platform,
      user: message.user,
      joinedAt: message.createdAt || new Date().toISOString(),
    });
    if (widget.participants.some((item) => item.key === participant.key)) return widget;
    changed = true;
    return normalizeStreamWidget({ ...widget, participants: [...widget.participants, participant] });
  });

  if (changed) {
    saveStreamWidgets(streamWidgets);
    broadcastStreamWidgets();
  }
}

function registerGiveawayWinnerNickname(message = {}) {
  const nickname = parseNicknameCommand(message.text);
  if (!nickname) return;

  const participant = normalizeGiveawayParticipant({
    platform: message.platform,
    user: message.user,
  });
  const capturedAt = message.createdAt || new Date().toISOString();
  const captured = [];

  streamWidgets = streamWidgets.map((widget) => {
    if (widget.type !== 'giveaway' || widget.status !== 'finished' || widget.collectNicknames !== true) {
      return widget;
    }
    const winner = widget.winners.find((item) => item.key === participant.key);
    if (!winner) return widget;

    captured.push({ drawId: widget.revealId, widgetId: widget.id, winner });
    return normalizeStreamWidget({
      ...widget,
      winnerNicknames: {
        ...(widget.winnerNicknames || {}),
        [winner.key]: { nickname, capturedAt, source: 'chat-command' },
      },
    });
  });

  if (!captured.length) return;
  const wasKnown = Boolean(profiles.findByUser(message.platform, message.user));
  const savedProfile = profiles.setNicknameForUser({
    platform: message.platform,
    user: message.user,
    displayName: message.user,
    nickname,
  });
  saveStreamWidgets(streamWidgets);
  captured.forEach(({ drawId, widgetId, winner }) => {
    appendGiveawayNicknameLog(drawId, widgetId, winner, nickname, capturedAt, 'chat-command');
  });
  if (savedProfile) {
    void notifyProfileChanged(savedProfile.id);
    if (!wasKnown) broadcastProfileKeys();
  }
  broadcastStreamWidgets();
}

// В старой версии первое сообщение победителя ошибочно считалось ником. Для
// текущего legacy-розыгрыша один раз пересматриваем сообщения после финала:
// явная команда имеет приоритет, затем берём отдельное nickname-подобное слово.
// После записи source повторная миграция этот розыгрыш больше не трогает.
function repairLegacyCurrentGiveawayNicknames() {
  let changed = false;
  const repaired = [];

  streamWidgets = streamWidgets.map((widget) => {
    if (widget.type !== 'giveaway' || widget.status !== 'finished' || !widget.finishedAt || !widget.winners.length) {
      return widget;
    }
    const claims = widget.winnerNicknames || {};
    const hasLegacyClaims = widget.winners.some((winner) => claims[winner.key] && !claims[winner.key].source);
    if (!hasLegacyClaims) return widget;

    const nextClaims = { ...claims };
    for (const winner of widget.winners) {
      const messages = chatHistory.filter((message) => {
        const key = `${String(message.platform || '').toLowerCase()}:${String(message.user || '').trim().toLowerCase()}`;
        return key === winner.key && new Date(message.createdAt || 0).getTime() >= new Date(widget.finishedAt).getTime();
      });
      const commandNickname = messages.map((message) => parseNicknameCommand(message.text)).find(Boolean) || '';
      const standaloneNickname = messages
        .map((message) => String(message.text || '').trim())
        .find((text) => /^(?=.*[a-zа-яё])[a-zа-яё0-9_.-]{2,120}$/iu.test(text)) || '';
      const profile = profiles.findByUser(winner.platform, winner.user);
      const nickname = commandNickname || String(profile?.nickname || '').trim() || standaloneNickname;
      if (!nickname) {
        delete nextClaims[winner.key];
        continue;
      }
      const matchingMessage = messages.find(
        (message) => parseNicknameCommand(message.text) === nickname || String(message.text || '').trim() === nickname,
      );
      const capturedAt = matchingMessage?.createdAt || widget.finishedAt;
      const source = commandNickname ? 'chat-command' : profile?.nickname ? 'profile' : 'manual-repair';
      nextClaims[winner.key] = { nickname, capturedAt, source };
      const saved = profiles.setNicknameForUser({
        platform: winner.platform,
        user: winner.user,
        displayName: winner.user,
        nickname,
      });
      repaired.push({ drawId: widget.revealId, widgetId: widget.id, winner, nickname, capturedAt, source, profileId: saved?.id });
    }
    changed = true;
    return normalizeStreamWidget({ ...widget, winnerNicknames: nextClaims });
  });

  if (!changed) return;
  saveStreamWidgets(streamWidgets);
  repaired.forEach(({ drawId, widgetId, winner, nickname, capturedAt, source }) => {
    appendGiveawayNicknameLog(drawId, widgetId, winner, nickname, capturedAt, source);
  });
}

function normalizePoll(payload = {}) {
  const options = (Array.isArray(payload.options) ? payload.options : [])
    .map((option) => String(option || '').trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((text, index) => ({
      id: String(index + 1),
      index: index + 1,
      text,
      votes: 0,
    }));

  if (options.length < 2) {
    throw new Error('Для голосования нужно минимум два варианта.');
  }

  const durationSeconds = Math.max(Number(payload.durationSeconds || 0), 0);
  const startedAt = new Date().toISOString();

  return {
    id: `poll-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: String(payload.title || 'Голосование').trim() || 'Голосование',
    options,
    voters: {},
    status: 'running',
    visible: payload.visible !== false,
    startedAt,
    durationSeconds,
    endsAt: durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : '',
    finishedAt: '',
  };
}

function startPoll(payload = {}) {
  activePoll = normalizePoll(payload);
  schedulePollFinish();
  broadcastStreamWidgets();
  return activePoll;
}

function schedulePollFinish() {
  clearTimeout(pollFinishTimer);
  pollFinishTimer = null;

  if (!activePoll?.endsAt || activePoll.status !== 'running') {
    return;
  }

  const delay = Math.max(new Date(activePoll.endsAt).getTime() - Date.now(), 0);
  pollFinishTimer = setTimeout(() => finishPoll(), delay);
}

function finishPoll() {
  if (!activePoll) {
    return null;
  }

  clearTimeout(pollFinishTimer);
  pollFinishTimer = null;
  activePoll = {
    ...activePoll,
    status: 'finished',
    finishedAt: new Date().toISOString(),
  };
  broadcastStreamWidgets();
  return activePoll;
}

function hidePoll() {
  if (!activePoll) {
    return getStreamWidgetsPayload();
  }

  activePoll = {
    ...activePoll,
    visible: false,
  };
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function showPoll() {
  if (!activePoll) {
    return getStreamWidgetsPayload();
  }

  activePoll = {
    ...activePoll,
    visible: true,
  };
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function clearPoll() {
  clearTimeout(pollFinishTimer);
  pollFinishTimer = null;
  activePoll = null;
  broadcastStreamWidgets();
  return getStreamWidgetsPayload();
}

function registerPollVote(message = {}) {
  if (!activePoll || activePoll.status !== 'running') {
    return;
  }

  const text = String(message.text || '').trim();
  const match = text.match(/^(\d{1,2})$/);
  if (!match) {
    return;
  }

  const optionIndex = Number(match[1]);
  const option = activePoll.options.find((item) => item.index === optionIndex);
  if (!option) {
    return;
  }

  const voterKey = `${message.platform || 'chat'}:${message.user || 'guest'}`.toLowerCase();
  const previousId = activePoll.voters[voterKey];
  if (previousId) {
    return;
  }

  const options = activePoll.options.map((item) => {
    if (item.id === option.id) {
      return { ...item, votes: Number(item.votes || 0) + 1 };
    }
    return item;
  });

  activePoll = {
    ...activePoll,
    options,
    voters: {
      ...activePoll.voters,
      [voterKey]: option.id,
    },
  };
  broadcastStreamWidgets();
}

function loadWindowState() {
  if (!fs.existsSync(windowStateFile)) {
    windowState = createDefaultWindowState();
    return;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    windowState = {
      ...createDefaultWindowState(),
      ...saved,
      chatWindow: {
        ...createDefaultWindowState().chatWindow,
        ...(saved?.chatWindow || {}),
      },
      backoffice: {
        ...createDefaultWindowState().backoffice,
        ...(saved?.backoffice || {}),
      },
    };
  } catch (error) {
    console.error(`Не удалось прочитать размеры окон: ${error.message}`);
    windowState = createDefaultWindowState();
  }
}

function saveWindowState() {
  if (!windowStateFile) {
    return;
  }

  try {
    fs.writeFileSync(windowStateFile, JSON.stringify(windowState, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить размеры окон: ${error.message}`);
  }
}

function loadChatUiSettings() {
  if (!fs.existsSync(chatUiSettingsFile)) {
    chatUiSettings = createDefaultChatUiSettings();
    return;
  }

  try {
    chatUiSettings = normalizeChatUiSettings(JSON.parse(fs.readFileSync(chatUiSettingsFile, 'utf8')));
  } catch (error) {
    console.error(`Не удалось прочитать настройки чата: ${error.message}`);
    chatUiSettings = createDefaultChatUiSettings();
  }
}

function saveChatUiSettings(settings = chatUiSettings) {
  chatUiSettings = normalizeChatUiSettings({
    ...chatUiSettings,
    ...settings,
  });

  if (!chatUiSettingsFile) {
    return chatUiSettings;
  }

  try {
    fs.writeFileSync(chatUiSettingsFile, JSON.stringify(chatUiSettings, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить настройки чата: ${error.message}`);
  }

  broadcastChatUiSettings();
  return chatUiSettings;
}

function normalizeChatUiSettings(settings = {}) {
  const defaults = createDefaultChatUiSettings();
  const direction = ['bottom-up', 'top-down'].includes(settings.direction) ? settings.direction : defaults.direction;
  return {
    fontSize: Math.min(Math.max(Number(settings.fontSize || defaults.fontSize), 12), 64),
    gap: Math.min(Math.max(Number(settings.gap ?? defaults.gap), 0), 20),
    direction,
  };
}

function getSavedWindowBounds(name, defaults) {
  const saved = windowState[name] || {};
  const bounds = {
    width: Number(saved.width || defaults.width),
    height: Number(saved.height || defaults.height),
  };

  if (Number.isFinite(saved.x)) {
    bounds.x = Number(saved.x);
  }

  if (Number.isFinite(saved.y)) {
    bounds.y = Number(saved.y);
  }

  return bounds;
}

function trackWindowState(win, name) {
  let timer = null;

  const persist = () => {
    if (win.isDestroyed()) {
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) {
        return;
      }

      const bounds = win.getBounds();
      windowState[name] = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: win.isMaximized(),
      };
      saveWindowState();
    }, 300);
  };

  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', () => {
    clearTimeout(timer);

    if (win.isDestroyed()) {
      return;
    }

    const bounds = win.getBounds();
    windowState[name] = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized(),
    };
    saveWindowState();
  });

  if (windowState[name]?.isMaximized) {
    win.maximize();
  }
}

function loadDonationAlertsToken() {
  if (!fs.existsSync(donationAlertsSettingsFile)) {
    return;
  }

  try {
    const settings = JSON.parse(fs.readFileSync(donationAlertsSettingsFile, 'utf8'));
    donationAlertsToken = String(settings.token || '').trim();
    donationAlertsRefreshToken = String(settings.refreshToken || '').trim();
    donationAlertsClientId = String(settings.clientId || '').trim();
    donationAlertsClientSecret = String(settings.clientSecret || '').trim();
  } catch (error) {
    console.error(`Не удалось прочитать настройки DonationAlerts: ${error.message}`);
  }
}

function saveDonationAlertsSettings() {
  if (!donationAlertsSettingsFile) {
    return;
  }

  try {
    fs.writeFileSync(
      donationAlertsSettingsFile,
      JSON.stringify(
        {
          token: donationAlertsToken,
          refreshToken: donationAlertsRefreshToken,
          clientId: donationAlertsClientId,
          clientSecret: donationAlertsClientSecret,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`Не удалось сохранить настройки DonationAlerts: ${error.message}`);
  }
}

function createDefaultAlertSettings() {
  return {
    displaySeconds: 8,
    systemAlerts: {
      subscriber: {
        id: 'subscriber-welcome',
        enabled: true,
        type: 'subscriber',
        title: 'Добро пожаловать!',
        image: DEFAULT_ALERT_ASSETS.subscriber.image,
        sound: DEFAULT_ALERT_ASSETS.subscriber.sound,
        volume: 100,
      },
      subscriptionRenewal: {
        id: 'subscription-renewal',
        enabled: true,
        type: 'subscriptionRenewal',
        title: 'Продление подписки',
        image: DEFAULT_ALERT_ASSETS.subscriber.image,
        sound: DEFAULT_ALERT_ASSETS.subscriber.sound,
        volume: 100,
      },
      raid: {
        id: 'raid-welcome',
        enabled: true,
        type: 'raid',
        title: 'Рейд!',
        image: DEFAULT_ALERT_ASSETS.raid.image,
        sound: DEFAULT_ALERT_ASSETS.raid.sound,
        volume: 100,
      },
      firstMessage: {
        id: 'first-message-welcome',
        enabled: false,
        type: 'firstMessage',
        title: 'Колокольчик',
        image: FIRST_MESSAGE_BELL_IMAGE,
        sound: '',
        volume: 100,
      },
      portal: {
        id: 'portal-welcome',
        enabled: true,
        type: 'portal',
        title: 'Гость из портала!',
        image: DEFAULT_ALERT_ASSETS.portal.image,
        sound: DEFAULT_ALERT_ASSETS.portal.sound,
        volume: 100,
      },
    },
    rules: [
      {
        id: 'base-donation-100-100000',
        enabled: true,
        type: 'interval',
        title: 'Базовый донат',
        min: 100,
        max: 100000,
        image: DEFAULT_ALERT_ASSETS.donation.image,
        sound: DEFAULT_ALERT_ASSETS.donation.sound,
        volume: 100,
      },
    ],
  };
}

function loadAlertSettings() {
  if (!fs.existsSync(alertSettingsFile)) {
    saveAlertSettings(alertSettings);
    return;
  }

  try {
    alertSettings = migrateAlertSettings(normalizeAlertSettings(JSON.parse(fs.readFileSync(alertSettingsFile, 'utf8'))));
    saveAlertSettings(alertSettings);
  } catch (error) {
    console.error(`Не удалось прочитать настройки алертов: ${error.message}`);
  }
}

function saveAlertSettings(settings) {
  alertSettings = normalizeAlertSettings(settings);

  if (!alertSettingsFile) {
    return alertSettings;
  }

  try {
    fs.writeFileSync(alertSettingsFile, JSON.stringify(alertSettings, null, 2));
  } catch (error) {
    console.error(`Не удалось сохранить настройки алертов: ${error.message}`);
  }

  return alertSettings;
}

async function pickAlertAsset(kind = 'image') {
  const isSound = kind === 'sound';
  const result = await dialog.showOpenDialog(mainWindow || chatWindow || undefined, {
    title: isSound ? 'Выберите мелодию алерта' : 'Выберите картинку алерта',
    properties: ['openFile'],
    filters: isSound
      ? [{ name: 'Аудио', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac'] }]
      : [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, url: '' };
  }

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase() || (isSound ? '.mp3' : '.png');
  const safeName = `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`;
  const relativePath = path.join('alerts', safeName);
  const targetPath = path.join(__dirname, 'assets', relativePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  return {
    canceled: false,
    url: getAssetPublicUrl(relativePath),
    name: path.basename(sourcePath),
  };
}

// ── Стикеры ───────────────────────────────────────────────────────────────
// Зритель активирует награду во VK Play Live -> TChat кидает стикер на
// OBS-оверлей widgets/stickers.html на несколько секунд.

const STICKER_ANIMATIONS = ['random', 'pop', 'drop', 'slide', 'spin', 'fly', 'glitch', 'zoom'];
const STICKER_POSITIONS = [
  'random',
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

// Последние награды из чата — чтобы в бэкоффисе было видно точные названия.
let rewardLog = [];

function createDefaultStickerSettings() {
  return {
    displaySeconds: 8,
    maxOnScreen: 6,
    showUser: true,
    rules: [],
  };
}

function normalizeStickerRule(rule = {}, index = 0) {
  return {
    id: String(rule.id || `sticker-${Date.now()}-${index}`),
    enabled: rule.enabled !== false,
    reward: String(rule.reward || '').trim(),
    image: String(rule.image || '').trim(),
    seconds: Math.max(Number(rule.seconds || 0), 0),
    size: Math.min(Math.max(Number(rule.size || 240), 60), 1200),
    position: STICKER_POSITIONS.includes(rule.position) ? rule.position : 'random',
    animation: STICKER_ANIMATIONS.includes(rule.animation) ? rule.animation : 'random',
    loop: rule.loop !== false,
  };
}

function normalizeStickerSettings(settings = {}) {
  const defaults = createDefaultStickerSettings();
  const rules = Array.isArray(settings.rules) ? settings.rules : defaults.rules;

  return {
    displaySeconds: Math.max(Number(settings.displaySeconds || defaults.displaySeconds), 1),
    maxOnScreen: Math.min(Math.max(Number(settings.maxOnScreen || defaults.maxOnScreen), 1), 30),
    showUser: settings.showUser !== false,
    rules: rules.map(normalizeStickerRule),
  };
}

function loadStickerSettings() {
  if (!stickerSettingsFile || !fs.existsSync(stickerSettingsFile)) {
    saveStickerSettings(stickerSettings);
    return;
  }

  try {
    stickerSettings = normalizeStickerSettings(JSON.parse(fs.readFileSync(stickerSettingsFile, 'utf8')));
  } catch (error) {
    console.error(`Не удалось прочитать настройки стикеров: ${error.message}`);
  }
}

function saveStickerSettings(settings) {
  stickerSettings = normalizeStickerSettings(settings);

  if (stickerSettingsFile) {
    try {
      fs.writeFileSync(stickerSettingsFile, JSON.stringify(stickerSettings, null, 2));
    } catch (error) {
      console.error(`Не удалось сохранить настройки стикеров: ${error.message}`);
    }
  }

  socketServer?.emit('stickers:settings', stickerSettings);
  return stickerSettings;
}

async function pickStickerAsset() {
  const result = await dialog.showOpenDialog(mainWindow || chatWindow || undefined, {
    title: 'Выберите картинку стикера',
    properties: ['openFile'],
    filters: [{ name: 'Стикеры', extensions: ['png', 'gif', 'webp', 'apng', 'jpg', 'jpeg', 'svg', 'webm', 'mp4'] }],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, url: '' };
  }

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase() || '.png';
  const safeName = `sticker-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`;
  const relativePath = path.join('stickers', safeName);
  const targetPath = path.join(__dirname, 'assets', relativePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  return {
    canceled: false,
    url: getAssetPublicUrl(relativePath),
    name: path.basename(sourcePath),
  };
}

// Пустое поле «награда» = правило ловит любую награду (запасной стикер).
function findStickerRule(rewardName = '') {
  const needle = String(rewardName || '').trim().toLowerCase();
  const enabled = stickerSettings.rules.filter((rule) => rule.enabled && rule.image);
  const exact = enabled.find((rule) => rule.reward && rule.reward.toLowerCase() === needle);
  if (exact) {
    return exact;
  }

  const partial = needle ? enabled.find((rule) => rule.reward && needle.includes(rule.reward.toLowerCase())) : null;
  return partial || enabled.find((rule) => !rule.reward) || null;
}

function showSticker(payload = {}) {
  const item = {
    id: String(payload.id || `sticker:${Date.now()}:${Math.random().toString(16).slice(2)}`),
    url: String(payload.url || '').trim(),
    seconds: Math.max(Number(payload.seconds || stickerSettings.displaySeconds), 1),
    size: Math.min(Math.max(Number(payload.size || 240), 60), 1200),
    position: STICKER_POSITIONS.includes(payload.position) ? payload.position : 'random',
    animation: STICKER_ANIMATIONS.includes(payload.animation) ? payload.animation : 'random',
    loop: payload.loop !== false,
    username: String(payload.username || '').trim(),
    reward: String(payload.reward || '').trim(),
  };

  if (!item.url) {
    return null;
  }

  socketServer?.emit('sticker:show', item);
  return item;
}

function rememberReward(event = {}) {
  rewardLog.unshift({
    username: String(event.username || 'Зритель'),
    reward: String(event.reward || ''),
    matched: Boolean(event.matched),
    createdAt: event.createdAt || new Date().toISOString(),
  });
  rewardLog = rewardLog.slice(0, 20);
  broadcastStickerState();
}

function broadcastStickerState() {
  mainWindow?.webContents?.send('stickers:state', getStickerStatePayload());
}

function getStickerStatePayload() {
  return {
    settings: stickerSettings,
    rewards: rewardLog,
  };
}

function enqueueStickerFromReward(event = {}) {
  const rule = findStickerRule(event.reward);

  rememberReward({ ...event, matched: Boolean(rule) });

  if (!rule) {
    logInfo(`Награда «${event.reward || '?'}» от ${event.username || 'зрителя'}: правило стикера не найдено`);
    return null;
  }

  return showSticker({
    id: event.id,
    url: rule.image,
    seconds: rule.seconds || stickerSettings.displaySeconds,
    size: rule.size,
    position: rule.position,
    animation: rule.animation,
    loop: rule.loop,
    username: event.username,
    reward: event.reward,
  });
}

function normalizeAlertSettings(settings = {}) {
  const defaults = createDefaultAlertSettings();
  const rules = Array.isArray(settings.rules) ? settings.rules : defaults.rules;
  const systemAlerts = settings.systemAlerts || {};

  return {
    displaySeconds: Math.max(Number(settings.displaySeconds || defaults.displaySeconds), 3),
    systemAlerts: {
      subscriber: normalizeSystemAlertRule(systemAlerts.subscriber, defaults.systemAlerts.subscriber),
      subscriptionRenewal: normalizeSystemAlertRule(systemAlerts.subscriptionRenewal, defaults.systemAlerts.subscriptionRenewal),
      raid: normalizeSystemAlertRule(systemAlerts.raid, defaults.systemAlerts.raid),
      firstMessage: normalizeSystemAlertRule(systemAlerts.firstMessage, defaults.systemAlerts.firstMessage),
      portal: normalizeSystemAlertRule(systemAlerts.portal, defaults.systemAlerts.portal),
    },
    rules: rules.map((rule, index) => ({
      id: String(rule.id || `rule-${Date.now()}-${index}`),
      enabled: rule.enabled !== false,
      type: ['amount', 'nickname', 'interval'].includes(rule.type) ? rule.type : 'interval',
      title: String(rule.title || 'Алерт'),
      nickname: String(rule.nickname || '').trim(),
      amount: rule.amount === '' ? '' : Number(rule.amount || 0),
      min: rule.min === '' ? '' : Number(rule.min || 0),
      max: rule.max === '' ? '' : Number(rule.max || 0),
      image: String(rule.image || '').trim(),
      sound: String(rule.sound || '').trim(),
      volume: Math.min(Math.max(Number(rule.volume || 100), 0), 100),
    })),
  };
}

function normalizeSystemAlertRule(rule = {}, fallback = {}) {
  return {
    id: String(rule.id || fallback.id),
    enabled: rule.enabled !== false,
    type: String(fallback.type || rule.type || 'system'),
    title: String(rule.title || fallback.title || 'Алерт'),
    image: String(rule.image || fallback.image || '').trim(),
    sound: String(rule.sound || fallback.sound || '').trim(),
    volume: Math.min(Math.max(Number(rule.volume || fallback.volume || 100), 0), 100),
  };
}

// В 1.2.8 дефолтные svg/wav заменены на png/mp3, старые файлы удалены. У тех,
// кто ставит поверх прежней версии, настройки в userData переживают переустановку
// и продолжают ссылаться на несуществующие файлы — алерт выходит без картинки и
// звука. Переписываем такие ссылки на новые дефолты; правки пользователя (свои
// картинки и звуки) не трогаем, они по этим путям не лежат.
function upgradeDefaultAlertAssets(rule = {}) {
  const legacy = /^\/assets\/alerts\/defaults\/(donation|subscriber|raid|portal)\.(svg|wav)$/;
  const patched = { ...rule };

  const imageMatch = legacy.exec(String(rule.image || ''));
  if (imageMatch) {
    patched.image = DEFAULT_ALERT_ASSETS[imageMatch[1]].image;
  }

  const soundMatch = legacy.exec(String(rule.sound || ''));
  if (soundMatch) {
    patched.sound = DEFAULT_ALERT_ASSETS[soundMatch[1]].sound;
  }

  return patched;
}

function migrateAlertSettings(settings = {}) {
  const oldDefaultIds = new Set(['amount-666', 'music-link', 'interval-100-499', 'interval-500-1000', 'interval-1000-plus']);
  const customRules = (Array.isArray(settings.rules) ? settings.rules : [])
    .filter((rule) => rule.type !== 'music' && !oldDefaultIds.has(rule.id))
    .map(upgradeDefaultAlertAssets);
  const hasBaseRule = customRules.some((rule) => rule.id === 'base-donation-100-100000');

  const normalizedSystemAlerts = normalizeAlertSettings(settings).systemAlerts;
  const systemAlerts = Object.fromEntries(
    Object.entries(normalizedSystemAlerts).map(([type, rule]) => [type, upgradeDefaultAlertAssets(rule)]),
  );

  return {
    displaySeconds: Math.max(Number(settings.displaySeconds || 8), 3),
    systemAlerts: {
      ...systemAlerts,
      firstMessage: {
        ...systemAlerts.firstMessage,
        enabled: false,
      },
    },
    rules: hasBaseRule ? customRules : [createDefaultAlertSettings().rules[0], ...customRules],
  };
}

function getChatDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return getChatDayKey(new Date());
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getChatUserKey(message = {}) {
  const platform = String(message.platform || 'chat').trim().toLowerCase();
  const user = String(message.user || 'guest').trim().toLowerCase();
  return `${platform}:${user}`;
}

function refreshFirstMessageGreetingUsers() {
  firstMessageGreetingDay = getChatDayKey();
  firstMessageGreetingUsers = new Set(
    chatHistory
      .filter((message) => getChatDayKey(message.createdAt) === firstMessageGreetingDay)
      .map(getChatUserKey),
  );
}

function loadChatHistory() {
  if (!fs.existsSync(chatHistoryFile)) {
    chatHistory = [];
    refreshFirstMessageGreetingUsers();
    return;
  }

  const lines = fs.readFileSync(chatHistoryFile, 'utf8').split(/\r?\n/).filter(Boolean);
  chatHistory = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  chatStats.messages = chatHistory.length;
  chatStats.users = new Set(chatHistory.map((message) => `${message.platform}:${message.user}`.toLowerCase()));
  refreshFirstMessageGreetingUsers();

  if (chatHistory.length > CHAT_HISTORY_MEMORY_LIMIT) {
    chatHistory = chatHistory.slice(-CHAT_HISTORY_MEMORY_LIMIT);
  }
}

const CHAT_HISTORY_MEMORY_LIMIT = 2000;

function saveChatMessage(message) {
  chatHistory.push(message);
  if (chatHistory.length > CHAT_HISTORY_MEMORY_LIMIT) {
    chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MEMORY_LIMIT);
  }
  fs.appendFile(chatHistoryFile, `${JSON.stringify(message)}\n`, (error) => {
    if (error) {
      console.error(`Не удалось сохранить сообщение чата: ${error.message}`);
    }
  });
  // Если у автора есть профиль — сообщение сразу уходит и в его собственный лог.
  profiles.recordMessage(message);
}

function getRecentChatMessages(limit = 30) {
  return chatHistory.slice(-limit).reverse();
}

function getAssetPublicUrl(relativePath) {
  return `http://localhost:${SERVER_PORT}/assets/${relativePath.replaceAll('\\', '/')}`;
}

function getPlatformIconUrl(platform) {
  const safePlatform = String(platform || 'demo').toLowerCase();
  const knownPlatforms = new Set(['twitch', 'vk', 'youtube', 'rutube', 'demo']);
  const iconName = knownPlatforms.has(safePlatform) ? safePlatform : 'demo';
  return getAssetPublicUrl(`chat/platforms/${iconName}.svg`);
}

async function cacheRemoteAsset(url, group = 'emotes') {
  if (!url) {
    return '';
  }

  try {
    const parsedUrl = new URL(url.startsWith('//') ? `https:${url}` : url);
    const extension = path.extname(parsedUrl.pathname).split('?')[0] || '.png';
    const safeName = Buffer.from(parsedUrl.href).toString('base64url').slice(0, 80);
    const relativePath = path.join('chat', group, `${safeName}${extension}`);
    const filePath = path.join(__dirname, 'assets', relativePath);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (!fs.existsSync(filePath)) {
      const response = await fetch(parsedUrl.href);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
    }

    return getAssetPublicUrl(relativePath);
  } catch (error) {
    console.error(`Не удалось сохранить ассет чата: ${error.message}`);
    return url;
  }
}

function normalizeMessageParts(text = '', parts = []) {
  if (parts.length) {
    return parts;
  }

  return [{ type: 'text', text: String(text) }];
}

function normalizeTtsText(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function escapeSsmlText(value = '') {
  return normalizeTtsText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getEdgeTtsCachePath(text, options = {}) {
  const cacheDir = path.join(__dirname, 'assets', 'tts');
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ text, ...options }))
    .digest('hex');

  return path.join(cacheDir, `${hash}.mp3`);
}

async function getEdgeTtsAudioPath(text, options = {}) {
  const normalizedText = normalizeTtsText(text);
  if (!normalizedText) {
    throw new Error('text is required');
  }

  const ttsOptions = {
    voice: options.voice || EDGE_TTS_DEFAULT_VOICE,
    lang: options.lang || 'ru-RU',
    outputFormat: options.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
    rate: options.rate || '+0%',
    volume: options.volume || '+0%',
    pitch: options.pitch || '+0Hz',
    timeout: 20000,
  };
  const filePath = getEdgeTtsCachePath(normalizedText, ttsOptions);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return filePath;
  }

  const edgeTts = new EdgeTTS(ttsOptions);
  await edgeTts.ttsPromise(escapeSsmlText(normalizedText), filePath);
  return filePath;
}

function createLocalServer() {
  const expressApp = express();
  const widgetsPath = path.join(__dirname, 'widgets');
  const assetsPath = path.join(__dirname, 'assets');

  expressApp.use(express.json());
  expressApp.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });
  expressApp.get([
    '/widget/chat',
    '/widget/chat/',
    '/widget/chat.html',
    '/widget/chat/widgets/chat.html',
    '/widgets/chat',
  ], (_request, response) => {
    response.redirect(302, '/widgets/chat.html');
  });
  expressApp.use('/widgets', (request, response, next) => {
    if (/\.(?:js|css|html)$/.test(request.path)) {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
    }
    next();
  });
  expressApp.use('/widgets', express.static(widgetsPath));
  expressApp.use('/assets', express.static(assetsPath));

  expressApp.get('/', (_request, response) => {
    response.redirect('/widgets/remote.html');
  });

  expressApp.get('/tts/edge', async (request, response) => {
    try {
      const filePath = await getEdgeTtsAudioPath(request.query?.text || '', {
        voice: request.query?.voice,
        rate: request.query?.rate,
        volume: request.query?.volume,
        pitch: request.query?.pitch,
      });

      response.type('audio/mpeg').sendFile(filePath);
    } catch (error) {
      console.error(`Edge TTS error: ${error.message}`);
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  expressApp.get('/health', (_request, response) => {
    response.json({
      ok: true,
      name: 'TChat',
      version: app.getVersion(),
      message: 'Сервер виджетов живёт.',
      host: SERVER_HOST,
      port: SERVER_PORT,
      widgets: {
        stream: '/widgets/stream.html',
        alerts: '/widgets/alerts.html',
        stickers: '/widgets/stickers.html',
        chat: '/widgets/chat.html',
        goal: '/widgets/goal.html',
        music: '/widgets/music.html',
        countdown: '/widgets/countdown.html',
        texts: '/widgets/texts.html',
        tasks: '/widgets/tasks.html',
        remote: '/widgets/remote.html',
      },
    });
  });

  expressApp.get('/chat/status', (_request, response) => {
    response.json(getChatStatusPayload());
  });

  // Конфиг для внешнего бота (токены TG/MAX, ключ polza.ai). Доступ только по ключу
  // из bot-config.json: /config/bot.json?key=... или заголовок X-Config-Key.
  expressApp.get('/config/bot.json', (request, response) => {
    const candidate = request.query.key || request.get('x-config-key');
    if (!isValidBotConfigKey(candidate)) {
      response.status(403).json({ ok: false, error: 'нужен верный ключ (?key= или X-Config-Key)' });
      return;
    }
    response.json(getBotConfigPayload());
  });

  expressApp.get('/remote/info', (_request, response) => {
    response.json({
      ok: true,
      name: 'TChat',
      port: SERVER_PORT,
      goal: goalState,
      chat: getChatStatusPayload(),
      widgets: getStreamWidgetsPayload(),
      poll: activePoll,
    });
  });

  expressApp.post('/remote/goal/update', (request, response) => {
    const payload = updateGoalState(request.body);
    response.json({ ok: true, goal: payload });
  });

  expressApp.post('/remote/goal/add', (request, response) => {
    const amount = Math.max(Number(request.body?.amount || 0), 0);
    if (!amount) {
      response.status(400).json({ ok: false, error: 'Укажите сумму больше нуля.' });
      return;
    }

    const payload = updateGoalState({
      current: Number(goalState.current || 0) + amount,
    });
    response.json({ ok: true, goal: payload });
  });

  expressApp.post('/remote/goal/reset', (_request, response) => {
    const payload = updateGoalState({ current: 0 });
    response.json({ ok: true, goal: payload });
  });

  expressApp.post('/remote/widgets/update', (request, response) => {
    const id = String(request.body?.id || '');
    if (!id) {
      response.status(400).json({ ok: false, error: 'id виджета не задан.' });
      return;
    }

    const payload = updateStreamWidget(id, request.body);
    response.json({ ok: true, ...payload });
  });

  expressApp.post('/remote/poll/start', (request, response) => {
    try {
      const poll = startPoll(request.body);
      response.json({ ok: true, poll });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  expressApp.post('/remote/poll/finish', (_request, response) => {
    response.json({ ok: true, poll: finishPoll() });
  });

  expressApp.post('/remote/poll/hide', (_request, response) => {
    response.json({ ok: true, ...hidePoll() });
  });

  expressApp.post('/remote/poll/show', (_request, response) => {
    response.json({ ok: true, ...showPoll() });
  });

  expressApp.post('/remote/poll/clear', (_request, response) => {
    response.json({ ok: true, ...clearPoll() });
  });

  expressApp.post('/remote/demo/donation', (request, response) => {
    const item = enqueueDonationAlert({
      id: `remote-${Date.now()}`,
      username: request.body?.username || 'Удалённый донат',
      amount: Number(request.body?.amount || 100),
      currency: request.body?.currency || 'RUB',
      message: request.body?.message || 'Донат с удалённой панели',
      createdAt: new Date().toISOString(),
      isTest: request.body?.isTest !== false,
      showInChat: request.body?.showInChat !== false,
    });
    response.json({ ok: true, item });
  });

  expressApp.get(DONATION_ALERTS_REDIRECT_PATH, async (request, response) => {
    if (request.query?.code) {
      try {
        await exchangeDonationAlertsCode(String(request.query.code));
        response.type('html').send(getDonationAlertsOauthResultPage('Готово. Токен сохранён, синхронизация донатов запущена. Это окно можно закрыть.'));
      } catch (error) {
        response.type('html').send(getDonationAlertsOauthResultPage(`Не удалось получить токен DonationAlerts: ${error.message}`));
      }
      return;
    }

    response.type('html').send(getDonationAlertsOauthPage());
  });

  expressApp.post(`${DONATION_ALERTS_REDIRECT_PATH}/token`, (request, response) => {
    const state = startDonationAlertsSync(request.body?.token || '');
    response.json({ ok: Boolean(request.body?.token), state });
  });

  expressApp.post('/demo/chat', (request, response) => {
    const payload = normalizeChatMessage(request.body);
    broadcastChatMessage(payload);
    response.json({ ok: true, payload });
  });

  expressApp.post('/demo/donation', (request, response) => {
    if (!isInternalDemoRequest(request)) {
      response.status(403).json({ ok: false, error: 'Demo endpoint доступен только из TChat.' });
      return;
    }

    const payload = normalizeDonation({ ...request.body, isTest: request.body?.isTest ?? true, showInChat: request.body?.showInChat ?? true });
    const item = enqueueDonationAlert(payload);
    response.json({ ok: true, payload, item });
  });

  expressApp.post('/demo/goal', (request, response) => {
    const payload = updateGoalState(request.body);
    response.json({ ok: true, payload });
  });

  expressApp.post('/demo/music', async (request, response) => {
    try {
      const url = String(request.body?.url || '').trim();
      if (!url) {
        response.status(400).json({ ok: false, error: 'url is required' });
        return;
      }

      await addManualMusicUrl({
        url,
        username: request.body?.username || 'Smoke test',
      });
      response.json({ ok: true, queue: getMusicQueuePayload() });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  expressApp.post('/demo/music/reset', (request, response) => {
    if (!isInternalDemoRequest(request)) {
      response.status(403).json({ ok: false, error: 'Demo endpoint доступен только из TChat.' });
      return;
    }

    musicQueue = musicQueue.filter((item) => {
      const username = String(item.donation?.username || '').trim().toLowerCase();
      return username !== 'smoke test';
    });
    startedMusicIds.clear();
    broadcastMusicQueue();
    response.json({ ok: true, queue: getMusicQueuePayload() });
  });

  expressApp.post('/demo/subscriber', (request, response) => {
    if (!isInternalDemoRequest(request)) {
      response.status(403).json({ ok: false, error: 'Demo endpoint доступен только из TChat.' });
      return;
    }

    const item = enqueueSubscriberAlert({
      id: `smoke-sub-${Date.now()}`,
      platform: request.body?.platform || 'demo',
      username: request.body?.username || 'SmokeSubscriber',
      message: request.body?.message || 'подписался на канал',
      createdAt: new Date().toISOString(),
      isTest: true,
    });
    if (item?.id) {
      markAlertPlayed(item.id);
    }
    response.json({ ok: true, item });
  });

  expressApp.get('/alerts/state', (_request, response) => {
    response.json({
      settings: alertSettings,
      queue: alertQueue.slice(0, 30),
    });
  });

  expressApp.get('/patchnotes.json', (_request, response) => {
    response.json({ notes: readLocalPatchnotes() });
  });

  expressApp.get('/stickers/state', (_request, response) => {
    response.json(getStickerStatePayload());
  });

  expressApp.post('/demo/sticker', (request, response) => {
    const item = showSticker(request.body || {});
    response.json({ ok: Boolean(item), item });
  });

  expressApp.get('/music/state', (_request, response) => {
    response.json(getMusicQueuePayload());
  });

  expressApp.get('/goal/state', (_request, response) => {
    response.json(goalState);
  });

  expressApp.get('/widgets/state', (_request, response) => {
    response.json(getStreamWidgetsPayload());
  });

  expressApp.post('/goal/update', (request, response) => {
    const payload = updateGoalState(request.body);
    response.json({ ok: true, goal: payload });
  });

  // Живой MPEG-TS входящего потока по id: incoming.js держит ffmpeg на каждый
  // источник и раздаёт его всем открытым виджетам incoming.html (браузер-источник
  // OBS). У каждой камеры свой адрес /streams/<id>/live.ts.
  expressApp.get('/streams/:id/live.ts', (request, response) => {
    response.setHeader('Content-Type', 'video/mp2t');
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.setHeader('Connection', 'close');
    incoming.attach(request.params.id, response);
  });

  httpServer = http.createServer(expressApp);
  socketServer = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  socketServer.on('connection', (socket) => {
    logInfo(`Виджет подключён: ${socket.id}`);
    socket.emit('system:ready', {
      message: 'Связь с локальным сервером установлена.',
      connectedAt: new Date().toISOString(),
    });
    socket.emit('chat:ui-settings', chatUiSettings);
    socket.emit('chat:filters', chatHiddenFilters);
    socket.emit('chat:status', getChatStatusPayload());
    socket.emit('chat:history', getRecentChatMessages(20));
    socket.emit('widgets:state', getStreamWidgetsPayload());
    socket.emit('stickers:settings', stickerSettings);

    socket.on('disconnect', () => {
      // Не логируем отключение: в Electron/OBS console.log может выбросить EPIPE и уронить приложение.
    });

    socket.on('alert:played', (payload) => {
      markAlertPlayed(payload?.id);
    });

    socket.on('music:started', (payload) => {
      markMusicStarted(payload?.id);
    });

    socket.on('music:played', (payload) => {
      markMusicPlayed(payload?.id);
    });

    socket.on('music:title', (payload) => {
      updateMusicTitle(payload?.id, payload?.title);
    });

    socket.on('music:bootstrap', (callback) => {
      finalizePlayingMusicOnWidgetBootstrap();
      if (typeof callback === 'function') {
        callback({ ok: true });
      }
    });
  });

  // Headless mode: expose the IPC brain to plain browsers (backoffice / chat).
  if (process.env.TCHAT_HEADLESS) {
    require('./src/headless/web-bridge').attach({ io: socketServer, app: expressApp });
  }
}

function startLocalServer() {
  createLocalServer();

  return new Promise((resolve) => {
    httpServer.once('error', (error) => {
      serverStatus = {
        isReady: false,
        host: SERVER_HOST,
        port: SERVER_PORT,
        url: `http://localhost:${SERVER_PORT}`,
        error: error.message,
      };
      console.error(`Сервер виджетов не запущён: ${error.message}`);
      resolve(serverStatus);
    });

    httpServer.listen(SERVER_PORT, SERVER_HOST, () => {
      serverStatus = {
        isReady: true,
        host: SERVER_HOST,
        port: SERVER_PORT,
        url: `http://localhost:${SERVER_PORT}`,
        error: null,
      };
      logInfo(`Сервер виджетов запущён: ${serverStatus.url} (${SERVER_HOST}:${SERVER_PORT})`);
      resolve(serverStatus);
    });
  });
}

function stopLocalServer() {
  return new Promise((resolve) => {
    if (!httpServer || !socketServer) {
      resolve();
      return;
    }

    socketServer.close(() => {
      httpServer.close(() => {
        console.log('Сервер виджетов остановлён.');
        resolve();
      });
    });
  });
}

// Проверка обновлений: при старте и вручную из бэкофиса. Когда обновление
// скачано — предлагаем перезапуститься; при отказе поставится при выходе.
// Все события пишутся в userData/updater.log и отправляются в бэкофис.
function appendUpdaterLog(payload) {
  try {
    const line = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), line);
  } catch {
    /* лог не критичен */
  }
}

let lastUpdaterStatus = null;

function broadcastUpdaterStatus(payload) {
  lastUpdaterStatus = payload;
  appendUpdaterLog(payload);
  mainWindow?.webContents.send('updater:status', payload);
}

// Прямая ссылка на установщик — запасной путь, если автообновление не дошло.
// Адрес раздачи берём оттуда же, откуда его берёт electron-updater.
function getInstallerDownloadUrl(version = '') {
  const base = String(require('./package.json')?.build?.publish?.[0]?.url || '').trim();
  if (!base || !version) {
    return '';
  }

  return `${base.replace(/\/+$/, '')}/TChat-Setup-${version}.exe`;
}

// Патчноуты приложения: локальный файл — то, что есть в этой версии.
function readLocalPatchnotes() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'patchnotes.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch (error) {
    console.error(`[patchnotes] не удалось прочитать: ${error.message}`);
    return [];
  }
}

function installDownloadedUpdate({ clean = false } = {}) {
  if (!autoUpdater) {
    return { ok: false, error: 'модуль обновления недоступен' };
  }

  if (clean) {
    const marked = requestCleanInstall();
    if (!marked.ok) {
      return { ok: false, error: `не удалось пометить чистую установку: ${marked.error}` };
    }
  }

  try {
    // Рестрим и входящие потоки держат ffmpeg — гасим их сами, чтобы установщик не воевал за файлы.
    restream.shutdown();
    incoming.shutdown();
  } catch {
    /* не критично */
  }

  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) {
    return;
  }

  // Версию из update-available запоминаем: событие download-progress её не несёт,
  // а окну обновления нужно показывать «TChat vX» и во время скачивания.
  let pendingUpdateVersion = '';

  autoUpdater.on('checking-for-update', () => broadcastUpdaterStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    pendingUpdateVersion = info?.version || '';
    broadcastUpdaterStatus({
      state: 'available',
      version: pendingUpdateVersion,
      current: app.getVersion(),
      downloadUrl: getInstallerDownloadUrl(pendingUpdateVersion),
    });
  });
  autoUpdater.on('update-not-available', () =>
    broadcastUpdaterStatus({ state: 'none', current: app.getVersion() }),
  );
  autoUpdater.on('download-progress', (progress) =>
    broadcastUpdaterStatus({
      state: 'downloading',
      version: pendingUpdateVersion,
      current: app.getVersion(),
      percent: Math.round(progress?.percent || 0),
      speedKbps: Math.round((progress?.bytesPerSecond || 0) / 1024),
    }),
  );

  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version || pendingUpdateVersion || 'новая версия';
    broadcastUpdaterStatus({
      state: 'downloaded',
      version,
      current: app.getVersion(),
      downloadUrl: getInstallerDownloadUrl(info?.version || pendingUpdateVersion || ''),
    });

    // Бэкоффис показывает своё окно обновления, которое нельзя закрыть мимо.
    // Системный диалог нужен только если бэкоффиса на экране нет — иначе
    // пользователь получил бы два запроса разом.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      return;
    }

    dialog
      .showMessageBox({
        type: 'info',
        title: 'Обновление TChat',
        message: `Скачано обновление ${version}. Установить сейчас?`,
        detail: 'Приложение перезапустится. Если идёт эфир — сначала завершите его.',
        buttons: ['Установить сейчас', 'Позже'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          installDownloadedUpdate();
        }
      })
      .catch(() => {});
  });

  autoUpdater.on('error', (error) => {
    const message = error?.message || String(error);
    console.error('[updater]', message);
    broadcastUpdaterStatus({ state: 'error', message });
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

// «Призрачный» режим по Ctrl+Alt+G: окно чата становится полупрозрачным и
// некликабельным — клики проходят сквозь него в игру. Повторное нажатие возвращает всё как было.
const GHOST_MODE_OPACITY = 0.5;
let ghostModeEnabled = false;

function applyGhostMode(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  targetWindow.setOpacity(ghostModeEnabled ? GHOST_MODE_OPACITY : 1);
  targetWindow.setIgnoreMouseEvents(ghostModeEnabled, { forward: true });
}

// Сообщаем окну чата о призрачном режиме, чтобы оно спрятало шапку
// (оставив только счётчики и сообщения).
function broadcastGhostMode() {
  chatWindow?.webContents.send('ghost:state', ghostModeEnabled);
}

function toggleGhostMode() {
  ghostModeEnabled = !ghostModeEnabled;
  applyGhostMode(chatWindow);
  broadcastGhostMode();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    ...getSavedWindowBounds('backoffice', { width: 920, height: 680 }),
    minWidth: 720,
    minHeight: 520,
    title: 'TChat - бэкоффис',
    autoHideMenuBar: true,
    backgroundColor: '#111315',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Бэкоффис широкий: в окне 920x680 вкладки «Виджеты» и «Рестрим» не влезают.
  // При самом первом открытии разворачиваем на весь экран. Дальше окно ведёт
  // себя как раньше: trackWindowState сам вернёт развёрнутое состояние, если
  // пользователь так его и оставил, и обычный размер, если он окно уменьшил.
  if (!Number.isFinite(Number(windowState.backoffice?.width))) {
    mainWindow.maximize();
  }

  trackWindowState(mainWindow, 'backoffice');
  mainWindow.loadFile(path.join(__dirname, 'backoffice.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    ...getSavedWindowBounds('chatWindow', { width: 520, height: 760 }),
    minWidth: 320,
    minHeight: 420,
    title: 'TChat - чат',
    autoHideMenuBar: true,
    backgroundColor: '#101418',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Поверх всех окон, включая безрамочные полноэкранные игры.
  chatWindow.setAlwaysOnTop(true, 'screen-saver');
  applyGhostMode(chatWindow);

  trackWindowState(chatWindow, 'chatWindow');
  chatWindow.loadFile(path.join(__dirname, 'chat-window.html'));

  chatWindow.webContents.once('did-finish-load', () => {
    chatWindow?.webContents.send('chat:history', getRecentChatMessages());
    broadcastChatStatus();
    broadcastGhostMode();
  });

  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

// Принимает свежий набор фильтров из окна чата и раздаёт его всем виджетам.
// Виджеты сами прячут совпадающие сообщения (и уже показанные, и будущие).
function setChatHiddenFilters(payload = {}) {
  chatHiddenFilters = {
    senders: Array.isArray(payload.senders) ? payload.senders.map(String) : [],
    messages: Array.isArray(payload.messages) ? payload.messages.map(String) : [],
  };
  socketServer?.emit('chat:filters', chatHiddenFilters);
  return chatHiddenFilters;
}

function broadcastChatMessage(message) {
  saveChatMessage(message);
  chatStats.messages += 1;
  chatStats.users.add(`${message.platform}:${message.user}`.toLowerCase());
  registerPollVote(message);
  registerGiveawayParticipant(message);
  registerGiveawayWinnerNickname(message);
  maybeEnqueueFirstMessageAlert(message);
  maybeEnqueuePortalAlert(message);
  socketServer?.emit('chat:message', message);
  mainWindow?.webContents.send('chat:message', message);
  chatWindow?.webContents.send('chat:message', message);
  broadcastChatStatus();
}

function broadcastChatUiSettings() {
  socketServer?.emit('chat:ui-settings', chatUiSettings);
  mainWindow?.webContents.send('chat:ui-settings', chatUiSettings);
  chatWindow?.webContents.send('chat:ui-settings', chatUiSettings);
}

function getChatStatusPayload() {
  const viewerTotal = Object.values(chatStats.viewers).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    messages: chatStats.messages,
    users: chatStats.users.size,
    platforms: Object.values(chatStats.platformStatus).filter((status) => status === 'подключён').length,
    viewers: {
      ...chatStats.viewers,
      total: viewerTotal,
    },
    statuses: chatStats.platformStatus,
    channels: currentChannels,
  };
}

function broadcastChatStatus() {
  const payload = getChatStatusPayload();
  mainWindow?.webContents.send('chat:status', payload);
  chatWindow?.webContents.send('chat:status', payload);
  socketServer?.emit('chat:status', payload);
}

function getDonationAlertsState() {
  return {
    ...donationAlertsState,
    hasToken: Boolean(donationAlertsToken),
  };
}

function broadcastDonationAlertsState() {
  const payload = getDonationAlertsState();
  mainWindow?.webContents.send('donationalerts:state', payload);
  chatWindow?.webContents.send('donationalerts:state', payload);
}

function getAlertQueuePayload() {
  return {
    queue: alertQueue.slice(0, 50),
    settings: alertSettings,
  };
}

function getMusicQueuePayload() {
  return {
    queue: musicQueue
      .filter((item) => item.status !== 'played' && !item.played)
      .slice(0, 50),
    minViews: 5000,
    settings: musicSettings,
  };
}

function broadcastAlertQueue() {
  const payload = getAlertQueuePayload();
  mainWindow?.webContents.send('alerts:queue', payload);
  chatWindow?.webContents.send('alerts:queue', payload);
  socketServer?.emit('alerts:queue', payload);
}

function broadcastMusicQueue() {
  const payload = getMusicQueuePayload();
  mainWindow?.webContents.send('music:queue', payload);
  chatWindow?.webContents.send('music:queue', payload);
  socketServer?.emit('music:queue', payload);
}

function broadcastMusicChatRequest(item) {
  if (!item?.id) {
    return;
  }

  chatWindow?.webContents.send('chat:music-request', item);
  socketServer?.emit('chat:music-request', item);
}

function broadcastGoalState() {
  mainWindow?.webContents.send('goal:state', goalState);
  chatWindow?.webContents.send('goal:state', goalState);
  socketServer?.emit('goal:update', goalState);
}

function updateGoalState(payload = {}) {
  goalState = saveGoalState({
    ...goalState,
    ...payload,
  });
  broadcastGoalState();
  return goalState;
}

// Донат идёт в счётчик только тех сборов, которые сейчас включены. Выключенный
// сбор — это сбор, который не идёт: пока он выключен, донаты мимо него, а не
// копятся втихую, чтобы выскочить цифрой при включении.
function addDonationToGoal(amount) {
  const value = Math.max(Number(amount || 0), 0);
  if (!value) {
    return goalState;
  }

  const goalWidgets = streamWidgets.filter((widget) => widget.type === 'goal');
  const activeGoalWidgets = goalWidgets.filter((widget) => widget.enabled !== false);

  // Отдельный виджет сбора (/widgets/goal.html) живёт своим состоянием: если на
  // рабочей области нет ни одного сбора, он и есть тот самый сбор — считаем.
  // Если сборы есть, но все выключены, счётчик стоит.
  if (!goalWidgets.length || activeGoalWidgets.length) {
    updateGoalState({
      current: Number(goalState.current || 0) + value,
    });
  }

  let hasGoalWidgets = false;
  streamWidgets = streamWidgets.map((widget) => {
    if (widget.type !== 'goal' || widget.enabled === false) {
      return widget;
    }

    hasGoalWidgets = true;
    return normalizeStreamWidget({
      ...widget,
      current: Number(widget.current || 0) + value,
    });
  });

  if (hasGoalWidgets) {
    saveStreamWidgets(streamWidgets);
    broadcastStreamWidgets();
  }

  return goalState;
}

function normalizeFirstMessageGreeting(message = {}) {
  const username = String(message.user || 'Зритель').trim() || 'Зритель';
  return {
    id: `first-message:${getChatDayKey(message.createdAt)}:${getChatUserKey(message)}`,
    platform: message.platform || 'chat',
    username,
    message: `${username} появился в чате`,
    createdAt: message.createdAt || new Date().toISOString(),
    isTest: message.platform === 'demo',
  };
}

function enqueueFirstMessageAlert(message = {}) {
  const normalized = normalizeFirstMessageGreeting(message);
  const rule = getSystemAlertRule('firstMessage');
  if (!rule.enabled) {
    return null;
  }

  const alertItem = {
    id: normalized.id,
    kind: 'firstMessage',
    firstMessage: normalized,
    rule,
    displaySeconds: 3,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);
  socketServer?.emit('alert:play', alertItem);
  broadcastAlertQueue();
  return alertItem;
}

function maybeEnqueueFirstMessageAlert(message = {}) {
  const day = getChatDayKey(message.createdAt);
  if (day !== firstMessageGreetingDay) {
    firstMessageGreetingDay = day;
    firstMessageGreetingUsers.clear();
  }

  const userKey = getChatUserKey(message);
  if (firstMessageGreetingUsers.has(userKey)) {
    return null;
  }

  firstMessageGreetingUsers.add(userKey);
  return enqueueFirstMessageAlert(message);
}

// «Пришёл из портала» — сервисное сообщение ChatBot о зрителе, занесённом порталом VK.
const PORTAL_MESSAGE_REGEX = /^(.+?)\s+приш(?:[её]л|ла)\s+из\s+портала!?$/i;

function buildPortalGreeting(username) {
  return (
    `Привет, ${username}! Тебя занесло весьма удачно - у нас тут весело и лампово!\n` +
    'Жми "отслеживать" и плюхайся на диван'
  );
}

function normalizePortalGuest(payload = {}) {
  const username = String(payload.username || 'Зритель').trim() || 'Зритель';
  return {
    id: `portal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    platform: payload.platform || 'chat',
    username,
    message: buildPortalGreeting(username),
    createdAt: payload.createdAt || new Date().toISOString(),
    isTest: payload.platform === 'demo',
  };
}

function enqueuePortalAlert(payload = {}) {
  const normalized = normalizePortalGuest(payload);
  const rule = getSystemAlertRule('portal');
  if (!rule.enabled) {
    return null;
  }

  const alertItem = {
    id: normalized.id,
    kind: 'portal',
    portal: normalized,
    rule,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);
  socketServer?.emit('alert:play', alertItem);
  broadcastAlertQueue();
  return alertItem;
}

function maybeEnqueuePortalAlert(message = {}) {
  if (String(message.user || '').trim().toLowerCase() !== 'chatbot') {
    return null;
  }

  const match = String(message.text || '').trim().match(PORTAL_MESSAGE_REGEX);
  if (!match) {
    return null;
  }

  return enqueuePortalAlert({
    username: match[1].trim(),
    platform: message.platform,
    createdAt: message.createdAt,
  });
}

function enqueueSubscriberAlert(subscriber = {}) {
  const normalized = normalizeSubscriber(subscriber);
  const rule = getSystemAlertRule('subscriber');
  if (!rule.enabled) {
    return null;
  }

  const alertItem = {
    id: normalized.id,
    kind: 'subscriber',
    subscriber: normalized,
    rule,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);

  if (!normalized.isTest) {
    socketServer?.emit('subscriber:alert', normalized);
    socketServer?.emit('alert:play', alertItem);
  }

  broadcastAlertQueue();
  return alertItem;
}

function enqueueSubscriptionRenewalAlert(renewal = {}) {
  const normalized = normalizeSubscriptionRenewal(renewal);
  const rule = getSystemAlertRule('subscriptionRenewal');
  if (!rule.enabled) {
    return null;
  }

  const alertItem = {
    id: normalized.id,
    kind: 'subscriptionRenewal',
    renewal: normalized,
    rule,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);

  if (!normalized.isTest) {
    socketServer?.emit('subscription-renewal:alert', normalized);
    socketServer?.emit('alert:play', alertItem);
  }

  broadcastAlertQueue();
  return alertItem;
}

function enqueueRaidAlert(raid = {}) {
  const normalized = normalizeRaid(raid);
  const rule = getSystemAlertRule('raid');
  if (!rule.enabled) {
    return null;
  }

  const alertItem = {
    id: normalized.id,
    kind: 'raid',
    raid: normalized,
    rule,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);

  if (!normalized.isTest) {
    socketServer?.emit('raid:alert', normalized);
    socketServer?.emit('alert:play', alertItem);
  }

  broadcastAlertQueue();
  return alertItem;
}

function getSystemAlertRule(type) {
  return normalizeSystemAlertRule(alertSettings.systemAlerts?.[type], createDefaultAlertSettings().systemAlerts[type]);
}

function normalizeSubscriber(payload = {}) {
  return {
    id: String(payload.id || `sub-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    platform: payload.platform || 'demo',
    username: payload.username || 'Зритель',
    message: payload.message || 'подписался на канал',
    createdAt: payload.createdAt || new Date().toISOString(),
    isTest: Boolean(payload.isTest),
  };
}

function normalizeSubscriptionRenewal(payload = {}) {
  return {
    id: String(payload.id || `renewal-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    platform: payload.platform || 'demo',
    username: payload.username || 'Зритель',
    tier: String(payload.tier || '').trim(),
    months: Math.max(Number(payload.months || 0), 0),
    message: payload.message || 'продлил подписку',
    createdAt: payload.createdAt || new Date().toISOString(),
    isTest: Boolean(payload.isTest),
  };
}

function normalizeRaid(payload = {}) {
  return {
    id: String(payload.id || `raid-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    platform: payload.platform || 'demo',
    username: payload.username || 'Зритель',
    viewers: Math.max(Number(payload.viewers || 0), 0),
    message: payload.message || 'привёл рейд',
    createdAt: payload.createdAt || new Date().toISOString(),
    isTest: Boolean(payload.isTest),
  };
}

function enqueueDonationAlert(donation) {
  const normalizedDonation = normalizeDonation(donation);
  addDonationToGoal(normalizedDonation.amount);
  const musicLinks = extractMusicLinks(normalizedDonation.message || '');

  if (musicLinks.length) {
    enqueueMusicDonation(normalizedDonation, musicLinks[0]).catch((error) => {
      console.error(`Не удалось обработать музыкальный донат: ${error.message}`);
    });
    return null;
  }

  const classification = classifyDonationAlert(normalizedDonation);
  const alertItem = {
    id: normalizedDonation.id || `donation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: 'donation',
    donation: normalizedDonation,
    rule: classification.rule,
    reason: classification.reason,
    isMusic: classification.isMusic,
    musicLinks: classification.musicLinks,
    played: false,
    queuedAt: new Date().toISOString(),
  };

  alertQueue.unshift(alertItem);
  alertQueue = alertQueue.slice(0, 100);

  if (!normalizedDonation.isTest || normalizedDonation.showInChat) {
    socketServer?.emit('donation:alert', normalizedDonation);
  }

  if (normalizedDonation.showInChat) {
    donationAlertsState = {
      ...donationAlertsState,
      donations: [
        {
          ...normalizedDonation,
          isNew: true,
          played: false,
        },
        ...donationAlertsState.donations.filter((donation) => donation.id !== normalizedDonation.id),
      ].slice(0, 30),
    };
    broadcastDonationAlertsState();
  }

  if (!normalizedDonation.isTest || normalizedDonation.showInChat) {
    chatWindow?.webContents.send('chat:donation-alert', alertItem);
  }

  socketServer?.emit('alert:play', alertItem);
  broadcastAlertQueue();
  return alertItem;
}

async function enqueueMusicDonation(donation, url, options = {}) {
  const skipViewsCheck = options.skipViewsCheck === true;
  const musicItem = {
    id: donation.id || `music-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: 'music',
    donation,
    url,
    embedUrl: '',
    platform: detectMusicPlatform(url),
    title: 'Музыкальная заявка',
    views: 0,
    minViews: 5000,
    status: 'checking',
    reason: '',
    played: false,
    manual: skipViewsCheck,
    queuedAt: new Date().toISOString(),
  };

  musicQueue.push(musicItem);
  musicQueue = musicQueue.slice(0, 100);
  broadcastMusicQueue();

  const metadata = await fetchMusicMetadata(url);
  musicQueue = musicQueue.map((item) => {
    if (item.id !== musicItem.id) {
      return item;
    }

    const hasVerifiedViews = metadata.views !== null && metadata.views !== undefined && Number.isFinite(Number(metadata.views));
    const isAllowed = skipViewsCheck || !hasVerifiedViews || Number(metadata.views) >= musicItem.minViews;
    return {
      ...item,
      ...metadata,
      viewsVerified: skipViewsCheck ? false : hasVerifiedViews,
      status: isAllowed ? 'ready' : 'rejected',
      reason: isAllowed ? '' : 'Недостаточно просмотров',
    };
  });

  const readyItem = musicQueue.find((item) => item.id === musicItem.id && item.status === 'ready');
  const resolvedItem = musicQueue.find((item) => item.id === musicItem.id) || musicItem;
  broadcastMusicQueue();
  broadcastMusicChatRequest(resolvedItem);

  if (readyItem) {
    socketServer?.emit('music:play', { ...readyItem, force: !musicQueue.some((item) => item.status === 'ready' && !item.played && item.id !== readyItem.id) });
  }
}

function markMusicStarted(id) {
  if (!id) {
    return;
  }

  startedMusicIds.add(id);
  const startedAt = new Date().toISOString();
  musicQueue = musicQueue.map((item) =>
    item.id === id && item.status !== 'played'
      ? { ...item, status: 'playing', startedAt: item.startedAt || startedAt }
      : item,
  );
  broadcastMusicQueue();
}

function markMusicPlayed(id) {
  if (!id) {
    return;
  }

  const nextQueue = musicQueue.filter((item) => item.id !== id);

  if (nextQueue.length === musicQueue.length) {
    return;
  }

  musicQueue = nextQueue;
  startedMusicIds.delete(id);
  broadcastMusicQueue();
}

function updateMusicTitle(id, title) {
  const normalizedTitle = cleanupTitle(title).slice(0, 300);
  if (!id || !isUsableMusicTitle(normalizedTitle)) {
    return;
  }

  let changed = false;
  musicQueue = musicQueue.map((item) => {
    if (item.id !== id || item.title === normalizedTitle) {
      return item;
    }

    changed = true;
    return { ...item, title: normalizedTitle };
  });

  if (changed) {
    broadcastMusicQueue();
  }
}

function finalizePlayingMusicOnWidgetBootstrap() {
  const idsToRemove = new Set();

  for (const item of musicQueue) {
    if (item.status === 'playing' || startedMusicIds.has(item.id)) {
      idsToRemove.add(item.id);
      startedMusicIds.delete(item.id);
    }
  }

  if (!idsToRemove.size) {
    return;
  }

  musicQueue = musicQueue.filter((item) => !idsToRemove.has(item.id));
  broadcastMusicQueue();
}

async function addManualMusicUrl(payload = {}) {
  const url = String(payload.url || '').trim();

  if (!url) {
    throw new Error('Ссылка на музыку не задана');
  }

  const musicLinks = extractMusicLinks(url);

  if (!musicLinks.length) {
    throw new Error('Поддерживаются ссылки YouTube, VK Видео и Rutube');
  }

  await enqueueMusicDonation(
    {
      id: `manual-music-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      username: payload.username || 'Бэкоффис',
      amount: 0,
      currency: 'RUB',
      message: url,
      createdAt: new Date().toISOString(),
    },
    musicLinks[0],
    { skipViewsCheck: true },
  );

  return getMusicQueuePayload();
}

function removeMusicItem(id) {
  if (!id) {
    return getMusicQueuePayload();
  }

  musicQueue = musicQueue.filter((item) => item.id !== id);
  broadcastMusicQueue();
  return getMusicQueuePayload();
}

function removeDonationAlert(id) {
  if (!id) {
    return getDonationAlertsState();
  }

  alertQueue = alertQueue.filter((item) => item.id !== id && item.donation?.id !== id);
  donationAlertsState = {
    ...donationAlertsState,
    donations: donationAlertsState.donations.filter((donation) => donation.id !== id),
  };
  broadcastDonationAlertsState();
  broadcastAlertQueue();
  return getDonationAlertsState();
}

function markAlertPlayed(id) {
  if (!id) {
    return;
  }

  alertQueue = alertQueue.map((item) => (item.id === id ? { ...item, played: true, playedAt: new Date().toISOString() } : item));
  donationAlertsState = {
    ...donationAlertsState,
    donations: donationAlertsState.donations.map((donation) => (donation.id === id ? { ...donation, played: true } : donation)),
  };
  broadcastDonationAlertsState();
  broadcastAlertQueue();
}

function classifyDonationAlert(donation) {
  const rules = alertSettings.rules.filter((rule) => rule.enabled);
  const amount = Number(donation.amount || 0);
  const exactAmountRule = rules.find((rule) => rule.type === 'amount' && Number(rule.amount) === amount);
  const nicknameRule = rules.find((rule) => rule.type === 'nickname' && sameText(rule.nickname, donation.username));
  const intervalRule = rules.find((rule) => {
    if (rule.type !== 'interval') {
      return false;
    }

    const min = rule.min === '' ? 0 : Number(rule.min || 0);
    const max = rule.max === '' ? Number.POSITIVE_INFINITY : Number(rule.max || 0);
    return amount >= min && amount <= max;
  });
  const fallbackRule = {
    id: 'fallback',
    type: 'fallback',
    title: 'Обычный донат',
    image: '',
    sound: '',
  };
  const selectedRule = exactAmountRule || nicknameRule || intervalRule || fallbackRule;

  return {
    rule: selectedRule,
    reason: exactAmountRule ? 'amount' : nicknameRule ? 'nickname' : intervalRule ? 'interval' : 'fallback',
    isMusic: false,
    musicLinks: [],
  };
}

function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function extractMusicLinks(text = '') {
  const urlMatches = String(text).match(/https?:\/\/[^\s<>"']+/gi) || [];
  const musicDomains = /(youtube\.com|youtu\.be|rutube\.ru|vk\.com\/video|vkvideo\.ru\/video|vk\.com\/clip|vkvideo\.ru\/clip)/i;
  return urlMatches.filter((url) => musicDomains.test(url));
}

function detectMusicPlatform(url = '') {
  if (/youtu\.be|youtube\.com/i.test(url)) return 'youtube';
  if (/rutube\.ru/i.test(url)) return 'rutube';
  if (/vk\.com|vkvideo\.ru/i.test(url)) return 'vk';
  return 'unknown';
}

async function fetchMusicMetadata(url) {
  const platform = detectMusicPlatform(url);
  const fallback = createMusicMetadataFallback(url, platform);

  try {
    let metadata = fallback;

    if (platform === 'youtube') metadata = await fetchYouTubeMusicMetadata(url);
    if (platform === 'rutube') metadata = await fetchRutubeMusicMetadata(url);
    if (platform === 'vk') metadata = await fetchVkMusicMetadata(url);

    return normalizeMusicMetadata(fallback, metadata);
  } catch {
    return fallback;
  }
}

function createMusicMetadataFallback(url, platform = detectMusicPlatform(url)) {
  return {
    platform,
    title: formatFallbackMusicTitle(url, platform),
    views: null,
    viewsVerified: false,
    duration: null,
    embedUrl: buildMusicEmbedUrl(url, platform),
  };
}

function normalizeMusicMetadata(fallback, metadata = {}) {
  const views = metadata.views === undefined ? fallback.views : metadata.views;
  const title = isUsableMusicTitle(metadata.title) ? metadata.title : fallback.title;
  const duration = Number(metadata.duration || fallback.duration || 0);
  return {
    ...fallback,
    ...metadata,
    title,
    views,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    viewsVerified: views !== null && views !== undefined && Number.isFinite(Number(views)),
    embedUrl: metadata.embedUrl || fallback.embedUrl,
  };
}

function extractYouTubeDuration(html = '') {
  const seconds = String(html).match(/"lengthSeconds":"(\d+)"/)?.[1];
  if (seconds) {
    return Number(seconds);
  }

  const milliseconds = String(html).match(/"approxDurationMs":"(\d+)"/)?.[1];
  return milliseconds ? Math.round(Number(milliseconds) / 1000) : null;
}

function extractVkDuration(html = '') {
  return extractFirstNumber(String(html), [/"duration"\s*:\s*(\d+)/, /"videoDuration"\s*:\s*(\d+)/]);
}

function buildMusicEmbedUrl(url = '', platform = detectMusicPlatform(url)) {
  if (platform === 'youtube') {
    const videoId = extractYouTubeVideoId(url);
    return videoId ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&playsinline=1` : url;
  }

  if (platform === 'rutube') {
    const videoId = extractRutubeVideoId(url);
    return videoId ? `https://rutube.ru/play/embed/${videoId}?autoplay=true&autostartmute=false` : url;
  }

  if (platform === 'vk') {
    const videoParts = extractVkVideoParts(url);
    return videoParts ? `https://vk.com/video_ext.php?oid=${videoParts.oid}&id=${videoParts.id}&autoplay=1&js_api=1&muted=1` : url;
  }

  return url;
}

function formatFallbackMusicTitle(url = '', platform = detectMusicPlatform(url)) {
  if (platform === 'youtube') {
    const videoId = extractYouTubeVideoId(url);
    return videoId ? `YouTube - ${videoId}` : 'YouTube';
  }

  if (platform === 'rutube') {
    const videoId = extractRutubeVideoId(url);
    return videoId ? `Rutube - ${videoId}` : 'Rutube';
  }

  if (platform === 'vk') {
    const videoParts = extractVkVideoParts(url);
    return videoParts ? `VK Видео - video${videoParts.oid}_${videoParts.id}` : 'VK Видео';
  }

  return url || 'Музыкальная заявка';
}

function extractTitleFromHtml(html = '', fallback = '') {
  const patterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title>(.*?)<\/title>/i,
    /"title"\s*:\s*"([^"]+)"/,
  ];

  for (const pattern of patterns) {
    const match = String(html).match(pattern);
    if (match?.[1]) {
      return cleanupTitle(match[1]);
    }
  }

  return fallback;
}

function isUsableMusicTitle(title = '') {
  const value = String(title || '').trim();
  return Boolean(value) && !/^https?:\/\//i.test(value) && !/^(YouTube|Rutube|VK Видео)$/i.test(value);
}

async function fetchTextWithTimeout(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

const VK_API_BASE = 'https://api.live.vkvideo.ru/v1';
const VK_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://live.vkvideo.ru/',
};

async function fetchJsonWithTimeout(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...VK_FETCH_HEADERS,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('таймаут запроса');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms = 1000) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isVkTransientError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();

  return (
    message.includes('fetch failed') ||
    message.includes('таймаут') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enetunreach') ||
    message.includes('socket hang up') ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
  );
}

function formatVkFetchError(error) {
  const code = error?.cause?.code || error?.code;
  if (code) {
    return String(code);
  }

  return String(error?.message || error || 'неизвестная ошибка');
}

async function fetchJsonWithRetry(url, timeoutMs = 20000, options = {}, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, timeoutMs, options);
    } catch (error) {
      lastError = error;
      if (!isVkTransientError(error) || attempt >= attempts) {
        throw error;
      }

      await delay(attempt * 1000);
    }
  }

  throw lastError || new Error('VK API недоступен');
}

function rememberVkMessageId(id) {
  chatStats.vkMessageIds.add(id);

  if (chatStats.vkMessageIds.size <= 5000) {
    return;
  }

  chatStats.vkMessageIds = new Set([...chatStats.vkMessageIds].slice(-3000));
}

function getVkPlatformStatus(chatAvailable = false) {
  if (vkConnectionState.consecutiveFailures > 5) {
    return `ошибка: ${vkConnectionState.lastError || 'VK Live недоступен'}`;
  }

  if (vkConnectionState.consecutiveFailures > 0) {
    return `переподключение... (${vkConnectionState.consecutiveFailures})`;
  }

  return chatAvailable ? 'подключён' : 'чат VK недоступен';
}

function unwrapVkStreamPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  if (payload.count || payload.hasChat !== undefined || payload.isOnline !== undefined || payload.title) {
    return payload;
  }

  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }

  return payload;
}

function extractVkViewerCount(stream = {}) {
  const topLevel = Number(stream?.count?.viewers);
  if (Number.isFinite(topLevel) && topLevel > 0) {
    return topLevel;
  }

  const sources = stream?.count?.sources;
  if (Array.isArray(sources)) {
    const fromSources = sources.reduce((sum, source) => sum + Number(source?.viewers || 0), 0);
    if (fromSources > 0) {
      return fromSources;
    }
  }

  return Number.isFinite(topLevel) ? Math.max(topLevel, 0) : 0;
}

async function fetchVkViewerCount(channelUrl) {
  const slug = parseVkChannelSlug(channelUrl);
  if (!slug) {
    return 0;
  }

  const streamPath = `/blog/${encodeURIComponent(slug)}/public_video_stream`;
  const payload = await fetchJsonWithRetry(`${VK_API_BASE}${streamPath}`, 15000, {}, 2);
  const stream = unwrapVkStreamPayload(payload);
  return extractVkViewerCount(stream);
}

function parseVkChannelSlug(channelUrl = '') {
  const raw = String(channelUrl || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    return url.pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    const match = raw.match(/live\.vkvideo\.ru\/([^/?#]+)/i);
    return (match?.[1] || raw.replace(/^\/+|\/+$/g, '')).trim();
  }
}

async function fetchYouTubeMusicMetadata(url) {
  const videoId = extractYouTubeVideoId(url);
  const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  let html = '';
  let views = null;
  let title = await fetchYouTubeOEmbedTitle(watchUrl).catch(() => '');

  try {
    html = await fetchTextWithTimeout(watchUrl);
    views = extractFirstNumber(html, [/"viewCount":"(\d+)"/, /"views":"(\d+)"/]);
  } catch {
    html = '';
  }

  if (!isUsableMusicTitle(title)) {
    title = extractTitleFromHtml(html, 'YouTube');
  }

  return {
    platform: 'youtube',
    title,
    views,
    duration: extractYouTubeDuration(html),
    embedUrl: buildMusicEmbedUrl(url, 'youtube'),
  };
}

async function fetchRutubeMusicMetadata(url) {
  const html = await fetchTextWithTimeout(url);
  const views = extractFirstNumber(html, [/"views"\s*:\s*(\d+)/, /"hits"\s*:\s*(\d+)/, /"viewCount"\s*:\s*(\d+)/]);

  return {
    platform: 'rutube',
    title: extractTitleFromHtml(html, 'Rutube'),
    views,
    embedUrl: buildMusicEmbedUrl(url, 'rutube'),
  };
}

async function fetchVkMusicMetadata(url) {
  const html = await fetchTextWithTimeout(url);
  const views = extractFirstNumber(html, [/"views"\s*:\s*(\d+)/, /"count"\s*:\s*\{"views"\s*:\s*(\d+)/, /(\d[\d\s.,]*)\s+просмотр/i]);

  return {
    platform: 'vk',
    title: extractTitleFromHtml(html, 'VK Видео'),
    views,
    duration: extractVkDuration(html),
    embedUrl: buildMusicEmbedUrl(url, 'vk'),
  };
}

async function fetchYouTubeOEmbedTitle(watchUrl) {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const payload = JSON.parse(await fetchTextWithTimeout(endpoint));
  return cleanupTitle(payload.title || '');
}

function extractYouTubeVideoId(url = '') {
  const value = String(url);
  return value.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)?.[1] || value.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1] || value.match(/\/shorts\/([a-zA-Z0-9_-]{11})/)?.[1] || '';
}

function extractRutubeVideoId(url = '') {
  return String(url).match(/rutube\.ru\/video\/([a-zA-Z0-9]+)/i)?.[1] || String(url).match(/rutube\.ru\/play\/embed\/([a-zA-Z0-9]+)/i)?.[1] || '';
}

function extractVkVideoParts(url = '') {
  const match = String(url).match(/video(-?\d+)_(\d+)/i) || String(url).match(/clip(-?\d+)_(\d+)/i);
  return match ? { oid: match[1], id: match[2] } : null;
}

function extractFirstNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) {
      return Number(String(match[1]).replace(/\D/g, '') || 0);
    }
  }

  return null;
}

function cleanupTitle(title = '') {
  return String(title)
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+-\s+YouTube$/i, '')
    .replace(/\s+-\s+смотреть видео онлайн.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function updateDonationAlertsCredentials(credentials = {}) {
  donationAlertsClientId = String(credentials.clientId || donationAlertsClientId || '').trim();
  donationAlertsClientSecret = String(credentials.clientSecret || donationAlertsClientSecret || '').trim();
  saveDonationAlertsSettings();
}

function getDonationAlertsCredentials() {
  return {
    clientId: donationAlertsClientId,
    clientSecret: donationAlertsClientSecret,
    redirectUri: DONATION_ALERTS_REDIRECT_URI,
  };
}

function getDonationAlertsAuthUrl(credentials = {}) {
  updateDonationAlertsCredentials(credentials);
  if (!donationAlertsClientId) {
    throw new Error('ID приложения DonationAlerts не задан');
  }

  const redirectUri = DONATION_ALERTS_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: donationAlertsClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DONATION_ALERTS_SCOPE,
  });

  return `https://www.donationalerts.com/oauth/authorize?${params.toString()}`;
}

async function exchangeDonationAlertsCode(code) {
  if (!donationAlertsClientId || !donationAlertsClientSecret) {
    throw new Error('ID приложения или секрет DonationAlerts не задан');
  }

  const redirectUri = DONATION_ALERTS_REDIRECT_URI;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: donationAlertsClientId,
    client_secret: donationAlertsClientSecret,
    redirect_uri: redirectUri,
    code,
  });
  const response = await fetch('https://www.donationalerts.com/oauth/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error_description || payload.message || `HTTP ${response.status}`);
  }

  donationAlertsToken = String(payload.access_token || '').trim();
  donationAlertsRefreshToken = String(payload.refresh_token || '').trim();
  saveDonationAlertsSettings();
  startDonationAlertsSync(donationAlertsToken);
}

function getDonationAlertsOauthPage() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>TChat - DonationAlerts</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111418;
        color: #eef2f5;
        font-family: "Segoe UI", Arial, sans-serif;
      }

      main {
        max-width: 560px;
        border: 1px solid #27313a;
        border-radius: 8px;
        background: #181e24;
        padding: 24px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: 24px;
      }

      p {
        margin: 0;
        color: #cbd5df;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>DonationAlerts подключается</h1>
      <p id="state">Получаем токен и передаём его в TChat.</p>
    </main>
    <script>
      const state = document.querySelector('#state');
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const token = params.get('access_token');

      if (!token) {
        state.textContent = 'Токен не найден. Вернитесь в бэкоффис и попробуйте ещё раз.';
      } else {
        fetch('/oauth/donationalerts/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
          .then((response) => response.json())
          .then(() => {
            localStorage.setItem('tchat.donationAlertsToken', token);
            state.textContent = 'Готово. Токен сохранён, синхронизация донатов запущена. Это окно можно закрыть.';
          })
          .catch((error) => {
            state.textContent = 'Не удалось передать токен в TChat: ' + error.message;
          });
      }
    </script>
  </body>
</html>`;
}

function getDonationAlertsOauthResultPage(message) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>TChat - DonationAlerts</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111418;
        color: #eef2f5;
        font-family: "Segoe UI", Arial, sans-serif;
      }

      main {
        max-width: 560px;
        border: 1px solid #27313a;
        border-radius: 8px;
        background: #181e24;
        padding: 24px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: 24px;
      }

      p {
        margin: 0;
        color: #cbd5df;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>DonationAlerts</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function startDonationAlertsSync(token) {
  const nextToken = String(token || '').trim();
  clearInterval(donationAlertsTimer);
  donationAlertsToken = nextToken;
  saveDonationAlertsSettings();
  donationAlertsBootstrapped = false;
  donationAlertsIds.clear();

  if (!donationAlertsToken) {
    donationAlertsState = {
      status: 'токен не задан',
      lastSyncAt: '',
      error: '',
      donations: [],
    };
    broadcastDonationAlertsState();
    return getDonationAlertsState();
  }

  donationAlertsState = {
    ...donationAlertsState,
    status: 'синхронизируем',
    error: '',
  };
  broadcastDonationAlertsState();
  syncDonationAlerts();
  donationAlertsTimer = setInterval(syncDonationAlerts, 30000);
  return getDonationAlertsState();
}

async function syncDonationAlerts() {
  if (!donationAlertsToken) {
    return;
  }

  try {
    const response = await fetch('https://www.donationalerts.com/api/v1/alerts/donations', {
      headers: {
        Authorization: `Bearer ${donationAlertsToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const donations = (Array.isArray(payload?.data) ? payload.data : [])
      .map(normalizeDonationAlert)
      .filter((donation) => donation.id);
    const newDonations = [];

    for (const donation of donations) {
      if (!donationAlertsIds.has(donation.id)) {
        donationAlertsIds.add(donation.id);

        if (donationAlertsBootstrapped) {
          donation.isNew = true;
          newDonations.push(donation);
        }
      }
    }

    const previousById = new Map(donationAlertsState.donations.map((donation) => [donation.id, donation]));
    const testDonations = donationAlertsState.donations.filter((donation) => donation.isTest && donation.showInChat);
    donationAlertsState = {
      status: 'подключён',
      lastSyncAt: new Date().toISOString(),
      error: '',
      donations: [
        ...testDonations,
        ...donations.slice(0, 30).map((donation) => ({
          ...donation,
          isNew: Boolean(newDonations.find((newDonation) => newDonation.id === donation.id) || previousById.get(donation.id)?.isNew),
          played: Boolean(previousById.get(donation.id)?.played || alertQueue.find((item) => item.id === donation.id)?.played),
        })),
      ].slice(0, 30),
    };
    donationAlertsBootstrapped = true;

    for (const donation of newDonations) {
      enqueueDonationAlert(donation);
    }

    broadcastDonationAlertsState();
  } catch (error) {
    donationAlertsState = {
      ...donationAlertsState,
      status: 'ошибка синхронизации',
      error: error.message,
      lastSyncAt: new Date().toISOString(),
    };
    console.error(`DonationAlerts не синхронизирован: ${error.message}`);
    broadcastDonationAlertsState();
  }
}

function normalizeDonationAlert(item = {}) {
  const amount = Number(item.amount || item.amount_in_user_currency || 0);

  return {
    id: String(item.id || item.alert_id || item.created_at || ''),
    username: item.username || item.name || item.user?.name || 'Зритель',
    amount,
    currency: item.currency || item.currency_code || 'RUB',
    message: item.message || '',
    createdAt: item.created_at || item.createdAt || new Date().toISOString(),
    isNew: false,
  };
}

function normalizeChatMessage(payload = {}) {
  const platform = payload.platform || 'demo';
  const text = payload.text || 'Пустое сообщение';

  return {
    platform,
    platformIcon: payload.platformIcon || getPlatformIconUrl(platform),
    user: payload.user || 'Гость',
    text,
    parts: normalizeMessageParts(text, payload.parts),
    badges: Array.isArray(payload.badges) ? payload.badges : [],
    createdAt: payload.createdAt || new Date().toISOString(),
  };
}

function parseTwitchChannel(value = '') {
  const trimmedValue = String(value).trim();

  if (!trimmedValue) {
    return '';
  }

  try {
    const url = new URL(trimmedValue);
    const pathParts = url.pathname.split('/').filter(Boolean);
    return (pathParts[0] || '').replace(/^@/, '').toLowerCase();
  } catch {
    return trimmedValue.replace(/^@/, '').replace(/^#/, '').toLowerCase();
  }
}

async function connectChatSources(channels = currentChannels) {
  const previousVkChannel = currentChannels.vk;
  currentChannels = {
    ...currentChannels,
    ...channels,
  };

  if (previousVkChannel !== currentChannels.vk) {
    vkChatBootstrapped = false;
    vkConnectionState = {
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastViewers: 0,
      lastChatAvailable: false,
      lastError: '',
      lastChatMessageId: 0,
    };
    chatStats.vkMessageIds = new Set();
  }

  await connectTwitchChat(parseTwitchChannel(currentChannels.twitch));
  await connectYouTubeChat(currentChannels.youtube);
  await connectRutubeChat(currentChannels.rutube);
  await refreshViewerCounts();
  await pollVkChat();
  broadcastChatStatus();
}

async function connectTwitchChat(channel) {
  if (twitchClient) {
    try {
      await twitchClient.disconnect();
    } catch (error) {
      console.error(`Не удалось отключить старый Twitch-чат: ${error.message}`);
    }
  }

  if (!channel) {
    chatStats.platformStatus.twitch = 'канал не задан';
    broadcastChatStatus();
    return;
  }

  chatStats.platformStatus.twitch = 'подключаем';
  broadcastChatStatus();

  twitchClient = new tmi.Client({
    connection: {
      reconnect: true,
      secure: true,
    },
    channels: [channel],
  });

  twitchClient.on('connected', () => {
    chatStats.platformStatus.twitch = 'подключён';
    console.log(`Twitch-чат подключён: ${channel}`);
    broadcastChatStatus();
  });

  twitchClient.on('disconnected', (reason) => {
    chatStats.platformStatus.twitch = `отключён: ${reason || 'причина неизвестна'}`;
    console.log(`Twitch-чат отключён: ${reason || 'причина неизвестна'}`);
    broadcastChatStatus();
  });

  twitchClient.on('message', (_channel, tags, message, self) => {
    if (self) {
      return;
    }

    createTwitchMessage(tags, message)
      .then((chatMessage) => broadcastChatMessage(chatMessage))
      .catch((error) => console.error(`Не удалось обработать Twitch-сообщение: ${error.message}`));
  });

  twitchClient.on('subscription', (_channel, username, _methods, message) => {
    enqueueSubscriberAlert({
      id: `twitch:sub:${username}:${Date.now()}`,
      platform: 'twitch',
      username,
      message: message || 'оформил подписку',
    });
  });

  twitchClient.on('resub', (_channel, username, months, message) => {
    enqueueSubscriptionRenewalAlert({
      id: `twitch:renewal:${username}:${Date.now()}`,
      platform: 'twitch',
      username,
      months: Number(months || 0),
      message: message || 'продлил подписку',
    });
  });

  twitchClient.on('subgift', (_channel, username, _streakMonths, recipient) => {
    enqueueSubscriberAlert({
      id: `twitch:gift:${recipient}:${Date.now()}`,
      platform: 'twitch',
      username: recipient,
      message: `получил подарочную подписку от ${username}`,
    });
  });

  twitchClient.on('raided', (_channel, username, viewers) => {
    enqueueRaidAlert({
      id: `twitch:raid:${username}:${Date.now()}`,
      platform: 'twitch',
      username,
      viewers,
      message: `рейд на ${viewers || 0} зрителей`,
    });
  });

  try {
    await twitchClient.connect();
  } catch (error) {
    chatStats.platformStatus.twitch = `ошибка: ${error.message}`;
    console.error(`Twitch-чат не подключён: ${error.message}`);
    broadcastChatStatus();
  }
}

async function connectYouTubeChat(channelUrl) {
  if (youtubeClient) {
    youtubeClient.stop();
    youtubeClient = null;
  }

  if (!channelUrl) {
    chatStats.platformStatus.youtube = 'канал не задан';
    broadcastChatStatus();
    return;
  }

  chatStats.platformStatus.youtube = 'подключаем';
  broadcastChatStatus();

  try {
    const liveId = await resolveYouTubeLiveId(channelUrl);

    if (!liveId) {
      chatStats.platformStatus.youtube = 'эфир не найден';
      broadcastChatStatus();
      return;
    }

    youtubeClient = new LiveChat({ liveId });
    youtubeClient.on('start', () => {
      chatStats.platformStatus.youtube = 'подключён';
      broadcastChatStatus();
    });
    youtubeClient.on('end', (reason) => {
      chatStats.platformStatus.youtube = `отключён: ${reason || 'эфир завершён'}`;
      broadcastChatStatus();
    });
    youtubeClient.on('error', (error) => {
      chatStats.platformStatus.youtube = `ошибка: ${error.message || error}`;
      broadcastChatStatus();
    });
    youtubeClient.on('chat', async (chatItem) => {
      const parts = await buildYouTubeMessageParts(chatItem.message || []);
      const text = parts.map((part) => part.text || part.alt || '').join('');
      const badges = await buildYouTubeBadges(chatItem);

      broadcastChatMessage({
        platform: 'youtube',
        platformIcon: getPlatformIconUrl('youtube'),
        user: chatItem.author?.name || 'Зритель',
        text,
        parts,
        badges,
        createdAt: (chatItem.timestamp || new Date()).toISOString(),
      });
    });

    const ok = await youtubeClient.start();
    if (!ok) {
      chatStats.platformStatus.youtube = 'не удалось подключить';
      broadcastChatStatus();
    }
  } catch (error) {
    chatStats.platformStatus.youtube = `ошибка: ${error.message}`;
    broadcastChatStatus();
  }
}

// Роли, которые мы выводим текстовой буквой, и слова, которыми ту же роль
// называет сама площадка в своих картинках-бейджах.
const BADGE_ROLE_ALIASES = {
  owner: ['owner', 'broadcaster', 'streamer'],
  moderator: ['moderator', 'mod'],
  verified: ['verified'],
  member: ['member', 'subscriber'],
};

// Площадки присылают свои картинки-бейджи (у VK модератор — меч, владелец —
// корона), а мы поверх этого добавляли свою букву роли. В итоге у модератора в
// чате висели и «M», и меч, у владельца — «O» и корона: одно и то же дважды.
// Оставляем картинку площадки, а свою букву показываем, только если картинки
// для этой роли нет.
function dropRolesCoveredByImages(roleBadges, imageBadges) {
  const covered = (role) => {
    const aliases = BADGE_ROLE_ALIASES[role] || [role];
    return imageBadges.some((badge) => {
      const label = String(badge.label || '').toLowerCase();
      return Boolean(badge.url) && aliases.some((alias) => label.includes(alias));
    });
  };
  return roleBadges.filter((badge) => !covered(String(badge.label || '').toLowerCase()));
}

// Убирает повторы: одна и та же картинка или одна и та же роль дважды.
function dedupeBadges(badges) {
  const seen = new Set();
  return badges.filter((badge) => {
    const key = badge.url ? `url:${badge.url}` : `label:${String(badge.label || '').toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function buildYouTubeBadges(chatItem) {
  const roleBadges = [
    chatItem.isOwner ? { label: 'owner' } : null,
    chatItem.isModerator ? { label: 'moderator' } : null,
    chatItem.isVerified ? { label: 'verified' } : null,
    chatItem.isMembership ? { label: 'member' } : null,
  ].filter(Boolean);

  const imageBadges = [];
  if (chatItem.author?.badge?.thumbnail?.url) {
    imageBadges.push({
      label: chatItem.author.badge.label || 'badge',
      url: await cacheRemoteAsset(chatItem.author.badge.thumbnail.url, 'badges'),
    });
  }

  return dedupeBadges([...dropRolesCoveredByImages(roleBadges, imageBadges), ...imageBadges]);
}

async function resolveYouTubeLiveId(channelUrl) {
  const value = String(channelUrl || '').trim();

  if (!value) {
    return '';
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  const url = value.startsWith('http') ? value : `https://www.youtube.com/${value}`;
  const liveUrl = url.includes('/live') || url.includes('/watch') ? url : `${url.replace(/\/$/, '')}/live`;
  const response = await fetch(liveUrl);
  const html = await response.text();
  const watchMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/) || html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  return watchMatch ? watchMatch[1] : '';
}

async function buildYouTubeMessageParts(messageParts) {
  const parts = [];

  for (const part of messageParts) {
    if ('text' in part) {
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.url) {
      const localUrl = await cacheRemoteAsset(part.url, 'emotes');
      parts.push({ type: 'image', url: localUrl, alt: part.emojiText || part.alt || '' });
    }
  }

  return parts.length ? parts : [{ type: 'text', text: '' }];
}

async function connectRutubeChat(channelUrl) {
  if (!channelUrl) {
    chatStats.platformStatus.rutube = 'канал не задан';
    chatStats.viewers.rutube = 0;
    broadcastChatStatus();
    return;
  }

  chatStats.platformStatus.rutube = 'ожидает доступный чат';
  chatStats.viewers.rutube = await fetchRutubeViewerCount(channelUrl).catch(() => 0);
  broadcastChatStatus();
}

async function fetchRutubeViewerCount(channelUrl) {
  const response = await fetch(channelUrl);
  const html = await response.text();
  const match = html.match(/"viewers_count"\s*:\s*(\d+)/) || html.match(/"viewersCount"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function createTwitchMessage(tags, message) {
  return {
    platform: 'twitch',
    platformIcon: getPlatformIconUrl('twitch'),
    user: tags['display-name'] || tags.username || 'Зритель',
    text: message,
    parts: await buildTwitchMessageParts(message, tags.emotes || {}),
    badges: Object.keys(tags.badges || {}),
    color: tags.color || '',
    createdAt: new Date().toISOString(),
  };
}

async function buildTwitchMessageParts(message, emotes) {
  const ranges = [];

  for (const [emoteId, positions] of Object.entries(emotes || {})) {
    for (const position of positions) {
      const [start, end] = position.split('-').map(Number);
      ranges.push({ emoteId, start, end });
    }
  }

  ranges.sort((left, right) => left.start - right.start);

  if (!ranges.length) {
    return [{ type: 'text', text: message }];
  }

  const parts = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ type: 'text', text: message.slice(cursor, range.start) });
    }

    const emoteText = message.slice(range.start, range.end + 1);
    const remoteUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${range.emoteId}/default/dark/1.0`;
    const localUrl = await cacheRemoteAsset(remoteUrl, 'emotes');
    parts.push({ type: 'image', url: localUrl, alt: emoteText });
    cursor = range.end + 1;
  }

  if (cursor < message.length) {
    parts.push({ type: 'text', text: message.slice(cursor) });
  }

  return parts;
}

function startChatPolling() {
  clearInterval(vkPollTimer);
  clearInterval(viewerPollTimer);

  vkPollTimer = setInterval(() => {
    pollVkChat().catch((error) => {
      vkConnectionState.consecutiveFailures += 1;
      vkConnectionState.lastError = formatVkFetchError(error);
      chatStats.viewers.vk = vkConnectionState.lastViewers || 0;
      chatStats.platformStatus.vk = getVkPlatformStatus(vkConnectionState.lastChatAvailable);
      broadcastChatStatus();
      console.error(`VK Live: неожиданная ошибка опроса: ${vkConnectionState.lastError}`);
    });
  }, 5000);

  viewerPollTimer = setInterval(() => {
    refreshViewerCounts().catch((error) => {
      console.error(`Не удалось обновить счётчики зрителей: ${error.message}`);
    });
  }, 10000);

  refreshViewerCounts().catch(() => {});
}

async function refreshViewerCounts() {
  const [twitchViewers, vkViewers, youtubeViewers, rutubeViewers] = await Promise.all([
    fetchTwitchViewerCount(parseTwitchChannel(currentChannels.twitch)).catch(() => chatStats.viewers.twitch || 0),
    currentChannels.vk
      ? fetchVkViewerCount(currentChannels.vk).catch(() => vkConnectionState.lastViewers || 0)
      : Promise.resolve(0),
    fetchYouTubeViewerCount(currentChannels.youtube).catch(() => 0),
    fetchRutubeViewerCount(currentChannels.rutube).catch(() => 0),
  ]);

  chatStats.viewers.twitch = twitchViewers;
  chatStats.viewers.vk = vkViewers;
  chatStats.viewers.youtube = youtubeViewers;
  chatStats.viewers.rutube = rutubeViewers;
  vkConnectionState.lastViewers = vkViewers;
  broadcastChatStatus();
}

async function fetchTwitchViewerCount(channel) {
  if (!channel) {
    return 0;
  }

  const query =
    'query ChannelShell($login: String!) { user(login: $login) { stream { viewersCount type } } }';
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operationName: 'ChannelShell',
      variables: { login: channel },
      query,
    }),
  });
  const payload = await response.json();

  return Number(payload?.data?.user?.stream?.viewersCount || 0);
}

async function fetchYouTubeViewerCount(channelUrl) {
  if (!channelUrl) {
    return 0;
  }

  const value = String(channelUrl).trim();
  const url = value.startsWith('http') ? value : `https://www.youtube.com/${value}`;
  const liveUrl = url.includes('/live') || url.includes('/watch') ? url : `${url.replace(/\/$/, '')}/live`;
  const response = await fetch(liveUrl);
  const html = await response.text();

  // ВАЖНО: нужны ТЕКУЩИЕ зрители эфира (concurrent), а НЕ суммарные просмотры видео.
  // Поле "viewCount" в videoDetails — это накопленные просмотры за всё время (даёт
  // нереалистично большую цифру), поэтому его здесь НЕ используем.
  const concurrent =
    html.match(/"concurrentViewers":"(\d+)"/) ||
    html.match(/"originalViewCount":"(\d+)"/);
  if (concurrent) {
    return Number(concurrent[1]) || 0;
  }

  // Фолбэк: текст вида "1 234 смотрят" / "1,234 watching now" (только с меткой «смотрят/watching»).
  const watching =
    html.match(/"simpleText":"([\d\s., ]+)\s*(?:watching|смотр)/i) ||
    html.match(/"text":"([\d\s., ]+)"\}[^}]*"text":"\s*(?:watching|смотр)/i);
  if (watching) {
    const n = Number(String(watching[1]).replace(/[^\d]/g, '') || 0);
    if (n > 0) {
      return n;
    }
  }

  // Нет активного эфира — онлайн 0 (не показываем суммарные просмотры).
  return 0;
}

async function pollVkChat() {
  if (!currentChannels.vk) {
    chatStats.viewers.vk = 0;
    chatStats.platformStatus.vk = 'канал не задан';
    broadcastChatStatus();
    return;
  }

  let vkState;
  try {
    vkState = await fetchVkState(currentChannels.vk);
    if (vkConnectionState.consecutiveFailures > 0) {
      logInfo('VK Live снова подключён');
    }
    vkConnectionState.consecutiveFailures = 0;
    vkConnectionState.lastError = '';
    vkConnectionState.lastSuccessAt = Date.now();
  } catch (error) {
    vkConnectionState.consecutiveFailures += 1;
    vkConnectionState.lastError = formatVkFetchError(error);
    chatStats.viewers.vk = vkConnectionState.lastViewers || 0;
    chatStats.platformStatus.vk = getVkPlatformStatus(vkConnectionState.lastChatAvailable);
    broadcastChatStatus();

    if (vkConnectionState.consecutiveFailures === 1 || vkConnectionState.consecutiveFailures % 5 === 0) {
      console.error(`VK Live: ошибка подключения (${vkConnectionState.consecutiveFailures}): ${vkConnectionState.lastError}`);
    }
    return;
  }

  const { messages, viewers, chatAvailable } = vkState;
  vkConnectionState.lastViewers = viewers;
  vkConnectionState.lastChatAvailable = chatAvailable;
  chatStats.viewers.vk = viewers;
  chatStats.platformStatus.vk = getVkPlatformStatus(chatAvailable);

  if (!vkChatBootstrapped) {
    for (const message of messages) {
      rememberVkMessageId(message.id);
      const numericId = Number(String(message.id).replace(/^vk:/, ''));
      if (Number.isFinite(numericId)) {
        vkConnectionState.lastChatMessageId = Math.max(vkConnectionState.lastChatMessageId, numericId);
      }
    }

    vkChatBootstrapped = true;
    broadcastChatStatus();
    return;
  }

  const sortedMessages = [...messages].sort((left, right) => {
    const leftId = Number(String(left.id).replace(/^vk:/, '')) || 0;
    const rightId = Number(String(right.id).replace(/^vk:/, '')) || 0;
    return leftId - rightId;
  });

  for (const message of sortedMessages) {
    if (chatStats.vkMessageIds.has(message.id)) {
      continue;
    }

    rememberVkMessageId(message.id);
    const numericId = Number(String(message.id).replace(/^vk:/, ''));
    if (Number.isFinite(numericId)) {
      vkConnectionState.lastChatMessageId = Math.max(vkConnectionState.lastChatMessageId, numericId);
    }

    if (message.rewardEvent && vkChatBootstrapped) {
      enqueueStickerFromReward(message.rewardEvent);
    }

    if (message.subscriptionRenewalEvent && vkChatBootstrapped) {
      enqueueSubscriptionRenewalAlert(message.subscriptionRenewalEvent);
    } else if (message.subscriberEvent && vkChatBootstrapped) {
      enqueueSubscriberAlert(message.subscriberEvent);
    }

    broadcastChatMessage({
      platform: 'vk',
      platformIcon: getPlatformIconUrl('vk'),
      user: message.user,
      text: message.text,
      parts: message.parts,
      badges: message.badges,
      createdAt: message.createdAt,
    });
  }

  vkChatBootstrapped = true;
  broadcastChatStatus();
}

async function mapVkChatItems(chatData = []) {
  const results = await Promise.all(
    chatData
      .filter((item) => item && !item.isDeleted)
      .map(async (item) => {
        try {
          const subscriberEvent = parseVkSubscriberEvent(item);
          const subscriptionRenewalEvent = parseVkSubscriptionRenewalEvent(item);
          const rewardEvent = parseVkRewardEvent(item);

          return {
            id: `vk:${item.id}`,
            user: item.author?.displayName || item.author?.nick || item.author?.name || 'Зритель',
            text: extractVkMessageText(item.data),
            parts: extractVkMessageParts(item.data),
            badges: await buildVkBadges(item.author?.badges || [], item.author || {}),
            createdAt: new Date(Number(item.createdAt || Date.now() / 1000) * 1000).toISOString(),
            subscriberEvent,
            subscriptionRenewalEvent,
            rewardEvent,
          };
        } catch (error) {
          console.error(`VK Live: не удалось разобрать сообщение ${item.id}: ${error.message}`);
          return null;
        }
      }),
  );

  return results.filter(Boolean);
}

async function fetchVkState(channelUrl) {
  const slug = parseVkChannelSlug(channelUrl);
  if (!slug) {
    throw new Error('VK канал не задан');
  }

  const streamPath = `/blog/${encodeURIComponent(slug)}/public_video_stream`;
  const [streamResult, chatResult] = await Promise.allSettled([
    fetchJsonWithRetry(`${VK_API_BASE}${streamPath}`),
    // VK's from_id paginates backwards (the response includes that ID and
    // older messages). Poll the newest page and deduplicate by message ID
    // instead, otherwise every message posted after startup is skipped.
    fetchJsonWithRetry(`${VK_API_BASE}${streamPath}/chat?limit=30`),
  ]);

  if (streamResult.status === 'rejected') {
    throw streamResult.reason;
  }

  const stream = unwrapVkStreamPayload(streamResult.value);
  const viewers = extractVkViewerCount(stream);
  const chatAvailable = stream?.hasChat !== false;

  let chatData = [];
  if (chatResult.status === 'fulfilled') {
    chatData = Array.isArray(chatResult.value?.data) ? chatResult.value.data : [];
  }

  const messages = (await mapVkChatItems(chatData)).filter((item) => item.text || item.parts.length || item.rewardEvent);

  return {
    viewers,
    messages,
    chatAvailable,
  };
}

async function buildVkBadges(badges = [], author = {}) {
  const roleBadges = [];

  if (author.isOwner) roleBadges.push({ label: 'owner' });
  if (author.isChatModerator || author.isChannelModerator) roleBadges.push({ label: 'moderator' });
  if (author.isVerifiedStreamer) roleBadges.push({ label: 'verified' });

  const imageBadges = await Promise.all(
    badges.map(async (badge) => {
      const url = badge.smallUrl || badge.mediumUrl || badge.largeUrl;
      return {
        label: badge.name || badge.achievement?.name || 'badge',
        url: url ? await cacheRemoteAsset(url, 'badges') : '',
      };
    }),
  );

  const images = imageBadges.filter((badge) => badge.label || badge.url);
  return dedupeBadges([...dropRolesCoveredByImages(roleBadges, images), ...images]);
}

function extractVkMessageText(parts = []) {
  return extractVkMessageParts(parts)
    .map((part) => {
      return part.text || part.alt || '';
    })
    .join('')
    .trim();
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

  return {
    username,
    textParts,
    id: item.id,
    createdAt: new Date(Number(item.createdAt || Date.now() / 1000) * 1000).toISOString(),
  };
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
    createdAt: base.createdAt,
  };
}

// Награды VK Play Live приходят либо отдельным полем в элементе чата, либо
// сообщением чат-бота вида «@ник активировал награду «Название»».
function parseVkStructuredReward(item = {}) {
  const reward = item.reward || item.rewardInfo || null;
  if (!reward || typeof reward !== 'object') {
    return null;
  }

  const name = String(reward.name || reward.title || reward.rewardName || '').trim();
  if (!name) {
    return null;
  }

  return {
    platform: 'vk',
    username: String(item.author?.displayName || item.author?.nick || item.author?.name || 'Зритель').trim(),
    reward: name,
    price: Number(reward.price || reward.cost || 0),
    message: String(reward.message || '').trim(),
    id: `vk:reward:${item.id}`,
    createdAt: new Date(Number(item.createdAt || Date.now() / 1000) * 1000).toISOString(),
  };
}

function parseVkRewardEvent(item = {}) {
  const structured = parseVkStructuredReward(item);
  if (structured) {
    return structured;
  }

  const base = parseVkChatBotMessage(item);
  if (!base || !/наград/i.test(base.textParts)) {
    return null;
  }

  const quoted = base.textParts.match(/[«"'"]([^»"'"]+)[»"'"]/);
  const rewardName = String(quoted?.[1] || '').trim();
  if (!rewardName) {
    return null;
  }

  return {
    platform: 'vk',
    username: base.username,
    reward: rewardName,
    price: 0,
    message: base.textParts,
    id: `vk:reward:${base.id}`,
    createdAt: base.createdAt,
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

  return {
    platform: 'vk',
    username: base.username,
    message: base.textParts,
    id: `vk:sub:${base.id}`,
    createdAt: base.createdAt,
  };
}

function extractVkMessageParts(parts = []) {
  return parts
    .map((part) => {
      if (part?.type === 'mention') {
        const mentionName = part.displayName || part.nick || part.name || '';
        return mentionName ? { type: 'text', text: `${mentionName} ` } : null;
      }

      if (part.url) {
        return { type: 'text', text: part.url };
      }

      if (part.imageUrl || part.smallUrl || part.mediumUrl || part.largeUrl) {
        return {
          type: 'image',
          url: part.imageUrl || part.smallUrl || part.mediumUrl || part.largeUrl,
          alt: part.name || part.content || 'emoji',
        };
      }

      if (part.emojiUrl || part.emoji?.url) {
        return {
          type: 'image',
          url: part.emojiUrl || part.emoji.url,
          alt: part.emojiText || part.name || 'emoji',
        };
      }

      try {
        const parsed = JSON.parse(part.content || '[]');

        if (Array.isArray(parsed)) {
          return { type: 'text', text: parsed[0] || '' };
        }

        if (parsed?.text) {
          return { type: 'text', text: parsed.text };
        }

        if (parsed?.emojiText) {
          return { type: 'text', text: parsed.emojiText };
        }
      } catch {
        return { type: 'text', text: part.content || '' };
      }

      return { type: 'text', text: part.content || '' };
    })
    .filter((part) => part && (part.text || part.url));
}

function normalizeDonation(payload = {}) {
  return {
    id: String(payload.id || payload.alertId || payload.createdAt || `donation-${Date.now()}`),
    username: payload.username || 'Зритель',
    amount: Number(payload.amount || 0),
    currency: payload.currency || 'RUB',
    message: payload.message || 'Без сообщения',
    createdAt: payload.createdAt || new Date().toISOString(),
    isTest: Boolean(payload.isTest),
    showInChat: Boolean(payload.showInChat),
  };
}

function purgeTestAlerts() {
  const hadTestAlerts = alertQueue.some(
    (item) => item.donation?.isTest || item.subscriber?.isTest || item.renewal?.isTest || item.raid?.isTest || item.firstMessage?.isTest,
  );
  const hadTestDonations = donationAlertsState.donations.some((donation) => donation.isTest);

  if (hadTestAlerts) {
    alertQueue = alertQueue.filter(
      (item) => !item.donation?.isTest && !item.subscriber?.isTest && !item.renewal?.isTest && !item.raid?.isTest && !item.firstMessage?.isTest,
    );
    broadcastAlertQueue();
  }

  if (hadTestDonations) {
    donationAlertsState = {
      ...donationAlertsState,
      donations: donationAlertsState.donations.filter((donation) => !donation.isTest),
    };
    broadcastDonationAlertsState();
  }
}

function isInternalDemoRequest(request) {
  return request.headers['x-tchat-internal'] === '1';
}

function normalizeGoal(payload = {}) {
  const target = Math.max(Number(payload.target || 1), 1);
  const current = Math.max(Number(payload.current || 0), 0);

  return {
    title: payload.title || 'Сбор',
    current,
    target,
    currency: payload.currency || 'RUB',
    percent: Math.min(Math.round((current / target) * 100), 100),
    updatedAt: payload.updatedAt || new Date().toISOString(),
  };
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  Menu.setApplicationMenu(null);
  // Строго до чтения любых настроек: иначе сотрём то, что уже загружено в память.
  applyPendingCleanInstall();
  setupChatStorage();
  profiles.init(path.join(app.getPath('userData'), 'settings'));
  setupDonationAlertsStorage();
  repairLegacyCurrentGiveawayNicknames();
  await startLocalServer();
  purgeTestAlerts();
  broadcastGoalState();
  createChatWindow();

  // Глобальный хоткей полупрозрачного режима — регистрируем сразу после создания
  // окна, до подключения чатов (они могут долго висеть и не должны задерживать хоткей).
  const ghostShortcutOk = globalShortcut.register('Control+Alt+G', toggleGhostMode);
  if (!ghostShortcutOk) {
    console.error('Не удалось зарегистрировать хоткей Ctrl+Alt+G (занят другим приложением).');
  }

  if (donationAlertsToken) {
    startDonationAlertsSync(donationAlertsToken);
  }
  await connectChatSources(currentChannels);
  startChatPolling();
  ensureCountdownTicking();
  setupAutoUpdater();
  restream.init({
    storageDir: path.join(app.getPath('userData'), 'settings'),
    onStatus: (state) => mainWindow?.webContents.send('restream:status', state),
  });
  incoming.init({
    storageDir: path.join(app.getPath('userData'), 'settings'),
    onStatus: (state) => mainWindow?.webContents.send('incoming:status', state),
  });
  donatepay.init({
    storageDir: path.join(app.getPath('userData'), 'settings'),
    // Донат из любого источника идёт в общую воронку: алерты, сбор, музыка, чат.
    onDonation: (donation) => enqueueDonationAlert({ ...donation, showInChat: true }),
    onStatus: () => broadcastDonationSources(),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createChatWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', async () => {
  clearInterval(vkPollTimer);
  clearInterval(viewerPollTimer);
  clearInterval(donationAlertsTimer);
  clearInterval(countdownTickTimer);
  if (twitchClient) {
    await twitchClient.disconnect().catch(() => {});
  }
  if (youtubeClient) {
    youtubeClient.stop();
  }
  restream.shutdown();
  incoming.shutdown();
  await stopLocalServer();
});

// Полный конфиг приложения одним файлом: боты TG/MAX, ключи ИИ, каналы чатов,
// токены DonationAlerts. Экспорт — чтобы перенести на другой ПК, импорт — применить.
function collectFullConfig() {
  return {
    tchatConfig: 1,
    exportedAt: new Date().toISOString(),
    version: app.getVersion(),
    announce: announceSettings,
    channels: { ...currentChannels },
    donationAlerts: {
      clientId: donationAlertsClientId,
      clientSecret: donationAlertsClientSecret,
      token: donationAlertsToken,
      refreshToken: donationAlertsRefreshToken,
    },
  };
}

ipcMain.handle('config:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Сохранить конфиг TChat',
    defaultPath: 'tchat-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) {
    return { ok: false, canceled: true };
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(collectFullConfig(), null, 2));
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('config:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Выбрать конфиг TChat',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) {
    return { ok: false, canceled: true };
  }

  try {
    // Убираем возможный BOM (файлы из PowerShell/Блокнота начинаются с ﻿).
    const rawText = fs.readFileSync(filePaths[0], 'utf8').replace(/^﻿/, '');
    const raw = JSON.parse(rawText);
    const applied = [];

    if (raw.announce && typeof raw.announce === 'object') {
      saveAnnounceSettings(raw.announce);
      applied.push('боты и ключи');
    }

    if (raw.donationAlerts && typeof raw.donationAlerts === 'object') {
      donationAlertsClientId = String(raw.donationAlerts.clientId || '').trim();
      donationAlertsClientSecret = String(raw.donationAlerts.clientSecret || '').trim();
      donationAlertsRefreshToken = String(raw.donationAlerts.refreshToken || '').trim();
      const importedToken = String(raw.donationAlerts.token || '').trim();
      startDonationAlertsSync(importedToken);
      applied.push('DonationAlerts');
    }

    if (raw.channels && typeof raw.channels === 'object') {
      await connectChatSources({
        twitch: parseTwitchChannel(raw.channels.twitch || ''),
        vk: String(raw.channels.vk || '').trim(),
        youtube: String(raw.channels.youtube || '').trim(),
        rutube: String(raw.channels.rutube || '').trim(),
      });
      saveChatChannels();
      applied.push('каналы чатов');
    }

    if (!applied.length) {
      return { ok: false, error: 'в файле нет настроек TChat' };
    }
    return { ok: true, applied };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('app:check-updates', async () => {
  if (!autoUpdater) {
    return { ok: false, error: 'модуль обновления недоступен' };
  }
  if (!app.isPackaged) {
    return { ok: false, error: 'проверка работает только в собранном приложении' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version || '';
    return {
      ok: true,
      current: app.getVersion(),
      latest,
      hasUpdate: Boolean(result?.isUpdateAvailable),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('restream:get-state', () => restream.getState());
ipcMain.handle('restream:start', () => restream.start());
ipcMain.handle('restream:stop', () => restream.stop());
ipcMain.handle('restream:save-config', (_event, payload) => restream.saveConfig(payload || {}));

ipcMain.handle('incoming:get-state', () => incoming.getState());
ipcMain.handle('incoming:add', (_event, payload) => incoming.addStream(payload || {}));
ipcMain.handle('incoming:update', (_event, payload) => incoming.updateStream(payload?.id, payload?.patch || {}));
ipcMain.handle('incoming:remove', (_event, payload) => incoming.removeStream(payload?.id));

// --- Профили зрителей ---------------------------------------------------------

// Отдельного коннектора у профилей нет: ключ polza.ai и адрес локальной Ollama
// берутся из «Подключений» — те же, что генерируют текст анонсов. Заводить второй
// ключ на то же самое незачем.
//
// Порядок как в анонсах: сначала polza.ai (если задан ключ), при отказе —
// локальная Ollama, если она отвечает. Ollama без ключа, поэтому она же
// выручает, когда polza.ai недоступна из сети.
const PROFILE_POLZA_URL = 'https://polza.ai/api/v1/chat/completions';
const PROFILE_POLZA_MODEL = 'deepseek/deepseek-chat';

function profilesPolza() {
  return {
    apiKey: String(announceSettings?.polza?.apiKey || '').trim(),
    // Модель анонсов рассчитана на длинный текст; для разбора чата берём дешёвую,
    // но если стример выбрал свою — уважаем выбор.
    model: String(announceSettings?.polza?.model || '').trim() || PROFILE_POLZA_MODEL,
  };
}

function profilesOllama() {
  return {
    baseUrl: String(announceSettings?.ollama?.baseUrl || '').trim(),
    model: String(announceSettings?.ollama?.model || '').trim(),
  };
}

// Жива ли локальная Ollama. Ответ короткоживуще кешируем: статус спрашивает
// интерфейс при каждом открытии карточки, а поднимать пробу каждый раз незачем.
let ollamaProbe = { at: 0, ready: false };

async function isOllamaReady() {
  const { baseUrl } = profilesOllama();
  if (!baseUrl) {
    return false;
  }
  if (Date.now() - ollamaProbe.at < 15000) {
    return ollamaProbe.ready;
  }
  let ready = false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
    ready = response.ok;
  } catch {
    ready = false;
  }
  ollamaProbe = { at: Date.now(), ready };
  return ready;
}

// Чем интерфейс объясняет, можно ли вообще собирать портрет.
async function getProfilesAiStatus() {
  const polza = profilesPolza();
  const ollama = profilesOllama();
  const ollamaReady = await isOllamaReady();
  return {
    hasKey: Boolean(polza.apiKey),
    model: polza.model,
    ollamaUrl: ollama.baseUrl,
    ollamaModel: ollama.model,
    ollamaReady,
    canAnalyze: Boolean(polza.apiKey) || ollamaReady,
  };
}

// Разовое наполнение лога профиля: проходим общий архив chat.jsonl и достаём
// оттуда все сообщения зрителя. Дальше лог пополняется на лету из saveChatMessage,
// так что второй раз архив по этому зрителю уже не читается.
async function seedProfileMessagesFromArchive(profile) {
  // Собираем по всем никам человека: основному и псевдонимам. Ник сравниваем
  // без платформы — один и тот же человек пишет из VK и с Twitch.
  const nicks = new Set(profiles.nicksOf(profile));
  const collected = [];

  const collect = (message) => {
    const nick = String(message.user || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!nicks.has(nick)) return;
    const text = String(message.text || '').trim();
    if (text) {
      collected.push({ text, createdAt: message.createdAt || '' });
    }
  };

  if (chatHistoryFile && fs.existsSync(chatHistoryFile)) {
    const stream = fs.createReadStream(chatHistoryFile, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        try {
          collect(JSON.parse(line));
        } catch {
          /* битая строка архива — пропускаем */
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } else {
    chatHistory.forEach(collect);
  }

  profiles.seedMessages(profile.id, collected);
  return collected.length;
}

// Профили, заведённые до появления собственного лога, и только что созданные
// наполняются архивом один раз. Параллельные вызовы делят один проход.
const profileSeedInFlight = new Map();

function ensureProfileMessages(profile) {
  if (!profile || profile.messagesSeeded) {
    return Promise.resolve(0);
  }
  const running = profileSeedInFlight.get(profile.id);
  if (running) {
    return running;
  }
  const task = seedProfileMessagesFromArchive(profile)
    .catch((error) => {
      console.error(`[profiles] не удалось наполнить лог сообщений: ${error?.message || error}`);
      return 0;
    })
    .finally(() => profileSeedInFlight.delete(profile.id));
  profileSeedInFlight.set(profile.id, task);
  return task;
}

// Донаты — только те, что отдал DonationAlerts за сессию: полной истории у нас
// нет, поэтому статистика по ним помечена как неполная.
function computeDonationStats(profile) {
  const userNorm = String(profile.user || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let donationCount = 0;
  let donationTotal = 0;
  let donationCurrency = '';
  for (const d of donationAlertsState.donations || []) {
    if (String(d.username || '').replace(/\s+/g, ' ').trim().toLowerCase() !== userNorm) continue;
    donationCount += 1;
    donationTotal += Number(d.amount || 0);
    donationCurrency = d.currency || donationCurrency;
  }
  return { donationCount, donationTotal, donationCurrency, donationsPartial: true };
}

// Статистика профиля: сообщения — из его же лога, донаты — из сессии.
async function getProfilePayload(id) {
  const profile = profiles.get(id);
  if (!profile) return null;
  await ensureProfileMessages(profile);
  return {
    ...profile,
    stats: { ...profiles.messageStats(id), ...computeDonationStats(profile) },
  };
}

// Ники с профилем — чтобы чат ставил метку и предлагал «Открыть», а не «Создать».
function broadcastProfileKeys() {
  const keys = profiles.list().map((p) => p.id);
  socketServer?.emit('profiles:keys', keys);
  chatWindow?.webContents.send('profiles:keys', keys);
  mainWindow?.webContents.send('profiles:keys', keys);
}

// Профили генерируются целиком, поэтому одновременный запуск на одном зрителе
// смысла не имеет: второй вызов дожидается первого.
const profileAnalysisInFlight = new Map();

// Сколько последних сообщений зрителя уходит в модель. Лог хранится целиком,
// но в промпт всё не влезет — да и портрет по свежему общению точнее.
// Потолок ожидания ответа модели: без него зависший запрос оставил бы карточку
// в «собираю портрет…» навсегда.
const PROFILE_REQUEST_TIMEOUT = 90000;

// Формат портрета — один и для первого разбора, и для обновления.
const PROFILE_JSON_SHAPE =
  '{"bio":"1-2 предложения о человеке","facts":["интересный факт", "..."],' +
  '"summary":"краткая сводка о том, как этот зритель общается со стримером",' +
  '"profession":"если следует из сообщений, иначе пустая строка",' +
  '"hobbies":["..."],"traits":["черта характера", "..."],' +
  '"timeline":[{"date":"ГГГГ-ММ-ДД","type":"health|trip|purchase|event|note","text":"что произошло в жизни зрителя"}]}';

// Что считаем событием для таймлайна — одинаково для первого разбора и обновления.
const PROFILE_TIMELINE_RULES =
  'В timeline клади всё заметное, что произошло у зрителя и о чём он сам написал: ' +
  'заболел или выздоровел, лежал в больнице (type "health"); куда-то съездил, отпуск, командировка, ' +
  'переезд (type "trip"); что-то купил — машина, техника, животное, крупная покупка (type "purchase"); ' +
  'сменил работу, экзамены, свадьба, ребёнок, новая учёба и прочие важные новости (type "event"). ' +
  'Дату бери из того сообщения, где он об этом сказал. Мелкую болтовню и шутки в события не записывай.';

// Анализ переписки через Polza.ai.
//
// Первый разбор идёт по всей переписке. Дальше портрет не пересобирается с нуля:
// модель получает прежний портрет и только те сообщения, что пришли после
// прошлого разбора, и обновляет им портрет. Отметка — profile.messagesAnalyzed,
// поэтому промпт не растёт вместе с логом, а старые выводы никуда не деваются.
async function runProfileAnalysis(id, { rebuild = false, allowWithoutNew = false } = {}) {
  const profile = profiles.get(id);
  if (!profile) return { ok: false, error: 'профиль не найден' };
  const status = await getProfilesAiStatus();
  if (!status.canAnalyze) {
    return { ok: false, error: 'нет ни ключа polza.ai, ни запущенной Ollama — задайте их во вкладке «Подключения»' };
  }

  await ensureProfileMessages(profile);
  const log = profiles.readMessages(id);
  if (!log.length) return { ok: false, error: 'нет сообщений этого зрителя для анализа' };

  const analyzed = Math.min(profile.messagesAnalyzed || 0, log.length);
  const incremental = !rebuild && Boolean(profile.aiUpdatedAt) && analyzed > 0;
  const fresh = incremental ? log.slice(analyzed) : log;
  if (incremental && !fresh.length && !allowWithoutNew) {
    return { ok: true, skipped: true };
  }

  // Полная пересборка получает всю переписку, дополнение — весь новый хвост.
  const shown = fresh.map((m) => ({
    text: m.text,
    date: m.createdAt ? String(m.createdAt).slice(0, 10) : '',
  }));

  const stats = computeDonationStats(profile);
  const manualNotes = profile.timeline.filter((e) => e.source === 'manual');

  const system = incremental
    ? 'Ты помощник стримера и ведёшь досье на зрителей. У тебя есть готовый портрет зрителя и его новые ' +
      'сообщения в чате. Обнови портрет: сохрани то, что осталось верным, добавь новое, убери то, что новые ' +
      'сообщения опровергают. Ответь СТРОГО валидным JSON без markdown и пояснений, портретом целиком: ' +
      `${PROFILE_JSON_SHAPE}. ` +
      `${PROFILE_TIMELINE_RULES} ` +
      'При этом клади в timeline ТОЛЬКО новые события из новых сообщений — прежние уже сохранены, повторять их не нужно. ' +
      'Остальные поля возвращай полностью, включая факты из прежнего портрета, которые остаются в силе. ' +
      'Не выдумывай того, чего нет ни в портрете, ни в сообщениях.'
    : 'Ты помощник стримера и ведёшь досье на зрителей. По сообщениям зрителя в чате составь ' +
      'портрет на русском языке. Ответь СТРОГО валидным JSON без markdown и пояснений: ' +
      `${PROFILE_JSON_SHAPE}. ` +
      `${PROFILE_TIMELINE_RULES} Если таких событий нет — пустой массив. ` +
      'Не выдумывай фактов, которых нет в сообщениях: лучше пустая строка или пустой массив.';

  const donationsLine = stats?.donationCount
    ? `Донаты за сессию: ${stats.donationCount} на ${Math.round(stats.donationTotal)} ${stats.donationCurrency || ''}`.trim()
    : 'Донатов не зафиксировано';
  const notesBlock = manualNotes.length
    ? `\nЗаметки стримера об этом человеке (учитывай их, но не копируй дословно):\n${manualNotes.map((e) => `- ${e.date}: ${e.text}`).join('\n')}`
    : '';

  // Кто это для канала. Для стримера портрет пишется про него самого, а не про
  // то, как он общается со стримером, — иначе получается дичь вроде «активный
  // зритель» про хозяина канала.
  const identityBlock =
    (profile.role === 'streamer'
      ? '\nВАЖНО: это не зритель, а стример этого канала. Пиши портрет про самого человека, ' +
        'а в summary опиши, как он ведёт эфир и общается с чатом.'
      : '') +
    (profile.note ? `\nЧто стример знает про него точно (считай это фактом): ${profile.note}` : '') +
    (profile.aliases.length ? `\nОн же пишет под никами: ${profile.aliases.join(', ')}.` : '');

  // Утверждения, помеченные стримером как неверные. Модель их выдумала или
  // переврала — повторять нельзя, даже если в переписке есть намёк.
  const correctionsBlock = profile.corrections.length
    ? `\nСтример пометил эти утверждения как НЕВЕРНЫЕ. Не повторяй их и не выводи заново ` +
      `ни в каком виде:\n${profile.corrections.map((c) => `- ${c.text}`).join('\n')}`
    : '';
  const portraitBlock = incremental
    ? `\nТекущее саммари профиля:\n${profile.aiSummary || '—'}\n` +
      `Текущий портрет (JSON):\n${JSON.stringify({
        bio: profile.bio,
        profession: profile.profession,
        hobbies: profile.hobbies,
        traits: profile.traits,
        facts: profile.facts,
        summary: profile.aiSummary,
      })}\n`
    : '';
  const messagesTitle = incremental
    ? `Новые сообщения с прошлого разбора (${shown.length})`
    : `Все сообщения в чате (${shown.length})`;
  const userPrompt =
    `${profile.role === 'streamer' ? 'Стример' : 'Зритель'}: ${profile.displayName} (${profile.platform})\n` +
    `Всего сообщений: ${log.length}. ${donationsLine}.${identityBlock}${correctionsBlock}${notesBlock}${portraitBlock}\n` +
    `${messagesTitle} (дата — текст):\n` +
    (shown.length ? shown.map((m) => `${m.date || '—'} — ${m.text}`).join('\n') : '— новых сообщений нет, уточни портрет по заметкам стримера');

  try {
    const { content, provider } = await requestProfileCompletion([
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ]);
    // Локальные модели любят обрамлять JSON в ```json — снимаем.
    const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, error: `${provider} вернул не JSON` };
    }
    // Отметку ставим по длине лога на момент чтения: сообщения, пришедшие
    // за время запроса, попадут в следующий разбор.
    profiles.applyAiResult(id, parsed, { mergeTimeline: incremental, analyzedCount: log.length });
    return { ok: true, incremental, usedMessages: shown.length, provider };
  } catch (error) {
    return { ok: false, error: describeNetworkError(error) };
  }
}

// fetch в Node на любой сетевой сбой отвечает голым «fetch failed», а настоящая
// причина (DNS, отказ соединения, сертификат) лежит в error.cause. Разворачиваем
// цепочку — иначе в карточке нечего показать, кроме «fetch failed».
function describeNetworkError(error) {
  if (error?.describedAlready) {
    return String(error.message || '');
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'модель не ответила вовремя (таймаут)';
  }
  const parts = [];
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = current.code ? `${current.code}` : '';
    const message = String(current.message || '').trim();
    if (code && !parts.includes(code)) {
      parts.push(code);
    } else if (message && !parts.includes(message)) {
      parts.push(message);
    }
    current = current.cause;
  }
  const detail = parts.filter(Boolean).join(' · ');
  return detail ? `сеть: ${detail}` : String(error?.message || error);
}

// Один запрос к OpenAI-совместимому эндпоинту. Возвращает текст ответа модели
// либо кидает ошибку с понятной причиной.
async function askModel({ url, apiKey, model, messages }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, temperature: 0.4 }),
    signal: AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) {
    throw new Error('пустой ответ модели');
  }
  return content;
}

// Цепочка источников: polza.ai → локальная Ollama. Возвращает { content, provider }
// или кидает ошибку со списком того, что не получилось.
async function requestProfileCompletion(messages) {
  const polza = profilesPolza();
  const ollama = profilesOllama();
  const attempts = [];

  if (polza.apiKey) {
    attempts.push({
      name: 'polza.ai',
      run: () => askModel({ url: PROFILE_POLZA_URL, apiKey: polza.apiKey, model: polza.model, messages }),
    });
  }
  if (ollama.baseUrl) {
    attempts.push({
      name: 'ollama',
      run: () =>
        askModel({
          url: `${ollama.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
          model: ollama.model,
          messages,
        }),
    });
  }
  if (!attempts.length) {
    throw new Error('не задан ключ polza.ai и не настроена локальная Ollama — см. вкладку «Подключения»');
  }

  const failures = [];
  for (const attempt of attempts) {
    try {
      return { content: await attempt.run(), provider: attempt.name };
    } catch (error) {
      const reason = describeNetworkError(error);
      failures.push(`${attempt.name} — ${reason}`);
      console.error(`[profiles] ${attempt.name} не ответил: ${reason}`);
    }
  }
  // Причины уже расшифрованы по каждому источнику: помечаем ошибку готовой,
  // чтобы внешний обработчик не приписал «сеть:» второй раз.
  const error = new Error(failures.join('; '));
  error.describedAlready = true;
  throw error;
}

// Обёртка вокруг разбора: держит статус профиля (pending → ready/error),
// не даёт запустить два разбора одного зрителя и сообщает интерфейсу результат.
function analyzeProfileWithAI(id, options = {}) {
  const running = profileAnalysisInFlight.get(id);
  if (running) {
    return running;
  }
  const task = (async () => {
    profiles.setAiStatus(id, 'pending');
    notifyProfileChanged(id);
    let result;
    try {
      result = await runProfileAnalysis(id, options);
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    if (!result.ok) {
      profiles.setAiStatus(id, 'error', result.error);
    } else if (result.skipped) {
      // Новых сообщений не было — портрет остался прежним, снимаем «собираю».
      profiles.setAiStatus(id, 'ready');
    }
    broadcastProfileKeys();
    notifyProfileChanged(id);
    return { ...result, profile: await getProfilePayload(id) };
  })().finally(() => profileAnalysisInFlight.delete(id));
  profileAnalysisInFlight.set(id, task);
  return task;
}

// Портрет собирается сам: профиль заводится по нику, содержимое пишет ИИ.
// Если разбор уже идёт, ставим ровно один повтор — чтобы новый контекст
// (например, только что добавленная заметка) точно попал в портрет.
const profileAnalysisQueued = new Set();

function scheduleProfileAnalysis(id, options = {}) {
  const running = profileAnalysisInFlight.get(id);
  if (running) {
    if (profileAnalysisQueued.has(id)) {
      return;
    }
    profileAnalysisQueued.add(id);
    running.finally(() => {
      profileAnalysisQueued.delete(id);
      scheduleProfileAnalysis(id, options);
    });
    return;
  }
  analyzeProfileWithAI(id, options).catch((error) => {
    console.error(`[profiles] анализ не удался: ${error?.message || error}`);
  });
}

// Бэкофис держит открытым один профиль — шлём ему свежую версию, чтобы карточка
// сама обновилась, когда фоновый разбор закончится.
async function notifyProfileChanged(id) {
  const payload = await getProfilePayload(id);
  if (payload) {
    mainWindow?.webContents.send('profiles:changed', payload);
  }
}

ipcMain.handle('profiles:list', () => profiles.list());
ipcMain.handle('profiles:get', (_event, id) => getProfilePayload(id));
ipcMain.handle('profiles:upsert', async (_event, patch) => {
  const saved = profiles.upsert(patch || {});
  broadcastProfileKeys();
  return getProfilePayload(saved.id);
});
ipcMain.handle('profiles:ensure', async (_event, payload) => {
  const isNew = !profiles.findByUser(payload?.platform, payload?.user);
  const saved = profiles.ensureForUser(payload || {});
  broadcastProfileKeys();
  if (isNew) {
    scheduleProfileAnalysis(saved.id);
  }
  return getProfilePayload(saved.id);
});
// Правый клик по нику в чате: заводим профиль (портрет сразу начинает
// собираться) и открываем бэкофис прямо на его карточке.
ipcMain.handle('profiles:open', async (_event, payload) => {
  const isNew = !profiles.findByUser(payload?.platform, payload?.user);
  const saved = profiles.ensureForUser(payload || {});
  broadcastProfileKeys();
  if (isNew) {
    scheduleProfileAnalysis(saved.id);
  }
  createWindow();
  const target = mainWindow?.webContents;
  if (target) {
    if (target.isLoading()) {
      target.once('did-finish-load', () => target.send('profiles:focus', saved.id));
    } else {
      target.send('profiles:focus', saved.id);
    }
  }
  return { ok: true, id: saved.id };
});
ipcMain.handle('profiles:remove', (_event, id) => {
  const ok = profiles.remove(id);
  broadcastProfileKeys();
  return { ok };
});
ipcMain.handle('profiles:add-timeline', async (_event, payload) => {
  const entry = profiles.addTimelineEntry(payload?.id, payload?.entry);
  // Заметка стримера — новый контекст для портрета, обновляем его даже если
  // новых сообщений в чате не было.
  if (entry && (await getProfilesAiStatus()).canAnalyze) {
    scheduleProfileAnalysis(payload.id, { allowWithoutNew: true });
  }
  return entry;
});
ipcMain.handle('profiles:remove-timeline', (_event, payload) => ({ ok: profiles.removeTimelineEntry(payload?.id, payload?.entryId) }));

// Стример пометил утверждение как неверное: убираем его из портрета и сразу
// пересобираем портрет — теперь модель знает, что так писать нельзя.
ipcMain.handle('profiles:mark-wrong', async (_event, payload) => {
  const updated = profiles.addCorrection(payload?.id, payload?.text);
  if (updated && (await getProfilesAiStatus()).canAnalyze) {
    scheduleProfileAnalysis(payload.id, { allowWithoutNew: true });
  }
  return getProfilePayload(payload?.id);
});

ipcMain.handle('profiles:unmark-wrong', async (_event, payload) => {
  profiles.removeCorrection(payload?.id, payload?.correctionId);
  return getProfilePayload(payload?.id);
});
// Кнопка «Обновить портрет» — обновляем даже без новых сообщений.
ipcMain.handle('profiles:analyze', (_event, payload) => {
  const id = typeof payload === 'string' ? payload : payload?.id;
  const mode = typeof payload === 'object' && payload?.mode === 'rebuild' ? 'rebuild' : 'extend';
  return analyzeProfileWithAI(id, { rebuild: mode === 'rebuild', allowWithoutNew: mode === 'rebuild' });
});
ipcMain.handle('profiles:get-keys', () => profiles.list().map((p) => p.id));
ipcMain.handle('profiles:get-ai-settings', () => getProfilesAiStatus());

ipcMain.handle('app:install-update', (_event, payload) => installDownloadedUpdate({ clean: Boolean(payload?.clean) }));

ipcMain.handle('app:get-data-summary', () => getUserDataSummary());

ipcMain.handle('app:get-setup-state', () => getSetupState());

// Адрес возврата берём из того же места, откуда его берёт сам OAuth-запрос,
// чтобы инструкция в мастере не разошлась с тем, что реально уходит в DA.
ipcMain.handle('app:get-oauth-info', () => ({
  donationAlerts: {
    redirectUri: DONATION_ALERTS_REDIRECT_URI,
    scope: DONATION_ALERTS_SCOPE,
    registerUrl: DONATION_ALERTS_APPS_URL,
  },
}));

ipcMain.handle('app:complete-setup', () => saveSetupState(true));

ipcMain.handle('app:get-patchnotes', () => ({
  current: app.getVersion(),
  notes: readLocalPatchnotes(),
  // Адрес раздачи: бэкоффис дотянется до заметок о версии, которой у нас ещё нет.
  feedUrl: String(require('./package.json')?.build?.publish?.[0]?.url || '').replace(/\/+$/, ''),
}));

ipcMain.handle('app:get-server-status', () => serverStatus);
ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  updaterStatus: lastUpdaterStatus,
  botConfig: {
    key: botConfigKey,
    url: `${serverStatus.url}/config/bot.json?key=${botConfigKey}`,
  },
}));

ipcMain.handle('app:open-external', async (_event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('app:open-chat-window', () => {
  createChatWindow();
});

ipcMain.handle('app:open-backoffice', () => {
  createWindow();
});

ipcMain.handle('chat:update-channels', async (_event, channels) => {
  await connectChatSources({
    twitch: parseTwitchChannel(channels?.twitch || currentChannels.twitch),
    vk: channels?.vk || currentChannels.vk,
    youtube: channels?.youtube || currentChannels.youtube,
    rutube: channels?.rutube || currentChannels.rutube,
  });
  saveChatChannels();
});

ipcMain.handle('chat:get-status', () => getChatStatusPayload());

ipcMain.handle('chat:get-history', () => getRecentChatMessages());

ipcMain.handle('chat:get-ui-settings', () => chatUiSettings);

ipcMain.handle('chat:save-ui-settings', (_event, payload) => saveChatUiSettings(payload));
ipcMain.handle('chat:update-filters', (_event, payload) => setChatHiddenFilters(payload));

// --- Источники донатов --------------------------------------------------------
//
// DonationAlerts и DonatePay — это просто два сервиса донатов, и дальше их может
// стать больше. Поэтому интерфейс работает не с конкретным сервисом, а со
// списком источников: у каждого свой способ авторизации и своё состояние, а
// донаты все приходят в одну воронку (enqueueDonationAlert).
//
// Чтобы добавить третий сервис: написать модуль с init/getState/saveSettings и
// добавить сюда одну запись.
const DONATION_SOURCES = [
  {
    id: 'donationalerts',
    name: 'DonationAlerts',
    // oauth — подключается кнопкой «Получить токен», поля ключа нет.
    auth: 'oauth',
    site: 'https://www.donationalerts.com',
    getState: () => {
      const state = getDonationAlertsState();
      return {
        // Токен есть — значит, подключено: опрос идёт по нему.
        connected: Boolean(state.hasToken),
        hasKey: Boolean(state.hasToken),
        enabled: Boolean(state.hasToken),
        error: state.error || '',
        account: '',
      };
    },
  },
  {
    id: 'donatepay',
    name: 'DonatePay',
    // apiKey — ключ из личного кабинета вставляется руками.
    auth: 'apiKey',
    site: 'https://donatepay.ru/page/api',
    keyHint: 'Ключ берётся на donatepay.ru → API',
    getState: () => {
      const state = donatepay.getState();
      return {
        connected: state.connected,
        hasKey: state.hasKey,
        enabled: state.enabled,
        error: state.error,
        account: state.user?.name || '',
        lastEventAt: state.lastEventAt,
      };
    },
    save: (patch) => donatepay.saveSettings(patch),
    check: (apiKey) => donatepay.checkKey(apiKey),
  },
];

function getDonationSources() {
  return DONATION_SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    auth: source.auth,
    site: source.site,
    keyHint: source.keyHint || '',
    ...source.getState(),
  }));
}

function broadcastDonationSources() {
  mainWindow?.webContents.send('donations:sources', getDonationSources());
}

ipcMain.handle('donations:get-sources', () => getDonationSources());

ipcMain.handle('donations:save-source', async (_event, payload) => {
  const source = DONATION_SOURCES.find((s) => s.id === payload?.id);
  if (!source?.save) {
    return { ok: false, error: 'этот источник так не настраивается' };
  }
  await source.save(payload.patch || {});
  broadcastDonationSources();
  return { ok: true, sources: getDonationSources() };
});

ipcMain.handle('donations:check-source', async (_event, payload) => {
  const source = DONATION_SOURCES.find((s) => s.id === payload?.id);
  if (!source?.check) {
    return { ok: false, error: 'проверка недоступна для этого источника' };
  }
  return source.check(payload.apiKey);
});

ipcMain.handle('donationalerts:update', (_event, payload) => startDonationAlertsSync(payload?.token || ''));

ipcMain.handle('donationalerts:get-state', () => getDonationAlertsState());

ipcMain.handle('donationalerts:get-auth-url', (_event, payload) => getDonationAlertsAuthUrl(payload));

ipcMain.handle('donationalerts:get-credentials', () => getDonationAlertsCredentials());

ipcMain.handle('donationalerts:remove-donation', (_event, payload) => removeDonationAlert(payload?.id));

ipcMain.handle('alerts:get-settings', () => alertSettings);

ipcMain.handle('alerts:save-settings', (_event, payload) => saveAlertSettings(payload));

ipcMain.handle('alerts:get-queue', () => getAlertQueuePayload());

ipcMain.handle('alerts:pick-asset', (_event, payload) => pickAlertAsset(payload?.kind || 'image'));

ipcMain.handle('stickers:get-state', () => getStickerStatePayload());

ipcMain.handle('stickers:save-settings', (_event, payload) => saveStickerSettings(payload));

ipcMain.handle('stickers:pick-asset', () => pickStickerAsset());

ipcMain.handle('stickers:test', (_event, payload) => showSticker(payload || {}));

ipcMain.handle('stickers:clear', () => {
  socketServer?.emit('sticker:clear');
  return { ok: true };
});

ipcMain.handle('music:get-queue', () => getMusicQueuePayload());

ipcMain.handle('music:save-settings', (_event, payload) => saveMusicSettings(payload));

ipcMain.handle('music:add-url', (_event, payload) => addManualMusicUrl(payload));

ipcMain.handle('music:remove-item', (_event, payload) => removeMusicItem(payload?.id));

ipcMain.handle('announce:get-settings', () => announceSettings);
ipcMain.handle('announce:save-settings', (_event, payload) => saveAnnounceSettings(payload || {}));
ipcMain.handle('announce:preview', async () => {
  try {
    return await announce.buildAnnouncement(announceSettings);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle('announce:send', async (_event, prepared) => {
  try {
    return await announce.sendAnnouncement(announceSettings, prepared || {});
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('goal:get-state', () => goalState);

ipcMain.handle('goal:update', (_event, payload) => updateGoalState(payload));

ipcMain.handle('widgets:get-state', () => getStreamWidgetsPayload());

ipcMain.handle('widgets:create', (_event, payload) => createStreamWidget(payload));

ipcMain.handle('widgets:update', (_event, payload) => updateStreamWidget(payload?.id, payload));

ipcMain.handle('widgets:delete', (_event, payload) => deleteStreamWidget(payload?.id));

ipcMain.handle('poll:start', (_event, payload) => startPoll(payload));

ipcMain.handle('poll:finish', () => finishPoll());

ipcMain.handle('poll:hide', () => hidePoll());

ipcMain.handle('poll:show', () => showPoll());

ipcMain.handle('poll:clear', () => clearPoll());

ipcMain.handle('giveaway:start', (_event, payload) => startGiveaway(payload?.id, payload));

ipcMain.handle('giveaway:finish', (_event, payload) => finishGiveaway(payload?.id));

ipcMain.handle('giveaway:reset', (_event, payload) => resetGiveaway(payload?.id));

ipcMain.handle('giveaway:reset-all', () => resetAllGiveaways());

ipcMain.handle('countdown:adjust', (_event, payload) => adjustCountdownWidget(payload?.id, payload?.deltaSeconds));

ipcMain.handle('countdown:set', (_event, payload) => setCountdownWidgetTime(payload?.id, payload));

ipcMain.handle('countdown:start', (_event, payload) => startCountdownWidget(payload?.id));

ipcMain.handle('countdown:pause', (_event, payload) => pauseCountdownWidget(payload?.id));

ipcMain.handle('countdown:resume', (_event, payload) => resumeCountdownWidget(payload?.id));

ipcMain.handle('countdown:reset', (_event, payload) => resetCountdownWidget(payload?.id, payload?.seconds));

ipcMain.handle('demo:send-chat-message', (_event, payload) => {
  const message = normalizeChatMessage(payload);
  broadcastChatMessage(message);
});

ipcMain.handle('demo:send-donation-alert', (_event, payload) => {
  const item = enqueueDonationAlert({
    id: `${payload?.isTest === false ? 'manual' : 'test'}-${Date.now()}`,
    username: payload?.username || (payload?.isTest === false ? 'Зритель' : 'Тестовый донатер'),
    amount: Number(payload?.amount || 666),
    currency: payload?.currency || 'RUB',
    message: payload?.message || (payload?.isTest === false ? 'Ручной донат' : 'Проверяем алерт из бэкоффиса'),
    createdAt: new Date().toISOString(),
    isTest: payload?.isTest !== false,
    showInChat: true,
  });
  return item;
});

ipcMain.handle('demo:send-subscriber-alert', (_event, payload) => {
  return enqueueSubscriberAlert({
    id: `test-sub-${Date.now()}`,
    platform: payload?.platform || 'demo',
    username: payload?.username || 'Новый зритель',
    message: payload?.message || 'подписался на канал',
    createdAt: new Date().toISOString(),
  });
});

ipcMain.handle('demo:send-subscription-renewal-alert', (_event, payload) => {
  return enqueueSubscriptionRenewalAlert({
    id: `test-renewal-${Date.now()}`,
    platform: payload?.platform || 'demo',
    username: payload?.username || 'Зритель',
    tier: payload?.tier || 'Матрос',
    months: Number(payload?.months || 2),
    message: payload?.message || "продлил подписку 'Матрос'. Подписан уже 2 месяцев.",
    createdAt: new Date().toISOString(),
    isTest: Boolean(payload?.isTest),
  });
});

ipcMain.handle('demo:send-raid-alert', (_event, payload) => {
  return enqueueRaidAlert({
    id: `test-raid-${Date.now()}`,
    platform: payload?.platform || 'demo',
    username: payload?.username || 'Рейдер',
    viewers: Number(payload?.viewers || 25),
    message: payload?.message || 'рейд на 25 зрителей',
    createdAt: new Date().toISOString(),
  });
});

ipcMain.handle('demo:update-goal', (_event, payload) => {
  return updateGoalState(payload);
});
