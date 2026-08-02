const socket = io();
const cardsRoot = document.querySelector('#cards');
const reveal = document.querySelector('#reveal');
const revealImage = document.querySelector('#revealImage');
const particles = document.querySelector('#particles');
const soundEnabled = new URLSearchParams(location.search).get('sound') !== '0';
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
const cardImages = Array.from({ length: 8 }, (_, index) => `/assets/vdv/card-${String(index + 1).padStart(2, '0')}.png?v=3`);
let current = null;
let initialized = false;
let audioContext = null;

document.body.classList.toggle('is-embedded', embedded);

fetch('/vdv/state').then((response) => response.json()).then((data) => applyState(data, false)).catch(() => {});
socket.on('vdv:update', (data) => applyState(data, initialized));

function applyState(data = {}, animate = true) {
  const previous = current;
  current = data;
  document.querySelector('#title').textContent = data.title || 'ДЕНЬ ВДВ';
  document.querySelector('#subtitle').textContent = data.subtitle || 'Никто, кроме нас!';
  document.querySelector('#amount').textContent = `${format(data.amount)} ₽`;
  document.querySelector('#pushups').textContent = format(data.pushups);
  document.querySelector('#squats').textContent = format(data.squats);
  const cycle = Number(data.amount || 0) % 3000;
  const percent = cycle / 30;
  document.querySelector('#progressFill').style.width = `${percent}%`;
  document.querySelector('#runner').style.left = `${percent}%`;
  const nextStep = 1000 - (Number(data.amount || 0) % 1000 || (Number(data.amount || 0) ? 1000 : 0));
  document.querySelector('#nextMilestone').textContent = `До следующего норматива: ${format(nextStep || 1000)} ₽`;
  renderCards(data, previous, animate);
  if (data.revealIndex >= 0) {
    const changed = data.revealIndex !== previous?.revealIndex || data.revision !== previous?.revision;
    showReveal(data.revealIndex, data.challenges[data.revealIndex], animate && changed);
  } else {
    hideReveal();
  }
  if (animate && previous && (data.pushups > previous.pushups || data.squats > previous.squats)) playMilestone();
  initialized = true;
}

function renderCards(data, previous, animate) {
  cardsRoot.innerHTML = data.challenges.map((challenge, index) => {
    const opened = Boolean(data.opened[index]);
    const newlyOpened = animate && opened && !previous?.opened?.[index];
    return `<article class="card${opened ? ' is-open' : ''}${newlyOpened ? ' is-new' : ''}" data-index="${index}" style="--card-image:url('${cardImages[index]}')">
      <div class="card__inner">
        <div class="card__face card__back"><span class="card__number">${String(index + 1).padStart(2, '0')}</span><span class="card__lock">ЗАКРЫТО</span></div>
        <div class="card__face card__front"><small>ИСПЫТАНИЕ ${String(index + 1).padStart(2, '0')}</small><strong>${escapeHtml(challenge)}</strong></div>
      </div>
    </article>`;
  }).join('');
}

function showReveal(index, text, animate = true) {
  document.querySelector('#revealNumber').textContent = `КАРТОЧКА ${String(index + 1).padStart(2, '0')}`;
  document.querySelector('#revealText').textContent = text;
  revealImage.src = cardImages[index];
  revealImage.alt = text || '';
  reveal.classList.toggle('is-animated', animate);
  if (animate) {
    reveal.classList.remove('is-active');
    void reveal.offsetWidth;
  }
  reveal.classList.add('is-active');
  reveal.setAttribute('aria-hidden', 'false');
  if (animate) {
    makeParticles();
    playReveal();
  }
}

function hideReveal() {
  reveal.classList.remove('is-active', 'is-animated');
  reveal.setAttribute('aria-hidden', 'true');
}

function makeParticles() {
  particles.innerHTML = Array.from({ length: 70 }, (_, index) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 180 + Math.random() * 520;
    const color = ['#ffffff','#49bff4','#ffd45f','#6f8948'][index % 4];
    return `<i class="particle" style="--x:${Math.cos(angle)*distance}px;--y:${Math.sin(angle)*distance}px;--r:${Math.random()*180}deg;--c:${color}"></i>`;
  }).join('');
  setTimeout(() => { particles.innerHTML = ''; }, 1700);
}

function getAudio() {
  if (!soundEnabled) return null;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function tone(frequency, start, duration, type = 'triangle', volume = .12) {
  const context = getAudio();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
  gain.gain.setValueAtTime(.001, context.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + start + .03);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(context.currentTime + start);
  oscillator.stop(context.currentTime + start + duration + .04);
}

function playReveal() { [220,330,440,660].forEach((note,index) => tone(note,index*.12,.55,index === 3 ? 'sawtooth' : 'triangle',.1)); }
function playMilestone() { tone(180,0,.18,'square',.08); tone(520,.16,.45,'triangle',.11); }
function format(value) { return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(Number(value || 0)); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char])); }
