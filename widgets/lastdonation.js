const socket = io();

const els = {
  root: document.querySelector('#lastdonRoot'),
  card: document.querySelector('#lastdonCard'),
  fx: document.querySelector('#lastdonFx'),
  title: document.querySelector('#lastdonTitle'),
  timer: document.querySelector('#lastdonTimer'),
  name: document.querySelector('#lastdonName'),
  amount: document.querySelector('#lastdonAmount'),
  prize: document.querySelector('#lastdonPrize'),
  barFill: document.querySelector('#lastdonBarFill'),
  barSpark: document.querySelector('#lastdonBarSpark'),
  total: document.querySelector('#lastdonTotal'),
  next: document.querySelector('#lastdonNext'),
  tiers: document.querySelector('#lastdonTiers'),
  top: document.querySelector('#lastdonTop'),
  topLockText: document.querySelector('#lastdonTopLockText'),
  tease: document.querySelector('#lastdonTease'),
  burst: document.querySelector('#lastdonBurst'),
  burstPrize: document.querySelector('#lastdonBurstPrize'),
  burstWinner: document.querySelector('#lastdonBurstWinner'),
};

const state = {
  data: null,
  lastLeaderKey: '',
  // Часы стрима идут от локального времени, но сдвинутого на разницу с сервером:
  // OBS-машина и сервер могут расходиться на минуты, и без сдвига таймер врёт.
  clockOffsetMs: 0,
  displayedProgress: 0,
  targetProgress: 0,
  topUnlocked: false,
};

const TEASE_INTERVAL_MS = 60000;

if (new URLSearchParams(window.location.search).get('embedded') === '1') {
  document.body.classList.add('is-embedded');
}

fetch('/lastdonation/state')
  .then((response) => response.json())
  .then(applyState)
  .catch(() => {});

socket.on('lastdonation:update', applyState);
socket.on('lastdonation:tier', ({ tier, donation } = {}) => {
  if (tier) celebrateTier(tier, donation);
});

function applyState(payload = {}) {
  state.data = payload;

  if (payload.serverNow) {
    state.clockOffsetMs = new Date(payload.serverNow).getTime() - Date.now();
  }

  els.root.classList.toggle('lastdon--off', payload.enabled === false);
  els.title.textContent = payload.title || 'Последний донат';

  renderLeader(payload);
  renderTiers(payload);
  renderTopPrizes(payload);
  renderTotals(payload);
  state.targetProgress = Number(payload.progress || 0);
  renderTimer();
}

function renderLeader(payload) {
  const leader = payload.leaders?.[0];
  const key = leader ? `${leader.username}:${leader.at}` : '';
  const mainPrize = payload.topPrizes?.[0]?.title || '';

  els.name.textContent = leader ? leader.username : 'Ждём донат';
  els.amount.textContent = leader ? `${formatMoney(leader.amount)} ${payload.currency || 'RUB'}` : '';
  els.prize.textContent = payload.topUnlocked
    ? leader?.prize || mainPrize
    : `главный приз откроется через ${payload.lockedTiers} ${pluralTiers(payload.lockedTiers)}`;

  if (key && key !== state.lastLeaderKey) {
    if (state.lastLeaderKey) pulseLeader();
    state.lastLeaderKey = key;
  }
}

function renderTotals(payload) {
  const currency = payload.currency || 'RUB';
  els.total.textContent = `${formatMoney(payload.total || 0)} ${currency}`;
  els.next.textContent = payload.nextTier
    ? `до «${payload.nextTier.title}» — ${formatMoney(payload.remainingToTier || 0)} ${currency}`
    : 'все ступени пробиты';
}

function renderTiers(payload) {
  els.tiers.innerHTML = '';

  (payload.tiers || []).forEach((tier) => {
    const isNext = payload.nextTier?.id === tier.id;
    const item = document.createElement('li');
    item.className = 'lastdon-tier';
    if (tier.winner) item.classList.add('lastdon-tier--done');
    if (isNext) item.classList.add('lastdon-tier--next');
    item.dataset.tierId = tier.id;

    const amount = document.createElement('span');
    amount.className = 'lastdon-tier__amount';
    amount.textContent = formatCompact(tier.amount);

    const title = document.createElement('span');
    title.className = 'lastdon-tier__title';
    title.textContent = tier.title;

    const winner = document.createElement('span');
    winner.className = 'lastdon-tier__winner';
    winner.textContent = tier.winner ? tier.winner.username : '';

    item.append(amount, title, winner);
    els.tiers.append(item);
  });
}

function renderTopPrizes(payload) {
  const unlocked = Boolean(payload.topUnlocked);

  els.root.classList.toggle('lastdon--top-open', unlocked);
  els.topLockText.textContent = unlocked
    ? 'открыто'
    : `ещё ${payload.lockedTiers} ${pluralTiers(payload.lockedTiers)}`;

  // Момент открытия топ-призов — второй по значимости после пробития ступени:
  // подсвечиваем блок и пускаем салют, чтобы зритель не пропустил.
  if (unlocked && !state.topUnlocked && state.lastLeaderKey) {
    els.root.classList.add('lastdon--top-unlocking');
    window.setTimeout(() => els.root.classList.remove('lastdon--top-unlocking'), 2400);
    window.setTimeout(fireSalute, 200);
  }
  state.topUnlocked = unlocked;

  els.top.innerHTML = '';

  (payload.topPrizes || []).forEach((prize) => {
    const leader = payload.leaders?.find((entry) => entry.place === prize.place);
    const item = document.createElement('li');
    item.className = `lastdon-top lastdon-top--${prize.place}`;
    if (!unlocked) item.classList.add('lastdon-top--locked');

    const place = document.createElement('span');
    place.className = 'lastdon-top__place';
    place.textContent = prize.place;

    const title = document.createElement('span');
    title.className = 'lastdon-top__title';
    title.textContent = prize.title;

    const holder = document.createElement('span');
    holder.className = 'lastdon-top__holder';
    holder.textContent = leader ? leader.username : '—';

    item.append(place, title, holder);
    els.top.append(item);
  });
}

// --- часы стрима ------------------------------------------------------------

function renderTimer() {
  const data = state.data;
  if (!data?.streamEndsAt) {
    els.timer.textContent = data?.streamMinutes ? `${data.streamMinutes} мин` : '--:--:--';
    els.timer.classList.remove('lastdon__timer--soon', 'lastdon__timer--over');
    return;
  }

  const leftMs = new Date(data.streamEndsAt).getTime() - (Date.now() + state.clockOffsetMs);
  const over = leftMs <= 0 || data.finished;

  els.timer.textContent = over ? 'стрим завершён' : formatClock(leftMs);
  els.timer.classList.toggle('lastdon__timer--over', over);
  els.timer.classList.toggle('lastdon__timer--soon', !over && leftMs < 10 * 60000);
}

window.setInterval(renderTimer, 1000);

// --- подогрев внимания ------------------------------------------------------

// Раз в минуту главный приз коротко «дышит» и подписывается текстом: зритель,
// зашедший в середине стрима, должен без объяснений понять, что последний
// донат забирает топ-приз. Пока прогрессия не пройдена, текст честно говорит,
// что приз ещё заперт, — иначе подогрев обещает то, чего пока нельзя выиграть.
function teaseMainPrize() {
  const data = state.data;
  if (!data || data.enabled === false || data.finished) {
    return;
  }

  const mainPrize = data.topPrizes?.[0]?.title;
  if (!mainPrize) {
    return;
  }

  const row = els.top.querySelector('.lastdon-top--1');
  if (row) {
    row.classList.remove('lastdon-top--tease');
    void row.offsetWidth;
    row.classList.add('lastdon-top--tease');
    window.setTimeout(() => row.classList.remove('lastdon-top--tease'), 2600);
  }

  els.tease.textContent = state.topUnlocked
    ? `${mainPrize} забирает последний задонативший от ${formatMoney(data.minAmount)} ${data.currency || 'RUB'}`
    : `${mainPrize} за последний донат — откроется после всей прогрессии`;
  els.tease.classList.add('lastdon__tease--show');
  window.setTimeout(() => els.tease.classList.remove('lastdon__tease--show'), 6000);
}

window.setInterval(teaseMainPrize, TEASE_INTERVAL_MS);

// --- эффекты ----------------------------------------------------------------

function pulseLeader() {
  els.card.classList.remove('lastdon__card--pulse');
  void els.card.offsetWidth;
  els.card.classList.add('lastdon__card--pulse');
  window.setTimeout(() => els.card.classList.remove('lastdon__card--pulse'), 1000);

  const rect = els.card.getBoundingClientRect();
  spawnCoins(rect.width * 0.28, rect.height * 0.36);
}

function celebrateTier(tier, donation) {
  els.burstPrize.textContent = tier.title;
  els.burstWinner.textContent = donation?.username ? `забрал ${donation.username}` : '';
  els.burst.hidden = false;
  els.burst.classList.remove('lastdon__burst--show');
  void els.burst.offsetWidth;
  els.burst.classList.add('lastdon__burst--show');

  els.root.classList.add('lastdon--flash');
  window.setTimeout(() => els.root.classList.remove('lastdon--flash'), 700);

  const row = els.tiers.querySelector(`[data-tier-id="${tier.id}"]`);
  if (row) {
    row.classList.add('lastdon-tier--hit');
    window.setTimeout(() => row.classList.remove('lastdon-tier--hit'), 1600);
  }

  fireSalute();

  window.setTimeout(() => {
    els.burst.classList.remove('lastdon__burst--show');
    window.setTimeout(() => {
      els.burst.hidden = true;
    }, 500);
  }, 5200);
}

// Салют: несколько разлётов с задержкой, чтобы читалось как залп, а не как
// один хлопок. Частицы живут в общем цикле requestAnimationFrame ниже.
function fireSalute() {
  const { width, height } = canvasSize();
  const shots = [
    { x: width * 0.2, y: height * 0.3, delay: 0 },
    { x: width * 0.78, y: height * 0.24, delay: 260 },
    { x: width * 0.5, y: height * 0.42, delay: 520 },
    { x: width * 0.32, y: height * 0.18, delay: 900 },
  ];

  shots.forEach((shot) => {
    window.setTimeout(() => spawnFirework(shot.x, shot.y), shot.delay);
  });

  window.setTimeout(() => spawnConfetti(), 120);
}

const ctx = els.fx.getContext('2d');
const particles = [];
const PALETTE = ['#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#4ade80', '#ffffff'];

function canvasSize() {
  return { width: els.fx.clientWidth, height: els.fx.clientHeight };
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  els.fx.width = els.fx.clientWidth * ratio;
  els.fx.height = els.fx.clientHeight * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function spawnFirework(x, y) {
  const color = pick(PALETTE);
  const count = 46;

  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.12;
    const speed = 1.6 + Math.random() * 3.4;
    particles.push({
      kind: 'spark',
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.012 + Math.random() * 0.012,
      size: 1.6 + Math.random() * 2.2,
      color: Math.random() < 0.25 ? '#ffffff' : color,
    });
  }
}

function spawnConfetti() {
  const { width } = canvasSize();

  for (let i = 0; i < 70; i += 1) {
    particles.push({
      kind: 'confetti',
      x: Math.random() * width,
      y: -20 - Math.random() * 120,
      vx: (Math.random() - 0.5) * 1.4,
      vy: 1.4 + Math.random() * 2.2,
      life: 1,
      decay: 0.004 + Math.random() * 0.004,
      size: 3 + Math.random() * 4,
      spin: (Math.random() - 0.5) * 0.3,
      angle: Math.random() * Math.PI,
      color: pick(PALETTE),
    });
  }
}

function spawnCoins(x, y) {
  for (let i = 0; i < 18; i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
    const speed = 2 + Math.random() * 2.6;
    particles.push({
      kind: 'coin',
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.014 + Math.random() * 0.01,
      size: 2.4 + Math.random() * 2.6,
      color: Math.random() < 0.4 ? '#ffffff' : '#fbbf24',
    });
  }
}

function drawParticles() {
  const { width, height } = canvasSize();
  ctx.clearRect(0, 0, width, height);

  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.kind === 'confetti' ? 0.02 : 0.075;
    p.vx *= 0.99;
    p.life -= p.decay;

    if (p.life <= 0 || p.y > height + 40) {
      particles.splice(i, 1);
      continue;
    }

    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.fillStyle = p.color;

    if (p.kind === 'confetti') {
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
      ctx.restore();
      continue;
    }

    ctx.shadowBlur = 12;
    ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  ctx.globalAlpha = 1;
}

// Полоска догоняет цель плавно: резкий скачок ширины на пробитии смотрится
// дёшево, а плавный доезд синхронизируется с салютом.
function animateBar() {
  const delta = state.targetProgress - state.displayedProgress;
  if (Math.abs(delta) > 0.001) {
    state.displayedProgress += delta * 0.12;
    const percent = Math.min(Math.max(state.displayedProgress, 0), 1) * 100;
    els.barFill.style.width = `${percent}%`;
    els.barSpark.style.left = `${percent}%`;
    els.barSpark.style.opacity = percent > 1 ? '1' : '0';
  }
}

function tick() {
  animateBar();
  if (particles.length) drawParticles();
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// --- утилиты ----------------------------------------------------------------

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function pluralTiers(count) {
  const value = Math.abs(Number(count || 0)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return 'ступеней';
  if (last === 1) return 'ступень';
  if (last >= 2 && last <= 4) return 'ступени';
  return 'ступеней';
}

function formatCompact(value) {
  const number = Number(value || 0);
  return number >= 1000 ? `${Math.round(number / 100) / 10}K` : String(number);
}
