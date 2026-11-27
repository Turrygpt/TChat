const card = document.getElementById('streamAlert');
const image = document.getElementById('streamAlertImage');
const video = document.getElementById('streamAlertVideo');
const user = document.getElementById('streamAlertUser');
const message = document.getElementById('streamAlertMessage');
const formatMoney = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
let playId = 0;

window.placeDonationAlert = ({ width, height, scale }, designWidth) => {
  document.querySelector('meta[name="viewport"]').content = 'width=' + designWidth;
  card.style.setProperty('--alert-width', (width ?? 42) + '%');
  if (height > 0) card.style.setProperty('--alert-height', height + '%');
  card.style.zoom = Math.min(Math.max(Number(scale) || 1, 0.25), 3);
  return true;
};

function clearMedia() {
  image.hidden = true;
  image.removeAttribute('src');
  video.hidden = true;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

window.showDonationAlert = data => {
  const id = ++playId;
  const currency = data.currency === 'RUB' ? '₽' : data.currency;
  const amount = formatMoney.format(data.amount) + ' ' + currency;
  user.textContent = data.username ? data.username + ' · ' + amount : amount;
  message.textContent = data.message;
  message.hidden = !data.message;
  clearMedia();
  const showImage = () => {
    if (id !== playId || !data.image) return;
    video.hidden = true;
    image.src = data.image;
    image.hidden = false;
  };
  const preferredVideo = data.video || (/\.(mp4|webm)$/i.test(data.image) ? data.image : '');
  if (preferredVideo) {
    video.hidden = false;
    video.src = preferredVideo;
    video.onerror = showImage;
    video.play().catch(showImage);
  } else {
    showImage();
  }
  card.classList.remove('stream-alert--show', 'stream-alert--hide');
  void card.offsetWidth;
  card.classList.add('stream-alert--show');
  return true;
};

window.hideDonationAlert = () => {
  const id = ++playId;
  card.classList.remove('stream-alert--show');
  card.classList.add('stream-alert--hide');
  setTimeout(() => { if (id === playId) clearMedia(); }, 450);
};
