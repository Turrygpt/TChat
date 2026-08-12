'use strict';

// TChat — точечный обход только для YouTube и только в этом приложении.
//
// Что делает:
//  1. Chromium (встроенный плеер/iframe): выставляет proxy-pac-url так, что
//     на прокси уходят ТОЛЬКО youtube-домены, остальное — DIRECT.
//  2. youtube-chat (axios): подменяет agent у общего экземпляра axios.
//     В проекте axios использует только youtube-chat, поэтому это = только YouTube.
//  3. Метаданные (глобальный fetch/undici): оборачивает fetch и добавляет
//     dispatcher ТОЛЬКО для youtube-хостов. VK/Rutube/Twitch/DonationAlerts не трогаются.
//
// Включение: youtube-proxy.json в корне ({ "enabled": true, "proxy": "http://127.0.0.1:1080" })
// или переменная окружения TCHAT_YT_PROXY (имеет приоритет).

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const YT_SUFFIXES = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'youtubei.googleapis.com',
];

function isYouTubeHost(host) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  return YT_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

function hostFromUrl(input) {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input && typeof input.url === 'string'
        ? input.url
        : String(input || '');
    if (!/^https?:/i.test(raw)) return '';
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

function readConfig() {
  // env имеет приоритет
  const envProxy = process.env.TCHAT_YT_PROXY && String(process.env.TCHAT_YT_PROXY).trim();
  if (envProxy) return { enabled: true, proxy: envProxy };

  try {
    const cfgPath = path.join(PROJECT_ROOT, 'youtube-proxy.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.enabled && cfg.proxy) {
        return { enabled: true, proxy: String(cfg.proxy).trim() };
      }
    }
  } catch (error) {
    console.error('[ytProxy] не смог прочитать youtube-proxy.json:', error.message);
  }
  return { enabled: false, proxy: '' };
}

// "http://127.0.0.1:1080" -> "127.0.0.1:1080"
function proxyHostPort(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return u.host;
  } catch {
    return String(proxyUrl).replace(/^\w+:\/\//, '');
  }
}

function writePacFile(proxyUrl) {
  const hp = proxyHostPort(proxyUrl);
  const lines = YT_SUFFIXES.map((s) => `    is(${JSON.stringify(s)})`).join(' ||\n');
  const pac = `// TChat — сгенерировано автоматически. Только YouTube -> прокси, остальное DIRECT.
function FindProxyForURL(url, host) {
  var PROXY = "PROXY ${hp}";
  host = (host || "").toLowerCase();
  function is(suffix) {
    return host === suffix || host.slice(-(suffix.length + 1)) === ("." + suffix);
  }
  if (
${lines}
  ) {
    return PROXY;
  }
  return "DIRECT";
}
`;
  const outPath = path.join(PROJECT_ROOT, 'scripts', 'yt.generated.pac');
  fs.writeFileSync(outPath, pac, 'utf8');
  return outPath;
}

function toFileUrl(p) {
  let s = p.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s; // C:/... -> /C:/...
  return 'file://' + encodeURI(s);
}

function installChromiumProxy(app, proxyUrl) {
  if (!app || !app.commandLine) return;
  try {
    const pacPath = writePacFile(proxyUrl);
    app.commandLine.appendSwitch('proxy-pac-url', toFileUrl(pacPath));
    // Прокси форсирует TCP; на всякий случай гасим QUIC/UDP, который умеет обходить прокси.
    app.commandLine.appendSwitch('disable-quic');
    console.log('[ytProxy] Chromium: YouTube -> ' + proxyUrl + ' (PAC), остальное DIRECT');
  } catch (error) {
    console.error('[ytProxy] Chromium proxy не выставлен:', error.message);
  }
}

function installAxiosProxy(proxyUrl) {
  try {
    const axios = require('axios'); // тот же singleton, что и в youtube-chat
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    axios.defaults.httpAgent = agent;
    axios.defaults.httpsAgent = agent;
    axios.defaults.proxy = false; // отключаем встроенную логику proxy, работаем через agent
    console.log('[ytProxy] axios (youtube-chat) -> ' + proxyUrl);

    // Тот же откат, что и у fetch. Без него выключенный локальный прокси
    // (Xray не поднялся, порт закрыт) молча убивал ИМЕННО чат: метаданные
    // уходили напрямую и онлайн был виден, а чат ютуба не подключался вовсе.
    const proxyHost = new URL(proxyUrl).hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(proxyHost)) {
      return;
    }

    const http = require('node:http');
    const https = require('node:https');
    const directHttp = new http.Agent();
    const directHttps = new https.Agent();
    let warnedAboutFallback = false;

    axios.interceptors.response.use(undefined, (error) => {
      const config = error && error.config;
      // Ответ есть — прокси жив, а ругается сам YouTube: это не наш случай.
      if (!config || config.__tchatDirectRetry || (error && error.response)) {
        return Promise.reject(error);
      }

      config.__tchatDirectRetry = true;
      // Агенты задаём явно: undefined в конфиге запроса вернул бы прокси из
      // axios.defaults, и повтор ушёл бы туда же, откуда только что упал.
      config.httpAgent = directHttp;
      config.httpsAgent = directHttps;

      if (!warnedAboutFallback) {
        warnedAboutFallback = true;
        console.warn('[ytProxy] локальный прокси недоступен, чат YouTube подключается напрямую');
      }

      return axios.request(config);
    });
  } catch (error) {
    console.error('[ytProxy] axios proxy не выставлен:', error.message);
  }
}

function installFetchProxy(proxyUrl) {
  try {
    const { ProxyAgent } = require('undici');
    const dispatcher = new ProxyAgent(proxyUrl);
    const origFetch = globalThis.fetch;
    const proxyHost = new URL(proxyUrl).hostname.toLowerCase();
    const canFallbackDirect = ['127.0.0.1', 'localhost', '::1'].includes(proxyHost);
    let warnedAboutFallback = false;
    if (typeof origFetch !== 'function') return;

    globalThis.fetch = function patchedFetch(input, init) {
      init = init || {};
      try {
        const host = hostFromUrl(input);
        if (host && isYouTubeHost(host) && !init.dispatcher) {
          const proxiedRequest = origFetch(input, Object.assign({}, init, { dispatcher }));
          if (!canFallbackDirect) {
            return proxiedRequest;
          }

          return proxiedRequest.catch((error) => {
            if (init.signal?.aborted) {
              throw error;
            }
            if (!warnedAboutFallback) {
              warnedAboutFallback = true;
              console.warn('[ytProxy] локальный прокси недоступен, метаданные YouTube запрашиваются напрямую');
            }
            return origFetch(input, init);
          });
        }
      } catch {
        /* fall through */
      }
      return origFetch(input, init);
    };
    console.log('[ytProxy] fetch (метаданные YouTube) -> ' + proxyUrl + ' (остальные хосты как есть)');
  } catch (error) {
    console.error('[ytProxy] fetch proxy не выставлен:', error.message);
  }
}

let installed = false;

function install(opts) {
  opts = opts || {};
  if (installed) return;
  const cfg = readConfig();
  if (!cfg.enabled) {
    console.log('[ytProxy] выключен (нет youtube-proxy.json / TCHAT_YT_PROXY). Всё идёт напрямую.');
    return;
  }
  installed = true;
  installChromiumProxy(opts.app, cfg.proxy);
  installAxiosProxy(cfg.proxy);
  installFetchProxy(cfg.proxy);
}

module.exports = { install, isYouTubeHost, YT_SUFFIXES };
