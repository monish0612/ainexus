// ─────────────────────────────────────────────────────────────────────────────
//  Resumable (chunked) upload routes — large files / unreliable office networks.
//
//  Chunks are proxied through our backend so the browser only ever talks to our
//  own origin. A dropped chunk is retried (or resumed from the committed offset)
//  without restarting the whole file, and a lost success response can't create a
//  duplicate: the server caches the finalized file meta and replays it.
//
//  Extracted into its own module so the full route lifecycle (session store,
//  resume, idempotent replay, edge cases) can be tested without booting the
//  whole server. index.js wires it onto the cloud router; tests mount it onto a
//  throw-away router with a mocked cloudService.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const RESUMABLE_CHUNK = 8 * 1024 * 1024; // 8 MiB (a multiple of 256 KiB)
const RESUMABLE_TTL_MS = 60 * 60 * 1000; // sessions live at most 1h
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Attach the three resumable-upload routes to an Express router.
 *
 * @param {import('express').Router} router
 * @param {object} deps
 * @param {object}   deps.cloudService  Drive helper (startResumableSession / uploadResumableChunk / queryResumableOffset)
 * @param {Function} deps.ensureDrive   (res) => boolean — short-circuits with 503 when Drive isn't configured
 * @param {object}  [deps.tg]           telegram logger ({ e(scope, msg, err) })
 * @param {Function}[deps.randomUUID]   id generator (override in tests)
 * @param {number}  [deps.ttlMs]        session TTL
 * @param {number}  [deps.chunkSize]    advertised chunk size
 * @param {number}  [deps.chunkCap]     hard per-request byte cap (defends memory)
 * @returns {{ sessions: Map, stopSweeper: Function, chunkSize: number }}
 */
function attachResumableRoutes(router, deps = {}) {
  const {
    cloudService,
    ensureDrive,
    tg = { e() {} },
    randomUUID = crypto.randomUUID,
    ttlMs = RESUMABLE_TTL_MS,
    chunkSize = RESUMABLE_CHUNK,
    chunkCap = (deps.chunkSize || RESUMABLE_CHUNK) + 1024 * 1024, // chunk + 1 MiB slack
  } = deps;

  if (!cloudService || typeof ensureDrive !== 'function') {
    throw new Error('attachResumableRoutes requires { cloudService, ensureDrive }');
  }

  const sessions = new Map(); // uploadId → { sessionUri, name, size, createdAt, done?, file? }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > ttlMs) sessions.delete(id);
    }
  }, SWEEP_INTERVAL_MS);
  if (sweeper.unref) sweeper.unref();

  // ── Start a session ──────────────────────────────────────────────────────
  router.post('/upload/resumable/start', async (req, res, next) => {
    if (!ensureDrive(res)) return;
    try {
      const { name, mimeType, size } = req.body || {};
      const sizeNum = Number(size);
      if (!name || !Number.isFinite(sizeNum) || sizeNum < 0) {
        return res.status(400).json({ error: 'name and a valid size are required' });
      }
      const sessionUri = await cloudService.startResumableSession({
        name: String(name).slice(0, 512),
        mimeType: mimeType ? String(mimeType) : 'application/octet-stream',
      });
      const uploadId = randomUUID();
      sessions.set(uploadId, {
        sessionUri,
        name: String(name),
        size: sizeNum,
        createdAt: Date.now(),
      });
      res.status(201).json({ uploadId, chunkSize });
    } catch (err) {
      tg.e('Cloud/resumable', `start failed: ${err.message}`, err);
      next(err);
    }
  });

  // ── Upload one chunk (raw octet-stream body) ─────────────────────────────
  router.put('/upload/resumable/:id', (req, res, next) => {
    if (!ensureDrive(res)) return;
    const sess = sessions.get(req.params.id);
    if (!sess) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }
    const start = Number(req.get('x-chunk-start'));
    const total = Number(req.get('x-chunk-total')) || sess.size;
    if (!Number.isFinite(start) || start < 0) {
      return res.status(400).json({ error: 'Invalid or missing x-chunk-start header' });
    }

    let parts = [];
    let received = 0;
    let aborted = false;
    req.on('data', (d) => {
      received += d.length;
      if (received > chunkCap) {
        // Over the cap: drop everything buffered and stop accumulating so we
        // never hold an unbounded chunk in memory. We keep draining to 'end'
        // (rather than destroying the socket) so the 413 response flushes
        // reliably instead of leaving the client hanging on a reset.
        if (!aborted) {
          aborted = true;
          parts = [];
        }
        return;
      }
      parts.push(d);
    });
    req.on('error', (err) => {
      if (!aborted) next(err);
    });
    req.on('end', async () => {
      if (aborted) return res.status(413).json({ error: 'Chunk exceeds maximum size' });
      // Idempotent replay: if a previous final chunk already finalized this
      // session but its response was lost, return the cached file meta instead
      // of re-uploading (prevents duplicate files).
      if (sess.done) {
        return res.status(201).json({ done: true, file: sess.file });
      }
      try {
        const buf = Buffer.concat(parts);
        const result = await cloudService.uploadResumableChunk({
          sessionUri: sess.sessionUri,
          chunk: buf,
          start,
          total,
        });
        if (result.done) {
          sess.done = true;
          sess.file = result.file;
          return res.status(201).json({ done: true, file: result.file });
        }
        res.status(200).json({ done: false, received: result.received });
      } catch (err) {
        tg.e('Cloud/resumable', `chunk failed: ${err.message}`, err);
        next(err);
      }
    });
  });

  // ── Query committed offset (for resume / finalize) ───────────────────────
  router.get('/upload/resumable/:id/status', async (req, res, next) => {
    if (!ensureDrive(res)) return;
    const sess = sessions.get(req.params.id);
    if (!sess) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }
    if (sess.done) {
      return res.json({ done: true, received: sess.size, file: sess.file });
    }
    try {
      const result = await cloudService.queryResumableOffset({
        sessionUri: sess.sessionUri,
        total: sess.size,
      });
      if (result.done) {
        sess.done = true;
        sess.file = result.file;
        return res.json({ done: true, received: sess.size, file: result.file });
      }
      res.json({ done: false, received: result.received });
    } catch (err) {
      next(err);
    }
  });

  return { sessions, stopSweeper: () => clearInterval(sweeper), chunkSize };
}

module.exports = { attachResumableRoutes, RESUMABLE_CHUNK, RESUMABLE_TTL_MS };
