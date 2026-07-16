// Web bridge: exposes main.js's Electron-IPC brain to ordinary browsers.
//
// - window.webContents.send(channel, payload)  ->  socket room "win:<role>"
// - browser  socket.emit('tchat:invoke', ...)  ->  ipcMain handler + ack
// - serves /backoffice and /chat (the real HTML) with a window.tchat shim
//
// Enabled only when main.js runs under the headless launcher (TCHAT_HEADLESS).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM_URL = '/headless/tchat-web-shim.js';

function normaliseRole(role) {
  return role === 'chat' ? 'chat' : 'backoffice';
}

function injectShim(html, role) {
  const snippet = [
    `<script>window.__TCHAT_ROLE=${JSON.stringify(role)};</script>`,
    '<script src="/socket.io/socket.io.js"></script>',
    `<script src="${SHIM_URL}"></script>`,
  ].join('\n');
  // Run our scripts before any of the page's own scripts (classic scripts
  // block and execute in order), so window.tchat exists when the page needs it.
  if (html.includes('<head>')) return html.replace('<head>', `<head>\n${snippet}`);
  return snippet + html;
}

function servePage(response, file, role) {
  fs.readFile(path.join(ROOT, file), 'utf8', (err, html) => {
    if (err) {
      response.status(500).type('text').send(`Cannot read ${file}: ${err.message}`);
      return;
    }
    response
      .type('html')
      .set('Cache-Control', 'no-cache, no-store, must-revalidate')
      .send(injectShim(html, role));
  });
}

function attach({ io, app }) {
  const shim = global.__tchatShim;
  if (!shim) throw new Error('electron-shim not loaded before web-bridge');

  // Fake-window sends -> matching browser room.
  shim.sendHook = (role, channel, payload) => {
    io.to(`win:${normaliseRole(role)}`).emit('tchat:event', { channel, payload });
  };

  // --- HTTP routes -------------------------------------------------------
  app.get(['/backoffice', '/backoffice.html'], (_req, res) =>
    servePage(res, 'backoffice.html', 'backoffice'),
  );
  app.get(['/chat', '/chat-window', '/chat-window.html'], (_req, res) =>
    servePage(res, 'chat-window.html', 'chat'),
  );
  app.get(SHIM_URL, (_req, res) => {
    res
      .type('application/javascript')
      .set('Cache-Control', 'no-cache, no-store, must-revalidate')
      .sendFile(path.join(__dirname, 'tchat-web-shim.js'));
  });
  // Friendly landing: pick a window.
  app.get('/app', (_req, res) => {
    res.type('html').send(
      '<!doctype html><meta charset="utf-8"><title>TChat</title>' +
        '<style>body{font-family:Segoe UI,sans-serif;background:#0f1117;color:#e8ebf2;' +
        'display:flex;gap:16px;align-items:center;justify-content:center;height:100vh;margin:0}' +
        'a{padding:18px 26px;background:#191c26;border:1px solid #2a3346;border-radius:14px;' +
        'text-decoration:none;color:inherit;font-size:18px}a:hover{border-color:#3a63ff}</style>' +
        '<a href="/chat">💬 Окно чата</a><a href="/backoffice">🎛 Бэкофис</a>',
    );
  });

  // --- Socket.io <-> IPC -------------------------------------------------
  io.on('connection', (socket) => {
    socket.on('tchat:join', (data = {}) => {
      const role = normaliseRole(data.role);
      socket.join(`win:${role}`);
      replayInitialState(shim, socket, role);
    });

    socket.on('tchat:invoke', async (data = {}, ack) => {
      const { channel, arg } = data;
      const handler = shim.ipcHandlers.get(channel);
      if (typeof ack !== 'function') return;
      if (!handler) {
        ack({ ok: false, error: `no handler for ${channel}` });
        return;
      }
      try {
        const value = await handler({ sender: socket }, arg);
        ack({ ok: true, value });
      } catch (error) {
        ack({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
  });

  // Ensure the backoffice fake-window exists so its pushes reach web clients.
  // (main.js only auto-creates the chat window on startup.)
  try {
    shim.ipcHandlers.get('app:open-backoffice')?.({});
  } catch {
    /* ignore */
  }
}

// Replays a window's "did-finish-load" pushes to a single freshly-joined
// client, mirroring what Electron does when its window finishes loading.
function replayInitialState(shim, socket, role) {
  const callbacks = shim.didFinishLoad[role] || [];
  if (!callbacks.length) return;
  const previous = shim.sendOverride;
  shim.sendOverride = (r, channel, payload) => {
    if (normaliseRole(r) === role) socket.emit('tchat:event', { channel, payload });
  };
  try {
    callbacks.forEach((cb) => {
      try {
        cb();
      } catch {
        /* ignore */
      }
    });
  } finally {
    shim.sendOverride = previous;
  }
}

module.exports = { attach };
