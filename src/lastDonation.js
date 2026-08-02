'use strict';

// Виджет «Последний донат»: ловит донаты от минимальной суммы (по умолчанию 500 ₽)
// и ведёт по ним две линии призов.
//
//  * Прогрессия — пороги по сумме всех зачтённых донатов (2000, 5000, 8000, …).
//    Порог пробивает тот, чей донат перевёл общую сумму через отметку: он и
//    становится победителем этой ступени. Пробитие уже случилось — переиграть
//    его нельзя, поэтому победитель ступени фиксируется навсегда.
//  * Топ-призы — разыгрываются в конце стрима между последними донатерами:
//    1 место у того, кто задонатил последним, 2 и 3 — предыдущие. Пока стрим
//    идёт, любой новый донат перетасовывает эту тройку — в этом весь смысл.
//
// Считаются только донаты от minAmount: мелочь не сбивает интригу «последнего».

const fs = require('node:fs');
const path = require('node:path');

const DONATION_HISTORY_LIMIT = 100;
const DEFAULT_MIN_AMOUNT = 500;
const DEFAULT_STREAM_MINUTES = 180;

let stateFile = '';
let state = createDefaultState();

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function createDefaultState() {
  return normalize({
    enabled: true,
    title: 'Последний донат',
    minAmount: DEFAULT_MIN_AMOUNT,
    currency: 'RUB',
    streamMinutes: DEFAULT_STREAM_MINUTES,
    tiers: [
      { amount: 2000, title: 'Розыгрыш бонускодов' },
      { amount: 5000, title: '+30 минут к стриму' },
      { amount: 8000, title: 'Стрим на выбор' },
      { amount: 12000, title: '+час к стриму' },
      { amount: 15000, title: 'Кинострим' },
    ],
    topPrizes: [
      { place: 1, title: '25000 золота' },
      { place: 2, title: '5000 золота' },
      { place: 3, title: '1000 золота' },
    ],
  });
}

function normalizeTier(raw = {}, index = 0) {
  const winner = raw.winner && raw.winner.username
    ? {
        username: String(raw.winner.username),
        amount: Math.max(Number(raw.winner.amount || 0), 0),
        at: raw.winner.at || new Date().toISOString(),
      }
    : null;

  return {
    id: String(raw.id || newId('tier')),
    amount: Math.max(Number(raw.amount || 0), 0),
    title: String(raw.title || `Приз ${index + 1}`).slice(0, 120),
    winner,
    reachedAt: winner ? raw.reachedAt || winner.at : '',
  };
}

function normalizeTopPrize(raw = {}, index = 0) {
  return {
    id: String(raw.id || newId('top')),
    place: Math.max(Number(raw.place || index + 1), 1),
    title: String(raw.title || `Топ-приз ${index + 1}`).slice(0, 120),
  };
}

function normalizeDonation(raw = {}) {
  return {
    id: String(raw.id || newId('ld')),
    username: String(raw.username || 'Зритель').slice(0, 80),
    amount: Math.max(Number(raw.amount || 0), 0),
    currency: String(raw.currency || 'RUB'),
    platform: String(raw.platform || ''),
    manual: Boolean(raw.manual),
    at: raw.at || new Date().toISOString(),
  };
}

function normalize(raw = {}) {
  const donations = (Array.isArray(raw.donations) ? raw.donations : [])
    .map(normalizeDonation)
    .slice(0, DONATION_HISTORY_LIMIT);

  return {
    enabled: raw.enabled !== false,
    title: String(raw.title || 'Последний донат').slice(0, 80),
    minAmount: Math.max(Number(raw.minAmount ?? DEFAULT_MIN_AMOUNT), 0),
    currency: String(raw.currency || 'RUB'),
    streamMinutes: Math.max(Number(raw.streamMinutes || DEFAULT_STREAM_MINUTES), 1),
    streamStartedAt: raw.streamStartedAt || '',
    streamEndsAt: raw.streamEndsAt || '',
    finished: Boolean(raw.finished),
    tiers: (Array.isArray(raw.tiers) ? raw.tiers : [])
      .map(normalizeTier)
      .sort((a, b) => a.amount - b.amount),
    topPrizes: (Array.isArray(raw.topPrizes) ? raw.topPrizes : [])
      .map(normalizeTopPrize)
      .sort((a, b) => a.place - b.place),
    total: Math.max(Number(raw.total || 0), 0),
    donations,
  };
}

function load(storageDir) {
  fs.mkdirSync(storageDir, { recursive: true });
  stateFile = path.join(storageDir, 'lastdonation-state.json');

  if (!fs.existsSync(stateFile)) {
    state = createDefaultState();
    save(state);
    return state;
  }

  try {
    state = normalize(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch (error) {
    console.error(`[lastdonation] не удалось прочитать состояние: ${error.message}`);
    state = createDefaultState();
  }

  return state;
}

function save(next = state) {
  state = normalize(next);

  if (stateFile) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`[lastdonation] не удалось сохранить состояние: ${error.message}`);
    }
  }

  return state;
}

// Отдаём виджету уже посчитанное: он рисует, а не думает.
function payload() {
  const leaders = state.donations.slice(0, state.topPrizes.length).map((donation, index) => ({
    place: index + 1,
    username: donation.username,
    amount: donation.amount,
    at: donation.at,
    prize: state.topPrizes.find((prize) => prize.place === index + 1)?.title || '',
  }));

  const nextTier = state.tiers.find((tier) => !tier.winner) || null;
  const prevAmount = nextTier
    ? [...state.tiers].reverse().find((tier) => tier.amount < nextTier.amount && tier.winner)?.amount || 0
    : 0;
  const span = nextTier ? Math.max(nextTier.amount - prevAmount, 1) : 1;
  const progress = nextTier
    ? Math.min(Math.max((state.total - prevAmount) / span, 0), 1)
    : 1;

  // Топ-призы (главные 25000/5000/1000) открываются только когда пробита вся
  // прогрессия: пока в ней остались ступени, тройка лидеров закрыта замком.
  const lockedTiers = state.tiers.filter((tier) => !tier.winner).length;

  return {
    ...state,
    leaders,
    nextTier,
    progress,
    topUnlocked: state.tiers.length > 0 && lockedTiers === 0,
    lockedTiers,
    remainingToTier: nextTier ? Math.max(nextTier.amount - state.total, 0) : 0,
    maxTier: state.tiers.length ? state.tiers[state.tiers.length - 1].amount : 0,
    serverNow: new Date().toISOString(),
  };
}

function update(patch = {}) {
  return save({ ...state, ...patch });
}

function startStream(minutes) {
  const streamMinutes = Math.max(Number(minutes || state.streamMinutes), 1);
  const startedAt = new Date();
  return save({
    ...state,
    streamMinutes,
    streamStartedAt: startedAt.toISOString(),
    streamEndsAt: new Date(startedAt.getTime() + streamMinutes * 60000).toISOString(),
    finished: false,
  });
}

function extendStream(minutes) {
  const delta = Number(minutes || 0);
  if (!delta || !state.streamEndsAt) {
    return state;
  }

  return save({
    ...state,
    streamMinutes: Math.max(state.streamMinutes + delta, 1),
    streamEndsAt: new Date(new Date(state.streamEndsAt).getTime() + delta * 60000).toISOString(),
  });
}

function stopStream() {
  return save({ ...state, finished: true });
}

// Сброс на новый стрим: призы и настройки остаются, победители и донаты — нет.
function reset() {
  return save({
    ...state,
    total: 0,
    donations: [],
    finished: false,
    streamStartedAt: '',
    streamEndsAt: '',
    tiers: state.tiers.map((tier) => ({ ...tier, winner: null, reachedAt: '' })),
  });
}

function setTiers(list) {
  return save({ ...state, tiers: Array.isArray(list) ? list : state.tiers });
}

function setTopPrizes(list) {
  return save({ ...state, topPrizes: Array.isArray(list) ? list : state.topPrizes });
}

function removeDonation(id) {
  const donation = state.donations.find((item) => item.id === id);
  if (!donation) {
    return { state: payload(), removed: false };
  }

  const donations = state.donations.filter((item) => item.id !== id);
  save({
    ...state,
    donations,
    total: Math.max(state.total - donation.amount, 0),
  });

  return { state: payload(), removed: true };
}

// Главный вход: донат приходит сюда и из реальных алертов, и из ручного ввода.
// Возвращает список только что пробитых ступеней — по ним виджет пускает салют.
function addDonation(raw = {}) {
  const donation = normalizeDonation(raw);

  if (!state.enabled || donation.amount < state.minAmount) {
    return { state: payload(), donation: null, reachedTiers: [] };
  }

  const total = state.total + donation.amount;
  const reachedTiers = [];

  const tiers = state.tiers.map((tier) => {
    if (tier.winner || total < tier.amount) {
      return tier;
    }

    const reached = {
      ...tier,
      winner: { username: donation.username, amount: donation.amount, at: donation.at },
      reachedAt: donation.at,
    };
    reachedTiers.push(reached);
    return reached;
  });

  save({
    ...state,
    total,
    tiers,
    donations: [donation, ...state.donations].slice(0, DONATION_HISTORY_LIMIT),
  });

  return { state: payload(), donation, reachedTiers };
}

module.exports = {
  load,
  save,
  payload,
  update,
  addDonation,
  removeDonation,
  reset,
  startStream,
  extendStream,
  stopStream,
  setTiers,
  setTopPrizes,
  getState: () => state,
};
