(() => {
  const stage = document.createElement('div');
  stage.className = 'chibi-stage'; stage.setAttribute('aria-live', 'polite'); document.body.append(stage);
  const socket = io();
  const queue = [], seen = new Set();
  let catalog = [], active = false, timer, exitTimer, cleanupTimer;
  function place(guest) {
    const content = guest.querySelector('.chibi-content');
    const width = stage.clientWidth, height = stage.clientHeight;
    const margin = Math.min(20, width / 20, height / 20);
    const scale = Math.min(1, (width - 2 * margin) / content.offsetWidth, (height - 2 * margin) / content.offsetHeight);
    const freeX = Math.max(0, width - 2 * margin - content.offsetWidth * scale);
    const freeY = Math.max(0, height - 2 * margin - content.offsetHeight * scale);
    const avatarSize = content.querySelector('.chibi-avatar').offsetWidth * scale;
    const anchor = Number(guest.dataset.anchor);
    const side = guest.dataset.side;
    guest.style.setProperty('--fit', scale);
    guest.style.left = `${side === 'left' ? -avatarSize * .36
      : side === 'right' ? width - content.offsetWidth * scale + avatarSize * .36
        : margin + freeX * anchor}px`;
    guest.style.top = `${side === 'top' ? -avatarSize * .3
      : side === 'bottom' ? height - avatarSize * .8
        : margin + freeY * anchor}px`;
  }
  window.addEventListener('resize', () => stage.querySelectorAll('.chibi-guest').forEach(place));
  function clear() { clearTimeout(timer); clearTimeout(exitTimer); clearTimeout(cleanupTimer); queue.length = 0; active = false; stage.replaceChildren(); }
  function next() {
    if (active || !queue.length || !catalog.length) return;
    const item = queue.shift();
    const character = catalog.find(c => c.id === item.character) || catalog[0];
    active = true;
    const guest = document.createElement('article'); guest.className = 'chibi-guest';
    const content = document.createElement('div'); content.className = 'chibi-content';
    guest.dataset.anchor = Number.isFinite(item.anchor) ? Math.min(1, Math.max(0, item.anchor)) : Math.random();
    guest.dataset.side = ['left','right','top','bottom'].includes(item.position) ? item.position : 'bottom';
    guest.style.setProperty('--chibi-accent', character.color);
    const seconds = Math.min(30, Math.max(3, Number(item.seconds) || 8));
    guest.style.setProperty('--chibi-duration', `${seconds}s`);
    const avatar = document.createElement('div'); avatar.className = 'chibi-avatar';
    // Every layer shares a square canvas: body -> outfit -> hat, for future wardrobes.
    for (const layer of ['body', 'outfit', 'hat']) {
      if (!character.layers[layer]) continue;
      const img = document.createElement('img'); img.src = character.layers[layer]; img.alt = layer === 'body' ? character.name : ''; avatar.append(img);
    }
    const bubble = document.createElement('div'); bubble.className = 'chibi-bubble';
    const name = document.createElement('strong'); name.className = 'chibi-name'; name.textContent = String(item.username || 'Зритель').slice(0,80);
    const message = document.createElement('p'); message.className = 'chibi-text'; message.textContent = String(item.message || '').slice(0,400);
    const progress = document.createElement('div'); progress.className = 'chibi-timer';
    bubble.append(name, message, progress); content.append(avatar, bubble); guest.append(content); stage.append(guest);
    place(guest);
    // Fade the bubble at a fixed screen position. Hide it before moving only the avatar.
    timer = setTimeout(() => {
      guest.classList.add('is-leaving');
      exitTimer = setTimeout(() => {
        bubble.style.visibility = 'hidden';
        guest.classList.add('is-retreating');
        cleanupTimer = setTimeout(() => { guest.remove(); active = false; next(); }, 500);
      }, 450);
    }, seconds * 1000);
  }
  socket.on('chibi:show', item => {
    if (!item || (item.id && seen.has(item.id))) return;
    if (item.id) { seen.add(item.id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
    if (queue.length < 30) queue.push(item); next();
  });
  socket.on('chibi:clear', clear);
  socket.on('chibis:settings', settings => { if (!settings.enabled) clear(); });
  async function load() {
    try {
      const response = await fetch('/chibis/state'); if (!response.ok) throw new Error('state');
      catalog = (await response.json()).catalog;
      await Promise.all(catalog.flatMap(c => Object.values(c.layers).filter(Boolean)).map(src => new Promise(resolve => {
        const img = new Image(); img.onload = img.onerror = resolve; img.src = src;
      })));
      next();
    } catch (error) { console.warn('Чибики: каталог пока недоступен', error); }
  }
  socket.on('connect', load);
  if (new URLSearchParams(location.search).has('preview')) {
    document.body.style.background = 'radial-gradient(ellipse at 40% 60%, #293447, #0e1320)';
    load().then(() => {
      let index = 0;
      const sides = ['left', 'top', 'right', 'bottom'];
      const previewSide = new URLSearchParams(location.search).get('side');
      const demo = () => {
        if (!catalog.length) return;
        queue.push({ character: catalog[index % catalog.length].id, username: 'TurryFan',
          message: 'Чат, вы невероятные! Спасибо за уютный стрим ✨',
          position: sides.includes(previewSide) ? previewSide : sides[index % sides.length], seconds: 6 });
        index++; next();
      };
      demo(); setInterval(demo, 8000);
    });
  }
})();
