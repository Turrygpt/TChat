// Real Chromium controls and overlay, with isolated settings and no live chat.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function browser(base) {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.ARENA_BROWSER_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, backgroundColor: '#19304a' });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] }, (_, done) => done({ cancel: true }));
  const js = code => win.webContents.executeJavaScript(code);
  async function wait(code) {
    for (let n = 0; n < 100; n++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Browser timeout: ' + code);
  }
  await win.loadURL(base + '/backoffice');
  await wait("!!document.querySelector('#arenaEnabled')");
  await js("document.querySelector('#arenaEnabled').checked=true; document.querySelector('#arenaSave').click()");
  await wait("document.querySelector('#arenaStatus').textContent.startsWith('Готово')");
  assert.equal((await (await fetch(base + '/arena/state')).json()).settings.enabled, true);
  for (const user of ['First', 'Second']) await fetch(base + '/demo/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'twitch', user, text: '!бой слесарь' }),
  });
  // Freeze combat while checking the browser renderer and reconnect behavior.
  await js("window.tchat.saveArena({paused:true})");
  await win.loadURL(base + '/widgets/stream.html');
  await wait("document.querySelectorAll('.arena-fighter').length === 2");
  assert.deepEqual(await js("[document.documentElement, document.body, document.querySelector('#arenaLayer')].map(e=>getComputedStyle(e).backgroundColor)"), Array(3).fill('rgba(0, 0, 0, 0)'));
  const loaded = await js("new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src='/assets/arena/mechanic.png'})");
  assert.equal(loaded, true);
  const output = path.join(os.tmpdir(), 'tchat-arena-preview.png');
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  await win.reload();
  await wait("document.querySelectorAll('.arena-fighter').length === 2");
  assert.equal((await (await fetch(base + '/arena/state')).json()).fighters.length, 2);
  await win.loadURL(base + '/backoffice');
  await wait("!!document.querySelector('#arenaClear')");
  await js("document.querySelector('#arenaClear').click()");
  await wait("window.tchat.getArenaState().then(s=>s.fighters.length===0)");
  console.log('PASS arena browser: controls, sprites, transparent overlay on dark background, reconnect and clear. Preview: ' + output);
  win.destroy();
  app.exit(0);
}

async function run() {
  const electronPath = require('electron');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-arena-browser-'));
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  Object.assign(process.env, { TCHAT_USER_DATA: storage, TCHAT_PORT: String(port), TCHAT_HOST: '127.0.0.1' });
  require('./serve-full');
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const env = { ...process.env, ARENA_BROWSER_PROFILE: path.join(storage, 'browser') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [__filename, '--browser', base], { env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  require('../src/headless/electron-shim').app.emit('before-quit');
  assert.equal(code, 0);
  process.exit(0);
}
if (process.argv.includes('--browser')) browser(process.argv.at(-1)).catch(error => { console.error(error); require('electron').app.exit(1); });
else run().catch(error => { console.error(error); process.exit(1); });
