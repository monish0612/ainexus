'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { noteDiscoveryResult } = require('../src/litellm-discovery-policy');

test('a short outage does not page Telegram', () => {
  let state = { attempts: 0, alerted: false, downSince: 0 };
  let note = noteDiscoveryResult(state, { ok: false, now: 1 });
  state = note.state;
  assert.equal(note.telegram, null);
  note = noteDiscoveryResult(state, { ok: false, now: 2 });
  assert.equal(note.telegram, null);
  assert.equal(note.state.attempts, 2);
});

test('the third failure pages once, later failures stay quiet', () => {
  let state = { attempts: 2, alerted: false, downSince: 1 };
  let note = noteDiscoveryResult(state, { ok: false, now: 3 });
  assert.equal(note.telegram, 'down');
  state = note.state;
  note = noteDiscoveryResult(state, { ok: false, now: 4 });
  assert.equal(note.telegram, null);
  assert.equal(note.state.alerted, true);
  assert.equal(note.state.attempts, 4);
});

test('recovery pages once and resets the counter', () => {
  const note = noteDiscoveryResult(
    { attempts: 9, alerted: true, downSince: 1 },
    { ok: true, now: 10 },
  );
  assert.equal(note.telegram, 'recovered');
  assert.equal(note.state.attempts, 0);
  assert.equal(note.state.alerted, false);
});

test('a success that was never an outage stays silent', () => {
  const note = noteDiscoveryResult(
    { attempts: 0, alerted: false, downSince: 0 },
    { ok: true, now: 1 },
  );
  assert.equal(note.telegram, null);
});
