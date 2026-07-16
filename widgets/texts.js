const socket = io();
const textsRoot = document.querySelector('#textsRoot');
const textsContent = document.querySelector('#textsContent');

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
    : items.find((item) => item.type === 'texts' && item.enabled !== false);

  activeWidget = widget || null;
  renderText();
}

function getActiveTextContent(widget = {}) {
  const items = Array.isArray(widget.textItems) ? widget.textItems : [];
  const activeItem = items.find((item) => item.id === widget.activeTextId) || items[0];
  return String(activeItem?.content || '').trim();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatStreamTextHtml(content = '') {
  const escaped = escapeHtml(content);
  return escaped.replace(/(\d[\d\s]*\d|\d+)/g, '<span class="stream-text__highlight">$1</span>');
}

function getTextsFontSize(widget = {}) {
  return Math.min(Math.max(Number(widget.fontSize || 32), 14), 96);
}

function applyTextLayout() {
  textsRoot.style.setProperty('width', 'max-content', 'important');
  textsRoot.style.setProperty('max-width', 'none', 'important');
  textsRoot.style.removeProperty('height');
  textsRoot.style.removeProperty('overflow');

  const frame = textsRoot.querySelector('.stream-text__frame');
  if (frame) {
    frame.style.setProperty('width', 'max-content', 'important');
    frame.style.setProperty('max-width', 'none', 'important');
    frame.style.overflow = 'visible';
  }
}

function renderText() {
  if (!activeWidget || activeWidget.enabled === false) {
    textsRoot.hidden = true;
    return;
  }

  const content = getActiveTextContent(activeWidget);
  if (!content) {
    textsRoot.hidden = true;
    return;
  }

  applyTextLayout();

  const nextHtml = formatStreamTextHtml(content);
  const fontSize = getTextsFontSize(activeWidget);
  textsContent.style.setProperty('--stream-text-size', `${fontSize}px`);
  textsContent.style.fontSize = `${fontSize}px`;

  if (textsContent.innerHTML !== nextHtml) {
    textsContent.innerHTML = nextHtml;
    textsRoot.classList.remove('stream-text--enter');
    void textsRoot.offsetWidth;
    textsRoot.classList.add('stream-text--enter');
  }

  textsRoot.hidden = false;
}
