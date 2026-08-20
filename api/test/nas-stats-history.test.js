'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const tgPath = require.resolve(path.join(__dirname, '..', 'src', 'telegram.js'));
require.cache[tgPath] = new Module(tgPath, null);
require.cache[tgPath].filename = tgPath;
require.cache[tgPath].loaded = true;
require.cache[tgPath].exports = {
  tg: { d() {}, i() {}, w() {}, e() {}, fatal() {} },
};

const hist = require('../src/nas-stats-history');
const svc = require('../src/nas-stats-service');

test.beforeEach(() => {
  hist._resetForTests();
  svc._resetForTests();
});

test('parseRange falls back to now rather than throwing', () => {
  assert.equal(hist.parseRange('7d'), '7d');
  assert.equal(hist.parseRange('30D'), '30d');
  assert.equal(hist.parseRange('nope'), 'now');
  assert.equal(hist.parseRange(null), 'now');
});

test('downsample keeps the last point in each bucket and caps the payload', () => {
  const stepped = hist.downsample([
    { t: 0, cpu: 1 }, { t: 10, cpu: 2 }, { t: 70, cpu: 3 }, { t: 80, cpu: 4 },
  ], 60);
  assert.deepEqual(stepped.map((p) => p.cpu), [2, 4]);
  const capped = hist.downsample(
    Array.from({ length: 1000 }, (_, i) => ({ t: i, cpu: i })),
    1,
    10,
  );
  assert.ok(capped.length <= 10);
});

test('recordEnvelope fills the live rings without inventing a NAS when it is off', async () => {
  hist.recordEnvelope({
    online: false,
    vps_live: { cpu_pct: 12.5, mem_pct: 40, disk_pct: 11, steal_pct: 3 },
  });
  const now = await hist.getHistory('now');
  assert.equal(now.vps.points.length, 1);
  assert.equal(now.vps.points[0].cpu, 12.5);
  assert.equal(now.nas.points.length, 0);
});

test('getHistory 7d uses fetchNas and never throws when it fails', async () => {
  const empty = await hist.getHistory('7d', {
    fetchNas: async () => { throw new Error('boom'); },
  });
  assert.equal(empty.range, '7d');
  assert.equal(empty.nas.online, false);
  assert.deepEqual(empty.nas.points, []);

  const filled = await hist.getHistory('7d', {
    fetchNas: async () => ({
      online: true,
      points: [{ t: 1, cpu: 9, mem: 20, disk: 37 }],
    }),
  });
  assert.equal(filled.nas.online, true);
  assert.equal(filled.nas.points[0].cpu, 9);
});

test('historyUrlFor rewrites the snapshot path and nothing else', () => {
  assert.equal(
    svc.historyUrlFor('http://10.0.1.1:18788/v1/snapshot', '7d'),
    'http://10.0.1.1:18788/v1/history?range=7d',
  );
});

test('fetchNasHistory degrades to empty on 404 rather than throwing', async () => {
  process.env.NAS_SNAPSHOT_URL = 'http://10.10.10.2:8788/v1/snapshot';
  process.env.NAS_SNAPSHOT_TOKEN = 'test-token';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try {
    const r = await svc.fetchNasHistory('7d');
    assert.equal(r.online, false);
    assert.equal(r.reason, 'not_configured');
    assert.deepEqual(r.points, []);
  } finally {
    global.fetch = realFetch;
  }
});

test('fetchNasHistory treats 401 as auth, not as a throw', async () => {
  process.env.NAS_SNAPSHOT_URL = 'http://10.10.10.2:8788/v1/snapshot';
  process.env.NAS_SNAPSHOT_TOKEN = 'test-token';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorised' }) });
  try {
    const r = await svc.fetchNasHistory('30d');
    assert.equal(r.online, false);
    assert.equal(r.reason, 'auth');
  } finally {
    global.fetch = realFetch;
  }
});

test('recordEnvelope drops non-numeric junk rather than poisoning the chart', async () => {
  hist.recordEnvelope({
    online: true,
    snapshot: {
      cpu: { pct: 'hot' },
      memory: { total_mb: 1000, available_mb: 250 },
      pools: [{ role: 'main', used_pct: 37 }],
    },
    vps_live: { cpu_pct: Number.NaN, mem_pct: 40, disk_pct: 11 },
  });
  const now = await hist.getHistory('now');
  assert.equal(now.nas.points[0].cpu, null);
  assert.equal(now.nas.points[0].mem, 75);
  assert.equal(now.nas.points[0].disk, 37);
  assert.equal(now.vps.points[0].cpu, null);
  assert.equal(now.vps.points[0].mem, 40);
});

test('getHistory now does not call fetchNas', async () => {
  let called = 0;
  hist.recordEnvelope({
    online: true,
    snapshot: { cpu: { pct: 8 }, memory: { total_mb: 100, available_mb: 40 }, pools: [] },
    vps_live: { cpu_pct: 1, mem_pct: 2, disk_pct: 3 },
  });
  const now = await hist.getHistory('now', {
    fetchNas: async () => { called += 1; return { online: true, points: [] }; },
  });
  assert.equal(called, 0);
  assert.ok(now.vps.points.length >= 1);
});
