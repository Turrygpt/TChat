const socket = io();
const chatMessages = document.querySelector('#chatMessages');
const query = new URLSearchParams(window.location.search);
const isAndroidClient = query.get('client') === 'android';
const maxMessages = isAndroidClient ? 20 : 8;
let chatSettings = {
  direction: 'top-down',
};

// Масштаб шрифта чата приходит из mobile-overlay.html (?font=1.4 и т.п.).
(() => {
  const font = parseFloat(query.get('font'));
  if (Number.isFinite(font) && font > 0) {
    document.documentElement.style.setProperty('--chat-font-scale', String(font));
  }
})();

let connectionNotice = null;

function setConnectionNotice(text = '') {
  if (!isAndroidClient) return;
  if (!connectionNotice) {
    connectionNotice = document.createElement('div');
    connectionNotice.className = 'chat-connection-notice';
    document.body.append(connectionNotice);
  }
  connectionNotice.textContent = text;
  connectionNotice.hidden = !text;
}

setConnectionNotice('Подключение к чату…');
socket.on('connect', () => setConnectionNotice(''));
socket.on('disconnect', () => setConnectionNotice('Связь с сервером чата потеряна'));
socket.on('connect_error', () => setConnectionNotice('Не удалось подключиться к серверу чата'));

socket.on('system:ready', (payload) => {
  addMessage({
    platform: 'system',
    user: 'TChat',
    text: payload.message || 'Виджет подключён.',
    badges: [],
  });
});

socket.on('chat:message', addMessage);
socket.on('chat:history', (messages = []) => {
  if (!isAndroidClient || !Array.isArray(messages)) return;
  chatMessages.replaceChildren();
  messages.slice(0, maxMessages).reverse().forEach(addMessage);
});
socket.on('chat:ui-settings', applyChatSettings);
socket.on('chat:music-request', addMusicRequestMessage);

// Скрытые в окне чата отправители/сообщения — не показываем их и здесь.
let hiddenChatSenders = new Set();
let hiddenChatMessages = new Set();

function normalizeFilterText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function chatSenderKey(message = {}) {
  return `${String(message.platform || '').toLowerCase()}:${normalizeFilterText(message.user)}`;
}

function chatTextKey(message = {}) {
  return normalizeFilterText(message.text);
}

function isChatMessageHidden(message = {}) {
  return hiddenChatSenders.has(chatSenderKey(message)) || hiddenChatMessages.has(chatTextKey(message));
}

socket.on('chat:filters', (filters = {}) => {
  hiddenChatSenders = new Set(Array.isArray(filters.senders) ? filters.senders : []);
  hiddenChatMessages = new Set(Array.isArray(filters.messages) ? filters.messages : []);
  chatMessages.querySelectorAll('.chat-message').forEach((node) => {
    if (hiddenChatSenders.has(node.dataset.senderKey) || hiddenChatMessages.has(node.dataset.textKey)) {
      node.remove();
    }
  });
});

function addMusicRequestMessage(item = {}) {
  const donation = item.donation || {};
  const title = decodeHtml(item.title || 'Музыкальная заявка');
  const username = donation.username || 'Зритель';
  const amount = Number(donation.amount || 0);
  const status = item.status === 'rejected' ? ` — ${item.reason || 'отклонено'}` : '';
  const amountPart = amount > 0 ? ` ${amount} ${donation.currency || 'RUB'}` : '';

  addMessage({
    platform: '',
    user: username,
    text: `заказал: ${title}${amountPart}${status}`,
    badges: ['ЗАКАЗ'],
  });
}

function decodeHtml(value = '') {
  const node = document.createElement('textarea');
  node.innerHTML = String(value);
  return node.value;
}

function applyChatSettings(settings = {}) {
  chatSettings = {
    ...chatSettings,
    ...settings,
    direction: settings.direction === 'top-down' ? 'top-down' : 'bottom-up',
  };
  document.body.classList.toggle('widget-page--chat-top-down', chatSettings.direction === 'top-down');
  document.body.classList.toggle('widget-page--chat-bottom-up', chatSettings.direction !== 'top-down');
}

function addMessage(message) {
  if (isChatMessageHidden(message)) return; // скрыто в окне чата

  const item = document.createElement('article');
  item.className = 'chat-message';
  item.dataset.senderKey = chatSenderKey(message);
  item.dataset.textKey = chatTextKey(message);
  item.innerHTML = `
    <div class="chat-message__meta">
      ${message.platform ? `<span class="chat-message__platform">${escapeHtml(message.platform)}</span>` : ''}
      ${renderOverlayBadges(message.badges)}
      <strong>${escapeHtml(message.user)}</strong>
    </div>
    <p>${escapeHtml(message.text)}</p>
  `;

  // Новые сообщения — сверху.
  chatMessages.prepend(item);

  while (chatMessages.children.length > maxMessages) {
    chatMessages.lastElementChild.remove();
  }

  if (!isAndroidClient) {
    window.setTimeout(() => {
      item.classList.add('chat-message--old');
    }, 14000);

    window.setTimeout(() => {
      item.remove();
    }, 18000);
  }
}

applyChatSettings(chatSettings);

// В overlay показываем только свои пометки-строки вроде «ЗАКАЗ». Ролевые бейджи
// площадок приходят объектами {label, url} — раньше они попадали сюда как есть и
// печатались как «[object Object]». На экране зрителю они и не нужны: в строке
// остаются источник, ник и текст.
function renderOverlayBadges(badges) {
  if (!Array.isArray(badges) || !badges.length) {
    return '';
  }
  return badges
    .filter((badge) => typeof badge === 'string' && badge.trim())
    .map((badge) => `<span class="chat-message__badge">${escapeHtml(badge)}</span>`)
    .join('');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
