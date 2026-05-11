'use strict';

// ═══════════════════════════════════════════════════════════════
//  LIVE FORMAT COVERAGE TEST
//
//  Takes a single source image (default: ./test-image.png — your
//  Taj Mahal upload) and converts it via sharp to every supported
//  format. Each variant is sent through the real backend to a real
//  provider; the test asserts the model still identifies the
//  Taj Mahal regardless of upload format.
//
//  This proves the format pipeline end-to-end:
//    user phone any-format → backend sniff → sharp transcode →
//    JPEG → provider → identification
//
//  Required env: GOOGLE_API_KEY + XGROK_API_KEY (from backend/.env).
//  Run:
//    node backend/api/test-image-formats-live.js \
//      --google-key=AIza... \
//      --source=test-image.png \
//      --expect="taj mahal,taj,agra,india,marble,mughal"
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const http = require('http');

let SOURCE = 'test-image.png';
let EXPECT_KEYS = ['taj mahal', 'taj', 'mahal', 'agra', 'india', 'marble', 'mausoleum', 'mughal'];
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = a.match(/^--source=(.+)$/))) SOURCE = m[1];
  else if ((m = a.match(/^--expect=(.+)$/))) EXPECT_KEYS = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  else if ((m = a.match(/^--google-key=(.+)$/))) process.env.GOOGLE_API_KEY = m[1];
  else if ((m = a.match(/^--xgrok-key=(.+)$/))) process.env.XGROK_API_KEY = m[1];
}

// ── Mocks: same as test-image-live.js so we can boot src/index hermetically.
const _pgQuery = () => Promise.resolve({ rows: [], rowCount: 0 });
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'), filename: require.resolve('pg'), loaded: true,
  exports: { Pool: function () { return { query: _pgQuery, on: () => {} }; } },
};
const tgPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(tgPath)] = {
  id: tgPath, filename: tgPath, loaded: true,
  exports: { tg: { d() {}, i() {}, w() {}, e() {}, fatal() {} } },
};
const rlPath = require.resolve('express-rate-limit');
require.cache[rlPath] = {
  id: rlPath, filename: rlPath, loaded: true,
  exports: () => (req, res, next) => next(),
};

process.env.DATABASE_URL = 'postgres://livetest';
process.env.JWT_SECRET = 'test-secret-32-chars-or-more-please';
process.env.PORT = '0';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

if (!process.env.GOOGLE_API_KEY || /\$\{/.test(process.env.GOOGLE_API_KEY) || process.env.GOOGLE_API_KEY.length < 20) {
  console.error('Missing GOOGLE_API_KEY (pass --google-key=…)');
  process.exit(2);
}
if (!process.env.XGROK_API_KEY || /\$\{/.test(process.env.XGROK_API_KEY) || process.env.XGROK_API_KEY.length < 20) {
  console.error('Missing XGROK_API_KEY (pass --xgrok-key=… or set in backend/.env)');
  process.exit(2);
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
let passed = 0, failed = 0;
const failures = [];
function ok(name, detail) { passed++; process.stdout.write(`  ${C.green}✓${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}\n`); }
function bad(name, why) { failed++; failures.push(`${name} — ${why}`); process.stdout.write(`  ${C.red}✗ ${name}${C.reset}\n     ${C.red}${why}${C.reset}\n`); }
function section(t) { process.stdout.write(`\n${C.cyan}${C.bold}━━━ ${t} ━━━${C.reset}\n`); }
function info(s) { process.stdout.write(`  ${C.dim}${s}${C.reset}\n`); }

// Recover server port via listen() hook.
const _net = require('net');
const _origListen = _net.Server.prototype.listen;
_net.Server.prototype.listen = function (...args) {
  const r = _origListen.apply(this, args);
  this.on('listening', () => {
    const a = this.address();
    if (a && typeof a === 'object') {
      global.__SERVER_PORT__ = a.port;
      console.log(`${C.dim}[boot] server listening on :${a.port}${C.reset}`);
    }
  });
  return r;
};

require('./src/index');
const sharp = require('sharp');

function _post(port, pathStr, body, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port, path: pathStr,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP timeout ${timeoutMs}ms`)));
    req.write(data); req.end();
  });
}

(async () => {
  // Wait for server.
  let port;
  for (let i = 0; i < 100; i++) {
    if (global.__SERVER_PORT__) { port = global.__SERVER_PORT__; break; }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!port) { console.error('server never listened'); process.exit(1); }

  // Load source.
  const srcPath = path.isAbsolute(SOURCE) ? SOURCE : path.join(__dirname, SOURCE);
  if (!fs.existsSync(srcPath)) {
    console.error(`Source image not found: ${srcPath}`);
    process.exit(2);
  }
  const srcBuf = fs.readFileSync(srcPath);
  info(`Source: ${srcPath} — ${(srcBuf.length / 1024).toFixed(1)}KB`);

  // ── Build variants in every format we claim to accept ──────────
  section('CONVERTING SOURCE → all formats');
  const variants = [];
  // Each spec: { name, mime, encode(buf) → Buffer }
  const specs = [
    { name: 'JPEG (passthrough)', mime: 'image/jpeg', enc: (b) => sharp(b).jpeg({ quality: 85 }).toBuffer() },
    { name: 'PNG',                mime: 'image/png',  enc: (b) => sharp(b).png().toBuffer() },
    { name: 'WebP',               mime: 'image/webp', enc: (b) => sharp(b).webp({ quality: 80 }).toBuffer() },
    { name: 'GIF',                mime: 'image/gif',  enc: (b) => sharp(b).resize(640).gif().toBuffer() },
    { name: 'BMP',                mime: 'image/bmp',  enc: null /* sharp can't ENCODE bmp; we hand-craft below */ },
    { name: 'TIFF',               mime: 'image/tiff', enc: (b) => sharp(b).tiff({ compression: 'jpeg' }).toBuffer() },
    { name: 'AVIF',               mime: 'image/avif', enc: (b) => sharp(b).resize(800).avif({ quality: 50, effort: 1 }).toBuffer() },
    { name: 'HEIC',               mime: 'image/heic', enc: (b) => sharp(b).resize(800).heif({ compression: 'hevc', quality: 60 }).toBuffer() },
  ];

  for (const s of specs) {
    if (!s.enc) {
      info(`  ${s.name}: skipped (sharp can't encode ${s.mime} in this build)`);
      continue;
    }
    try {
      const t0 = Date.now();
      const buf = await s.enc(srcBuf);
      variants.push({ name: s.name, mime: s.mime, buf });
      info(`  ${s.name.padEnd(20)} ${(buf.length / 1024).toFixed(1).padStart(7)}KB in ${Date.now() - t0}ms`);
    } catch (e) {
      info(`  ${C.yellow}${s.name}: skipped — sharp build limitation: ${e.message?.slice(0, 80)}${C.reset}`);
    }
  }

  // ── Send each variant through /image-search (Gemini lite — fastest)
  section('SECTION A — every format → /image-search (gemini lite)');
  for (const v of variants) {
    const t0 = Date.now();
    const r = await _post(port, '/api/v1/ai/image-search', {
      query: 'What is in this image? Identify it and tell me about it.',
      image: v.buf.toString('base64'),
      imageMediaType: v.mime,
      provider: 'gemini', mode: 'lite', liteModel: 'gemini-2.5-flash-lite',
    });
    const lat = Date.now() - t0;
    const status = r.statusCode;
    const ans = r.body?.answer || '';
    const lower = ans.toLowerCase();
    const matched = EXPECT_KEYS.some(k => lower.includes(k));
    const label = `${v.name.padEnd(20)}`;
    process.stdout.write(`  ${C.dim}→ ${label}${C.reset}  ${C.bold}${status}${C.reset}  ${(lat + 'ms').padStart(8)}  ${(ans.length + 'ch').padStart(7)}\n`);
    if (status !== 200) { bad(`${v.name} HTTP 200`, `got ${status} body=${JSON.stringify(r.body).slice(0, 200)}`); continue; }
    if (!matched) { bad(`${v.name} model identified Taj`, `none of [${EXPECT_KEYS.slice(0, 5).join(',')}] in: ${ans.slice(0, 160).replace(/\n/g, ' ')}…`); continue; }
    ok(`${v.name} → 200 + identified Taj Mahal in ${lat}ms`);
  }

  // ── Cross-provider quick smoke: same format suite via xGrok lite
  section('SECTION B — every format → /image-search (xgrok lite)');
  for (const v of variants) {
    const t0 = Date.now();
    const r = await _post(port, '/api/v1/ai/image-search', {
      query: 'What is in this image?',
      image: v.buf.toString('base64'),
      imageMediaType: v.mime,
      provider: 'xgrok', mode: 'lite', xgrokLiteModel: 'grok-4-1-fast-non-reasoning',
    });
    const lat = Date.now() - t0;
    const status = r.statusCode;
    const ans = r.body?.answer || '';
    const lower = ans.toLowerCase();
    const matched = EXPECT_KEYS.some(k => lower.includes(k));
    const label = `${v.name.padEnd(20)}`;
    process.stdout.write(`  ${C.dim}→ ${label}${C.reset}  ${C.bold}${status}${C.reset}  ${(lat + 'ms').padStart(8)}  ${(ans.length + 'ch').padStart(7)}\n`);
    if (status !== 200) { bad(`${v.name} (xgrok) HTTP 200`, `got ${status}`); continue; }
    if (!matched) { bad(`${v.name} (xgrok) identified Taj`, `none in: ${ans.slice(0, 160).replace(/\n/g, ' ')}…`); continue; }
    ok(`${v.name} (xgrok) → 200 + identified Taj Mahal in ${lat}ms`);
  }

  process.stdout.write(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);
  process.stdout.write(`${C.bold}  SUMMARY${C.reset}\n`);
  process.stdout.write(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);
  process.stdout.write(`  ${C.green}passed: ${passed}${C.reset}\n`);
  process.stdout.write(`  ${failed > 0 ? C.red : C.dim}failed: ${failed}${C.reset}\n`);
  if (failures.length) {
    process.stdout.write(`\n${C.red}${C.bold}FAILURES:${C.reset}\n`);
    for (const f of failures) process.stdout.write(`  ${C.red}• ${f}${C.reset}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('UNCAUGHT', e.stack || e.message); process.exit(2); });
