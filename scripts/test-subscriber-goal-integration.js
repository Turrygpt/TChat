const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tchat-goal-'));
process.env.TCHAT_USER_DATA = storage;
process.env.TCHAT_PORT = '3196';
process.env.TCHAT_HOST = '127.0.0.1';
require('./serve-full');
(async () => {
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:3196/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    const handlers = global.__tchatShim.ipcHandlers;
    const invoke = (name, arg) => handlers.get(name)({}, arg);
    let state = await invoke('widgets:create', { type: 'subscriber-goal', title: 'Подписчики', target: 10, current: 2, reward: 'Разыграю коврик!', platform: 'all' });
    const goal = state.items.find(w => w.type === 'subscriber-goal'); assert.ok(goal); assert.equal(goal.current, 2); assert.equal(goal.target, 10);
    state = await invoke('widgets:update', { id: goal.id, enabled: false });
    assert.equal(state.items.find(w => w.id === goal.id).enabled, false);
    state = await invoke('widgets:update', { id: goal.id, sound: false, enabled: true, target: 20 });
    const updated = state.items.find(w => w.id === goal.id); assert.equal(updated.sound, false); assert.equal(updated.current, 2); assert.equal(updated.target, 20);
    await invoke('demo:send-subscriber-alert', { username: 'Test' });
    state = await invoke('widgets:get-state'); assert.equal(state.items.find(w => w.id === goal.id).current, 2);
    for (const file of ['subscriber-goal.html','subscriber-goal.js','subscriber-goal.css','stream.html']) assert.equal((await fetch(`http://127.0.0.1:3196/widgets/${file}`)).status, 200);
    const vm = require('node:vm'); const html = fs.readFileSync(path.join(__dirname, '..', 'backoffice.html'), 'utf8');
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    const saved = JSON.parse(fs.readFileSync(path.join(storage, 'settings', 'stream-widgets.json'), 'utf8')).items.find(w => w.id === goal.id);
    assert.equal(saved.target, 20); assert.equal(saved.current, 2); assert.equal(saved.sound, false);
    console.log('Integration PASS: real IPC create/edit/hide/show, test alert exclusion, saved state, served OBS assets, backoffice JavaScript.');
    const smoke = spawn(process.execPath, [path.join(__dirname,'smoke-test.js')], { env: {...process.env,TCHAT_URL:'http://127.0.0.1:3196'},stdio:'inherit' });
    const code = await new Promise(r => smoke.on('exit', r)); assert.equal(code, 0); process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
})();
