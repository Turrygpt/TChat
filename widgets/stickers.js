// Слой стикеров. Используется двумя страницами:
//   - widgets/stickers.html — отдельный источник в OBS;
//   - widgets/stream.html   — общий оверлей вместе с остальными виджетами.
// Поэтому здесь нет своего io() и глобальных переменных: страница передаёт
// готовый сокет и контейнер в TChatStickers.mount().
(() => {
  const ANIMATIONS = ['pop', 'drop', 'slide', 'spin', 'fly', 'glitch', 'zoom'];
  const FIXED_POSITIONS = {
    'top-left': [20, 22],
    top: [50, 18],
    'top-right': [80, 22],
    left: [16, 50],
    center: [50, 50],
    right: [84, 50],
    'bottom-left': [20, 78],
    bottom: [50, 82],
    'bottom-right': [80, 78],
  };

  const IN_DURATION_MS = 900;
  const OUT_DURATION_MS = 700;

  function mount({ socket, layer } = {}) {
    if (!socket || !layer || layer.dataset.stickersMounted === '1') {
      return null;
    }

    layer.dataset.stickersMounted = '1';

    let settings = {
      displaySeconds: 8,
      maxOnScreen: 6,
      showUser: true,
    };

    // Живые стикеры: id -> { node, x, y, timer }.
    const active = new Map();

    fetch('/stickers/state')
      .then((response) => response.json())
      .then((state) => applySettings(state?.settings))
      .catch(() => {});

    socket.on('stickers:settings', applySettings);
    socket.on('sticker:show', showSticker);
    socket.on('sticker:clear', clearStickers);

    function applySettings(next) {
      if (!next) {
        return;
      }

      settings = {
        displaySeconds: Math.max(Number(next.displaySeconds || settings.displaySeconds), 1),
        maxOnScreen: Math.max(Number(next.maxOnScreen || settings.maxOnScreen), 1),
        showUser: next.showUser !== false,
      };
    }

    function showSticker(payload = {}) {
      const url = String(payload.url || '').trim();
      if (!url) {
        return;
      }

      const id = String(payload.id || `sticker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const size = clamp(Number(payload.size || 240), 60, 1200);
      const seconds = Math.max(Number(payload.seconds || settings.displaySeconds), 1);
      const animation = resolveAnimation(payload.animation);
      const point = resolvePoint(payload.position);

      while (active.size >= settings.maxOnScreen) {
        hideSticker([...active.keys()][0], 0);
      }

      const node = buildSticker({ id, url, size, animation, point, payload });
      layer.appendChild(node);
      active.set(id, { node, x: point.x, y: point.y, timer: null });

      const entry = active.get(id);
      entry.timer = window.setTimeout(() => hideSticker(id), seconds * 1000);
    }

    function buildSticker({ id, url, size, animation, point, payload }) {
      const node = document.createElement('div');
      node.className = `sticker sticker--in-${animation}`;
      node.dataset.stickerId = id;
      node.style.setProperty('--x', `${point.x}%`);
      node.style.setProperty('--y', `${point.y}%`);
      node.style.setProperty('--size', `${size}px`);
      node.style.setProperty('--in-duration', `${IN_DURATION_MS}ms`);
      node.style.setProperty('--out-duration', `${OUT_DURATION_MS}ms`);
      // Стикер слева влетает слева, справа — справа; так вход всегда идёт из-за края.
      node.style.setProperty('--slide-from', `${point.x < 50 ? -70 : 70}vw`);
      node.style.setProperty('--slide-tilt', `${point.x < 50 ? -12 : 12}deg`);
      node.style.setProperty('--fly-from-x', `${point.x < 50 ? -30 : 30}vw`);

      const anim = document.createElement('div');
      anim.className = 'sticker__anim';

      const float = document.createElement('div');
      float.className = 'sticker__float';

      if (payload.burst !== false) {
        const burst = document.createElement('span');
        burst.className = 'sticker__burst';
        float.appendChild(burst);
      }

      float.appendChild(createMedia(url, payload.loop !== false));

      const caption = document.createElement('span');
      caption.className = 'sticker__caption';
      caption.textContent = settings.showUser ? String(payload.username || '') : '';
      float.appendChild(caption);

      anim.appendChild(float);
      node.appendChild(anim);
      return node;
    }

    // Видео для .mp4/.webm, картинка для остального (png/gif/webp/apng).
    function createMedia(url, loop) {
      const clean = String(url).split('?')[0].toLowerCase();

      if (clean.endsWith('.mp4') || clean.endsWith('.webm')) {
        const video = document.createElement('video');
        video.className = 'sticker__media';
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.loop = loop;
        video.src = url;
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
        return video;
      }

      const image = document.createElement('img');
      image.className = 'sticker__media';
      image.alt = '';
      image.src = url;
      return image;
    }

    function hideSticker(id, delayMs = 0) {
      const entry = active.get(id);
      if (!entry) {
        return;
      }

      active.delete(id);
      window.clearTimeout(entry.timer);

      const remove = () => {
        entry.node.classList.add('sticker--out');
        window.setTimeout(() => entry.node.remove(), OUT_DURATION_MS + 60);
      };

      if (delayMs > 0) {
        window.setTimeout(remove, delayMs);
      } else {
        remove();
      }
    }

    function clearStickers() {
      [...active.keys()].forEach((id) => hideSticker(id));
    }

    function resolveAnimation(animation) {
      const name = String(animation || 'random').toLowerCase();
      if (ANIMATIONS.includes(name)) {
        return name;
      }

      return ANIMATIONS[Math.floor(Math.random() * ANIMATIONS.length)];
    }

    function resolvePoint(position) {
      const fixed = FIXED_POSITIONS[String(position || '').toLowerCase()];
      if (fixed) {
        return { x: fixed[0], y: fixed[1] };
      }

      return randomPoint();
    }

    // Случайная точка в безопасной зоне, по возможности подальше от уже висящих.
    function randomPoint() {
      const points = [...active.values()];
      let best = null;
      let bestDistance = -1;

      for (let attempt = 0; attempt < 14; attempt += 1) {
        const candidate = {
          x: 14 + Math.random() * 72,
          y: 16 + Math.random() * 68,
        };

        if (!points.length) {
          return candidate;
        }

        const distance = Math.min(...points.map((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y)));
        if (distance > bestDistance) {
          bestDistance = distance;
          best = candidate;
        }

        if (distance >= 26) {
          return candidate;
        }
      }

      return best;
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    return { showSticker, clearStickers, getActiveCount: () => active.size };
  }

  window.TChatStickers = { mount };
})();
