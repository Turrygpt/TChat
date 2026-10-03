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
const context = vm.createContext({ window, document: { createElement: () => new Node() }, location: { search: '' }, URLSearchParams,
  fetch: () => new Promise(() => {}), setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout() {}, Math, Map, Set });
vm.runInContext(fs.readFileSync(require.resolve('../widgets/subscriber-goal.js'), 'utf8'), context);
const widget = { id: 'test', type: 'subscriber-goal', title: '<script>bad</script>', reward: 'Разыграю коврик!', current: 0, target: 2, enabled: true, sound: false, x: 10, y: 10, width: 40 };
const mounted = window.TChatSubscriberGoals.mount({ socket, layer });
socket.emit('widgets:state', { items: [widget] });
assert.equal(layer.children.length, 1);
const node = layer.children[0];
assert.equal(node.querySelector('.subscriber-goal__title').textContent, widget.title);
assert.equal(node.querySelector('.subscriber-goal__remaining').textContent, 'Осталось 2');
socket.emit('widgets:state', { items: [{ ...widget, current: 1 }] });
assert.equal(layer.children[0], node); // state updates keep the animated DOM alive
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Alice', reached: false }]);
assert.match(node.querySelector('.subscriber-goal__new').textContent, /Alice/);
socket.emit('widgets:state', { items: [{ ...widget, current: 2 }] });
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Bob', reached: true }]);
assert.equal(node.querySelector('.subscriber-goal__fill').style.width, '100%');
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 80);
assert.equal(node.classes.has('is-complete'), true);
socket.emit('subscriber-goal:increment', [{ id: 'test', username: 'Third', reached: false }]);
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 80);
scheduled.forEach(fn => fn());
assert.equal(node.querySelector('.subscriber-goal__effects').children.length, 0);
assert.equal(node.querySelector('.subscriber-goal__new').textContent, '');
socket.emit('widgets:state', { items: [{ ...widget, enabled: false }] });
assert.equal(layer.children.length, 0);
socket.emit('subscriber-goal:increment', [{ id: 'test', reached: true }]);
assert.equal(layer.children.length, 0);
socket.emit('widgets:state', { items: [{ ...widget, current: 3 }] });
assert.equal(layer.children[0].querySelector('.subscriber-goal__effects').children.length, 0); // reload never celebrates again
mounted.destroy();
assert.equal(socket.listenerCount('widgets:state'), 0);
assert.equal(socket.listenerCount('connect'), 0);
assert.equal(layer.children.length, 0);
console.log('Overlay PASS: text safety, remaining count, persistent nodes, +1 animation, 80 fireworks, completion, hide/show and cleanup.');
