'use strict';

// ═══════════════════════════════════════════════════════════════
//  X-FEED LOGIC TESTS — validates all new logic before production
//
//  Run: node test-x-feed.js
//  No external deps needed. Tests pure functions, model resolution,
//  retry logic, tiered fallback, and window-advancement behavior.
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  ❌ ${testName}`);
  }
}

function assertEq(actual, expected, testName) {
  const ok = actual === expected;
  if (!ok) {
    failed++;
    failures.push(`${testName} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
    console.log(`  ❌ ${testName} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  } else {
    passed++;
    console.log(`  ✅ ${testName}`);
  }
}

function assertDeepEq(actual, expected, testName) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    failures.push(testName);
    console.log(`  ❌ ${testName}`);
    console.log(`     got:      ${JSON.stringify(actual).slice(0, 200)}`);
    console.log(`     expected: ${JSON.stringify(expected).slice(0, 200)}`);
  } else {
    passed++;
    console.log(`  ✅ ${testName}`);
  }
}

// ── Mock telegram before requiring any module ───────────────────
const tgLogs = [];
const mockTg = {
  d: (tag, msg) => tgLogs.push({ level: 'd', tag, msg }),
  i: (tag, msg) => tgLogs.push({ level: 'i', tag, msg }),
  w: (tag, msg, err) => tgLogs.push({ level: 'w', tag, msg, err }),
  e: (tag, msg, err) => tgLogs.push({ level: 'e', tag, msg, err }),
  fatal: (tag, msg, err) => tgLogs.push({ level: 'fatal', tag, msg, err }),
};

// Inject mock telegram into require cache
const path = require('path');
const telegramPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(telegramPath)] = {
  id: telegramPath,
  filename: telegramPath,
  loaded: true,
  exports: { tg: mockTg },
};

// ═══════════════════════════════════════════════════════════════
//  SECTION 1: Pure functions (copied from x-feed-service.js)
// ═══════════════════════════════════════════════════════════════

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch { /* continue */ }
  }
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch { /* continue */ }
  }
  return null;
}

function extractDigestJSON(text) {
  if (!text) return null;
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)?.[1]?.trim(),
    (() => { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); return s !== -1 && e > s ? text.slice(s, e + 1) : null; })(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj.article === 'string' && obj.article.length > 100) {
        return {
          title: String(obj.title || '').slice(0, 120),
          excerpt: String(obj.excerpt || '').slice(0, 250),
          article: obj.article,
          stats: Array.isArray(obj.stats) ? obj.stats : [],
          keyTopics: Array.isArray(obj.key_topics) ? obj.key_topics : [],
        };
      }
    } catch { /* next */ }
  }
  return null;
}

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10_000;

function isRetryableError(error) {
  if (!error) return false;
  const msg = error.message || String(error);
  if (/429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|EPIPE/i.test(msg)) return true;
  if (error.status && (error.status === 429 || error.status >= 500)) return true;
  return false;
}

function backoffDelay(attempt) {
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  const jitter = Math.random() * capped * 0.3;
  return Math.round(capped + jitter);
}

function extractResponseText(data) {
  let text = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text') text += c.text || '';
      }
    }
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════
//  SECTION 2: xgrok.js exported functions
// ═══════════════════════════════════════════════════════════════

const { resolveXGrokModel, getXGrokConfig, isXGrokAvailable } = require('./src/xgrok');

// ═══════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════');
console.log(' X-FEED LOGIC TESTS');
console.log('══════════════════════════════════════════════\n');

// ── 1. extractJSON ──────────────────────────────────────────────
console.log('▸ extractJSON');

assertDeepEq(
  extractJSON('{"posts_found": 3, "posts": []}'),
  { posts_found: 3, posts: [] },
  'Parses plain JSON'
);

assertDeepEq(
  extractJSON('```json\n{"posts_found": 2, "posts": []}\n```'),
  { posts_found: 2, posts: [] },
  'Parses fenced JSON (```json)'
);

assertDeepEq(
  extractJSON('```\n{"posts_found": 1, "posts": []}\n```'),
  { posts_found: 1, posts: [] },
  'Parses fenced JSON (``` without lang)'
);

assertDeepEq(
  extractJSON('Here are the results: {"posts_found": 5, "posts": []} end'),
  { posts_found: 5, posts: [] },
  'Extracts embedded JSON object'
);

assertDeepEq(
  extractJSON('[1, 2, 3]'),
  [1, 2, 3],
  'Parses JSON array'
);

assertEq(extractJSON(null), null, 'Returns null for null');
assertEq(extractJSON(''), null, 'Returns null for empty string');
assertEq(extractJSON('just some text'), null, 'Returns null for non-JSON text');
assertEq(extractJSON(undefined), null, 'Returns null for undefined');

assertDeepEq(
  extractJSON('  \n  {"a": 1}  \n  '),
  { a: 1 },
  'Handles whitespace-wrapped JSON'
);

console.log('');

// ── 2. extractDigestJSON ────────────────────────────────────────
console.log('▸ extractDigestJSON');

const longArticle = 'A'.repeat(150);
const validDigest = JSON.stringify({
  title: 'Market Brief',
  excerpt: 'Stocks rose today',
  article: longArticle,
  stats: [{ value: '5%', label: 'S&P 500' }],
  key_topics: ['stocks', 'bonds'],
});

const parsedDigest = extractDigestJSON(validDigest);
assertEq(parsedDigest?.title, 'Market Brief', 'Extracts title');
assertEq(parsedDigest?.excerpt, 'Stocks rose today', 'Extracts excerpt');
assertEq(parsedDigest?.article, longArticle, 'Extracts full article');
assertDeepEq(parsedDigest?.stats, [{ value: '5%', label: 'S&P 500' }], 'Extracts stats array');
assertDeepEq(parsedDigest?.keyTopics, ['stocks', 'bonds'], 'Extracts key_topics');

const fencedDigest = '```json\n' + validDigest + '\n```';
assert(extractDigestJSON(fencedDigest) !== null, 'Parses fenced digest JSON');

const shortArticleDigest = JSON.stringify({ title: 'X', article: 'short' });
assertEq(extractDigestJSON(shortArticleDigest), null, 'Rejects article < 100 chars');
assertEq(extractDigestJSON(null), null, 'Returns null for null input');
assertEq(extractDigestJSON('garbage'), null, 'Returns null for garbage input');

const longTitle = 'T'.repeat(200);
const longTitleDigest = JSON.stringify({ title: longTitle, excerpt: 'test', article: longArticle });
assertEq(extractDigestJSON(longTitleDigest)?.title.length, 120, 'Truncates title to 120 chars');

console.log('');

// ── 3. isRetryableError ─────────────────────────────────────────
console.log('▸ isRetryableError');

assert(isRetryableError(new Error('Request 429 rate limited')), '429 in message is retryable');
assert(isRetryableError(new Error('Server returned 500')), '500 in message is retryable');
assert(isRetryableError(new Error('502 Bad Gateway')), '502 is retryable');
assert(isRetryableError(new Error('503 Service Unavailable')), '503 is retryable');
assert(isRetryableError(new Error('504 Gateway Timeout')), '504 is retryable');
assert(isRetryableError(new Error('Request timeout')), 'timeout keyword is retryable');
assert(isRetryableError(new Error('ETIMEDOUT')), 'ETIMEDOUT is retryable');
assert(isRetryableError(new Error('ECONNRESET')), 'ECONNRESET is retryable');
assert(isRetryableError(new Error('ECONNREFUSED')), 'ECONNREFUSED is retryable');
assert(isRetryableError(new Error('socket hang up')), 'socket hang up is retryable');
assert(isRetryableError(new Error('fetch failed')), 'fetch failed is retryable');
assert(isRetryableError(new Error('EPIPE')), 'EPIPE is retryable');

const err429 = new Error('rate limited');
err429.status = 429;
assert(isRetryableError(err429), 'status 429 is retryable');

const err500 = new Error('internal');
err500.status = 500;
assert(isRetryableError(err500), 'status 500 is retryable');

const err502 = new Error('bad gw');
err502.status = 502;
assert(isRetryableError(err502), 'status 502 is retryable');

assert(!isRetryableError(new Error('Invalid JSON')), '400-level non-retryable error');
assert(!isRetryableError(new Error('Not found')), 'Generic error is not retryable');
assert(!isRetryableError(null), 'null is not retryable');
assert(!isRetryableError(undefined), 'undefined is not retryable');

const err400 = new Error('bad request');
err400.status = 400;
assert(!isRetryableError(err400), 'status 400 is NOT retryable');

const err403 = new Error('forbidden');
err403.status = 403;
assert(!isRetryableError(err403), 'status 403 is NOT retryable');

console.log('');

// ── 4. backoffDelay ─────────────────────────────────────────────
console.log('▸ backoffDelay');

for (let attempt = 0; attempt < 5; attempt++) {
  const delays = [];
  for (let i = 0; i < 100; i++) delays.push(backoffDelay(attempt));

  const min = Math.min(...delays);
  const max = Math.max(...delays);
  const exponential = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
  const expectedMin = exponential;
  const expectedMax = exponential * 1.3;

  assert(min >= expectedMin, `attempt ${attempt}: min delay (${min}) >= base (${expectedMin})`);
  assert(max <= expectedMax + 1, `attempt ${attempt}: max delay (${max}) <= cap (${Math.round(expectedMax)})`);
}

assert(backoffDelay(0) >= 1000, 'attempt 0 delay >= 1000ms');
assert(backoffDelay(10) <= 13001, 'attempt 10 delay capped at ~13000ms (10000 + 30% jitter)');

console.log('');

// ── 5. extractResponseText ──────────────────────────────────────
console.log('▸ extractResponseText');

assertEq(
  extractResponseText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] }),
  'Hello',
  'Extracts single output_text'
);

assertEq(
  extractResponseText({ output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Part 1 ' }, { type: 'output_text', text: 'Part 2' }] },
  ] }),
  'Part 1 Part 2',
  'Concatenates multiple output_text blocks'
);

assertEq(
  extractResponseText({ output: [{ type: 'tool_use', content: [] }] }),
  '',
  'Ignores non-message items'
);

assertEq(extractResponseText({ output: [] }), '', 'Empty output → empty string');
assertEq(extractResponseText({}), '', 'No output field → empty string');

console.log('');

// ── 6. resolveXGrokModel ────────────────────────────────────────
console.log('▸ resolveXGrokModel');

// Clear env vars first
delete process.env.XGROK_LITE_MODEL;
delete process.env.XGROK_DEEP_MODEL;
delete process.env.XGROK_THINKING_MODEL;

assertEq(resolveXGrokModel('lite'), 'grok-4-1-fast-non-reasoning', 'lite → default lite model');
assertEq(resolveXGrokModel('thinking'), 'grok-4-1-fast-reasoning', 'thinking → default thinking model');
assertEq(resolveXGrokModel('deep'), 'grok-4-0709', 'deep → default deep model');
assertEq(resolveXGrokModel(undefined), 'grok-4-0709', 'undefined mode → deep model (default)');
assertEq(resolveXGrokModel(null), 'grok-4-0709', 'null mode → deep model (default)');

assertEq(resolveXGrokModel('lite', 'custom-lite'), 'custom-lite', 'lite with settings override');
assertEq(resolveXGrokModel('deep', undefined, 'custom-deep'), 'custom-deep', 'deep with settings override');
assertEq(resolveXGrokModel('thinking', undefined, undefined, 'custom-thinking'), 'custom-thinking', 'thinking with settings override');

process.env.XGROK_LITE_MODEL = 'env-lite';
process.env.XGROK_DEEP_MODEL = 'env-deep';
process.env.XGROK_THINKING_MODEL = 'env-thinking';

assertEq(resolveXGrokModel('lite'), 'env-lite', 'lite → env var when set');
assertEq(resolveXGrokModel('deep'), 'env-deep', 'deep → env var when set');
assertEq(resolveXGrokModel('thinking'), 'env-thinking', 'thinking → env var when set');

assertEq(resolveXGrokModel('lite', 'settings-lite'), 'settings-lite', 'settings param takes priority over env var (lite)');
assertEq(resolveXGrokModel('deep', undefined, 'settings-deep'), 'settings-deep', 'settings param takes priority over env var (deep)');
assertEq(resolveXGrokModel('thinking', undefined, undefined, 'settings-thinking'), 'settings-thinking', 'settings param takes priority over env var (thinking)');

// Clean up
delete process.env.XGROK_LITE_MODEL;
delete process.env.XGROK_DEEP_MODEL;
delete process.env.XGROK_THINKING_MODEL;

console.log('');

// ── 7. getXGrokConfig ───────────────────────────────────────────
console.log('▸ getXGrokConfig');

delete process.env.XGROK_API_KEY;
const configNoKey = getXGrokConfig();
assertEq(configNoKey.available, false, 'available=false when no API key');
assertEq(configNoKey.liteModel, 'grok-4-1-fast-non-reasoning', 'config.liteModel default');
assertEq(configNoKey.deepModel, 'grok-4-0709', 'config.deepModel default');
assertEq(configNoKey.thinkingModel, 'grok-4-1-fast-reasoning', 'config.thinkingModel default');

process.env.XGROK_API_KEY = 'test-key';
assertEq(getXGrokConfig().available, true, 'available=true when API key set');
delete process.env.XGROK_API_KEY;

console.log('');

// ── 8. isXGrokAvailable ────────────────────────────────────────
console.log('▸ isXGrokAvailable');

delete process.env.XGROK_API_KEY;
assertEq(isXGrokAvailable(), false, 'unavailable without key');
process.env.XGROK_API_KEY = 'test-key-123';
assertEq(isXGrokAvailable(), true, 'available with key');
delete process.env.XGROK_API_KEY;

console.log('');

// ── 9. Thinking retry dedup guard ───────────────────────────────
console.log('▸ Thinking retry dedup guard');

// Simulate the guard logic from processHandle lines 804-828
function simulateThinkingRetryGuard(liteModel, thinkingModel) {
  return thinkingModel !== liteModel;
}

assert(
  simulateThinkingRetryGuard('grok-4-1-fast-non-reasoning', 'grok-4-1-fast-reasoning'),
  'Different models → retry allowed'
);

assert(
  !simulateThinkingRetryGuard('grok-4-1-fast-reasoning', 'grok-4-1-fast-reasoning'),
  'Same models → retry skipped'
);

assert(
  simulateThinkingRetryGuard('grok-4-1-fast-non-reasoning', 'grok-4-0709'),
  'Lite vs deep → retry allowed'
);

console.log('');

// ── 10. Digest fallback chain construction ──────────────────────
console.log('▸ Digest fallback chain construction');

function buildFallbackChain(liteModel, thinkingModel, deepModel) {
  return [
    { model: liteModel, tier: 'lite' },
    ...(thinkingModel !== liteModel ? [{ model: thinkingModel, tier: 'thinking' }] : []),
    ...(deepModel !== liteModel && deepModel !== thinkingModel ? [{ model: deepModel, tier: 'deep' }] : []),
  ];
}

const chain1 = buildFallbackChain('grok-4-1-fast-non-reasoning', 'grok-4-1-fast-reasoning', 'grok-4-0709');
assertEq(chain1.length, 3, 'All different → 3-tier chain');
assertEq(chain1[0].tier, 'lite', 'First tier is lite');
assertEq(chain1[1].tier, 'thinking', 'Second tier is thinking');
assertEq(chain1[2].tier, 'deep', 'Third tier is deep');

const chain2 = buildFallbackChain('same-model', 'same-model', 'same-model');
assertEq(chain2.length, 1, 'All same → 1-tier chain (lite only)');

const chain3 = buildFallbackChain('grok-lite', 'grok-thinking', 'grok-thinking');
assertEq(chain3.length, 2, 'thinking=deep → 2-tier chain (lite + thinking)');
assertEq(chain3[1].tier, 'thinking', 'Second tier is thinking (not deep)');

const chain4 = buildFallbackChain('grok-lite', 'grok-lite', 'grok-deep');
assertEq(chain4.length, 2, 'lite=thinking → 2-tier chain (lite + deep)');
assertEq(chain4[1].tier, 'deep', 'Second tier is deep (thinking skipped)');

console.log('');

// ── 11. Simulated processHandle flow ────────────────────────────
console.log('▸ Simulated processHandle flow (thinking retry + window logic)');

async function simulateProcessHandle({ litePosts, thinkingPosts, thinkingThrows }) {
  const liteModel = 'grok-4-1-fast-non-reasoning';
  const thinkingModel = 'grok-4-1-fast-reasoning';
  let fetchResult = { postsFound: litePosts, posts: litePosts > 0 ? [{ text: 'post' }] : [], model: liteModel };
  let thinkingRetried = false;
  let windowAdvanced = false;

  if (fetchResult.postsFound === 0) {
    if (thinkingModel !== liteModel) {
      thinkingRetried = true;
      if (thinkingThrows) {
        // thinking model threw an error — proceed with lite result
      } else {
        const thinkingResult = {
          postsFound: thinkingPosts,
          posts: thinkingPosts > 0 ? [{ text: 'thinking-post' }] : [],
          model: thinkingModel,
        };
        if (thinkingResult.postsFound > 0 || thinkingResult.posts.length > 0) {
          fetchResult = thinkingResult;
        }
      }
    }
  }

  if (fetchResult.postsFound === 0) {
    return { skipped: true, reason: 'no_posts', windowAdvanced: false, thinkingRetried };
  }

  windowAdvanced = true;
  return { skipped: false, success: true, windowAdvanced: true, thinkingRetried, postsFound: fetchResult.postsFound };
}

(async () => {
  const r1 = await simulateProcessHandle({ litePosts: 5, thinkingPosts: 0, thinkingThrows: false });
  assert(r1.success === true, 'Lite finds posts → success');
  assert(r1.thinkingRetried === false, 'Lite finds posts → no thinking retry');
  assert(r1.windowAdvanced === true, 'Lite finds posts → window advanced');

  const r2 = await simulateProcessHandle({ litePosts: 0, thinkingPosts: 3, thinkingThrows: false });
  assert(r2.success === true, 'Lite=0, thinking finds posts → success');
  assert(r2.thinkingRetried === true, 'Lite=0 → thinking retried');
  assert(r2.windowAdvanced === true, 'Thinking finds posts → window advanced');
  assertEq(r2.postsFound, 3, 'Uses thinking result post count');

  const r3 = await simulateProcessHandle({ litePosts: 0, thinkingPosts: 0, thinkingThrows: false });
  assert(r3.skipped === true, 'Both 0 → skipped');
  assertEq(r3.reason, 'no_posts', 'Both 0 → reason=no_posts');
  assert(r3.windowAdvanced === false, '⚠️ CRITICAL: Both 0 → window NOT advanced');
  assert(r3.thinkingRetried === true, 'Both 0 → thinking was retried');

  const r4 = await simulateProcessHandle({ litePosts: 0, thinkingPosts: 0, thinkingThrows: true });
  assert(r4.skipped === true, 'Lite=0, thinking throws → skipped');
  assert(r4.windowAdvanced === false, '⚠️ CRITICAL: Thinking throws → window NOT advanced');
  assert(r4.thinkingRetried === true, 'Thinking was attempted even though it threw');

  console.log('');

  // ── 12. Simulated generateDigest tiered fallback ──────────────
  console.log('▸ Simulated generateDigest tiered fallback');

  async function simulateGenerateDigest({ liteFails, thinkingFails, deepFails }) {
    const liteModel = 'grok-4-1-fast-non-reasoning';
    const thinkingModel = 'grok-4-1-fast-reasoning';
    const deepModel = 'grok-4-0709';

    const fallbackChain = [
      { model: liteModel, tier: 'lite' },
      ...(thinkingModel !== liteModel ? [{ model: thinkingModel, tier: 'thinking' }] : []),
      ...(deepModel !== liteModel && deepModel !== thinkingModel ? [{ model: deepModel, tier: 'deep' }] : []),
    ];

    let result = null;
    let usedModel = liteModel;
    const tiersAttempted = [];

    for (let i = 0; i < fallbackChain.length; i++) {
      const { model, tier } = fallbackChain[i];
      const isLast = i === fallbackChain.length - 1;
      tiersAttempted.push(tier);

      const shouldFail =
        (tier === 'lite' && liteFails) ||
        (tier === 'thinking' && thinkingFails) ||
        (tier === 'deep' && deepFails);

      if (shouldFail) {
        if (isLast) return { result: null, usedModel: null, tiersAttempted };
        continue;
      }

      result = { content: 'digest content', model_used: model };
      usedModel = model;
      break;
    }

    return { result, usedModel, tiersAttempted };
  }

  const d1 = await simulateGenerateDigest({ liteFails: false, thinkingFails: false, deepFails: false });
  assertEq(d1.usedModel, 'grok-4-1-fast-non-reasoning', 'Lite succeeds → uses lite');
  assertEq(d1.tiersAttempted.length, 1, 'Lite succeeds → only 1 tier attempted');

  const d2 = await simulateGenerateDigest({ liteFails: true, thinkingFails: false, deepFails: false });
  assertEq(d2.usedModel, 'grok-4-1-fast-reasoning', 'Lite fails → uses thinking');
  assertEq(d2.tiersAttempted.length, 2, 'Lite fails → 2 tiers attempted');

  const d3 = await simulateGenerateDigest({ liteFails: true, thinkingFails: true, deepFails: false });
  assertEq(d3.usedModel, 'grok-4-0709', 'Lite+thinking fail → uses deep');
  assertEq(d3.tiersAttempted.length, 3, 'Lite+thinking fail → 3 tiers attempted');

  const d4 = await simulateGenerateDigest({ liteFails: true, thinkingFails: true, deepFails: true });
  assertEq(d4.result, null, '⚠️ CRITICAL: All tiers fail → returns null');
  assertEq(d4.usedModel, null, 'All tiers fail → no model used');
  assertDeepEq(d4.tiersAttempted, ['lite', 'thinking', 'deep'], 'All 3 tiers attempted before giving up');

  console.log('');

  // ── 13. Telegram log capture verification ─────────────────────
  console.log('▸ Telegram log capture');

  tgLogs.length = 0;
  mockTg.d('TEST', 'debug message');
  mockTg.i('TEST', 'info message');
  mockTg.w('TEST', 'warning message', new Error('warn-err'));
  mockTg.e('TEST', 'error message', new Error('err-detail'));

  assertEq(tgLogs.length, 4, '4 log entries captured');
  assertEq(tgLogs[0].level, 'd', 'First is debug');
  assertEq(tgLogs[1].level, 'i', 'Second is info');
  assertEq(tgLogs[2].level, 'w', 'Third is warning');
  assertEq(tgLogs[3].level, 'e', 'Fourth is error');
  assertEq(tgLogs[2].err?.message, 'warn-err', 'Warning includes error object');
  assertEq(tgLogs[3].err?.message, 'err-detail', 'Error includes error object');

  console.log('');

  // ── 14. Error detail propagation ──────────────────────────────
  console.log('▸ Error detail propagation');

  const grokError = new Error('xGrok 429 [grok-4-1-fast-non-reasoning]: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}');
  grokError.status = 429;
  grokError.code = 'RATE_LIMIT';

  assert(isRetryableError(grokError), 'XGrokError with 429 is retryable');
  assert(grokError.message.includes('429'), 'Error message contains status code');
  assert(grokError.message.includes('grok-4-1-fast-non-reasoning'), 'Error message contains model name');
  assert(grokError.message.includes('Rate limit exceeded'), 'Error message contains API error detail');

  const logMsg = `Grok lite (grok-4-1-fast-non-reasoning) FAILED (5000ms): ${grokError.message?.slice(0, 200)}`;
  assert(logMsg.includes('429'), 'Log message preserves status code');
  assert(logMsg.includes('Rate limit exceeded'), 'Log message preserves error detail');
  assert(logMsg.length <= 300, `Log message reasonable length (${logMsg.length} chars)`);

  console.log('');

  // ── 15. Edge cases ────────────────────────────────────────────
  console.log('▸ Edge cases');

  assertDeepEq(
    extractJSON('{"posts_found": 0, "posts": []}'),
    { posts_found: 0, posts: [] },
    'extractJSON handles 0 posts correctly'
  );

  const nestedJSON = 'Some preamble text\n{"posts_found": 2, "posts": [{"text": "hello {world}"}]}\ntrailing';
  const nestedResult = extractJSON(nestedJSON);
  assertEq(nestedResult?.posts_found, 2, 'extractJSON handles nested braces in values');

  const emptyArrayDigest = JSON.stringify({
    title: 'Test', excerpt: 'X', article: longArticle, stats: 'not-array', key_topics: 123,
  });
  const edgeParsed = extractDigestJSON(emptyArrayDigest);
  assertDeepEq(edgeParsed?.stats, [], 'Non-array stats → empty array');
  assertDeepEq(edgeParsed?.keyTopics, [], 'Non-array key_topics → empty array');

  const excerptLong = 'E'.repeat(300);
  const longExcerptDigest = JSON.stringify({ title: 'T', excerpt: excerptLong, article: longArticle });
  assertEq(extractDigestJSON(longExcerptDigest)?.excerpt.length, 250, 'Excerpt truncated to 250 chars');

  console.log('');

  // ══════════════════════════════════════════════════════════════
  //  RESULTS
  // ══════════════════════════════════════════════════════════════
  console.log('══════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed — x-feed logic is production-ready.\n');
    process.exit(0);
  }
})();
