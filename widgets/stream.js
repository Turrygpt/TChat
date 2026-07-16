const socket = io();

const streamGoals = document.querySelector('#streamGoals');
const streamCountdowns = document.querySelector('#streamCountdowns');
const streamTexts = document.querySelector('#streamTexts');
const streamTasks = document.querySelector('#streamTasks');
const streamEmbeddedWidgets = document.querySelector('#streamEmbeddedWidgets');
const streamPoll = document.querySelector('#streamPoll');
const alertBox = document.querySelector('#streamAlert');
const alertImage = document.querySelector('#streamAlertImage');
const alertTitle = document.querySelector('#streamAlertTitle');
const alertUser = document.querySelector('#streamAlertUser');
const alertMessage = document.querySelector('#streamAlertMessage');
const alertSound = document.querySelector('#streamAlertSound');

const alertQueue = [];
const queuedAlertIds = new Set();
let isAlertPlaying = false;
let displaySeconds = 8;
let latestState = { items: [], poll: null };
let pollTickTimer = null;
let countdownRenderTimer = null;

function applyWidgetHeight(node, widget) {
  if (!node) return;

  if (widget?.type === 'texts') {
    node.classList.remove('stream-widget--sized');
    node.style.removeProperty('height');
    node.style.removeProperty('overflow');
    node.style.removeProperty('box-sizing');
    return;
  }

  const height = Number(widget.height);
  const hasHeight = Number.isFinite(height) && height > 0;
  node.classList.toggle('stream-widget--sized', hasHeight);

  if (hasHeight) {
    node.style.height = `${height}%`;
    node.style.overflow = 'hidden';
    node.style.boxSizing = 'border-box';
    return;
  }

  node.style.removeProperty('height');
  node.style.removeProperty('overflow');
  node.style.removeProperty('box-sizing');
}

function widgetHeightCss(widget) {
  const height = Number(widget.height);
  if (!Number.isFinite(height) || height <= 0) {
    return '';
  }

  return `height: ${height}%; overflow: hidden; box-sizing: border-box;`;
}

fetch('/widgets/state')
  .then((response) => response.json())
  .then(applyWidgetsState)
  .catch(() => {});

fetch('/alerts/state')
  .then((response) => response.json())
  .then((state) => {
    displaySeconds = Number(state?.settings?.displaySeconds || displaySeconds);
    bootstrapAlertQueue(state?.queue);
  })
  .catch(() => {});

socket.on('widgets:state', applyWidgetsState);

socket.on('alerts:queue', (payload) => {
  displaySeconds = Number(payload?.settings?.displaySeconds || displaySeconds);
});

socket.on('alert:play', (payload) => {
  enqueueAlertForPlayback(payload);
});

function bootstrapAlertQueue(items = []) {
  if (!Array.isArray(items)) return;

  [...items].reverse().forEach((item) => {
    enqueueAlertForPlayback(item);
  });
}

function enqueueAlertForPlayback(payload) {
  if (!payload?.id || payload.played || !isWidgetEnabled('alerts') || queuedAlertIds.has(payload.id)) {
    return;
  }

  queuedAlertIds.add(payload.id);
  alertQueue.push(payload);
  playNextAlert();
}

function applyWidgetsState(state = {}) {
  latestState = {
    items: Array.isArray(state.items) ? state.items : [],
    poll: state.poll || null,
  };
  applyAlertWidgetLayout();
  renderGoals(latestState.items);
  renderCountdowns(latestState.items);
  renderTexts(latestState.items);
  renderTasks(latestState.items);
  renderEmbeddedWidgets(latestState.items);
  renderPoll(latestState.poll);
}

function applyAlertWidgetLayout() {
  const widget = latestState.items.find((item) => item.type === 'alerts' || item.id === 'builtin-alerts');
  if (!widget || !alertBox) return;

  alertBox.style.setProperty('--alert-left', `${Number(widget.x ?? 34)}%`);
  alertBox.style.setProperty('--alert-top', `${Number(widget.y ?? 34)}%`);
  alertBox.style.setProperty('--alert-width', `${Number(widget.width ?? 42)}%`);
  const height = Number(widget.height);
  if (Number.isFinite(height) && height > 0) {
    alertBox.style.setProperty('--alert-height', `${height}%`);
  } else {
    alertBox.style.removeProperty('--alert-height');
  }
}

function renderGoals(items) {
  const goals = items.filter((item) => item.type === 'goal' && item.enabled !== false);
  streamGoals.innerHTML = goals
    .map((goal) => {
      const target = Math.max(Number(goal.target || 1), 1);
      const current = Math.max(Number(goal.current || 0), 0);
      const percent = Math.min((current / target) * 100, 100);
      const style = `left: ${Number(goal.x || 18)}%; top: ${Number(goal.y || 6)}%; width: ${Number(goal.width || 64)}%; ${widgetHeightCss(goal)}`;
      return `
        <article class="stream-goal" style="${style}">
          <div class="stream-goal__top">
            <strong>${escapeHtml(goal.title || 'Сбор')}</strong>
            <span>${formatMoney(current)} / ${formatMoney(target)} ${escapeHtml(goal.currency || 'RUB')}</span>
          </div>
          <div class="stream-goal__track">
            <div class="stream-goal__fill" style="width: ${percent}%"></div>
          </div>
        </article>
      `;
    })
    .join('');
}

function getCountdownRemainingSeconds(widget = {}) {
  if (widget.status === 'running' && widget.endsAt) {
    return Math.max(Math.ceil((new Date(widget.endsAt).getTime() - Date.now()) / 1000), 0);
  }
  if (widget.status === 'finished') {
    return 0;
  }
  return Math.max(Number(widget.remainingSeconds || 0), 0);
}

function splitCountdownParts(seconds = 0) {
  const total = Math.max(Number(seconds || 0), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return {
    hours,
    minutes,
    seconds: secs,
    showHours: hours > 0,
  };
}

function ensureCountdownNode(widget) {
  let node = streamCountdowns.querySelector(`[data-countdown-id="${widget.id}"]`);
  if (node) {
    return node;
  }

  node = document.createElement('article');
  node.className = 'stream-countdown stream-countdown--enter';
  node.dataset.countdownId = widget.id;
  node.innerHTML = `
    <div class="stream-countdown__glow" aria-hidden="true"></div>
    <div class="stream-countdown__title">До конца стрима</div>
    <div class="stream-countdown__clock" aria-live="polite">
      <span class="stream-countdown__segment" data-part="hours">00</span>
      <span class="stream-countdown__sep">:</span>
      <span class="stream-countdown__segment" data-part="minutes">00</span>
      <span class="stream-countdown__sep">:</span>
      <span class="stream-countdown__segment" data-part="seconds">00</span>
    </div>
  `;
  node.addEventListener(
    'animationend',
    () => {
      node.classList.remove('stream-countdown--enter');
    },
    { once: true },
  );
  streamCountdowns.appendChild(node);
  return node;
}

function setCountdownSegment(node, value) {
  if (!node || node.textContent === value) {
    return;
  }

  node.textContent = value;
  node.classList.add('is-ticking');
  window.setTimeout(() => node.classList.remove('is-ticking'), 320);
}

function updateCountdownNode(node, widget) {
  const remaining = getCountdownRemainingSeconds(widget);
  const parts = splitCountdownParts(remaining);
  const isFinished = widget.status === 'finished' || remaining <= 0;
  const isUrgent = !isFinished && remaining <= 300;
  const isCritical = !isFinished && remaining <= 60;
  const isPaused = widget.status === 'paused';

  node.style.left = `${Number(widget.x || 72)}%`;
  node.style.top = `${Number(widget.y || 4)}%`;
  node.style.width = 'max-content';
  node.style.maxWidth = `${Number(widget.width || 18)}%`;
  applyWidgetHeight(node, widget);

  node.classList.toggle('stream-countdown--finished', isFinished);
  node.classList.toggle('stream-countdown--urgent', isUrgent);
  node.classList.toggle('stream-countdown--critical', isCritical);
  node.classList.toggle('stream-countdown--paused', isPaused);

  const hoursNode = node.querySelector('[data-part="hours"]');
  const minutesNode = node.querySelector('[data-part="minutes"]');
  const secondsNode = node.querySelector('[data-part="seconds"]');
  const separators = node.querySelectorAll('.stream-countdown__sep');

  if (parts.showHours) {
    hoursNode.hidden = false;
    separators[0].hidden = false;
    setCountdownSegment(hoursNode, String(parts.hours).padStart(2, '0'));
  } else {
    hoursNode.hidden = true;
    separators[0].hidden = true;
  }

  setCountdownSegment(minutesNode, String(parts.minutes).padStart(2, '0'));
  setCountdownSegment(secondsNode, String(parts.seconds).padStart(2, '0'));
}

function syncCountdownNodes(items) {
  const countdowns = items.filter((item) => item.type === 'countdown' && item.enabled !== false);
  const activeIds = new Set(countdowns.map((widget) => widget.id));

  streamCountdowns.querySelectorAll('[data-countdown-id]').forEach((node) => {
    if (!activeIds.has(node.dataset.countdownId)) {
      node.remove();
    }
  });

  countdowns.forEach((widget) => {
    const node = ensureCountdownNode(widget);
    updateCountdownNode(node, widget);
  });
}

function ensureCountdownTicker(countdowns) {
  const hasRunning = countdowns.some((widget) => widget.status === 'running');
  if (!hasRunning) {
    clearInterval(countdownRenderTimer);
    countdownRenderTimer = null;
    return;
  }

  if (countdownRenderTimer) {
    return;
  }

  countdownRenderTimer = setInterval(() => {
    const items = latestState.items.filter((item) => item.type === 'countdown' && item.enabled !== false);
    items.forEach((widget) => {
      const node = streamCountdowns.querySelector(`[data-countdown-id="${widget.id}"]`);
      if (node) {
        updateCountdownNode(node, widget);
      }
    });

    if (!items.some((widget) => widget.status === 'running')) {
      clearInterval(countdownRenderTimer);
      countdownRenderTimer = null;
    }
  }, 200);
}

function renderCountdowns(items) {
  if (!streamCountdowns) return;

  const countdowns = items.filter((item) => item.type === 'countdown' && item.enabled !== false);
  syncCountdownNodes(items);
  ensureCountdownTicker(countdowns);
}

function getActiveTextContent(widget = {}) {
  const items = Array.isArray(widget.textItems) ? widget.textItems : [];
  const activeItem = items.find((item) => item.id === widget.activeTextId) || items[0];
  return String(activeItem?.content || '').trim();
}

function formatStreamTextHtml(content = '') {
  const escaped = escapeHtml(content);
  return escaped.replace(/(\d[\d\s]*\d|\d+)/g, '<span class="stream-text__highlight">$1</span>');
}

function getTextsFontSize(widget = {}) {
  return Math.min(Math.max(Number(widget.fontSize || 32), 14), 96);
}

function ensureTextNode(widget) {
  let node = streamTexts.querySelector(`[data-text-id="${widget.id}"]`);
  if (node) {
    return node;
  }

  node = document.createElement('article');
  node.className = 'stream-text';
  node.dataset.textId = widget.id;
  node.innerHTML = `
    <div class="stream-text__frame">
      <div class="stream-text__glow" aria-hidden="true"></div>
      <p class="stream-text__content"></p>
    </div>
  `;
  streamTexts.appendChild(node);
  return node;
}

function applyTextNodeSizing(node) {
  if (!node) return;

  node.style.setProperty('width', 'max-content', 'important');
  node.style.setProperty('max-width', 'none', 'important');
  node.style.removeProperty('height');
  node.style.removeProperty('overflow');
  node.style.removeProperty('box-sizing');
  node.classList.remove('stream-widget--sized');

  const frame = node.querySelector('.stream-text__frame');
  if (frame) {
    frame.style.setProperty('width', 'max-content', 'important');
    frame.style.setProperty('max-width', 'none', 'important');
    frame.style.overflow = 'visible';
  }
}

function updateTextNode(node, widget) {
  const content = getActiveTextContent(widget);
  const contentNode = node.querySelector('.stream-text__content');

  node.style.left = `${Number(widget.x || 8)}%`;
  node.style.top = `${Number(widget.y || 18)}%`;
  applyTextNodeSizing(node);
  node.hidden = !content;

  if (!content) {
    return;
  }

  const fontSize = getTextsFontSize(widget);
  contentNode.style.setProperty('--stream-text-size', `${fontSize}px`);
  contentNode.style.fontSize = `${fontSize}px`;

  const nextHtml = formatStreamTextHtml(content);
  if (contentNode.innerHTML !== nextHtml) {
    contentNode.innerHTML = nextHtml;
    node.classList.remove('stream-text--enter');
    void node.offsetWidth;
    node.classList.add('stream-text--enter');
  }
}

function renderTexts(items) {
  if (!streamTexts) return;

  const texts = items.filter((item) => item.type === 'texts' && item.enabled !== false);
  const activeIds = new Set(texts.map((widget) => widget.id));

  streamTexts.querySelectorAll('[data-text-id]').forEach((node) => {
    if (!activeIds.has(node.dataset.textId)) {
      node.remove();
    }
  });

  texts.forEach((widget) => {
    const node = ensureTextNode(widget);
    updateTextNode(node, widget);
  });
}

function getTaskItems(widget = {}) {
  return (Array.isArray(widget.taskItems) ? widget.taskItems : []).filter((item) => String(item.text || '').trim());
}

function ensureTaskNode(widget) {
  let node = streamTasks.querySelector(`[data-task-widget-id="${widget.id}"]`);
  if (node) {
    return node;
  }

  node = document.createElement('article');
  node.className = 'stream-task-board stream-task-board--enter';
  node.dataset.taskWidgetId = widget.id;
  streamTasks.appendChild(node);
  return node;
}

function renderTaskBoardHtml(widget = {}) {
  const items = getTaskItems(widget);
  const tasksHtml = items
    .map((item) => `
      <li class="stream-task-item ${item.done ? 'is-done' : ''}">
        <span class="stream-task-item__mark" aria-hidden="true"></span>
        <p>${escapeHtml(item.text || '')}</p>
      </li>
    `)
    .join('');

  return `
    <div class="stream-task-panel stream-task-panel--${escapeHtml(widget.skin || 'farming-simulator-25')}">
      <div class="stream-task-panel__head">
        <div class="stream-task-panel__icon" aria-hidden="true">${widget.skin === 'cities' ? '◆' : widget.skin === 'mir-korabley' ? 'MK' : 'FS'}</div>
        <div class="stream-task-panel__text">
          <strong>${escapeHtml(widget.title || 'Задачи на стрим')}</strong>
          <span>${escapeHtml(widget.subtitle || 'План на эфир')}</span>
        </div>
      </div>
      <ul class="stream-task-list">${tasksHtml}</ul>
      <div class="stream-task-panel__foot">${escapeHtml(widget.footer || 'Live overlay')}</div>
    </div>
  `;
}

function updateTaskNode(node, widget) {
  node.style.left = `${Number(widget.x || 4)}%`;
  node.style.top = `${Number(widget.y || 8)}%`;
  node.style.width = `${Number(widget.width || 26)}%`;
  applyWidgetHeight(node, widget);
  node.hidden = getTaskItems(widget).length === 0;

  const nextHtml = renderTaskBoardHtml(widget);
  if (node.innerHTML !== nextHtml) {
    node.innerHTML = nextHtml;
    node.classList.remove('stream-task-board--enter');
    void node.offsetWidth;
    node.classList.add('stream-task-board--enter');
  }
}

function renderTasks(items) {
  if (!streamTasks) return;

  const tasks = items.filter((item) => item.type === 'tasks' && item.enabled !== false);
  const activeIds = new Set(tasks.map((widget) => widget.id));

  streamTasks.querySelectorAll('[data-task-widget-id]').forEach((node) => {
    if (!activeIds.has(node.dataset.taskWidgetId)) {
      node.remove();
    }
  });

  tasks.forEach((widget) => {
    const node = ensureTaskNode(widget);
    updateTaskNode(node, widget);
  });
}

function renderEmbeddedWidgets(items) {
  if (!streamEmbeddedWidgets) return;

  const widgets = items.filter((item) => ['music'].includes(item.type) && item.enabled !== false);
  const activeIds = new Set(widgets.map((widget) => widget.id));

  streamEmbeddedWidgets.querySelectorAll('[data-embedded-widget-id]').forEach((node) => {
    if (!activeIds.has(node.dataset.embeddedWidgetId)) {
      node.remove();
    }
  });

  widgets.forEach((widget) => {
    const x = Number(widget.x ?? 68);
    const y = Number(widget.y ?? 10);
    const width = Number(widget.width ?? 28);
    const src = widget.type === 'music' ? '/widgets/music.html?embedded=1' : '';
    const style = `left: ${x}%; top: ${y}%; width: ${width}%; ${widgetHeightCss(widget)}`;
    let node = streamEmbeddedWidgets.querySelector(`[data-embedded-widget-id="${widget.id}"]`);

    if (node) {
      if (node.getAttribute('src') !== src) {
        node.setAttribute('src', src);
      }
      node.setAttribute('title', widget.title || 'Музыка');
      node.setAttribute('style', style);
      return;
    }

    node = document.createElement('iframe');
    node.className = `stream-embedded-widget stream-embedded-widget--${widget.type}`;
    node.dataset.embeddedWidgetId = widget.id;
    node.title = widget.title || 'Музыка';
    node.src = src;
    node.style.cssText = style;
    node.allow = 'clipboard-write; autoplay; encrypted-media; fullscreen';
    node.allowFullscreen = true;
    streamEmbeddedWidgets.appendChild(node);
  });
}

function isWidgetEnabled(type) {
  const widget = latestState.items.find((item) => item.type === type || item.id === `builtin-${type}`);
  return widget ? widget.enabled !== false : true;
}

function renderPoll(poll) {
  clearInterval(pollTickTimer);
  pollTickTimer = null;

  const pollWidget = latestState.items.find((item) => item.type === 'poll' && item.enabled !== false);

  if (!poll || poll.visible === false || !pollWidget) {
    streamPoll.hidden = true;
    streamPoll.innerHTML = '';
    streamPoll.style.removeProperty('left');
    streamPoll.style.removeProperty('top');
    streamPoll.style.removeProperty('width');
    streamPoll.style.removeProperty('height');
    streamPoll.style.removeProperty('overflow');
    streamPoll.style.removeProperty('box-sizing');
    streamPoll.classList.remove('stream-widget--sized');
    return;
  }

  streamPoll.hidden = false;
  streamPoll.style.left = `${Number(pollWidget.x ?? 60)}%`;
  streamPoll.style.top = `${Number(pollWidget.y ?? 56)}%`;
  streamPoll.style.width = `${Number(pollWidget.width ?? 34)}%`;
  applyWidgetHeight(streamPoll, pollWidget);
  streamPoll.style.right = 'auto';
  streamPoll.style.bottom = 'auto';
  drawPoll(poll);

  if (poll.status === 'running' && poll.endsAt) {
    pollTickTimer = setInterval(() => drawPoll(latestState.poll), 1000);
  }
}

function drawPoll(poll) {
  if (!poll) return;

  const total = poll.options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
  const winner = getWinner(poll);
  const secondsLeft = poll.status === 'running' && poll.endsAt ? Math.max(Math.ceil((new Date(poll.endsAt).getTime() - Date.now()) / 1000), 0) : 0;
  const statusText = poll.status === 'finished' ? 'Результаты' : poll.endsAt ? `${secondsLeft} сек` : 'идёт';

  streamPoll.innerHTML = `
    <div class="stream-poll__head">
      <span>${escapeHtml(statusText)}</span>
      <strong>${escapeHtml(poll.title)}</strong>
    </div>
    <div class="stream-poll__options">
      ${poll.options
        .map((option) => {
          const percent = total > 0 ? (Number(option.votes || 0) / total) * 100 : 0;
          const isWinner = poll.status === 'finished' && winner?.id === option.id;
          return `
            <div class="stream-poll__option ${isWinner ? 'stream-poll__option--winner' : ''}">
              <div class="stream-poll__label">
                <span>${option.index}</span>
                <strong>${escapeHtml(option.text)}</strong>
                <em>${formatMoney(option.votes || 0)}</em>
              </div>
              <div class="stream-poll__bar"><div style="width: ${percent}%"></div></div>
            </div>
          `;
        })
        .join('')}
    </div>
    <div class="stream-poll__footer">${poll.status === 'finished' && winner ? `Победил вариант: ${escapeHtml(winner.text)}` : 'Пишите в чат номер варианта'}</div>
  `;
}

async function playNextAlert() {
  if (isAlertPlaying || !alertQueue.length) {
    return;
  }

  isAlertPlaying = true;
  const item = alertQueue.shift();
  renderAlert(item);

  alertBox.classList.remove('stream-alert--hide', 'stream-alert--show');
  void alertBox.offsetWidth;
  alertBox.classList.add('stream-alert--show');

  await playAlertSound(item.rule || {});
  await wait(Math.max(Number(item.displaySeconds || displaySeconds || 8), item.kind === 'firstMessage' ? 3 : 6) * 1000);

  alertBox.classList.remove('stream-alert--show');
  alertBox.classList.add('stream-alert--hide');
  await wait(450);
  socket.emit('alert:played', { id: item.id });
  queuedAlertIds.delete(item.id);
  isAlertPlaying = false;
  playNextAlert();
}

function renderAlert(item = {}) {
  const rule = item.rule || {};
  const donation = item.donation || {};
  const data = item.firstMessage || item.portal || item.subscriber || item.renewal || item.raid || donation;

  alertTitle.textContent = rule.title || alertTitleFor(item.kind);
  alertTitle.hidden = !alertTitle.textContent;
  alertUser.textContent = item.kind === 'donation' || donation.amount ? `${data.username || 'Зритель'} - ${formatMoney(donation.amount)} ${donation.currency || 'RUB'}` : data.username || 'Зритель';
  alertMessage.textContent = data.message || messageFor(item);

  if (rule.image) {
    alertImage.src = rule.image;
    alertImage.hidden = false;
  } else {
    alertImage.removeAttribute('src');
    alertImage.hidden = true;
  }
}

function alertTitleFor(kind) {
  return {
    firstMessage: 'Колокольчик',
    portal: 'Гость из портала!',
    subscriber: 'Новый подписчик',
    subscriptionRenewal: 'Продление подписки',
    raid: 'Рейд',
  }[kind] || 'Новый донат';
}

function messageFor(item) {
  if (item.kind === 'firstMessage') return item.firstMessage?.message || `${item.firstMessage?.username || 'Зритель'} появился в чате`;
  if (item.kind === 'portal') return item.portal?.message || 'Добро пожаловать из портала!';
  if (item.kind === 'raid') return `Рейд на ${formatMoney(item.raid?.viewers || 0)} зрителей`;
  if (item.kind === 'subscriber') return 'Спасибо за подписку!';
  if (item.kind === 'subscriptionRenewal') return 'Спасибо за поддержку!';
  return 'Без сообщения';
}

function playAlertSound(rule) {
  return new Promise((resolve) => {
    if (!rule.sound) {
      resolve();
      return;
    }

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      alertSound.removeEventListener('ended', finish);
      alertSound.removeEventListener('error', finish);
      resolve();
    };

    alertSound.src = rule.sound;
    alertSound.volume = Math.min(Math.max(Number(rule.volume ?? 100), 0), 100) / 100;
    alertSound.currentTime = 0;
    alertSound.addEventListener('ended', finish, { once: true });
    alertSound.addEventListener('error', finish, { once: true });
    alertSound.play().catch(finish);
    window.setTimeout(finish, 30000);
  });
}

function getWinner(poll) {
  return [...poll.options].sort((left, right) => Number(right.votes || 0) - Number(left.votes || 0))[0] || null;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
