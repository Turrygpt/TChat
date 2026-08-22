const socket = io();
document.documentElement.style.setProperty('background', 'transparent', 'important');
document.body.style.setProperty('background', 'transparent', 'important');
const root = document.querySelector('#giveaway');
const confetti = document.querySelector('#confetti');
const requestedId = new URLSearchParams(window.location.search).get('id');
let latestWidget = null;
let tickTimer = null;
let renderedSignature = '';
let timerKey = '';
let autoHideTimer = null;

fetch('/widgets/state')
  .then((response) => response.json())
  .then(applyState)
  .catch(() => {});

socket.on('widgets:state', applyState);

function applyState(state = {}) {
  const giveaways = (Array.isArray(state.items) ? state.items : []).filter(
    (widget) => widget.type === 'giveaway' && widget.enabled !== false,
  );
  const widget = requestedId ? giveaways.find((item) => item.id === requestedId) : giveaways[0];
  latestWidget = widget || null;
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  if (widget?.status === 'finished' && widget.finishedAt) {
    const hideDelay = new Date(widget.finishedAt).getTime() + 5 * 60 * 1000 - Date.now();
    if (hideDelay <= 0) {
      latestWidget = null;
    } else {
      autoHideTimer = setTimeout(() => {
        latestWidget = null;
        render();
      }, hideDelay);
    }
  }
  const nextSignature = JSON.stringify(latestWidget ? { ...latestWidget, updatedAt: undefined } : null);
  if (nextSignature !== renderedSignature) {
    renderedSignature = nextSignature;
    render();
  }

  const nextTimerKey = widget?.status === 'running' && widget.endsAt ? `${widget.id}:${widget.endsAt}` : '';
  if (nextTimerKey !== timerKey) {
    timerKey = nextTimerKey;
    clearInterval(tickTimer);
    tickTimer = nextTimerKey ? setInterval(updateTimer, 1000) : null;
  }

  if (widget?.status === 'finished' && widget.revealId && !isRevealCelebrated(widget)) {
    markRevealCelebrated(widget);
    celebrate();
  }
}

function celebratedStorageKey(widget) {
  return `tchat:giveaway:celebrated:${widget.id}`;
}

function isRevealCelebrated(widget) {
  try {
    return window.localStorage.getItem(celebratedStorageKey(widget)) === widget.revealId;
  } catch {
    return false;
  }
}

function markRevealCelebrated(widget) {
  try {
    window.localStorage.setItem(celebratedStorageKey(widget), widget.revealId);
  } catch {
    // localStorage may be unavailable (e.g. OBS private mode); celebration may replay on reload.
  }
}

function updateTimer() {
  const timer = root.querySelector('.giveaway__timer');
  if (timer && latestWidget) {
    timer.textContent = timerText(latestWidget);
  }
}

function render() {
  const widget = latestWidget;
  if (!widget) {
    root.hidden = true;
    reportHeight();
    return;
  }

  root.hidden = false;
  const participants = Array.isArray(widget.participants) ? widget.participants : [];
  const winners = Array.isArray(widget.winners) ? widget.winners : [];
  const pendingNicknames = winners.filter((winner) => !widget.winnerNicknames?.[winner.key]);
  const isFinished = widget.status === 'finished';
  root.className = `giveaway${isFinished ? ' giveaway--finished' : ''}`;
  root.innerHTML = `
    <header class="giveaway__header">
      <div>
        <span class="giveaway__eyebrow">${isFinished ? 'Победители' : 'TChat giveaway'}</span>
        <h1>${escapeHtml(widget.title || 'Розыгрыш')}</h1>
      </div>
      <div class="giveaway__timer">${escapeHtml(timerText(widget))}</div>
    </header>
    <div class="giveaway__prize">🎁 ${escapeHtml(widget.prize || 'Приз')} · ${Number(widget.prizeCount || 1)} шт.</div>
    ${
      isFinished
        ? `<section class="giveaway__winners">${
            winners.length
              ? winners
                  .map(
                    (winner, index) =>
                      `<div class="giveaway__winner" style="animation-delay:${index * 180}ms"><span>${index + 1}</span><div>${escapeHtml(winner.user)}${
                        widget.winnerNicknames?.[winner.key]
                          ? `<small>Ник: ${escapeHtml(widget.winnerNicknames[winner.key].nickname)}</small>`
                          : ''
                      }</div></div>`,
                  )
                  .join('')
              : '<div class="giveaway__winner">Нет участников</div>'
          }</section>${
            widget.collectNicknames && pendingNicknames.length
              ? `<p class="giveaway__nickname-prompt">🏆 Победители, отправьте в чат: <strong>Ник: ваш_ник</strong> или <strong>Ник ваш_ник</strong><br><small>Обычные сообщения не учитываются · повторная команда изменит ник</small></p>`
              : widget.collectNicknames && winners.length
                ? '<p class="giveaway__nickname-prompt giveaway__nickname-prompt--done">✓ Ники получены · для изменения отправьте новую команду «Ник: ваш_ник»</p>'
                : ''
          }`
        : `
          <p class="giveaway__join">${widget.status === 'running' ? 'Пишите в чат' : 'Скоро начнём'} <strong class="giveaway__keyword">${escapeHtml(widget.keyword || '!участвую')}</strong></p>
          <section class="giveaway__participants">
            ${
              participants.length
                ? participants
                    .map((participant) => `<span class="giveaway__person">${escapeHtml(participant.user)}</span>`)
                    .join('')
                : '<em class="giveaway__empty">Ждём первых участников…</em>'
            }
          </section>
        `
    }
    <footer class="giveaway__footer">${participants.length} ${plural(participants.length, 'участник', 'участника', 'участников')}</footer>
  `;
  reportHeight();
}

function reportHeight() {
  requestAnimationFrame(() => {
    const height = root.hidden ? 0 : Math.ceil(root.getBoundingClientRect().height);
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: 'tchat:giveaway-size', id: latestWidget?.id || requestedId || '', height },
        '*',
      );
    }
  });
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(reportHeight).observe(root);
}

function timerText(widget) {
  if (widget.status === 'finished') return 'ГОТОВО';
  if (widget.status !== 'running') return 'ОЖИДАНИЕ';
  if (!widget.endsAt) return 'ВРУЧНУЮ';
  const seconds = Math.max(Math.ceil((new Date(widget.endsAt).getTime() - Date.now()) / 1000), 0);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function celebrate() {
  confetti.innerHTML = '';
  const colors = ['#ffd166', '#ff5ba4', '#70e1f5', '#80f4c5', '#a98bff', '#ffffff'];
  for (let index = 0; index < 90; index += 1) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[index % colors.length];
    piece.style.setProperty('--duration', `${2.5 + Math.random() * 2.5}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.7}s`);
    piece.style.setProperty('--drift', `${-120 + Math.random() * 240}px`);
    confetti.appendChild(piece);
  }
  window.setTimeout(() => (confetti.innerHTML = ''), 6000);
  playFanfare();
}

function playFanfare() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    context.resume().catch(() => {});
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * 0.13;
      oscillator.type = index < 3 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.4);
    });
    window.setTimeout(() => context.close(), 2200);
  } catch {
    // OBS/browser may block audio until the source is allowed to play it.
  }
}

function plural(value, one, few, many) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
