'use strict';

// ═══════════════════════════════════════════════════════════════
//  IMAGE PREPROCESSING — server-side normalise + resize + transcode
//
//  Why: phones happily upload 12 MP photos (~12 MB JPEG / 30 MB PNG)
//  in any of a dozen formats — JPEG, PNG, WebP, HEIC/HEIF (iPhone),
//  AVIF (modern Android), GIF, BMP, TIFF, JXL, ICO, etc. — and the
//  LLM providers each accept a different subset. Re-shrinking +
//  transcoding on the backend gives us:
//
//    • Universal input acceptance — any raster format sharp can decode
//    • Provider-uniform output — always send image/jpeg, never WEBP/HEIC
//    • Predictable, small payloads (faster + cheaper)
//    • EXIF strip (no GPS coords leak through to the model)
//    • Auto-rotation honoured then dropped (orientation-correct output)
//    • A safety net when the client mis-compresses
//
//  Sharp is optionally-required: when it isn't installed we fall back
//  to "provider-native passthrough" — only formats every provider
//  handles natively are accepted, the rest are rejected with a clear
//  error pointing at the install fix.
// ═══════════════════════════════════════════════════════════════

const { tg } = require('./telegram');

let _sharp = null;
let _sharpAvailable = false;
try {
  // eslint-disable-next-line global-require
  _sharp = require('sharp');
  _sharpAvailable = true;
  console.log('[ImgPrep] sharp available — server-side image preprocessing ENABLED');
} catch (_) {
  console.warn('[ImgPrep] sharp not installed — server-side image preprocessing DISABLED (passthrough; only provider-native formats accepted)');
}

// Anthropic / Google both recommend a long edge of ~1568 px for vision
// models — beyond that the extra detail rarely changes the answer but
// dramatically increases latency. JPEG q=82 is the sweet spot for
// photographic content.
const MAX_LONG_EDGE_PX = 1568;
const JPEG_QUALITY = 82;

// Server-side accept ceiling. The express body limit is 10 MB JSON; a
// base64 string of N bytes is 4*ceil(N/3). 8 MB base64 ≈ 6 MB raw.
const MAX_BASE64_BYTES = 8 * 1024 * 1024;

// ── MIME tiers ──────────────────────────────────────────────────
//
//  PROVIDER_NATIVE  → jpeg/png/webp/gif/heic/heif. Both Gemini and
//                     xGrok accept these without help. Safe to send
//                     even if sharp is unavailable.
//  SHARP_DECODABLE  → everything libvips/sharp can input.
//                     Always transcoded to image/jpeg before egress
//                     so the provider always sees the same wire shape.
//  REJECTED         → anything not in either set above.
//
const _PROVIDER_NATIVE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png',
  'image/webp', 'image/gif',
  'image/heic', 'image/heif',
]);

const _SHARP_EXTRA_MIMES = new Set([
  'image/bmp',
  'image/tiff', 'image/x-tiff',
  'image/avif',
  'image/jxl',                                  // libvips 8.16+
  'image/x-icon', 'image/vnd.microsoft.icon',   // .ico
  'image/apng',                                 // animated PNG (sharp reads first frame)
  // Note: SVG is intentionally NOT accepted. It is a vector / XML format
  // that opens up billion-laughs / external-entity / script-injection
  // surface area we don't need for an LLM-vision use case.
]);

// Build the full accepted set based on whether sharp is loaded.
function _buildAcceptedSet() {
  const s = new Set(_PROVIDER_NATIVE_MIMES);
  if (_sharpAvailable) for (const m of _SHARP_EXTRA_MIMES) s.add(m);
  return s;
}
let ACCEPTED_MEDIA_TYPES = _buildAcceptedSet();

function _normaliseMediaType(mediaType) {
  const m = String(mediaType || '').trim().toLowerCase();
  if (!m) return 'image/jpeg';
  if (m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/x-tiff') return 'image/tiff';
  if (m === 'image/vnd.microsoft.icon') return 'image/x-icon';
  return m;
}

function _stripDataUrlPrefix(b64) {
  if (typeof b64 !== 'string') return '';
  const idx = b64.indexOf('base64,');
  return idx === -1 ? b64 : b64.slice(idx + 'base64,'.length);
}

// ── Magic-byte sniffer ──────────────────────────────────────────
//
//  Definitive source of truth. Phones lie about extensions all the
//  time — iPhone "screenshots" sent over WhatsApp arrive as PNGs
//  named .jpg, Android shares of HEIC photos via Drive sometimes
//  end up labelled image/jpeg, Apple Photos exports HEIC with .jpg
//  extensions when "Most Compatible" is half-broken, etc.
//
//  We sniff the leading bytes and trust ONLY what we see — the
//  client's claimed MIME is treated as a hint, not gospel.
//
function _sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;

  // JPEG — FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';

  // PNG / APNG — 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    // Look for an "acTL" chunk in the first ~4KB to distinguish APNG.
    const head = b.slice(0, Math.min(4096, b.length));
    for (let i = 8; i < head.length - 4; i++) {
      if (head[i] === 0x61 && head[i + 1] === 0x63 && head[i + 2] === 0x54 && head[i + 3] === 0x4c) {
        return 'image/apng';
      }
      // First IDAT means we've passed the metadata — bail.
      if (head[i] === 0x49 && head[i + 1] === 0x44 && head[i + 2] === 0x41 && head[i + 3] === 0x54) break;
    }
    return 'image/png';
  }

  // GIF — "GIF87a" / "GIF89a"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
      && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';

  // BMP — "BM"
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';

  // TIFF — little-endian "II*\0" or big-endian "MM\0*"
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00)
      || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'image/tiff';

  // ICO — 00 00 01 00 (icon resource)
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';

  // JPEG XL codestream — FF 0A
  if (b[0] === 0xff && b[1] === 0x0a) return 'image/jxl';

  // JPEG XL ISOBMFF container — 00 00 00 0C 4A 58 4C 20 0D 0A 87 0A
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0c
      && b[4] === 0x4a && b[5] === 0x58 && b[6] === 0x4c && b[7] === 0x20) return 'image/jxl';

  // RIFF...WEBP — "RIFF" + 4 size bytes + "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';

  // ISOBMFF (HEIC / HEIF / AVIF / JP2) — bytes 4-7 = "ftyp",
  // bytes 8-11 = brand. Some files have a 4-byte size field first then
  // "ftyp" — that's the standard layout we already check.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = b.slice(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heim', 'heis', 'heif'].includes(brand)) return 'image/heif';
    if (brand === 'jp2 ') return 'image/jp2';
    // Unknown ftyp brand — best guess HEIC (most common phone case).
    return 'image/heic';
  }

  return null;
}

/**
 * Validate the wire-shape image payload. Pure synchronous, cheap.
 *
 * Validation order (all under ~1ms):
 *   1. base64 string + length + character whitelist
 *   2. Decode header bytes ONLY (first 64) to sniff the actual mime
 *   3. Sniffed mime authoritative — falls back to claimed mime when
 *      sniff returns null (e.g. for very small valid images)
 *   4. Reject if not in the accepted set (sharp-aware)
 *
 * @param {string} image - base64 (with or without `data:` prefix)
 * @param {string} imageMediaType - claimed mime from the client
 * @returns {{ok: true, base64: string, mediaType: string, sniffedMime: string|null} | {ok: false, error: string}}
 */
function validateImagePayload(image, imageMediaType) {
  if (typeof image !== 'string' || image.length < 32) {
    return { ok: false, error: 'image is required (base64 string)' };
  }
  const b64 = _stripDataUrlPrefix(image);
  if (b64.length > MAX_BASE64_BYTES) {
    return {
      ok: false,
      error: `image too large (${(b64.length / 1024 / 1024).toFixed(1)}MB base64; max ${MAX_BASE64_BYTES / 1024 / 1024}MB)`,
    };
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) {
    return { ok: false, error: 'image is not valid base64' };
  }
  const claimed = _normaliseMediaType(imageMediaType);
  if (!claimed || claimed === 'image/jpeg' && !imageMediaType) {
    // imageMediaType was missing entirely — we'll let the sniffer
    // decide. If sniff also fails we bail out below.
  }

  // Decode just the header for sniffing (cheap — base64 → ~192 bytes).
  let headerBuf = null;
  try {
    headerBuf = Buffer.from(b64.slice(0, 256), 'base64');
  } catch (_) {
    return { ok: false, error: 'image is not valid base64 (decode failed)' };
  }
  const sniffed = _sniffMime(headerBuf);

  // Resolution rules — magic-byte sniff wins when it succeeds:
  //   sniff hits           → trust sniff (client claim is just a hint)
  //   sniff misses, ≥12 B  → genuine garbage; reject hard
  //   sniff misses, <12 B  → too small to sniff; trust claimed mime
  let truth;
  if (sniffed) {
    truth = sniffed;
  } else if (headerBuf.length >= 12) {
    return {
      ok: false,
      error: claimed
        ? `image bytes do not match any known image format (client claimed "${claimed}")`
        : 'image bytes do not match any known image format',
    };
  } else if (claimed) {
    truth = claimed;
  } else {
    return { ok: false, error: 'unable to determine image type (provide imageMediaType)' };
  }

  if (!ACCEPTED_MEDIA_TYPES.has(truth)) {
    const hint = !_sharpAvailable && _SHARP_EXTRA_MIMES.has(truth)
      ? ` (install sharp on the server to enable ${truth})`
      : '';
    return { ok: false, error: `imageMediaType "${truth}" not supported${hint}` };
  }

  return {
    ok: true,
    base64: b64,
    mediaType: _normaliseMediaType(truth),
    sniffedMime: sniffed,
    claimedMime: claimed,
  };
}

/**
 * Decode → resize → transcode-to-JPEG. With sharp installed this
 * is the unified output path — no matter what the client sent we
 * always hand the provider a clean stripped JPEG. Without sharp,
 * provider-native input passes through unchanged (the validator
 * has already filtered out non-native types in that mode).
 *
 * @param {string} base64 - already-validated, no data: prefix
 * @param {string} mediaType - normalised lowercase mime
 * @returns {Promise<{base64: string, mediaType: string, originalBytes: number, processedBytes: number, downscaled: boolean, transcoded: boolean, durationMs: number, error?: string}>}
 */
async function preprocessForVision(base64, mediaType) {
  const t0 = Date.now();
  const originalBytes = base64.length;

  if (!_sharpAvailable) {
    return {
      base64,
      mediaType,
      originalBytes,
      processedBytes: originalBytes,
      downscaled: false,
      transcoded: false,
      durationMs: Date.now() - t0,
    };
  }

  try {
    const buf = Buffer.from(base64, 'base64');
    // For animated formats (GIF, APNG, animated WebP) sharp by default
    // takes only the first frame; that's exactly what we want for
    // vision — the model sees the initial frame, no extra payload.
    const sharpInput = _sharp(buf, { failOn: 'truncated', animated: false });
    const meta = await sharpInput.metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);

    // Always transcode unless the input is already an
    // appropriately-small JPEG (cheap fast-path).
    const needsResize = longEdge > MAX_LONG_EDGE_PX;
    const needsTranscode = mediaType !== 'image/jpeg';

    if (!needsResize && !needsTranscode) {
      return {
        base64,
        mediaType: 'image/jpeg',
        originalBytes,
        processedBytes: originalBytes,
        downscaled: false,
        transcoded: false,
        durationMs: Date.now() - t0,
      };
    }

    let pipeline = _sharp(buf, { failOn: 'truncated', animated: false })
      .rotate();              // honour EXIF orientation, then drop the tag
    if (needsResize) {
      pipeline = pipeline.resize({
        width: MAX_LONG_EDGE_PX,
        height: MAX_LONG_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    // Flatten over white for any input that has alpha (PNG / WebP /
    // AVIF / HEIF) — JPEG has no alpha and a dark default would look
    // wrong to the model.
    const out = await pipeline
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    const outBase64 = out.toString('base64');
    const durationMs = Date.now() - t0;
    const ratio = (out.length / buf.length);
    console.log(
      `[ImgPrep] ${mediaType} ${meta.width}x${meta.height} ${(buf.length / 1024).toFixed(0)}KB → `
      + `image/jpeg ${Math.min(meta.width || 0, MAX_LONG_EDGE_PX)}px ${(out.length / 1024).toFixed(0)}KB `
      + `(${(ratio * 100).toFixed(0)}%) ${durationMs}ms`,
    );
    return {
      base64: outBase64,
      mediaType: 'image/jpeg',
      originalBytes,
      processedBytes: outBase64.length,
      downscaled: needsResize,
      transcoded: needsTranscode,
      durationMs,
    };
  } catch (e) {
    // Sharp couldn't parse — log and fall back to the original bytes.
    // For provider-native types this is harmless; for sharp-only types
    // it'll likely fail at the provider too, but at least we get a
    // structured upstream error.
    console.warn(`[ImgPrep] sharp failed (${e.message?.slice(0, 120)}) — passthrough`);
    tg.w('ImgPrep', `sharp preprocessing failed for ${mediaType} (${(originalBytes / 1024).toFixed(0)}KB)`, e);
    return {
      base64,
      mediaType,
      originalBytes,
      processedBytes: originalBytes,
      downscaled: false,
      transcoded: false,
      durationMs: Date.now() - t0,
      error: e.message?.slice(0, 200),
    };
  }
}

function isSharpAvailable() {
  return _sharpAvailable;
}

function getMaxBase64Bytes() {
  return MAX_BASE64_BYTES;
}

// Exposed for tests — lets us prove magic-byte sniffing in isolation.
function _sniffMimeForTesting(buf) {
  return _sniffMime(buf);
}

module.exports = {
  validateImagePayload,
  preprocessForVision,
  isSharpAvailable,
  getMaxBase64Bytes,
  MAX_LONG_EDGE_PX,
  ACCEPTED_MEDIA_TYPES,
  PROVIDER_NATIVE_MIMES: _PROVIDER_NATIVE_MIMES,
  SHARP_EXTRA_MIMES: _SHARP_EXTRA_MIMES,
  _sniffMimeForTesting,
};
