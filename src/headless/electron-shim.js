// Fake "electron" module so main.js can run under plain Node on a headless
// server. The two BrowserWindows become logical "roles" (backoffice / chat)
// whose webContents.send() is forwarded to web clients by the web-bridge.
//
// Only the small Electron surface that main.js actually uses is implemented:
//   app, BrowserWindow, Menu, ipcMain, shell, dialog
// Any method we did not anticipate resolves to a harmless no-op via a Proxy.

const path = require('node:path');
const fs = require('node:fs');

// Shared state the web-bridge reaches into.
const shim = (global.__tchatShim = global.__tchatShim || {
  ipcHandlers: new Map(), // channel -> handler(fn)(event, payload)
  windows: {}, // role -> fake window
  didFinishLoad: { backoffice: [], chat: [] }, // role -> [callback]
  // Set by the web-bridge. Forwards a window "send" to the matching room.
  sendHook: null,
  // Overridden transiently so an initial replay targets one socket.
  sendOverride: null,
});

const USER_DATA =
  process.env.TCHAT_USER_DATA || path.join(process.cwd(), 'data');

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}
ensureDir(USER_DATA);

function noop() {}

// Wraps a concrete object so that reads of unknown properties yield a no-op
// function instead of throwing. Known properties pass through unchanged.
function withNoopFallback(base) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return noop;
    },
  });
}

function roleFromOptions(options = {}) {
  // Strip the "TChat" brand first: otherwise "tchat" contains "chat" and every
  // window would look like the chat window.
  const title = String(options.title || '')
    .toLowerCase()
    .replace(/tchat/g, '');
  if (title.includes('бэк') || title.includes('back')) return 'backoffice';
  if (title.includes('чат') || title.includes('chat')) return 'chat';
  return 'backoffice';
}

class BrowserWindow {
  constructor(options = {}) {
    this.role = roleFromOptions(options);
    this._destroyed = false;

    const role = this.role;
    this.webContents = withNoopFallback({
      id: role === 'chat' ? 2 : 1,
      send: (channel, payload) => {
        const hook = shim.sendOverride || shim.sendHook;
        if (hook) hook(role, channel, payload);
      },
      on: noop,
      once: (event, callback) => {
        if (event === 'did-finish-load') {
          shim.didFinishLoad[role] = shim.didFinishLoad[role] || [];
          shim.didFinishLoad[role].push(callback);
        }
      },
      setWindowOpenHandler: noop,
      openDevTools: noop,
      closeDevTools: noop,
      executeJavaScript: () => Promise.resolve(),
      insertCSS: () => Promise.resolve(),
      session: withNoopFallback({
        webRequest: withNoopFallback({}),
        clearCache: () => Promise.resolve(),
      }),
    });

    shim.windows[role] = this;
    return withNoopFallback(this);
  }

  isDestroyed() {
    return this._destroyed;
  }
  destroy() {
    this._destroyed = true;
  }
  close() {
    this._destroyed = true;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isVisible() {
    return true;
  }
  getBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  loadFile() {
    return Promise.resolve();
  }
  loadURL() {
    return Promise.resolve();
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
  focus() {}
  show() {}
  hide() {}
  restore() {}
  maximize() {}
  minimize() {}
  setMenu() {}
  setMenuBarVisibility() {}
  removeAllListeners() {}

  static getAllWindows() {
    return Object.values(shim.windows).filter((w) => !w.isDestroyed());
  }
  static getFocusedWindow() {
    return null;
  }
  static fromWebContents() {
    return null;
  }
}

const ipcMain = withNoopFallback({
  handle(channel, handler) {
    shim.ipcHandlers.set(channel, handler);
  },
  handleOnce(channel, handler) {
    shim.ipcHandlers.set(channel, handler);
  },
  removeHandler(channel) {
    shim.ipcHandlers.delete(channel);
  },
  on: noop,
  once: noop,
  removeAllListeners: noop,
});

const listeners = new Map();
const app = withNoopFallback({
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: noop,
  whenReady: () => Promise.resolve(),
  on: (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
  },
  once: (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
  },
  emit: (event, ...args) => {
    (listeners.get(event) || []).forEach((cb) => {
      try {
        cb({ preventDefault: noop }, ...args);
      } catch {
        /* ignore */
      }
    });
  },
  removeAllListeners: noop,
  getPath: (name) => {
    if (name === 'userData') return USER_DATA;
    if (name === 'temp') return require('node:os').tmpdir();
    if (name === 'home') return require('node:os').homedir();
    const dir = path.join(USER_DATA, String(name));
    ensureDir(dir);
    return dir;
  },
  setPath: noop,
  getName: () => 'TChat',
  getVersion: () => '1.0.0',
  getAppPath: () => process.cwd(),
  setAppUserModelId: noop,
  disableHardwareAcceleration: noop,
  quit: () => {
    // Fire before-quit listeners, then exit.
    (listeners.get('before-quit') || []).forEach((cb) => {
      try {
        cb({ preventDefault: noop });
      } catch {
        /* ignore */
      }
    });
    process.exit(0);
  },
  exit: (code = 0) => process.exit(code),
  commandLine: withNoopFallback({ appendSwitch: noop, appendArgument: noop }),
});

// Let SIGTERM (systemctl stop) run the app's cleanup.
process.on('SIGTERM', () => app.emit('before-quit'));
process.on('SIGINT', () => app.quit());

const shell = withNoopFallback({
  // On a server we cannot open a browser; the client opens external URLs.
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: noop,
});

const dialog = withNoopFallback({
  // No native file picker on a server. Report "cancelled".
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showErrorBox: noop,
});

const Menu = withNoopFallback({
  setApplicationMenu: noop,
  buildFromTemplate: () => withNoopFallback({ popup: noop, append: noop }),
});

const nativeImage = withNoopFallback({
  createFromPath: () => withNoopFallback({ isEmpty: () => true }),
  createEmpty: () => withNoopFallback({ isEmpty: () => true }),
});

module.exports = {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  dialog,
  nativeImage,
  Tray: class Tray {
    constructor() {
      return withNoopFallback(this);
    }
  },
  screen: withNoopFallback({
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
  }),
  session: withNoopFallback({ defaultSession: withNoopFallback({}) }),
  globalShortcut: withNoopFallback({ register: () => true, unregisterAll: noop }),
  contextBridge: withNoopFallback({ exposeInMainWorld: noop }),
  ipcRenderer: withNoopFallback({}),
};
