'use strict';

// Профили зрителей — CRM по избранным пользователям чата. Не для всех, а для тех,
// кого стример решил вести: bio, профессия, хобби, черты характера и таймлайн
// общения (заметки, донаты, события — «болел», «сменил работу» и т.п.).
//
// Содержимое профиля пишет только ИИ по переписке зрителя: руками ничего
// заполнять не нужно и нельзя. Стример задаёт лишь ник, закрепление и может
// добавить свои заметки в таймлайн — они идут в ИИ как дополнительный контекст.
//
// Хранилище — userData/settings/profiles.json. Ключ профиля стабильный:
// `${platform}:${нормализованный ник}`, тот же, что использует чат для фильтров,
// так что правый клик по нику в чате находит или заводит профиль однозначно.
//
// Сообщения зрителя лежат рядом с профилем — settings/profile-messages/*.jsonl,
// свой файл на каждого. При заведении профиля файл один раз наполняется из общего
// архива чата, дальше каждое новое сообщение этого зрителя дописывается в конец.
// Поэтому ни портрету, ни статистике больше не нужно перечитывать весь chat.jsonl.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let file = '';
let messagesDir = '';
let profiles = [];

function normalizeUser(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function makeId(platform, user) {
  return `${String(platform || '').toLowerCase()}:${normalizeUser(user)}`;
}

function normalizeEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const text = String(entry.text || '').trim();
  if (!text) {
    return null;
  }
  const date = String(entry.date || '').trim();
  return {
    id: String(entry.id || `t-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
    // note — заметка, event — событие в жизни, health — болезнь/самочувствие,
    // trip — поездка или переезд, purchase — покупка, donation — донат.
    type: ['note', 'event', 'health', 'trip', 'purchase', 'donation'].includes(entry.type) ? entry.type : 'note',
    // ai — событие вытащил анализ переписки, manual — заметка стримера.
    source: entry.source === 'ai' ? 'ai' : 'manual',
    text,
  };
}

function sortTimeline(timeline = []) {
  return [...timeline].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeProfile(profile = {}) {
  const platform = String(profile.platform || '').toLowerCase();
  const user = String(profile.user || '').trim();
  const asArray = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    id: String(profile.id || makeId(platform, user)),
    platform,
    user,
    displayName: String(profile.displayName || user || 'Зритель'),
    bio: String(profile.bio || ''),
    profession: String(profile.profession || ''),
    hobbies: asArray(profile.hobbies),
    traits: asArray(profile.traits),
    // Интересные факты о человеке — то, что вытащил анализ чата.
    facts: asArray(profile.facts),
    timeline: sortTimeline(
      Array.isArray(profile.timeline) ? profile.timeline.map(normalizeEntry).filter(Boolean) : [],
    ),
    // aiSummary — краткая сводка «о нашем общении», результат анализа переписки.
    aiSummary: String(profile.aiSummary || ''),
    aiUpdatedAt: profile.aiUpdatedAt || '',
    // Состояние генерации портрета: '' — ещё не запускалась, pending — идёт,
    // ready — портрет готов, error — последняя попытка упала (текст в aiError).
    aiStatus: ['pending', 'ready', 'error'].includes(profile.aiStatus) ? profile.aiStatus : '',
    aiError: String(profile.aiError || ''),
    // Другие ники того же человека: он пишет то из VK, то из Twitch, то под
    // сокращением имени. Сообщения со всех этих ников идут в один лог и в один
    // портрет, иначе на одного человека заводится три половинчатых профиля.
    aliases: asArray(profile.aliases).map(normalizeUser).filter(Boolean),
    // Кто это для канала: зритель или стример. Стример — не зритель: у него
    // портрет пишется про него самого, а не про то, как он общается со стримером.
    role: profile.role === 'streamer' ? 'streamer' : 'viewer',
    // Что стример знает про человека наверняка (родство, роль на канале).
    // Не часть портрета — это вводные для ИИ, как и заметки в таймлайне.
    note: String(profile.note || ''),
    // Утверждения, которые ИИ выдумал или переврал, а стример пометил как
    // неверные. Портрет по-прежнему пишет ИИ — стример только говорит, что
    // неправда: при следующей сборке эти утверждения не повторяются.
    corrections: (Array.isArray(profile.corrections) ? profile.corrections : [])
      .map((c) => {
        const text = String(c?.text || '').trim();
        if (!text) {
          return null;
        }
        return {
          id: String(c.id || `c-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
          text,
          date: String(c.date || new Date().toISOString().slice(0, 10)),
        };
      })
      .filter(Boolean),
    // Наполнен ли лог сообщений из общего архива чата (делается один раз).
    messagesSeeded: Boolean(profile.messagesSeeded),
    // Сколько сообщений из лога уже учтено в портрете: следующий разбор берёт
    // только хвост после этой отметки и обновляет им прежний портрет.
    messagesAnalyzed: Number(profile.messagesAnalyzed) || 0,
    pinned: Boolean(profile.pinned),
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || new Date().toISOString(),
  };
}

function load() {
  if (!file || !fs.existsSync(file)) {
    profiles = [];
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    profiles = Array.isArray(raw?.profiles) ? raw.profiles.map(normalizeProfile) : [];
  } catch (error) {
    console.error(`[profiles] не удалось прочитать: ${error.message}`);
    profiles = [];
  }
}

function save() {
  if (!file) {
    return;
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ profiles }, null, 2));
  } catch (error) {
    console.error(`[profiles] не удалось сохранить: ${error.message}`);
  }
}

function init(storageDir) {
  file = path.join(storageDir, 'profiles.json');
  messagesDir = path.join(storageDir, 'profile-messages');
  try {
    fs.mkdirSync(messagesDir, { recursive: true });
  } catch (error) {
    console.error(`[profiles] не удалось создать папку сообщений: ${error.message}`);
  }
  load();
}

// --- Лог сообщений зрителя ----------------------------------------------------

// Имя файла из ключа профиля: в ключе есть двоеточие и кириллица, поэтому берём
// платформу для читаемости и хеш ключа — чтобы имя было валидным и уникальным.
function messagesFile(id) {
  const platform = String(id).split(':')[0].replace(/[^a-z0-9]/gi, '') || 'chat';
  const hash = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
  return path.join(messagesDir, `${platform}-${hash}.jsonl`);
}

function parseMessageLine(line) {
  try {
    const raw = JSON.parse(line);
    const text = String(raw.text || '').trim();
    if (!text) {
      return null;
    }
    return { text, createdAt: raw.createdAt || '' };
  } catch {
    return null;
  }
}

// Все сохранённые сообщения зрителя, по порядку. Файл маленький — он на одного
// человека, так что читаем целиком.
function readMessages(id, limit = 0) {
  if (!messagesDir) {
    return [];
  }
  const target = messagesFile(id);
  if (!fs.existsSync(target)) {
    return [];
  }
  try {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    const parsed = lines.map(parseMessageLine).filter(Boolean);
    return limit > 0 ? parsed.slice(-limit) : parsed;
  } catch (error) {
    console.error(`[profiles] не удалось прочитать сообщения: ${error.message}`);
    return [];
  }
}

// Сколько сообщений и когда зритель писал — считается по его же логу.
function messageStats(id) {
  const messages = readMessages(id);
  let firstSeen = 0;
  let lastSeen = 0;
  for (const message of messages) {
    const ts = message.createdAt ? new Date(message.createdAt).getTime() : 0;
    if (!ts) continue;
    if (!firstSeen || ts < firstSeen) firstSeen = ts;
    if (ts > lastSeen) lastSeen = ts;
  }
  return { messageCount: messages.length, firstSeen, lastSeen };
}

// Сообщения, пришедшие в чат, пока лог профиля ещё наполнялся архивом: класть
// их в файл рано (наполнение перезапишет его), потерять — жалко.
const pendingMessages = new Map();

// Первичное наполнение лога из общего архива чата — один раз на профиль.
function seedMessages(id, messages = []) {
  const profile = get(id);
  if (!profile || !messagesDir) {
    return false;
  }
  const seen = new Set();
  const all = [...messages, ...(pendingMessages.get(id) || [])];
  pendingMessages.delete(id);
  const payload = all
    .map((m) => ({ text: String(m.text || '').trim(), createdAt: m.createdAt || '' }))
    .filter((m) => {
      if (!m.text) {
        return false;
      }
      const key = `${m.createdAt}|${m.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((m) => JSON.stringify(m))
    .join('\n');
  try {
    fs.writeFileSync(messagesFile(id), payload ? `${payload}\n` : '');
  } catch (error) {
    console.error(`[profiles] не удалось сохранить сообщения: ${error.message}`);
    return false;
  }
  profile.messagesSeeded = true;
  save();
  return true;
}

// Новое сообщение из чата: если у автора есть профиль — дописываем в его лог.
// Возвращает id профиля, чтобы вызывающий знал, что что-то изменилось.
function recordMessage(message = {}) {
  if (!messagesDir) {
    return '';
  }
  const text = String(message.text || '').trim();
  if (!text) {
    return '';
  }
  // Ищем с учётом псевдонимов: сообщение под вторым ником того же человека
  // должно попасть в его же лог, а не потеряться.
  const profile = findByUser(message.platform, message.user);
  if (!profile) {
    // Профиля нет — сообщение и так лежит в общем архиве чата.
    return '';
  }
  const id = profile.id;
  const entry = { text, createdAt: message.createdAt || new Date().toISOString() };
  if (!profile.messagesSeeded) {
    // Лог ещё наполняется архивом — придержим сообщение до конца наполнения.
    const queue = pendingMessages.get(id) || [];
    queue.push(entry);
    pendingMessages.set(id, queue);
    return '';
  }
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFile(messagesFile(id), line, (error) => {
    if (error) {
      console.error(`[profiles] не удалось дописать сообщение: ${error.message}`);
    }
  });
  return id;
}

function dropMessages(id) {
  if (!messagesDir) {
    return;
  }
  try {
    fs.rmSync(messagesFile(id), { force: true });
  } catch (error) {
    console.error(`[profiles] не удалось удалить сообщения: ${error.message}`);
  }
}

// Закреплённые сверху, дальше по алфавиту отображаемого имени.
function list() {
  return [...profiles].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName, 'ru');
  });
}

function get(id) {
  return profiles.find((p) => p.id === id) || null;
}

// Профиль этого ника: сначала по точному ключу платформы, потом по псевдонимам.
// Псевдоним сравнивается без платформы — один и тот же человек пишет и из VK,
// и из Twitch под тем же именем.
function findByUser(platform, user) {
  const id = makeId(platform, user);
  const exact = profiles.find((p) => p.id === id);
  if (exact) {
    return exact;
  }
  const nick = normalizeUser(user);
  if (!nick) {
    return null;
  }
  return profiles.find((p) => p.aliases.includes(nick)) || null;
}

// Все ники профиля (основной + псевдонимы) — по ним собираются сообщения.
function nicksOf(profile) {
  if (!profile) {
    return [];
  }
  return [...new Set([normalizeUser(profile.user), ...profile.aliases].filter(Boolean))];
}

// Поля, которые пишет только анализ переписки (applyAiResult). Из патчей
// интерфейса они выбрасываются: портрет зрителя делает ИИ, а не руки.
// Псевдонимы, роль и заметка сюда не входят: это не портрет, а вводные о том,
// кто перед нами. Их задаёт стример, а ИИ уже пишет по ним портрет.
const AI_OWNED_FIELDS = ['bio', 'profession', 'hobbies', 'traits', 'facts', 'aiSummary', 'aiUpdatedAt', 'aiStatus', 'aiError'];

// Создаёт/обновляет профиль. Из патча берём только ник, платформу, отображаемое
// имя и закрепление. Возвращает нормализованную запись.
function upsert(patch = {}) {
  const id = patch.id || makeId(patch.platform, patch.user);
  const existing = profiles.find((p) => p.id === id);
  const safePatch = { ...patch };
  for (const field of AI_OWNED_FIELDS) {
    delete safePatch[field];
  }
  delete safePatch.timeline;
  const merged = normalizeProfile({
    ...(existing || {}),
    ...safePatch,
    id,
    // ключевые поля не перетираем пустыми из патча
    platform: safePatch.platform || existing?.platform || (id.split(':')[0] || ''),
    user: safePatch.user || existing?.user || '',
    createdAt: existing?.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (existing) {
    profiles = profiles.map((p) => (p.id === id ? merged : p));
  } else {
    profiles.push(merged);
  }
  save();
  return merged;
}

// Заводит минимальный профиль для ника из чата, если его ещё нет.
function ensureForUser({ platform, user, displayName } = {}) {
  const existing = findByUser(platform, user);
  if (existing) {
    return existing;
  }
  return upsert({ platform, user, displayName: displayName || user });
}

function remove(id) {
  const before = profiles.length;
  profiles = profiles.filter((p) => p.id !== id);
  if (profiles.length !== before) {
    dropMessages(id);
    save();
    return true;
  }
  return false;
}

function addTimelineEntry(id, entry) {
  const profile = get(id);
  if (!profile) {
    return null;
  }
  const normalized = normalizeEntry({ ...entry, source: 'manual' });
  if (!normalized) {
    return null;
  }
  profile.timeline = sortTimeline([...profile.timeline, normalized]);
  profile.updatedAt = new Date().toISOString();
  save();
  return normalized;
}

function removeTimelineEntry(id, entryId) {
  const profile = get(id);
  if (!profile) {
    return false;
  }
  const before = profile.timeline.length;
  profile.timeline = profile.timeline.filter((e) => e.id !== entryId);
  if (profile.timeline.length !== before) {
    profile.updatedAt = new Date().toISOString();
    save();
    return true;
  }
  return false;
}

// Применяет результат анализа чата. Текстовые поля портрета модель всегда
// возвращает целиком — их переписываем: автор у них один, ИИ.
//
// Таймлайн: при полном разборе ИИ-события заменяются, при обновлении по новым
// сообщениям (mergeTimeline) — дописываются к прежним с дедупом, потому что
// модель в этом режиме видит только хвост переписки и старые события не вернёт.
// Заметки стримера не трогаются никогда.
function applyAiResult(id, result = {}, options = {}) {
  const profile = get(id);
  if (!profile) {
    return null;
  }
  const asArray = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

  // Подстраховка на случай, если модель всё же повторит помеченное как неверное.
  const wrong = new Set(profile.corrections.map((c) => c.text.trim().toLowerCase()));
  const keep = (value) => !wrong.has(String(value || '').trim().toLowerCase());

  profile.aiSummary = String(result.summary || result.aiSummary || '').trim();
  profile.bio = keep(result.bio) ? String(result.bio || '').trim() : '';
  profile.profession = keep(result.profession) ? String(result.profession || '').trim() : '';
  profile.hobbies = asArray(result.hobbies).filter(keep);
  profile.traits = asArray(result.traits).filter(keep);
  profile.facts = asArray(result.facts).filter(keep);

  const aiEntries = (Array.isArray(result.timeline) ? result.timeline : [])
    .map((entry) => normalizeEntry({ ...entry, source: 'ai' }))
    .filter(Boolean);
  const kept = options.mergeTimeline ? profile.timeline : profile.timeline.filter((e) => e.source !== 'ai');
  const seen = new Set(kept.map((e) => `${e.date}|${e.text.toLowerCase()}`));
  const added = aiEntries.filter((e) => {
    const key = `${e.date}|${e.text.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  profile.timeline = sortTimeline([...kept, ...added]);

  if (Number.isFinite(options.analyzedCount)) {
    profile.messagesAnalyzed = Math.max(0, Math.floor(options.analyzedCount));
  }
  profile.aiStatus = 'ready';
  profile.aiError = '';
  profile.aiUpdatedAt = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();
  save();
  return profile;
}

// Стример пометил утверждение как неверное. Убираем его из портрета сразу — и
// запоминаем, чтобы следующая сборка его не повторила.
function addCorrection(id, text) {
  const profile = get(id);
  const claim = String(text || '').trim();
  if (!profile || !claim) {
    return null;
  }
  const same = (value) => String(value || '').trim().toLowerCase() === claim.toLowerCase();
  if (!profile.corrections.some((c) => same(c.text))) {
    profile.corrections.push({
      id: `c-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      text: claim,
      date: new Date().toISOString().slice(0, 10),
    });
  }

  profile.facts = profile.facts.filter((f) => !same(f));
  profile.hobbies = profile.hobbies.filter((h) => !same(h));
  profile.traits = profile.traits.filter((t) => !same(t));
  if (same(profile.bio)) profile.bio = '';
  if (same(profile.profession)) profile.profession = '';
  if (same(profile.aiSummary)) profile.aiSummary = '';

  profile.updatedAt = new Date().toISOString();
  save();
  return profile;
}

function removeCorrection(id, correctionId) {
  const profile = get(id);
  if (!profile) {
    return false;
  }
  const before = profile.corrections.length;
  profile.corrections = profile.corrections.filter((c) => c.id !== correctionId);
  if (profile.corrections.length === before) {
    return false;
  }
  profile.updatedAt = new Date().toISOString();
  save();
  return true;
}

// Состояние генерации портрета — чтобы интерфейс показывал «собираю портрет…»
// и текст ошибки вместо пустой карточки.
function setAiStatus(id, status, error = '') {
  const profile = get(id);
  if (!profile) {
    return null;
  }
  profile.aiStatus = ['pending', 'ready', 'error'].includes(status) ? status : '';
  profile.aiError = status === 'error' ? String(error || '') : '';
  save();
  return profile;
}

module.exports = {
  init,
  makeId,
  list,
  get,
  findByUser,
  upsert,
  ensureForUser,
  remove,
  addTimelineEntry,
  removeTimelineEntry,
  applyAiResult,
  setAiStatus,
  readMessages,
  messageStats,
  seedMessages,
  recordMessage,
  nicksOf,
  addCorrection,
  removeCorrection,
};
