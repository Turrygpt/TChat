/* Shared by the transparent OBS source and the combined stream overlay. */
window.TChatSubscriberGoals = {
  mount({ socket, layer, standalone = false }) {
    const filterId = standalone ? new URLSearchParams(location.search).get('id') : null;
    const nodes = new Map();
    const timers = new Set();
    let audio;
    function cancel(timer) { if (timer != null) { clearTimeout(timer); timers.delete(timer); } }
    function scheduleMotivation(entry) {
      const widget = entry.widget;
      const interval = Math.max(15, Math.min(3600, Number(widget.motivationIntervalSeconds) || 300));
      const key = `${widget.motivationEnabled !== false}:${interval}:${widget.current >= widget.target}`;
      if (entry.motivationKey === key) return;
      entry.motivationKey = key;
      cancel(entry.motivationTimer);
      entry.node.classList.remove('is-motivating');
      if (widget.motivationEnabled === false || widget.current >= widget.target) return;
      const tick = () => {
        if (nodes.get(widget.id) !== entry) return;
        if (Date.now() >= (entry.busyUntil || 0)) {
          const messages = ['Подпишись! Приблизим цель вместе 👍', 'Твоя подписка — ещё один шаг к цели ✨', 'Поддержи стрим подпиской! 💜'];
          entry.node.querySelector('.subscriber-goal__motivation').textContent = messages[(entry.motivationIndex || 0) % messages.length];
          entry.motivationIndex = (entry.motivationIndex || 0) + 1;
          entry.node.classList.add('is-motivating');
          later(() => entry.node.classList.remove('is-motivating'), 6000);
        }
        entry.motivationTimer = later(tick, interval * 1000);
      };
      entry.motivationTimer = later(tick, interval * 1000);
    }
    function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
    function melody() {
      try {
        audio ||= new (window.AudioContext || window.webkitAudioContext)();
        audio.resume().then(() => {
          [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.51].forEach((hz, i) => {
            const start = audio.currentTime + i * 0.13;
            const oscillator = audio.createOscillator(); const gain = audio.createGain();
            oscillator.type = 'square'; oscillator.frequency.value = hz;
            gain.gain.setValueAtTime(0.035, start); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.23);
            oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(start); oscillator.stop(start + 0.24);
          });
        }).catch(() => {});
      } catch (_) { /* Audio unavailable: keep the visual celebration. */ }
    }
    function render(state = {}) {
      const items = (state.items || []).filter(w => w.type === 'subscriber-goal' && w.enabled !== false && (!filterId || w.id === filterId));
      const keep = new Set(items.map(w => w.id));
      for (const [id, entry] of nodes) if (!keep.has(id)) { cancel(entry.motivationTimer); entry.node.remove(); nodes.delete(id); }
      for (const widget of items) {
        let entry = nodes.get(widget.id);
        if (!entry) {
          const node = document.createElement('article'); node.className = 'subscriber-goal';
          node.innerHTML = '<div class="subscriber-goal__head"><span class="subscriber-goal__icon">★</span><strong class="subscriber-goal__title"></strong><span class="subscriber-goal__count"></span></div><div class="subscriber-goal__track"><div class="subscriber-goal__fill"></div></div><div class="subscriber-goal__bottom"><span class="subscriber-goal__reward"></span></div><div class="subscriber-goal__footer"><strong class="subscriber-goal__remaining"></strong><span class="subscriber-goal__status"></span></div><div class="subscriber-goal__motivation" aria-live="polite"></div><div class="subscriber-goal__reaction" aria-hidden="true"></div><div class="subscriber-goal__new" aria-live="polite"></div><div class="subscriber-goal__effects"></div>';
          layer.append(node); entry = { node }; nodes.set(widget.id, entry);
        }
        const node = entry.node; entry.widget = widget;
        node.style.cssText = standalone ? 'position:relative;width:100%;box-sizing:border-box;' : `left:${Number(widget.x)}%;top:${Number(widget.y)}%;width:${Number(widget.width)}%;scale:${Number(widget.scale) || 1};transform-origin:top left;`;
        node.querySelector('.subscriber-goal__title').textContent = widget.title;
        node.querySelector('.subscriber-goal__count').textContent = `${widget.current} / ${widget.target}`;
        node.querySelector('.subscriber-goal__remaining').textContent = `Осталось подписок: ${Math.max(0, widget.target - widget.current)}`;
        node.querySelector('.subscriber-goal__reward').textContent = widget.reward;
        node.querySelector('.subscriber-goal__status').textContent = widget.current >= widget.target ? 'Цель достигнута! 🎉' : '';
        node.querySelector('.subscriber-goal__fill').style.width = `${Math.min(100, widget.current / widget.target * 100)}%`;
        node.classList.toggle('is-complete', widget.current >= widget.target);
        scheduleMotivation(entry);
      }
    }
    function increment(changes = []) {
      for (const change of changes) {
        const entry = nodes.get(change.id); if (!entry) continue;
        const node = entry.node;
        entry.busyUntil = Date.now() + 6500;
        node.classList.remove('is-motivating');
        const reaction = node.querySelector('.subscriber-goal__reaction');
        reaction.replaceChildren();
        const like = document.createElement('span'); like.className = 'subscriber-goal__like'; like.textContent = '👍';
        reaction.append(like);
        for (let i = 0; i < 7; i++) {
          const heart = document.createElement('span'); heart.className = 'subscriber-goal__heart'; heart.textContent = i % 2 ? '✨' : '💜';
          heart.style.cssText = `--dx:${(i - 3) * 32}px;--delay:${i * 0.06}s;`;
          reaction.append(heart);
        }
        later(() => { if (reaction.children[0] === like) reaction.replaceChildren(); }, 2500);
        node.classList.remove('is-bumping'); void node.offsetWidth; node.classList.add('is-bumping');
        const notice = node.querySelector('.subscriber-goal__new');
        notice.textContent = `+1 · ${change.username || 'Зритель'} · Спасибо за подписку!`;
        const serial = (entry.serial || 0) + 1; entry.serial = serial;
        later(() => { if (entry.serial === serial) { notice.textContent = ''; node.classList.remove('is-bumping'); } }, 4200);
        if (change.reached) {
          const effects = node.querySelector('.subscriber-goal__effects');
          for (let i = 0; i < 80; i++) {
            const spark = document.createElement('i'); spark.className = 'subscriber-goal__spark';
            const angle = Math.random() * Math.PI * 2, distance = 90 + Math.random() * 230;
            spark.style.cssText = `--dx:${Math.cos(angle) * distance}px;--dy:${Math.sin(angle) * distance}px;--delay:${Math.random() * 0.7}s;background:hsl(${Math.random() * 360} 95% 65%);left:${20 + Math.random() * 60}%;top:${20 + Math.random() * 50}%;`;
            effects.append(spark); later(() => spark.remove(), 3000);
          }
          if (entry.widget.sound) melody();
        }
      }
    }
    // Join the state stream before fetching to avoid losing early updates.
    let received = false;
    let generation = 0;
    let disposed = false;
    const onState = state => { received = true; generation++; render(state); };
    socket.on('widgets:state', onState);
    socket.on('subscriber-goal:increment', increment);
    const onConnect = () => {
      const before = generation;
      fetch('/widgets/state').then(r => r.json()).then(state => { if (!disposed && before === generation) render(state); }).catch(() => {});
    };
    socket.on('connect', onConnect);
    fetch('/widgets/state').then(r => r.json()).then(state => { if (!disposed && !received) render(state); }).catch(() => {});
    return { render, destroy() { disposed = true; socket.off('connect', onConnect); socket.off('widgets:state', onState); socket.off('subscriber-goal:increment', increment); for (const t of timers) clearTimeout(t); layer.replaceChildren(); audio?.close(); } };
  }
};
