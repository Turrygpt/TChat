const { execFile, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const boundary = 'tchat-camera';
const frameTimeout = 15000;
const maxJpegSize = 1024 * 1024;

function workerError(stderr) {
  return stderr.match(/^TCHAT_CAMERA_ERROR: (.+)$/m)?.[1].trim();
}

function createSnapCamera() {
  const root = path.resolve(process.env.TCHAT_SNAPCAMERA_DIR || 'C:/Projects/snapcamera');
  const python = path.join(root, '.venv-lens', 'Scripts', 'python.exe');
  const worker = path.join(__dirname, 'snaplite-worker.py');
  const workerOptions = { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } };
  const viewers = new Set();
  let child;
  let latestFrame;
  let state = { phase: 'idle', error: '', run: 0 };

  function checkRuntime() {
    if (!existsSync(python) || !existsSync(path.join(root, 'lens_runtime.py'))) {
      throw new Error(`SnapLite не найден в ${root}. Запустите Start.cmd в папке SnapLite для установки зависимостей.`);
    }
  }

  async function listDevices() {
    checkRuntime();
    try {
      const { stdout } = await execFileAsync(python, [worker, root, '--list'], { ...workerOptions, timeout: frameTimeout });
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(workerError(error.stderr || '') || 'Не удалось получить список камер SnapLite.');
    }
  }

  function clearStream() {
    latestFrame = undefined;
    for (const viewer of viewers) viewer.destroy();
    viewers.clear();
  }

  function stop() {
    if (child && state.phase !== 'stopping') {
      state = { ...state, phase: 'stopping', error: '' };
      clearStream();
      child.kill();
    } else if (!child) {
      state = { ...state, phase: 'idle', error: '' };
    }
    return state;
  }

  function start({ camera, effect, mirror } = {}) {
    if (child) return state;
    if (!Number.isInteger(camera) || camera < 0 || !['none', 'butterfly'].includes(effect)) {
      throw new Error('Выберите камеру и эффект.');
    }
    checkRuntime();

    const args = [worker, root, '--camera', String(camera), '--effect', effect];
    if (mirror === true) args.push('--mirror');
    const process = spawn(python, args, { ...workerOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    child = process;
    state = { phase: 'starting', error: '', run: state.run + 1 };
    let pending = Buffer.alloc(0);
    let stderr = '';
    let failure = '';

    function abort(message) {
      failure = message;
      state = { ...state, phase: 'stopping', error: message };
      clearStream();
      process.kill();
    }

    const timeout = setTimeout(() => {
      if (state.phase !== 'stopping') abort('SnapLite перестал передавать кадры. Проверьте камеру и запустите её снова.');
    }, frameTimeout);
    process.stdin.on('error', () => {});
    process.stderr.setEncoding('utf8').on('data', (data) => { stderr = (stderr + data).slice(-4096); });
    process.on('error', (error) => { failure = `Не удалось запустить SnapLite. ${error.message}`; });
    process.stdout.on('data', (chunk) => {
      if (state.phase === 'stopping') return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size < 4 || size > maxJpegSize) {
          abort('SnapLite передал некорректный кадр.');
          return;
        }
        if (pending.length < size + 4) break;

        latestFrame = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${size}\r\n\r\n`),
          pending.subarray(4, size + 4),
          Buffer.from('\r\n'),
        ]);
        pending = pending.subarray(size + 4);
        if (state.phase === 'starting') state = { ...state, phase: 'live' };
        timeout.refresh();
        for (const viewer of viewers) {
          if (!viewer.writableNeedDrain) viewer.write(latestFrame);
        }
      }
    });
    process.once('close', () => {
      clearTimeout(timeout);
      clearStream();
      child = undefined;
      const error = failure || (state.phase === 'stopping' ? '' : workerError(stderr) || 'Работа камеры SnapLite прервалась.');
      state = { ...state, phase: error ? 'error' : 'idle', error };
    });
    return state;
  }

  function mount(app) {
    app.use('/api/camera', (request, response, next) => {
      const localAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
      const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host || '');
      const fetchSite = request.headers['sec-fetch-site'];
      const origin = request.headers.origin;
      response.set({ 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
      if (!localAddress || !localHost || request.headers.forwarded || request.headers['x-forwarded-for'] ||
          (fetchSite && !['same-origin', 'none'].includes(fetchSite)) ||
          (origin && origin !== `http://${request.headers.host}`)) {
        response.sendStatus(403);
        return;
      }
      next();
    });
    app.get('/api/camera/state', (_request, response) => {
      response.json({ live: state.phase === 'live', run: state.run });
    });
    app.get('/api/camera/stream', (request, response) => {
      if (!latestFrame || String(state.run) !== request.query.run) return response.sendStatus(404);
      if (request.method === 'HEAD') return response.sendStatus(200);
      if (viewers.size >= 16) return response.sendStatus(503);
      response.type(`multipart/x-mixed-replace; boundary=${boundary}`);
      viewers.add(response);
      response.on('close', () => viewers.delete(response));
      response.write(latestFrame);
    });
  }

  return { getState: () => state, listDevices, mount, start, stop };
}

module.exports = { createSnapCamera };
