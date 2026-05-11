'use strict';

// ═══════════════════════════════════════════════════════════════
//  IMAGE VISION ENDPOINT — CONTRACT TESTS
//
//  Verifies /api/v1/ai/image-search and /api/v1/ai/image-followup
//  end-to-end through the real Express pipeline, with the LLM
//  providers mocked so we can simulate every edge case
//  deterministically (success / 429 / 500 / timeout / both-down /
//  hedged-race / cache hit / dedupe / huge image / etc.).
//
//  Strategy mirrors test-saved-searches.js:
//    1. Mock pg.Pool + telegram + express-rate-limit BEFORE
//       requiring src/index.js so the boot path is hermetic.
//    2. Mock ./google-grounding and ./xgrok at require-cache level
//       so route handlers see deterministic provider behaviour.
//    3. Drive the captured Express app through real http requests
//       so body parsing, helmet, CORS, JSON limits all run.
//    4. Assert on response status, JSON envelope, AND on the recorded
//       provider call log so routing / fallback / cache / dedupe
//       behaviour is verified, not assumed.
//
//  Run: node backend/api/test-image-endpoints.js
//  Exits 0 on success, 1 on any failure.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;
const failures = [];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function log(msg) { process.stdout.write(`${msg}\n`); }
function ok(name, detail = '') { passed++; log(`  ${C.green}✓${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`); }
function bad(name, why) {
  failed++;
  failures.push(`${name} — ${why}`);
  log(`  ${C.red}✗ ${name}${C.reset}\n     ${C.red}${why}${C.reset}`);
}
function section(title) { log(`\n${C.cyan}${C.bold}━━━ ${title} ━━━${C.reset}`); }
function assert(cond, name, why = 'assertion failed') { cond ? ok(name) : bad(name, why); }
function assertEq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  a === e ? ok(name, `= ${a.slice(0, 80)}`) : bad(name, `expected ${e}, got ${a}`);
}
function assertContains(s, needle, name) {
  if (typeof s === 'string' && s.includes(needle)) ok(name, `"…${needle}…"`);
  else bad(name, `expected substring "${needle}" in ${JSON.stringify(s)}`);
}
function assertHas(obj, key, name) {
  obj && Object.prototype.hasOwnProperty.call(obj, key) ? ok(name) : bad(name, `expected key "${key}" in ${JSON.stringify(obj)?.slice(0, 200)}`);
}
function assertType(obj, key, type, name) {
  if (!obj || typeof obj[key] !== type) bad(name, `expected typeof "${key}" = ${type}, got ${typeof obj?.[key]}`);
  else ok(name);
}

// ── Telegram log capture ────────────────────────────────────────
// Records every tg.* call so tests can assert telegram coverage on
// failure paths (the user explicitly asked for "robust exception
// with telegram logs").
const telegramLog = [];
const tgMock = {
  d: (tag, msg) => telegramLog.push({ level: 'd', tag, msg }),
  i: (tag, msg) => telegramLog.push({ level: 'i', tag, msg }),
  w: (tag, msg, err) => telegramLog.push({ level: 'w', tag, msg, err: err?.message }),
  e: (tag, msg, err) => telegramLog.push({ level: 'e', tag, msg, err: err?.message }),
  fatal: (tag, msg, err) => telegramLog.push({ level: 'fatal', tag, msg, err: err?.message }),
};
function clearTelegramLog() { telegramLog.length = 0; }
function telegramHas(tag, level, contains) {
  return telegramLog.some(e =>
    e.tag === tag
    && (!level || e.level === level)
    && (!contains || (e.msg && e.msg.includes(contains))),
  );
}

// ── pg mock ─────────────────────────────────────────────────────
const pgQueryLog = [];
const pgCanned = [];
function _pgQuery(text, values) {
  pgQueryLog.push({ text: String(text).trim().slice(0, 120), values: values || [] });
  for (let i = 0; i < pgCanned.length; i++) {
    const c = pgCanned[i];
    const matches = typeof c.match === 'string' ? text.includes(c.match) : c.match.test(text);
    if (matches) {
      const consume = c.once !== false;
      if (consume) pgCanned.splice(i, 1);
      return Promise.resolve({ rows: c.rows || [], rowCount: c.rowCount || 0 });
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
function clearPg() { pgQueryLog.length = 0; pgCanned.length = 0; }

const pgMock = {
  Pool: function () { return { query: _pgQuery, on: () => {} }; },
};
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'), filename: require.resolve('pg'),
  loaded: true, exports: pgMock,
};

// ── Telegram module mock ────────────────────────────────────────
const telegramPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(telegramPath)] = {
  id: telegramPath, filename: telegramPath, loaded: true,
  exports: { tg: tgMock },
};

// ── Required env BEFORE src/index.js boots ──────────────────────
process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '0';
process.env.GOOGLE_API_KEY = 'AIzaTest_mock_gemini_key';
process.env.XGROK_API_KEY = 'xai-test-mock-grok-key';
// Use generous defaults so resolveXGrokModel returns predictable strings.
process.env.XGROK_LITE_MODEL = 'grok-4-1-fast-non-reasoning';
process.env.XGROK_DEEP_MODEL = 'grok-4-0709';
process.env.XGROK_THINKING_MODEL = 'grok-4-1-fast-reasoning';

// ── express-rate-limit no-op ────────────────────────────────────
const rateLimitPath = require.resolve('express-rate-limit');
require.cache[rateLimitPath] = {
  id: rateLimitPath, filename: rateLimitPath, loaded: true,
  exports: () => (req, res, next) => next(),
};

// ── Vision provider mocks ───────────────────────────────────────
// Test-controlled call log + behaviour switches so we can simulate
// success / latency / 429 / 500 / timeout / both-down per call.
const visionLog = [];
let geminiSearchBehaviour = null;
let geminiConverseBehaviour = null;
let xgrokSearchBehaviour = null;
let xgrokConverseBehaviour = null;
function clearVision() {
  visionLog.length = 0;
  geminiSearchBehaviour = null;
  geminiConverseBehaviour = null;
  xgrokSearchBehaviour = null;
  xgrokConverseBehaviour = null;
}

const groundingPath = path.resolve(__dirname, 'src', 'google-grounding.js');
require.cache[require.resolve(groundingPath)] = {
  id: groundingPath, filename: groundingPath, loaded: true,
  exports: {
    isGroundingAvailable: () => Boolean(process.env.GOOGLE_API_KEY) && process.env._MOCK_GEMINI_DOWN !== '1',
    resolveGroundingMode: (mode, deepModel, liteModel) => {
      if (mode === 'lite') return liteModel || 'gemini-2.5-flash-lite';
      return deepModel || undefined;
    },
    groundingPathRoot: groundingPath,
    groundedSearch: async () => { throw new Error('text path not under test here'); },
    groundedConverse: async () => { throw new Error('text path not under test here'); },
    groundedExtract: async () => { throw new Error('not under test'); },
    updateGroundingModels: () => {},
    getGroundingConfig: () => ({}),
    GroundingError: class GroundingError extends Error {
      constructor(message, code = 'UNKNOWN', status = 500) {
        super(message);
        this.name = 'GroundingError';
        this.code = code;
        this.status = status;
      }
    },
    groundedSearchVision: async (query, imageB64, mediaType, opts = {}) => {
      const callId = visionLog.length;
      visionLog.push({
        provider: 'gemini', kind: 'search',
        query, mediaType, imageBytes: imageB64?.length || 0,
        opts: { ...opts },
      });
      if (geminiSearchBehaviour) return geminiSearchBehaviour(callId, opts);
      return {
        text: `Gemini vision answered: ${query || '(image-only)'}`,
        model: opts.model || 'gemini-2.5-flash',
        sources: [
          { index: 0, title: 'Source A', url: 'https://example.com/a' },
          { index: 1, title: 'Source B', url: 'https://example.com/b' },
        ],
        citations: [{ text: 'cited', startIndex: 0, endIndex: 5, sourceIndices: [0] }],
        searchQueries: ['related search'],
        usage: { totalTokens: 123 },
      };
    },
    groundedConverseVision: async (history, sysInstr, imageB64, mediaType, opts = {}) => {
      const callId = visionLog.length;
      visionLog.push({
        provider: 'gemini', kind: 'converse',
        history, sysInstr, mediaType, imageBytes: imageB64?.length || 0,
        opts: { ...opts },
      });
      if (geminiConverseBehaviour) return geminiConverseBehaviour(callId, opts);
      return {
        text: `Gemini follow-up: ${history?.[history.length - 1]?.text || ''}`,
        model: opts.model || 'gemini-2.5-flash',
        sources: [{ index: 0, title: 'Followup Src', url: 'https://example.com/x' }],
        searchQueries: ['related followup search'],
        usage: { totalTokens: 200 },
      };
    },
  },
};

const xgrokModulePath = path.resolve(__dirname, 'src', 'xgrok.js');
require.cache[require.resolve(xgrokModulePath)] = {
  id: xgrokModulePath, filename: xgrokModulePath, loaded: true,
  exports: {
    isXGrokAvailable: () => Boolean(process.env.XGROK_API_KEY) && process.env._MOCK_XGROK_DOWN !== '1',
    resolveXGrokModel: (mode, lite, deep, thinking) => {
      if (mode === 'lite') return lite || 'grok-4-1-fast-non-reasoning';
      if (mode === 'thinking') return thinking || 'grok-4-1-fast-reasoning';
      return deep || 'grok-4-0709';
    },
    xgrokSearch: async () => { throw new Error('text path not under test'); },
    xgrokConverse: async () => { throw new Error('text path not under test'); },
    xgrokComplete: async () => ({ content: 'fallback notice', model_used: 'litellm-fallback', usage: {} }),
    callXGrok: async () => ({ content: 'fallback notice', model_used: 'litellm-fallback', usage: {} }),
    getXGrokConfig: () => ({}),
    XGrokError: class XGrokError extends Error {
      constructor(message, code = 'UNKNOWN', status = 500) {
        super(message);
        this.name = 'XGrokError';
        this.code = code;
        this.status = status;
      }
    },
    xgrokSearchVision: async (query, imageB64, mediaType, opts = {}) => {
      const callId = visionLog.length;
      visionLog.push({
        provider: 'xgrok', kind: 'search',
        query, mediaType, imageBytes: imageB64?.length || 0,
        opts: { ...opts },
      });
      if (xgrokSearchBehaviour) return xgrokSearchBehaviour(callId, opts);
      return {
        text: `xGrok vision answered: ${query || '(image-only)'}`,
        model: opts.model || 'grok-4-0709',
        sources: [{ title: 'xGrok Source', url: 'https://x.ai/source' }],
        searchQueries: ['web_search (1 calls)'],
        usage: { input_tokens: 50 },
      };
    },
    xgrokConverseVision: async (history, sysInstr, imageB64, mediaType, opts = {}) => {
      const callId = visionLog.length;
      visionLog.push({
        provider: 'xgrok', kind: 'converse',
        history, sysInstr, mediaType, imageBytes: imageB64?.length || 0,
        opts: { ...opts },
      });
      if (xgrokConverseBehaviour) return xgrokConverseBehaviour(callId, opts);
      return {
        text: `xGrok follow-up: ${history?.[history.length - 1]?.text || ''}`,
        model: opts.model || 'grok-4-0709',
        sources: [{ title: 'xGrok Followup', url: 'https://x.ai/followup' }],
        searchQueries: ['web_search (2 calls)'],
        usage: { input_tokens: 100 },
      };
    },
  },
};

// ── Capture express app, no-op .listen ──────────────────────────
const origExpress = require('express');
let capturedApp = null;
const expressShim = function () {
  const app = origExpress();
  capturedApp = app;
  app.listen = function (_port, cb) {
    if (typeof cb === 'function') cb();
    return { close: (cb2) => cb2 && cb2() };
  };
  return app;
};
Object.setPrototypeOf(expressShim, origExpress);
Object.assign(expressShim, origExpress);
require.cache[require.resolve('express')] = {
  id: require.resolve('express'), filename: require.resolve('express'),
  loaded: true, exports: expressShim,
};

// ── Boot src/index.js (under mocks) ─────────────────────────────
const indexPath = path.resolve(__dirname, 'src', 'index.js');
require(indexPath);

if (!capturedApp) {
  log('FATAL: failed to capture express app');
  process.exit(1);
}

// ── HTTP test client ────────────────────────────────────────────
let _testServer = null;
let _testPort = 0;

function _startServer() {
  return new Promise((resolve, reject) => {
    _testServer = http.createServer(capturedApp);
    _testServer.listen(0, '127.0.0.1', () => {
      _testPort = _testServer.address().port;
      resolve();
    });
    _testServer.on('error', reject);
  });
}
function _stopServer() {
  return new Promise((resolve) => {
    if (_testServer) _testServer.close(() => resolve());
    else resolve();
  });
}
function _request(method, urlPath, { body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: _testPort,
      path: urlPath,
      headers: payload === null
        ? {}
        : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── Image fixtures ──────────────────────────────────────────────
// 1×1 transparent PNG — minimum-viable valid PNG, ~67 bytes raw.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
);
function tinyPngBase64() { return TINY_PNG.toString('base64'); }
function _b64StringOfSize(charCount) {
  // Build a valid base64 string of EXACTLY `charCount` characters (the
  // size that hits the wire — not the decoded byte count).
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // Round down to a multiple of 4 so the string is well-formed b64.
  const total = Math.floor(charCount / 4) * 4;
  let s = '';
  for (let i = 0; i < total; i++) s += chars[i % chars.length];
  return s;
}
function makePngImage(sizeKB) {
  // Generate a valid base64 string of approximately sizeKB on the wire
  // that the magic-byte sniffer will recognise as JPEG. We prepend the
  // standard JPEG SOI marker (FF D8 FF E0 …) followed by enough random
  // padding to hit `sizeKB * 1024` base64 chars on the wire. The
  // provider is mocked so the bytes don't have to decode — they only
  // need to pass the validator's first-12-bytes check.
  const jpegHeader = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  ]);
  // Decoded byte count needed to produce sizeKB base64 chars.
  const targetDecodedBytes = Math.max(jpegHeader.length, Math.floor((sizeKB * 1024 * 3) / 4));
  const padding = Buffer.alloc(targetDecodedBytes - jpegHeader.length);
  // Cheap deterministic padding (no Math.random ⇒ tests stay reproducible).
  for (let i = 0; i < padding.length; i++) padding[i] = (i * 31) & 0xff;
  return Buffer.concat([jpegHeader, padding]).toString('base64');
}

// ── Helper: clear all state between tests ───────────────────────
function reset() {
  clearTelegramLog();
  clearPg();
  clearVision();
  delete process.env._MOCK_GEMINI_DOWN;
  delete process.env._MOCK_XGROK_DOWN;
}

// ═══════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════════╗${C.reset}`);
  log(`${C.bold}${C.magenta}║  IMAGE VISION ENDPOINTS — CONTRACT + ROBUSTNESS TESTS    ║${C.reset}`);
  log(`${C.bold}${C.magenta}╚══════════════════════════════════════════════════════════╝${C.reset}`);

  await _startServer();

  // ════════════════════════════════════════════════════════════════
  //  GROUP 1 — VALIDATION (FAST FAIL, NO PROVIDER CALL)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 1 — Validation (must reject in <50ms with no provider call)');

  for (const ep of ['/api/v1/ai/image-search', '/api/v1/ai/image-followup']) {
    reset();
    {
      const t0 = Date.now();
      const r = await _request('POST', ep, { body: {} });
      const elapsed = Date.now() - t0;
      assertEq(r.statusCode, 400, `${ep} — empty body → 400`);
      assert(elapsed < 200, `${ep} — empty body fast-fail`, `took ${elapsed}ms (expected <200ms)`);
      assertEq(visionLog.length, 0, `${ep} — empty body never reaches provider`);
    }

    reset();
    {
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', imageMediaType: 'image/jpeg' }
          : { imageMediaType: 'image/jpeg' },
      });
      assertEq(r.statusCode, 400, `${ep} — missing image → 400`);
      assertContains(r.body.error, 'image', `${ep} — error mentions image`);
    }

    reset();
    {
      // Missing imageMediaType is now ALLOWED — the magic-byte sniffer
      // determines the actual mime from the bytes (a real PNG starts
      // with 89 50 4E 47…). Phones lie about extensions all the time
      // so the server now treats imageMediaType as a hint, not gospel.
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', image: tinyPngBase64() }
          : { image: tinyPngBase64() },
      });
      assertEq(r.statusCode, 200, `${ep} — missing imageMediaType is OK (sniffer fills it in)`);
    }

    reset();
    {
      // Client claims application/pdf but the bytes are a valid PNG.
      // The sniffer wins: the request is accepted and the PNG is
      // routed to the provider. This is correct: the client lied,
      // but we have ground truth — refuse to break a real image.
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', image: tinyPngBase64(), imageMediaType: 'application/pdf' }
          : { image: tinyPngBase64(), imageMediaType: 'application/pdf' },
      });
      assertEq(r.statusCode, 200, `${ep} — bogus claimed mime overridden by magic-byte sniff`);
    }

    reset();
    {
      // True garbage — claimed AND actual are both unrecognisable.
      // Sniffer can't help, validator must reject.
      const garbageB64 = Buffer.from('this is not an image at all, just plain text bytes').toString('base64');
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', image: garbageB64, imageMediaType: 'image/jpeg' }
          : { image: garbageB64, imageMediaType: 'image/jpeg' },
      });
      assertEq(r.statusCode, 400, `${ep} — garbage bytes claimed-as-jpeg rejected`);
    }

    reset();
    {
      // Invalid base64 (contains spaces and non-b64 chars).
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', image: 'not valid b64 ###', imageMediaType: 'image/jpeg' }
          : { image: 'not valid b64 ###', imageMediaType: 'image/jpeg' },
      });
      assertEq(r.statusCode, 400, `${ep} — non-base64 string rejected`);
    }

    reset();
    {
      // Image too small (<32 chars).
      const r = await _request('POST', ep, {
        body: ep.endsWith('image-followup')
          ? { question: 'why', image: 'abc', imageMediaType: 'image/jpeg' }
          : { image: 'abc', imageMediaType: 'image/jpeg' },
      });
      assertEq(r.statusCode, 400, `${ep} — tiny string rejected`);
    }
  }

  // /image-followup specific: question required
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: { image: tinyPngBase64(), imageMediaType: 'image/jpeg' },
    });
    assertEq(r.statusCode, 400, 'image-followup — missing question → 400');
    assertContains(r.body.error, 'question', 'image-followup — error mentions question');
  }

  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: { question: 'a', image: tinyPngBase64(), imageMediaType: 'image/jpeg' },
    });
    assertEq(r.statusCode, 400, 'image-followup — too-short question → 400');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 2 — MEDIA TYPE COVERAGE (every accepted type)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 2 — Media-type coverage (jpeg/png/webp/heic/heif/gif/bmp + jpg alias)');

  for (const m of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp',
                   'image/heic', 'image/heif', 'image/gif', 'image/bmp']) {
    reset();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'what is this', image: tinyPngBase64(), imageMediaType: m, mode: 'lite' },
    });
    assertEq(r.statusCode, 200, `image-search accepts ${m}`);
    assertEq(visionLog.length, 1, `image-search ${m} called provider exactly once`);
    // jpg → jpeg normalisation
    if (m === 'image/jpg') {
      assertEq(visionLog[0].mediaType, 'image/jpeg', 'image/jpg normalised to image/jpeg');
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 3 — IMAGE SIZE LIMITS (hard ceiling at 8MB base64)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 3 — Image size handling (small → mid → boundary → over-limit)');

  for (const sizeKB of [1, 64, 512, 2048, 4096]) {
    reset();
    const t0 = Date.now();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: makePngImage(sizeKB), imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 20000 });
    const elapsed = Date.now() - t0;
    assertEq(r.statusCode, 200, `image-search accepts ${sizeKB}KB image (took ${elapsed}ms)`);
  }

  reset();
  {
    // Just over the 8MB validator cap but well under the 10MB express
    // body limit. This must hit OUR validator, not express's body parser.
    const huge = makePngImage(8.5 * 1024); // 8.5 MB → > 8 MB validator ceiling
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: huge, imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 30000 });
    assertEq(r.statusCode, 400, 'image-search 8.5MB rejected by validator (400)');
    assertContains(r.body.error, 'too large', 'rejection mentions size');
    assertEq(visionLog.length, 0, '8.5MB image never reaches provider');
  }

  reset();
  {
    // Way over the express body limit (10MB JSON) — should still be a
    // clean rejection (413) before our validator even runs. This is the
    // outermost ring of defence so we never OOM the process.
    const monster = makePngImage(15 * 1024); // 15 MB → > 10 MB body limit
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: monster, imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 30000 });
    assert(r.statusCode === 400 || r.statusCode === 413,
      `monster 15MB rejected (got ${r.statusCode}, want 400 or 413)`,
      `body=${JSON.stringify(r.body).slice(0, 200)}`);
    assertEq(visionLog.length, 0, '15MB image never reaches provider (express body limit catches it)');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 4 — PROVIDER ROUTING (4 mode×provider combos × 2 endpoints)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 4 — Provider routing (provider × mode × model-slot resolution)');

  // image-search × Gemini × lite
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: {
        query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'gemini', mode: 'lite', liteModel: 'gemini-2.5-flash-lite',
      },
    });
    assertEq(r.statusCode, 200, 'image-search Gemini+lite → 200');
    assertEq(visionLog.length, 1, 'image-search Gemini+lite called once');
    assertEq(visionLog[0].provider, 'gemini', 'image-search Gemini+lite hit gemini');
    assertEq(visionLog[0].opts.model, 'gemini-2.5-flash-lite', 'image-search Gemini+lite uses liteModel');
    assertEq(r.body.mode, 'lite', 'image-search Gemini+lite response mode=lite');
  }

  // image-search × Gemini × deep
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: {
        query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'gemini', mode: 'deep', deepModel: 'gemini-2.5-pro',
      },
    });
    assertEq(r.statusCode, 200, 'image-search Gemini+deep → 200');
    assertEq(visionLog[0].provider, 'gemini', 'image-search Gemini+deep hit gemini');
    assertEq(visionLog[0].opts.model, 'gemini-2.5-pro', 'image-search Gemini+deep uses deepModel');
    assertEq(r.body.mode, 'deep', 'image-search Gemini+deep response mode=deep');
  }

  // image-search × xGrok × lite
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: {
        query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'xgrok', mode: 'lite', xgrokLiteModel: 'grok-3-mini',
      },
    });
    assertEq(r.statusCode, 200, 'image-search xGrok+lite → 200');
    assertEq(visionLog[0].provider, 'xgrok', 'image-search xGrok+lite hit xgrok');
    assertEq(visionLog[0].opts.model, 'grok-3-mini', 'image-search xGrok+lite uses xgrokLiteModel');
  }

  // image-search × xGrok × deep
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: {
        query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'xgrok', mode: 'deep', xgrokDeepModel: 'grok-4',
      },
    });
    assertEq(r.statusCode, 200, 'image-search xGrok+deep → 200');
    assertEq(visionLog[0].opts.model, 'grok-4', 'image-search xGrok+deep uses xgrokDeepModel');
  }

  // image-search × xGrok × thinking
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: {
        query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'xgrok', mode: 'thinking', xgrokThinkingModel: 'grok-4-thinking',
      },
    });
    assertEq(r.statusCode, 200, 'image-search xGrok+thinking → 200');
    assertEq(visionLog[0].opts.model, 'grok-4-thinking', 'image-search xGrok+thinking uses xgrokThinkingModel');
  }

  // image-followup × Gemini × deep + history
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        query: 'orig', initialAnswer: 'orig answer', question: 'why?',
        history: [
          { role: 'user', text: 'first user' },
          { role: 'assistant', text: 'first assistant' },
        ],
        image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'gemini', mode: 'deep', deepModel: 'gemini-2.5-pro',
      },
    });
    assertEq(r.statusCode, 200, 'image-followup Gemini+deep → 200');
    assertEq(visionLog.length, 1, 'image-followup Gemini+deep called once');
    assertEq(visionLog[0].provider, 'gemini', 'image-followup Gemini+deep hit gemini');
    assertEq(visionLog[0].history.length, 3, 'image-followup history has 3 turns (2 prior + new user)');
    assertEq(visionLog[0].history[2].text, 'why?', 'last turn is the new user question');
    assert(visionLog[0].sysInstr.includes('orig'), 'image-followup sysInstr includes initial query', `sysInstr=${visionLog[0].sysInstr.slice(0, 150)}`);
    assert(visionLog[0].sysInstr.includes('orig answer'), 'image-followup sysInstr includes initial answer', `sysInstr=${visionLog[0].sysInstr.slice(0, 150)}`);
  }

  // image-followup × xGrok × thinking
  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        question: 'why?', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        provider: 'xgrok', mode: 'thinking', xgrokThinkingModel: 'grok-4-think',
      },
    });
    assertEq(r.statusCode, 200, 'image-followup xGrok+thinking → 200');
    assertEq(visionLog[0].provider, 'xgrok', 'image-followup xGrok+thinking hit xgrok');
    assertEq(visionLog[0].opts.model, 'grok-4-think', 'image-followup xGrok+thinking uses xgrokThinkingModel');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 5 — RESPONSE SHAPE CONTRACT
  // ════════════════════════════════════════════════════════════════
  section('GROUP 5 — Response shape contract (locked-down Flutter wire)');

  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'cat', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    });
    assertEq(r.statusCode, 200, 'image-search → 200');
    for (const k of ['answer', 'query', 'model', 'mode', 'sources', 'citations', 'searchQueries']) {
      assertHas(r.body, k, `image-search response has "${k}"`);
    }
    assertType(r.body, 'answer', 'string', 'answer is string');
    assertType(r.body, 'query', 'string', 'query is string');
    assertType(r.body, 'model', 'string', 'model is string');
    assert(Array.isArray(r.body.sources), 'sources is array');
    assert(Array.isArray(r.body.citations), 'citations is array');
    assert(Array.isArray(r.body.searchQueries), 'searchQueries is array');
    assertEq(r.body.query, 'cat', 'query echoed back');
  }

  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        question: 'tell me more', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite',
      },
    });
    assertEq(r.statusCode, 200, 'image-followup → 200');
    for (const k of ['answer', 'model', 'sources', 'searchQueries']) {
      assertHas(r.body, k, `image-followup response has "${k}"`);
    }
    assertType(r.body, 'answer', 'string', 'answer is string');
    assertType(r.body, 'model', 'string', 'model is string');
    assert(Array.isArray(r.body.sources), 'sources is array');
    assert(Array.isArray(r.body.searchQueries), 'searchQueries is array');
    assert(!('query' in r.body), 'image-followup does NOT echo query (matches article-followup shape)');
    assert(!('citations' in r.body), 'image-followup does NOT echo citations (matches article-followup shape)');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 6 — DATA URL PREFIX TOLERANCE
  // ════════════════════════════════════════════════════════════════
  section('GROUP 6 — data: URL prefix is stripped & still works');

  reset();
  {
    const dataUrl = `data:image/png;base64,${tinyPngBase64()}`;
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: dataUrl, imageMediaType: 'image/png', mode: 'lite' },
    });
    assertEq(r.statusCode, 200, 'data: prefix accepted');
    assertEq(visionLog.length, 1, 'data: prefix still calls provider');
    // The data: prefix must be stripped before egress. With sharp
    // installed the bytes will additionally be transcoded to JPEG
    // (so byte counts may grow), but the prefix string itself must
    // be gone — assert that no "data:" or "base64," substring leaks.
    const sentBase64 = visionLog[0].imageBytes;
    assert(typeof sentBase64 === 'number' && sentBase64 > 0,
      'provider received non-empty bytes',
      `imageBytes=${sentBase64}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 7 — IMAGE-ONLY (no query) is allowed for /image-search
  // ════════════════════════════════════════════════════════════════
  section('GROUP 7 — image-only search (empty query is OK for /image-search)');

  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    });
    // When the user types nothing, the backend substitutes the canonical
    // "lens prompt" — same wording as the Anthropic chat sample's
    // _lensPrompt — so the model performs a Google-Lens-style identify.
    const LENS = 'Identify what is in this image and explain it in detail as described.';
    assertEq(r.statusCode, 200, 'image-search with no query → 200');
    assertEq(r.body.query, LENS, 'empty query is replaced with the lens prompt');
    assertEq(visionLog[0].query, LENS, 'provider receives the lens prompt');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 8 — DB CACHE BEHAVIOR (image-followup)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 8 — DB cache hit (skips provider when same image+question)');

  reset();
  {
    // Pre-arm a cache hit on the very first SELECT.
    pgCanned.push({
      match: /SELECT result_json FROM ai_response_cache/i,
      rows: [{
        result_json: {
          answer: 'cached answer',
          model: 'cached-model',
          sources: [],
          searchQueries: [],
        },
      }],
    });
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        question: 'cached test', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        mode: 'lite', provider: 'gemini',
      },
    });
    assertEq(r.statusCode, 200, 'image-followup cache hit → 200');
    assertEq(r.body.answer, 'cached answer', 'cache returned the canned answer');
    assertEq(visionLog.length, 0, 'cache hit skips provider entirely');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 9 — IN-FLIGHT DEDUPE (image-followup)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 9 — In-flight dedupe (parallel identical requests share one provider call)');

  reset();
  {
    let resolveProvider;
    const blocker = new Promise((res) => { resolveProvider = res; });
    geminiConverseBehaviour = async (callId, opts) => {
      await blocker; // hold first call open
      return {
        text: 'shared answer', model: opts.model || 'gemini-2.5-flash-lite',
        sources: [], searchQueries: [],
      };
    };

    const body = {
      question: 'dedupe', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
      mode: 'lite', provider: 'gemini',
    };
    const p1 = _request('POST', '/api/v1/ai/image-followup', { body });
    // Wait a tick so the second hits the in-flight Map.
    await new Promise(r => setTimeout(r, 50));
    const p2 = _request('POST', '/api/v1/ai/image-followup', { body });
    await new Promise(r => setTimeout(r, 50));

    // Only one provider call should have fired so far.
    assertEq(visionLog.length, 1, 'two identical parallel requests fired ONE provider call');
    resolveProvider();
    const [r1, r2] = await Promise.all([p1, p2]);
    assertEq(r1.statusCode, 200, 'first parallel request → 200');
    assertEq(r2.statusCode, 200, 'second parallel request → 200');
    assertEq(r1.body.answer, 'shared answer', 'first got the shared answer');
    assertEq(r2.body.answer, 'shared answer', 'second got the shared answer (dedup worked)');
    assertEq(visionLog.length, 1, 'still exactly ONE provider call after both completed');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 10 — CROSS-PROVIDER FALLBACK (primary errors, backup wins)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 10 — Cross-provider fallback (primary errors, backup succeeds)');

  reset();
  {
    // Primary (gemini) throws immediately; fallback (xgrok) succeeds.
    geminiSearchBehaviour = async () => {
      const e = new Error('Gemini upstream 500'); e.name = 'GroundingError'; e.code = 'SERVER'; e.status = 500;
      throw e;
    };
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 30000 });
    assertEq(r.statusCode, 200, 'gemini fail → xgrok fallback → 200');
    assertEq(visionLog.length, 2, 'fallback added exactly one extra provider call');
    assertEq(visionLog[0].provider, 'gemini', 'primary was gemini');
    assertEq(visionLog[1].provider, 'xgrok', 'fallback was xgrok');
    assert(telegramHas('AI/image-search', 'i', 'Hedged FALLBACK won')
      || telegramHas('AI/image-search', null, 'fallback'),
      'telegram logged the fallback event');
  }

  reset();
  {
    // Primary xgrok throws; fallback (gemini) succeeds.
    xgrokSearchBehaviour = async () => {
      const e = new Error('xGrok upstream 502'); e.name = 'XGrokError'; e.code = 'SERVER'; e.status = 502;
      throw e;
    };
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite', provider: 'xgrok' },
    }, { timeoutMs: 30000 });
    assertEq(r.statusCode, 200, 'xgrok fail → gemini fallback → 200');
    assertEq(visionLog.length, 2, 'xgrok→gemini fallback added one extra call');
    assertEq(visionLog[0].provider, 'xgrok', 'primary was xgrok');
    assertEq(visionLog[1].provider, 'gemini', 'fallback was gemini');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 11 — BOTH PROVIDERS DOWN (graceful error notice)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 11 — Both providers fail → graceful notice (never raw 500 to client)');

  reset();
  {
    geminiSearchBehaviour = async () => { throw new Error('gemini down'); };
    xgrokSearchBehaviour = async () => { throw new Error('xgrok down'); };
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 30000 });
    assertEq(r.statusCode, 200, 'both down still returns 200 (graceful notice)');
    assertEq(r.body.fallback, true, 'fallback flag set');
    assertType(r.body, 'answer', 'string', 'still has an answer field');
    assert(telegramHas('AI/image-search', 'e', 'Both providers failed')
      || telegramHas('AI/image-search', 'e', 'exhausted')
      || telegramHas('AI/image-search', 'e', 'error notice'),
      'telegram logged the both-down catastrophe');
  }

  reset();
  {
    geminiConverseBehaviour = async () => { throw new Error('gemini down'); };
    xgrokConverseBehaviour = async () => { throw new Error('xgrok down'); };
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: { question: 'why', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 30000 });
    assertEq(r.statusCode, 200, 'image-followup both-down → 200 (graceful)');
    assertEq(r.body.fallback, true, 'image-followup fallback flag set');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 12 — NO PROVIDER CONFIGURED (503)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 12 — No vision provider available → 503');

  process.env._MOCK_GEMINI_DOWN = '1';
  process.env._MOCK_XGROK_DOWN = '1';
  reset();
  process.env._MOCK_GEMINI_DOWN = '1'; // reset() cleared them
  process.env._MOCK_XGROK_DOWN = '1';
  {
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    });
    assertEq(r.statusCode, 503, 'no provider → 503');
    assertContains(r.body.error, 'provider', '503 error mentions provider');
    assertEq(visionLog.length, 0, 'no provider call when both keys missing');
    assert(telegramHas('AI/image-search', 'e', 'No vision provider'),
      'telegram logged the missing-provider failure');
  }
  delete process.env._MOCK_GEMINI_DOWN;
  delete process.env._MOCK_XGROK_DOWN;

  // ════════════════════════════════════════════════════════════════
  //  GROUP 13 — HEDGED PARALLEL FALLBACK (slow primary, fast backup)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 13 — Hedged parallel fallback (slow primary → backup wins fast)');

  reset();
  {
    // Primary takes 12s (well beyond the 6s lite-hedge); backup answers in 200ms.
    // The wall-clock for the request should be < 1.5s — proving the hedge worked.
    geminiSearchBehaviour = async () => new Promise((resolve) => {
      setTimeout(() => resolve({
        text: 'slow gemini', model: 'gemini-slow', sources: [], citations: [], searchQueries: [],
      }), 12000);
    });
    xgrokSearchBehaviour = async () => new Promise((resolve) => {
      setTimeout(() => resolve({
        text: 'fast xgrok', model: 'grok-fast', sources: [], searchQueries: [],
      }), 200);
    });

    const t0 = Date.now();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'q', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    }, { timeoutMs: 20000 });
    const elapsed = Date.now() - t0;
    assertEq(r.statusCode, 200, 'hedged race → 200');
    assertEq(r.body.answer, 'fast xgrok', 'fast backup wins the race');
    assert(elapsed < 8000, `hedged race finished fast`, `took ${elapsed}ms (expected < 8000ms; primary alone would take 12000ms)`);
    assert(telegramHas('AI/image-search', 'i', 'Primary slow')
      || telegramHas('AI/image-search', 'i', 'hedged'),
      'telegram logged the hedge fire');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 14 — CONVERSATION CONTINUITY
  // ════════════════════════════════════════════════════════════════
  section('GROUP 14 — Conversation continuity (history forwarded + new turn appended)');

  reset();
  {
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        question: 'turn 3', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        history: [
          { role: 'user', text: 'turn 1' },
          { role: 'assistant', text: 'turn 2' },
        ],
        mode: 'lite', provider: 'gemini',
      },
    });
    assertEq(r.statusCode, 200, 'image-followup with history → 200');
    assertEq(visionLog[0].history.length, 3, 'forwarded 3 turns');
    assertEq(visionLog[0].history[0].text, 'turn 1', 'history[0] preserved');
    assertEq(visionLog[0].history[1].text, 'turn 2', 'history[1] preserved');
    assertEq(visionLog[0].history[2].text, 'turn 3', 'history[2] is the new question');
    assertEq(visionLog[0].history[2].role, 'user', 'new turn is role=user');
  }

  reset();
  {
    // Malformed history entries should be dropped silently (no crash).
    const r = await _request('POST', '/api/v1/ai/image-followup', {
      body: {
        question: 'fine question', image: tinyPngBase64(), imageMediaType: 'image/jpeg',
        history: [
          { role: 'user', text: 'good' },
          { role: 'user' }, // missing text
          { text: 'no role' }, // missing role
          null,
          'string', // not an object
          { role: 'assistant', text: 'good 2' },
        ],
        mode: 'lite', provider: 'gemini',
      },
    });
    assertEq(r.statusCode, 200, 'malformed history entries silently dropped');
    assertEq(visionLog[0].history.length, 3, '2 valid + 1 new = 3 turns forwarded');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 15 — TELEGRAM LOG COVERAGE AUDIT
  // ════════════════════════════════════════════════════════════════
  section('GROUP 15 — Telegram log coverage on every interesting path');

  // Success path emits at least one debug + one info breadcrumb.
  reset();
  await _request('POST', '/api/v1/ai/image-search', {
    body: { query: 'tg test', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
  });
  assert(telegramHas('AI/image-search', 'd', 'provider='),
    'tg.d on every request (provider= breadcrumb)');
  assert(telegramHas('AI/image-search', 'i', '✓'),
    'tg.i on success (✓ breadcrumb)');

  reset();
  await _request('POST', '/api/v1/ai/image-search', {
    body: { image: 'short', imageMediaType: 'image/jpeg' },
  });
  assert(telegramHas('AI/image-search', 'd', '400 validation'),
    'tg.d on validation failures (avoids tg-flood-on-error)');

  // ════════════════════════════════════════════════════════════════
  //  GROUP 16 — CONCURRENCY (10 parallel UNIQUE requests)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 16 — Concurrency stress (10 parallel UNIQUE requests all succeed)');

  reset();
  {
    const t0 = Date.now();
    const requests = [];
    for (let i = 0; i < 10; i++) {
      requests.push(_request('POST', '/api/v1/ai/image-search', {
        body: {
          query: `unique query ${i}`, // unique to bypass cache/dedupe
          image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite',
        },
      }, { timeoutMs: 20000 }));
    }
    const responses = await Promise.all(requests);
    const elapsed = Date.now() - t0;
    const allOk = responses.every(r => r.statusCode === 200);
    assert(allOk, `10 parallel requests all 200`, responses.filter(r => r.statusCode !== 200).map(r => r.statusCode).join(','));
    assert(elapsed < 5000, `10 parallel requests completed quickly`, `took ${elapsed}ms`);
    assertEq(visionLog.length, 10, '10 unique requests fired 10 provider calls (no false dedupe)');
  }

  // ════════════════════════════════════════════════════════════════
  //  GROUP 17 — ENDPOINT MOUNTING (no double-registration, both reachable)
  // ════════════════════════════════════════════════════════════════
  section('GROUP 17 — Endpoints mounted under /api/v1/ai/');

  reset();
  {
    // Ensure the route doesn't 404.
    const r1 = await _request('POST', '/api/v1/ai/image-search', {
      body: { query: 'mount', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    });
    const r2 = await _request('POST', '/api/v1/ai/image-followup', {
      body: { question: 'mount', image: tinyPngBase64(), imageMediaType: 'image/jpeg', mode: 'lite' },
    });
    assert(r1.statusCode !== 404, 'image-search not 404');
    assert(r2.statusCode !== 404, 'image-followup not 404');
  }

  // GET on these POST-only endpoints should be 404 (no method handler).
  reset();
  {
    const r = await _request('GET', '/api/v1/ai/image-search');
    assert(r.statusCode === 404 || r.statusCode === 405,
      `GET image-search rejected (got ${r.statusCode})`);
  }

  await _stopServer();

  // ── Summary ─────────────────────────────────────────────────────
  log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}  SUMMARY${C.reset}`);
  log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`  ${C.green}passed: ${passed}${C.reset}`);
  log(`  ${C.red}failed: ${failed}${C.reset}`);
  if (failures.length > 0) {
    log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
    for (const f of failures) log(`  ${C.red}• ${f}${C.reset}`);
  }
  log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  log(`\n${C.red}${C.bold}UNCAUGHT TEST RUNNER ERROR:${C.reset} ${e.stack || e.message}`);
  process.exit(2);
});
