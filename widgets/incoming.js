'use strict';

// Плеер одного входящего потока. По ?id= тянет живой MPEG-TS с локального
// сервера TChat (/streams/<id>/live.ts) и играет через mpegts.js (MSE). Сам
// переподключается, если поток пропал (источник отвалился, OBS прятал сцену).

(() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') || '';
  const video = document.getElementById('cam');
  const placeholderText = document.getElementById('placeholderText');

  if (params.get('fit') === 'contain') {
    document.body.classList.add('fit-contain');
  }
  if (params.get('placeholder') === '0') {
    document.body.classList.add('no-placeholder');
  }
  video.muted = params.get('muted') === '1';

  if (!id) {
    if (placeholderText) placeholderText.textContent = 'Не указан ?id потока';
    return;
  }

  const streamUrl = new URL(`/streams/${encodeURIComponent(id)}/live.ts`, window.location.href).href;

  let player = null;
  let retryTimer = null;
  let destroyed = false;

  function setLive(on) {
    document.body.classList.toggle('live', on);
  }

  function scheduleReconnect(delay) {
    if (destroyed || retryTimer) {
      return;
    }
    setLive(false);
    if (placeholderText) {
      placeholderText.textContent = 'Ждём поток…';
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function teardown() {
    if (player) {
      try {
        player.destroy();
      } catch {
        /* уже разрушен */
      }
      player = null;
    }
  }

  function connect() {
    if (destroyed) {
      return;
    }
    if (!window.mpegts || !window.mpegts.isSupported()) {
      if (placeholderText) {
        placeholderText.textContent = 'Браузер не поддерживает MSE-воспроизведение';
      }
      return;
    }

    teardown();

    player = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: streamUrl },
      {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.5,
        liveBufferLatencyMinRemain: 0.3,
        lazyLoad: false,
        stashInitialSize: 128,
      },
    );

    player.on(window.mpegts.Events.ERROR, () => {
      teardown();
      scheduleReconnect(1500);
    });

    player.attachMediaElement(video);
    player.load();
    const tryPlay = () => video.play().catch(() => {});
    player.play().then(tryPlay).catch(tryPlay);
  }

  video.addEventListener('playing', () => setLive(true));
  video.addEventListener('waiting', () => setLive(false));
  video.addEventListener('stalled', () => scheduleReconnect(1500));
  video.addEventListener('ended', () => scheduleReconnect(1500));

  window.addEventListener('beforeunload', () => {
    destroyed = true;
    clearTimeout(retryTimer);
    teardown();
  });

  connect();
})();
