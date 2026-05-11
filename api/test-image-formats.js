'use strict';

// ═══════════════════════════════════════════════════════════════
//  IMAGE FORMAT COVERAGE TESTS
//
//  Direct unit tests for image-preprocess.js — proves:
//    • Magic-byte sniffer correctly identifies every supported
//      format from real header bytes (not from claimed mime).
//    • Validator accepts every format in the supported set, in
//      both sharp-installed and sharp-missing modes.
//    • Validator rejects truly unsupported formats fast.
//    • Preprocessor transcodes ALL formats to image/jpeg when
//      sharp is available.
//    • Client-claimed mime mismatch is overridden by sniff.
//
//  Run: node backend/api/test-image-formats.js
//  Exits 0 on success, 1 on any failure.
// ═══════════════════════════════════════════════════════════════

const path = require('path');

// Mock telegram before requiring image-preprocess (which imports it).
const telegramPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(telegramPath)] = {
  id: telegramPath, filename: telegramPath, loaded: true,
  exports: { tg: { d() {}, i() {}, w() {}, e() {}, fatal() {} } },
};

const {
  validateImagePayload,
  preprocessForVision,
  isSharpAvailable,
  ACCEPTED_MEDIA_TYPES,
  PROVIDER_NATIVE_MIMES,
  SHARP_EXTRA_MIMES,
  _sniffMimeForTesting,
} = require('./src/image-preprocess');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};
let passed = 0, failed = 0;
const failures = [];
function log(m) { process.stdout.write(`${m}\n`); }
function ok(name, detail) { passed++; log(`  ${C.green}✓${C.reset} ${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`); }
function bad(name, why) { failed++; failures.push(`${name} — ${why}`); log(`  ${C.red}✗ ${name}${C.reset}\n     ${C.red}${why}${C.reset}`); }
function section(t) { log(`\n${C.cyan}${C.bold}━━━ ${t} ━━━${C.reset}`); }
function assertEq(a, e, name) { (JSON.stringify(a) === JSON.stringify(e)) ? ok(name, `= ${JSON.stringify(a)}`) : bad(name, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assert(c, name, why) { c ? ok(name) : bad(name, why || 'assertion failed'); }

// ── Synthetic header buffers for every format we claim to handle ──
// Each is just enough to tickle the magic-byte sniffer; the rest is
// padding so the buffer is ≥12 bytes (the sniffer's minimum).
const PAD = Buffer.alloc(64, 0x55); // arbitrary trailing bytes

const HEADERS = {
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), PAD]),
  png:  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]), PAD]),
  apng: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG sig
    Buffer.from([0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4c]), // acTL chunk header
    PAD,
  ]),
  gif:  Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x10, 0x00, 0x10, 0x00, 0x80, 0x00]), PAD]),
  bmp:  Buffer.concat([Buffer.from('BM'), Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00]), PAD]),
  tiff: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), PAD]),
  ico:  Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00]), PAD]),
  jxl_codestream: Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.alloc(20, 0x00)]),
  jxl_box: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), PAD]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), PAD]),
  // ISOBMFF: 4 size bytes + "ftyp" + 4-byte brand + ...
  heic: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'), PAD]),
  heif: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('mif1'), PAD]),
  avif: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('avif'), PAD]),
};

// ════════════════════════════════════════════════════════════════
//  GROUP 1 — Magic-byte sniffer
// ════════════════════════════════════════════════════════════════
section('GROUP 1 — magic-byte sniffer identifies every format');

assertEq(_sniffMimeForTesting(HEADERS.jpeg), 'image/jpeg', 'JPEG header → image/jpeg');
assertEq(_sniffMimeForTesting(HEADERS.png), 'image/png', 'PNG header → image/png');
assertEq(_sniffMimeForTesting(HEADERS.apng), 'image/apng', 'APNG (PNG+acTL) → image/apng');
assertEq(_sniffMimeForTesting(HEADERS.gif), 'image/gif', 'GIF header → image/gif');
assertEq(_sniffMimeForTesting(HEADERS.bmp), 'image/bmp', 'BMP header → image/bmp');
assertEq(_sniffMimeForTesting(HEADERS.tiff), 'image/tiff', 'TIFF (little-endian) → image/tiff');
assertEq(_sniffMimeForTesting(HEADERS.ico), 'image/x-icon', 'ICO header → image/x-icon');
assertEq(_sniffMimeForTesting(HEADERS.jxl_codestream), 'image/jxl', 'JXL codestream → image/jxl');
assertEq(_sniffMimeForTesting(HEADERS.jxl_box), 'image/jxl', 'JXL ISOBMFF box → image/jxl');
assertEq(_sniffMimeForTesting(HEADERS.webp), 'image/webp', 'WebP RIFF → image/webp');
assertEq(_sniffMimeForTesting(HEADERS.heic), 'image/heic', 'HEIC ftyp → image/heic');
assertEq(_sniffMimeForTesting(HEADERS.heif), 'image/heif', 'HEIF (mif1) ftyp → image/heif');
assertEq(_sniffMimeForTesting(HEADERS.avif), 'image/avif', 'AVIF ftyp → image/avif');

assertEq(_sniffMimeForTesting(Buffer.alloc(8, 0)), null, '<12 bytes → null (too small)');
assertEq(_sniffMimeForTesting(Buffer.from('this is not an image at all just plain bytes')), null,
  'plain text bytes → null (no magic match)');
assertEq(_sniffMimeForTesting(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')), null,
  'SVG → null (intentionally not in sniff table for security)');
assertEq(_sniffMimeForTesting(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3')), null,
  'PDF magic → null (not an image)');

// ════════════════════════════════════════════════════════════════
//  GROUP 2 — Validator accepts every format the sniffer recognises
// ════════════════════════════════════════════════════════════════
section('GROUP 2 — validator accepts every format the sniffer recognises');

// Build base64 wire payloads from the synthetic headers.
function _b64(buf) { return buf.toString('base64'); }

const formatTable = [
  { name: 'JPEG', buf: HEADERS.jpeg, claimed: 'image/jpeg', expected: 'image/jpeg' },
  { name: 'JPG  (alias)', buf: HEADERS.jpeg, claimed: 'image/jpg', expected: 'image/jpeg' },
  { name: 'PNG', buf: HEADERS.png, claimed: 'image/png', expected: 'image/png' },
  { name: 'APNG', buf: HEADERS.apng, claimed: 'image/apng', expected: 'image/apng' },
  { name: 'GIF', buf: HEADERS.gif, claimed: 'image/gif', expected: 'image/gif' },
  { name: 'BMP', buf: HEADERS.bmp, claimed: 'image/bmp', expected: 'image/bmp' },
  { name: 'TIFF', buf: HEADERS.tiff, claimed: 'image/tiff', expected: 'image/tiff' },
  { name: 'ICO', buf: HEADERS.ico, claimed: 'image/x-icon', expected: 'image/x-icon' },
  { name: 'WebP', buf: HEADERS.webp, claimed: 'image/webp', expected: 'image/webp' },
  { name: 'HEIC', buf: HEADERS.heic, claimed: 'image/heic', expected: 'image/heic' },
  { name: 'HEIF', buf: HEADERS.heif, claimed: 'image/heif', expected: 'image/heif' },
  { name: 'AVIF', buf: HEADERS.avif, claimed: 'image/avif', expected: 'image/avif' },
  { name: 'JXL (codestream)', buf: HEADERS.jxl_codestream, claimed: 'image/jxl', expected: 'image/jxl' },
  { name: 'JXL (box)', buf: HEADERS.jxl_box, claimed: 'image/jxl', expected: 'image/jxl' },
];

for (const f of formatTable) {
  const v = validateImagePayload(_b64(f.buf), f.claimed);
  // Sharp-only formats are accepted only when sharp is loaded.
  const isSharpOnly = SHARP_EXTRA_MIMES.has(f.expected);
  if (isSharpOnly && !isSharpAvailable()) {
    assert(!v.ok, `${f.name} → 400 (sharp unavailable, intentional)`,
      `expected reject, got ${JSON.stringify(v).slice(0, 120)}`);
  } else {
    assert(v.ok === true, `${f.name} → accepted`,
      v.ok ? '' : `error: ${v.error}`);
    if (v.ok) assertEq(v.mediaType, f.expected, `${f.name} mediaType normalised`);
  }
}

// ════════════════════════════════════════════════════════════════
//  GROUP 3 — Sniff-vs-claim conflict resolution (sniff wins)
// ════════════════════════════════════════════════════════════════
section('GROUP 3 — magic-byte sniff overrides client-claimed mime');

{
  // Client lies: says image/jpeg but bytes are a real PNG.
  const v = validateImagePayload(_b64(HEADERS.png), 'image/jpeg');
  assert(v.ok === true, 'PNG bytes claimed as JPEG → accepted');
  assertEq(v.mediaType, 'image/png', 'sniff overrides → mediaType=png');
  assertEq(v.sniffedMime, 'image/png', 'sniffedMime exposed to caller');
  assertEq(v.claimedMime, 'image/jpeg', 'claimedMime exposed to caller');
}
{
  // Client claims totally bogus type (application/pdf), bytes are PNG.
  const v = validateImagePayload(_b64(HEADERS.png), 'application/pdf');
  assert(v.ok === true, 'PNG bytes + bogus claim → still accepted (sniff wins)');
  assertEq(v.mediaType, 'image/png', 'mediaType resolved from bytes');
}
{
  // Client claims valid type but bytes are garbage text.
  const v = validateImagePayload(Buffer.from('not an image at all, just bytes').toString('base64'), 'image/jpeg');
  assert(v.ok === false, 'garbage bytes claimed as JPEG → rejected');
  assert(v.error.includes('do not match'), 'error explains byte mismatch',
    `got: ${v.error}`);
}
{
  // No claim at all, bytes are PNG. Sniffer fills in.
  const v = validateImagePayload(_b64(HEADERS.png), undefined);
  assert(v.ok === true, 'missing imageMediaType + valid bytes → accepted');
  assertEq(v.mediaType, 'image/png', 'mime resolved from bytes alone');
}

// ════════════════════════════════════════════════════════════════
//  GROUP 4 — Hard rejections (truly unsupported)
// ════════════════════════════════════════════════════════════════
section('GROUP 4 — rejects truly unsupported types');

{
  // SVG bytes → sniffer returns null, validator rejects.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const v = validateImagePayload(svg.toString('base64'), 'image/svg+xml');
  assert(v.ok === false, 'SVG → rejected (intentional, security)');
}
{
  // PDF magic.
  const pdf = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\nthis is a pdf');
  const v = validateImagePayload(pdf.toString('base64'), 'application/pdf');
  assert(v.ok === false, 'PDF magic → rejected');
}
{
  // Random bytes claimed as a known image type.
  const garbage = Buffer.alloc(100, 0xab);
  const v = validateImagePayload(garbage.toString('base64'), 'image/png');
  assert(v.ok === false, 'random bytes claimed as PNG → rejected');
}
{
  // Empty / too-short.
  const v = validateImagePayload('AAAA', 'image/jpeg');
  assert(v.ok === false, 'too-short string → rejected');
}
{
  // Not base64 at all.
  const v = validateImagePayload('@@@not-base64@@@', 'image/jpeg');
  assert(v.ok === false, 'non-base64 → rejected');
}

// ════════════════════════════════════════════════════════════════
//  GROUP 5 — Preprocessor transcodes everything → JPEG (sharp only)
// ════════════════════════════════════════════════════════════════
if (isSharpAvailable()) {
  section('GROUP 5 — preprocessor transcodes ALL formats → image/jpeg');

  const sharp = require('sharp');
  // Make a small REAL image in each format that sharp can encode, and
  // verify preprocessForVision returns image/jpeg for each.
  const formats = [
    { name: 'PNG → JPEG', encoder: () => sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 200 } } }).png().toBuffer(), inputMime: 'image/png' },
    { name: 'WebP → JPEG', encoder: () => sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 200 } } }).webp().toBuffer(), inputMime: 'image/webp' },
    { name: 'TIFF → JPEG', encoder: () => sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 200 } } }).tiff().toBuffer(), inputMime: 'image/tiff' },
    { name: 'GIF → JPEG', encoder: () => sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 200 } } }).gif().toBuffer(), inputMime: 'image/gif' },
    { name: 'AVIF → JPEG', encoder: () => sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 200 } } }).avif({ effort: 0 }).toBuffer(), inputMime: 'image/avif' },
  ];

  (async () => {
    for (const f of formats) {
      let buf;
      try { buf = await f.encoder(); } catch (e) {
        // Some libvips builds skip AVIF / JXL / etc.
        log(`  ${C.yellow}- ${f.name}: skipped (libvips build limitation: ${e.message?.slice(0, 60)})${C.reset}`);
        continue;
      }
      const v = validateImagePayload(buf.toString('base64'), f.inputMime);
      if (!v.ok) {
        bad(`${f.name} validator`, v.error);
        continue;
      }
      const prep = await preprocessForVision(v.base64, v.mediaType);
      assertEq(prep.mediaType, 'image/jpeg', `${f.name} — output is image/jpeg`);
      assert(prep.transcoded === true, `${f.name} — transcoded=true`);
      // Decode the output and verify it's a real JPEG.
      const outBuf = Buffer.from(prep.base64, 'base64');
      assert(outBuf[0] === 0xff && outBuf[1] === 0xd8 && outBuf[2] === 0xff,
        `${f.name} — output starts with JPEG magic`,
        `got ${outBuf[0].toString(16)} ${outBuf[1].toString(16)} ${outBuf[2].toString(16)}`);
    }

    // Resize check: large input → resized down to ≤1568 px long edge.
    section('GROUP 6 — preprocessor resizes oversized images');
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 80, g: 160, b: 240 } } }).jpeg().toBuffer();
    const vBig = validateImagePayload(big.toString('base64'), 'image/jpeg');
    assert(vBig.ok, 'oversized 4000×3000 input validates');
    const prepBig = await preprocessForVision(vBig.base64, vBig.mediaType);
    assert(prepBig.downscaled === true, 'oversized input → downscaled=true');
    const meta = await sharp(Buffer.from(prepBig.base64, 'base64')).metadata();
    assert(Math.max(meta.width, meta.height) <= 1568,
      `output long edge ≤ 1568 (got ${meta.width}×${meta.height})`);
    // Compression check: byte count must shrink.
    assert(prepBig.processedBytes < prepBig.originalBytes,
      `byte count shrunk (${(prepBig.originalBytes / 1024).toFixed(0)}KB → ${(prepBig.processedBytes / 1024).toFixed(0)}KB)`);

    // ────────────────────────────────────────────────────────────
    //  SUMMARY
    // ────────────────────────────────────────────────────────────
    log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    log(`${C.bold}  SUMMARY${C.reset}`);
    log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    log(`  ${C.green}passed: ${passed}${C.reset}`);
    log(`  ${failed > 0 ? C.red : C.dim}failed: ${failed}${C.reset}`);
    log(`  ${C.dim}sharp: ${isSharpAvailable() ? 'available' : 'NOT installed (sharp-only formats skipped)'}${C.reset}`);
    log(`  ${C.dim}accepted mimes: ${[...ACCEPTED_MEDIA_TYPES].sort().join(', ')}${C.reset}`);
    if (failures.length) {
      log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
      for (const x of failures) log(`  ${C.red}• ${x}${C.reset}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  })().catch(e => { console.error('UNCAUGHT', e); process.exit(2); });
} else {
  log(`\n${C.yellow}sharp not installed — skipping GROUP 5+6 (transcoding tests)${C.reset}`);
  log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}  SUMMARY${C.reset}`);
  log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`  ${C.green}passed: ${passed}${C.reset}`);
  log(`  ${failed > 0 ? C.red : C.dim}failed: ${failed}${C.reset}`);
  if (failures.length) {
    log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
    for (const x of failures) log(`  ${C.red}• ${x}${C.reset}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}
