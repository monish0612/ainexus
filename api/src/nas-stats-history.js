'use strict';

/**
 * In-memory series for the Stats live chart and the 7D / 30D views.
 *
 * This is deliberately not a database. 1-second points exist only to make the
 * gauges and the "Now" sparkline breathe; 60-second points exist so a 7-day
 * chart has something to draw after the API process has been up. Both vanish
 * on restart. NAS 7D/30D is sourced from nas-status.py's own in-memory rings
 * (same contract: no disk) so a phone that was in a pocket overnight can still
 * open a week of CPU when the daemon stayed up.
 *
 * Nothing here is allowed to throw into getStats(). A history bug must cost
 * the chart, never the dashboard that was already working.
 */

const LIVE_MAX = 180;                 // ~3 minutes at 1 s
const MINUTE_MAX = 30 * 24 * 60;      // 30 days of 60 s points
const SERVE_CAP = 400;                // keep JSON small on the WG path

class Ring {
  constructor(max) {
    this.max = max;
    this.items = [];
  }

  push(point) {
    this.items.push(point);
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max);
    }
  }

  since(epochS) {
    if (epochS == null) return this.items.slice();
    return this.items.filter((p) => p.t >= epochS);
  }

  get last() {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  clear() {
    this.items = [];
  }
}

const _nasLive = new Ring(LIVE_MAX);
const _vpsLive = new Ring(LIVE_MAX);
const _vpsMinute = new Ring(MINUTE_MAX);
let _lastVpsMinuteT = 0;
let _sampler = null;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

function sanitisePoint(p, { steal = false } = {}) {
  const out = {
    t: Math.trunc(Number(p && p.t) || 0),
    cpu: num(p && p.cpu),
    mem: num(p && p.mem),
    disk: num(p && p.disk),
  };
  if (steal) out.steal = num(p && p.steal);
  return out;
}

function memUsedPct(memory) {
  if (!memory || typeof memory !== 'object') return null;
  const total = memory.total_mb;
  const avail = memory.available_mb;
  if (typeof total !== 'number' || typeof avail !== 'number' || total <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (100 * (total - avail)) / total)) * 10) / 10;
}

function mainPoolUsedPct(pools) {
  if (!Array.isArray(pools)) return null;
  const main = pools.find((p) => p && p.role === 'main') || pools[0];
  return main && typeof main.used_pct === 'number' ? main.used_pct : null;
}

function downsample(points, stepS, cap = SERVE_CAP) {
  const src = Array.isArray(points) ? points : [];
  if (!src.length) return [];
  let out;
  if (!stepS || stepS <= 1) {
    out = src.slice();
  } else {
    const buckets = new Map();
    for (const p of src) {
      if (!p || typeof p.t !== 'number') continue;
      const b = Math.floor(p.t / stepS) * stepS;
      buckets.set(b, p);
    }
    out = [...buckets.keys()].sort((a, b) => a - b).map((k) => buckets.get(k));
  }
  if (out.length > cap) {
    const stride = Math.max(1, Math.ceil(out.length / cap));
    out = out.filter((_, i) => i % stride === 0).slice(0, cap);
  }
  return out;
}

function parseRange(raw) {
  const r = String(raw || 'now').toLowerCase();
  if (r === 'now' || r === '7d' || r === '30d') return r;
  return 'now';
}

function pickVps(range) {
  const now = Math.floor(Date.now() / 1000);
  if (range === 'now') return { step_s: 1, points: downsample(_vpsLive.since(now - 180), 1) };
  if (range === '7d') {
    return { step_s: 600, points: downsample(_vpsMinute.since(now - 7 * 86400), 600) };
  }
  return { step_s: 3600, points: downsample(_vpsMinute.since(now - 30 * 86400), 3600) };
}

function recordEnvelope(env) {
  if (!env || typeof env !== 'object') return;
  const t = Math.floor(Date.now() / 1000);
  const vps = env.vps_live || {};
  _vpsLive.push(sanitisePoint({
    t,
    cpu: vps.cpu_pct,
    mem: vps.mem_pct,
    disk: vps.disk_pct,
    steal: vps.steal_pct,
  }, { steal: true }));
  maybeVpsMinute(t, vps);

  if (env.online && env.snapshot) {
    const snap = env.snapshot;
    _nasLive.push(sanitisePoint({
      t,
      cpu: snap.cpu && snap.cpu.pct,
      mem: memUsedPct(snap.memory),
      disk: mainPoolUsedPct(snap.pools),
    }));
  }
}

function maybeVpsMinute(t, vps) {
  if (t - _lastVpsMinuteT < 60) return;
  _lastVpsMinuteT = t;
  _vpsMinute.push(sanitisePoint({
    t,
    cpu: vps.cpu_pct,
    mem: vps.mem_pct,
    disk: vps.disk_pct,
    steal: vps.steal_pct,
  }, { steal: true }));
}

/**
 * Fills the VPS 7D/30D ring even when nobody is looking at the dashboard.
 * measure() should be cheap (this process's own CPU/RAM/disk) and must not
 * fetch the NAS — that would turn a background timer into extra tunnel load.
 */
function startVpsMinuteSampler(measure) {
  if (_sampler || typeof measure !== 'function') return;
  const tick = () => {
    try {
      const vps = measure() || {};
      maybeVpsMinute(Math.floor(Date.now() / 1000), vps);
    } catch {
      // A sampler fault is a missing 7D point, not a crashed API.
    }
  };
  _sampler = setInterval(tick, 60_000);
  if (typeof _sampler.unref === 'function') _sampler.unref();
}

function stopVpsMinuteSampler() {
  if (_sampler) clearInterval(_sampler);
  _sampler = null;
}

async function getHistory(rangeRaw, { fetchNas } = {}) {
  const range = parseRange(rangeRaw);
  const vps = pickVps(range);
  let nas = { online: false, reason: 'unreachable', step_s: vps.step_s, points: [] };

  if (range === 'now') {
    nas = {
      online: _nasLive.items.length > 0,
      reason: null,
      step_s: 1,
      points: downsample(_nasLive.since(Math.floor(Date.now() / 1000) - 180), 1),
    };
  } else if (typeof fetchNas === 'function') {
    try {
      const remote = await fetchNas(range);
      if (remote && typeof remote === 'object') {
        nas = {
          online: remote.online === true,
          reason: remote.reason || null,
          step_s: typeof remote.step_s === 'number' ? remote.step_s : vps.step_s,
          points: downsample(Array.isArray(remote.points) ? remote.points : [], 1)
            .slice(0, SERVE_CAP)
            .map((p) => sanitisePoint(p)),
        };
      }
    } catch {
      nas = { online: false, reason: 'unreachable', step_s: vps.step_s, points: [] };
    }
  }

  return {
    range,
    at: Math.floor(Date.now() / 1000),
    nas,
    vps: { points: vps.points, step_s: vps.step_s },
  };
}

function _resetForTests() {
  _nasLive.clear();
  _vpsLive.clear();
  _vpsMinute.clear();
  _lastVpsMinuteT = 0;
  stopVpsMinuteSampler();
}

module.exports = {
  recordEnvelope,
  getHistory,
  startVpsMinuteSampler,
  stopVpsMinuteSampler,
  parseRange,
  downsample,
  memUsedPct,
  mainPoolUsedPct,
  _resetForTests,
};
