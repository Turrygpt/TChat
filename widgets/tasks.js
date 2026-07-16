const socket = io();
const tasksRoot = document.querySelector('#tasksRoot');

const widgetId = new URLSearchParams(window.location.search).get('id');
let activeWidget = null;

fetch('/widgets/state')
  .then((response) => response.json())
  .then(applyWidgetsPayload)
  .catch(() => {});

socket.on('widgets:state', applyWidgetsPayload);

function applyWidgetsPayload(payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const widget = widgetId
    ? items.find((item) => item.id === widgetId)
    : items.find((item) => item.type === 'tasks' && item.enabled !== false);

  activeWidget = widget || null;
  renderTasks();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getTaskItems(widget = {}) {
  return (Array.isArray(widget.taskItems) ? widget.taskItems : []).filter((item) => String(item.text || '').trim());
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

function renderTasks() {
  if (!activeWidget || activeWidget.enabled === false || getTaskItems(activeWidget).length === 0) {
    tasksRoot.hidden = true;
    return;
  }

  const nextHtml = renderTaskBoardHtml(activeWidget);
  if (tasksRoot.innerHTML !== nextHtml) {
    tasksRoot.innerHTML = nextHtml;
    tasksRoot.classList.remove('stream-task-board--enter');
    void tasksRoot.offsetWidth;
    tasksRoot.classList.add('stream-task-board--enter');
  }

  tasksRoot.hidden = false;
}
