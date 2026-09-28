const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { findRewardRule, twitchReward } = require('../src/rewardRules');
const { TwitchRewards } = require('../src/twitchRewards');

test('rules match exact titles, platforms and known prices, with fallback', () => {
  const like = { reward: 'Классный стрим', image: '/assets/reactions/like.svg', platform: 'vk', price: 900 };
  const fallback = { reward: '', image: '/fallback.png' };
  const rules = [fallback, like];
  assert.equal(findRewardRule(rules, { platform: 'vk', reward: ' классный СТРИМ ', price: 900 }), like);
  for (const event of [
    { platform: 'twitch', reward: like.reward, price: 900 },
    { platform: 'vk', reward: like.reward, price: 800 },
    { platform: 'vk', reward: like.reward, price: 0 },
    { platform: 'vk', reward: 'Не Классный стрим', price: 900 },
  ]) assert.equal(findRewardRule(rules, event), fallback);
  assert.equal(findRewardRule([{ ...like, price: 0 }], { platform: 'vk', reward: like.reward })?.image, like.image);
  assert.equal(findRewardRule([{ ...like, enabled: false }], { platform: 'vk', reward: like.reward, price: 900 }), null);
});

test('real VK parsers feed the shared sticker pipeline once per purchase', () => {
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const names = ['parseVkChatBotMessage', 'parseVkStructuredReward', 'parseVkRewardEvent', 'enqueueStickerFromReward'];
  const shown = [];
  const logged = [];
  const context = vm.createContext({
    seenRewards: new Set(), findStickerRule: (event) => findRewardRule([{ reward: 'Классный стрим', image: '/like.svg' }], event),
    rememberReward: (event) => logged.push(event), showSticker: (event) => shown.push(event),
    chibis: { reward: () => {} },
    stickerSettings: { displaySeconds: 8 }, logInfo: () => {},
  });
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
  }
  const event = context.parseVkRewardEvent({ id: 42, author: { displayName: 'Viewer' }, reward: { name: 'Классный стрим', cost: 900 } });
  assert.equal(event.price, 900);
  context.enqueueStickerFromReward(event);
  context.enqueueStickerFromReward(event);
  const botEvent = context.parseVkRewardEvent({ id: 43, author: { displayName: 'ChatBot' }, data: [
    { type: 'mention', displayName: 'Viewer2' },
    { type: 'text', content: JSON.stringify(['активировал награду «Классный стрим»']) },
  ] });
  context.enqueueStickerFromReward(botEvent);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].username, 'Viewer2');
  assert.equal(logged.length, 2);
  assert.equal(context.parseVkRewardEvent({ author: { displayName: 'Viewer' }, data: [{ type: 'text', content: 'награда «Классный стрим»' }] }), null);
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; FakeSocket.instances.push(this); }
  terminate() { this.closed = true; this.emit('close'); }
  close() { this.terminate(); }
  message(type, payload) { this.emit('message', JSON.stringify({ metadata: { message_type: type }, payload })); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Twitch subscribes, handles no-message purchases, deduplicates, migrates and revokes', async () => {
  const calls = [];
  const events = [];
  const client = new TwitchRewards({ Socket: FakeSocket, onReward: (event) => events.push(event), onStatus: () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ client_id: 'app', user_id: '123', login: 'streamer', scopes: ['channel:read:redemptions'] }) };
    },
  });
  try {
    await client.start('secret');
    const socket = FakeSocket.instances.at(-1);
    socket.message('session_welcome', { session: { id: 'session-1', keepalive_timeout_seconds: 10 } });
    await tick();
    const subscription = JSON.parse(calls[1].options.body);
    assert.equal(subscription.condition.broadcaster_user_id, '123');
    assert.equal(subscription.transport.session_id, 'session-1');
    const payload = { subscription: { type: subscription.type }, event: { id: 'one', user_name: 'Viewer', reward: { title: 'Классный стрим', cost: 900 } } };
    socket.message('notification', payload);
    socket.message('notification', payload);
    assert.equal(events.length, 1);
    assert.equal(events[0].price, 900);
    assert.equal(events[0].platform, 'twitch');
    socket.message('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } });
    const replacement = FakeSocket.instances.at(-1);
    assert.ok(!socket.closed);
    replacement.message('session_welcome', { session: { id: 'session-2' } });
    await tick();
    assert.ok(socket.closed);
    assert.equal(calls.length, 2, 'migration must not create duplicate subscriptions');
    replacement.message('notification', payload);
    assert.equal(events.length, 1);
    replacement.message('revocation', {});
    assert.equal(client.token, '');
    assert.match(client.status, /отозвал/);
  } finally { client.stop(); }
});

test('Twitch rejects tokens without redemption scope and malformed events', async () => {
  const client = new TwitchRewards({ onReward: () => {}, onStatus: () => {}, Socket: FakeSocket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ user_id: '123', scopes: ['chat:read'] }) }),
  });
  await client.start('secret');
  assert.match(client.status, /channel:read:redemptions/);
  assert.equal(client.sockets.size, 0);
  assert.equal(twitchReward({}), null);
  client.stop();
});
