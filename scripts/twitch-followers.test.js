const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TwitchFollowers, twitchFollower } = require('../src/twitchFollowers');

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; FakeSocket.instances.push(this); }
  terminate() { this.closed = true; this.emit('close'); }
  close() { this.terminate(); }
  message(type, payload) { this.emit('message', JSON.stringify({ metadata: { message_type: type }, payload })); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const info = { client_id: 'app', user_id: '123', login: 'streamer', scopes: ['moderator:read:followers'] };
const follow = { broadcaster_user_id: '123', user_id: '456', user_login: 'viewer', user_name: 'Viewer', followed_at: '2026-10-04T10:00:00Z' };
const notification = (event = follow) => ({ subscription: { type: 'channel.follow' }, event });

function createClient(options = {}) {
  const calls = [], messages = [], subscribers = [], statuses = [];
  const client = new TwitchFollowers({
    Socket: FakeSocket, getChannel: () => 'streamer',
    publish: (message) => messages.push(message), subscriberAlert: (event) => subscribers.push(event),
    onStatus: (status) => statuses.push(status),
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return { ok: true, json: async () => info };
    },
    ...options,
  });
  return { client, calls, messages, subscribers, statuses };
}
async function connect(client) {
  await client.start('oauth:secret');
  const socket = FakeSocket.instances.at(-1);
  socket.message('session_welcome', { session: { id: 'session-1', keepalive_timeout_seconds: 10 } });
  await tick();
  return socket;
}

test('follows use EventSub v2 with the owner as broadcaster and moderator', async () => {
  const { client, calls, statuses } = createClient();
  try {
    await connect(client);
    assert.equal(calls[0].request.headers.Authorization, 'OAuth secret');
    const request = calls[1].request;
    assert.equal(request.headers.Authorization, 'Bearer secret');
    assert.equal(request.headers['Client-Id'], 'app');
    assert.deepEqual(JSON.parse(request.body), {
      type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '123', moderator_user_id: '123' },
      transport: { method: 'websocket', session_id: 'session-1' },
    });
    assert.match(client.status, /Подключено: streamer.*фолловеры/);
    assert.ok(statuses.every((status) => !status.includes('secret')));
  } finally { client.stop(); }
});

test('new followers reach chat and alerts once; a later refollow is a new event', async () => {
  const { client, messages, subscribers } = createClient();
  try {
    const socket = await connect(client);
    socket.message('notification', notification());
    socket.message('notification', notification());
    assert.equal(messages.length, 1);
    assert.equal(subscribers.length, 1);
    assert.equal(messages[0].user, 'Viewer');
    assert.equal(messages[0].systemEvent, 'twitch-follow');
    assert.equal(messages[0].highlighted, false, 'OBS must display the follow message');
    assert.deepEqual(messages[0].parts, [{ type: 'text', text: 'теперь отслеживает канал' }]);
    assert.equal(messages[0].id, subscribers[0].id);
    assert.equal(subscribers[0].createdAt, follow.followed_at);
    socket.message('notification', notification({ ...follow, followed_at: '2026-10-04T11:00:00Z' }));
    assert.equal(messages.length, 2);
    assert.notEqual(messages[0].id, messages[1].id);
  } finally { client.stop(); }
});

test('followers remain in chat when subscriber alerts are disabled', async () => {
  const { client, messages } = createClient({ subscriberAlert: () => null });
  try {
    const socket = await connect(client);
    socket.message('notification', notification());
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'теперь отслеживает канал');
  } finally { client.stop(); }
});

test('malformed, unrelated and wrong-channel events are ignored', async () => {
  const { client, messages } = createClient();
  try {
    const socket = await connect(client);
    for (const event of [{}, { ...follow, user_id: '' }, { ...follow, followed_at: 'invalid' }, { ...follow, broadcaster_user_id: '999' }]) {
      socket.message('notification', notification(event));
    }
    socket.message('notification', { ...notification(), subscription: { type: 'channel.subscribe' } });
    assert.equal(messages.length, 0);
    assert.equal(twitchFollower({ ...follow, user_name: '', user_login: 'fallback' }, '123').username, 'fallback');
  } finally { client.stop(); }
});

test('missing scope, wrong owner, missing channel and invalid tokens show actionable status', async () => {
  for (const [options, expected] of [
    [{ getChannel: () => '' }, /укажите.*канал/],
    [{ fetchImpl: async () => ({ ok: true, json: async () => ({ ...info, scopes: ['chat:read'] }) }) }, /moderator:read:followers/],
    [{ getChannel: () => 'another' }, /владельца канала another/],
    [{ fetchImpl: async () => ({ ok: true, json: async () => ({ client_id: 'app' }) }) }, /пользовательский токен/],
    [{ fetchImpl: async () => ({ ok: false, status: 401 }) }, /недействителен/],
    [{ fetchImpl: async () => { throw new Error('fetch failed'); } }, /fetch failed/],
  ]) {
    const { client } = createClient(options);
    try {
      await client.start('secret');
      assert.match(client.status, expected);
      assert.equal(client.sockets.size, 0);
      assert.equal(client.token, '');
    } finally { client.stop(); }
  }
});

test('subscription refusal stays non-fatal and clears the token', async () => {
  const { client } = createClient({ fetchImpl: async (url) => url.includes('/validate')
    ? { ok: true, json: async () => info } : { ok: false, status: 403 } });
  try {
    await connect(client);
    assert.match(client.status, /фолловеры.*HTTP 403/);
    assert.equal(client.sockets.size, 0);
    assert.equal(client.token, '');
  } finally { client.stop(); }
});

test('session migration preserves deduplication without creating another subscription', async () => {
  const { client, calls, messages } = createClient();
  try {
    const socket = await connect(client);
    socket.message('notification', notification());
    socket.message('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } });
    const replacement = FakeSocket.instances.at(-1);
    assert.notEqual(socket, replacement);
    assert.ok(!socket.closed);
    replacement.message('session_welcome', { session: { id: 'session-2' } });
    await tick();
    assert.ok(socket.closed);
    assert.equal(calls.length, 2);
    replacement.message('notification', notification());
    assert.equal(messages.length, 1);
    replacement.message('revocation', {});
    assert.equal(client.token, '');
    assert.match(client.status, /отозвал.*фолловеры/);
  } finally { client.stop(); }
});

test('lost connections report reconnect status; unsafe reconnect URLs are rejected', async () => {
  const { client, messages } = createClient();
  try {
    const socket = await connect(client);
    socket.terminate();
    assert.match(client.status, /повтор через 5 секунд/);
    socket.message('notification', notification());
    assert.equal(messages.length, 0, 'a closed socket cannot deliver followers');
    await connect(client);
    FakeSocket.instances.at(-1).message('session_reconnect', { session: { reconnect_url: 'wss://example.com/ws' } });
    assert.equal(client.token, '');
    assert.match(client.status, /Некорректный адрес/);
  } finally { client.stop(); }
});

test('a channel change during authorization and disconnect during subscription cannot revive the session', async () => {
  let channel = 'streamer';
  let finishValidation;
  const { client } = createClient({ getChannel: () => channel,
    fetchImpl: () => new Promise((resolve) => { finishValidation = resolve; }) });
  try {
    const pending = client.start('secret');
    channel = 'another';
    finishValidation({ ok: true, json: async () => info });
    await pending;
    assert.equal(client.sockets.size, 0);
    assert.match(client.status, /Канал Twitch изменён/);
  } finally { client.stop(); }

  let finishSubscription;
  const next = createClient({ fetchImpl: async (url) => url.includes('/validate')
    ? { ok: true, json: async () => info }
    : new Promise((resolve) => { finishSubscription = resolve; }) });
  try {
    await next.client.start('secret');
    FakeSocket.instances.at(-1).message('session_welcome', { session: { id: 'session' } });
    next.client.stop();
    next.client.report('Не подключено');
    finishSubscription({ ok: true });
    await tick();
    assert.equal(next.client.status, 'Не подключено');
    assert.equal(next.client.sockets.size, 0);
  } finally { next.client.stop(); }
});
