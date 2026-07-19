'use strict';

// Раздаёт установщики прямо через nginx, а не через прокси на Express.
//
// Зачем: electron-updater качает обновление кусками и просит несколько
// диапазонов одним запросом (multi-range). Express (модуль send) такое не умеет
// и вместо 206 с кусками отдаёт 200 со всем файлом целиком — докачка собирала
// из этого мусор. Поэтому в приложении стоял disableDifferentialDownload, и
// каждое обновление тянуло установщик целиком, все 150 МБ.
//
// nginx отдаёт диапазоны сам и multi-range поддерживает. После этой правки
// дифференциальную докачку можно включить обратно.
//
// Скрипт делает резервную копию конфига, проверяет nginx -t, перезагружает и
// прогоняет тесты. Если что-то пошло не так — возвращает конфиг обратно.

const { Client } = require('ssh2');

const SERVER_HOST = '195.62.49.244';
const CONFIG_PATH = '/etc/nginx/conf.d/tchat.conf';
const BACKUP_PATH = `${CONFIG_PATH}.bak-download-range`;

const password = process.env.TCHAT_DEPLOY_PASS;
if (!password) {
  console.error('Задайте пароль сервера в переменной TCHAT_DEPLOY_PASS.');
  process.exit(1);
}

// Префиксные location в nginx выбираются по самому длинному совпадению, поэтому
// /tchat/download/ перехватывает запросы раньше общего /tchat/.
const DOWNLOAD_LOCATION = [
  '    location /tchat/download/ {',
  '        alias /opt/tchat/releases/;',
  '        autoindex off;',
  '        add_header Accept-Ranges bytes;',
  '    }',
  '',
].join('\\n');

const conn = new Client();

function exec(command, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errOut += d));
      stream.on('close', (code) => {
        if (code !== 0 && !allowFail) return reject(new Error(`exit ${code}: ${errOut || out}`));
        resolve((out + errOut).trim());
      });
    });
  });
}

async function rollback() {
  console.log('Откатываю конфиг.');
  await exec(`cp ${BACKUP_PATH} ${CONFIG_PATH} && nginx -t && systemctl reload nginx`);
}

conn
  .on('ready', async () => {
    try {
      const already = await exec(`grep -c "location /tchat/download/" ${CONFIG_PATH} || true`, { allowFail: true });
      if (Number(already) > 0) {
        console.log('Раздача уже настроена, конфиг не трогаю.');
      } else {
        await exec(`cp ${CONFIG_PATH} ${BACKUP_PATH}`);
        console.log(`Резервная копия: ${BACKUP_PATH}`);
        await exec(`sed -i 's|^    location /tchat/ {|${DOWNLOAD_LOCATION}    location /tchat/ {|' ${CONFIG_PATH}`);
        console.log('Конфиг обновлён.');
      }

      const test = await exec('nginx -t', { allowFail: true });
      if (!/successful/.test(test)) {
        console.error(test);
        await rollback();
        throw new Error('nginx -t не прошёл');
      }

      await exec('systemctl reload nginx');
      console.log('nginx перезагружен.');

      const url = 'http://127.0.0.1/tchat/download/TChat-Setup-1.2.10.exe';
      const single = await exec(`curl -s -o /dev/null -w "%{http_code} %{size_download}" -r 0-1023 ${url}`);
      const multi = await exec(`curl -s -D - -o /dev/null -r 0-1023,2048-3071 ${url} | head -3 | tr -d '\\r'`);
      const yml = await exec(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/tchat/download/latest.yml`);

      console.log(`\nодин диапазон:  ${single}   (ждём "206 1024")`);
      console.log(`несколько:      ${multi.split('\\n')[0]}   (ждём 206 Partial Content)`);
      console.log(`latest.yml:     ${yml}   (ждём 200)`);

      if (!single.startsWith('206') || !/206/.test(multi) || yml !== '200') {
        await rollback();
        throw new Error('проверки не прошли, конфиг откачен');
      }

      console.log('\nГотово: диапазоны отдаёт nginx, multi-range работает.');
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
