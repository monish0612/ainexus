'use strict';

/**
 * Reads the home NAS's status snapshot and re-serves it to the phone.
 *
 * The NAS runs nas-status.py on 10.10.10.2:8788, reachable from this container over the
 * WireGuard tunnel. That daemon holds the bearer token; so does this process, in
 * NAS_SNAPSHOT_TOKEN. The phone holds neither — it authenticates with the app JWT it already
 * has, and this route is the only thing that ever sees the NAS credential. That is the whole
 * reason this module exists rather than the app calling the NAS directly: one fewer secret on
 * a device that can be lost, and no second hostname, DNS record or certificate to maintain.
 *
 * Two things it deliberately does that a naive proxy would not:
 *
 * 1. It always answers 200 with an envelope. "The NAS is switched off" is a normal, expected
 *    state that the dashboard renders as a dull screen of zeros, and it must be
 *    distinguishable from "your phone has no signal". If this returned 502 for an unreachable
 *    NAS, the app could not tell the two apart and would show a network error for a NAS the
 *    owner switched off deliberately.
 *
 * 2. It reports the VPS's own figures from this process, not from the NAS. The NAS's snapshot
 *    carries a VPS block sourced from vps-status.json, but that is written every five minutes
 *    and, more importantly, it is gone entirely when the NAS is off. The machine answering
 *    this request is self-evidently up, so its CPU, memory and disk can always be measured
 *    here and the VPS screen never goes dark just because the NAS did.
 */

const os = require('os');
const fs = require('fs');
const { tg } = require('./telegram');

const DEFAULT_URL = 'http://10.10.10.2:8788/v1/snapshot';

// Kept short on purpose. Its job is to collapse a burst — the app polling every 2s while a
// pull-to-refresh lands on top of it — into one upstream call, not to serve stale data. The
// NAS resamples every 2s, so a TTL longer than that would throw away freshness the daemon
// already paid for.
const DEFAULT_CACHE_TTL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 4000;

function cfg() {
  return {
    url: process.env.NAS_SNAPSHOT_URL || DEFAULT_URL,
    token: process.env.NAS_SNAPSHOT_TOKEN || '',
    timeoutMs: Number(process.env.NAS_SNAPSHOT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    cacheTtlMs: Number(process.env.NAS_SNAPSHOT_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS,
  };
}

// ── state ────────────────────────────────────────────────────────────────────────
// Module-level and intentionally not exported: a second copy would double the upstream load
// and split the transition tracking, which is what makes the Telegram line fire once.
const _cache = { value: null, expiresAt: 0 };
let _inflight = null;
let _lastSeenAt = null;
let _wasOnline = null;      // null until the first result, so startup is not a "transition"
let _prevCpu = null;
// Survives the NAS being switched off, because a renewal date does not stop being true when the
// machine that relayed it goes away. See sanitiseBilling.
let _lastBilling = null;

function _resetForTests() {
  _cache.value = null;
  _cache.expiresAt = 0;
  _inflight = null;
  _lastSeenAt = null;
  _wasOnline = null;
  _prevCpu = null;
  _lastBilling = null;
}

// ── the VPS, measured here ───────────────────────────────────────────────────────

/**
 * Aggregate CPU jiffies across all cores.
 *
 * os.cpus() reports counters since boot, so a percentage only exists as a difference between
 * two readings. The first call after startup therefore has nothing to compare against and
 * cpu_pct is null rather than a fabricated zero — a dashboard showing 0% on a busy machine is
 * worse than one showing a dash.
 */
function cpuTotals() {
  const cpus = os.cpus() || [];
  if (cpus.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total, cores: cpus.length };
}

function cpuPct(cur, prev) {
  if (!cur || !prev) return null;
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.round(Math.max(0, Math.min(100, (100 * (total - idle)) / total)) * 10) / 10;
}

/**
 * Root filesystem usage.
 *
 * statfsSync landed in Node 18.15. It is called through a guard rather than assumed, because
 * an older runtime should cost this one field and not the whole VPS block.
 */
function rootDisk() {
  try {
    if (typeof fs.statfsSync !== 'function') return { pct: null, totalGb: null, freeGb: null };
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return { pct: null, totalGb: null, freeGb: null };
    return {
      pct: Math.round(((total - free) / total) * 1000) / 10,
      totalGb: Math.round((total / 1024 ** 3) * 10) / 10,
      freeGb: Math.round((free / 1024 ** 3) * 10) / 10,
    };
  } catch {
    return { pct: null, totalGb: null, freeGb: null };
  }
}

/**
 * What this machine can say about itself, plus whatever the NAS knew about it.
 *
 * steal_pct, throttled and Hostinger's own state cannot be measured from inside a container —
 * they come from vps-watch.py via the NAS. So they are merged in when available and left null
 * when the NAS is off, with vps_age_s telling the UI how old they are. The locally measured
 * fields never go null while this process is answering, which is the point.
 */
function vpsLive(nasVps) {
  const cur = cpuTotals();
  const pct = cpuPct(cur, _prevCpu);
  if (cur) _prevCpu = cur;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg() || [0, 0, 0];
  const disk = rootDisk();
  const v = nasVps || {};

  return {
    cpu_pct: pct,
    cores: cur ? cur.cores : null,
    load1: round2(load[0]),
    load5: round2(load[1]),
    load15: round2(load[2]),
    mem_pct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : null,
    mem_total_gb: totalMem ? Math.round((totalMem / 1024 ** 3) * 10) / 10 : null,
    mem_free_gb: totalMem ? Math.round((freeMem / 1024 ** 3) * 10) / 10 : null,
    disk_pct: disk.pct,
    disk_total_gb: disk.totalGb,
    disk_free_gb: disk.freeGb,
    uptime_s: Math.round(os.uptime()),

    // From the NAS when it is reachable; null, not zero, when it is not.
    state: v.state ?? null,
    state_from: v.state_from ?? null,
    reachable: v.reachable ?? null,
    steal_pct: v.steal_pct ?? null,
    throttled: v.throttled ?? null,
    conditions: Array.isArray(v.conditions) ? v.conditions : [],
    containers: v.containers ?? null,
    running: v.running ?? null,
    vps_age_s: v.age_s ?? null,
    // vps-watch.py samples every 5 minutes, so anything past 15 is reported as stale rather
    // than quietly presented as current. docs/31 section 5.1.
    vps_stale: typeof v.age_s === 'number' ? v.age_s > 900 : null,

    // What Hostinger says the machine is, as opposed to what it is currently doing. Only
    // populated once something has made vps-watch.py call the API, so null on a long healthy
    // run — the screen shows the locally measured figures either way and treats these as
    // labels, never as the reading.
    plan_name: v.plan_name ?? null,
    vcpus: v.vcpus ?? null,
    plan_ram_mb: v.ram_mb ?? null,
    plan_disk_mb: v.disk_mb ?? null,
    hostname: v.hostname ?? null,

    // The renewal date, already resolved to a date plus the verb it must be said with. Passed
    // through untouched: vps-watch.py owns the auto-renewal rule, and re-deriving it here would
    // be a second place to invert it. See the long note on api_plan in vps-watch.py.
    billing: sanitiseBilling(v.billing),
  };
}

function round2(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : null;
}

/**
 * The renewal date, whitelisted, and remembered across the NAS going away.
 *
 * Two jobs. The first is to copy only the fields the screen knows about, so that a future field
 * added to the NAS daemon cannot arrive on a phone that has no idea what to do with it.
 *
 * The second is the reason this holds state at all. Everything else in the VPS block is a live
 * reading that is meaningless once stale, but a renewal date moves once a month — so when the
 * NAS is switched off, blanking it would be strictly worse than showing yesterday's answer.
 * It is therefore kept and re-served with from_cache set, and the screen says how old it is
 * rather than pretending it was just measured. A date the owner can see and distrust beats an
 * empty space he cannot interpret.
 */
function sanitiseBilling(b) {
  const pick = (s) => (s && typeof s === 'object' ? {
    name: typeof s.name === 'string' ? s.name.slice(0, 60) : null,
    status: s.status ?? null,
    auto_renew: typeof s.auto_renew === 'boolean' ? s.auto_renew : null,
    due_at: typeof s.due_at === 'string' ? s.due_at : null,
    due_kind: s.due_kind === 'renews' || s.due_kind === 'expires' ? s.due_kind : null,
    days_left: typeof s.days_left === 'number' ? s.days_left : null,
    period: typeof s.period === 'number' ? s.period : null,
    period_unit: typeof s.period_unit === 'string' ? s.period_unit : null,
    renewal_price: typeof s.renewal_price === 'number' ? s.renewal_price : null,
    currency: typeof s.currency === 'string' ? s.currency : null,
  } : null);

  if (b && typeof b === 'object' && (b.vps || (Array.isArray(b.others) && b.others.length))) {
    const clean = {
      at: typeof b.at === 'number' ? b.at : null,
      error: b.error ?? null,
      vps: pick(b.vps),
      // Capped: the domain is the only other subscription today, and an account that grows to
      // fifty should not turn a stats poll into a large response.
      others: Array.isArray(b.others) ? b.others.slice(0, 8).map(pick).filter(Boolean) : [],
      from_cache: false,
      age_s: typeof b.at === 'number' ? Math.max(0, Math.floor(Date.now() / 1000) - b.at) : null,
    };
    _lastBilling = clean;
    return clean;
  }

  if (_lastBilling) {
    return {
      ..._lastBilling,
      from_cache: true,
      age_s: typeof _lastBilling.at === 'number'
        ? Math.max(0, Math.floor(Date.now() / 1000) - _lastBilling.at)
        : null,
    };
  }
  return null;
}

// ── the NAS ──────────────────────────────────────────────────────────────────────

async function fetchSnapshot() {
  const { url, token, timeoutMs } = cfg();
  if (!token) return { ok: false, reason: 'not_configured' };

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout and a refused connection mean different things to the reader: one is a NAS
    // that is up but wedged, the other is a NAS that is off. Both render the same dull
    // screen, but the log line should not lie about which happened.
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'unreachable' };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: 'unreachable' };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!body || typeof body !== 'object' || typeof body.at !== 'number') {
    return { ok: false, reason: 'bad_payload' };
  }
  return { ok: true, snapshot: body };
}

/**
 * Log only when online-ness changes.
 *
 * The app polls every 2 seconds. Logging each failure would put thirty messages a minute into
 * Telegram for a NAS that is merely switched off, which is how the channel that also carries
 * "your VPS is suspended" gets muted. The first result after startup is not a transition.
 */
function noteTransition(online, reason) {
  if (_wasOnline === online) return;
  const first = _wasOnline === null;
  _wasOnline = online;
  if (first) return;

  if (online) {
    tg.i('Cloud/stats', 'NAS status daemon is answering again; the stats screen is live.');
  } else if (reason === 'auth') {
    tg.e(
      'Cloud/stats',
      'NAS rejected the status token (401). The stats screen will show the NAS as off until '
        + 'NAS_SNAPSHOT_TOKEN here matches STATUS_TOKEN in nas-status.env on the NAS.',
    );
  } else if (reason === 'not_configured') {
    tg.w('Cloud/stats', 'NAS_SNAPSHOT_TOKEN is not set, so the stats screen has no data source.');
  } else {
    tg.w(
      'Cloud/stats',
      `NAS status daemon is not answering (${reason}); the stats screen will show it as off. `
        + 'Films, files and remote access are unaffected.',
    );
  }
}

function envelope(result) {
  const now = Math.floor(Date.now() / 1000);
  const online = result.ok === true;
  if (online) _lastSeenAt = result.snapshot.at || now;
  noteTransition(online, result.reason);

  const snapshot = online ? result.snapshot : null;
  return {
    online,
    reason: online ? null : result.reason,
    at: now,
    // How old the NAS's own sample is, which is not the same as how long ago we asked. The
    // daemon serves its last successful sample, so this is the number that says whether the
    // figures on screen are actually moving.
    age_s: online ? Math.max(0, now - (snapshot.at || now)) : null,
    last_seen_at: _lastSeenAt,
    snapshot,
    vps_live: vpsLive(snapshot ? snapshot.vps : null),
  };
}

/**
 * The route's only entry point. Never throws, never rejects.
 *
 * Concurrent callers share one upstream request through _inflight, so a client that fires
 * several polls at once cannot multiply load on a 4-core NAS that is also transcoding video.
 */
async function getStats() {
  const now = Date.now();
  if (_cache.value && _cache.expiresAt > now) return _cache.value;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const result = await fetchSnapshot();
      const env = envelope(result);
      _cache.value = env;
      _cache.expiresAt = Date.now() + cfg().cacheTtlMs;
      return env;
    } catch (err) {
      // Belt and braces. fetchSnapshot already swallows its own failures, so reaching here
      // means a bug in this module, and the dashboard should still render rather than 500.
      tg.e('Cloud/stats', `unexpected failure building the envelope: ${err.message}`, err);
      return envelope({ ok: false, reason: 'unreachable' });
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

module.exports = {
  getStats,
  // Exported for the tests only.
  _resetForTests,
  cpuPct,
  vpsLive,
  fetchSnapshot,
  envelope,
  sanitiseBilling,
};
