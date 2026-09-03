# TChat Agent Notes

Keep context small. Read this file first, then open only the files needed for the task.

## Fast Checks

- Use `npm.cmd`, not `npm`, in PowerShell.
- `npm.cmd run server:check` verifies the lightweight widget server and `/health`.
- `npm.cmd run smoke:test` checks the running app at `http://localhost:3000`.
- Main local URL: `http://localhost:3000`.

## Files To Open By Task

- Electron/server/chat integrations: `main.js`.
- Backoffice UI: `backoffice.html` and `src/preload.js`.
- OBS widgets: matching `widgets/*.html` plus `widgets/*.js`.
- Standalone server checks: `src/server/widgetServer.js` and `scripts/check-server.js`.
- End-to-end smoke behavior: `scripts/smoke-test.js`.
- App launch wrapper: `scripts/start-electron.js`.

## Runtime Notes

- The app is a local Electron main process plus Express/Socket.io widget server.
- Widget URLs are served from `/widgets/...` on port `3000`.
- Runtime settings live in Electron userData, not in this repo.
- Twitch, YouTube, Rutube and VK are external services; keep failures non-fatal and show status instead of crashing.
- VK pages can omit `initial-state`; chat polling must degrade to an empty message list/status.
- Music metadata fetches for VK/Rutube can fail; preserve direct embed fallbacks.

## Change Rules

- Keep fixes scoped; avoid broad rewrites of `main.js` unless the task needs it.
- Do not edit `node_modules/`.
- After chat, widget, server or integration changes, run at least `npm.cmd run server:check`.
- Run `npm.cmd run smoke:test` when behavior touches browser-visible widgets or socket events.

## Web / Build / Deploy (v1.0.0)

- Headless web server: `src/server/widgetServer.js` + `scripts/serve.js` (`npm run serve`).
  No Electron; serves `/`, `/widgets`, `/assets`, `/health`, demo endpoints, socket.io.
- Server deploy: `deploy/deploy.sh` (client) + `deploy/remote-setup.sh` (server, systemd+nginx).
- Windows build: `npm run dist` (electron-builder, config in `package.json` "build", `asar:false`).
- Android WebView wrapper: `android/` (change URL in `res/values/strings.xml`).
- Alert media supports MP4/WebM/GIF; `.gif` rules auto-prefer a sibling `.mp4`.
- Keep asset writes under a path that stays writable when packaged (`asar:false` + per-user install).
- User-picked alert/sticker media is copied into `userData/assets/{alerts,stickers}`, next to the
  settings that reference it, so it survives updates and reinstalls. `/assets/...` serves userData
  first, then the bundled `assets/` (defaults, icons). Never write uploads into the app folder.
