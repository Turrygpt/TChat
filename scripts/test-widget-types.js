const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function checkBrowser(baseUrl) {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const browser = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { backgroundThrottling: false } });
  browser.webContents.session.webRequest.onBeforeRequest({ urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] }, (_request, done) => done({ cancel: true }));
  await browser.loadURL(`${baseUrl}/backoffice`);
  const preview = await browser.webContents.executeJavaScript(`(async () => {
    renderWidgetsState(await window.tchat.getWidgetsState());
    const node = document.querySelector('[data-preview-widget="sticker-1787932019457-180f41717349a8"] > article');
    const style = getComputedStyle(node);
    const subscribers = document.querySelector('[data-preview-widget="subscriber-goal-1791040036809-70f1d8576248a8"] > article');
    return { className: node.className, text: node.textContent, background: style.backgroundImage,
      borderWidth: style.borderTopWidth, collection: !!node.querySelector('.stream-goal__track'),
      subscribers: subscribers.className, subscriberPosition: getComputedStyle(subscribers).position };
  })()`);
  assert.equal(preview.className, 'stream-sticker-widget');
  assert.match(preview.text, /Любой корабль в топ-3 - 500/);
  assert.match(preview.background, /linear-gradient/);
  assert.equal(preview.borderWidth, '5px');
  assert.equal(preview.collection, false);
  assert.equal(preview.subscribers, 'subscriber-goal');
  assert.equal(preview.subscriberPosition, 'relative');
  await browser.loadURL(`${baseUrl}/widgets/stream.html`);
  const overlay = await browser.webContents.executeJavaScript(`(async () => {
    const state = await (await fetch('/widgets/state')).json();
    renderStickerWidgets(state.items);
    return { stickers: document.querySelectorAll('.stream-sticker-widget').length,
      misplaced: !!document.querySelector('#streamGoals [data-sticker-widget-id]'),
      text: document.querySelector('.stream-sticker-widget__text').textContent };
  })()`);
  assert.equal(overlay.stickers, 2);
  assert.equal(overlay.misplaced, false);
  assert.match(overlay.text, /ЛЮБОЙ КОРАБЛЬ/);
  console.log('PASS browser: repaired stickers use sticker styles in preview and OBS; subscriber preview uses its own styles.');
  browser.destroy();
  app.quit();
}

async function run() {
  const electronPath = require('electron');
  const { resolveWidgetType } = require('../src/widgetTypes');
  assert.equal(resolveWidgetType({ id: 'sticker-1787932019457-180f41717349a8', type: 'goal' }), 'sticker');
  assert.equal(resolveWidgetType({ id: 'subscriber-goal-1791040036809-70f1d8576248a8', type: 'goal' }), 'subscriber-goal');
  assert.equal(resolveWidgetType({ id: 'sticker-title', type: 'goal' }), 'goal');
  assert.equal(resolveWidgetType({ id: 'custom-sticker', type: 'sticker' }), 'sticker');
  assert.equal(resolveWidgetType({ id: 'goal-1787932019457-180f41717349a8', type: 'goal' }), 'goal');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-widget-types-'));
  const settingsDir = path.join(storage, 'settings');
  fs.mkdirSync(settingsDir);
  const fixtures = [
    { id: 'sticker-1787932019457-180f41717349a8', title: 'Любой корабль в топ-3 - 500', expected: 'sticker', x: 1, y: 80, width: 28 },
    { id: 'sticker-1787585224349-5588ba6bda86b8', title: 'FS25 Kinlaig', expected: 'sticker', x: 35, y: 80, width: 28 },
    { id: 'giveaway-1788292287166-3cf6c2da912148', expected: 'giveaway', enabled: false },
    { id: 'donation-giveaway-1791213392418-9d2c71a9aead68', expected: 'donation-giveaway', enabled: false },
    { id: 'subscriber-goal-1791040036809-70f1d8576248a8', expected: 'subscriber-goal', title: 'Розыгрыш коврика', current: 12, target: 50 },
    { id: 'video-overlay-1787931124367-16b4c16bce47f8', expected: 'video-overlay', enabled: false },
    { id: 'goal-1788449856959-3017ae1e03ec3', expected: 'goal', title: 'Сбор', current: 2400, target: 30000 },
    { id: 'builtin-tasks', expected: 'tasks', enabled: false },
  ];
  const damaged = { items: fixtures.map(({ expected, ...widget }) => ({ enabled: true, x: 10, y: 10, width: 28, ...widget, type: widget.id.startsWith('builtin-') ? expected : 'goal' })) };
  const file = path.join(settingsDir, 'stream-widgets.json');
  fs.writeFileSync(file, JSON.stringify(damaged));
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  Object.assign(process.env, { TCHAT_USER_DATA: storage, TCHAT_PORT: String(port), TCHAT_HOST: '127.0.0.1' });
  require('./serve-full');
  const baseUrl = `http://127.0.0.1:${port}`;
  let state;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`${baseUrl}/widgets/state`); if (response.ok) { state = await response.json(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(state, 'isolated server started');
  for (const fixture of fixtures) {
    const restored = state.items.find(widget => widget.id === fixture.id);
    assert.equal(restored.type, fixture.expected);
    if (fixture.title) assert.equal(restored.title, fixture.title);
    if (fixture.current) assert.equal(restored.current, fixture.current);
    if (fixture.target) assert.equal(restored.target, fixture.target);
  }
  const restoredSticker = state.items.find(widget => widget.id === fixtures[0].id);
  assert.equal(restoredSticker.content, fixtures[0].title);
  assert.match(restoredSticker.background, /linear-gradient/);
  const backup = fs.readdirSync(settingsDir).find(name => name.includes('.before-type-repair-'));
  assert.ok(backup);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(settingsDir, backup))), damaged);
  const invoke = (name, arg) => global.__tchatShim.ipcHandlers.get(name)({}, arg);
  await invoke('widgets:update', { id: fixtures[0].id, type: 'goal', x: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file)).items.find(w => w.id === fixtures[0].id).type, 'sticker');
  let created = await invoke('widgets:create', { id: 'custom-sticker', type: 'sticker', title: 'New', variant: 'neon' });
  assert.equal(created.items.find(w => w.id === 'custom-sticker').variant, 'neon');
  created = await invoke('widgets:update', { id: 'custom-sticker', type: 'goal', variant: 'gold' });
  assert.equal(created.items.find(w => w.id === 'custom-sticker').type, 'sticker');
  assert.equal(created.items.find(w => w.id === 'custom-sticker').variant, 'gold');
  await invoke('widgets:delete', { id: 'custom-sticker' });
  console.log('PASS widget types: migration, backup, retained titles/positions/counts, creation, style changes and immutable types.');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const browser = spawn(electronPath, [__filename, '--browser', baseUrl], { env, stdio: 'inherit', windowsHide: true });
  const browserCode = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve); });
  assert.equal(browserCode, 0);
  const smoke = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'smoke:test'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, TCHAT_URL: baseUrl },
    stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
  });
  const smokeCode = await new Promise((resolve, reject) => { smoke.once('error', reject); smoke.once('exit', resolve); });
  assert.equal(smokeCode, 0);
  console.log(`PASS all checks with isolated settings at ${storage}`);
  process.exit(0);
}

if (process.argv.includes('--browser')) {
  checkBrowser(process.argv.at(-1)).catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  run().catch(error => { console.error(error); process.exit(1); });
}
