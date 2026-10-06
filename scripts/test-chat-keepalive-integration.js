'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

async function run() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-chat-keepalive-'));
  try {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    Object.assign(process.env, { TCHAT_USER_DATA: storage, TCHAT_PORT: String(port), TCHAT_HOST: '127.0.0.1' });
    fs.mkdirSync(path.join(storage, 'settings'));
    fs.writeFileSync(path.join(storage, 'settings', 'channels.json'), JSON.stringify({ twitch: 'test', youtube: '@test' }));
    // A Twitch handshake that never resolves must not prevent YouTube startup.
    require('../src/net/chatKeepAlive').tmi.Client = class extends EventEmitter {
      connect() { return new Promise(() => {}); }
    };
    let youtubeStarted = 0;
    require('youtube-chat/dist/live-chat').LiveChat = class extends EventEmitter {
      async start() { youtubeStarted++; this.emit('start'); return true; }
      stop() { this.emit('end'); }
    };
    const realFetch = global.fetch;
    global.fetch = (url, options) => {
      if (String(url).startsWith('https://gql.twitch.tv/')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { user: { stream: null } } }) });
      }
      if (String(url).startsWith('https://www.youtube.com/')) {
        return Promise.resolve({ ok: true, text: async () => '<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk">"isLiveNow":true' });
      }
      return realFetch(url, options);
    };
    require('./serve-full');
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await realFetch(`${baseUrl}/health`)).ok && youtubeStarted > 0; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'YouTube and the server must start despite a stalled Twitch connection');
    console.log('PASS chat startup: a stalled Twitch handshake does not block YouTube or the full server.');
    const smoke = spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run smoke:test'], {
      env: { ...process.env, TCHAT_URL: baseUrl }, stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => { smoke.once('error', reject); smoke.once('exit', resolve); });
    assert.equal(code, 0, 'full isolated smoke checks must pass');
  } finally {
    const resolved = path.resolve(storage);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tchat-chat-keepalive-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
