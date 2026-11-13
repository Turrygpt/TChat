const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createQuiz } = require('../src/quiz/quiz');
const { questions, questionById, pointSteps } = require('../src/quiz/bank');
const current = quiz => questionById.get(quiz.state().question.id);
const { createWidgetServer } = require('../src/server/widgetServer');
const turn = () => new Promise(resolve => setImmediate(resolve));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function answer(quiz, index) {
  quiz.command('select', { answer: index });
  quiz.command('lock');
  return quiz.command('reveal');
}

test('a nickname is required before play; player choices include profiles, chat and earlier players', () => {
  const quiz = createQuiz({ getPlayerNames: () => ['Ник из профиля'] });
  try {
    assert.throws(() => quiz.command('start'), /ник игрока/);
    assert.throws(() => quiz.command('start', { player: '   ' }), /ник игрока/);
    assert.equal(quiz.state().phase, 'waiting');
    quiz.command('start', { player: '  Игрок  ' });
    assert.equal(quiz.state().player, 'Игрок');
    quiz.command('new');
    quiz.ingestChat({ user: 'Ник из чата', platform: 'twitch', text: 'Привет' });
    assert.deepEqual(quiz.state().playerNames, ['Игрок', 'Ник из профиля', 'Ник из чата']);
    assert.equal(quiz.state().pointSteps[0], 100);
    assert.equal(quiz.state().pointSteps[14], 1000000);
  } finally { quiz.destroy(); }
});

test('expanded bank: unique cards, 30 Lesta questions, playful warmups and eight dialogues per heroine/step', () => {
  assert.equal(new Set(questions.map(q => q.id)).size, questions.length);
  assert.equal(new Set(questions.map(q => q.text)).size, questions.length);
  assert.ok(questions.length > 950);
  assert.equal(questions.filter(q => q.topic === 'Мир кораблей · Lesta').length, 30);
  for (const q of questions) {
    assert.equal(q.answers.length, 4); assert.equal(new Set(q.answers).size, 4);
    assert.ok(q.correct >= 0 && q.correct < 4); assert.ok(q.explanation);
    if (q.mode === 'history') assert.ok(q.sources.length && q.sources.every(url => url.startsWith('https://')));
  }
  for (let level = 1; level <= 15; level++) {
    assert.ok(questions.filter(q => q.mode === 'history' && q.level === level).length >= 25);
    for (const id of ['ussr', 'england', 'usa', 'france', 'germany']) assert.equal(questions.filter(q => q.characterId === id && q.level === level).length, 8);
  }
  assert.ok(questions.filter(q => q.level <= 5).every(q => q.kind === 'warmup'));
  const { characters } = require('../src/quiz/characters');
  for (const q of questions.filter(q => q.mode === 'characters')) {
    const heroine = characters.find(character => character.id === q.characterId);
    const expected = q.clues.map(key => heroine.tastes[key]);
    assert.equal(q.answers[q.correct], expected.join(' + '));
    expected.forEach(clue => assert.ok(heroine.lore.toLowerCase().includes(clue.toLowerCase())));
    assert.equal(q.clues.length, q.level === 15 ? 3 : q.level >= 11 ? 2 : 1);
  }
});

test('25 complete historical games never repeat a question', () => {
  const quiz = createQuiz(), seen = new Set();
  try {
    for (let game = 0; game < 25; game++) {
      quiz.command('start', { player: `Игрок ${game}`, mode: 'history' });
      for (let level = 1; level <= 15; level++) {
        const q = current(quiz); assert.equal(q.level, level); assert.ok(!seen.has(q.id)); seen.add(q.id);
        answer(quiz, q.correct);
        if (level < 15) quiz.command('next');
      }
      quiz.command('finish'); quiz.command('new');
    }
    assert.equal(seen.size, 375);
    assert.equal(quiz.state().evening.remaining.history, questions.filter(q => q.mode === 'history').length - 375);
    assert.throws(() => quiz.command('start', { player: '26' }), /25 игр/);
    quiz.command('new-evening');
    assert.equal(quiz.state().evening.gamesPlayed, 0);
    quiz.command('start', { player: 'Новый вечер' });
  } finally { quiz.destroy(); }
});

test('one heroine per game, introduction before questions, five full games without repeats', () => {
  for (const characterId of ['ussr', 'england', 'usa', 'france', 'germany']) {
    const quiz = createQuiz(), seen = new Set();
    try {
      for (let game = 0; game < 5; game++) {
        quiz.command('start', { player: 'Игрок', mode: 'characters', characterIds: [characterId] });
        assert.equal(quiz.state().phase, 'briefing');
        assert.equal(quiz.state().question, null);
        assert.throws(() => quiz.command('select', { answer: 0 }));
        quiz.command('begin');
        for (let level = 1; level <= 15; level++) {
          const q = current(quiz); assert.equal(q.characterId, characterId); assert.equal(q.level, level);
          assert.ok(!seen.has(q.id)); seen.add(q.id); answer(quiz, q.correct); if (level < 15) quiz.command('next');
        }
        quiz.command('new');
      }
      assert.equal(seen.size, 75);
      assert.throws(() => quiz.command('start', { player: 'Ещё', mode: 'characters', characterIds: [characterId] }), /пяти играх/);
    } finally { quiz.destroy(); }
  }
  const quiz = createQuiz();
  try {
    assert.throws(() => quiz.command('start', { player: 'A', mode: 'characters', characterIds: [] }));
    assert.throws(() => quiz.command('start', { player: 'A', mode: 'characters', characterIds: ['usa', 'germany'] }), /одну/);
  } finally { quiz.destroy(); }
});

test('saved evening survives restart; prizes are a static manual list, independent of rankings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-quiz-save-'));
  const storageFile = path.join(root, 'quiz-evening.json');
  let quiz = createQuiz({ storageFile });
  try {
    quiz.command('start', { player: 'Лидер' });
    answer(quiz, current(quiz).correct); quiz.command('retire');
    assert.equal(quiz.state().points, 100);
    quiz.destroy(); quiz = createQuiz({ storageFile });
    assert.equal(quiz.state().phase, 'finished');
    assert.equal(quiz.state().evening.remaining.history, questions.filter(q => q.mode === 'history').length - 15);
    quiz.command('new'); quiz.command('start', { player: 'Второй' });
    answer(quiz, (current(quiz).correct + 1) % 4); quiz.command('finish');
    quiz.command('close-evening');
    assert.equal(quiz.state().evening.standings[0].player, 'Лидер');
    assert.throws(() => quiz.command('award', { playerKey: 'второй', rewardId: 'reward-1' }));
    assert.deepEqual(quiz.state().evening.pool.map(item => item.title), ['Стрим по кораблю на выбор', 'Кружка с автографом', 'Стрим по игре', 'Кинострим', 'Подписка офицер', '10000 з', '5000 з']);
    quiz.destroy(); quiz = createQuiz({ storageFile });
    assert.equal(quiz.state().evening.pool.length, 7);
    quiz.command('new-evening');
    const saved = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    assert.equal(saved.archives.length, 1);
    assert.equal(saved.archives[0].games.length, 2);
  } finally {
    quiz.destroy();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tchat-quiz-save-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('15 host-paced rounds, hidden answer key, checkpoints and million-point finish', () => {
  const quiz = createQuiz();
  try {
    assert.ok(questions.length > 950);
    assert.equal(quiz.state().phase, 'waiting');
    assert.equal(quiz.state().question, null);
    quiz.command('start', { player: 'Участник' });
    for (let i = 0; i < 15; i++) {
      const before = quiz.state();
      assert.equal(before.index, i);
      assert.equal(before.question.correct, undefined);
      assert.equal(before.question.explanation, undefined);
      assert.equal(before.question.answers.length, 4);
      assert.throws(() => quiz.command('reveal'));
      assert.throws(() => quiz.command('next'));
      quiz.command('select', { answer: (current(quiz).correct + 1) % 4 });
      quiz.command('clear');
      assert.equal(quiz.state().selected, null);
      quiz.command('select', { answer: current(quiz).correct });
      assert.equal(quiz.state().phase, 'selected');
      quiz.command('lock');
      assert.equal(quiz.state().question.correct, undefined);
      assert.throws(() => quiz.command('select', { answer: 0 }));
      assert.throws(() => quiz.command('clear'));
      quiz.command('reveal');
      assert.equal(quiz.state().phase, 'correct');
      assert.equal(quiz.state().earned, pointSteps[i]);
      assert.equal(quiz.state().question.correct, current(quiz).correct);
      assert.throws(() => quiz.command('reveal'));
      if (i < 14) quiz.command('next');
    }
    assert.equal(quiz.state().guaranteed, 32000);
    assert.deepEqual(quiz.state().checkpoints, [{ step: 5, points: 1000 }, { step: 10, points: 32000 }]);
    quiz.command('finish');
    assert.equal(quiz.state().phase, 'finished');
    assert.equal(quiz.state().outcome, 'won');
    assert.equal(quiz.state().points, 1000000);
    quiz.command('new', { player: 'Следующий' });
    assert.equal(quiz.state().phase, 'waiting');
    assert.equal(quiz.state().answered, 0);
    assert.equal(quiz.state().player, 'Следующий');
  } finally { quiz.destroy(); }
});

test('full reset clears the whole evening, nick suggestions, questions, lifelines and survives restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-quiz-reset-'));
  const storageFile = path.join(root, 'quiz-evening.json');
  let quiz = createQuiz({ storageFile, getPlayerNames: () => ['Ник из общего профиля'] });
  try {
    quiz.command('start', { player: 'Старый ник' });
    answer(quiz, current(quiz).correct); quiz.command('next'); quiz.command('fifty');
    quiz.ingestChat({ user: 'Старый зритель', platform: 'twitch', text: 'A' });
    const previous = quiz.state();
    quiz.command('reset-all');
    let state = quiz.state();
    assert.notEqual(state.session, previous.session); assert.notEqual(state.evening.id, previous.evening.id);
    assert.equal(state.player, ''); assert.equal(state.phase, 'waiting'); assert.equal(state.question, null);
    assert.equal(state.evening.gamesPlayed, 0); assert.deepEqual(state.evening.standings, []);
    assert.deepEqual(state.evening.appearances, {}); assert.deepEqual(state.playerNames, []); assert.deepEqual(state.recent, []);
    assert.equal(state.lifelines.fifty, false); assert.equal(state.earned, 0); assert.ok(state.evening.nameEpoch);
    assert.equal(state.evening.remaining.history, questions.filter(q => q.mode === 'history').length);
    assert.equal(state.evening.remaining.characters, questions.filter(q => q.mode === 'characters').length);
    quiz.destroy(); quiz = createQuiz({ storageFile, getPlayerNames: () => ['Ник из общего профиля'] });
    state = quiz.state(); assert.deepEqual(state.playerNames, []); assert.equal(state.evening.gamesPlayed, 0);
    quiz.command('start', { player: 'Новый ник' });
    assert.deepEqual(quiz.state().playerNames, ['Новый ник']);
    assert.equal(JSON.parse(fs.readFileSync(storageFile, 'utf8')).archives.length, 0);
  } finally {
    quiz.destroy();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tchat-quiz-reset-'));
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('wrong answer awards only reached checkpoints; retirement keeps earned points', () => {
  for (const correctCount of [0, 4, 5, 9, 10, 14]) {
    const quiz = createQuiz();
    try {
      quiz.command('start', { player: 'Игрок' });
      for (let i = 0; i < correctCount; i++) { answer(quiz, current(quiz).correct); quiz.command('next'); }
      answer(quiz, (current(quiz).correct + 1) % 4);
      assert.equal(quiz.state().phase, 'wrong');
      assert.equal(quiz.state().points, correctCount >= 10 ? 32000 : correctCount >= 5 ? 1000 : 0);
      assert.throws(() => quiz.command('next'));
      quiz.command('finish');
    } finally { quiz.destroy(); }
  }
  const quiz = createQuiz();
  quiz.command('start', { player: 'Игрок' }); answer(quiz, current(quiz).correct); quiz.command('next');
  quiz.command('retire');
  assert.equal(quiz.state().points, 100);
  assert.equal(quiz.state().outcome, 'retired');
  assert.equal(quiz.state().question.correct, undefined);
  quiz.destroy();
});

test('50/50 keeps correct and selected answers, is single-use; stale controls are rejected', () => {
  const quiz = createQuiz();
  try {
    quiz.command('start', { player: 'Игрок' });
    const before = quiz.state();
    quiz.command('select', { answer: 0, controlRevision: before.controlRevision, session: before.session });
    assert.throws(() => quiz.command('lock', { controlRevision: before.controlRevision }));
    quiz.command('fifty');
    const hidden = quiz.state().hidden;
    assert.equal(hidden.length, 2); assert.ok(!hidden.includes(current(quiz).correct)); assert.ok(!hidden.includes(0));
    assert.throws(() => quiz.command('select', { answer: hidden[0] }));
    assert.throws(() => quiz.command('fifty'));
    quiz.command('new');
    assert.throws(() => quiz.command('start', { session: before.session }));
    quiz.command('audio', { enabled: true, volume: 500 });
    assert.deepEqual(quiz.state().audio, { enabled: true, volume: 100 });
    assert.throws(() => quiz.command('audio', { enabled: true, volume: 'oops' }));
  } finally { quiz.destroy(); }
});

test('real chat votes are per user/platform, replaceable, phase-scoped and never choose an answer', () => {
  const quiz = createQuiz();
  try {
    const vote = (text, user = 'Viewer', platform = 'twitch') => quiz.ingestChat({ text, user, platform });
    quiz.command('start', { player: 'Игрок' }); vote('A');
    assert.equal(quiz.state().lifelines.chat.total, 0);
    quiz.command('chat');
    const controlRevision = quiz.state().controlRevision;
    vote(' A '); vote('2'); vote('С', 'Other'); vote('4', 'Viewer', 'vk'); vote('это A', 'NoVote');
    quiz.ingestChat({ text: '1', user: 'Bot', systemEvent: true });
    assert.deepEqual(quiz.state().lifelines.chat.counts, [0, 1, 1, 1]);
    assert.equal(quiz.state().lifelines.chat.total, 3);
    assert.equal(quiz.state().selected, null);
    assert.equal(quiz.state().controlRevision, controlRevision);
    quiz.command('select', { answer: 1 }); quiz.command('lock'); vote('1');
    assert.deepEqual(quiz.state().lifelines.chat.counts, [0, 1, 1, 1]);
    assert.equal(quiz.state().lifelines.chat.status, 'closed');
  } finally { quiz.destroy(); }
});

test('AI uses an actual provider callback without the answer key; unavailable/error stays honest', async () => {
  const offline = createQuiz(); offline.command('start', { player: 'Игрок' });
  assert.equal(offline.state().lifelines.friend.status, 'unavailable');
  assert.throws(() => offline.command('friend')); offline.destroy();
  let prompt;
  const quiz = createQuiz({ askFriend: async text => { prompt = text; return { content: 'Думаю, C.', provider: 'test-model' }; } });
  try {
    quiz.command('start', { player: 'Игрок' }); quiz.command('friend');
    assert.equal(quiz.state().lifelines.friend.status, 'loading');
    assert.throws(() => quiz.command('friend'));
    await turn();
    assert.ok(prompt.includes(current(quiz).text));
    assert.ok(!prompt.includes('Правильный ответ:'));
    assert.equal(quiz.state().lifelines.friend.text, 'Думаю, C.');
    assert.equal(quiz.state().lifelines.friend.provider, 'test-model');
    assert.throws(() => quiz.command('friend'));
  } finally { quiz.destroy(); }
  const failure = createQuiz({ askFriend: async () => { throw new Error('private api credentials'); } });
  failure.command('start', { player: 'Игрок' }); failure.command('friend'); await turn();
  assert.equal(failure.state().lifelines.friend.status, 'error');
  assert.equal(failure.state().lifelines.friend.used, false);
  assert.ok(!failure.state().lifelines.friend.text.includes('credentials'));
  failure.destroy();
  let resolve;
  const slow = createQuiz({ askFriend: () => new Promise(r => { resolve = r; }) });
  slow.command('start', { player: 'Игрок' }); slow.command('friend'); await turn();
  slow.command('new'); resolve({ content: 'Old answer', provider: 'test' }); await turn();
  assert.equal(slow.state().lifelines.friend.text, ''); slow.destroy();
});

test('isolated HTTP server serves the screen, shares/replays state and receives chat', async () => {
  const server = createWidgetServer({ port: 0, host: '127.0.0.1' });
  try {
    const { url } = await server.start();
    const request = async (route, body) => {
      const response = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      return { status: response.status, body: await response.json() };
    };
    for (const page of ['quiz.html', 'quiz.css', 'quiz.js', 'quiz-audio.js']) assert.equal((await fetch(`${url}/widgets/${page}`)).status, 200);
    assert.equal((await request('/quiz/state')).body.phase, 'waiting');
    await request('/quiz/action', { action: 'start', player: 'Игрок' });
    await request('/quiz/action', { action: 'chat' });
    server.emitChatMessage({ platform: 'twitch', user: 'Connected viewer', text: 'C' });
    const result = await request('/quiz/state');
    assert.equal(result.body.lifelines.chat.counts[2], 1);
    assert.equal(result.body.selected, null);
    assert.equal(result.body.question.correct, undefined);
    assert.equal((await request('/quiz/action', { action: 'reveal' })).status, 409);
    const correct = questionById.get(result.body.question.id).correct;
    await request('/quiz/action', { action: 'select', answer: correct });
    await request('/quiz/action', { action: 'lock' });
    assert.equal((await request('/quiz/state')).body.question.correct, undefined);
    const reveal = await request('/quiz/action', { action: 'reveal' });
    assert.equal(reveal.body.state.phase, 'correct');
    assert.equal((await request('/quiz/state')).body.question.correct, correct);
    const health = await request('/health');
    assert.equal(health.body.widgets.quiz, '/widgets/quiz.html');
  } finally { await server.stop(); }
});
