'use strict';

/**
 * Chunked NAS uploads, matching the Drive resumable routes so a large file on a
 * flaky mobile link retries 8 MiB at a time instead of restarting 2 GB.
 *
 * Nextcloud's protocol is MKCOL → PUT 00001..N → MOVE .file. This module is the
 * HTTP session on top of that; the WebDAV verbs live in nas-files-service.js.
 */

function attachNasResumableRoutes(router, deps = {}) {
  const {
    nasFiles,
    tg = { e() {} },
    ttlMs = 24 * 60 * 60 * 1000,
    chunkSize = nasFiles.CHUNK_SIZE,
    chunkCap = (deps.chunkSize || nasFiles.CHUNK_SIZE) + 1024 * 1024,
  } = deps;

  if (!nasFiles) throw new Error('attachNasResumableRoutes requires { nasFiles }');

  const sessions = new Map();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt <= ttlMs) continue;
      sessions.delete(id);
      nasFiles.abortUpload(s.davId).catch(() => {});
    }
  }, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  function nasFail(res, reason) {
    return res
      .status(nasFiles.httpStatusFor(reason))
      .json({ error: nasFiles.explain(reason), reason });
  }

  router.post('/nas/upload/resumable/start', async (req, res, next) => {
    if (!nasFiles.isConfigured()) return nasFail(res, 'not_configured');
    try {
      const { name, mimeType, size } = req.body || {};
      const sizeNum = Number(size);
      if (!name || !Number.isFinite(sizeNum) || sizeNum < 0) {
        return res.status(400).json({ error: 'name and a valid size are required' });
      }
      if (sizeNum > nasFiles.MAX_UPLOAD_BYTES) {
        return nasFail(res, 'too_large');
      }
      const created = await nasFiles.createUploadCollection();
      if (!created.ok) return nasFail(res, created.reason);

      const uploadId = created.id;
      sessions.set(uploadId, {
        davId: created.id,
        name: String(name),
        size: sizeNum,
        mimeType: mimeType ? String(mimeType) : 'application/octet-stream',
        received: 0,
        createdAt: Date.now(),
      });
      res.status(201).json({ uploadId, chunkSize });
    } catch (err) {
      tg.e('Cloud/NAS', `chunked start failed: ${err.message}`, err);
      next(err);
    }
  });

  router.put('/nas/upload/resumable/:id', (req, res, next) => {
    if (!nasFiles.isConfigured()) return nasFail(res, 'not_configured');
    const sess = sessions.get(req.params.id);
    if (!sess) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }
    const start = Number(req.get('x-chunk-start'));
    const total = Number(req.get('x-chunk-total')) || sess.size;
    if (!Number.isFinite(start) || start < 0) {
      return res.status(400).json({ error: 'Invalid or missing x-chunk-start header' });
    }
    if (start % chunkSize !== 0) {
      return res.status(400).json({ error: 'Chunk start is not aligned' });
    }

    let parts = [];
    let received = 0;
    let aborted = false;
    req.on('data', (d) => {
      received += d.length;
      if (received > chunkCap) {
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
      if (sess.done) {
        return res.status(201).json({ done: true, file: sess.file });
      }
      try {
        const buf = Buffer.concat(parts);
        if (start < sess.received) {
          if (start + buf.length > sess.received) {
            return res.status(409).json({ error: 'Chunk overlaps a committed offset' });
          }
          // Replay of a chunk we already have. If the MOVE after the last
          // chunk was the thing that failed, try that again rather than
          // telling the phone to skip a file that is not actually there.
          if (sess.received >= total) return finish(res, sess, nasFiles, nasFail, sessions);
          return res.status(200).json({ done: false, received: sess.received });
        }
        if (start !== sess.received) {
          return res.status(409).json({
            error: 'Chunk is not next in sequence',
            received: sess.received,
          });
        }

        const index = Math.floor(start / chunkSize) + 1;
        const put = await nasFiles.putUploadChunk(sess.davId, index, buf, {
          contentType: sess.mimeType,
        });
        if (!put.ok) return nasFail(res, put.reason);

        sess.received += buf.length;
        if (sess.received < total) {
          return res.status(200).json({ done: false, received: sess.received });
        }
        return finish(res, sess, nasFiles, nasFail, sessions);
      } catch (err) {
        tg.e('Cloud/NAS', `chunk failed: ${err.message}`, err);
        next(err);
      }
    });
  });

  router.get('/nas/upload/resumable/:id/status', async (req, res, next) => {
    const sess = sessions.get(req.params.id);
    if (!sess) {
      return res.status(404).json({ error: 'Upload session not found or expired' });
    }
    if (sess.done) {
      return res.json({ done: true, received: sess.size, file: sess.file });
    }
    if (sess.received >= sess.size) {
      try {
        return await finish(res, sess, nasFiles, nasFail, sessions);
      } catch (err) {
        return next(err);
      }
    }
    res.json({ done: false, received: sess.received });
  });

  router.delete('/nas/upload/resumable/:id', async (req, res, next) => {
    const sess = sessions.get(req.params.id);
    sessions.delete(req.params.id);
    try {
      if (sess && !sess.done) await nasFiles.abortUpload(sess.davId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return { sessions, stopSweeper: () => clearInterval(sweeper), chunkSize };
}

async function finish(res, sess, nasFiles, nasFail, sessions) {
  const assembled = await nasFiles.assembleUpload(sess.davId, sess.name, sess.size);
  if (!assembled.ok) return nasFail(res, assembled.reason);
  sess.done = true;
  sess.file = { name: assembled.name, size: sess.size };
  sessions.delete(sess.davId);
  return res.status(201).json({ done: true, file: sess.file });
}

module.exports = { attachNasResumableRoutes };
