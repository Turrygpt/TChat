const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CHALLENGES = [
  '3 главных тоста',
  'Десантные приметы',
  'Традиционное угощение',
  'Купаемся в фонтане',
  'Синева',
  'Позвать батю',
  'Кашевар',
  'Портянка!',
];

const LEGACY_CHALLENGES = [
  '10 отжиманий с хлопком',
  'Планка — 2 минуты',
  '20 берпи без остановки',
  '30 выпадов',
  'Минута в уголке',
  '25 подъёмов корпуса',
  'Армейский комплекс × 3',
  'Сюрприз от чата',
];

let stateFile = '';
let state = normalize({ challenges: DEFAULT_CHALLENGES });

function normalize(input = {}) {
  const savedChallenges = Array.isArray(input.challenges) ? input.challenges : [];
  const hasLegacyChallenges = LEGACY_CHALLENGES.every((challenge, index) => savedChallenges[index] === challenge);
  const sourceChallenges = savedChallenges.length && !hasLegacyChallenges ? savedChallenges : DEFAULT_CHALLENGES;
  const challenges = Array.from({ length: 8 }, (_, index) =>
    String(sourceChallenges[index] || DEFAULT_CHALLENGES[index]).trim().slice(0, 120) || DEFAULT_CHALLENGES[index]
  );
  const opened = Array.from({ length: 8 }, (_, index) => Boolean(input.opened?.[index]));
  const amount = Math.max(0, Number(input.amount || 0));

  return {
    title: String(input.title || 'ДЕНЬ ВДВ').trim().slice(0, 60) || 'ДЕНЬ ВДВ',
    subtitle: String(input.subtitle || 'Никто, кроме нас!').trim().slice(0, 100) || 'Никто, кроме нас!',
    challenges,
    opened,
    amount,
    pushups: Math.floor(amount / 3000) * 10,
    squats: Math.floor(amount / 1000) * 10,
    revealIndex: Number.isInteger(input.revealIndex) ? input.revealIndex : -1,
    revision: Math.max(0, Number(input.revision || 0)),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function load(directory) {
  stateFile = path.join(directory, 'vdv-widget.json');
  try {
    state = normalize(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    state = normalize({ challenges: DEFAULT_CHALLENGES });
    save(state);
  }
  return payload();
}

function save(next) {
  state = normalize(next);
  if (stateFile) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
  return payload();
}

function update(patch = {}) {
  return save({
    ...state,
    ...patch,
    opened: Array.isArray(patch.opened) ? patch.opened : state.opened,
    challenges: Array.isArray(patch.challenges) ? patch.challenges : state.challenges,
    revealIndex: -1,
    revision: state.revision + 1,
    updatedAt: new Date().toISOString(),
  });
}

function reveal(index) {
  const cardIndex = Number(index);
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 7) return payload();
  const opened = [...state.opened];
  opened[cardIndex] = true;
  return save({ ...state, opened, revealIndex: cardIndex, revision: state.revision + 1, updatedAt: new Date().toISOString() });
}

function close(index) {
  const cardIndex = Number(index);
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 7) return payload();
  return save({ ...state, revealIndex: -1, revision: state.revision + 1, updatedAt: new Date().toISOString() });
}

function resetCards() {
  return save({ ...state, opened: Array(8).fill(false), revealIndex: -1, revision: state.revision + 1, updatedAt: new Date().toISOString() });
}

function addAmount(amount) {
  const value = Math.max(0, Number(amount || 0));
  if (!value) return payload();
  return save({ ...state, amount: state.amount + value, revealIndex: -1, revision: state.revision + 1, updatedAt: new Date().toISOString() });
}

function payload() {
  return JSON.parse(JSON.stringify(state));
}

module.exports = { DEFAULT_CHALLENGES, load, payload, update, reveal, close, resetCards, addAmount };
