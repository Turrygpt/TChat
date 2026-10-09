const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

// Run the real main process with separate storage, fake Twitch services and an
// ephemeral port. No demo events or mutations reach the user's running app.
async function run() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-followers-'));
  let followers, observer;
  try {
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    Object.assign(process.env, { TCHAT_USER_DATA: storage, TCHAT_PORT: String(port), TCHAT_HOST: '127.0.0.1' });
    fs.mkdirSync(path.join(storage, 'settings'));
    fs.writeFileSync(path.join(storage, 'settings', 'channels.json'), JSON.stringify({ twitch: 'streamer' }));

    require('tmi.js').Client = class extends EventEmitter {
      async connect() { this.emit('connected'); }
      async disconnect() { this.emit('disconnected'); }
    };
    const realFetch = global.fetch;
    global.fetch = (url, options) => String(url) === 'https://gql.twitch.tv/gql'
      ? Promise.resolve({ ok: true, json: async () => ({ data: { user: { stream: null } } }) })
      : realFetch(url, options);
    class TwitchSocket extends EventEmitter {
      terminate() { this.emit('close'); }
      close() { this.terminate(); }
      message(type, payload) { this.emit('message', JSON.stringify({ metadata: { message_type: type }, payload })); }
    }
    const twitchModule = require('../src/twitchFollowers');
    const RealFollowers = twitchModule.TwitchFollowers;
    twitchModule.TwitchFollowers = class extends RealFollowers {
      constructor(options) {
        super({ ...options, Socket: TwitchSocket, fetchImpl: async () => ({ ok: true, json: async () => ({
          client_id: 'test-app', user_id: '123', login: 'streamer', scopes: ['moderator:read:followers'],
        }) }) });
        followers = this;
      }
    };
    require('./serve-full');
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`${baseUrl}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'isolated server must start');
    const invoke = (name, arg) => global.__tchatShim.ipcHandlers.get(name)({}, arg);
    const packets = [];
    observer = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/socket.io/?EIO=4&transport=websocket`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OBS socket timeout')), 5000);
      observer.once('error', reject);
      observer.on('message', (raw) => {
        const packet = String(raw);
        if (packet.startsWith('0')) observer.send('40');
        else if (packet === '2') observer.send('3');
        else if (packet.startsWith('40')) {
          observer.send('42["tchat:join",{"role":"backoffice"}]');
          observer.send('420["tchat:invoke",{"channel":"followers:twitch-status"}]');
        }
        else if (packet.startsWith('430')) { clearTimeout(timeout); resolve(); }
        else if (packet.startsWith('42')) packets.push(JSON.parse(packet.slice(2)));
      });
    });

    const state = await invoke('widgets:create', { type: 'subscriber-goal', title: 'Фолловеры Twitch', target: 10, platform: 'twitch' });
    const goalId = state.items.find((item) => item.type === 'subscriber-goal').id;
    await invoke('followers:twitch-connect', 'oauth:test-secret');
    const socket = [...followers.sockets][0];
    socket.message('session_welcome', { session: { id: 'test-session' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(await invoke('followers:twitch-status'), /Подключено: streamer/);
    const event = { user_id: '456', user_name: 'NewFollower', broadcaster_user_id: '123', followed_at: '2026-10-04T10:00:00Z' };
    const notify = (data) => socket.message('notification', { subscription: { type: 'channel.follow' }, event: data });
    notify(event);
    notify(event);
    const history = await invoke('chat:get-history');
    assert.equal(history.length, 1, 'duplicate follows do not reach history');
    assert.equal(history[0].systemEvent, 'twitch-follow');
    assert.equal(new URL(history[0].platformIcon).pathname, '/assets/chat/platforms/twitch.svg');
    assert.equal(history[0].user, 'NewFollower');
    const queue = (await invoke('alerts:get-queue')).queue;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'subscriber');
    assert.equal(queue[0].subscriber.username, 'NewFollower');
    assert.equal((await invoke('widgets:get-state')).items.find((item) => item.id === goalId).current, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(packets.filter(([name, message]) => name === 'chat:message' && message.systemEvent === 'twitch-follow').length, 1);
    assert.equal(packets.filter(([name]) => name === 'alert:play').length, 1);
    assert.ok(packets.some(([name, message]) => name === 'tchat:event' && message.channel === 'followers:twitch-status'));

    const settings = await invoke('alerts:get-settings');
    settings.systemAlerts.subscriber.enabled = false;
    await invoke('alerts:save-settings', settings);
    notify({ ...event, user_id: '789', user_name: 'AnotherFollower' });
    assert.equal((await invoke('chat:get-history')).length, 2);
    assert.equal((await invoke('alerts:get-queue')).queue.length, 1, 'disabled alerts leave chat and goals working');
    assert.equal((await invoke('widgets:get-state')).items.find((item) => item.id === goalId).current, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(storage, 'settings', 'stream-widgets.json'), 'utf8'));
    assert.equal(saved.items.find((item) => item.id === goalId).current, 2);
    assert.ok(!JSON.stringify(packets).includes('test-secret'), 'tokens must never be emitted to chat or OBS');

    await invoke('chat:update-channels', { twitch: 'another' });
    assert.equal(followers.token, '');
    assert.match(await invoke('followers:twitch-status'), /Канал Twitch изменён/);
    assert.equal(await invoke('followers:twitch-disconnect'), 'Не подключено');
    const html = fs.readFileSync(path.join(__dirname, '..', 'backoffice.html'), 'utf8');
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    console.log('PASS followers integration: real IPC, OBS socket events, chat history, enabled/disabled alerts, saved goal count, channel changes, token isolation and backoffice JavaScript.');

    const smoke = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run smoke:test'], { env: { ...process.env, TCHAT_URL: baseUrl }, stdio: 'inherit' })
      : spawn('npm', ['run', 'smoke:test'], { env: { ...process.env, TCHAT_URL: baseUrl }, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { smoke.once('error', reject); smoke.once('exit', resolve); });
    assert.equal(code, 0, 'isolated smoke checks must pass');
    if (process.env.TCHAT_TEST_KEEP_ALIVE === '1') {
      console.log(`UI preview: ${baseUrl}/backoffice (isolated test data)`);
      await new Promise((resolve) => process.once('SIGINT', resolve));
    }
  } finally {
    followers?.stop();
    observer?.terminate();
    const resolved = path.resolve(storage);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tchat-followers-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
