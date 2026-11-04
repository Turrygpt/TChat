(() => {
  const flightMs = 1120;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const tiers = [
    { min: 0, name: 'simple', color: '#f7ca78', sparks: 9, rings: 0, radius: 38, trails: 3, puff: 5, flip: 360, swell: 1.22, sound: 'soft' },
    { min: 500, name: 'bright', color: '#54efd9', sparks: 19, rings: 1, radius: 66, trails: 7, puff: 9, flip: 360, swell: 1.33, sound: '' },
    { min: 1000, name: 'rare', color: '#cb9bff', sparks: 33, rings: 2, radius: 105, trails: 11, puff: 14, flip: 360, swell: 1.42, sound: 'rare' },
    { min: 2500, name: 'grand', color: '#ffd772', sparks: 52, rings: 3, radius: 155, trails: 16, puff: 20, flip: 720, swell: 1.52, sound: 'grand' },
  ];
  let obsVisible = true;
  let obsActive = true;
  let lastSoundAt = -Infinity;
  let layer;

  window.addEventListener('obsSourceVisibleChanged', (event) => { obsVisible = event.detail?.visible !== false; });
  window.addEventListener('obsSourceActiveChanged', (event) => { obsActive = event.detail?.active !== false; });

  function sprite(className, x, y, tier, text = '') {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'goal-effect-layer';
      layer.setAttribute('aria-hidden', 'true');
      document.body.append(layer);
    }
    const element = document.createElement('span');
    element.className = `${className} goal-effect--${tier.name}`;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.textContent = text;
    layer.append(element);
    return element;
  }

  function animateSprite(element, frames, options) {
    const animation = element.animate(frames, options);
    return animation.finished.catch(() => {}).finally(() => element.remove());
  }

  function playSound(tier) {
    if (!obsVisible || !obsActive || performance.now() - lastSoundAt < 260) return;
    lastSoundAt = performance.now();
    const suffix = tier.sound ? `-${tier.sound}` : '';
    const audio = new Audio(`/assets/alerts/defaults/goal-deposit${suffix}.wav?v=3`);
    audio.volume = 0.48;
    audio.play().catch(() => {});
  }

  function ring(x, y, tier, scale, delay = 0) {
    void animateSprite(sprite('goal-effect-ring', x, y, tier), [
      { transform: 'translate(-50%, -50%) scale(.38)', opacity: .85 },
      { transform: `translate(-50%, -50%) scale(${scale})`, opacity: 0 },
    ], { delay, duration: 450 + scale * 66, easing: 'ease-out' });
  }

  function burst(x, y, tier, count, reach, gravity) {
    for (let index = 0; index < count; index += 1) {
      const angle = index * 2.399963;
      const radius = reach * (.42 + (index % 7) * .11);
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      const spark = sprite('goal-effect-spark', x, y, tier);
      if (index % 3 === 0) spark.classList.add('goal-effect-spark--accent');
      if (index % 5 === 0) spark.classList.add('goal-effect-spark--star');
      else if (index % 3 === 1) spark.classList.add('goal-effect-spark--ember');
      void animateSprite(spark, [
        { transform: 'translate(-50%, -50%) scale(.6)', opacity: .95, easing: 'cubic-bezier(.16,.75,.26,1)' },
        { transform: `translate(${dx * .78}px, ${dy * .76}px) rotate(${index * 23}deg) scale(1.15)`, opacity: .9, offset: .38 },
        { transform: `translate(${dx}px, ${dy + gravity}px) rotate(${index * 36 + 90}deg) scale(.15)`, opacity: 0 },
      ], { duration: 320 + reach * 2.5 + (index % 5) * 80 });
    }
  }

  function impact(track, x, y, tier) {
    const moving = !reducedMotion.matches;
    track.animate([
      { boxShadow: `0 0 ${moving ? tier.radius * .37 : 12}px ${tier.rings}px ${tier.color}`, filter: 'brightness(1.35)' },
      { boxShadow: '0 0 0 0 transparent', filter: 'brightness(1)' },
    ], { duration: 680, easing: 'ease-out' });
    if (!moving) return;

    for (let index = 0; index < tier.rings; index += 1) {
      ring(x, y, tier, 2 + tier.radius / 55 + index * .48, index * 105);
    }
    if (tier.name === 'grand') {
      void animateSprite(sprite('goal-effect-flare', x, y, tier), [
        { transform: 'translate(-50%, -50%) scale(.35) rotate(-14deg)', opacity: .85 },
        { transform: 'translate(-50%, -50%) scale(1.5) rotate(14deg)', opacity: 0 },
      ], { duration: 570, easing: 'ease-out' });
      const bounds = track.getBoundingClientRect();
      const sweep = sprite('goal-effect-sweep', bounds.left, bounds.top, tier);
      sweep.style.width = `${bounds.width}px`;
      sweep.style.height = `${bounds.height}px`;
      void animateSprite(sweep, [
        { clipPath: 'inset(0 96% 0 0 round 999px)', opacity: .3 },
        { clipPath: 'inset(0 44% 0 23% round 999px)', opacity: .9, offset: .45 },
        { clipPath: 'inset(0 0 0 95% round 999px)', opacity: 0 },
      ], { duration: 780, easing: 'ease-out' });
    }
    burst(x, y, tier, tier.sparks, tier.radius, 22 + tier.radius * .47);
  }

  function play({ track, amount, currency, percent, sound, onImpact }) {
    if (!track || !obsVisible || !obsActive || document.hidden) return false;
    const rect = track.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight ||
        rect.right <= 0 || rect.left >= window.innerWidth) return false;

    const x = Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width * percent / 100));
    const y = rect.top + rect.height / 2;
    const tier = tiers.findLast((preset) => amount >= preset.min) || tiers[0];
    const moving = !reducedMotion.matches;
    const startX = window.innerWidth / 2;
    const startY = window.innerHeight / 2;
    const dx = startX - x;
    const dy = startY - y;
    const arc = Math.min(64, Math.hypot(dx, dy) * .28);
    const bend = dx < 0 ? -arc : arc;
    const center = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const midpoint = `translate(calc(-50% + ${dx * .5 + bend}px), calc(-50% + ${dy * .5}px))`;
    const approach = `translate(calc(-50% + ${dx * .12}px), calc(-50% + ${dy * .12}px))`;
    const finish = 'translate(-50%, -50%)';
    const token = sprite('goal-effect-token', x, y, tier);
    const turn = document.createElement('span');
    turn.className = 'goal-effect-turn';
    const face = document.createElement('span');
    face.className = 'goal-effect-face';
    face.textContent = `+${money.format(amount)} ${currency}`;
    const reverse = document.createElement('span');
    reverse.className = 'goal-effect-face goal-effect-face--reverse';
    reverse.textContent = '✦';
    turn.append(face, reverse);
    token.append(turn);
    const pose = (translation, tilt, stretch) => `${translation} rotateZ(${tilt}deg) scale(${stretch})`;
    const flight = moving ? [
      { transform: pose(center, 0, '.38, .72'), opacity: .3, easing: 'ease-out' },
      { transform: pose(center, -6, `${tier.swell}, ${tier.swell * .9}`), opacity: 1, offset: .17 },
      { transform: pose(center, 3, '.96, 1.06'), opacity: 1, offset: .32 },
      { transform: pose(midpoint, dx < 0 ? 16 : -16, '1.08, .94'), opacity: 1, offset: .61 },
      { transform: pose(approach, 0, '1.13, .85'), opacity: 1, offset: .86, easing: 'ease-in' },
      { transform: pose(finish, 0, '.35, .12'), opacity: 0 },
    ] : [
      { transform: 'translate(-50%, -140%)', opacity: 1 },
      { transform: 'translate(-50%, -140%)', opacity: 0 },
    ];
    if (moving) {
      turn.animate([
        { transform: 'perspective(580px) rotateY(0deg)', offset: 0 },
        { transform: 'perspective(580px) rotateY(0deg)', offset: .32 },
        { transform: `perspective(580px) rotateY(${tier.flip}deg)`, offset: .86 },
        { transform: `perspective(580px) rotateY(${tier.flip}deg)`, offset: 1 },
      ], { duration: flightMs });
      burst(startX, startY, tier, tier.puff, tier.radius * .62, 12);
      if (tier.name === 'grand') ring(startX, startY, tier, 3.6);
      for (let index = 0; index < tier.trails; index += 1) {
        const drift = ((index % 5) - 2) * 12;
        const trail = sprite('goal-effect-trail', x + drift, y + drift * .42, tier);
        if (index % 4 === 0) trail.classList.add('goal-effect-trail--star');
        void animateSprite(trail, [
          { transform: `${center} scale(.2)`, opacity: 0 },
          { transform: `${center} scale(.64)`, opacity: .5, offset: .32 },
          { transform: `${midpoint} scale(1) rotate(65deg)`, opacity: .86, offset: .61 },
          { transform: `${finish} scale(.2) rotate(150deg)`, opacity: 0 },
        ], { duration: flightMs, delay: 24 + index * 10 });
      }
    }
    if (sound) playSound(tier);
    void animateSprite(token, flight, { duration: flightMs }).then(() => {
      onImpact();
      if (track.isConnected && obsVisible && obsActive && !document.hidden) impact(track, x, y, tier);
    });
    return true;
  }

  window.TChatGoalEffects = { play };
})();
