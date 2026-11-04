const socket = io();
const goalTitle = document.querySelector('#goalTitle');
const goalCurrent = document.querySelector('#goalCurrent');
const goalTarget = document.querySelector('#goalTarget');
const goalCurrencyCurrent = document.querySelector('#goalCurrencyCurrent');
const goalCurrencyTarget = document.querySelector('#goalCurrencyTarget');
const goalPercent = document.querySelector('#goalPercent');
const goalProgress = document.querySelector('#goalProgress');
const goalCard = document.querySelector('#goalCard');
const goalTrack = goalProgress.parentElement;

const state = {
  displayedCurrent: 0,
  requestedCurrent: null,
  goal: 1,
  currency: 'RUB',
  animationId: null,
};
const widgetId = new URLSearchParams(window.location.search).get('id');

function applyWidgetGoal(payload, donationEffect) {
  const widgetGoal = payload.items?.find((item) => item.id === widgetId && item.type === 'goal');
  const enabled = Boolean(widgetGoal && widgetGoal.enabled !== false);
  goalCard.hidden = !enabled;
  if (enabled) applyGoal(widgetGoal, donationEffect);
}

if (widgetId) goalCard.hidden = true;

fetch(widgetId ? '/widgets/state' : '/goal/state')
  .then((response) => response.json())
  .then((payload) => {
    if (!widgetId) {
      applyGoal(payload);
      return;
    }

    applyWidgetGoal(payload);
  })
  .catch(() => {});

if (widgetId) socket.on('widgets:state', applyWidgetGoal);
else socket.on('goal:update', applyGoal);

function applyGoal(payload = {}, donationEffect) {
  const current = Number(payload.current || 0);
  state.goal = Math.max(Number(payload.target || 1), 1);
  state.currency = payload.currency || 'RUB';

  goalTitle.textContent = payload.title || 'Сбор';
  goalTarget.textContent = formatMoney(state.goal);
  goalCurrencyCurrent.textContent = state.currency;
  goalCurrencyTarget.textContent = state.currency;
  if (state.requestedCurrent === current) {
    renderGoal();
    return;
  }
  state.requestedCurrent = current;
  const render = () => {
    if (state.requestedCurrent !== current) return;
    animateCurrentTo(current);
    flashReminder();
  };
  const amount = donationEffect?.amount;
  const percent = Math.min(current / state.goal * 100, 100);
  if (amount > 0 && window.TChatGoalEffects?.play({
    track: goalTrack, amount, currency: state.currency, percent, sound: true, onImpact: render,
  })) return;
  render();
}

function animateCurrentTo(current) {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }

  const from = state.displayedCurrent;
  const delta = current - from;

  if (Math.abs(delta) < 0.5) {
    state.displayedCurrent = current;
    renderGoal();
    return;
  }

  const duration = Math.min(1800, Math.max(500, Math.abs(delta) * 2 + 400));
  const start = performance.now();

  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    state.displayedCurrent = from + delta * eased;
    renderGoal();

    if (progress < 1) {
      state.animationId = requestAnimationFrame(step);
      return;
    }

    state.displayedCurrent = current;
    state.animationId = null;
    renderGoal();
  };

  state.animationId = requestAnimationFrame(step);
}

function renderGoal() {
  const percent = state.goal > 0 ? Math.min((state.displayedCurrent / state.goal) * 100, 100) : 0;

  goalCurrent.textContent = formatMoney(state.displayedCurrent);
  goalPercent.textContent = `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
  goalProgress.style.width = `${percent}%`;
}

function flashReminder() {
  goalCard.classList.remove('goal-card--pulse');
  void goalCard.offsetWidth;
  goalCard.classList.add('goal-card--pulse');

  setTimeout(() => {
    goalCard.classList.remove('goal-card--pulse');
  }, 900);
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}
