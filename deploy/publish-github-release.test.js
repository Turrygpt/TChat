'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publishRelease } = require('./publish-github-release');
const names = ['TChat-Setup-1.5.10.exe', 'TChat-Setup-1.5.10.exe.blockmap', 'latest.yml'];
function run(releases, { missing, failAt } = {}) {
  const calls = [];
  const invoke = () => publishRelease({ version: '1.5.10', repository: 'Turrygpt/TChat', target: 'abc123',
    exists: (file) => file !== missing,
    gh: (args) => { calls.push(args); if (calls.length === failAt) throw Error('GitHub failure'); return JSON.stringify(releases); },
  });
  return { calls, invoke };
}
test('new release stays draft until the complete update bundle is uploaded', () => {
  const { calls, invoke } = run([[]]); invoke();
  assert.equal(calls[1][1], 'create'); assert.ok(calls[1].includes('--draft'));
  assert.deepEqual(calls[2], ['release', 'upload', 'v1.5.10', ...names.map(n => `dist/${n}`), '--repo', 'Turrygpt/TChat', '--clobber']);
  assert.ok(calls[3].includes('--draft=false')); assert.ok(calls[3].includes('--latest'));
});
test('published complete release on a later API page is left untouched', () => {
  const { calls, invoke } = run([[], [{ tag_name: 'v1.5.10', draft: false, assets: names.map(name => ({ name, state: 'uploaded' })) }]]);
  invoke(); assert.equal(calls.length, 1);
});
test('existing draft resumes upload without attempting to create a release', () => {
  const { calls, invoke } = run([[{ tag_name: 'v1.5.10', draft: true, assets: [] }]]);
  invoke(); assert.deepEqual(calls.slice(1).map(c => c[1]), ['upload', 'edit']);
});
test('incomplete published release cannot mix artifacts from different builds', () => {
  const { calls, invoke } = run([[{ tag_name: 'v1.5.10', draft: false, assets: [] }]]);
  assert.throws(invoke, /original build artifacts/); assert.equal(calls.length, 1);
});
for (const missing of [...names.map(n => `dist/${n}`), 'dist/release-notes.md']) {
  test(`missing ${missing} stops before mutations`, () => {
    const { calls, invoke } = run([[]], { missing }); assert.throws(invoke, /Missing release file/); assert.equal(calls.length, 1);
  });
}
for (const failAt of [1, 2, 3, 4]) {
  test(`GitHub failure at call ${failAt} propagates and stops publication`, () => {
    const { calls, invoke } = run([[]], { failAt }); assert.throws(invoke, /GitHub failure/); assert.equal(calls.length, failAt);
  });
}
