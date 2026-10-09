const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.TCHAT_TEST_MAIN || path.join(__dirname, '..', 'main.js'), 'utf8');

function harness() {
  const state = vm.createContext({
    streamWidgets: [], donationAlertsToken: 'isolated-test', donationAlertsBootstrapped: false,
    donationAlertsIds: new Set(), donationAlertsState: { donations: [] }, alertQueue: [],
    broadcastDonationAlertsState() {}, alerts: [], console,
    enqueueDonationAlert(donation) { state.alerts.push(donation); },
  });
  for (const name of ['normalizeDonationGiveawayParticipant', 'normalizeDonationGiveawayWidget', 'appendDonationGiveawayParticipant', 'registerDonationGiveawayDonor', 'normalizeDonationAlert', 'syncDonationAlerts']) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), state);
  }
  vm.runInContext(`
    function updateStreamWidget(id, patch) {
      streamWidgets = streamWidgets.map(widget => widget.id === id
        ? normalizeDonationGiveawayWidget({ ...widget, ...patch }) : widget);
    }
    streamWidgets = [normalizeDonationGiveawayWidget({
      id: 'october', type: 'donation-giveaway', enabled: true, status: 'running',
      startedAt: '2026-10-05T15:16:32.418Z', participants: [],
    })];
  `, state);
  state.rows = [];
  state.fetch = async () => ({ ok: true, json: async () => ({ data: state.rows }) });
  return state;
}

test('first DonationAlerts sync recovers donors since start without replaying alerts', async () => {
  const state = harness();
  state.rows = [
    { id: 'old', username: 'До розыгрыша', created_at: '2026-10-04T18:00:00Z' },
    { id: 'new', username: 'Первый', created_at: '2026-10-06T18:00:00Z' },
    { id: 'duplicate', username: ' первый ', created_at: '2026-10-07T18:00:00Z' },
  ];
  await vm.runInContext('syncDonationAlerts()', state);
  assert.equal(state.streamWidgets[0].participants.length, 1);
  assert.equal(state.streamWidgets[0].participants[0].user, 'Первый');
  assert.equal(state.alerts.length, 0);
  await vm.runInContext('syncDonationAlerts()', state);
  assert.equal(state.streamWidgets[0].participants.length, 1);
  state.rows.unshift({ id: 'live', username: 'Новый', created_at: '2026-10-09T18:00:00Z' });
  await vm.runInContext('syncDonationAlerts()', state);
  assert.equal(state.streamWidgets[0].participants.length, 2);
  assert.equal(state.alerts.length, 1);
});

test('live donation, manual entry, pause, hidden collection and persisted roster', () => {
  const state = harness();
  vm.runInContext(`
    registerDonationGiveawayDonor({username:'Донатер'});
    registerDonationGiveawayDonor({username:' донатер '});
    registerDonationGiveawayDonor({username:'Тест',isTest:true});
    registerDonationGiveawayDonor({username:' '});
    appendDonationGiveawayParticipant('october','Вручную','manual');
    streamWidgets[0].status='paused';
    registerDonationGiveawayDonor({username:'Пауза'});
    streamWidgets[0].status='running'; streamWidgets[0].enabled=false;
    registerDonationGiveawayDonor({username:'Скрыт'});
    streamWidgets=JSON.parse(JSON.stringify(streamWidgets)).map(normalizeDonationGiveawayWidget);
  `, state);
  assert.deepEqual(Array.from(state.streamWidgets[0].participants, p => p.user), ['Донатер', 'Вручную', 'Скрыт']);
  assert.equal(state.streamWidgets[0].participants[1].source, 'manual');
});
