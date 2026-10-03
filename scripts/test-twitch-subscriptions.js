const assert = require('node:assert/strict');
const tmi = require('tmi.js');
const { registerTwitchSubscriptions } = require('../src/twitchSubscriptions');

// Feed real IRC USERNOTICE frames through the installed tmi.js parser, without
// connecting to Twitch or changing a running TChat instance.
const client = new tmi.Client({ channels: ['test'] });
const messages = [];
const subscribers = [];
const renewals = [];
registerTwitchSubscriptions(client, {
  publish: (message) => messages.push(message),
  subscriberAlert: (event) => { subscribers.push(event); return null; },
  renewalAlert: (event) => { renewals.push(event); return null; },
});
function notice(type, extra = '', message = '') {
  client._onMessage({ data: `@id=${type};display-name=Alice;login=alice;msg-id=${type};msg-param-sub-plan=1000${extra} :tmi.twitch.tv USERNOTICE #test${message ? ` :${message}` : ''}` });
}
notice('sub', '', 'Спасибо!');
notice('resub', ';msg-param-cumulative-months=12', 'Снова с вами');
notice('subgift', ';msg-param-recipient-display-name=Bob;msg-param-recipient-user-name=bob');
notice('anonsubgift', ';msg-param-recipient-display-name=Carol;msg-param-recipient-user-name=carol');
notice('submysterygift', ';msg-param-mass-gift-count=5');
notice('anonsubmysterygift', ';msg-param-mass-gift-count=3');
assert.equal(messages.length, 6, 'each notice reaches chat even with alerts disabled');
assert.equal(subscribers.length, 3, 'bulk gift summaries must not duplicate recipient alerts');
assert.equal(renewals.length, 1);
assert.equal(renewals[0].months, 12);
assert.equal(subscribers[1].username, 'Bob');
assert.equal(subscribers[2].username, 'Carol');
assert.equal(messages[0].user, 'Alice');
assert.match(messages[0].text, /оформил подписку \(Tier 1\) — Спасибо!/);
assert.match(messages[1].text, /месяцев: 12.*Снова с вами/);
assert.match(messages[2].text, /Bob/);
assert.equal(messages[3].user, 'Аноним');
assert.match(messages[4].text, /количество: 5/);
assert.match(messages[5].text, /количество: 3/);
for (const message of messages) {
  assert.equal(message.platform, 'twitch');
  assert.equal(message.systemEvent, 'twitch-subscription');
  assert.equal(message.highlighted, true);
  assert.deepEqual(message.parts, [{ type: 'text', text: message.text }]);
}
console.log('PASS Twitch subscriptions: real USERNOTICE parsing, renewals, gifts, anonymous and bulk gifts, disabled alerts');
