'use strict';

// Собирает установщик и заливает релиз на VPS одной командой.
//
// Использование:
//   PowerShell:  $env:TCHAT_DEPLOY_PASS='<пароль root>'; npm run release
//   cmd:         set "TCHAT_DEPLOY_PASS=<пароль root>" && npm run release
//
// Что делает по шагам:
//   1. проверяет, что задан пароль сервера (падаем сразу, до долгой сборки);
//   2. ставит ssh2, если его нет (нужен upload-release.js);
//   3. npm run dist — собирает NSIS-установщик текущей версии из package.json;
//   4. node deploy/upload-release.js — заливает установщик, latest.yml,
//      патчноуты и виджеты на сервер и перезапускает сервис.
//
// Важно: поднимите version в package.json ДО запуска — иначе автообновление
// не увидит новый релиз (соберётся установщик со старым номером).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.join(__dirname, '..');
const version = require(path.join(projectDir, 'package.json')).version;
const patchnotes = JSON.parse(fs.readFileSync(path.join(projectDir, 'patchnotes.json'), 'utf8'));
const releaseNote = patchnotes.notes?.find((note) => String(note.version) === String(version));

if (!releaseNote || typeof releaseNote.critical !== 'boolean') {
  console.error(
    `Релиз ${version} не помечен в patchnotes.json. Добавьте к записи версии "critical": true или false.`,
  );
  process.exit(1);
}

if (!process.env.TCHAT_DEPLOY_PASS) {
  console.error(
    'Не задан пароль сервера. Задайте TCHAT_DEPLOY_PASS и запустите снова:\n' +
      "  PowerShell:  $env:TCHAT_DEPLOY_PASS='<пароль>'; npm run release\n" +
      '  cmd:         set "TCHAT_DEPLOY_PASS=<пароль>" && npm run release',
  );
  process.exit(1);
}

// Выполняет шаг и валит весь релиз, если шаг упал: не хочется залить половину.
function run(label, command, args, hint = '') {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: projectDir, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nШаг «${label}» завершился с ошибкой (код ${result.status}). Релиз остановлен.`);
    if (hint) {
      console.error(hint);
    }
    process.exit(result.status || 1);
  }
}

// Сборка часто падает на симлинках winCodeSign (darwin/*.dylib): Windows не даёт
// их создавать без права SeCreateSymbolicLinkPrivilege. Подсказываем, как выдать.
const WINCODESIGN_HINT =
  '\nВозможная причина — winCodeSign не смог создать симлинки darwin/*.dylib.\n' +
  'Дайте сборке право на симлинки одним из способов и запустите снова:\n' +
  '  • включите «Режим разработчика»: Параметры → Конфиденциальность и защита → Для разработчиков;\n' +
  '  • либо запустите терминал «от имени администратора».';

// 1. ssh2 нужен upload-release.js. Ставим только если ещё нет — чтобы не ждать npm зря.
if (!fs.existsSync(path.join(projectDir, 'node_modules', 'ssh2'))) {
  run('установка ssh2', 'npm', ['install', '--no-save', 'ssh2']);
}

// 2. сборка установщика
run(`сборка TChat ${version}`, 'npm', ['run', 'dist'], WINCODESIGN_HINT);

// 3. заливка на сервер
run('заливка релиза', 'node', ['deploy/upload-release.js']);

console.log(`\nГотово: TChat ${version} собран и залит на сервер.`);
