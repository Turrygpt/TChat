(() => {
  const palettes = [
    ['#ff277d', '#7c3cff'],
    ['#ff4b5f', '#ff9b38'],
    ['#6d5cff', '#23c6ff'],
    ['#ff3eb5', '#8f48ff'],
    ['#32c8ff', '#4776ff'],
  ];
  const mountedLayers = new WeakSet();

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function createLike(layer) {
    const particle = document.createElement('div');
    const [colorA, colorB] = palettes[Math.floor(Math.random() * palettes.length)];
    const size = random(58, 118);
    const duration = random(3.2, 4.8);
    const startX = random(4, 90);
    const startY = random(48, 90);
    const maxLift = Math.max(window.innerHeight * (startY / 100) - 40, 220);

    particle.className = 'vk-like';
    particle.style.setProperty('--like-size', `${size}px`);
    particle.style.setProperty('--like-color-a', colorA);
    particle.style.setProperty('--like-color-b', colorB);
    particle.style.setProperty('--like-x', `${startX}vw`);
    particle.style.setProperty('--like-y', `${startY}vh`);
    const drift = random(-115, 115);
    const spin = random(-18, 18);
    particle.style.setProperty('--like-drift', `${drift}px`);
    particle.style.setProperty('--like-drift-end', `${drift * 1.4}px`);
    particle.style.setProperty('--like-lift', `${random(Math.min(250, maxLift), maxLift)}px`);
    particle.style.setProperty('--like-spin', `${spin}deg`);
    particle.style.setProperty('--like-spin-end', `${spin * 2}deg`);
    particle.style.setProperty('--like-duration', `${duration}s`);
    particle.innerHTML = `
      <span class="vk-like__halo"></span>
      <span class="vk-like__heart">
        <svg viewBox="0 0 100 92" aria-hidden="true">
          <path d="M50 88C43 80 10 61 5 36 1 16 13 3 29 3c10 0 18 5 21 13C54 8 62 3 72 3c16 0 28 13 24 33-5 25-38 44-46 52Z"/>
          <path d="M22 13c-8 5-11 15-7 25 2 5 6 8 9 10-4-14 1-27 15-34-5-4-11-4-17-1Z"/>
        </svg>
      </span>
      <i class="vk-like__spark"></i><i class="vk-like__spark"></i><i class="vk-like__spark"></i>
      <i class="vk-like__spark"></i><i class="vk-like__spark"></i><i class="vk-like__spark"></i>
    `;
    layer.appendChild(particle);

    const remove = () => particle.remove();
    particle.addEventListener('animationend', (event) => {
      if (event.animationName === 'vk-like-flight') remove();
    }, { once: true });
    setTimeout(remove, (duration + 0.5) * 1000);
  }

  function burst(layer, amount = 1) {
    const count = Math.min(Math.max(Math.round(Number(amount) || 1), 1), 30);
    for (let index = 0; index < count; index += 1) {
      setTimeout(() => createLike(layer), index * random(85, 190));
    }
  }

  function mount({ socket, layer } = {}) {
    if (!socket || !layer || mountedLayers.has(layer)) return;
    mountedLayers.add(layer);
    socket.on('vk:likes', (payload = {}) => burst(layer, payload.count));

    const demoCount = Number(new URLSearchParams(window.location.search).get('demo') || 0);
    if (demoCount > 0) setTimeout(() => burst(layer, demoCount), 450);
  }

  window.TChatVkLikes = { mount, burst };
})();
