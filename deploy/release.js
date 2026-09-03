'use strict';

// Собирает установщик, публикует релиз на GitHub (оттуда его теперь берёт
// автообновление) и заливает виджеты/патчноуты на VPS одной командой.
//
// Использование:
//   PowerShell:  $env:GH_TOKEN='<personal access token>'; $env:TCHAT_DEPLOY_PASS='<пароль root>'; npm run release
//   cmd:         set "GH_TOKEN=<токен>" && set "TCHAT_DEPLOY_PASS=<пароль root>" && npm run release
//
// GH_TOKEN нужен personal access token с правами repo (Settings → Developer
// settings → Personal access tokens на github.com) — им electron-builder
// создаёт GitHub Release и заливает в него установщик и latest.yml.
//
// Что делает по шагам:
//   1. проверяет, что заданы GH_TOKEN и пароль VPS (падаем сразу, до долгой сборки);
//   2. ставит ssh2, если его нет (нужен upload-release.js);
//   3. npm run dist:publish — собирает установщик и публикует его в GitHub
//      Releases (latest.yml оттуда же читает автообновление);
//   4. node deploy/upload-release.js — обновляет widgetServer.js, патчноуты
//      и виджеты на VPS (это отдельный, живой сервис, не связанный с
//      автообновлением) и перезапускает его.
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

if (!process.env.GH_TOKEN) {
  console.error(
    'Не задан GitHub-токен. Задайте GH_TOKEN (personal access token с правами repo) и запустите снова:\n' +
      "  PowerShell:  $env:GH_TOKEN='<токен>'; npm run release\n" +
      '  cmd:         set "GH_TOKEN=<токен>" && npm run release',
  );
  process.exit(1);
}

// В GitHub-токене бывают только буквы, цифры, _ и -. Всё остальное — это в
// переменную попала подстановка из инструкции (<токен>) или лишние кавычки.
// electron-builder ловит это сам, но уже В КОНЦЕ сборки: несколько минут
// потрачено впустую, а ошибка тонет в куче стектрейсов про publish.
if (!/^[\w-]+$/.test(process.env.GH_TOKEN)) {
  console.error(
    'GH_TOKEN не похож на токен: в нём есть символы, которых в GitHub PAT не бывает —\n' +
      'скорее всего, в переменную попала подстановка <токен> или лишние кавычки.\n' +
      'Токен берётся на github.com: Settings → Developer settings → Personal access tokens →\n' +
      'Tokens (classic) → Generate new token, права repo.',
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

// 2. сборка установщика и публикация в GitHub Releases
run(`сборка и публикация TChat ${version}`, 'npm', ['run', 'dist:publish'], WINCODESIGN_HINT);

// 3. синхронизация виджет-сервера на VPS (не связано с автообновлением)
run('обновление виджет-сервера на VPS', 'node', ['deploy/upload-release.js']);

console.log(`\nГотово: TChat ${version} опубликован на GitHub и виджет-сервер обновлён.`);
