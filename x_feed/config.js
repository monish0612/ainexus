'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Configuration, constants, and CJS bridge
// ═══════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// CJS bridge — single import point for all Grok + Telegram deps
export const { tg } = _require('../api/src/telegram');
export const {
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
} = _require('../api/src/xgrok');

// ── Tracked X handles ──────────────────────────────────────────────────

export const X_FEED_HANDLES = [
  {
    handle: 'KobeissiLetter',
    displayName: 'The Kobeissi Letter',
    category: 'Finance',
    tag: 'Daily Brief',
    defaultImage:
      'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
  },
];

// ── Schedule ───────────────────────────────────────────────────────────

export const SCHEDULE_HOUR_IST = 21;   // 9 PM
export const SCHEDULE_MINUTE_IST = 0;
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

// ── Retry / timeout ────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const FETCH_TIMEOUT_MS = 120_000;
export const SUMMARIZE_TIMEOUT_MS = 90_000;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 10_000;

// ── Vision (image analysis) ───────────────────────────────────────────

export const VISION_TIMEOUT_MS = 60_000;
export const VISION_CONCURRENCY = 3;
export const VISION_MAX_RETRIES = 2;
export const VISION_MAX_IMAGES_PER_RUN = 20;

// ── API ────────────────────────────────────────────────────────────────

export const XGROK_API_BASE = 'https://api.x.ai/v1';
