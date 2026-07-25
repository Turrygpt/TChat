const socket = io();
const chatMessages = document.querySelector('#chatMessages');
const maxMessages = 8;
let chatSettings = {
  direction: 'top-down',
};

socket.on('system:ready', (payload) => {
  addMessage({
    platform: 'system',
    user: 'TChat',
    text: payload.message || 'Виджет подключён.',
    badges: [],
  });
});

socket.on('chat:message', addMessage);
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
      ${Array.isArray(message.badges) && message.badges.length
        ? message.badges.map((badge) => `<span class="chat-message__badge">${escapeHtml(badge)}</span>`).join('')
        : ''}
      <strong>${escapeHtml(message.user)}</strong>
    </div>
    <p>${escapeHtml(message.text)}</p>
  `;

  chatMessages.append(item);

  while (chatMessages.children.length > maxMessages) {
    chatMessages.firstElementChild.remove();
  }

  window.setTimeout(() => {
    item.classList.add('chat-message--old');
  }, 14000);

  window.setTimeout(() => {
    item.remove();
  }, 18000);
}

applyChatSettings(chatSettings);

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
