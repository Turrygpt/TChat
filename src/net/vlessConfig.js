'use strict';

// Парсит vless:// ссылку и пересобирает youtube-bypass/xray-config.json.
// Используется настройкой в бэкофисе: вставил новую ссылку -> конфиг обновился.
// Проксируется по-прежнему ТОЛЬКО YouTube (routing), локальный HTTP-порт берётся
// из youtube-proxy.json (по умолчанию 10810).

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const XRAY_CONFIG_PATH = path.join(PROJECT_ROOT, 'youtube-bypass', 'xray-config.json');
const PROXY_STATE_PATH = path.join(PROJECT_ROOT, 'youtube-proxy.json');

const YT_DOMAINS = [
  'geosite:youtube',
  'domain:youtube.com',
  'domain:youtu.be',
  'domain:youtube-nocookie.com',
  'domain:googlevideo.com',
  'domain:ytimg.com',
  'domain:ggpht.com',
  'domain:youtubei.googleapis.com',
];

function parseVlessLink(link) {
  const raw = String(link || '').trim();
  if (!/^vless:\/\//i.test(raw)) {
    throw new Error('Ссылка должна начинаться с vless://');
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Не удалось разобрать ссылку (проверь формат)');
  }

  const id = decodeURIComponent(u.username || '');
  const address = u.hostname;
  const port = Number(u.port || 443);
  if (!id) throw new Error('В ссылке нет UUID');
  if (!address) throw new Error('В ссылке нет адреса сервера');

  const p = u.searchParams;
  return {
    id,
    address,
    port,
    network: p.get('type') || 'tcp',
    security: p.get('security') || 'none',
    sni: p.get('sni') || p.get('peer') || '',
    fingerprint: p.get('fp') || 'chrome',
    publicKey: p.get('pbk') || '',
    shortId: p.get('sid') || '',
    spiderX: p.get('spx') || '/',
    flow: p.get('flow') || '',
    tag: decodeURIComponent((u.hash || '').replace(/^#/, '')),
  };
}

function buildXrayConfig(v, options = {}) {
  const httpPort = Number(options.httpPort || 10810);

  const streamSettings = { network: v.network || 'tcp' };
  if (v.security === 'reality') {
    streamSettings.security = 'reality';
    streamSettings.realitySettings = {
      show: false,
      fingerprint: v.fingerprint || 'chrome',
      serverName: v.sni,
      publicKey: v.publicKey,
      shortId: v.shortId,
      spiderX: v.spiderX || '/',
    };
  } else if (v.security === 'tls') {
    streamSettings.security = 'tls';
    streamSettings.tlsSettings = {
      serverName: v.sni,
      fingerprint: v.fingerprint || 'chrome',
      allowInsecure: false,
    };
  }

  const user = { id: v.id, encryption: 'none' };
  if (v.flow) user.flow = v.flow;

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'http-in',
        listen: '127.0.0.1',
        port: httpPort,
        protocol: 'http',
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: { vnext: [{ address: v.address, port: v.port, users: [user] }] },
        streamSettings,
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', outboundTag: 'proxy', domain: YT_DOMAINS },
        { type: 'field', outboundTag: 'direct', network: 'tcp,udp' },
      ],
    },
  };
}

function readProxyState() {
  try {
    return JSON.parse(fs.readFileSync(PROXY_STATE_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeProxyState(state) {
  fs.writeFileSync(PROXY_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function portFromProxy(proxy) {
  const m = String(proxy || '').match(/:(\d+)\/?$/);
  return Number((m && m[1]) || 10810);
}

function summaryOf(v) {
  return {
    address: v.address,
    port: v.port,
    sni: v.sni,
    security: v.security,
    flow: v.flow,
    tag: v.tag,
  };
}

function getState() {
  const s = readProxyState();
  const proxy = s.proxy || 'http://127.0.0.1:10810';
  let summary = null;
  if (s.vless) {
    try {
      summary = summaryOf(parseVlessLink(s.vless));
    } catch {
      summary = null;
    }
  }
  return {
    enabled: s.enabled !== false,
    link: s.vless || '',
    proxy,
    httpPort: portFromProxy(proxy),
    summary,
  };
}

function saveLink(payload = {}) {
  const s = readProxyState();
  const proxy = s.proxy || 'http://127.0.0.1:10810';
  const httpPort = portFromProxy(proxy);
  const trimmed = String(payload.link || '').trim();

  let summary = null;
  if (trimmed) {
    const v = parseVlessLink(trimmed); // бросит понятную ошибку при кривой ссылке
    const cfg = buildXrayConfig(v, { httpPort });
    fs.mkdirSync(path.dirname(XRAY_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    summary = summaryOf(v);
    s.vless = trimmed;
  }

  if (typeof payload.enabled === 'boolean') {
    s.enabled = payload.enabled;
  } else if (typeof s.enabled !== 'boolean') {
    s.enabled = true;
  }
  if (!s.proxy) s.proxy = proxy;

  writeProxyState(s);
  return { ok: true, enabled: s.enabled !== false, link: s.vless || '', summary };
}

module.exports = { parseVlessLink, buildXrayConfig, getState, saveLink };
