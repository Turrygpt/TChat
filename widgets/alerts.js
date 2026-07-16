const socket = io();
const alertBox = document.querySelector('#streamAlert');
const alertImage = document.querySelector('#streamAlertImage');
const alertVideo = document.querySelector('#streamAlertVideo');
const alertTitle = document.querySelector('#streamAlertTitle');
const alertUser = document.querySelector('#streamAlertUser');
const alertMessage = document.querySelector('#streamAlertMessage');
const alertSound = document.querySelector('#streamAlertSound');

const queue = [];
let isPlaying = false;
let displaySeconds = 8;
const MIN_ALERT_DISPLAY_SECONDS = 15;

fetch('/alerts/state')
  .then((response) => response.json())
  .then((state) => {
    displaySeconds = Number(state?.settings?.displaySeconds || displaySeconds);
  })
  .catch(() => {});

socket.on('alerts:queue', (payload) => {
  displaySeconds = Number(payload?.settings?.displaySeconds || displaySeconds);
});

socket.on('alert:play', (payload) => {
  queue.push(payload);
  playNextAlert();
});

async function playNextAlert() {
  if (isPlaying || !queue.length) {
    return;
  }

  isPlaying = true;
  const item = queue.shift();
  const donation = item.donation || {};
  const rule = item.rule || {};

  renderAlert(item, donation, rule);

  alertBox.classList.remove('stream-alert--hide', 'stream-alert--show');
  void alertBox.offsetWidth;
  alertBox.classList.add('stream-alert--show');

  const startedAt = Date.now();
  const minDisplayMs = Math.max(Number(item.displaySeconds || displaySeconds), item.kind === 'firstMessage' ? 3 : MIN_ALERT_DISPLAY_SECONDS) * 1000;

  await playAlertSound(rule);
  if (item.kind === 'firstMessage' || item.kind === 'portal') {
    // Greeting alerts are intentionally short and silent unless a custom sound is set.
  } else if (item.kind === 'subscriber') {
    await speakSubscriber(item.subscriber || {});
  } else if (item.kind === 'subscriptionRenewal') {
    await speakSubscriptionRenewal(item.renewal || {});
  } else if (item.kind === 'raid') {
    await speakRaid(item.raid || {});
  } else {
    await speakDonation(donation);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed < minDisplayMs) {
    await wait(minDisplayMs - elapsed);
  }

  await wait(450);

  alertBox.classList.remove('stream-alert--show');
  alertBox.classList.add('stream-alert--hide');
  await wait(450);
  socket.emit('alert:played', { id: item.id });
  isPlaying = false;
  playNextAlert();
}

function hideAlertMedia() {
  alertImage.hidden = true;
  alertImage.removeAttribute('src');
  alertVideo.hidden = true;
  alertVideo.removeAttribute('src');
  try {
    alertVideo.pause();
  } catch (_error) {
    // ignore
  }
}

function showAlertImage(url) {
  alertVideo.hidden = true;
  alertVideo.removeAttribute('src');
  alertImage.src = url;
  alertImage.hidden = false;
}

function showAlertVideo(url, fallbackUrl) {
  alertImage.hidden = true;
  alertImage.removeAttribute('src');
  alertVideo.onerror = fallbackUrl
    ? () => {
        alertVideo.onerror = null;
        showAlertImage(fallbackUrl);
      }
    : null;
  alertVideo.src = url;
  alertVideo.hidden = false;
  alertVideo.currentTime = 0;
  const playPromise = alertVideo.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      if (fallbackUrl) {
        showAlertImage(fallbackUrl);
      }
    });
  }
}

// Chooses <video> for .mp4/.webm. For legacy .gif rules it prefers an .mp4
// sibling (same name) and falls back to the original .gif if the video fails.
function setAlertMedia(url) {
  if (!url) {
    hideAlertMedia();
    return;
  }

  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4') || clean.endsWith('.webm')) {
    showAlertVideo(url, null);
    return;
  }

  if (clean.endsWith('.gif')) {
    const mp4Sibling = url.replace(/\.gif(\?.*)?$/i, '.mp4');
    showAlertVideo(mp4Sibling, url);
    return;
  }

  showAlertImage(url);
}

function renderAlert(item, donation, rule) {
  alertTitle.textContent = '';
  alertTitle.hidden = true;

  if (item.kind === 'firstMessage') {
    const firstMessage = item.firstMessage || {};
    renderSystemAlert(rule, firstMessage.username || 'Зритель', firstMessage.message || `${firstMessage.username || 'Зритель'} появился в чате`);
    return;
  }

  if (item.kind === 'portal') {
    const portal = item.portal || {};
    renderSystemAlert(rule, portal.username || 'Зритель', portal.message || 'Добро пожаловать из портала!');
    return;
  }

  if (item.kind === 'subscriber') {
    const subscriber = item.subscriber || {};
    renderSystemAlert(rule, subscriber.username || 'Зритель', subscriber.message || 'Спасибо за подписку!');
    return;
  }

  if (item.kind === 'subscriptionRenewal') {
    const renewal = item.renewal || {};
    renderSystemAlert(rule, renewal.username || 'Зритель', buildSubscriptionRenewalMessage(renewal));
    return;
  }

  if (item.kind === 'raid') {
    const raid = item.raid || {};
    const viewers = Number(raid.viewers || 0);
    const message = viewers > 0 ? `Рейд на ${formatMoney(viewers)} зрителей!` : 'Рейд!';
    renderSystemAlert(rule, raid.username || 'Зритель', message);
    return;
  }

  alertUser.textContent = `${donation.username || 'Зритель'} - ${formatMoney(donation.amount)} ${donation.currency || 'RUB'}`;
  alertMessage.textContent = donation.message || 'Без сообщения';

  setAlertMedia(rule.image);
}

function renderSystemAlert(rule, username, message) {
  alertTitle.textContent = rule.title || '';
  alertTitle.hidden = !rule.title;
  alertUser.textContent = username;
  alertMessage.textContent = message;

  setAlertMedia(rule.image);
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
    window.setTimeout(finish, 45000);
  });
}

function speakSubscriber(subscriber) {
  const username = subscriber.username || 'Зритель';
  return playEdgeTts(`${username}. Добро пожаловать! Спасибо за подписку.`);
}

function buildSubscriptionRenewalMessage(renewal = {}) {
  const tier = String(renewal.tier || '').trim();
  const months = Number(renewal.months || 0);
  const tierPart = tier ? ` '${tier}'` : '';
  const monthsPart = months > 0 ? ` Подписан уже ${months} ${months === 1 ? 'месяц' : months < 5 ? 'месяца' : 'месяцев'}.` : '';
  return `продлил подписку${tierPart}.${monthsPart}`.trim();
}

function speakSubscriptionRenewal(renewal) {
  const username = renewal.username || 'Зритель';
  return playEdgeTts(`${username}. ${buildSubscriptionRenewalMessage(renewal)} Спасибо за поддержку!`);
}

function speakRaid(raid) {
  const username = raid.username || 'Зритель';
  const viewers = Number(raid.viewers || 0);
  const viewersText = viewers > 0 ? `на ${formatMoney(viewers)} зрителей` : '';
  return playEdgeTts(`${username}. Рейд ${viewersText}. Добро пожаловать!`);
}

function speakDonation(donation) {
  return playEdgeTts(buildSpeechText(donation));
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

function buildSpeechText(donation) {
  const user = donation.username || 'Зритель';
  const amount = `${formatMoney(donation.amount)} ${donation.currency || 'рублей'}`;
  const message = donation.message || 'Без сообщения';
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
