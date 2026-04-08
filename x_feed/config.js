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

export const SCHEDULE_TIMES_IST = [
  { hour: 8, minute: 0 },   // 8 AM IST — morning digest
  { hour: 21, minute: 0 },  // 9 PM IST — evening digest
];
// Legacy single-schedule exports (used by scheduler.js)
export const SCHEDULE_HOUR_IST = 21;
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

// ── LiteLLM fallback (when xGrok is down) ──────────────────────────────
// Direct HTTP call to the LiteLLM proxy — avoids circular CJS deps.
// Returns the same { content, model_used, usage } shape as xgrokComplete.

export async function callLiteLLMFallback({ messages, temperature = 0.7, maxTokens = 4096, timeoutMs = 60_000 }) {
  const baseUrl = String(process.env.LITELLM_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('LITELLM_URL not configured — cannot fallback');

  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key.trim()}`;

  let model = null;
  try {
    const raw = process.env._LITELLM_MODEL_PRIORITY;
    if (raw) {
      const list = JSON.parse(raw);
      if (list.length > 0) model = list[0];
    }
  } catch {}

  const body = { messages, max_tokens: maxTokens, temperature };
  if (model) body.model = model;

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM fallback ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model_used: data.model || model || 'litellm-fallback',
    usage: data.usage || null,
  };
}
