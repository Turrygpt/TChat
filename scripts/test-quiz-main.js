// Exercise the real main.js chat and existing AI adapter, with fake upstreams
// and separate userData. No calls reach the user's stream or paid services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');

async function run() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-quiz-main-'));
  const realFetch = global.fetch;
  let client, modelRequest;
  try {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    Object.assign(process.env, { TCHAT_PORT: String(port), TCHAT_USER_DATA: storage });
    const base = `http://localhost:${port}`;
    fs.mkdirSync(path.join(storage, 'settings'));
    fs.writeFileSync(path.join(storage, 'settings', 'channels.json'), JSON.stringify({ twitch: 'quiz-test-only' }));
    fs.writeFileSync(path.join(storage, 'settings', 'announce.json'), JSON.stringify({ polza: { apiKey: 'fake-test-key', model: 'test-model' } }));
    const { tmi } = require('../src/net/chatKeepAlive');
    tmi.Client = class extends EventEmitter {
      constructor() { super(); client = this; }
      async connect() { this.emit('connected'); }
      async disconnect() { this.emit('disconnected'); }
    };
    global.fetch = async (url, options) => {
      if (String(url).startsWith(base)) return realFetch(url, options);
      if (String(url) === 'https://polza.ai/api/v1/chat/completions') {
        modelRequest = JSON.parse(options.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Я бы предложил A, но могу ошибаться.' } }] }) };
      }
      if (String(url) === 'https://gql.twitch.tv/gql') return { ok: true, json: async () => ({ data: { user: { stream: null } } }) };
      throw new Error('Network disabled by isolated quiz test');
    };
    require('./serve-full');
    const waitFor = async fn => {
      for (let i = 0; i < 100; i++) {
        try { const result = await fn(); if (result) return result; } catch {}
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('Isolated main process timed out');
    };
    const state = async () => (await realFetch(`${base}/quiz/state`)).json();
    const action = async (action) => {
      const response = await realFetch(`${base}/quiz/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(action === 'start' ? { player: 'Игрок' } : {}) }) });
      assert.equal(response.status, 200); return response.json();
    };
    await waitFor(async () => (await state()).phase === 'waiting' && client);
    await action('start'); await action('chat');
    client.emit('message', '#quiz-test-only', { username: 'actual-pipeline-viewer', 'display-name': 'Viewer' }, 'C', false);
    const voted = await waitFor(async () => { const value = await state(); return value.lifelines.chat.total === 1 && value; });
    assert.equal(voted.lifelines.chat.counts[2], 1);
    assert.equal(voted.selected, null);
    assert.equal(voted.chatStatus.platforms, 1);
    await action('friend');
    const helped = await waitFor(async () => { const value = await state(); return value.lifelines.friend.status === 'ready' && value; });
    assert.equal(helped.lifelines.friend.provider, 'polza.ai');
    assert.equal(helped.lifelines.friend.text, 'Я бы предложил A, но могу ошибаться.');
    assert.equal(modelRequest.model, 'test-model');
    assert.ok(!JSON.stringify(modelRequest).includes('Правильный ответ:'));
    assert.equal(helped.question.correct, undefined);
    console.log('Main integration PASS: connected Twitch message → quiz vote; existing AI settings → actual adapter request; no answer key supplied. Upstreams were mocked.');
  } finally {
    global.__tchatShim && require('../src/headless/electron-shim').app.emit('before-quit');
    // Let pending Windows DNS/HTTP handles finish before exiting the test process.
    await new Promise(resolve => setTimeout(resolve, 350));
    global.fetch = realFetch;
    const target = path.resolve(storage);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('tchat-quiz-main-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
