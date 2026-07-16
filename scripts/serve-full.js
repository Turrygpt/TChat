#!/usr/bin/env node
// Headless launcher: runs the full TChat brain (main.js) under plain Node by
// aliasing the "electron" module to a fake shim, then exposes it to browsers
// via the web-bridge. No Electron, no display server required.
//
// Usage:
//   TCHAT_HEADLESS=1 TCHAT_HOST=0.0.0.0 TCHAT_PORT=3100 node scripts/serve-full.js

const path = require('node:path');
const Module = require('node:module');

process.env.TCHAT_HEADLESS = process.env.TCHAT_HEADLESS || '1';
process.env.TCHAT_HOST = process.env.TCHAT_HOST || '0.0.0.0';
process.env.TCHAT_PORT = process.env.TCHAT_PORT || '3100';
process.env.TCHAT_USER_DATA =
  process.env.TCHAT_USER_DATA || path.join(__dirname, '..', 'data');

// Load the shim first so its globals exist, then make require('electron') → shim.
const electronShim = require('../src/headless/electron-shim');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronShim;
  return originalLoad.call(this, request, parent, isMain);
};

console.log(
  `TChat headless starting on ${process.env.TCHAT_HOST}:${process.env.TCHAT_PORT} ` +
    `(data: ${process.env.TCHAT_USER_DATA})`,
);

// Running main.js triggers app.whenReady() (resolved immediately by the shim),
// which starts the local server; the web-bridge attaches inside createLocalServer.
require('../main.js');
