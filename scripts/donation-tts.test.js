const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../widgets/stream.js'), 'utf8');

function createPlayer({ sound = () => Promise.resolve(), rejectPlayback = false } = {}) {
  const audio = [];
  const played = [];
  const waits = [];
  const warnings = [];
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.handlers = new Map();
      this.paused = false;
      audio.push(this);
    }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    removeEventListener(name) { this.handlers.delete(name); }
    fire(name) { this.handlers.get(name)?.(); }
    play() { return rejectPlayback ? Promise.reject(new Error('Playback blocked')) : Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.unloaded = true; }
  }
  const context = vm.createContext({
    Audio: FakeAudio,
    Date: { now: () => now },
    console: { warn: (...args) => warnings.push(args) },
    window: {
      setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    MIN_DONATION_DISPLAY_MS: 15000,
    alertQueue: [], queuedAlertIds: new Set(), isAlertPlaying: false, displaySeconds: 8,
    alertBox: { classList: { add() {}, remove() {} }, offsetWidth: 0 },
    renderAlert() {}, playAlertSound: sound,
    wait: (ms) => { waits.push(ms); return Promise.resolve(); },
    socket: { emit: (name, payload) => played.push({ name, ...payload }) },
  });
  for (const name of ['playNextAlert', 'speakDonation', 'playEdgeTts', 'formatMoney']) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, `${name} exists`);
    vm.runInContext(source.slice(start, end), context);
  }
  return { context, audio, played, waits, warnings, timers, advance: (ms) => { now += ms; } };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const donation = (id) => ({ id, kind: 'donation', donation: { username: 'Иван', amount: 500, message: 'Спасибо & удачи!' } });

test('donation speech follows the alert sound and holds the queue until audio ends', async () => {
  let finishSound;
  const soundEnded = new Promise((resolve) => { finishSound = resolve; });
  const player = createPlayer({ sound: () => soundEnded });
  player.context.alertQueue.push(donation('one'), donation('two'));
  player.context.queuedAlertIds.add('one').add('two');
  const playback = player.context.playNextAlert();
  await flush();
  assert.equal(player.audio.length, 0, 'waits for custom alert sound');
  finishSound();
  await flush();
  assert.equal(player.audio.length, 1);
  const url = new URL(player.audio[0].src, 'http://localhost');
  assert.equal(url.pathname, '/tts/edge');
  assert.equal(url.searchParams.get('text'), 'Иван. Донат 500 рублей. Спасибо & удачи!');
  assert.equal(player.played.length, 0);
  assert.equal(player.context.alertQueue.length, 1);
  player.advance(20000);
  player.audio[0].fire('ended');
  await playback;
  await flush();
  assert.equal(player.played[0].id, 'one');
  assert.equal(player.waits[0], 0, 'long speech is not cut off or followed by another display delay');
  assert.equal(player.audio.length, 2);
  assert.ok(player.audio[0].paused && player.audio[0].unloaded);
  player.audio[1].fire('ended');
  await flush();
  assert.deepEqual(player.played.map((item) => item.id), ['one', 'two']);
  assert.equal(player.context.isAlertPlaying, false);
  assert.equal(player.timers.size, 0);
});

test('short speech keeps the donation visible for at least 15 seconds', async () => {
  const player = createPlayer();
  player.context.alertQueue.push(donation('short'));
  const playback = player.context.playNextAlert();
  await flush();
  player.advance(2000);
  player.audio[0].fire('ended');
  await playback;
  assert.equal(player.waits[0], 13000);
  assert.equal(player.played[0].id, 'short');
});

test('an unavailable TTS endpoint and rejected playback release subsequent donations', async () => {
  const player = createPlayer();
  player.context.alertQueue.push(donation('failed'), donation('next'));
  const playback = player.context.playNextAlert();
  await flush();
  player.audio[0].fire('error');
  await playback;
  await flush();
  assert.equal(player.warnings.length, 1);
  assert.equal(player.audio.length, 2);
  assert.equal(player.played[0].id, 'failed');
  player.audio[1].fire('ended');
  await flush();
  assert.equal(player.context.isAlertPlaying, false);

  const blocked = createPlayer({ rejectPlayback: true });
  blocked.context.alertQueue.push(donation('blocked'));
  await blocked.context.playNextAlert();
  assert.equal(blocked.warnings.length, 1);
  assert.equal(blocked.played[0].id, 'blocked');
  assert.equal(blocked.timers.size, 0);
});

test('TTS timeout covers synthesis retries and stops late audio before continuing', async () => {
  const player = createPlayer();
  const playback = player.context.playEdgeTts('Проверка');
  const timeout = [...player.timers.values()][0];
  assert.ok(timeout.ms >= 55000);
  timeout.fn();
  await playback;
  assert.ok(player.audio[0].paused && player.audio[0].unloaded);
  assert.equal(player.audio[0].handlers.size, 0);
  assert.equal(player.timers.size, 0);
});

test('empty text and non-donation alerts do not request TTS; text respects the server limit', async () => {
  const player = createPlayer();
  await player.context.playEdgeTts(' \n ');
  player.context.alertQueue.push({ id: 'greeting', kind: 'firstMessage' });
  await player.context.playNextAlert();
  assert.equal(player.audio.length, 0);
  const playback = player.context.playEdgeTts('я'.repeat(900));
  assert.equal(new URL(player.audio[0].src, 'http://localhost').searchParams.get('text').length, 700);
  player.audio[0].fire('ended');
  await playback;
});
