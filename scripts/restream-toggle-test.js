'use strict';

// Проверяет, что включение и выключение площадки не рвёт эфир остальным.
//
// Поднимаем рестрим с двумя площадками, вместо RTMP пишем в файлы (ffmpeg всё
// равно, куда муксить), подаём на вход синтетический поток вместо OBS. Затем
// гасим вторую площадку и смотрим на первую: её файл должен продолжать расти,
// а процесс слушателя — остаться тем же, без переподключения входа.
//
// Запуск: node scripts/restream-toggle-test.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ffmpegPath = require('ffmpeg-static');
const restream = require('../src/restream');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-restream-'));
const PORT = 1937;
const KEY = 'test';
const firstFile = path.join(workDir, 'first.flv');
const secondFile = path.join(workDir, 'second.flv');
const secondAgainFile = path.join(workDir, 'second-again.flv');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sizeOf = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

const failures = [];
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

async function main() {
  restream.init({ storageDir: workDir, onStatus: () => {} });
  restream.saveConfig({
    ingestPort: PORT,
    streamKey: KEY,
    destinations: [
      { id: 'first', name: 'Первая', url: firstFile, key: '', enabled: true },
      { id: 'second', name: 'Вторая', url: secondFile, key: '', enabled: true },
    ],
  });
  restream.start();
  await sleep(1500);

  // Вместо OBS — синтетический поток на тот же локальный RTMP.
  const source = spawn(
    ffmpegPath,
    [
      '-loglevel', 'error',
      '-re',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15',
      '-c:a', 'aac', '-shortest',
      '-f', 'flv', `rtmp://127.0.0.1:${PORT}/live/${KEY}`,
    ],
    { windowsHide: true },
  );
  source.stderr.on('data', (d) => process.stderr.write(`[источник] ${d}`));

  await sleep(9000);

  const liveState = restream.getState();
  check('эфир идёт', liveState.live, `битрейт ${liveState.stats.bitrateKbps} kbps`);
  check('обе площадки в эфире', liveState.destinations.every((d) => d.status === 'live'),
    liveState.destinations.map((d) => `${d.name}:${d.status}`).join(', '));

  // Размер файла — грубая мерка: ffmpeg сбрасывает вывод на диск блоками по
  // 256 КБ, между замерами файл может не измениться, хотя поток идёт. Поэтому
  // основная проверка — счётчик реально отданных площадке байт.
  const sentOf = (state, id) => state.destinations.find((d) => d.id === id)?.sentBytes || 0;
  const firstBefore = sentOf(liveState, 'first');
  const secondBefore = sentOf(liveState, 'second');
  check('первая площадка пишет', firstBefore > 0, `${firstBefore} байт`);
  check('вторая площадка пишет', secondBefore > 0, `${secondBefore} байт`);

  const secondFileBefore = sizeOf(secondFile);

  // Гасим вторую площадку — первая не должна этого заметить.
  restream.saveConfig({
    destinations: [
      { id: 'first', name: 'Первая', url: firstFile, key: '', enabled: true },
      { id: 'second', name: 'Вторая', url: secondFile, key: '', enabled: false },
    ],
  });
  await sleep(6000);

  const afterState = restream.getState();
  const firstAfter = sentOf(afterState, 'first');
  const secondAfter = sentOf(afterState, 'second');

  check('эфир не прервался', afterState.live, `live=${afterState.live}`);
  check('входящий поток не переподключался', afterState.stats.disconnects === 0,
    `обрывов: ${afterState.stats.disconnects}`);
  check('первая площадка продолжила писать', firstAfter > firstBefore,
    `${firstBefore} → ${firstAfter} байт`);
  check('вторая площадка остановлена', secondAfter === secondBefore,
    `${secondBefore} → ${secondAfter} байт`);
  check('файл выключенной площадки не растёт', sizeOf(secondFile) === secondFileBefore,
    `${secondFileBefore} → ${sizeOf(secondFile)} байт`);
  check('вторая помечена выключенной', afterState.destinations.find((d) => d.id === 'second')?.status === 'idle');

  // Возвращаем вторую в эфир — снова без последствий для первой. Файл берём
  // новый: ffmpeg не перезаписывает существующий без -y, а настоящая площадка
  // при возврате открывает свежее соединение, а не дописывает старое.
  const firstBeforeBack = sentOf(afterState, 'first');
  restream.saveConfig({
    destinations: [
      { id: 'first', name: 'Первая', url: firstFile, key: '', enabled: true },
      { id: 'second', name: 'Вторая', url: secondAgainFile, key: '', enabled: true },
    ],
  });
  await sleep(6000);

  const backState = restream.getState();
  check('эфир пережил и включение', backState.live && backState.stats.disconnects === 0,
    `обрывов: ${backState.stats.disconnects}`);
  check('первая площадка не заметила соседа', sentOf(backState, 'first') > firstBeforeBack,
    `${firstBeforeBack} → ${sentOf(backState, 'first')} байт`);
  const secondBack = backState.destinations.find((d) => d.id === 'second');
  check('вторая площадка вернулась в эфир', secondBack?.status === 'live',
    `статус ${secondBack?.status}${secondBack?.error ? `, ${secondBack.error}` : ''}`);
  check('вторая площадка снова пишет', sentOf(backState, 'second') > 0,
    `${sentOf(backState, 'second')} байт`);

  source.kill('SIGKILL');
  restream.stop();
  restream.shutdown();
  await sleep(500);

  console.log(`\nРезультат: ${failures.length ? `провалено ${failures.length}` : 'всё сошлось'}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
