const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const lastDonation = require('../lastDonation');
const vdv = require('../vdv');

const APP_VERSION = require('../../package.json').version;

function createWidgetServer({ port, host = '0.0.0.0' }) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const widgetsPath = path.join(__dirname, '../../widgets');
  const assetsPath = path.join(__dirname, '../../assets');
  const releasesPath = path.join(__dirname, '../../releases');

  app.use(express.json());
  app.get([
    '/widget/chat',
    '/widget/chat/',
    '/widget/chat.html',
    '/widget/chat/widgets/chat.html',
    '/widgets/chat',
  ], (_request, response) => {
    response.redirect(302, '/widgets/chat.html');
  });
  app.use('/widgets', express.static(widgetsPath));
  app.use('/assets', express.static(assetsPath));
  // Стабильная ссылка на свежий установщик: URL не меняется от версии к версии,
  // всегда отдаёт текущую сборку. Версию берём из latest.yml (его кладёт
  // upload-release), иначе — самый свежий exe в releases/. Должна стоять ДО
  // статики /download, чтобы имя latest не искалось на диске как файл.
  app.get(['/download/latest', '/download/TChat-Setup-latest.exe'], (_request, response) => {
    const file = resolveLatestInstaller(releasesPath);
    if (!file) {
      response.status(404).type('text').send('Установщик пока не загружен.');
      return;
    }
    // download() отдаёт файл с его версионным именем и поддерживает Range.
    response.download(path.join(releasesPath, file), file);
  });

  // Сборки приложения (exe + latest.yml для автообновления). Папку releases/
  // на сервере наполняет upload-release; если её нет — просто 404.
  app.use('/download', express.static(releasesPath));

  app.get('/', (_request, response) => {
    response.type('html').send(renderLandingPage());
  });

  app.get('/health', (_request, response) => {
    response.json({
      ok: true,
      name: 'TChat',
      version: APP_VERSION,
      message: 'Сервер виджетов живёт.',
      widgets: {
        stream: '/widgets/stream.html',
        alerts: '/widgets/alerts.html',
        chat: '/widgets/chat.html',
        goal: '/widgets/goal.html',
        lastdonation: '/widgets/lastdonation.html',
        music: '/widgets/music.html',
        giveaway: '/widgets/giveaway.html',
        countdown: '/widgets/countdown.html',
        texts: '/widgets/texts.html',
        tasks: '/widgets/tasks.html',
        stickers: '/widgets/stickers.html',
        vdv: '/widgets/vdv.html',
      },
    });
  });

  app.get('/widgets/state', (_request, response) => {
    response.json({
      items: [
        {
          id: 'builtin-tasks',
          type: 'tasks',
          title: 'Задачи на стрим',
          enabled: true,
          x: 4,
          y: 8,
          width: 26,
          subtitle: 'План на эфир',
          footer: 'Live overlay',
          skin: 'farming-simulator-25',
          taskItems: [
            { id: 'task-1', text: 'Сбор урожая', done: false },
            { id: 'task-2', text: 'Запустить ресторан', done: false },
            { id: 'task-3', text: 'Сделать моцареллу', done: false },
          ],
        },
      ],
      poll: null,
      urls: {
        stream: `http://localhost:${port}/widgets/stream.html`,
        alerts: `http://localhost:${port}/widgets/alerts.html`,
        chat: `http://localhost:${port}/widgets/chat.html`,
        goal: `http://localhost:${port}/widgets/goal.html`,
        lastdonation: `http://localhost:${port}/widgets/lastdonation.html`,
        music: `http://localhost:${port}/widgets/music.html`,
        giveaway: `http://localhost:${port}/widgets/giveaway.html`,
        countdown: `http://localhost:${port}/widgets/countdown.html`,
        texts: `http://localhost:${port}/widgets/texts.html`,
        tasks: `http://localhost:${port}/widgets/tasks.html`,
        stickers: `http://localhost:${port}/widgets/stickers.html`,
      },
    });
  });

  app.get('/alerts/state', (_request, response) => {
    response.json({
      settings: { displaySeconds: 8 },
      queue: [],
    });
  });

  app.get('/patchnotes.json', (_request, response) => {
    fs.readFile(path.join(__dirname, '../../patchnotes.json'), 'utf8', (err, raw) => {
      if (err) {
        response.json({ notes: [] });
        return;
      }
      try {
        response.json(JSON.parse(raw));
      } catch {
        response.json({ notes: [] });
      }
    });
  });

  app.get('/stickers/state', (_request, response) => {
    response.json({
      settings: { displaySeconds: 8, maxOnScreen: 6, showUser: true, rules: [] },
      rewards: [],
    });
  });

  app.post('/demo/sticker', (request, response) => {
    const item = {
      id: `sticker:${Date.now()}`,
      url: String(request.body?.url || '').trim(),
      seconds: Number(request.body?.seconds || 8),
      size: Number(request.body?.size || 240),
      position: String(request.body?.position || 'random'),
      animation: String(request.body?.animation || 'random'),
      loop: request.body?.loop !== false,
      username: String(request.body?.username || ''),
      reward: String(request.body?.reward || ''),
    };
    io.emit('sticker:show', item);
    response.json({ ok: Boolean(item.url), item });
  });

  app.post('/demo/chat', (request, response) => {
    const payload = normalizeChatMessage(request.body);
    io.emit('chat:message', payload);
    response.json({ ok: true, payload });
  });

  app.post('/demo/donation', (request, response) => {
    const payload = normalizeDonation(request.body);
    const item = createDonationAlertItem(payload);
    io.emit('donation:alert', payload);
    io.emit('alert:play', item);
    io.emit('vdv:update', vdv.addAmount(payload.amount));
    response.json({ ok: true, payload, item });
  });

  vdv.load(path.join(__dirname, '../../data'));

  function broadcastVdv(payload = vdv.payload()) {
    io.emit('vdv:update', payload);
    return payload;
  }

  app.get('/vdv/state', (_request, response) => response.json(vdv.payload()));
  app.post('/vdv/update', (request, response) => response.json({ ok: true, state: broadcastVdv(vdv.update(request.body || {})) }));
  app.post('/vdv/reveal/:index', (request, response) => response.json({ ok: true, state: broadcastVdv(vdv.reveal(Number(request.params.index))) }));
  app.post('/vdv/close/:index', (request, response) => response.json({ ok: true, state: broadcastVdv(vdv.close(Number(request.params.index))) }));
  app.post('/vdv/reset', (_request, response) => response.json({ ok: true, state: broadcastVdv(vdv.resetCards()) }));
  app.post('/vdv/add', (request, response) => response.json({ ok: true, state: broadcastVdv(vdv.addAmount(request.body?.amount)) }));

  app.post('/demo/goal', (request, response) => {
    const payload = normalizeGoal(request.body);
    io.emit('goal:update', payload);
    response.json({ ok: true, payload });
  });

  // Виджет «Последний донат». В headless-режиме состояние лежит рядом с сервером
  // (в Electron его ведёт main.js), поэтому веб-версия работает автономно.
  lastDonation.load(path.join(__dirname, '../../data'));

  function broadcastLastDonation(payload = lastDonation.payload()) {
    io.emit('lastdonation:update', payload);
    return payload;
  }

  app.get('/lastdonation/state', (_request, response) => {
    response.json(lastDonation.payload());
  });

  app.post('/lastdonation/update', (request, response) => {
    lastDonation.update(request.body || {});
    response.json({ ok: true, state: broadcastLastDonation() });
  });

  app.post('/lastdonation/donation', (request, response) => {
    const amount = Number(request.body?.amount || 0);
    if (!(amount > 0)) {
      response.status(400).json({ ok: false, error: 'Укажите сумму больше нуля.' });
      return;
    }

    const result = lastDonation.addDonation({ ...request.body, amount });
    if (result.donation) {
      broadcastLastDonation(result.state);
      result.reachedTiers.forEach((tier) => {
        io.emit('lastdonation:tier', { tier, donation: result.donation });
      });
    }

    response.json({ ok: true, counted: Boolean(result.donation), state: result.state });
  });

  app.post('/lastdonation/donation/remove', (request, response) => {
    const result = lastDonation.removeDonation(String(request.body?.id || ''));
    if (result.removed) broadcastLastDonation(result.state);
    response.json({ ok: result.removed, state: result.state });
  });

  app.post('/lastdonation/stream/:action', (request, response) => {
    const { action } = request.params;
    if (action === 'start') lastDonation.startStream(request.body?.minutes);
    else if (action === 'extend') lastDonation.extendStream(request.body?.minutes);
    else if (action === 'stop') lastDonation.stopStream();
    else if (action === 'reset') lastDonation.reset();
    else {
      response.status(400).json({ ok: false, error: 'Неизвестное действие.' });
      return;
    }

    response.json({ ok: true, state: broadcastLastDonation() });
  });

  io.on('connection', (socket) => {
    console.log(`Виджет подключён к Socket.io: ${socket.id}`);

    socket.emit('system:ready', {
      message: 'Связь с локальным сервером установлена.',
      connectedAt: new Date().toISOString(),
    });

    socket.emit('lastdonation:update', lastDonation.payload());
    socket.emit('vdv:update', vdv.payload());

    socket.on('disconnect', () => {
      console.log(`Виджет отключён от Socket.io: ${socket.id}`);
    });
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve({
            isReady: true,
            port,
            host,
            url: `http://localhost:${port}`,
            error: null,
          });
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        io.close(() => {
          server.close(() => resolve());
        });
      });
    },

    emitChatMessage(payload) {
      io.emit('chat:message', normalizeChatMessage(payload));
    },

    emitDonationAlert(payload) {
      const donation = normalizeDonation(payload);
      io.emit('donation:alert', donation);
      io.emit('alert:play', createDonationAlertItem(donation));
    },

    emitGoalUpdate(payload) {
      io.emit('goal:update', normalizeGoal(payload));
    },
  };
}

// Имя актуального установщика в releases/. Приоритет — latest.yml (там ровно та
// сборка, что раздаётся автообновлению); если его нет, берём самый свежий exe.
function resolveLatestInstaller(releasesPath) {
  try {
    const yml = fs.readFileSync(path.join(releasesPath, 'latest.yml'), 'utf8');
    const match = yml.match(/^path:\s*(TChat-Setup-.+?\.exe)\s*$/m);
    if (match && fs.existsSync(path.join(releasesPath, match[1]))) {
      return match[1];
    }
  } catch {
    /* latest.yml нет — падаем в фолбэк по времени файла */
  }
  try {
    const exes = fs
      .readdirSync(releasesPath)
      .filter((name) => /^TChat-Setup-.+\.exe$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(releasesPath, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return exes.length ? exes[0].name : '';
  } catch {
    return '';
  }
}

function normalizeChatMessage(payload = {}) {
  return {
    platform: payload.platform || 'demo',
    user: payload.user || 'Гость',
    text: payload.text || 'Пустое сообщение',
    badges: Array.isArray(payload.badges) ? payload.badges : [],
    createdAt: payload.createdAt || new Date().toISOString(),
  };
}

function normalizeDonation(payload = {}) {
  return {
    id: String(payload.id || payload.alertId || payload.createdAt || `donation-${Date.now()}`),
    username: payload.username || 'Зритель',
    amount: Number(payload.amount || 0),
    currency: payload.currency || 'RUB',
    message: payload.message || 'Без сообщения',
    createdAt: payload.createdAt || new Date().toISOString(),
  };
}

function createDonationAlertItem(donation) {
  return {
    id: donation.id,
    kind: 'donation',
    donation,
    rule: {
      id: 'demo',
      type: 'demo',
      title: 'Demo donation',
      image: '',
      sound: '',
      volume: 100,
    },
    played: false,
    queuedAt: new Date().toISOString(),
  };
}

function normalizeGoal(payload = {}) {
  const target = Math.max(Number(payload.target || 1), 1);
  const current = Math.max(Number(payload.current || 0), 0);

  return {
    title: payload.title || 'Сбор',
    current,
    target,
    currency: payload.currency || 'RUB',
    percent: Math.min(Math.round((current / target) * 100), 100),
    updatedAt: payload.updatedAt || new Date().toISOString(),
  };
}

function renderLandingPage() {
  const widgets = [
    ['remote', 'Пульт (мобильный)', 'Управление со смартфона'],
    ['stream', 'Оверлей стрима', 'Полный оверлей для Prizm/OBS'],
    ['alerts', 'Алерты', 'Донаты, подписки, рейды'],
    ['chat', 'Чат', 'Агрегированный чат'],
    ['goal', 'Цель сбора', 'Прогресс-бар цели'],
    ['lastdonation', 'Последний донат', 'Призы за последний донат'],
    ['music', 'Музыка', 'Текущий трек / заявки'],
    ['giveaway', 'Розыгрыш', 'Участники и победители'],
    ['countdown', 'Таймер', 'Обратный отсчёт'],
    ['texts', 'Тексты', 'Бегущие сообщения'],
    ['tasks', 'Задачи', 'План на эфир'],
  ];

  const cards = widgets
    .map(function (w) {
      return '<a class="card" href="/widgets/' + w[0] + '.html" target="_blank" rel="noopener">' +
        '<span class="card__title">' + w[1] + '</span>' +
        '<span class="card__subtitle">' + w[2] + '</span>' +
        '<code class="card__url">/widgets/' + w[0] + '.html</code></a>';
    })
    .join('') +
    '<a class="card" href="/download/latest">' +
    '<span class="card__title">Скачать TChat для Windows</span>' +
    '<span class="card__subtitle">Всегда свежая версия (обновляется сам)</span>' +
    '<code class="card__url">/download/latest</code></a>';

  return [
    '<!doctype html>',
    '<html lang="ru"><head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '<meta name="theme-color" content="#0f1117" />',
    '<title>TChat ' + APP_VERSION + '</title>',
    '<style>',
    ':root { color-scheme: dark; }',
    '* { box-sizing: border-box; }',
    'body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1117; color: #e8ebf2; padding: 20px; }',
    'h1 { font-size: 20px; margin: 0 0 4px; }',
    'p.lead { margin: 0 0 18px; color: #9aa3b5; font-size: 14px; }',
    '.grid { display: grid; gap: 12px; grid-template-columns: 1fr; }',
    '@media (min-width: 640px) { .grid { grid-template-columns: 1fr 1fr; } }',
    '.card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; background: #191c26; border: 1px solid #262b3a; border-radius: 14px; text-decoration: none; color: inherit; }',
    '.card:hover { border-color: #3a63ff; }',
    '.card__title { font-weight: 600; font-size: 15px; }',
    '.card__subtitle { font-size: 13px; color: #9aa3b5; }',
    '.card__url { font-size: 12px; color: #5f6b85; margin-top: 4px; }',
    'footer { margin-top: 20px; color: #5f6b85; font-size: 12px; line-height: 1.5; }',
    '</style></head><body>',
    '<h1>TChat ' + APP_VERSION + '</h1>',
    '<p class="lead">Оверлеи и мобильный пульт. Откройте «Пульт» на телефоне, ссылки оверлеев вставляйте в Prizm/OBS как браузер-источник.</p>',
    '<main class="grid">',
    cards,
    '</main>',
    '<footer>Оверлеи имеют прозрачный фон — вставляйте их URL в Prizm как «Браузер».<br />Проверка сервера: <code>/health</code></footer>',
    '</body></html>',
  ].join('\n');
}

module.exports = {
  createWidgetServer,
  renderLandingPage,
};
