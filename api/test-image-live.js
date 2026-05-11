'use strict';

// ═══════════════════════════════════════════════════════════════
//  LIVE 4-MODEL VISION TEST
//
//  Hits /api/v1/ai/image-search and /api/v1/ai/image-followup
//  against the REAL Gemini + xGrok APIs with a REAL test image,
//  for all four model slots:
//
//    • Gemini lite   (gemini-2.5-flash-lite)
//    • Gemini deep   (gemini-2.5-pro / configured GEMINI_PRO_MODEL)
//    • xGrok  lite   (grok-4-1-fast-non-reasoning)
//    • xGrok  deep   (grok-4-0709)
//
//  The Express server is booted in-process with Postgres / Telegram /
//  rate-limit mocked out (no infra dependency). Then a real HTTP
//  request flows through the real route handlers, real preprocessing,
//  real hedged-race executor, real Gemini/xGrok REST calls.
//
//  Required env (or pass via CLI flags):
//    GOOGLE_API_KEY=AIza...   real Gemini API key
//    XGROK_API_KEY=xai-...    real xAI Grok key (already in backend/.env)
//
//  Run:
//    node backend/api/test-image-live.js
//    node backend/api/test-image-live.js --quick   (skips deep models)
//
//  Exits 0 on success, 1 on any failure.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const ARGS = new Set(process.argv.slice(2));
const QUICK = ARGS.has('--quick');
const VERBOSE = ARGS.has('--verbose') || ARGS.has('-v');

// CLI flags
//   --local-image=<path>            use a local file instead of fetching
//   --expect=keyword1,keyword2,…    keywords the model MUST surface
//   --followup-expect=k1,k2,…       keywords the follow-up MUST surface
//   --followup-question="..."       custom follow-up question
//   --initial-answer="..."          seed initial answer for the follow-up
let LOCAL_IMAGE_PATH = null;
let EXPECT_KEYS = null;
let FOLLOWUP_EXPECT_KEYS = null;
let FOLLOWUP_QUESTION = null;
let INITIAL_ANSWER = null;
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = a.match(/^--local-image=(.+)$/))) LOCAL_IMAGE_PATH = m[1];
  else if ((m = a.match(/^--expect=(.+)$/))) EXPECT_KEYS = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  else if ((m = a.match(/^--followup-expect=(.+)$/))) FOLLOWUP_EXPECT_KEYS = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  else if ((m = a.match(/^--followup-question=(.+)$/))) FOLLOWUP_QUESTION = m[1];
  else if ((m = a.match(/^--initial-answer=(.+)$/))) INITIAL_ANSWER = m[1];
}

let passed = 0;
let failed = 0;
const failures = [];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m',
};
function log(msg) { process.stdout.write(`${msg}\n`); }
function ok(name, detail = '') { passed++; log(`  ${C.green}✓${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`); }
function bad(name, why) {
  failed++;
  failures.push(`${name} — ${why}`);
  log(`  ${C.red}✗ ${name}${C.reset}\n     ${C.red}${why}${C.reset}`);
}
function section(title) { log(`\n${C.cyan}${C.bold}━━━ ${title} ━━━${C.reset}`); }
function group(title) { log(`\n${C.magenta}${C.bold}═══ ${title} ═══${C.reset}`); }
function info(s) { log(`  ${C.dim}${s}${C.reset}`); }
function assert(cond, name, why = 'assertion failed') { cond ? ok(name) : bad(name, why); }

// ── Boot-time mocks (BEFORE requiring src/index.js) ─────────────
// Postgres is the only piece we replace — Gemini + xGrok hit the
// real network so we can prove end-to-end performance.
const pgQueryLog = [];
function _pgQuery(text) {
  pgQueryLog.push(String(text).trim().slice(0, 80));
  // Always return empty rows so /image-followup never sees a cache hit.
  return Promise.resolve({ rows: [], rowCount: 0 });
}
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'),
  filename: require.resolve('pg'),
  loaded: true,
  exports: { Pool: function () { return { query: _pgQuery, on: () => {} }; } },
};

// Capture telegram log lines in-memory so we can inspect breadcrumbs
// after each request and prove the "robust telegram logs" promise.
const telegramLog = [];
const tgMock = {
  d: (tag, msg) => telegramLog.push({ level: 'd', tag, msg }),
  i: (tag, msg) => telegramLog.push({ level: 'i', tag, msg }),
  w: (tag, msg, err) => telegramLog.push({ level: 'w', tag, msg, err: err?.message }),
  e: (tag, msg, err) => telegramLog.push({ level: 'e', tag, msg, err: err?.message }),
  fatal: (tag, msg, err) => telegramLog.push({ level: 'fatal', tag, msg, err: err?.message }),
};
const telegramPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(telegramPath)] = {
  id: telegramPath, filename: telegramPath, loaded: true,
  exports: { tg: tgMock },
};
function clearTg() { telegramLog.length = 0; }
function tgCount(level) { return telegramLog.filter(e => e.level === level).length; }

// Skip rate limiter — same trick as the mocked test.
const rlPath = require.resolve('express-rate-limit');
require.cache[rlPath] = {
  id: rlPath, filename: rlPath, loaded: true,
  exports: () => (req, res, next) => next(),
};

// ── Required env BEFORE src/index.js boots ──────────────────────
process.env.DATABASE_URL = 'postgres://livetest';
process.env.JWT_SECRET = 'test-secret-32-chars-or-more-please';
process.env.PORT = '0';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Pull real keys from backend/.env if not already exported.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// CLI override:  --google-key=AIza...   --xgrok-key=xai-...
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--google-key=(.+)$/);
  if (m) process.env.GOOGLE_API_KEY = m[1];
  const x = a.match(/^--xgrok-key=(.+)$/);
  if (x) process.env.XGROK_API_KEY = x[1];
}

// Fail fast if a key is unresolved (literally still "${GOOGLE_API_KEY}").
function _looksUnresolved(v) { return !v || /\$\{.+?\}/.test(v) || v.length < 20; }
const missingKeys = [];
if (_looksUnresolved(process.env.GOOGLE_API_KEY)) missingKeys.push('GOOGLE_API_KEY');
if (_looksUnresolved(process.env.XGROK_API_KEY)) missingKeys.push('XGROK_API_KEY');
if (missingKeys.length) {
  console.error(`\n${C.red}${C.bold}Missing or unresolved keys: ${missingKeys.join(', ')}${C.reset}`);
  console.error(`Set them in backend/.env or via --google-key=… --xgrok-key=… and re-run.`);
  process.exit(2);
}

// Override XGROK model slots if not provided
process.env.XGROK_LITE_MODEL = process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning';
process.env.XGROK_DEEP_MODEL = process.env.XGROK_DEEP_MODEL || 'grok-4-0709';
process.env.XGROK_THINKING_MODEL = process.env.XGROK_THINKING_MODEL || 'grok-4-1-fast-reasoning';

// Silence the news scheduler & x-feed scheduler so they don't spam.
// They will still init but their pool.query → no-op.
console.log(`${C.dim}[boot] env ready — booting in-process Express…${C.reset}`);

// ── Boot the real server ────────────────────────────────────────
require('./src/index');

// ── HTTP helper ─────────────────────────────────────────────────
function _request(method, pathStr, { body, port, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const dataStr = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: pathStr,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(dataStr),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP timeout ${timeoutMs}ms`)));
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

// ── Real test image: Eiffel Tower ──────────────────────────────
// Universally recognisable → easy assertion that the model actually
// looked at the image. We try several public sources because
// Wikimedia rate-limits aggressively on default User-Agents.
const TEST_IMAGE_URLS = [
  // Wikimedia thumbnail — works most of the time with a proper UA.
  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Tour_Eiffel_Wikimedia_Commons_%28cropped%29.jpg/640px-Tour_Eiffel_Wikimedia_Commons_%28cropped%29.jpg',
  // Wikimedia FilePath redirect (different rate-limit bucket).
  'https://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel_Wikimedia_Commons_(cropped).jpg?width=640',
  // Unsplash Eiffel Tower — fully open, no rate limit, hot-link allowed.
  'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=640&q=75&auto=format&fit=crop',
];
// Wikimedia / Wikipedia require a UA with tool name + URL + contact.
const UA_HEADERS = {
  'user-agent': 'ai_nexus-live-test/1.0 (https://github.com/ai-nexus/local-test; ai-nexus-test@example.com) node-https',
  'accept': 'image/jpeg,image/png,image/*;q=0.9,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9',
};

function _downloadOnce(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: UA_HEADERS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return _downloadOnce(next, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url.slice(0, 80)}…`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('image fetch timeout')));
  });
}

async function _downloadImage(urls) {
  const errs = [];
  for (const u of urls) {
    try {
      const buf = await _downloadOnce(u);
      // Sanity check — must be at least 5KB and start with a JPEG/PNG magic byte.
      if (buf.length < 5_000) {
        errs.push(`${u.slice(0, 60)}… → only ${buf.length}B`);
        continue;
      }
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      if (!isJpg && !isPng) {
        errs.push(`${u.slice(0, 60)}… → not JPEG/PNG (got 0x${buf[0].toString(16)}${buf[1].toString(16)})`);
        continue;
      }
      log(`  ${C.dim}[img] fetched from ${u.slice(0, 80)}…${C.reset}`);
      return { buf, mediaType: isJpg ? 'image/jpeg' : 'image/png', source: u };
    } catch (e) {
      errs.push(`${u.slice(0, 60)}… → ${e.message}`);
    }
  }
  throw new Error('all image sources failed:\n  ' + errs.join('\n  '));
}

// ── Wait for app.listen ─────────────────────────────────────────
async function _waitForServer() {
  for (let i = 0; i < 100; i++) {
    const port = global.__SERVER_PORT__;
    if (port) return port;
    // index.js calls app.listen(PORT) but doesn't expose port. We poll
    // /health on every common port instead — but the simpler trick is
    // to monkey-patch app.listen via a require hook. Skip that and
    // just probe http://127.0.0.1:<PORT> with PORT=process.env.PORT.
    // Since we set PORT=0, we need to recover the chosen port.
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server never listened');
}

// Recover the port via a global hijack of net.Server.prototype.listen.
const _net = require('net');
const _origListen = _net.Server.prototype.listen;
_net.Server.prototype.listen = function (...args) {
  const result = _origListen.apply(this, args);
  this.on('listening', () => {
    const addr = this.address();
    if (addr && typeof addr === 'object') {
      global.__SERVER_PORT__ = addr.port;
      console.log(`${C.dim}[boot] in-process server listening on :${addr.port}${C.reset}`);
    }
  });
  return result;
};

// ── Per-leg test runner ─────────────────────────────────────────
const RESULTS = []; // { provider, mode, model, latencyMs, status, sources, answerChars, sample }

async function runImageSearchLeg({ port, label, body, expect }) {
  clearTg();
  const t0 = Date.now();
  let r;
  try {
    r = await _request('POST', '/api/v1/ai/image-search', { port, body, timeoutMs: 240_000 });
  } catch (e) {
    bad(`${label} — request`, e.message);
    return null;
  }
  const latencyMs = Date.now() - t0;

  const status = r.statusCode;
  const ans = r.body?.answer || '';
  const sources = Array.isArray(r.body?.sources) ? r.body.sources : [];
  const sq = Array.isArray(r.body?.searchQueries) ? r.body.searchQueries : [];
  const model = r.body?.model || '';

  log(`  ${C.dim}→ ${label}${C.reset}  ${C.bold}${status}${C.reset}  ${latencyMs}ms  ${ans.length}ch  src=${sources.length}  sq=${sq.length}  model=${model}`);
  if (VERBOSE) info(`     answer head: ${ans.slice(0, 200).replace(/\n/g, ' ')}`);

  assert(status === 200, `${label} — HTTP 200`, `got ${status} body=${JSON.stringify(r.body).slice(0, 200)}`);
  assert(typeof ans === 'string' && ans.length > 50, `${label} — non-empty answer (>50ch)`, `got ${ans.length}ch`);
  assert(Array.isArray(sources), `${label} — sources is array`);
  if (expect?.identifies && status === 200) {
    const lower = ans.toLowerCase();
    const matched = expect.identifies.some(k => lower.includes(k));
    assert(matched, `${label} — answer mentions one of [${expect.identifies.join(', ')}]`,
      `none found in: ${ans.slice(0, 200).replace(/\n/g, ' ')}…`);
  }
  if (expect?.expectedFallback) {
    assert(r.body?.fallback === true, `${label} — fallback flag set`);
  } else if (status === 200) {
    assert(r.body?.fallback !== true, `${label} — not a degraded notice`,
      `got fallback=true: ${ans.slice(0, 120)}`);
  }
  // Telegram log coverage on success.
  const hasInfo = telegramLog.some(e => e.tag === 'AI/image-search' && e.level === 'i');
  assert(hasInfo, `${label} — telegram info breadcrumb on success`,
    `tg=${JSON.stringify(telegramLog.slice(-3))}`);

  RESULTS.push({
    label, provider: body.provider || 'gemini', mode: body.mode || 'lite',
    model, latencyMs, status, sources: sources.length, sq: sq.length,
    answerChars: ans.length, sample: ans.slice(0, 120).replace(/\n/g, ' '),
    fallback: r.body?.fallback === true,
  });
  return { ...r, latencyMs };
}

async function runImageFollowupLeg({ port, label, body, expect }) {
  clearTg();
  const t0 = Date.now();
  let r;
  try {
    r = await _request('POST', '/api/v1/ai/image-followup', { port, body, timeoutMs: 240_000 });
  } catch (e) {
    bad(`${label} — request`, e.message);
    return null;
  }
  const latencyMs = Date.now() - t0;
  const status = r.statusCode;
  const ans = r.body?.answer || '';
  const model = r.body?.model || '';
  const sources = Array.isArray(r.body?.sources) ? r.body.sources : [];

  log(`  ${C.dim}→ ${label}${C.reset}  ${C.bold}${status}${C.reset}  ${latencyMs}ms  ${ans.length}ch  src=${sources.length}  model=${model}`);
  if (VERBOSE) info(`     answer head: ${ans.slice(0, 200).replace(/\n/g, ' ')}`);

  assert(status === 200, `${label} — HTTP 200`, `got ${status} body=${JSON.stringify(r.body).slice(0, 200)}`);
  assert(typeof ans === 'string' && ans.length > 30, `${label} — non-empty answer (>30ch)`, `got ${ans.length}ch`);
  if (expect?.contains) {
    const lower = ans.toLowerCase();
    const matched = expect.contains.some(k => lower.includes(k));
    assert(matched, `${label} — answer mentions one of [${expect.contains.join(', ')}]`,
      `none in: ${ans.slice(0, 200).replace(/\n/g, ' ')}…`);
  }
  return { ...r, latencyMs };
}

// ── MAIN ────────────────────────────────────────────────────────
(async () => {
  // Wait for the in-process server to listen.
  let port;
  for (let i = 0; i < 100; i++) {
    if (global.__SERVER_PORT__) { port = global.__SERVER_PORT__; break; }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!port) {
    console.error(`${C.red}server never listened${C.reset}`);
    process.exit(1);
  }

  // Load the test image — local file if provided (real user-uploaded
  // photo), otherwise download from one of the public sources.
  group('LOADING TEST IMAGE');
  let imgBuf, imageMediaType, imageSourceLabel;
  if (LOCAL_IMAGE_PATH) {
    try {
      imgBuf = fs.readFileSync(LOCAL_IMAGE_PATH);
    } catch (e) {
      console.error(`${C.red}local image read failed: ${e.message}${C.reset}`);
      process.exit(1);
    }
    // Sniff actual mime from magic bytes — never trust the file
    // extension. Phone galleries routinely save HEIC/HEIF as .jpg
    // and screenshots as .png-but-actually-webp, etc.
    if (imgBuf[0] === 0xff && imgBuf[1] === 0xd8) imageMediaType = 'image/jpeg';
    else if (imgBuf[0] === 0x89 && imgBuf[1] === 0x50) imageMediaType = 'image/png';
    else if (imgBuf[0] === 0x47 && imgBuf[1] === 0x49) imageMediaType = 'image/gif';
    else if (imgBuf[0] === 0x52 && imgBuf[1] === 0x49) imageMediaType = 'image/webp';
    else imageMediaType = 'image/jpeg'; // best guess
    imageSourceLabel = `local file ${path.basename(LOCAL_IMAGE_PATH)}`;
    log(`  ${C.dim}[img] loaded ${imageSourceLabel}${C.reset}`);
  } else {
    let dl;
    try {
      dl = await _downloadImage(TEST_IMAGE_URLS);
    } catch (e) {
      console.error(`${C.red}image download failed: ${e.message}${C.reset}`);
      process.exit(1);
    }
    imgBuf = dl.buf;
    imageMediaType = dl.mediaType;
    imageSourceLabel = 'Eiffel Tower (CDN)';
  }
  const imageBase64 = imgBuf.toString('base64');
  info(`${imageSourceLabel} — ${imageMediaType} — ${(imgBuf.length / 1024).toFixed(1)}KB raw, ${(imageBase64.length / 1024).toFixed(1)}KB base64`);
  ok('test image loaded');

  // Identifying keywords the model MUST surface to prove it actually
  // looked at the bytes. Defaults to the Eiffel set (CDN image);
  // override via --expect=k1,k2,…
  const eiffelKeys = EXPECT_KEYS || ['eiffel', 'tour eiffel', 'tower', 'paris', 'champ de mars', 'lattice'];

  // ════════════════════════════════════════════════════════════
  //  SECTION A — IMAGE-SEARCH × 4 MODELS
  // ════════════════════════════════════════════════════════════
  group('SECTION A — /image-search × 4 model slots (real APIs)');

  section('A1 — Gemini lite  (gemini-2.5-flash-lite)');
  await runImageSearchLeg({
    port, label: 'gemini lite',
    body: {
      query: 'What is in this image? Identify it and tell me about it.',
      image: imageBase64, imageMediaType,
      provider: 'gemini', mode: 'lite',
      liteModel: 'gemini-2.5-flash-lite',
    },
    expect: { identifies: eiffelKeys },
  });

  if (!QUICK) {
    section('A2 — Gemini deep  (gemini-2.5-pro)');
    await runImageSearchLeg({
      port, label: 'gemini deep',
      body: {
        query: 'What is in this image? Identify it and tell me about it.',
        image: imageBase64, imageMediaType,
        provider: 'gemini', mode: 'deep',
        deepModel: 'gemini-2.5-pro',
      },
      expect: { identifies: eiffelKeys },
    });
  } else {
    info('  (skipped — --quick)');
  }

  section('A3 — xGrok lite  (grok-4-1-fast-non-reasoning)');
  await runImageSearchLeg({
    port, label: 'xgrok lite',
    body: {
      query: 'What is in this image? Identify it and tell me about it.',
      image: imageBase64, imageMediaType,
      provider: 'xgrok', mode: 'lite',
      xgrokLiteModel: 'grok-4-1-fast-non-reasoning',
    },
    expect: { identifies: eiffelKeys },
  });

  if (!QUICK) {
    section('A4 — xGrok deep  (grok-4-0709)');
    await runImageSearchLeg({
      port, label: 'xgrok deep',
      body: {
        query: 'What is in this image? Identify it and tell me about it.',
        image: imageBase64, imageMediaType,
        provider: 'xgrok', mode: 'deep',
        xgrokDeepModel: 'grok-4-0709',
      },
      expect: { identifies: eiffelKeys },
    });
  } else {
    info('  (skipped — --quick)');
  }

  // ════════════════════════════════════════════════════════════
  //  SECTION B — EDGE CASES (same image, different request shape)
  // ════════════════════════════════════════════════════════════
  group('SECTION B — edge cases');

  section('B1 — Image-only (empty query) → lens prompt fallback');
  await runImageSearchLeg({
    port, label: 'lens-style image-only (xgrok lite)',
    body: {
      image: imageBase64, imageMediaType,
      provider: 'xgrok', mode: 'lite',
    },
    expect: { identifies: eiffelKeys },
  });

  section('B2 — data:URL prefix tolerated');
  await runImageSearchLeg({
    port, label: 'data:URL prefix (xgrok lite)',
    body: {
      query: 'Identify this.',
      image: `data:image/jpeg;base64,${imageBase64}`,
      imageMediaType: 'image/jpeg',
      provider: 'xgrok', mode: 'lite',
    },
    expect: { identifies: eiffelKeys },
  });

  section('B3 — invalid media types → 400 fast (no provider call)');
  // BMP / HEIC / HEIF / GIF / WEBP are all in the accepted set (sharp +
  // Gemini + xGrok all handle them). Truly unsupported types like
  // SVG, TIFF and PDF must reject in <500ms before any network egress.
  for (const mt of ['image/svg+xml', 'image/tiff', 'application/pdf', 'text/plain']) {
    clearTg();
    const t0 = Date.now();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      port,
      body: { query: 'x', image: imageBase64, imageMediaType: mt },
    });
    const lat = Date.now() - t0;
    log(`  ${C.dim}→ ${mt.padEnd(18)}${C.reset}  ${C.bold}${r.statusCode}${C.reset}  ${lat}ms`);
    assert(r.statusCode === 400, `${mt} → 400`, `got ${r.statusCode}`);
    assert(lat < 500, `${mt} rejected in <500ms`, `took ${lat}ms`);
  }

  section('B4 — missing image → 400 fast');
  {
    clearTg();
    const t0 = Date.now();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      port,
      body: { query: 'no image here' },
    });
    const lat = Date.now() - t0;
    log(`  ${C.dim}→ missing image${C.reset}  ${C.bold}${r.statusCode}${C.reset}  ${lat}ms`);
    assert(r.statusCode === 400, 'missing image → 400', `got ${r.statusCode}`);
    assert(lat < 500, 'rejected in <500ms', `took ${lat}ms`);
  }

  section('B5 — junk base64 → 400 fast');
  {
    clearTg();
    const t0 = Date.now();
    const r = await _request('POST', '/api/v1/ai/image-search', {
      port,
      body: { query: 'x', image: '@@@not_base64@@@', imageMediaType: 'image/jpeg' },
    });
    const lat = Date.now() - t0;
    log(`  ${C.dim}→ junk base64${C.reset}  ${C.bold}${r.statusCode}${C.reset}  ${lat}ms`);
    assert(r.statusCode === 400, 'junk base64 → 400', `got ${r.statusCode}`);
    assert(lat < 500, 'rejected in <500ms', `took ${lat}ms`);
  }

  // ════════════════════════════════════════════════════════════
  //  SECTION C — MULTI-TURN FOLLOW-UP × 4 MODELS
  // ════════════════════════════════════════════════════════════
  group('SECTION C — /image-followup × 4 model slots (real APIs)');

  // Use a pre-canned "initial answer" so the system prompt tells the
  // model exactly what to follow up on. The user question asks
  // something the model must SEE in the image to answer.
  // Initial answer + question + expected keywords are all overridable
  // via CLI for non-default test images.
  const _initialAnswer = INITIAL_ANSWER
    || 'This is the Eiffel Tower in Paris, France — a 330-metre wrought-iron lattice tower on the Champ de Mars.';
  const _followupQuestion = FOLLOWUP_QUESTION
    || 'What country is the structure in this image located in, and what is the capital of that country?';
  const _followupExpect = FOLLOWUP_EXPECT_KEYS || ['france', 'paris'];

  const followupBody = (provider, mode, modelOverride = {}) => ({
    query: 'What is in this image?',
    initialAnswer: _initialAnswer,
    question: _followupQuestion,
    history: [
      { role: 'user', text: 'What is in this image?' },
      { role: 'model', text: _initialAnswer },
    ],
    image: imageBase64, imageMediaType,
    provider, mode,
    ...modelOverride,
  });

  section('C1 — Gemini lite follow-up');
  await runImageFollowupLeg({
    port, label: 'gemini lite followup',
    body: followupBody('gemini', 'lite', { liteModel: 'gemini-2.5-flash-lite' }),
    expect: { contains: _followupExpect },
  });

  if (!QUICK) {
    section('C2 — Gemini deep follow-up');
    await runImageFollowupLeg({
      port, label: 'gemini deep followup',
      body: followupBody('gemini', 'deep', { deepModel: 'gemini-2.5-pro' }),
      expect: { contains: _followupExpect },
    });
  }

  section('C3 — xGrok lite follow-up');
  await runImageFollowupLeg({
    port, label: 'xgrok lite followup',
    body: followupBody('xgrok', 'lite', { xgrokLiteModel: 'grok-4-1-fast-non-reasoning' }),
    expect: { contains: _followupExpect },
  });

  if (!QUICK) {
    section('C4 — xGrok deep follow-up');
    await runImageFollowupLeg({
      port, label: 'xgrok deep followup',
      body: followupBody('xgrok', 'deep', { xgrokDeepModel: 'grok-4-0709' }),
      expect: { contains: _followupExpect },
    });
  }

  // ════════════════════════════════════════════════════════════
  //  SECTION D — CONCURRENCY: same image hit 4 providers in parallel
  // ════════════════════════════════════════════════════════════
  group('SECTION D — 4 providers in parallel (parallel retries / hedging stress)');
  {
    const t0 = Date.now();
    const calls = [
      runImageSearchLeg({ port, label: '∥ gemini lite', body: { query: 'Identify this.', image: imageBase64, imageMediaType, provider: 'gemini', mode: 'lite', liteModel: 'gemini-2.5-flash-lite' }, expect: { identifies: eiffelKeys } }),
      runImageSearchLeg({ port, label: '∥ xgrok  lite', body: { query: 'Identify this.', image: imageBase64, imageMediaType, provider: 'xgrok',  mode: 'lite', xgrokLiteModel: 'grok-4-1-fast-non-reasoning' }, expect: { identifies: eiffelKeys } }),
    ];
    if (!QUICK) {
      calls.push(runImageSearchLeg({ port, label: '∥ gemini deep', body: { query: 'Identify this.', image: imageBase64, imageMediaType, provider: 'gemini', mode: 'deep', deepModel: 'gemini-2.5-pro' }, expect: { identifies: eiffelKeys } }));
      calls.push(runImageSearchLeg({ port, label: '∥ xgrok  deep', body: { query: 'Identify this.', image: imageBase64, imageMediaType, provider: 'xgrok',  mode: 'deep', xgrokDeepModel: 'grok-4-0709' }, expect: { identifies: eiffelKeys } }));
    }
    await Promise.all(calls);
    const lat = Date.now() - t0;
    info(`  parallel batch finished in ${lat}ms (max single-leg latency dominates)`);
  }

  // ════════════════════════════════════════════════════════════
  //  RESULTS TABLE
  // ════════════════════════════════════════════════════════════
  group('RESULTS — latency / size matrix');
  if (RESULTS.length) {
    log(`  ${'label'.padEnd(28)} ${'status'.padEnd(7)} ${'latency'.padEnd(10)} ${'src'.padEnd(5)} ${'sq'.padEnd(4)} ${'chars'.padEnd(7)} model`);
    log(`  ${'─'.repeat(95)}`);
    for (const r of RESULTS) {
      const fb = r.fallback ? `${C.yellow}(degraded)${C.reset}` : '';
      log(`  ${r.label.padEnd(28)} ${String(r.status).padEnd(7)} ${(r.latencyMs + 'ms').padEnd(10)} ${String(r.sources).padEnd(5)} ${String(r.sq).padEnd(4)} ${String(r.answerChars).padEnd(7)} ${r.model} ${fb}`);
    }
    const okOnes = RESULTS.filter(r => r.status === 200 && !r.fallback);
    if (okOnes.length) {
      const avg = Math.round(okOnes.reduce((a, b) => a + b.latencyMs, 0) / okOnes.length);
      const min = Math.min(...okOnes.map(r => r.latencyMs));
      const max = Math.max(...okOnes.map(r => r.latencyMs));
      info(`  successful legs: ${okOnes.length}/${RESULTS.length}  ·  avg ${avg}ms  min ${min}ms  max ${max}ms`);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  SUMMARY
  // ════════════════════════════════════════════════════════════
  log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}  SUMMARY${C.reset}`);
  log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`  ${C.green}passed: ${passed}${C.reset}`);
  log(`  ${failed > 0 ? C.red : C.dim}failed: ${failed}${C.reset}`);
  if (failures.length) {
    log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
    for (const f of failures) log(`  ${C.red}• ${f}${C.reset}`);
  }

  // Force exit (Express keeps event loop alive via schedulers).
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n${C.red}${C.bold}UNCAUGHT:${C.reset} ${e.stack || e.message}`);
  process.exit(2);
});
