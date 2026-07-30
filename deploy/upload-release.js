'use strict';

// Заливает собранный релиз (dist/) на VPS и перезапускает сервис tchat.
// Сервер после этого раздаёт установщик по /tchat/download/ и отдаёт
// latest.yml автообновлению приложения (electron-updater).
//
// Использование:
//   npm run dist
//   set TCHAT_DEPLOY_PASS=<пароль root>   (PowerShell: $env:TCHAT_DEPLOY_PASS='...')
//   node deploy/upload-release.js
//
// Требует пакет ssh2: npm install --no-save ssh2

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');

const SERVER_HOST = '195.62.49.244';
const REMOTE_DIR = '/opt/tchat';

const projectDir = path.join(__dirname, '..');
const dist = path.join(projectDir, 'dist');
const version = require(path.join(projectDir, 'package.json')).version;
const patchnotes = JSON.parse(fs.readFileSync(path.join(projectDir, 'patchnotes.json'), 'utf8'));
const releaseNote = patchnotes.notes?.find((note) => String(note.version) === String(version));

if (!releaseNote || typeof releaseNote.critical !== 'boolean') {
  console.error(
    `Релиз ${version} не помечен в patchnotes.json. Добавьте к записи версии "critical": true или false.`,
  );
  process.exit(1);
}

const password = process.env.TCHAT_DEPLOY_PASS;
if (!password) {
  console.error('Задайте пароль сервера в переменной TCHAT_DEPLOY_PASS.');
  process.exit(1);
}

// Виджеты обязаны ехать вместе с widgetServer.js: сервер отдаёт их список в
// /health и раздаёт из /widgets. Если залить только сервер, он будет обещать
// виджет, которого на диске нет, и по ссылке прилетит "Cannot GET".
const widgetsDir = path.join(projectDir, 'widgets');
const widgetUploads = fs.existsSync(widgetsDir)
  ? fs
      .readdirSync(widgetsDir)
      .filter((name) => fs.statSync(path.join(widgetsDir, name)).isFile())
      .map((name) => [path.join(widgetsDir, name), `${REMOTE_DIR}/widgets/${name}`])
  : [];

const uploads = [
  [path.join(dist, `TChat-Setup-${version}.exe`), `${REMOTE_DIR}/releases/TChat-Setup-${version}.exe`],
  [path.join(dist, `TChat-Setup-${version}.exe.blockmap`), `${REMOTE_DIR}/releases/TChat-Setup-${version}.exe.blockmap`],
  [path.join(projectDir, 'src', 'server', 'widgetServer.js'), `${REMOTE_DIR}/src/server/widgetServer.js`],
  [path.join(projectDir, 'package.json'), `${REMOTE_DIR}/package.json`],
  [path.join(projectDir, 'patchnotes.json'), `${REMOTE_DIR}/patchnotes.json`],
  // Рядом с latest.yml: установленное приложение читает заметки о версии,
  // которой у него ещё нет, с той же раздачи, откуда качает обновление.
  [path.join(projectDir, 'patchnotes.json'), `${REMOTE_DIR}/releases/patchnotes.json`],
  ...widgetUploads,
  // Publish latest.yml last. Clients must not discover a release before its
  // critical/regular policy, installer, blockmap and patch notes are present.
  [path.join(dist, 'latest.yml'), `${REMOTE_DIR}/releases/latest.yml`],
];

for (const [local] of uploads) {
  if (!fs.existsSync(local)) {
    console.error(`Нет файла: ${local} — сначала npm run dist.`);
    process.exit(1);
  }
}

const conn = new Client();

function exec(command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errOut += d));
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}: ${errOut || out}`));
        resolve(out.trim());
      });
    });
  });
}

conn
  .on('ready', async () => {
    try {
      await exec(`mkdir -p ${REMOTE_DIR}/releases ${REMOTE_DIR}/widgets`);
      const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
      for (const [local, remote] of uploads) {
        await new Promise((resolve, reject) =>
          sftp.fastPut(local, remote, (e) => (e ? reject(new Error(`${local}: ${e.message}`)) : resolve())),
        );
        console.log(`загружен ${path.basename(local)}`);
      }
      await exec('systemctl restart tchat');
      await new Promise((r) => setTimeout(r, 3000));
      console.log('health: ' + (await exec('curl -s http://127.0.0.1:3000/health')));
      console.log(`Готово. Ссылка: http://${SERVER_HOST}/tchat/download/TChat-Setup-${version}.exe`);
    } catch (error) {
      console.error('ОШИБКА: ' + error.message);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .on('error', (error) => {
    console.error('ssh: ' + error.message);
    process.exit(1);
  })
  .connect({ host: SERVER_HOST, port: 22, username: 'root', password, readyTimeout: 20000 });
