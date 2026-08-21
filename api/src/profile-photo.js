'use strict';

// ═══════════════════════════════════════════════════════════════
//  PROFILE PHOTO — one rolling JPEG for the single app login
//
//  Phone and web both PUT/GET/DELETE the same row so a new install
//  shows the picture as soon as the owner signs in. Drive backup
//  copies the base64 payload with the rest of user data.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const PHOTO_ID = 'app';
const MIN_JPEG_BYTES = 128;
const MAX_JPEG_BYTES = 256 * 1024;
const MAX_B64_CHARS = Math.ceil(MAX_JPEG_BYTES / 3) * 4 + 64;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_JPEG_BYTES) return false;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
  return buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

function stripDataUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const comma = s.indexOf(',');
  if (s.slice(0, 5).toLowerCase() === 'data:' && comma !== -1) {
    return s.slice(comma + 1);
  }
  return s.replace(/\s+/g, '');
}

function decodeJpegBase64(raw) {
  const b64 = stripDataUrl(raw);
  if (!b64) {
    const err = new Error('Photo is empty');
    err.status = 400;
    err.code = 'PHOTO_EMPTY';
    throw err;
  }
  if (b64.length > MAX_B64_CHARS) {
    const err = new Error('Photo is too large. Pick one under 200 KB.');
    err.status = 413;
    err.code = 'PHOTO_TOO_LARGE';
    throw err;
  }
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    const err = new Error("Couldn't read that photo. Try another.");
    err.status = 400;
    err.code = 'PHOTO_INVALID';
    throw err;
  }
  // Buffer.from('!!!', 'base64') does not throw — it yields a short junk buffer.
  if (!isJpeg(buf) || buf.length > MAX_JPEG_BYTES) {
    const err = new Error(
      buf.length > MAX_JPEG_BYTES
        ? 'Photo is too large. Pick one under 200 KB.'
        : "Couldn't read that photo. Try another.",
    );
    err.status = buf.length > MAX_JPEG_BYTES ? 413 : 400;
    err.code = buf.length > MAX_JPEG_BYTES ? 'PHOTO_TOO_LARGE' : 'PHOTO_INVALID';
    throw err;
  }
  return buf;
}

function etagFor(sha) {
  return `"${sha}"`;
}

function ifNoneMatchHits(header, sha) {
  if (!header || !sha) return false;
  const want = etagFor(sha);
  return String(header)
    .split(',')
    .map((p) => p.trim())
    .some((p) => p === want || p === `W/${want}`);
}

function metaRow(row) {
  if (!row) return { exists: false };
  return {
    exists: true,
    sha256: row.sha256,
    bytes: Number(row.bytes) || 0,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at || ''),
  };
}

async function readRow(pool) {
  const { rows } = await pool.query(
    `SELECT jpeg_b64, sha256, bytes, updated_at
       FROM profile_photo WHERE id = $1`,
    [PHOTO_ID],
  );
  return rows[0] || null;
}

async function wipeProfilePhoto(pool) {
  await pool.query('DELETE FROM profile_photo');
}

function buildProfilePhotoRouter(express, pool, { onMutate } = {}) {
  const ping = (reason) => {
    try {
      if (typeof onMutate === 'function') onMutate(reason);
    } catch {
      // Backup scheduling must never fail a user-visible save/delete.
    }
  };
  const router = express.Router();

  router.get('/photo/meta', async (_req, res, next) => {
    try {
      const row = await readRow(pool);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(metaRow(row));
    } catch (err) {
      next(err);
    }
  });

  router.get('/photo', async (req, res, next) => {
    try {
      const row = await readRow(pool);
      if (!row) return res.status(204).end();
      if (ifNoneMatchHits(req.headers['if-none-match'], row.sha256)) {
        res.setHeader('ETag', etagFor(row.sha256));
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        return res.status(304).end();
      }
      const jpeg = Buffer.from(String(row.jpeg_b64 || ''), 'base64');
      if (!isJpeg(jpeg)) return res.status(204).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('ETag', etagFor(row.sha256));
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('Content-Length', String(jpeg.length));
      return res.status(200).end(jpeg);
    } catch (err) {
      next(err);
    }
  });

  router.put('/photo', async (req, res, next) => {
    try {
      const raw = req.body && req.body.jpegBase64;
      const jpeg = decodeJpegBase64(raw);
      const sha = sha256Hex(jpeg);
      const b64 = jpeg.toString('base64');
      const { rows } = await pool.query(
        `INSERT INTO profile_photo (id, jpeg_b64, sha256, bytes, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO UPDATE SET
           jpeg_b64 = EXCLUDED.jpeg_b64,
           sha256 = EXCLUDED.sha256,
           bytes = EXCLUDED.bytes,
           updated_at = NOW()
         RETURNING sha256, bytes, updated_at`,
        [PHOTO_ID, b64, sha, jpeg.length],
      );
      ping('profile-photo-save');
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(metaRow(rows[0]));
    } catch (err) {
      if (err && err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });

  router.delete('/photo', async (_req, res, next) => {
    try {
      await wipeProfilePhoto(pool);
      ping('profile-photo-delete');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  PHOTO_ID,
  MIN_JPEG_BYTES,
  MAX_JPEG_BYTES,
  sha256Hex,
  isJpeg,
  stripDataUrl,
  decodeJpegBase64,
  etagFor,
  ifNoneMatchHits,
  metaRow,
  wipeProfilePhoto,
  buildProfilePhotoRouter,
};
