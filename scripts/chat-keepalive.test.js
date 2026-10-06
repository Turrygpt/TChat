'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const { tmi, singleFlight, watchTwitchConnection, retireTwitchClient } = require('../src/net/chatKeepAlive');
const { installAxiosKeepAlive } = require('../src/net/ytProxy');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await wait(10);
  }
  assert.ok(predicate(), 'condition must become true within one second');
}

async function localTwitch(t, { welcome = true } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const state = { connections: 0, pings: 0, reply: true };
  server.on('connection', (socket) => {
    state.connections++;
    socket.on('message', (raw) => {
      const frame = String(raw);
      if (frame.startsWith('NICK ') && welcome) {
        const nick = frame.slice(5).trim();
        socket.send(`:tmi.twitch.tv 001 ${nick} :Welcome\r\n:tmi.twitch.tv 376 ${nick} :End of MOTD\r\n`);
      }
      if (frame === 'PING') {
        state.pings++;
        if (state.reply) socket.send('PONG :tmi.twitch.tv');
      }
    });
  });
  const client = new tmi.Client({
    options: { skipUpdatingEmotesets: true },
    connection: { server: '127.0.0.1', port: server.address().port, secure: false,
      reconnectInterval: 10, maxReconnectInterval: 20 },
    channels: [],
  });
  const failures = [];
  const stop = watchTwitchConnection(client, { pingIntervalMs: 30, timeoutMs: 50,
    connectTimeoutMs: 100, checkIntervalMs: 5, onTimeout: (reason) => failures.push(reason) });
  t.after(async () => {
    stop();
    retireTwitchClient(client);
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  client.connect().catch(() => {});
  return { client, state, failures, stop };
}

test('Twitch: an idle chat stays alive and a lost PONG triggers automatic reconnect', async (t) => {
  const { state, failures } = await localTwitch(t);
  await until(() => state.pings >= 2);
  assert.equal(state.connections, 1, 'an empty but responsive chat must stay connected');
  assert.deepEqual(failures, []);
  state.reply = false;
  await until(() => state.connections >= 2);
  assert.ok(failures.includes('нет ответа на PING'));
  state.reply = true;
  await until(() => state.pings >= 4);
});

test('Twitch: a silent IRC handshake is terminated and retried', async (t) => {
  const { state, failures } = await localTwitch(t, { welcome: false });
  await until(() => state.connections >= 2);
  assert.ok(failures.includes('таймаут подключения'));
});

test('Twitch: retiring a disconnected client cancels an already queued reconnect', async (t) => {
  const { client, state, stop } = await localTwitch(t);
  await until(() => state.pings >= 1);
  const reconnect = once(client, 'reconnect');
  client.ws.terminate();
  await reconnect;
  stop();
  retireTwitchClient(client);
  await wait(100);
  assert.equal(state.connections, 1);
});

test('polling: repeated ticks share a stalled request and recover after failure', async () => {
  let attempts = 0;
  let reject;
  const poll = singleFlight(() => {
    attempts++;
    return attempts === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : 42;
  });
  const first = poll();
  assert.equal(poll(), first);
  await Promise.resolve();
  assert.equal(attempts, 1);
  reject(new Error('ECONNRESET'));
  await assert.rejects(first, /ECONNRESET/);
  assert.equal(await poll(), 42);
  assert.equal(attempts, 2);
});

test('YouTube: keep-alive and deadlines apply without a proxy, fresh on retry', async () => {
  const requests = [];
  const instance = axios.create({ adapter: async (config) => {
    requests.push(config);
    return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
  } });
  installAxiosKeepAlive(instance);
  await instance.get('https://www.youtube.com/watch?v=test');
  const config = requests[0];
  assert.equal(config.timeout, 15000);
  assert.equal(config.httpsAgent.keepAlive, true);
  assert.ok(config.signal instanceof AbortSignal);
  await instance.request(config);
  assert.notEqual(requests[1].signal, config.signal, 'fallback must not inherit an expired deadline');
  await instance.get('https://api.live.vkvideo.ru/v1/test');
  assert.equal(requests[2].timeout, 0, 'other integrations keep their own request settings');
});

test('YouTube: caller cancellation and a configured proxy agent are preserved', async () => {
  const controller = new AbortController();
  const instance = axios.create({ adapter: async (config) => {
    assert.equal(config.httpsAgent, agent);
    controller.abort();
    assert.equal(config.signal.aborted, true);
    return { status: 200, data: {}, headers: {}, config };
  } });
  const agent = new (require('node:https').Agent)();
  installAxiosKeepAlive(instance);
  await assert.rejects(instance.get('https://www.youtube.com/live', {
    signal: controller.signal, httpsAgent: agent,
  }), (error) => axios.isCancel(error));
});

test('YouTube: a stalled HTTP response is aborted and the next request succeeds', async (t) => {
  let stalled = true;
  const server = http.createServer((_request, response) => {
    if (stalled) { response.writeHead(200); response.write('partial'); }
    else response.end('recovered');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = new http.Agent({ keepAlive: true, lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) });
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const instance = axios.create({ httpAgent: agent, proxy: false });
  installAxiosKeepAlive(instance, 100);
  const url = `http://www.youtube.com:${server.address().port}/live`;
  await assert.rejects(instance.get(url));
  stalled = false;
  assert.equal((await instance.get(url)).data, 'recovered');
});

function youtubeHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const clients = [];
  const messages = [];
  class FakeLiveChat extends EventEmitter {
    constructor() { super(); clients.push(this); this.stopped = false; }
    async start() { this.emit('start'); return true; }
    stop() { this.stopped = true; this.emit('end'); }
  }
  const context = vm.createContext({
    LiveChat: FakeLiveChat, youtubeClient: null, youtubeLiveId: '', youtubeRetryLiveId: '',
    youtubeAttaching: false, youtubeMessageIds: new Set(),
    currentChannels: { youtube: 'channel', twitch: '', vk: '', rutube: '' },
    chatStats: { platformStatus: {}, viewers: { youtube: 12 } },
    twitchViewerState: { lastViewers: 0, zeroViewerSince: 0 },
    vkConnectionState: { lastViewers: 0 }, ZERO_VIEWER_GRACE_MS: 30000,
    broadcastChatStatus() {}, logInfo() {}, console,
    buildYouTubeMessageParts: async () => [{ type: 'text', text: 'hello' }],
    buildYouTubeBadges: async () => [], getPlatformIconUrl: () => '',
    broadcastChatMessage: (message) => messages.push(message),
    parseTwitchChannel: () => '', fetchTwitchViewerCount: async () => 0,
    fetchRutubeViewerCount: async () => 0,
    fetchYouTubeLiveState: async () => { throw new Error('ECONNRESET'); },
  });
  vm.runInContext(source.slice(source.indexOf('function detachYouTubeChat()'), source.indexOf('const BADGE_ROLE_ALIASES')), context);
  vm.runInContext(source.slice(source.indexOf('async function refreshViewerCountsOnce()'), source.indexOf('async function fetchTwitchViewerCount(')), context);
  return { context, clients, messages };
}

test('YouTube: a failed chat reconnects even when channel discovery is unreachable', async () => {
  const { context, clients, messages } = youtubeHarness();
  await context.syncYouTubeChat('live123');
  assert.equal(clients.length, 1);
  await context.refreshViewerCountsOnce();
  assert.equal(clients.length, 1, 'no messages does not mean a healthy chat is dead');
  clients[0].emit('chat', { id: 'msg1', timestamp: new Date() });
  await wait(0);
  clients[0].emit('error', new Error('ECONNRESET'));
  assert.equal(context.youtubeClient, null);
  assert.equal(clients[0].stopped, true);
  await context.refreshViewerCountsOnce();
  assert.equal(clients.length, 2);
  assert.equal(context.chatStats.platformStatus.youtube, 'подключён');
  assert.equal(context.chatStats.viewers.youtube, 12);
  clients[0].emit('error', new Error('late failure'));
  assert.equal(context.youtubeClient, clients[1], 'retired client must not overwrite the new connection');
  clients[1].emit('chat', { id: 'msg1', timestamp: new Date() });
  await wait(0);
  assert.equal(messages.length, 1, 'reconnect backlog must not duplicate messages');
  context.fetchYouTubeLiveState = async () => ({ liveId: '', viewers: 0 });
  await context.refreshViewerCountsOnce();
  assert.equal(context.youtubeRetryLiveId, '', 'an ended broadcast must stop retries');
  assert.equal(context.youtubeClient, null);
});

test('YouTube: a late start after changing channels is stopped without changing status', async () => {
  const { context, clients } = youtubeHarness();
  let finish;
  context.LiveChat.prototype.start = function () {
    return new Promise((resolve) => { finish = () => { this.emit('start'); resolve(true); }; });
  };
  const attaching = context.syncYouTubeChat('oldlive');
  await context.connectYouTubeChat('newchannel');
  finish();
  await attaching;
  assert.equal(clients[0].stopped, true);
  assert.equal(context.youtubeClient, null);
  assert.equal(context.chatStats.platformStatus.youtube, 'ищем эфир');
});

test('YouTube: reconnecting during asset loading does not lose the unfinished message', async () => {
  const { context, clients, messages } = youtubeHarness();
  let finish;
  let calls = 0;
  context.buildYouTubeMessageParts = () => ++calls === 1
    ? new Promise((resolve) => { finish = () => resolve([{ type: 'text', text: 'hello' }]); })
    : Promise.resolve([{ type: 'text', text: 'hello' }]);
  await context.syncYouTubeChat('live123');
  clients[0].emit('chat', { id: 'msg1', timestamp: new Date() });
  clients[0].emit('error', new Error('ECONNRESET'));
  await context.refreshViewerCountsOnce();
  clients[1].emit('chat', { id: 'msg1', timestamp: new Date() });
  await wait(0);
  assert.equal(messages.length, 1);
  finish();
  await wait(0);
  assert.equal(messages.length, 1);
});

test('VK: a chat-only network failure is reported, while an unavailable chat remains non-fatal', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  let failure = new Error('ECONNRESET');
  const context = vm.createContext({
    VK_API_BASE: 'https://example.test', parseVkChannelSlug: () => 'test',
    fetchJsonWithRetry: async (url) => {
      if (url.includes('/chat?')) throw failure;
      return { viewers: 12 };
    },
    unwrapVkStreamPayload: (data) => data, extractVkViewerCount: (stream) => stream.viewers,
    extractVkLikeCount: () => 0, mapVkChatItems: async () => [],
  });
  vm.runInContext(source.slice(source.indexOf('function isVkTransientError('), source.indexOf('function formatVkFetchError(')), context);
  vm.runInContext(source.slice(source.indexOf('async function fetchVkState('), source.indexOf('async function buildVkBadges(')), context);
  await assert.rejects(context.fetchVkState('test'), /ECONNRESET/);
  failure = new Error('HTTP 503');
  await assert.rejects(context.fetchVkState('test'), /HTTP 503/);
  failure = new Error('HTTP 404');
  const state = await context.fetchVkState('test');
  assert.equal(state.chatAvailable, false);
  assert.equal(state.viewers, 12);
  assert.equal(state.messages.length, 0);
});

test('chat assets: downloads have a deadline, use userData and fall back after a network error', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const writes = [];
  const context = vm.createContext({
    URL, Buffer, path, AbortSignal, console: { error() {} },
    getUserAssetsDir: () => path.join('C:', 'test-user-data', 'assets'),
    getAssetPublicUrl: () => '/assets/local.png',
    fs: { mkdirSync() {}, existsSync: () => false, writeFileSync: (file) => writes.push(file) },
    fetch: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function cacheRemoteAsset('), source.indexOf('function normalizeMessageParts(')), context);
  assert.equal(await context.cacheRemoteAsset('https://example.test/smile.png'), '/assets/local.png');
  assert.ok(writes[0].startsWith(context.getUserAssetsDir()));
  context.fetch = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await context.cacheRemoteAsset('https://example.test/smile.png'), 'https://example.test/smile.png');
});
