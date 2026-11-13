const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function checkBrowser() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const root = process.argv.at(-1);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-backoffice-startup-'));
  app.setPath('userData', storage);
  fs.mkdirSync(path.join(storage, 'settings'));
  fs.writeFileSync(path.join(storage, 'settings', 'channels.json'), JSON.stringify({ twitch: '', vk: '', youtube: '', rutube: '' }));
  const handlers = new Map();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, handler) => { handlers.set(name, handler); originalHandle(name, handler); };
  const failures = [];
  app.on('browser-window-created', (_event, window) => {
    window.hide();
    window.webContents.on('preload-error', (_event, file, error) => failures.push(`${file}: ${error.message}`));
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !/fonts|net::|favicon/.test(event.message)) failures.push(event.message);
    });
  });
  await app.whenReady();
  const heldFonts = [];
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] },
    (_request, done) => heldFonts.push(done),
  );
  require(path.join(root, 'main.js'));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backoffice stays blank while Google Fonts requests hang')), 5000);
    app.on('browser-window-created', (_event, window) => {
      window.webContents.once('dom-ready', () => {
        if (window.webContents.getURL().endsWith('/backoffice.html')) { clearTimeout(timeout); resolve(window); }
      });
    });
  });
  handlers.get('app:open-backoffice')({});
  try {
    const window = await ready;
    const result = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.tab[data-tab="connections"]').click();
      return { api: typeof window.tchat.getWidgetsState, text: document.body.innerText.length,
        tab: document.querySelector('#connectionsSection').classList.contains('is-active') };
    })()`);
    assert.equal(result.api, 'function');
    assert.ok(result.text > 100);
    assert.equal(result.tab, true);
    assert.ok(heldFonts.length > 0, 'Google Fonts requests were stalled');
    assert.deepEqual(failures, []);
    console.log('PASS desktop backoffice: real preload and IPC, visible content and working tabs while Google Fonts never responds');
  } finally {
    heldFonts.forEach(done => done({ cancel: true }));
    session.defaultSession.webRequest.onBeforeRequest(null);
    BrowserWindow.getAllWindows().forEach(window => window.destroy());
  }
  app.exit(0);
}

if (process.argv.includes('--browser')) {
  checkBrowser().catch(error => { console.error(error.message); require('electron').app.exit(1); });
} else {
  const { spawn } = require('node:child_process');
  const env = { ...process.env, TCHAT_PORT: '32159' };
  delete env.ELECTRON_RUN_AS_NODE;
  const root = process.argv[2] || path.join(__dirname, '..');
  const child = spawn(require('electron'), [__filename, '--browser', root], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
}
