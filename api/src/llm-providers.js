'use strict';

// ═══════════════════════════════════════════════════════════════
//  LLM PROVIDER REGISTRY — production-grade plug-and-play layer
//
//  Every provider implements a single contract:
//    complete(messages, opts) => string
//
//  opts shape: { temperature, max_tokens, model }
//
//  Built-in safety:
//    - Per-call timeout (default 60s, configurable)
//    - Retry with exponential backoff (up to 2 retries)
//    - Circuit breaker: auto-disable failing providers temporarily
//    - Automatic fallback to 'litellm' when non-default provider fails
//    - Full Telegram alerting on every failure and recovery
//
//  To add a new provider:
//    1. Create my-provider.js with your API logic
//    2. register('my-provider', { complete, isAvailable })
//    3. Add the option to the Flutter settings dropdown
// ═══════════════════════════════════════════════════════════════

let _tg = null;

function _initTg() {
  if (!_tg) {
    try { _tg = require('./telegram').tg; } catch { _tg = { d() {}, i() {}, w() {}, e() {} }; }
  }
  return _tg;
}

const _providers = new Map();

// ── Circuit breaker state per provider ─────────────────────────
const _circuitBreaker = new Map();
const _CB_THRESHOLD = 3;
const _CB_COOLDOWN_MS = 120_000; // 2 min cooldown after tripping

function _getCb(name) {
  if (!_circuitBreaker.has(name)) {
    _circuitBreaker.set(name, { failures: 0, openUntil: 0, lastError: null });
  }
  return _circuitBreaker.get(name);
}

function _recordSuccess(name) {
  const cb = _getCb(name);
  if (cb.failures > 0) {
    const tg = _initTg();
    tg.i('LLM-CB', `Circuit closed for "${name}" (recovered after ${cb.failures} failures)`);
  }
  cb.failures = 0;
  cb.openUntil = 0;
  cb.lastError = null;
}

function _recordFailure(name, err) {
  const cb = _getCb(name);
  cb.failures++;
  cb.lastError = err?.message || String(err);
  if (cb.failures >= _CB_THRESHOLD) {
    cb.openUntil = Date.now() + _CB_COOLDOWN_MS;
    const tg = _initTg();
    tg.e('LLM-CB', `Circuit OPEN for "${name}" — ${cb.failures} consecutive failures, cooldown ${_CB_COOLDOWN_MS / 1000}s`, err);
    console.error(`[LLM-CB] Circuit OPEN for "${name}" until ${new Date(cb.openUntil).toISOString()}`);
  }
}

function _isCircuitOpen(name) {
  const cb = _getCb(name);
  if (cb.failures < _CB_THRESHOLD) return false;
  if (Date.now() >= cb.openUntil) {
    // half-open: allow one attempt
    cb.failures = _CB_THRESHOLD - 1;
    return false;
  }
  return true;
}

// ── Constants ──────────────────────────────────────────────────
const _DEFAULT_TIMEOUT_MS = 60_000;
const _MAX_RETRIES = 2;

function _isRetryable(err) {
  const msg = err?.message || String(err);
  return /429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg);
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Register an LLM provider.
 *
 * @param {string} name         - Unique provider key (e.g. 'litellm', 'xgrok')
 * @param {object} provider
 * @param {function} provider.complete      - async (messages, opts) => string
 * @param {function} provider.isAvailable   - () => boolean
 * @param {number}   [provider.timeoutMs]   - Per-call timeout override
 * @param {boolean}  [provider.hasOwnRetry] - Set true if the provider handles its own retry
 */
function register(name, { complete, isAvailable, timeoutMs, hasOwnRetry }) {
  if (!name || typeof complete !== 'function') {
    throw new Error(`Invalid provider registration: ${name}`);
  }
  _providers.set(name, {
    complete,
    isAvailable: typeof isAvailable === 'function' ? isAvailable : () => true,
    timeoutMs: timeoutMs || _DEFAULT_TIMEOUT_MS,
    hasOwnRetry: Boolean(hasOwnRetry),
  });
  const tg = _initTg();
  tg.d('LLM-Reg', `Provider "${name}" registered (timeout=${timeoutMs || _DEFAULT_TIMEOUT_MS}ms, ownRetry=${Boolean(hasOwnRetry)})`);
}

/**
 * Call a registered provider with timeout, retry, and circuit breaker.
 *
 * @param {string} name       - Provider key
 * @param {Array}  messages   - Chat messages array
 * @param {object} opts       - { temperature, max_tokens, model }
 * @returns {Promise<string>} - The completion text
 */
async function complete(name, messages, opts = {}) {
  const tg = _initTg();
  const t0 = Date.now();

  const provider = _providers.get(name);
  if (!provider) {
    const err = new Error(`Unknown LLM provider: "${name}". Available: ${list().join(', ')}`);
    tg.e('LLM-Reg', err.message);
    throw err;
  }
  if (!provider.isAvailable()) {
    const err = new Error(`LLM provider "${name}" is not available (missing API key or config)`);
    tg.e('LLM-Reg', err.message);
    throw err;
  }
  if (_isCircuitOpen(name)) {
    const cb = _getCb(name);
    const err = new Error(`LLM provider "${name}" circuit is open (${cb.failures} failures, last: ${cb.lastError})`);
    tg.w('LLM-CB', `Skipping "${name}" — circuit open until ${new Date(cb.openUntil).toISOString()}`);
    throw err;
  }

  // Providers with built-in retry (e.g. xgrok.js callXGrok) skip the registry retry loop
  // to avoid multiplicative retry amplification (3 × 3 = 9 attempts).
  const maxRetries = provider.hasOwnRetry ? 0 : _MAX_RETRIES;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        tg.w('LLM-Retry', `${name} retry ${attempt}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      const timeoutMs = opts.timeoutMs || provider.timeoutMs;
      const result = await Promise.race([
        provider.complete(messages, opts),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`LLM provider "${name}" timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const elapsed = Date.now() - t0;
      _recordSuccess(name);

      if (attempt > 0) {
        tg.i('LLM-Retry', `${name} recovered on attempt ${attempt + 1} (${elapsed}ms)`);
      }

      return result;
    } catch (e) {
      lastError = e;
      const elapsed = Date.now() - t0;
      const retryable = _isRetryable(e);

      if (!retryable || attempt >= maxRetries) {
        _recordFailure(name, e);
        tg.e('LLM-Call', `${name} FAILED after ${attempt + 1} attempt(s) (${elapsed}ms): ${e.message?.slice(0, 150)}`);
        break;
      }
      console.warn(`[LLM] ${name} attempt ${attempt + 1} failed (retryable): ${e.message?.slice(0, 100)}`);
    }
  }

  throw lastError;
}

/**
 * Safe complete with automatic fallback.
 * Tries `name` first; if it fails AND a fallback provider is available, tries that.
 * Designed for the news ingestion pipeline where reliability > provider preference.
 *
 * @param {string}      name       - Preferred provider
 * @param {string|null} fallback   - Fallback provider key (null = no fallback)
 * @param {Array}       messages   - Chat messages
 * @param {object}      opts       - Completion options
 * @returns {Promise<{text: string, provider: string, elapsed: number}>}
 */
async function completeWithFallback(name, fallback, messages, opts = {}) {
  const tg = _initTg();
  const t0 = Date.now();

  try {
    const text = await complete(name, messages, opts);
    return { text, provider: name, elapsed: Date.now() - t0 };
  } catch (primaryErr) {
    if (!fallback || fallback === name || !has(fallback)) {
      throw primaryErr;
    }

    tg.w('LLM-Fallback', `"${name}" failed → falling back to "${fallback}": ${primaryErr.message?.slice(0, 100)}`);
    console.warn(`[LLM] ${name} → fallback to ${fallback}: ${primaryErr.message?.slice(0, 100)}`);

    try {
      const text = await complete(fallback, messages, opts);
      const elapsed = Date.now() - t0;
      tg.i('LLM-Fallback', `"${fallback}" succeeded after "${name}" failure (${elapsed}ms)`);
      return { text, provider: fallback, elapsed };
    } catch (fallbackErr) {
      tg.e('LLM-Fallback', `Both "${name}" AND "${fallback}" failed`, fallbackErr);
      throw fallbackErr;
    }
  }
}

/**
 * List all registered provider names that are currently available.
 * @returns {string[]}
 */
function list() {
  return [..._providers.entries()]
    .filter(([, p]) => p.isAvailable())
    .map(([name]) => name);
}

/**
 * Check if a provider is registered AND available AND circuit is not open.
 * @param {string} name
 * @returns {boolean}
 */
function has(name) {
  const p = _providers.get(name);
  if (!p || !p.isAvailable()) return false;
  return !_isCircuitOpen(name);
}

/**
 * List all registered provider names (including unavailable).
 * @returns {string[]}
 */
function listAll() {
  return [..._providers.keys()];
}

/**
 * Get circuit breaker health for monitoring / /llm/config.
 * @returns {Object}
 */
function getHealth() {
  const health = {};
  for (const [name, p] of _providers.entries()) {
    const cb = _getCb(name);
    health[name] = {
      available: p.isAvailable(),
      circuitOpen: _isCircuitOpen(name),
      consecutiveFailures: cb.failures,
      lastError: cb.lastError,
    };
  }
  return health;
}

module.exports = { register, complete, completeWithFallback, list, has, listAll, getHealth };
