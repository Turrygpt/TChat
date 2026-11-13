(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const isControl = new URLSearchParams(location.search).get('control') === '1';
  const money = value => Number(value).toLocaleString('ru-RU');
  const active = state => ['question', 'selected'].includes(state.phase);
  let state, connected = false, busy = false, chatStatus, handledNameEpoch;
  const selectedCharacters = new Set(['germany']);
  const audio = new window.TChatQuizAudio(status => {
    $('unlockAudio').hidden = status !== 'blocked';
    $('audioStatus').textContent = status === 'blocked' ? 'Браузер ожидает нажатия для звука' : 'Звук готов';
  });
  $('controls').hidden = !isControl;
  document.body.classList.toggle('control-mode', isControl);
  const cleanUrl = new URL('./quiz.html', location.href).href;
  $('obsUrl').textContent = cleanUrl;
  $('obsLink').href = cleanUrl;
  const resize = () => { $('stage').style.transform = isControl ? '' : `scale(${$('viewport').clientWidth / 1920})`; };
  new ResizeObserver(resize).observe($('viewport'));
  resize();
  $('openSettings').onclick = () => $('settingsDialog').showModal();
  $('closeSettings').onclick = () => $('settingsDialog').close();
  $('showTastes').onclick = () => { $('loreDetails').open = true; $('settingsDialog').showModal(); $('loreDetails').scrollIntoView({ block: 'start' }); };
  $('settingsDialog').addEventListener('click', event => {
    if (event.target !== $('settingsDialog')) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
  });

  function rememberedNames() {
    try { const value = JSON.parse(localStorage.getItem('tchat-quiz-player-names') || '[]'); return Array.isArray(value) ? value.filter(name => typeof name === 'string').slice(0, 100) : []; }
    catch { return []; }
  }
  $('playerInput').addEventListener('input', () => { if (state) render(state); });
  $('modeInput').addEventListener('change', () => { if (state) render(state); });
  const answerNodes = [], hostNodes = [];
  for (let i = 0; i < 4; i++) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'answer';
    const letter = document.createElement('span'); letter.className = 'letter'; letter.textContent = 'ABCD'[i];
    const text = document.createElement('span'); text.className = 'answer-text';
    const icon = document.createElement('span'); icon.className = 'answer-icon'; icon.setAttribute('aria-hidden', 'true');
    button.append(letter, text, icon); button.onclick = () => act('select', { answer: i });
    $('answers').append(button); answerNodes.push({ button, text, icon });
    const host = document.createElement('button'); host.type = 'button'; host.textContent = 'ABCD'[i];
    host.onclick = () => act('select', { answer: i }); $('hostAnswers').append(host); hostNodes.push(host);
  }
  const ladderNodes = [];
  for (let i = 14; i >= 0; i--) {
    const node = document.createElement('li');
    const number = document.createElement('span'); number.className = 'step-number'; number.textContent = String(i + 1).padStart(2, '0');
    const marker = document.createElement('span'); marker.className = 'step-marker';
    const prize = document.createElement('span');
    node.append(number, marker, prize); $('ladder').append(node); ladderNodes[i] = { node, prize };
  }
  const phaseLabels = {
    waiting: 'Ожидаем начала', briefing: 'Знакомимся с героиней', question: 'Выберите ответ',
    selected: 'Ответ выбран', locked: 'Ответ зафиксирован',
    correct: 'Верно', wrong: 'Неверно', finished: 'Игра завершена',
  };
  function renderEvening(s) {
    const evening = s.evening;
    if (s.phase !== 'waiting') {
      $('modeInput').value = s.mode;
      if (s.mode === 'characters') { selectedCharacters.clear(); s.characterIds.slice(0, 1).forEach(id => selectedCharacters.add(id)); }
    }
    if (s.storageError) { $('hostStatus').textContent = s.storageError; $('hostStatus').classList.add('error'); }
    $('eveningStatus').textContent = `Игра ${evening.gamesPlayed} / ${evening.maxGames} · без повторов`;
    $('modeInput').disabled = s.phase !== 'waiting' || busy || evening.closed;
    const useCharacters = (s.phase === 'waiting' ? $('modeInput').value : s.mode) === 'characters';
    $('controls').classList.toggle('playing', s.phase !== 'waiting');
    $('controls').classList.toggle('briefing-mode', s.phase === 'briefing');
    $('begin').hidden = s.phase !== 'briefing';
    $('characterSelection').hidden = !useCharacters || s.phase !== 'waiting';
    $('loreDetails').hidden = !useCharacters;
    $('showTastes').hidden = !useCharacters;
    $('characterSelection').replaceChildren(); $('loreText').replaceChildren();
    s.characters.forEach(character => {
      const label = document.createElement('label'), input = document.createElement('input'), image = document.createElement('img'), text = document.createElement('span');
      const remaining = 5 - (evening.appearances[character.id] || 0);
      input.type = 'radio'; input.name = 'heroine'; input.checked = selectedCharacters.has(character.id);
      input.disabled = s.phase !== 'waiting' || busy || !remaining || evening.closed;
      input.onchange = () => { selectedCharacters.clear(); selectedCharacters.add(character.id); render(state); };
      image.src = character.portrait; image.alt = character.name; image.loading = 'lazy';
      text.textContent = `${character.nation} · ${remaining}/5`;
      label.title = `${character.name} · ${character.nation} · осталось ${remaining} из 5 игр`;
      label.append(input, image, text); $('characterSelection').append(label);
      if (selectedCharacters.has(character.id)) { const p = document.createElement('p'); p.textContent = character.lore; $('loreText').append(p); }
    });
    const presenter = useCharacters ? s.characters.find(character => character.id === (s.question?.characterId || [...selectedCharacters][0])) : s.historicalHost;
    $('characterPresenter').hidden = !presenter || evening.closed;
    $('stage').classList.toggle('with-character', Boolean(presenter));
    if (presenter) {
      if ($('characterPortrait').getAttribute('src') !== presenter.portrait) $('characterPortrait').src = presenter.portrait;
      $('characterPortrait').alt = presenter.name; $('characterName').textContent = presenter.name;
      $('characterNation').textContent = presenter.nation;
    }
    $('closeEvening').disabled = busy || !connected || evening.closed || !['waiting', 'wrong', 'finished'].includes(s.phase) && !(s.phase === 'correct' && s.answered === 15);
    $('newEvening').disabled = busy || !connected;
    $('eveningScreen').hidden = !evening.closed;
    $('stage').classList.toggle('evening-closed', evening.closed);
    $('standings').replaceChildren(); $('hostStandings').replaceChildren();
    evening.standings.forEach(player => {
      const li = document.createElement('li'); li.textContent = `${player.player} — ${money(player.points)}`; $('standings').append(li);
      const p = document.createElement('p'); p.textContent = `${player.player} — ${money(player.points)} баллов`; $('hostStandings').append(p);
    });
    if (!evening.standings.length) { const p = document.createElement('p'); p.textContent = 'Пока нет завершённых игр'; $('hostStandings').append(p); }
    $('playerScores').replaceChildren();
    const scores = evening.standings.map(player => ({ ...player }));
    if (s.player && !['waiting', 'finished', 'wrong'].includes(s.phase)) {
      const previous = scores.find(player => player.player.toLocaleLowerCase('ru') === s.player.toLocaleLowerCase('ru'));
      if (previous) { previous.points = Math.max(previous.points, s.earned); previous.live = true; }
      else scores.push({ player: s.player, points: s.earned, live: true });
    }
    scores.sort((a, b) => b.points - a.points).forEach(player => {
      const li = document.createElement('li'), name = document.createElement('span'), points = document.createElement('strong');
      name.textContent = `${player.live ? '▶ ' : ''}${player.player}`; name.title = player.player; points.textContent = money(player.points);
      if (player.live) { li.className = 'live-player'; li.title = 'Играет сейчас; баллы текущей игры ещё не забраны'; }
      li.append(name, points); $('playerScores').append(li);
    });
    $('noScores').hidden = scores.length > 0;
    $('finalPool').replaceChildren(); $('prizeList').replaceChildren();
    evening.pool.forEach(reward => {
      const item = document.createElement('div'); item.className = 'final-reward'; item.textContent = reward.title; $('finalPool').append(item);
      const li = document.createElement('li'); li.textContent = reward.title; $('prizeList').append(li);
    });
    $('sourceDetails').hidden = s.question?.correct === undefined;
    $('sourceText').replaceChildren();
    if (s.question?.correct !== undefined) {
      const p = document.createElement('p'); p.textContent = s.question.explanation; $('sourceText').append(p);
      (s.question.sources || []).forEach(url => { const a = document.createElement('a'); a.href = url; a.textContent = new URL(url).hostname; a.target = '_blank'; a.rel = 'noopener'; $('sourceText').append(a, document.createTextNode(' ')); });
    }
  }
  function showAssistance() {
    const chat = state.lifelines.chat, friend = state.lifelines.friend;
    const hasFriend = ['loading', 'ready', 'error'].includes(friend.status);
    const hasChat = chat.status !== 'idle';
    $('assistance').replaceChildren();
    if (!['question', 'selected', 'locked'].includes(state.phase)) {
      $('assistance').hidden = true;
      $('stage').classList.remove('has-assistance');
      return;
    }
    $('assistance').hidden = !hasFriend && !hasChat;
    $('stage').classList.toggle('has-assistance', hasFriend || hasChat);
    if (hasFriend) {
      const text = document.createElement('div');
      text.textContent = friend.status === 'loading' ? 'Звоним нейросетевому другу…' : friend.text;
      const note = document.createElement('small'); note.className = 'friend-disclaimer';
      note.textContent = friend.status === 'ready' ? `Мнение ИИ · ${friend.provider} · может ошибаться` : friend.status === 'loading' ? 'Это реальный запрос к подключённой модели.' : 'Можно повторить запрос или продолжить игру.';
      $('assistance').append(text, note);
    }
    if (hasChat && !hasFriend) {
      const text = document.createElement('div'); text.className = 'chat-help';
      text.textContent = `${chat.status === 'open' ? 'Чат, ваш ход! Пишите A / B / C / D или 1–4.' : 'Голосование закрыто.'} ${chat.total ? `Голосов: ${chat.total}` : 'Пока нет голосов.'}`;
      const chart = document.createElement('div'); chart.className = 'chat-chart';
      chat.counts.forEach((count, i) => {
        const column = document.createElement('div'); column.className = 'chat-column';
        const percent = chat.total ? Math.round(count / chat.total * 100) : 0;
        const top = document.createElement('span'); top.textContent = `${percent}%`;
        const bar = document.createElement('i'); bar.style.setProperty('--bar', `${percent * .65}px`);
        const label = document.createElement('span'); label.textContent = `${'ABCD'[i]} · ${count}`;
        column.append(top, bar, label); chart.append(column);
      });
      $('assistance').append(text, chart);
    }
  }
  function render(snapshot) {
    if (!snapshot || (state && snapshot.revision < state.revision)) return;
    state = snapshot;
    const s = state, waiting = s.phase === 'waiting', finished = s.phase === 'finished';
    if (s.evening.nameEpoch && handledNameEpoch !== s.evening.nameEpoch) {
      handledNameEpoch = s.evening.nameEpoch;
      try { localStorage.removeItem('tchat-quiz-player-names'); localStorage.setItem('tchat-quiz-name-epoch', s.evening.nameEpoch); } catch { /* private browser storage */ }
      $('playerInput').value = '';
      $('modeInput').value = 'history';
      selectedCharacters.clear(); selectedCharacters.add('germany');
      $('settingsDialog').close();
    }
    const briefing = s.phase === 'briefing', heroine = s.characters.find(character => character.id === s.characterIds[0]);
    $('stage').className = `stage ${s.phase}`;
    $('player').textContent = s.player || 'Выберите игрока';
    $('score').textContent = money(['wrong', 'finished'].includes(s.phase) ? s.points : s.earned);
    $('questionNumber').textContent = briefing ? 'ЗНАКОМСТВО · ЗАПОМНИ ЕЁ ВКУСЫ' : waiting ? 'НОВАЯ ИГРА' : finished ? 'ИГРА ЗАВЕРШЕНА' : `ВОПРОС ${s.index + 1} ИЗ 15`;
    $('atStake').textContent = waiting || briefing ? '' : finished ? `${money(s.points)} баллов` : `За ответ · ${money(s.pointSteps[s.index])}`;
    // Also clean cards cached by an already running server until its next restart.
    const questionText = s.mode === 'history'
      ? (s.question?.text || '').replace(/^Атлас:\s*«(?:Без экзамена на адмирала!\s*)?([\s\S]*)»$/u, '$1')
      : s.question?.text || '';
    $('question').textContent = briefing ? heroine.intro : waiting ? s.player ? 'Готовы начать?' : 'Введите или выберите ник игрока' : questionText;
    $('question').classList.toggle('long', questionText.length > 160);
    $('question').classList.toggle('very-long', questionText.length > 240);
    $('phaseText').textContent = phaseLabels[s.phase];
    $('guaranteed').textContent = `Несгораемая · ${money(s.guaranteed)} баллов`;
    $('resultNote').textContent = finished ? `${s.outcome === 'won' ? 'Все 15 вопросов пройдены' : s.outcome === 'retired' ? 'Игрок забрал баллы' : 'Игра окончена'} · ${money(s.points)} баллов` : ['correct', 'wrong'].includes(s.phase) ? s.question.explanation : '';
    const names = [...new Set([...s.playerNames, ...rememberedNames()])];
    if (JSON.stringify(names) !== $('playerNames').dataset.names) {
      $('playerNames').dataset.names = JSON.stringify(names);
      $('playerNames').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
    }
    answerNodes.forEach(({ button, text, icon }, i) => {
      const eliminated = s.hidden.includes(i), correct = s.question?.correct === i;
      const wrong = s.question?.correct !== undefined && s.selected === i && !correct;
      button.className = `answer${s.selected === i ? ' selected' : ''}${eliminated ? ' eliminated' : ''}${correct ? ' correct' : ''}${wrong ? ' wrong' : ''}`;
      text.textContent = waiting || briefing ? '' : s.question.answers[i];
      icon.textContent = correct ? '✓' : wrong ? '×' : '';
      button.disabled = !isControl || !active(s) || eliminated || !connected || busy;
      button.setAttribute('aria-pressed', String(s.selected === i));
      hostNodes[i].disabled = button.disabled;
      hostNodes[i].classList.toggle('chosen', s.selected === i);
      hostNodes[i].setAttribute('aria-pressed', String(s.selected === i));
    });
    ladderNodes.forEach(({ node, prize }, i) => {
      node.className = `${s.checkpoints.some(checkpoint => checkpoint.step === i + 1) ? 'checkpoint ' : ''}${i < s.answered ? 'passed ' : ''}${!waiting && i === s.index ? 'current' : ''}`;
      prize.textContent = money(s.pointSteps[i]);
      if (!waiting && i === s.index) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
    ['fifty', 'chat', 'friend'].forEach(key => {
      const life = s.lifelines[key];
      $(`life-${key}`).classList.toggle('used', key === 'fifty' ? life : life.used);
      $(`life-${key}`).classList.toggle('active', key === 'chat' ? life.status === 'open' : key === 'friend' && life.status === 'loading');
    });
    $('life-friend').classList.toggle('unavailable', s.lifelines.friend.status === 'unavailable');
    showAssistance();
    const available = {
      start: waiting && !s.evening.closed && s.evening.gamesPlayed < 25 && Boolean($('playerInput').value.trim()) &&
        ($('modeInput').value !== 'characters' || selectedCharacters.size === 1 && [...selectedCharacters].every(id => (s.evening.appearances[id] || 0) < 5)), clear: s.phase === 'selected', lock: s.phase === 'selected', reveal: s.phase === 'locked',
      next: s.phase === 'correct' && s.answered < 15, finish: s.phase === 'wrong' || (s.phase === 'correct' && s.answered === 15),
      retire: active(s) || (s.phase === 'correct' && s.answered < 15),
      fifty: active(s) && !s.lifelines.fifty, chat: active(s) && !s.lifelines.chat.used,
      chatClose: active(s) && s.lifelines.chat.status === 'open',
      friend: active(s) && !s.lifelines.friend.used && ['idle', 'error'].includes(s.lifelines.friend.status), newGame: true,
      resetGame: true, begin: briefing,
    };
    Object.entries(available).forEach(([id, enabled]) => $(id).disabled = !enabled || busy || !connected);
    $('audioEnabled').disabled = busy || !connected; $('volume').disabled = busy || !connected;
    $('audioEnabled').checked = s.audio.enabled;
    if (document.activeElement !== $('volume')) $('volume').value = s.audio.volume;
    $('volumeText').textContent = `${s.audio.volume}%`;
    const status = chatStatus || s.chatStatus;
    $('chatStatus').textContent = status?.standalone ? 'Автономный сервер: внешние чаты и ИИ не подключены' : `Подключено площадок: ${status?.platforms || 0}${!status?.platforms ? ' · проверьте «Подключения»' : ''}`;
    $('chatFeed').replaceChildren();
    if (s.recent.length === 0) { const p = document.createElement('p'); p.textContent = 'Новые сообщения подключённых чатов появятся здесь.'; $('chatFeed').append(p); }
    s.recent.forEach(message => {
      const p = document.createElement('p'), platform = document.createElement('small'), user = document.createElement('b');
      platform.textContent = message.platform; user.textContent = `${message.user}: `;
      p.append(platform, user, document.createTextNode(message.text)); $('chatFeed').append(p);
    });
    renderEvening(s);
    audio.update(s, connected && (!isControl || $('monitorAudio').checked));
    $('unlockAudio').hidden = !s.audio.enabled || (isControl && !$('monitorAudio').checked) || audio.context?.state === 'running';
  }
  async function act(action, data = {}) {
    if (!isControl || !state || busy || !connected) return;
    busy = true; $('hostStatus').textContent = ''; $('hostStatus').classList.remove('error'); render(state);
    try {
      const response = await fetch('/quiz/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, session: state.session, controlRevision: state.controlRevision, ...data }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (result.state) render(result.state);
      if (!response.ok || !result.ok) throw new Error(result.error || 'Действие не выполнено');
      $('hostStatus').textContent = phaseLabels[state.phase];
      if (action === 'start') {
        try { localStorage.setItem('tchat-quiz-player-names', JSON.stringify([...new Set([state.player, ...rememberedNames()])].slice(0, 100))); } catch { /* storage can be disabled */ }
      }
    } catch (error) {
      $('hostStatus').textContent = `${error.message}. Состояние можно проверить на экране.`;
      $('hostStatus').classList.add('error');
      try { await sync(); } catch { /* socket reconnect will restore state */ }
    } finally { busy = false; if (state) render(state); }
  }
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => act(button.dataset.action,
    button.dataset.action === 'start' ? { player: $('playerInput').value, mode: $('modeInput').value, characterIds: [...selectedCharacters] } : {}));
  $('newGame').onclick = () => {
    if (state.phase !== 'waiting' && state.phase !== 'finished' && !confirm('Завершить текущую сессию и начать новую игру?')) return;
    act('new', { player: $('playerInput').value });
  };
  $('resetGame').onclick = async () => {
    if (!confirm('Сбросить ВЕСЬ вечер? Все ники викторины, баллы, результаты, подсказки и использованные вопросы будут очищены. Вопросы снова станут доступны.')) return;
    const session = state.session;
    await act('reset-all');
    if (state.session !== session && state.phase === 'waiting' && !state.player) {
      $('playerInput').value = '';
      $('modeInput').value = 'history';
      render(state);
      $('playerInput').focus();
    }
  };
  $('retire').onclick = () => { if (confirm(`Завершить игру и забрать ${money(state.earned)} баллов?`)) act('retire'); };
  $('closeEvening').onclick = () => { if (confirm('Завершить вечер и показать итоговый лидерборд? Новые игры в этом вечере будут закрыты.')) act('close-evening'); };
  $('newEvening').onclick = () => { if (confirm('Начать новый вечер? Использованные вопросы снова станут доступны, а результаты прошлого вечера останутся в архиве настроек.')) act('new-evening'); };
  $('audioEnabled').onchange = () => act('audio', { enabled: $('audioEnabled').checked, volume: Number($('volume').value) });
  $('volume').oninput = () => { $('volumeText').textContent = `${$('volume').value}%`; };
  $('volume').onchange = () => act('audio', { enabled: $('audioEnabled').checked, volume: Number($('volume').value) });
  $('monitorAudio').onchange = async () => { if ($('monitorAudio').checked) await audio.unlock(); if (state) render(state); };
  $('unlockAudio').onclick = async () => { await audio.unlock(); if (state) render(state); };
  $('copyObs').onclick = async () => {
    try { await navigator.clipboard.writeText(cleanUrl); $('hostStatus').textContent = 'URL OBS скопирован'; }
    catch { $('hostStatus').textContent = `URL OBS: ${cleanUrl}`; }
  };
  async function sync() {
    const response = await fetch('/quiz/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Викторина недоступна на этом сервере');
    render(await response.json());
  }
  const socket = io();
  socket.on('connect', () => {
    connected = true; $('connection').hidden = true;
    // Clear the revision guard on server restart; the session may have changed.
    state = undefined;
    sync().catch(error => { $('connection').hidden = false; $('connection').textContent = error.message; });
  });
  socket.on('quiz:state', render);
  socket.on('chat:status', status => { chatStatus = status; if (state) render(state); });
  const disconnected = () => {
    connected = false; $('connection').hidden = false; $('connection').textContent = 'Связь с TChat потеряна · ждём подключения';
    audio.stop(); if (state) render(state);
  };
  socket.on('disconnect', disconnected); socket.on('connect_error', disconnected);
  window.addEventListener('pagehide', () => { audio.destroy(); socket.disconnect(); });
  sync().catch(error => { $('connection').textContent = `${error.message}. Запустите обновлённый сервер TChat.`; });
})();
