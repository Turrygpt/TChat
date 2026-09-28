const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChibis, normalize, catalog } = require('../src/chibis');
const events = [];
const emit = (name, item) => events.push({ name, item });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-chibis-'));
try {
  const file = path.join(temp, 'settings.json');
  const chibis = createChibis({ emit, file });
  const reward = { id: 'reward-1', platform: 'twitch', reward: 'Выделить сообщение', username: 'Зритель', message: '<b>Это текст</b>' };
  assert.equal(chibis.reward(reward), null, 'Disabled by default');
  chibis.save({ enabled: true, characters: ['mechanic'], position: 'right', platform: 'twitch' });
  assert.equal(chibis.reward({ ...reward, platform: 'vk' }), null, 'Platform filter');
  assert.equal(chibis.reward({ ...reward, reward: 'Другая награда' }), null, 'Exact reward filter');
  const item = chibis.reward(reward);
  assert.equal(item.character, 'mechanic'); assert.equal(item.position, 'right'); assert.equal(item.message, reward.message);
  assert.equal(chibis.reward(reward), null, 'Duplicate reward ignored');
  assert.ok(chibis.reward({ ...reward, id: 'highlight', highlighted: true, reward: '' }));
  chibis.save({ ...chibis.state().settings, highlighted: false });
  assert.equal(chibis.reward({ ...reward, id: 'highlight2', highlighted: true }), null);
  assert.deepEqual(createChibis({ emit, file }).state(), chibis.state(), 'Settings survive restart');
  assert.equal(normalize({ seconds: Infinity, characters: ['missing'] }).seconds, 30);
  assert.equal(normalize({ characters: [] }).characters.length, catalog.length);
  assert.equal(chibis.show({ message: 'x'.repeat(1000) }).message.length, 400);
  chibis.clear(); assert.equal(events.at(-1).name, 'chibi:clear');
  for (const character of catalog) assert.ok(fs.existsSync(path.join(__dirname, '..', character.layers.body)));
  const random = createChibis({ emit });
  const profiles = require('../src/profiles');
  const profileDir = path.join(temp, 'profiles');
  profiles.init(profileDir);
  const viewer = profiles.upsert({ platform: 'twitch', user: 'Viewer', chibiId: 'witch' });
  const assigned = createChibis({ emit,
    resolveCharacter: event => profiles.findByUser(event.platform, event.username)?.chibiId || '',
  });
  assigned.save({ characters: ['captain'] });
  assert.equal(assigned.show({ platform: 'twitch', username: 'VIEWER' }).character, 'witch', 'Assignment overrides random pool');
  assert.equal(assigned.show({ platform: 'vk', username: 'Viewer' }).character, 'captain', 'Unlinked platform stays random');
  assert.equal(assigned.show({ platform: 'twitch', username: 'Unknown' }).character, 'captain');
  profiles.upsert({ id: viewer.id, pinned: true });
  profiles.init(profileDir);
  assert.equal(profiles.get(viewer.id).chibiId, 'witch', 'Assignment survives edits and restart');
  profiles.upsert({ id: viewer.id, nickname: 'SharedPlayer' });
  const linked = profiles.upsert({ platform: 'vk', user: 'OtherAccount', nickname: 'SharedPlayer' });
  assert.equal(assigned.show({ platform: 'vk', username: 'OtherAccount' }).character, 'witch', 'Merged accounts retain assignment');
  profiles.upsert({ id: linked.id, chibiId: '' });
  assert.equal(assigned.show({ platform: 'twitch', username: 'Viewer' }).character, 'captain', 'Reset restores random selection');
  assert.equal(profiles.upsert({ id: linked.id, chibiId: 'unknown-character' }).chibiId, '', 'Invalid assignments normalize to random');
  for (let batch = 0; batch < 5; batch++) {
    const appearances = Array.from({ length: 4 }, () => random.show());
    assert.deepEqual(appearances.map(item => item.position).sort(), ['bottom', 'left', 'right', 'top']);
    assert.ok(appearances.every(item => item.anchor >= 0 && item.anchor <= 1));
  }
  console.log('PASS chibis: reward filters, highlights, deduplication, character selection, persistence, bounds, assets, clear');
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('tchat-chibis-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
