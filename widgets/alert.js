const socket = io();
const donationAlert = document.querySelector('#donationAlert');
const donationTitle = document.querySelector('#donationTitle');
const donationAmount = document.querySelector('#donationAmount');
const donationMessage = document.querySelector('#donationMessage');

const queue = [];
const MIN_DONATION_DISPLAY_MS = 15000;
let isPlaying = false;

socket.on('donation:alert', (payload) => {
  queue.push(payload || {});
  playNextDonation();
});

async function playNextDonation() {
  if (isPlaying || !queue.length) {
    return;
  }

  isPlaying = true;
  const payload = queue.shift();
  const startedAt = Date.now();

  donationTitle.textContent = `${payload.username || 'Зритель'} поддержал(а) стрим`;
  donationAmount.textContent = `${formatMoney(payload.amount)} ${payload.currency || 'RUB'}`;
  donationMessage.textContent = payload.message || 'Без сообщения';

  donationAlert.classList.remove('donation-alert--hide', 'donation-alert--show');
  void donationAlert.offsetWidth;
  donationAlert.classList.add('donation-alert--show');

  await speakDonation(payload);

  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_DONATION_DISPLAY_MS) {
    await wait(MIN_DONATION_DISPLAY_MS - elapsed);
  }

  donationAlert.classList.remove('donation-alert--show');
  donationAlert.classList.add('donation-alert--hide');
  await wait(450);

  isPlaying = false;
  playNextDonation();
}

function speakDonation(payload) {
  return playEdgeTts(buildSpeechText(payload));
}

function playEdgeTts(text) {
  return new Promise((resolve) => {
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalizedText) {
      resolve();
      return;
    }

    const audio = new Audio(`/tts/edge?text=${encodeURIComponent(normalizedText)}`);
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('error', finish);
      resolve();
    };

    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.play().catch(finish);
    window.setTimeout(finish, Math.max(10000, normalizedText.length * 160));
  });
}

function buildSpeechText(payload) {
  const user = payload.username || 'Зритель';
  const amount = `${formatMoney(payload.amount)} ${payload.currency || 'рублей'}`;
  const message = payload.message || 'Без сообщения';
  return `${user}. Донат ${amount}. ${message}`;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}
