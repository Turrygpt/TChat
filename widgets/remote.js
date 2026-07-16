const STORAGE_KEY = 'tchat.remote.host';
const DEFAULT_POLL_OPTIONS = ['Вариант 1', 'Вариант 2'];

const hostInput = document.querySelector('#hostInput');
const connectButton = document.querySelector('#connectButton');
const connectionDot = document.querySelector('#connectionDot');
const connectionText = document.querySelector('#connectionText');
const statsPanel = document.querySelector('#statsPanel');
const goalPanel = document.querySelector('#goalPanel');
const widgetsPanel = document.querySelector('#widgetsPanel');
const pollPanel = document.querySelector('#pollPanel');
const donationPanel = document.querySelector('#donationPanel');
const goalTitleInput = document.querySelector('#goalTitleInput');
const goalTargetInput = document.querySelector('#goalTargetInput');
const goalCurrentInput = document.querySelector('#goalCurrentInput');
const goalCurrencyInput = document.querySelector('#goalCurrencyInput');
const goalSummary = document.querySelector('#goalSummary');
const goalProgressFill = document.querySelector('#goalProgressFill');
const widgetCards = document.querySelector('#widgetCards');
const pollStatusText = document.querySelector('#pollStatusText');
const pollTitleInput = document.querySelector('#pollTitleInput');
const pollDurationInput = document.querySelector('#pollDurationInput');
const pollOptionsList = document.querySelector('#pollOptionsList');
const toast = document.querySelector('#toast');

let baseUrl = '';
let socket = null;
let statsRefreshTimer = null;
let pollOptionDraft = [...DEFAULT_POLL_OPTIONS];
let toastTimer = null;
let hasRemoteApi = false;

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getDefaultHost() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return saved;
  }

  if (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file:')) {
    return window.location.origin;
  }

  return 'http://192.168.1.2:3000';
}

function setConnected(isConnected, message = '') {
  connectionDot.classList.toggle('is-online', isConnected);
  connectionText.textContent = message || (isConnected ? 'Подключено' : 'Не подключено');
  const panels = [statsPanel, goalPanel, widgetsPanel, pollPanel, donationPanel];
  panels.forEach((panel) => {
    panel.hidden = !isConnected;
  });
  connectButton.disabled = false;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('toast--error', isError);
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 2600);
}

async function apiRequest(path, options = {}) {
  if (!baseUrl) {
    throw new Error('Сначала укажите адрес TChat.');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    throw new Error(body.error || `Ошибка HTTP ${response.status}`);
  }

  return body;
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function renderGoal(goal = {}) {
  goalTitleInput.value = goal.title || 'Сбор';
  goalTargetInput.value = Number(goal.target || 1);
  goalCurrentInput.value = Number(goal.current || 0);
  goalCurrencyInput.value = goal.currency || 'RUB';

  const target = Math.max(Number(goal.target || 1), 1);
  const current = Math.max(Number(goal.current || 0), 0);
  const percent = Math.min(Math.round((current / target) * 100), 100);
  goalSummary.textContent = `${formatMoney(current)} / ${formatMoney(target)} ${goal.currency || 'RUB'} (${percent}%)`;
  goalProgressFill.style.width = `${percent}%`;
}

function renderStats(chat = {}) {
  document.querySelector('#totalViewers').textContent = Number(chat.viewers?.total || 0);
  document.querySelector('#twitchViewers').textContent = Number(chat.viewers?.twitch || 0);
  document.querySelector('#vkViewers').textContent = Number(chat.viewers?.vk || 0);
  document.querySelector('#youtubeViewers').textContent = Number(chat.viewers?.youtube || 0);
}

function renderWidgetCards(items = []) {
  const goalWidgets = items.filter((item) => item.type === 'goal');

  if (!goalWidgets.length) {
    widgetCards.innerHTML = '<p class="muted">Нет отдельных полосок сбора на overlay.</p>';
    return;
  }

  widgetCards.innerHTML = goalWidgets
    .map((widget) => {
      const percent = Math.min(Math.round((Number(widget.current || 0) / Math.max(Number(widget.target || 1), 1)) * 100), 100);
      return `
        <article class="widget-card" data-widget-id="${escapeHtml(widget.id)}">
          <div class="widget-card__title">
            <span>${escapeHtml(widget.title || 'Сбор')}</span>
            <span class="muted">${percent}%</span>
          </div>
          <label class="field">
            <span>Цель</span>
            <input data-widget-field="target" type="number" min="1" value="${Number(widget.target || 1)}" />
          </label>
          <label class="field">
            <span>Текущая сумма</span>
            <input data-widget-field="current" type="number" min="0" value="${Number(widget.current || 0)}" />
          </label>
          <div class="button-row">
            <button class="button button--ghost" type="button" data-widget-save="${escapeHtml(widget.id)}">Сохранить</button>
            <button class="button button--ghost" type="button" data-widget-add="100" data-widget-id="${escapeHtml(widget.id)}">+100</button>
            <button class="button button--ghost" type="button" data-widget-add="500" data-widget-id="${escapeHtml(widget.id)}">+500</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderPoll(poll) {
  if (!poll) {
    pollStatusText.textContent = 'Нет активного голосования.';
    return;
  }

  const total = poll.options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
  const status = poll.visible === false ? 'скрыто' : poll.status === 'finished' ? 'завершено' : 'идёт';
  pollStatusText.innerHTML = `
    <strong>${escapeHtml(poll.title)}</strong> — ${status}, голосов: ${total}
    <br />
    ${poll.options
      .map((option) => `${option.index}. ${escapeHtml(option.text)} — ${option.votes || 0}`)
      .join('<br />')}
  `;
}

function renderPollOptions() {
  pollOptionsList.innerHTML = pollOptionDraft
    .map(
      (option, index) => `
        <div class="poll-option-row">
          <input data-poll-option-index="${index}" type="text" value="${escapeHtml(option)}" />
          <button class="button button--ghost" type="button" data-remove-poll-option="${index}">Удалить</button>
        </div>
      `,
    )
    .join('');
}

function collectPollOptions() {
  pollOptionDraft = [...pollOptionsList.querySelectorAll('[data-poll-option-index]')]
    .map((input) => input.value.trim())
    .filter(Boolean);
  return pollOptionDraft;
}

function setLegacyMode(isLegacy) {
  const legacyNote = document.querySelector('#legacyBanner');
  if (legacyNote) {
    legacyNote.hidden = !isLegacy;
  }

  pollPanel.hidden = isLegacy;
  donationPanel.hidden = isLegacy;

  widgetCards.querySelectorAll('[data-widget-save], [data-widget-add]').forEach((button) => {
    button.disabled = isLegacy;
    button.title = isLegacy ? 'Перезапустите TChat на ПК стримера' : '';
  });
}

async function probeRemoteApi() {
  try {
    await apiRequest('/remote/info');
    return true;
  } catch {
    return false;
  }
}

async function updateGoalOnServer(payload) {
  if (hasRemoteApi) {
    const result = await apiRequest('/remote/goal/update', {
      method: 'POST',
      body: payload,
    });
    return result.goal || payload;
  }

  const result = await apiRequest('/goal/update', {
    method: 'POST',
    body: payload,
  });
  return result.goal || payload;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function disconnectSocket() {
  clearInterval(statsRefreshTimer);
  statsRefreshTimer = null;

  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function connectSocket() {
  disconnectSocket();
  socket = io(baseUrl, {
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    setConnected(true, `Подключено: ${baseUrl}`);
  });

  socket.on('disconnect', () => {
    setConnected(false, 'Соединение потеряно');
  });

  socket.on('goal:update', (goal) => {
    renderGoal(goal);
  });

  socket.on('widgets:state', (payload) => {
    renderWidgetCards(payload.items || []);
    renderPoll(payload.poll || null);
  });

  socket.on('chat:status', (payload) => {
    renderStats(payload);
  });
}

function startStatsRefresh() {
  clearInterval(statsRefreshTimer);
  statsRefreshTimer = setInterval(() => {
    refreshState().catch(() => {});
  }, 15000);
}

async function refreshState() {
  if (hasRemoteApi) {
    const info = await apiRequest('/remote/info');
    renderGoal(info.goal || {});
    renderStats(info.chat || {});
    renderWidgetCards(info.widgets?.items || []);
    renderPoll(info.poll || null);
    return info;
  }

  const [goal, widgetsPayload] = await Promise.all([apiRequest('/goal/state'), apiRequest('/widgets/state')]);
  const info = {
    goal,
    chat: null,
    widgets: widgetsPayload,
    poll: widgetsPayload.poll || null,
    legacyMode: true,
  };
  renderGoal(goal);
  renderStats({});
  renderWidgetCards(widgetsPayload.items || []);
  renderPoll(widgetsPayload.poll || null);
  return info;
}

async function connect() {
  baseUrl = normalizeBaseUrl(hostInput.value || getDefaultHost());
  hostInput.value = baseUrl;
  localStorage.setItem(STORAGE_KEY, baseUrl);
  connectButton.disabled = true;
  connectionText.textContent = 'Подключаем...';

  try {
    await apiRequest('/health');
    hasRemoteApi = await probeRemoteApi();
    await refreshState();
    connectSocket();
    startStatsRefresh();
    setConnected(true, `Подключено: ${baseUrl}`);
    setLegacyMode(!hasRemoteApi);

    if (!hasRemoteApi) {
      showToast('Работает базовый режим. Перезапустите TChat для полного функционала.', true);
    } else {
      showToast('Подключение установлено');
    }
  } catch (error) {
    disconnectSocket();
    setConnected(false, 'Ошибка подключения');

    const isNetworkError = /failed to fetch|networkerror|network request failed/i.test(error.message);
    const message = isNetworkError
      ? 'Сервер недоступен. Убедитесь, что TChat запущен, IP верный и порт 3000 открыт в брандмауэре.'
      : error.message;

    showToast(message, true);
  }
}

async function saveGoal() {
  try {
    const goal = await updateGoalOnServer({
      title: goalTitleInput.value.trim() || 'Сбор',
      target: Number(goalTargetInput.value || 1),
      current: Number(goalCurrentInput.value || 0),
      currency: goalCurrencyInput.value.trim() || 'RUB',
    });
    renderGoal(goal);
    showToast('Полоска сохранена');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function addToGoal(amount) {
  const value = Math.max(Number(amount || 0), 0);
  if (!value) {
    showToast('Укажите сумму больше нуля', true);
    return;
  }

  try {
    let goal;
    if (hasRemoteApi) {
      const result = await apiRequest('/remote/goal/add', {
        method: 'POST',
        body: { amount: value },
      });
      goal = result.goal;
    } else {
      const current = await apiRequest('/goal/state');
      goal = await updateGoalOnServer({
        ...current,
        current: Number(current.current || 0) + value,
      });
    }

    renderGoal(goal || {});
    showToast(`Добавлено ${formatMoney(value)}`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function resetGoal() {
  try {
    let goal;
    if (hasRemoteApi) {
      const result = await apiRequest('/remote/goal/reset', { method: 'POST' });
      goal = result.goal;
    } else {
      const current = await apiRequest('/goal/state');
      goal = await updateGoalOnServer({
        ...current,
        current: 0,
      });
    }

    renderGoal(goal || {});
    showToast('Сумма сброшена');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveWidget(widgetId, card) {
  if (!hasRemoteApi) {
    showToast('Перезапустите TChat на ПК стримера для управления виджетами', true);
    return;
  }

  const targetInput = card.querySelector('[data-widget-field="target"]');
  const currentInput = card.querySelector('[data-widget-field="current"]');

  try {
    await apiRequest('/remote/widgets/update', {
      method: 'POST',
      body: {
        id: widgetId,
        target: Number(targetInput.value || 1),
        current: Number(currentInput.value || 0),
      },
    });
    showToast('Виджет обновлён');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function addToWidget(widgetId, amount) {
  const card = widgetCards.querySelector(`[data-widget-id="${widgetId}"]`);
  if (!card) {
    return;
  }

  const currentInput = card.querySelector('[data-widget-field="current"]');
  currentInput.value = Number(currentInput.value || 0) + Number(amount || 0);
  await saveWidget(widgetId, card);
}

async function startPoll() {
  if (!hasRemoteApi) {
    showToast('Перезапустите TChat на ПК стримера для голосований', true);
    return;
  }

  const options = collectPollOptions();

  try {
    await apiRequest('/remote/poll/start', {
      method: 'POST',
      body: {
        title: pollTitleInput.value.trim() || 'Голосование',
        durationSeconds: Number(pollDurationInput.value || 0),
        options,
      },
    });
    showToast('Голосование запущено');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function finishPoll() {
  try {
    await apiRequest('/remote/poll/finish', { method: 'POST' });
    showToast('Голосование завершено');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function showPoll() {
  try {
    await apiRequest('/remote/poll/show', { method: 'POST' });
    showToast('Голосование показано');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function hidePoll() {
  try {
    await apiRequest('/remote/poll/hide', { method: 'POST' });
    showToast('Голосование скрыто');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function sendDonation() {
  if (!hasRemoteApi) {
    showToast('Перезапустите TChat на ПК стримера для тестовых донатов', true);
    return;
  }

  try {
    await apiRequest('/remote/demo/donation', {
      method: 'POST',
      body: {
        username: document.querySelector('#donationUserInput').value.trim() || 'Удалённый зритель',
        amount: Number(document.querySelector('#donationAmountInput').value || 100),
        message: document.querySelector('#donationMessageInput').value.trim() || 'Проверка с удалённой панели',
        isTest: true,
        showInChat: true,
      },
    });
    showToast('Тестовый донат отправлен');
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

hostInput.value = getDefaultHost();
renderPollOptions();

connectButton.addEventListener('click', connect);
document.querySelector('#saveGoalButton').addEventListener('click', saveGoal);
document.querySelector('#resetGoalButton').addEventListener('click', resetGoal);
document.querySelector('#customAddAmountButton').addEventListener('click', () => {
  addToGoal(document.querySelector('#customAddAmountInput').value);
});
document.querySelector('#startPollButton').addEventListener('click', startPoll);
document.querySelector('#showPollButton').addEventListener('click', showPoll);
document.querySelector('#finishPollButton').addEventListener('click', finishPoll);
document.querySelector('#hidePollButton').addEventListener('click', hidePoll);
document.querySelector('#sendDonationButton').addEventListener('click', sendDonation);
document.querySelector('#addPollOptionButton').addEventListener('click', () => {
  pollOptionDraft.push(`Вариант ${pollOptionDraft.length + 1}`);
  renderPollOptions();
});

document.body.addEventListener('click', (event) => {
  const addAmountButton = event.target.closest('[data-add-amount]');
  if (addAmountButton) {
    addToGoal(addAmountButton.dataset.addAmount);
    return;
  }

  const widgetSaveButton = event.target.closest('[data-widget-save]');
  if (widgetSaveButton) {
    const card = widgetSaveButton.closest('[data-widget-id]');
    saveWidget(widgetSaveButton.dataset.widgetSave, card);
    return;
  }

  const widgetAddButton = event.target.closest('[data-widget-add]');
  if (widgetAddButton) {
    addToWidget(widgetAddButton.dataset.widgetId, widgetAddButton.dataset.widgetAdd);
  }
});

pollOptionsList.addEventListener('input', collectPollOptions);
pollOptionsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-poll-option]');
  if (!button) {
    return;
  }

  pollOptionDraft.splice(Number(button.dataset.removePollOption), 1);
  if (pollOptionDraft.length < 2) {
    pollOptionDraft.push(`Вариант ${pollOptionDraft.length + 1}`);
  }
  renderPollOptions();
});

if (hostInput.value) {
  connect();
}
