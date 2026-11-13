// Real Chromium + Socket.io checks. Both the game server and browser profile are isolated.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-quiz-browser-'));
  const env = { ...process.env, TCHAT_QUIZ_BROWSER_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('tchat-quiz-browser-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
} else {
  // Electron deliberately doesn't initialize NODE_PATH; useful for worktrees
  // that reuse the checkout's installed dependencies without writing node_modules.
  require('node:module').Module._initPaths();
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  const { createWidgetServer } = require('../src/server/widgetServer');
  const { questionById } = require('../src/quiz/bank');
  const profile = process.env.TCHAT_QUIZ_BROWSER_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-quiz-browser-'));
  const output = process.env.TCHAT_QUIZ_SCREENSHOTS || path.join(os.tmpdir(), 'tchat-quiz-previews');
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  let server, control, obs, resultCode = 0;
  const waitFor = async (win, expression) => {
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Browser timed out: ${expression}`);
  };
  const click = async id => {
    await waitFor(control, `!document.getElementById(${JSON.stringify(id)}).disabled`);
    await control.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`);
  };
  const choose = async index => {
    await waitFor(control, `!document.querySelectorAll('#hostAnswers button')[${index}].disabled`);
    await control.webContents.executeJavaScript(`document.querySelectorAll('#hostAnswers button')[${index}].click()`);
  };
  const phase = async value => {
    await waitFor(control, `document.getElementById('stage').classList.contains(${JSON.stringify(value)})`);
    await waitFor(obs, `document.getElementById('stage').classList.contains(${JSON.stringify(value)})`);
  };
  const capture = async name => {
    await waitFor(obs, `Array.from(document.images).filter(image => image.getBoundingClientRect().width && image.getBoundingClientRect().height).every(image => image.complete && image.naturalWidth)`);
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(output, `${name}.png`), (await obs.webContents.capturePage()).toPNG());
  };
  const controlFits = async (label, sizes = [[1440, 900], [1280, 720], [1024, 768], [800, 600]]) => {
    for (const [width, height] of sizes) {
      control.setContentSize(width, height);
      await waitFor(control, `innerWidth === ${width} && innerHeight === ${height}`);
      await new Promise(resolve => setTimeout(resolve, 60));
      const layout = await control.webContents.executeJavaScript(`(() => {
        const bounds = element => { const r = element.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right }; };
        const elements = ['#openSettings','#newGame','#resetGame','#ladder li:first-child','#ladder li:last-child','#prizeList li:last-child','#playerScores'];
        if (document.querySelector('#stage').classList.contains('briefing')) elements.push('#begin');
        else elements.push('#retire','#lock','#reveal','#next','#fifty','#friend');
        if (document.querySelector('#stage').classList.contains('waiting')) elements.push('#playerInput','#modeInput','#start');
        if (!document.querySelector('#characterSelection').hidden) elements.push('#characterSelection');
        if (!document.querySelector('#stage').classList.contains('waiting')) elements.push('#question','#answers','.question-footer','#characterPresenter');
        return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
          controls:bounds(document.querySelector('#controls')), viewport:bounds(document.querySelector('#viewport')),
          elements:elements.map(selector => ({selector,...bounds(document.querySelector(selector))})),
          questionBottom:bounds(document.querySelector('.question-footer')).bottom,
          mainBottom:bounds(document.querySelector('.main-area')).bottom };
      })()`);
      assert.ok(layout.scrollHeight <= height + 1 && layout.scrollWidth <= width + 1, `${label} ${width}x${height}: page must fit: ${JSON.stringify(layout)}`);
      assert.ok(layout.controls.top >= layout.viewport.bottom - 1, `${label}: game and controls must not overlap`);
      for (const element of layout.elements) {
        assert.ok(element.top >= 0 && element.left >= 0 && element.bottom <= height + 1 && element.right <= width + 1, `${label} ${width}x${height}: ${JSON.stringify(element)} must be visible`);
        if (element.selector === '#answers') assert.ok(element.bottom <= layout.viewport.bottom, `${label}: answers must stay above controls`);
      }
      assert.ok(layout.questionBottom <= layout.mainBottom + 1, `${label} ${width}x${height}: question must fit inside main area: ${JSON.stringify(layout)}`);
      if (width === 1280 || width === 800) fs.writeFileSync(path.join(output, `quiz-control-${label}-${width}.png`), (await control.webContents.capturePage()).toPNG());
    }
    control.setContentSize(1440, 900);
  };
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    server = createWidgetServer({ port: 0, host: '127.0.0.1' });
    const { url } = await server.start();
    control = new BrowserWindow({ show: false, width: 1440, height: 1080, webPreferences: { offscreen: true, backgroundThrottling: false } });
    obs = new BrowserWindow({ show: false, width: 1920, height: 1080, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
    const errors = [];
    for (const win of [control, obs]) win.webContents.on('console-message', (_event, ...args) => {
      const details = args[0];
      if (typeof details === 'object' ? details.level === 'error' : details === 3) errors.push(typeof details === 'object' ? details.message : args[1]);
    });
    await Promise.all([control.loadURL(`${url}/widgets/quiz.html?control=1`), obs.loadURL(`${url}/widgets/quiz.html`)]);
    await waitFor(control, `!document.getElementById('newGame').disabled`);
    assert.equal(await control.webContents.executeJavaScript(`document.getElementById('start').disabled`), true);
    assert.equal(await obs.webContents.executeJavaScript(`getComputedStyle(document.getElementById('controls')).display`), 'none');
    await capture('quiz-waiting');
    await controlFits('waiting');
    await click('openSettings');
    assert.ok(await control.webContents.executeJavaScript(`document.querySelector('#settingsDialog').open && document.querySelector('#settingsDialog').getBoundingClientRect().bottom <= innerHeight`));
    await click('closeSettings');
    assert.equal(await control.webContents.executeJavaScript(`document.querySelector('#settingsDialog').open`), false);
    await control.webContents.executeJavaScript(`document.getElementById('playerInput').value = 'Александра'; document.getElementById('playerInput').dispatchEvent(new Event('input'))`);
    await click('start'); await phase('question');
    await waitFor(obs, `document.getElementById('player').textContent === 'Александра'`);
    const layout = await obs.webContents.executeJavaScript(`({ footer: document.querySelector('.question-footer').getBoundingClientRect().bottom, boundary: document.querySelector('.stage-footer').getBoundingClientRect().top, height: document.querySelector('#stage').getBoundingClientRect().height })`);
    assert.ok(layout.footer < layout.boundary, `question controls must not overlap the footer: ${JSON.stringify(layout)}`);
    assert.equal(layout.height, 1080);
    assert.equal(await obs.webContents.executeJavaScript(`document.querySelectorAll('#ladder .checkpoint').length`), 2);
    await capture('quiz-question');
    await controlFits('history');
    // Exercise every real question/answer length in the compact host layout.
    control.setContentSize(800, 600);
    await waitFor(control, 'innerWidth === 800 && innerHeight === 600');
    const bankOverflow = await control.webContents.executeJavaScript(`(() => {
      const question = document.querySelector('#question'), answers = [...document.querySelectorAll('.answer-text')];
      const original = { text:question.textContent, classes:question.className, answers:answers.map(node => node.textContent) };
      const failures = [];
      for (const item of ${JSON.stringify([...questionById.values()].map(({ id, text, answers }) => ({ id, text, answers })))}) {
        question.textContent = item.text; question.classList.toggle('long',item.text.length>160); question.classList.toggle('very-long',item.text.length>240);
        answers.forEach((node,index) => { node.textContent=item.answers[index]; });
        const footer=document.querySelector('.question-footer').getBoundingClientRect(), main=document.querySelector('.main-area').getBoundingClientRect();
        if (footer.bottom > main.bottom+1 || document.querySelector('#characterPresenter').getBoundingClientRect().bottom > document.querySelector('.question-meta').getBoundingClientRect().top+1 || answers.some(node => node.scrollWidth>node.clientWidth+1)) failures.push(item.id);
      }
      question.textContent=original.text; question.className=original.classes; answers.forEach((node,index) => {node.textContent=original.answers[index];});
      return failures;
    })()`);
    assert.deepEqual(bankOverflow, [], 'all question and answer lengths must fit at 800x600');
    control.setContentSize(1440, 900);
    await click('chat');
    await waitFor(obs, `document.getElementById('assistance').textContent.includes('Пока нет голосов')`);
    server.emitChatMessage({ platform: 'twitch', user: '<script>Viewer</script>', text: 'C' });
    server.emitChatMessage({ platform: 'vk', user: 'Viewer2', text: '2' });
    await waitFor(obs, `document.getElementById('assistance').textContent.includes('Голосов: 2')`);
    assert.equal(await obs.webContents.executeJavaScript(`document.querySelectorAll('.answer.selected').length`), 0);
    await capture('quiz-chat');
    await controlFits('chat');
    await click('chatClose');
    const first = await (await fetch(url + '/quiz/state')).json();
    const firstCorrect = questionById.get(first.question.id).correct;
    await choose(firstCorrect);
    await phase('selected');
    await click('lock'); await phase('locked');
    assert.equal(await obs.webContents.executeJavaScript(`document.querySelectorAll('.answer.correct').length`), 0);
    await capture('quiz-locked');
    await click('reveal'); await phase('correct');
    assert.equal(await obs.webContents.executeJavaScript(`document.querySelector('.answer.correct .letter').textContent`), 'ABCD'[firstCorrect]);
    await capture('quiz-correct');
    await click('next'); await phase('question');
    await click('fifty');
    await waitFor(obs, `document.querySelectorAll('.answer.eliminated').length === 2`);
    assert.equal(await obs.webContents.executeJavaScript(`document.querySelectorAll('.answer.eliminated').length`), 2);
    const state = await (await fetch(url + '/quiz/state')).json();
    const wrong = [0, 1, 2, 3].find(i => i !== questionById.get(state.question.id).correct && !state.hidden.includes(i));
    await choose(wrong);
    await phase('selected'); await click('lock'); await phase('locked');
    await click('reveal'); await phase('wrong'); await capture('quiz-wrong');
    await click('finish'); await phase('finished'); await capture('quiz-finished');
    await obs.reload();
    await waitFor(obs, `document.getElementById('stage').classList.contains('finished')`);
    assert.equal(await obs.webContents.executeJavaScript(`document.getElementById('score').textContent`), '0');
    await click('newGame'); await phase('waiting'); await click('start'); await phase('question');
    await control.webContents.executeJavaScript(`document.getElementById('monitorAudio').click()`);
    await control.webContents.executeJavaScript(`document.getElementById('audioEnabled').click()`);
    await waitFor(control, `document.getElementById('volumeText').textContent === '25%' && document.getElementById('audioEnabled').checked`);
    await waitFor(obs, `document.getElementById('audioStatus').textContent === 'Звук готов'`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await control.webContents.executeJavaScript(`document.getElementById('audioEnabled').click()`);
    await waitFor(control, `!document.getElementById('audioEnabled').checked`);
    // Review every question's real text at broadcast size, then the full victory.
    const post = async body => {
      const response = await fetch(url + '/quiz/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
    };
    await post({ action: 'new', player: 'Александра' }); await post({ action: 'start', player: 'Александра' });
    for (let i = 0; i < 15; i++) {
      await waitFor(obs, `document.getElementById('questionNumber').textContent === 'ВОПРОС ${i + 1} ИЗ 15'`);
      assert.ok(await obs.webContents.executeJavaScript(`document.querySelector('.question-footer').getBoundingClientRect().bottom < document.querySelector('.stage-footer').getBoundingClientRect().top`), `Question ${i + 1} must fit`);
      const snapshot = await (await fetch(url + '/quiz/state')).json();
      await post({ action: 'select', answer: questionById.get(snapshot.question.id).correct }); await post({ action: 'lock' }); await post({ action: 'reveal' });
      if (i < 14) await post({ action: 'next' });
    }
    await post({ action: 'finish' }); await phase('finished');
    await waitFor(obs, `document.getElementById('score').textContent.replace(/\\s/g, '') === '1000000'`);
    await capture('quiz-victory');
    await post({ action: 'close-evening' });
    await waitFor(obs, `!document.getElementById('eveningScreen').hidden`);
    await capture('quiz-evening');
    await post({ action: 'new-evening' }); await post({ action: 'new', player: 'Александра' });
    await phase('waiting');
    await control.webContents.executeJavaScript(`document.getElementById('modeInput').value = 'characters'; document.getElementById('modeInput').dispatchEvent(new Event('change'))`);
    await controlFits('character-setup');
    await click('start'); await phase('briefing');
    await controlFits('briefing'); await capture('quiz-briefing');
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('#characterSelection input[type=checkbox]').length`), 0);
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('#characterSelection input[type=radio]:checked').length`), 1);
    assert.ok(await control.webContents.executeJavaScript(`document.querySelector('#question').textContent.includes('Я Марта') && [...document.querySelectorAll('.answer')].every(button => button.disabled)`));
    await click('begin'); await phase('question');
    await waitFor(obs, `document.getElementById('characterPortrait').src.endsWith('/germany.png')`);
    await capture('quiz-germany');
    for (let i = 0; i < 15; i++) {
      const snapshot = await (await fetch(url + '/quiz/state')).json();
      await waitFor(obs, `document.getElementById('questionNumber').textContent === 'ВОПРОС ${i + 1} ИЗ 15'`);
      const fits = await obs.webContents.executeJavaScript(`document.querySelector('.lifelines').getBoundingClientRect().bottom <= document.querySelector('.main-area').getBoundingClientRect().bottom - 90 && document.querySelector('#answers').getBoundingClientRect().bottom < document.querySelector('.question-footer').getBoundingClientRect().bottom`);
      assert.ok(fits, `Lore question ${i + 1} must fit with its portrait`);
      await waitFor(control, `document.getElementById('questionNumber').textContent === 'ВОПРОС ${i + 1} ИЗ 15'`);
      await controlFits(`lore-${i + 1}`, i === 14 ? undefined : [[800, 600]]);
      if (i === 14) await capture('quiz-lore-hard');
      await post({ action: 'select', answer: questionById.get(snapshot.question.id).correct }); await post({ action: 'lock' }); await post({ action: 'reveal' });
      if (i < 14) await post({ action: 'next' });
    }
    // Full reset clears scores/names and restores the complete unused pool in both views.
    const beforeReset = await (await fetch(url + '/quiz/state')).json();
    await control.webContents.executeJavaScript(`window.confirm = () => false; void 0`);
    await click('resetGame');
    assert.equal((await (await fetch(url + '/quiz/state')).json()).session, beforeReset.session, 'cancel must preserve the current game');
    await control.webContents.executeJavaScript(`window.confirm = () => true; void 0`);
    await click('resetGame'); await phase('waiting');
    await waitFor(control, `document.getElementById('playerInput').value === '' && document.getElementById('start').disabled`);
    const afterReset = await (await fetch(url + '/quiz/state')).json();
    assert.notEqual(afterReset.session, beforeReset.session);
    assert.equal(afterReset.player, '');
    assert.equal(afterReset.earned, 0);
    assert.equal(afterReset.evening.gamesPlayed, 0);
    assert.deepEqual(afterReset.evening.appearances, {});
    assert.deepEqual(afterReset.evening.standings, []);
    assert.deepEqual(afterReset.playerNames, []);
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('#playerNames option').length`), 0);
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('#prizeList li').length`), 7);
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('#finalPool button').length`), 0);
    await waitFor(obs, `document.querySelectorAll('#playerScores li').length === 0`);
    await controlFits('reset');
    assert.deepEqual(errors, [], 'browser should have no script/resource errors');
    console.log(`Browser PASS: two synchronized windows, real host clicks, vote display, hidden answers, 50/50, results, reload, new game, Web Audio. Previews: ${output}`);
  }).catch(error => { console.error(error); resultCode = 1; }).finally(async () => {
    const deadline = setTimeout(() => app.exit(resultCode), 3000);
    control?.destroy(); obs?.destroy(); await server?.stop();
    clearTimeout(deadline);
    app.exit(resultCode);
  });
}
