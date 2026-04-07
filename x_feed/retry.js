'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Generic retry utilities with exponential backoff + jitter
//
//  Reusable across fetcher, summarizer, and any future modules.
//  Telegram-logged at every stage. Never throws silently.
// ═══════════════════════════════════════════════════════════════════════

import { tg, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from './config.js';

// ── Retryable error classifier ─────────────────────────────────────────

const RETRYABLE_PATTERN =
  /429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|EPIPE/i;

export function isRetryableError(error) {
  if (!error) return false;
  const msg = error.message || String(error);
  if (RETRYABLE_PATTERN.test(msg)) return true;
  if (error.status && (error.status === 429 || error.status >= 500)) return true;
  return false;
}

// ── Sleep with jitter ──────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function backoffDelay(attempt, base = RETRY_BASE_DELAY_MS, max = RETRY_MAX_DELAY_MS) {
  const exponential = base * Math.pow(2, attempt);
  const capped = Math.min(exponential, max);
  const jitter = Math.random() * capped * 0.3;
  return Math.round(capped + jitter);
}

// ── Core retry wrapper ─────────────────────────────────────────────────
//
//  Usage:
//    const result = await withRetry(() => fetchSomething(), {
//      maxAttempts: 3,
//      tag: 'X-FEED/fetch',
//      label: 'fetch posts @KobeissiLetter',
//    });
//
//  Options:
//    maxAttempts   — total attempts (default 3)
//    tag           — Telegram log tag
//    label         — human-readable label for logs
//    baseDelayMs   — initial backoff delay
//    maxDelayMs    — maximum backoff delay
//    onRetry       — callback(attempt, error) before each retry

export async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    tag = 'X-FEED/retry',
    label = 'operation',
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    onRetry,
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, baseDelayMs, maxDelayMs);
        tg.w(tag, `Retry ${attempt}/${maxAttempts - 1} for ${label} (wait ${delay}ms)`);
        if (typeof onRetry === 'function') onRetry(attempt, lastError);
        await sleep(delay);
      }
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      const isLast = attempt >= maxAttempts - 1;

      if (!retryable || isLast) {
        const status = retryable ? 'exhausted' : 'non-retryable';
        tg.e(tag, `${label} FAILED (${status}, attempt ${attempt + 1}/${maxAttempts})`, error);
        break;
      }
    }
  }

  throw lastError;
}

// ── Concurrency limiter ────────────────────────────────────────────────
//
//  Limits parallel async operations. Used when processing multiple dates.
//
//  Usage:
//    const limit = createLimiter(3);
//    await Promise.all(items.map(item => limit(() => process(item))));

export function createLimiter(concurrency) {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const next = queue.shift();
    next();
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            runNext();
          });
      });
      runNext();
    });
}
