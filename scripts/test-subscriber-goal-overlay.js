const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
class Node {
  constructor() {
    this.children = []; this.parts = {}; this.style = {}; this.textContent = '';
    this.classes = new Set(); this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x), toggle: (x, enabled) => enabled ? this.classes.add(x) : this.classes.delete(x) };
  }
  append(node) { node.parent = this; this.children.push(node); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  replaceChildren() { this.children = []; }
  querySelector(selector) { return this.parts[selector] ||= new Node(); }
}
const socket = new EventEmitter(), layer = new Node(), scheduled = [];
const window = {};
let clock = 0;
const context = vm.createContext({ window, document: { createElement: () => new Node() }, location: { search: '' }, URLSearchParams,
  fetch: () => new Promise(() => {}), setTimeout: (fn, ms) => { scheduled.push({ fn, ms, active: true }); return scheduled.length; }, clearTimeout: id => { if (scheduled[id - 1]) scheduled[id - 1].active = false; }, Date: { now: () => clock }, Math, Map, Set });
vm.runInContext(fs.readFileSync(require.resolve('../widgets/subscriber-goal.js'), 'utf8'), context);
const widget = { id: 'test', type: 'subscriber-goal', title: '<script>bad</script>', reward: 'Разыграю коврик!', current: 0, target: 2, enabled: true, sound: false, x: 10, y: 10, width: 40 };
const mounted = window.TChatSubscriberGoals.mount({ socket, layer });
socket.emit('widgets:state', { items: [widget] });
assert.equal(layer.children.length, 1);
const node = layer.children[0];
assert.equal(node.querySelector('.subscriber-goal__title').textContent, widget.title);
assert.equal(node.querySelector('.subscriber-goal__remaining').textContent, 'Осталось подписок: 2');
const inviteTimer = scheduled.find(timer => timer.ms === 300000 && timer.active);
assert.ok(inviteTimer, 'default invitation repeats every five minutes');
clock = 300000; inviteTimer.active = false; inviteTimer.fn();
assert.equal(node.classes.has('is-motivating'), true);
assert.match(node.querySelector('.subscriber-goal__motivation').textContent, /Подпишись/);
socket.emit('widgets:state', { items: [{ ...widget, current: 1 }] });
assert.equal(layer.children[0], node); // state updates keep the animated DOM alive
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Alice', reached: false }]);
assert.match(node.querySelector('.subscriber-goal__new').textContent, /Alice/);
assert.equal(node.classes.has('is-motivating'), false, 'subscription takes priority over the prompt');
assert.equal(node.querySelector('.subscriber-goal__reaction').children.length, 8);
assert.equal(node.querySelector('.subscriber-goal__reaction').children[0].textContent, '👍');
socket.emit('widgets:state', { items: [{ ...widget, current: 2 }] });
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Bob', reached: true }]);
assert.equal(node.querySelector('.subscriber-goal__fill').style.width, '100%');
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 80);
assert.equal(node.classes.has('is-complete'), true);
assert.equal(node.querySelector('.subscriber-goal__remaining').textContent, 'Осталось подписок: 0');
assert.equal(scheduled.some(timer => timer.ms === 300000 && timer.active), false, 'completed goals stop invitations');
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Third', reached: false }]);
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 80);
scheduled.forEach(timer => { if (timer.active) { timer.active = false; timer.fn(); } });
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 0);
assert.equal(node.querySelector('.subscriber-goal__new').textContent, '');
assert.equal(node.querySelector('.subscriber-goal__reaction').children.length, 0);
socket.emit('widgets:state', { items: [{ ...widget, enabled: false }] });
assert.equal(layer.children.length, 0);
socket.emit('subscriber-goal:increment', [{ id: 'test', reached: true }]);
assert.equal(layer.children.length, 0);
socket.emit('widgets:state', { items: [{ ...widget, current: 3 }] });
assert.equal(layer.children[0].querySelector('.subscriber-goal__effects').children.length, 0); // reload never celebrates again
socket.emit('widgets:state', { items: [{ ...widget, motivationEnabled: false }] });
assert.equal(scheduled.some(timer => timer.ms === 300000 && timer.active), false, 'disabled motivator has no timer');
socket.emit('widgets:state', { items: [{ ...widget, motivationIntervalSeconds: 15 }] });
assert.ok(scheduled.some(timer => timer.ms === 15000 && timer.active));
socket.emit('widgets:state', { items: [{ ...widget, enabled: false }] });
assert.equal(scheduled.some(timer => timer.ms === 15000 && timer.active), false, 'hidden widget stops invitations');
mounted.destroy();
assert.equal(socket.listenerCount('widgets:state'), 0);
assert.equal(socket.listenerCount('connect'), 0);
assert.equal(layer.children.length, 0);
console.log('Overlay PASS: text safety, remaining count, persistent nodes, +1 animation, 80 fireworks, completion, hide/show and cleanup.');

// Exercise the active toolbar's creation handler, including selection of the new widget.
(async () => {
  const html = fs.readFileSync(require.resolve('../backoffice.html'), 'utf8');
  const toolbar = html.slice(html.indexOf('<section class="workspace-zone workspace-zone--widgets">'), html.indexOf('<aside class="workspace-zone workspace-zone--config">'));
  assert.match(toolbar, /id="quickCreateSubscriberGoalButton"[^>]*>\+ Подписчики/);
  assert.match(html, /querySelector\('#quickCreateSubscriberGoalButton'\)\.addEventListener\('click', \(\) => createSubscriberGoalWidget\(\)\)/);
  const start = html.indexOf('      async function createSubscriberGoalWidget(');
  const end = html.indexOf("      document.querySelector('#createSubscriberGoalButton')", start);
  let createdOptions, rendered;
  const ui = vm.createContext({ Set, widgetsState: { items: [{ id: 'old', type: 'goal' }] }, selectedWorkspaceWidgetId: 'old', widgetsStudioState: {},
    window: { tchat: { createWidget: async options => { createdOptions = options; return { items: [{ ...options, id: 'new' }, { id: 'old', type: 'goal' }] }; } } },
    renderWidgetsState: state => rendered = state });
  vm.runInContext(html.slice(start, end), ui);
  await ui.createSubscriberGoalWidget();
  assert.equal(createdOptions.type, 'subscriber-goal');
  assert.equal(createdOptions.platform, 'all');
  assert.equal(ui.selectedWorkspaceWidgetId, 'new');
  assert.equal(rendered.items[0].id, 'new');
  console.log('Toolbar PASS: visible + Подписчики button creates and selects a subscriber goal for the right-hand settings.');
})().catch(error => { console.error(error); process.exitCode = 1; });
