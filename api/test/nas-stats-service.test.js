'use strict';

// ═══════════════════════════════════════════════════════════════
//  NAS STATS SERVICE
//
//  The dashboard this feeds has one property that matters more than
//  any of its numbers: it must never lie. A NAS that is switched off
//  has to be reported as off — not as an error, not as zeros that
//  look like readings. So these tests are mostly about what the
//  service says when things go wrong, and about the two things that
//  protect a 4-core NAS that is also transcoding video: the cache
//  and the in-flight dedupe.
//
//  fetch and the Telegram module are both stubbed, so nothing here
//  touches the network or the real alert channel.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// ── stub Telegram before the service is loaded ────────────────────
// require.cache is keyed by resolved path, so seeding it makes the service pick up this fake
// on its own require('./telegram') without any injection seam in the production code.
const sent = [];
const tgPath = require.resolve(path.join(__dirname, '..', 'src', 'telegram.js'));
require.cache[tgPath] = new Module(tgPath, null);
require.cache[tgPath].filename = tgPath;
require.cache[tgPath].loaded = true;
require.cache[tgPath].exports = {
  tg: {
    d: (tag, msg) => sent.push({ level: 'd', tag, msg }),
    i: (tag, msg) => sent.push({ level: 'i', tag, msg }),
    w: (tag, msg) => sent.push({ level: 'w', tag, msg }),
    e: (tag, msg) => sent.push({ level: 'e', tag, msg }),
    fatal: (tag, msg) => sent.push({ level: 'fatal', tag, msg }),
  },
};

const svc = require('../src/nas-stats-service');

// ── a representative snapshot, shaped like the real one ──────────
function snapshot(over = {}) {
  return {
    api: 1,
    at: Math.floor(Date.now() / 1000),
    host: 'truenas',
    version: '25.04.2.6',
    uptime_s: 141353,
    cpu: { cores: 4, pct: 12.5, load1: 0.4, load5: 0.3, load15: 0.2 },
    memory: {
      total_mb: 7363, available_mb: 2430, free_mb: 1814,
      arc_mb: 1491, arc_cap_mb: 1536, pressure: 'ok',
    },
    pools: [
      { name: 'Storage', health: 'ONLINE', size_bytes: 493921239040,
        used_bytes: 183078453248, free_bytes: 310842785792, used_pct: 37, role: 'main' },
      { name: 'Backup', health: 'ONLINE', size_bytes: 996432412672,
        used_bytes: 172655915008, free_bytes: 823776497664, used_pct: 17, role: 'backup_usb' },
    ],
    movies: {
      dataset: 'Storage/media', path: '/mnt/Storage/media',
      used_bytes: 156145664000, avail_bytes: 295543554048, refer_bytes: 86350766080,
      headline_free_gb: 275, note: 'Deleting a film does not free this number for 14 days.',
    },
    snapshots: { count_storage: 325, held_bytes: 60786593792 },
    disks: [{ name: 'sda', role: 'Storage', temp_c: 42, ok: true }],
    services: { jellyfin: true, nextcloud: true, caddy: true, smb: true,
      media_watch: true, livetv: 'off_by_choice' },
    playback: { count: 0, items: [] },
    vps: {
      state: 'running', state_from: 'probe', reachable: true, steal_pct: 3.9,
      cpu_pct: 9.2, mem_pct: 27.3, disk_pct: 11.0, containers: 13, running: 13,
      throttled: false, conditions: [], case: 'OK', age_s: 120,
    },
    health: { stages_ok: 16, stages_total: 16, failing: [] },
    ...over,
  };
}

// ── a scripted fetch ─────────────────────────────────────────────
const realFetch = global.fetch;
let calls = 0;
let script = () => ({ status: 200, body: snapshot() });

function installFetch() {
  calls = 0;
  global.fetch = async (url, opts) => {
    calls += 1;
    const r = await script(url, opts, calls);
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.invalidJson) throw new SyntaxError('Unexpected token');
        return r.body;
      },
    };
  };
}

function reset() {
  sent.length = 0;
  svc._resetForTests();
  installFetch();
  process.env.NAS_SNAPSHOT_URL = 'http://10.10.10.2:8788/v1/snapshot';
  process.env.NAS_SNAPSHOT_TOKEN = 'test-token';
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1500';
  process.env.NAS_SNAPSHOT_TIMEOUT_MS = '4000';
}

test.after(() => {
  global.fetch = realFetch;
});

// ── happy path ───────────────────────────────────────────────────

test('a reachable NAS produces online:true and passes the snapshot through', async () => {
  reset();
  const snap = snapshot();
  script = () => ({ status: 200, body: snap });

  const env = await svc.getStats();

  assert.equal(env.online, true);
  assert.equal(env.reason, null);
  assert.equal(env.snapshot.movies.headline_free_gb, 275);
  assert.equal(env.snapshot.memory.pressure, 'ok');
  assert.equal(env.last_seen_at, snap.at);
  assert.ok(env.age_s >= 0 && env.age_s < 5, `age_s should be tiny, got ${env.age_s}`);
});

test('the bearer token is sent, and only in the Authorization header', async () => {
  reset();
  let seen = null;
  script = (url, opts) => {
    seen = { url, opts };
    return { status: 200, body: snapshot() };
  };

  await svc.getStats();

  assert.equal(seen.opts.headers.Authorization, 'Bearer test-token');
  // A token in the query string would be logged by every hop that logs a URL.
  assert.doesNotMatch(seen.url, /test-token/);
});

// ── the failure modes, which all have to stay 200-with-an-envelope ─

const failures = [
  {
    name: 'a timeout',
    script: () => ({ throw: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }),
    reason: 'timeout',
  },
  {
    name: 'a refused connection (the NAS is off)',
    script: () => ({ throw: Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }) }),
    reason: 'unreachable',
  },
  {
    name: 'a rejected token',
    script: () => ({ status: 401, body: { error: 'unauthorised' } }),
    reason: 'auth',
  },
  {
    name: 'a 500 from the daemon',
    script: () => ({ status: 500, body: {} }),
    reason: 'unreachable',
  },
  {
    name: 'a body that is not JSON',
    script: () => ({ status: 200, invalidJson: true }),
    reason: 'bad_payload',
  },
  {
    name: 'JSON that is missing the timestamp',
    script: () => ({ status: 200, body: { api: 1, cpu: {} } }),
    reason: 'bad_payload',
  },
  {
    name: 'a null body',
    script: () => ({ status: 200, body: null }),
    reason: 'bad_payload',
  },
];

for (const f of failures) {
  test(`${f.name} yields online:false, reason:${f.reason}, and never throws`, async () => {
    reset();
    script = f.script;

    const env = await svc.getStats();

    assert.equal(env.online, false);
    assert.equal(env.reason, f.reason);
    assert.equal(env.snapshot, null);
    // The whole point of the envelope: the VPS half of the dashboard stays live even when
    // the NAS half cannot be read, because this process is the VPS.
    assert.ok(env.vps_live, 'vps_live must survive a NAS failure');
    assert.equal(typeof env.vps_live.mem_pct, 'number');
  });
}

test('a missing token degrades to not_configured without calling out', async () => {
  reset();
  delete process.env.NAS_SNAPSHOT_TOKEN;

  const env = await svc.getStats();

  assert.equal(env.online, false);
  assert.equal(env.reason, 'not_configured');
  assert.equal(calls, 0, 'must not attempt a request with no token');
});

// ── protecting the NAS ───────────────────────────────────────────

test('a second call inside the TTL is served from cache', async () => {
  reset();
  script = () => ({ status: 200, body: snapshot() });

  const a = await svc.getStats();
  const b = await svc.getStats();

  assert.equal(calls, 1, 'the second call must not reach the NAS');
  assert.equal(a, b, 'and must be the very same object');
});

test('once the TTL expires the NAS is asked again', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  script = () => ({ status: 200, body: snapshot() });

  await svc.getStats();
  await new Promise((r) => setTimeout(r, 5));
  await svc.getStats();

  assert.equal(calls, 2);
});

test('concurrent callers collapse into one upstream request', async () => {
  reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  script = async () => {
    await gate;
    return { status: 200, body: snapshot() };
  };

  const all = Promise.all([svc.getStats(), svc.getStats(), svc.getStats(), svc.getStats()]);
  release();
  const results = await all;

  assert.equal(calls, 1, 'four simultaneous polls must cost the NAS one request');
  assert.equal(results[0].online, true);
  for (const r of results) assert.equal(r, results[0]);
});

// ── Telegram discipline ──────────────────────────────────────────

test('the first result is not announced, however it turns out', async () => {
  reset();
  script = () => ({ throw: Object.assign(new Error('down'), { name: 'TypeError' }) });

  await svc.getStats();

  assert.equal(sent.length, 0, 'a NAS that was already off at boot is not news');
});

test('going offline is announced exactly once, not once per poll', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  script = () => ({ status: 200, body: snapshot() });
  await svc.getStats();                       // establishes "online"
  assert.equal(sent.length, 0);

  script = () => ({ throw: Object.assign(new Error('down'), { name: 'TypeError' }) });
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 3));
    await svc.getStats();
  }

  // At a 2-second poll, one message per failure would be thirty a minute into the same
  // channel that carries "your VPS is suspended".
  assert.equal(sent.length, 1, `expected exactly one message, got ${sent.length}`);
  assert.equal(sent[0].level, 'w');
  assert.equal(sent[0].tag, 'Cloud/stats');
  assert.match(sent[0].msg, /unaffected/i);
});

test('recovery is announced once, and the pair reads as a story', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  script = () => ({ status: 200, body: snapshot() });
  await svc.getStats();

  script = () => ({ throw: Object.assign(new Error('down'), { name: 'TypeError' }) });
  await new Promise((r) => setTimeout(r, 3));
  await svc.getStats();

  script = () => ({ status: 200, body: snapshot() });
  await new Promise((r) => setTimeout(r, 3));
  await svc.getStats();
  await new Promise((r) => setTimeout(r, 3));
  await svc.getStats();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, 'i');
  assert.match(sent[1].msg, /answering again/i);
});

test('a rejected token is an error, and names both sides of the mismatch', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  script = () => ({ status: 200, body: snapshot() });
  await svc.getStats();

  script = () => ({ status: 401, body: {} });
  await new Promise((r) => setTimeout(r, 3));
  await svc.getStats();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 'e');
  assert.match(sent[0].msg, /NAS_SNAPSHOT_TOKEN/);
  assert.match(sent[0].msg, /STATUS_TOKEN/);
});

test('no message ever carries the token', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  process.env.NAS_SNAPSHOT_TOKEN = 'super-secret-value';
  script = () => ({ status: 200, body: snapshot() });
  await svc.getStats();
  script = () => ({ status: 401, body: {} });
  await new Promise((r) => setTimeout(r, 3));
  await svc.getStats();

  for (const m of sent) assert.doesNotMatch(m.msg, /super-secret-value/);
});

// ── the VPS half ─────────────────────────────────────────────────

test('cpuPct refuses to invent a figure it cannot measure', () => {
  const a = { idle: 800, total: 1000 };
  const b = { idle: 1600, total: 2000 };
  assert.equal(svc.cpuPct(b, a), 20);
  assert.equal(svc.cpuPct(b, null), null, 'no previous sample means no percentage');
  assert.equal(svc.cpuPct(a, a), null, 'no elapsed jiffies means no percentage');
  assert.equal(svc.cpuPct(a, b), null, 'counters going backwards means a reboot');
});

test('vps_live merges the NAS-sourced fields but nulls them when the NAS is off', () => {
  const withNas = svc.vpsLive({ steal_pct: 7.5, throttled: true, state: 'running',
    state_from: 'hostinger', containers: 13, age_s: 100 });
  assert.equal(withNas.steal_pct, 7.5);
  assert.equal(withNas.throttled, true);
  assert.equal(withNas.state, 'running');
  assert.equal(withNas.vps_stale, false);

  const without = svc.vpsLive(null);
  assert.equal(without.steal_pct, null, 'steal cannot be measured from inside a container');
  assert.equal(without.throttled, null);
  assert.equal(without.state, null);
  // Locally measurable things must not go null just because the NAS did.
  assert.equal(typeof without.mem_pct, 'number');
  assert.equal(typeof without.uptime_s, 'number');
});

test('stale VPS figures are flagged rather than presented as current', () => {
  assert.equal(svc.vpsLive({ age_s: 200 }).vps_stale, false);
  assert.equal(svc.vpsLive({ age_s: 901 }).vps_stale, true);
  assert.equal(svc.vpsLive({}).vps_stale, null, 'unknown age is not the same as fresh');
});

// ── degraded snapshots ───────────────────────────────────────────

test('a snapshot with null sections is still served, not rejected', async () => {
  reset();
  script = () => ({
    status: 200,
    body: snapshot({ disks: null, playback: null, snapshots: null, health: null, vps: null }),
  });

  const env = await svc.getStats();

  assert.equal(env.online, true, 'a SMART blip must not read as the NAS being off');
  assert.equal(env.snapshot.disks, null);
  assert.equal(env.snapshot.movies.headline_free_gb, 275, 'the good sections still arrive');
});

test('last_seen_at survives the NAS going away', async () => {
  reset();
  process.env.NAS_SNAPSHOT_CACHE_TTL_MS = '1';
  const snap = snapshot();
  script = () => ({ status: 200, body: snap });
  await svc.getStats();

  script = () => ({ throw: Object.assign(new Error('off'), { name: 'TypeError' }) });
  await new Promise((r) => setTimeout(r, 3));
  const env = await svc.getStats();

  assert.equal(env.online, false);
  assert.equal(env.last_seen_at, snap.at, 'the app needs this to say "last seen 3 min ago"');
});

// ── the renewal date ─────────────────────────────────────────────
//
// The rule these guard is inverted and invisible: a healthy auto-renewing VPS reports
// expires_at as null and puts the date in next_billing_at. vps-watch.py resolves that into a
// date plus a verb, and the contract here is that neither this layer nor the phone re-derives
// it — so what these actually check is that the verb survives, and that "renews" is never
// silently turned into "expires".

const billing = (over = {}) => ({
  at: 1755600000,
  error: null,
  vps: {
    name: 'KVM 2', status: 'active', auto_renew: true,
    due_at: '2026-09-18T03:37:38Z', due_kind: 'renews', days_left: 29,
    period: 1, period_unit: 'month', renewal_price: 209900, currency: 'INR',
  },
  others: [{
    name: '.COM Domain', status: 'non_renewing', auto_renew: false,
    due_at: '2029-06-27T09:31:38Z', due_kind: 'expires', days_left: 1043,
    period: 3, period_unit: 'year', renewal_price: 454934, currency: 'INR',
  }],
  ...over,
});

test('the resolved renewal date and its verb reach the phone unchanged', () => {
  svc._resetForTests();
  const v = svc.vpsLive({ billing: billing(), plan_name: 'KVM 2', vcpus: 2, ram_mb: 8192 });

  assert.equal(v.billing.vps.due_kind, 'renews',
    'an auto-renewing subscription must never be relabelled as expiring');
  assert.equal(v.billing.vps.due_at, '2026-09-18T03:37:38Z');
  assert.equal(v.billing.vps.days_left, 29);
  assert.equal(v.billing.vps.renewal_price, 209900, 'cents, for the UI to format');
  assert.equal(v.billing.from_cache, false);
  assert.equal(v.plan_name, 'KVM 2');
  assert.equal(v.vcpus, 2);
  assert.equal(v.plan_ram_mb, 8192);
});

test('the domain is carried alongside the VPS, never merged into it', () => {
  svc._resetForTests();
  const v = svc.vpsLive({ billing: billing() });

  assert.equal(v.billing.vps.name, 'KVM 2');
  assert.equal(v.billing.others.length, 1);
  assert.equal(v.billing.others[0].name, '.COM Domain');
  assert.equal(v.billing.others[0].due_kind, 'expires',
    'the domain really does expire, and must not be softened to "renews"');
});

test('a renewal date outlives the NAS being switched off', () => {
  svc._resetForTests();
  svc.vpsLive({ billing: billing() });

  // The NAS is now off, so the snapshot carries no VPS block at all.
  const after = svc.vpsLive(null);

  assert.equal(after.billing.vps.due_at, '2026-09-18T03:37:38Z',
    'a date that changes monthly must not be blanked by a NAS reboot');
  assert.equal(after.billing.from_cache, true, 'and it must admit that it is remembered');
  assert.ok(after.billing.age_s >= 0);
  // The live readings are still live: this cache is only for the slow-moving facts.
  assert.equal(typeof after.mem_pct, 'number');
});

test('unknown fields from a future daemon are dropped rather than forwarded', () => {
  svc._resetForTests();
  const v = svc.vpsLive({
    billing: billing({ vps: { ...billing().vps, secret_internal_field: 'nope' } }),
  });

  assert.equal(v.billing.vps.secret_internal_field, undefined);
  assert.equal(v.billing.vps.name, 'KVM 2', 'the known fields still come through');
});

test('a nonsense due_kind is dropped, not guessed at', () => {
  svc._resetForTests();
  const v = svc.vpsLive({ billing: billing({ vps: { ...billing().vps, due_kind: 'maybe' } }) });

  assert.equal(v.billing.vps.due_kind, null,
    'the UI picks its wording from this, so an unrecognised verb must not be passed on');
});

test('no billing anywhere yields null rather than an empty shell', () => {
  svc._resetForTests();
  assert.equal(svc.vpsLive(null).billing, null);
  assert.equal(svc.vpsLive({}).billing, null);
  assert.equal(svc.sanitiseBilling({ at: 1, error: 'HTTP 500', vps: null, others: [] }), null,
    'a failed billing lookup with nothing remembered is not a subscription');
});
