const fs = require('node:fs');
const path = require('node:path');
const catalog = [
  { id: 'captain', name: 'Капитан', color: '#8dbdff' },
  { id: 'mechanic', name: 'Слесарь', color: '#79e1c3' },
  { id: 'witch', name: 'Волшебница', color: '#d4a4ff' },
  { id: 'warehouse', name: 'Кладовщик', color: '#f4c47b' },
  { id: 'pilot', name: 'Лётчик', color: '#9ecaff' },
  { id: 'driver', name: 'Водитель', color: '#91c8c2' },
  { id: 'femme-fatale', name: 'Роковая женщина', color: '#f19ab0' },
  { id: 'soldier', name: 'Военный', color: '#b3c78d' },
  { id: 'gnome', name: 'Гном', color: '#eeb17d' },
  { id: 'doctor', name: 'Доктор', color: '#93d9de' },
  { id: 'builder', name: 'Строитель', color: '#ffd06d' },
  { id: 'businessman', name: 'Бизнесмен', color: '#afbadf' },
].map(item => ({ ...item, layers: { body: `/assets/chibis/${item.id}.png`, outfit: null, hat: null } }));
const positions = ['random', 'left', 'right', 'top', 'bottom'];
function normalize(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const selected = Array.isArray(value.characters) ? value.characters.filter(id => catalog.some(c => c.id === id)) : catalog.map(c => c.id);
  return { enabled: value.enabled === true, reward: String(value.reward ?? 'Выделить сообщение').trim().slice(0, 150),
    highlighted: value.highlighted !== false, platform: ['twitch', 'vk'].includes(value.platform) ? value.platform : 'any',
    position: positions.includes(value.position) ? value.position : 'random',
    seconds: Math.min(30, Math.max(3, Number(value.seconds) || 8)), characters: selected.length ? selected : catalog.map(c => c.id) };
}
function createChibis({ emit, file, resolveCharacter = () => '' } = {}) {
  let settings = normalize();
  const seen = new Set();
  let sideBag = [];
  function randomSide() {
    if (!sideBag.length) {
      sideBag = positions.slice(1);
      for (let i = sideBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sideBag[i], sideBag[j]] = [sideBag[j], sideBag[i]];
      }
    }
    return sideBag.pop();
  }
  if (file && fs.existsSync(file)) { try { settings = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (error) { console.warn('Чибики: не удалось прочитать настройки', error.message); } }
  const state = () => ({ settings, catalog });
  function save(value) {
    const next = normalize(value);
    if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(next, null, 2)); }
    settings = next;
    emit('chibis:settings', settings);
    return state();
  }
  function show(event = {}) {
    if (!event || typeof event !== 'object') event = {};
    const assigned = resolveCharacter(event);
    const character = catalog.some(item => item.id === assigned)
      ? assigned : settings.characters[Math.floor(Math.random() * settings.characters.length)];
    const item = { id: String(event.id || `chibi:${Date.now()}:${Math.random()}`), character,
      username: String(event.username || 'Зритель').slice(0, 80), message: String(event.message || 'Спасибо за стрим!').slice(0, 400),
      position: settings.position === 'random' ? randomSide() : settings.position,
      anchor: Math.random(),
      seconds: settings.seconds };
    emit('chibi:show', item); return item;
  }
  function reward(event = {}) {
    if (!settings.enabled || (settings.platform !== 'any' && settings.platform !== event.platform)) return null;
    if (event.highlighted ? !settings.highlighted : (!settings.reward || String(event.reward || '').trim().toLocaleLowerCase('ru') !== settings.reward.toLocaleLowerCase('ru'))) return null;
    if (event.id && seen.has(event.id)) return null;
    if (event.id) { seen.add(event.id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
    return show(event);
  }
  return { state, save, show, reward, clear: () => emit('chibi:clear') };
}
module.exports = { createChibis, normalize, catalog };
