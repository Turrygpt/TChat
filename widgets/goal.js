const socket = io();
const goalTitle = document.querySelector('#goalTitle');
const goalCurrent = document.querySelector('#goalCurrent');
const goalTarget = document.querySelector('#goalTarget');
const goalCurrencyCurrent = document.querySelector('#goalCurrencyCurrent');
const goalCurrencyTarget = document.querySelector('#goalCurrencyTarget');
const goalPercent = document.querySelector('#goalPercent');
const goalProgress = document.querySelector('#goalProgress');
const goalCard = document.querySelector('#goalCard');

const state = {
  displayedCurrent: 0,
  targetCurrent: 0,
  goal: 1,
  currency: 'RUB',
  animationId: null,
};
const widgetId = new URLSearchParams(window.location.search).get('id');

fetch(widgetId ? '/widgets/state' : '/goal/state')
  .then((response) => response.json())
  .then((payload) => {
    if (!widgetId) {
      applyGoal(payload);
      return;
    }

    const widgetGoal = payload.items?.find((item) => item.id === widgetId);
    if (widgetGoal) applyGoal(widgetGoal);
  })
  .catch(() => {});

socket.on('goal:update', applyGoal);
socket.on('widgets:state', (payload) => {
  if (!widgetId) return;
  const widgetGoal = payload.items?.find((item) => item.id === widgetId);
  if (widgetGoal) applyGoal(widgetGoal);
});

function applyGoal(payload = {}) {
  const current = Number(payload.current || 0);
  state.goal = Math.max(Number(payload.target || 1), 1);
  state.currency = payload.currency || 'RUB';

  goalTitle.textContent = payload.title || 'Сбор';
  goalTarget.textContent = formatMoney(state.goal);
  goalCurrencyCurrent.textContent = state.currency;
  goalCurrencyTarget.textContent = state.currency;
  animateCurrentTo(current);
  flashReminder();
}

function animateCurrentTo(current) {
  state.targetCurrent = current;

  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
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
