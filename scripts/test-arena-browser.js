// Real Chromium controls and overlay, with isolated settings and no live chat.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function browser(base) {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData', process.env.ARENA_BROWSER_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, backgroundColor: '#19304a', webPreferences:{backgroundThrottling:false} });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] }, (_, done) => done({ cancel: true }));
  const js = code => win.webContents.executeJavaScript(code);
  async function wait(code) {
    for (let n = 0; n < 300; n++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Browser timeout: ' + code);
  }
  await win.loadURL(base + '/backoffice');
  await wait("document.querySelector('#arenaSave') && !document.querySelector('#arenaSave').disabled");
  await js("document.querySelector('#arenaEnabled').checked=true; document.querySelector('#arenaSave').click()");
  await wait("document.querySelector('#arenaStatus').textContent.startsWith('Арена включена')");
  assert.equal((await (await fetch(base + '/arena/state')).json()).settings.enabled, true);
  for (const user of ['First', 'Second', 'Third']) await fetch(base + '/demo/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'twitch', user, text: '!бой '+({First:'алкоголик',Second:'бабка',Third:'слесарь'}[user]) }),
  });
  // Freeze combat while checking the browser renderer and reconnect behavior.
  await js("window.tchat.saveArena({paused:true})");
  await win.loadURL(base + '/widgets/stream.html');
  await wait("document.querySelectorAll('.arena-fighter').length === 3");
  assert.deepEqual(await js("[document.documentElement, document.body, document.querySelector('#arenaLayer')].map(e=>getComputedStyle(e).backgroundColor)"), Array(3).fill('rgba(0, 0, 0, 0)'));
  assert.equal(await js("document.querySelector('#arenaCommands').hidden"),false);
  assert.match(await js("document.querySelector('#arenaCommands').textContent"),/!бой.*!выход/);
  const loaded = await js("new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src='/assets/arena/mechanic.png'})");
  assert.equal(loaded, true);
  for (const [width,height] of [[1280,720],[1920,1080],[2560,1440]]) {
    win.setContentSize(width,height);
    await wait(`innerWidth===${width} && innerHeight===${height}`);
    await wait("Math.abs(document.querySelector('.arena-sprite').getBoundingClientRect().bottom-(innerHeight-Math.ceil(document.querySelector('#arenaCommands').getBoundingClientRect().height+8)))<1");
    const labels=await js(`Array.from(document.querySelectorAll('.arena-fighter')).map(node=>({
      bottom:node.querySelector('.arena-sprite').getBoundingClientRect().bottom,
      name:node.querySelector('.arena-name').textContent,
      nameBackground:getComputedStyle(node.querySelector('.arena-name')).backgroundColor,
      font:parseFloat(getComputedStyle(node.querySelector('.arena-name')).fontSize),
      earned:node.querySelectorAll('.arena-star.is-earned').length,
      level:node.querySelector('.arena-level').textContent,
      labelBottom:node.querySelector('.arena-labels').getBoundingClientRect().bottom,
      artTop:node.querySelector('.arena-art').getBoundingClientRect().top
    }))`);
    assert.deepEqual(labels.map(n=>n.earned).sort(),[1,2,3]);
    assert.deepEqual(labels.map(n=>n.level).sort(),['Ур. 1','Ур. 10','Ур. 5']);
    for (const label of labels) {
      const floor=await js("innerHeight-document.querySelector('#arenaCommands').getBoundingClientRect().height-8");
      assert.ok(Math.abs(label.bottom-floor)<1,'feet must sit immediately above the command strip');
      assert.ok(label.font>=16 && label.labelBottom<=label.artTop,'readable badges must stay above the fighter');
      assert.notEqual(label.nameBackground,'rgba(0, 0, 0, 0)');
    }
  }
  win.setContentSize(1280,720);
  await wait('innerWidth===1280 && innerHeight===720');
  // A colored scene behind the transparent overlay makes alpha edges visible.
  await js(`document.body.insertAdjacentHTML('afterbegin','<div id="testBackdrop" style="position:fixed;inset:0;background:linear-gradient(120deg,#19304a,#375942);z-index:-1"></div>')`);
  const output = path.join(os.tmpdir(), 'tchat-arena-preview.png');
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});
  await wait("document.querySelectorAll('.arena-fighter').length === 3");
  assert.equal((await (await fetch(base + '/arena/state')).json()).fighters.length, 3);
  const control=new BrowserWindow({show:false});
  await control.loadURL(base+'/backoffice');
  win.showInactive();
  await control.webContents.executeJavaScript('window.tchat.saveArena({paused:false})');
  await wait("document.querySelectorAll('.arena-damage').length>0");
  const damage=await js("document.querySelector('.arena-damage').textContent");
  assert.match(damage,/−[1-9][0-9]*/);
  await js(`document.body.insertAdjacentHTML('afterbegin','<div style="position:fixed;inset:0;background:linear-gradient(120deg,#19304a,#375942);z-index:-1"></div>')`);
  await js(`document.querySelectorAll('.arena-impact').forEach(fx=>fx.getAnimations({subtree:true}).forEach(animation=>{animation.pause();animation.currentTime=150;}))`);
  await new Promise(resolve=>setTimeout(resolve,180));
  const effectBounds=await js(`(()=>{const e=document.querySelector('.arena-damage');const r=e.getBoundingClientRect();return {opacity:getComputedStyle(e).opacity,top:r.top,bottom:r.bottom,left:r.left}})()`);
  assert.ok(Number(effectBounds.opacity)>.5 && effectBounds.top>0 && effectBounds.bottom<720,JSON.stringify(effectBounds));
  fs.writeFileSync(path.join(os.tmpdir(),'tchat-arena-combat.png'),(await win.webContents.capturePage()).toPNG());
  win.hide();
  await control.webContents.executeJavaScript('window.tchat.saveArena({paused:true})');
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(await js("document.querySelectorAll('.arena-impact').length"),0,'effects clean up after combat pauses');
  await control.webContents.executeJavaScript('window.tchat.saveArena({enabled:false})');
  await wait("document.querySelector('#arenaCommands').hidden && !document.querySelector('.arena-fighter')");
  control.destroy();

  await win.loadURL(base + '/backoffice');
  await wait("document.querySelector('#arenaClear') && !document.querySelector('#arenaClear').disabled");
  await js("document.querySelector('#arenaClear').click()");
  await wait("window.tchat.getArenaState().then(s=>s.fighters.length===0)");
  console.log('PASS arena browser: controls, sprites, transparent overlay on dark background, reconnect and clear. Preview: ' + output);
  win.destroy();
  app.exit(0);
}

async function run() {
  const electronPath = require('electron');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-arena-browser-'));
  fs.mkdirSync(path.join(storage,'settings'));
  fs.writeFileSync(path.join(storage,'settings','arena.json'),JSON.stringify({settings:{enabled:false},profiles:Object.fromEntries(
    [['first',0],['second',480],['third',2430]].map(([name,xp])=>['twitch:'+name,{xp,wins:0,deaths:0,character:'mechanic',readyAt:0,lastCommand:0}])
  )}));
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  Object.assign(process.env, { TCHAT_USER_DATA: storage, TCHAT_PORT: String(port), TCHAT_HOST: '127.0.0.1' });
  require('./serve-full');
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 300; n++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const env = { ...process.env, ARENA_BROWSER_PROFILE: path.join(storage, 'browser') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [__filename, '--browser', base], { env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  require('../src/headless/electron-shim').app.emit('before-quit');
  assert.equal(code, 0);
  process.exit(0);
}
if (process.argv.includes('--browser')) browser(process.argv.at(-1)).catch(error => { console.error(error); require('electron').app.exit(1); });
else run().catch(error => { console.error(error); process.exit(1); });
