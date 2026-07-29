'use strict';

// A broken RTMP destination must fail and retry without interrupting the
// listener or another destination that is still receiving the same stream.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ffmpegPath = require('ffmpeg-static');
const restream = require('../src/restream');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-restream-failure-'));
const outputFile = path.join(workDir, 'healthy.flv');
const port = 1938;
const key = 'failure-test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) {
    failures.push(name);
  }
}

async function main() {
  restream.init({ storageDir: workDir, onStatus: () => {} });
  restream.saveConfig({
    ingestPort: port,
    streamKey: key,
    destinations: [
      { id: 'healthy', name: 'Healthy', url: outputFile, key: '', enabled: true },
      {
        id: 'broken',
        name: 'Broken YouTube-like endpoint',
        url: 'rtmp://127.0.0.1:65534/live',
        key: 'secret-test-key',
        enabled: true,
      },
    ],
  });
  restream.start();
  await sleep(1200);

  const source = spawn(ffmpegPath, [
    '-loglevel', 'error',
    '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15',
    '-c:a', 'aac', '-shortest',
    '-f', 'flv', `rtmp://127.0.0.1:${port}/live/${key}`,
  ], { windowsHide: true });

  await sleep(6500);
  const first = restream.getState();
  const firstBytes = first.destinations.find((dest) => dest.id === 'healthy')?.sentBytes || 0;
  await sleep(10000);
  const second = restream.getState();
  const secondBytes = second.destinations.find((dest) => dest.id === 'healthy')?.sentBytes || 0;
  const logPath = path.join(workDir, 'logs', 'restream.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const logEvents = log
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);

  check('listener remains live', second.live);
  check('listener did not reconnect', second.stats.disconnects === 0, `disconnects=${second.stats.disconnects}`);
  check('healthy destination keeps receiving data', secondBytes > firstBytes, `${firstBytes} → ${secondBytes}`);
  check(
    'broken destination failure is logged',
    logEvents.some((event) => ['destination-error', 'destination-exit', 'destination-stall'].includes(event)),
    `events=${[...new Set(logEvents)].join(',')}`,
  );
  check('stream key is redacted from log', !log.includes('secret-test-key'));

  source.kill('SIGKILL');
  restream.stop();
  restream.shutdown();
  await sleep(300);
  fs.rmSync(workDir, { recursive: true, force: true });

  console.log(`\nResult: ${failures.length ? `${failures.length} failure(s)` : 'all checks passed'}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  restream.shutdown();
  process.exit(1);
});
