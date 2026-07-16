const socket = io();
const countdownRoot = document.querySelector('#countdownRoot');
const countdownClock = document.querySelector('#countdownClock');

const widgetId = new URLSearchParams(window.location.search).get('id');
let activeWidget = null;
let tickTimer = null;

fetch('/widgets/state')
  .then((response) => response.json())
  .then(applyWidgetsPayload)
  .catch(() => {});

socket.on('widgets:state', applyWidgetsPayload);

function applyWidgetsPayload(payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const widget = widgetId
    ? items.find((item) => item.id === widgetId)
    : items.find((item) => item.type === 'countdown' && item.enabled !== false);

  activeWidget = widget || null;
  renderCountdown();
}

function getRemainingSeconds(widget = {}) {
  if (!widget) return 0;
  if (widget.status === 'running' && widget.endsAt) {
    return Math.max(Math.ceil((new Date(widget.endsAt).getTime() - Date.now()) / 1000), 0);
  }
  if (widget.status === 'finished') return 0;
  return Math.max(Number(widget.remainingSeconds || 0), 0);
}

function splitCountdown(seconds = 0) {
  const total = Math.max(Number(seconds || 0), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return { hours, minutes, seconds: secs, showHours: hours > 0 };
}

function setCountdownSegment(node, value) {
  if (!node || node.textContent === value) {
    return;
  }

  node.textContent = value;
  node.classList.add('is-ticking');
  window.setTimeout(() => node.classList.remove('is-ticking'), 320);
}

function renderCountdown() {
  clearInterval(tickTimer);
  tickTimer = null;

  if (!activeWidget || activeWidget.enabled === false) {
    countdownRoot.hidden = true;
    return;
  }

  countdownRoot.hidden = false;
  drawCountdown();

  if (activeWidget.status === 'running') {
    tickTimer = setInterval(drawCountdown, 200);
  }
}

function drawCountdown() {
  if (!activeWidget) return;

  const remaining = getRemainingSeconds(activeWidget);
  const parts = splitCountdown(remaining);
  const isFinished = activeWidget.status === 'finished' || remaining <= 0;
  const isUrgent = !isFinished && remaining <= 300;
  const isCritical = !isFinished && remaining <= 60;

  countdownRoot.classList.toggle('stream-countdown--finished', isFinished);
  countdownRoot.classList.toggle('stream-countdown--urgent', isUrgent);
  countdownRoot.classList.toggle('stream-countdown--critical', isCritical);
  countdownRoot.classList.toggle('stream-countdown--paused', activeWidget.status === 'paused');

  const hoursNode = countdownClock.querySelector('[data-part="hours"]');
  const minutesNode = countdownClock.querySelector('[data-part="minutes"]');
  const secondsNode = countdownClock.querySelector('[data-part="seconds"]');
  const separators = countdownClock.querySelectorAll('.stream-countdown__sep');

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
