'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — 9 PM IST daily scheduler
//
//  Uses setTimeout (not setInterval) for drift-proof scheduling.
//  Each run calculates the exact ms until the next 9 PM IST window.
//  On startup, checks for catch-up needs and triggers immediately.
// ═══════════════════════════════════════════════════════════════════════

import {
  tg,
  isXGrokAvailable,
  X_FEED_HANDLES,
  SCHEDULE_TIMES_IST,
  IST_OFFSET_MS,
} from './config.js';
import { getSyncState } from './store.js';

// ── State ──────────────────────────────────────────────────────────────

let _timer = null;
let _runFn = null; // injected by index.js to avoid circular deps

// ── IST time calculations ──────────────────────────────────────────────

export function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

export function todayISTString() {
  return nowIST().toISOString().slice(0, 10);
}

export function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatTimeIST(isoString) {
  const d = new Date(isoString);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * Returns the ISO timestamp for "start of today IST" in UTC.
 * Used as the default "since" on first-ever run.
 */
export function startOfTodayISTasUTC() {
  const ist = nowIST();
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS).toISOString();
}

/**
 * Build human-readable labels for the fetch window.
 */
export function buildWindowLabels(sinceISO, untilISO) {
  const sinceDate = new Date(sinceISO);
  const untilDate = new Date(untilISO);

  const sinceIST = new Date(sinceDate.getTime() + IST_OFFSET_MS);
  const untilIST = new Date(untilDate.getTime() + IST_OFFSET_MS);

  const fmtDate = (d) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };

  const fmtTime = (d) => {
    let h = d.getUTCHours();
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm} IST`;
  };

  return {
    sinceLabel: `${fmtTime(sinceIST)} on ${fmtDate(sinceIST)}`,
    untilLabel: `${fmtTime(untilIST)} on ${fmtDate(untilIST)}`,
  };
}

// ── Scheduling ─────────────────────────────────────────────────────────

export function msUntilNextRun() {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  let bestMs = Infinity;

  for (const { hour, minute } of SCHEDULE_TIMES_IST) {
    const target = new Date(istNow);
    target.setUTCHours(hour, minute, 0, 0);
    if (target <= istNow) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    const targetUTC = new Date(target.getTime() - IST_OFFSET_MS);
    const ms = targetUTC.getTime() - now.getTime();
    if (ms < bestMs) bestMs = ms;
  }

  return Math.max(0, bestMs);
}

function nextRunLabel() {
  const ms = msUntilNextRun();
  const nextIST = new Date(Date.now() + ms + IST_OFFSET_MS);
  return nextIST.toISOString().slice(0, 19).replace('T', ' ') + ' IST';
}

export function scheduleNextRun() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  const ms = msUntilNextRun();
  const hours = (ms / 3600000).toFixed(1);
  const label = nextRunLabel();

  tg.i('X-FEED/sched', `Next run in ${hours}h at ${label}`);
  console.log(`[X-FEED] Next run in ${hours}h at ${label}`);

  _timer = setTimeout(async () => {
    if (typeof _runFn === 'function') {
      try {
        await _runFn({ reason: 'scheduled' });
      } catch (e) {
        tg.e('X-FEED/sched', 'Scheduled run failed', e);
      }
    }
    scheduleNextRun();
  }, ms);
}

// ── Start / stop ───────────────────────────────────────────────────────

export function startScheduler(runDailySyncFn) {
  _runFn = runDailySyncFn;

  if (!isXGrokAvailable()) {
    console.log('[X-FEED] xGrok not available — scheduler disabled');
    tg.w('X-FEED/sched', 'xGrok API key not set — scheduler disabled');
    return;
  }

  const handles = X_FEED_HANDLES.map((h) => `@${h.handle}`).join(', ');
  const timeLabel = SCHEDULE_TIMES_IST.map((t) => `${t.hour}:${String(t.minute).padStart(2, '0')}`).join(' & ') + ' IST';
  console.log(`[X-FEED] Scheduler starting: handles=[${handles}] times=${timeLabel}`);
  tg.i('X-FEED/sched', `Starting: handles=[${handles}], schedule=${timeLabel}`);

  // Check if catch-up is needed on startup:
  //   1. No sync state at all (first-ever run)
  //   2. Last sync was more than 18 hours ago (server downtime / missed schedule)
  const CATCHUP_THRESHOLD_MS = 18 * 60 * 60 * 1000;
  const needsCatchUp = X_FEED_HANDLES.some((h) => {
    const state = getSyncState(h.handle);
    if (!state || !state.last_window_end) return true;
    const lastSync = new Date(state.last_sync_at || 0).getTime();
    return Date.now() - lastSync > CATCHUP_THRESHOLD_MS;
  });

  if (needsCatchUp && typeof _runFn === 'function') {
    tg.i('X-FEED/sched', 'Catch-up needed — triggering startup sync in 10s');
    setTimeout(() => {
      _runFn({ reason: 'startup-catchup' }).catch((e) => {
        tg.e('X-FEED/sched', 'Startup catch-up failed', e);
      });
    }, 10_000);
  }

  scheduleNextRun();
}

export function stopScheduler() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    tg.i('X-FEED/sched', 'Scheduler stopped');
  }
  _runFn = null;
}

export function isSchedulerActive() {
  return _timer !== null;
}
