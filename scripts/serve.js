#!/usr/bin/env node
// Headless TChat web server (no Electron).
// Serves overlay widgets, assets and the mobile remote panel.
// Intended for hosting on a VPS so the app is reachable from a phone browser
// and can be embedded into Prizm/OBS as a browser source.
//
// Usage:
//   PORT=3000 node scripts/serve.js
//   HOST=0.0.0.0 PORT=3000 node scripts/serve.js

const os = require('node:os');
const { createWidgetServer } = require('../src/server/widgetServer');

const PORT = Number(process.env.PORT || process.env.TCHAT_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function localIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        out.push(net.address);
      }
    }
  }
  return out;
}

async function main() {
  const server = createWidgetServer({ port: PORT, host: HOST });
  await server.start();

  const lines = [
    'TChat web server 1.0.0 запущен.',
    `  Локально:   http://localhost:${PORT}/`,
    ...localIps().map((ip) => `  По сети:    http://${ip}:${PORT}/  (телефон в той же сети)`),
    `  Проверка:   http://localhost:${PORT}/health`,
    '',
    'Оверлеи для Prizm/OBS (браузер-источник):',
    `  Стрим:      http://<host>:${PORT}/widgets/stream.html`,
    `  Алерты:     http://<host>:${PORT}/widgets/alerts.html`,
    `  Чат:        http://<host>:${PORT}/widgets/chat.html`,
    `  Пульт:      http://<host>:${PORT}/widgets/remote.html`,
  ];
  console.log(lines.join('\n'));

  const shutdown = async (signal) => {
    console.log(`\nПолучен ${signal}, останавливаю сервер...`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
