# TChat 1.0.0

Стримерский агрегатор чатов, DonationAlerts и OBS/Prizm-виджетов.
Работает в двух режимах: десктоп-приложение (Electron) и веб-сервер (для телефона и Prizm).

## Быстрый старт (десктоп)

```powershell
npm.cmd install
npm.cmd start
```

На Windows используйте `npm.cmd`, потому что PowerShell может блокировать `npm.ps1`.

Проверки:

```powershell
npm.cmd run server:check
npm.cmd run smoke:test
```

## Веб-режим (телефон, Prizm, сервер)

Headless-сервер без Electron — отдаёт оверлеи, ассеты и мобильный пульт:

```bash
npm run serve            # http://localhost:3000  (слушает 0.0.0.0)
PORT=8080 npm run serve  # другой порт
```

- Лендинг + пульт: `http://<ip>:3000/`
- С телефона в той же сети: `http://<ip-компа>:3000/`
- Оверлеи для Prizm/OBS: `http://<ip>:3000/widgets/stream.html` и т.д.

Разместить на сервере одной командой — см. **[deploy/README.md](deploy/README.md)**.
Встраивание в Prizm по ссылке — там же.

## Сборка приложений

- **Windows (standalone .exe):**

  ```powershell
  npm.cmd install
  npm.cmd run dist            # установщик NSIS + portable, папка dist/
  npm.cmd run dist:portable   # только portable
  ```

  Результат в `dist/`: `TChat Setup 1.0.0.exe` и `TChat-1.0.0-portable.exe`.

- **Android (WebView-обёртка):** см. **[android/README.md](android/README.md)**.

## Главное

- `main.js` — Electron main process, локальный Express/Socket.io сервер, интеграции.
- `backoffice.html` — основная панель управления.
- `chat-window.html` — отдельное окно чата.
- `src/preload.js` — IPC-мост для Electron.
- `src/server/widgetServer.js` — headless веб-сервер (оверлеи, ассеты, лендинг, пульт).
- `scripts/serve.js` — точка входа веб-режима.
- `widgets/` — OBS/Prizm/LAN-виджеты (прозрачный фон).
- `assets/` — картинки, звуки, TTS-кеш.
- `deploy/` — деплой на VPS (systemd + nginx) и инструкция по Prizm.
- `android/` — Android-обёртка.

## URL веб-сервера

- Health: `/health`
- Alerts: `/widgets/alerts.html`
- Chat: `/widgets/chat.html`
- Goal: `/widgets/goal.html`
- Music: `/widgets/music.html`
- Stream overlay: `/widgets/stream.html`
- Remote panel: `/widgets/remote.html`

## Функции

- Чаты: Twitch, VK Video Live, YouTube, Rutube, demo.
- DonationAlerts OAuth/sync, тестовые донаты, правила алертов.
- OBS-алерты для донатов и подписчиков (картинки, **MP4** и GIF).
- Edge TTS для текста донатов.
- Музыкальные заявки из YouTube, Rutube и VK.
- Виджеты цели, чата, музыки, алертов и удалённой панели.
- Локальный рестрим-сервер: OBS вещает на этот ПК, TChat раздаёт поток на YouTube/Twitch/VK без перекодирования.
- Окно чата всегда поверх всех окон; **Ctrl+Alt+G** — глобальный хоткей «призрачного» режима: окно чата полупрозрачное и некликабельное (клики проходят в игру).

## Медиа алертов

Виджет алертов умеет проигрывать **MP4/WebM** (тег `<video>`) и картинки.
Для старых GIF-правил он автоматически подхватывает `.mp4`-версию рядом
(с тем же именем) и откатывается на `.gif`, если видео недоступно.

## Для работы с нейросетью

Перед правками читайте `AGENTS.md`.
