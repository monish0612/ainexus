'use strict';

// ═══════════════════════════════════════════════════════════════
//  RESUMABLE UPLOAD — HTTP integration tests (real Express + sockets)
//
//  Mounts the real ./cloud-resumable routes onto a throw-away router with
//  an in-memory "Drive" simulator (mocking cloudService), then drives the
//  full chunked-upload lifecycle over real HTTP with fetch:
//    • start → chunk → chunk → done
//    • resume via /status
//    • idempotent replay of the final chunk (no duplicate Drive write)
//    • /status finalize when Drive already has all bytes
//    • edge cases: 404 (unknown session), 413 (oversized chunk),
//      400 (bad/missing headers + bad start payload), 503 (Drive off),
//      500 (Drive throws), and byte-perfect reassembly.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { attachResumableRoutes, RESUMABLE_CHUNK } = require('../src/cloud-resumable');

// ── In-memory Drive simulator (stands in for cloudService) ─────────────────
function makeDrive() {
  const sessions = new Map(); // sessionUri → { total, buf: Buffer[], received }
  const stats = { startCalls: 0, chunkCalls: 0, queryCalls: 0 };
  let failChunkOnce = false;

  return {
    stats,
    failNextChunk() {
      failChunkOnce = true;
    },
    // Inspect assembled bytes for a session uri.
    assembled(uri) {
      const s = sessions.get(uri);
      return s ? Buffer.concat(s.buf) : null;
    },
    // Force Drive to already hold all bytes (simulates a lost final response).
    forceComplete(uri) {
      const s = sessions.get(uri);
      if (s) s.received = s.total;
    },
    isDriveAvailable: () => true,

    async startResumableSession({ name }) {
      stats.startCalls += 1;
      const uri = `https://drive.local/session/${crypto.randomUUID()}`;
      sessions.set(uri, { total: null, buf: [], received: 0, name });
      return uri;
    },

    async uploadResumableChunk({ sessionUri, chunk, start, total }) {
      stats.chunkCalls += 1;
      if (failChunkOnce) {
        failChunkOnce = false;
        throw new Error('simulated Drive 500');
      }
      const s = sessions.get(sessionUri);
      if (!s) throw new Error('unknown session');
      s.total = total;
      // Sequential, gap-free assembly (mirrors how the client streams).
      assert.equal(start, s.received, 'chunk start must equal committed offset');
      s.buf.push(Buffer.from(chunk));
      s.received += chunk.length;
      if (s.received >= total) {
        return { done: true, file: { id: 'file-1', name: s.name, size: total } };
      }
      return { done: false, received: s.received };
    },

    async queryResumableOffset({ sessionUri, total }) {
      stats.queryCalls += 1;
      const s = sessions.get(sessionUri);
      const received = s ? s.received : 0;
      if (received >= total) {
        return { done: true, received: total, file: { id: 'file-1', name: s.name, size: total } };
      }
      return { done: false, received };
    },
  };
}

let server;
let base;
let drive;
let driveOn;
let attached;

test.before(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();

  drive = makeDrive();
  driveOn = true;
  const ensureDrive = (res) => {
    if (!driveOn) {
      res.status(503).json({ error: 'Cloud storage is not configured' });
      return false;
    }
    return true;
  };

  attached = attachResumableRoutes(router, {
    cloudService: drive,
    ensureDrive,
    chunkCap: 8, // tiny cap so we can exercise the 413 guard
  });

  app.use('/api/v1/cloud', router);
  // JSON error handler so next(err) surfaces as 500 we can assert on.
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (attached) attached.stopSweeper();
  await new Promise((r) => server.close(r));
});

const startUpload = (body) =>
  fetch(`${base}/api/v1/cloud/upload/resumable/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const putChunk = (id, bytes, start, total, extraHeaders = {}) =>
  fetch(`${base}/api/v1/cloud/upload/resumable/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-chunk-start': String(start),
      'x-chunk-total': String(total),
      ...extraHeaders,
    },
    body: bytes,
  });

const status = (id) =>
  fetch(`${base}/api/v1/cloud/upload/resumable/${id}/status`);

// ─────────────────────────────────────────────────────────────────────────

test('start: valid → 201 with uploadId + chunkSize', async () => {
  const r = await startUpload({ name: 'a.bin', mimeType: 'application/octet-stream', size: 6 });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok(body.uploadId);
  assert.equal(body.chunkSize, RESUMABLE_CHUNK);
});

test('start: missing name → 400; negative/NaN size → 400', async () => {
  assert.equal((await startUpload({ size: 5 })).status, 400);
  assert.equal((await startUpload({ name: 'x', size: -1 })).status, 400);
  assert.equal((await startUpload({ name: 'x', size: 'abc' })).status, 400);
});

test('full happy path: two chunks reassemble byte-perfect → done', async () => {
  const data = crypto.randomBytes(6);
  const r = await startUpload({ name: 'doc.bin', size: data.length });
  const { uploadId } = await r.json();

  // chunk 1: bytes 0..3 (4 bytes) → still incomplete
  const c1 = await putChunk(uploadId, data.subarray(0, 4), 0, data.length);
  assert.equal(c1.status, 200);
  const b1 = await c1.json();
  assert.equal(b1.done, false);
  assert.equal(b1.received, 4);

  // chunk 2: bytes 4..5 (2 bytes) → done
  const c2 = await putChunk(uploadId, data.subarray(4), 4, data.length);
  assert.equal(c2.status, 201);
  const b2 = await c2.json();
  assert.equal(b2.done, true);
  assert.equal(b2.file.id, 'file-1');

  // Byte-perfect on the Drive side (correct order, no gaps/dupes).
  const sess = attached.sessions.get(uploadId);
  assert.ok(Buffer.compare(drive.assembled(sess.sessionUri), data) === 0);
});

test('resume: /status reports committed offset mid-upload', async () => {
  const data = crypto.randomBytes(6);
  const { uploadId } = await (await startUpload({ name: 'r.bin', size: 6 })).json();
  await putChunk(uploadId, data.subarray(0, 4), 0, 6);

  const s = await status(uploadId);
  assert.equal(s.status, 200);
  const body = await s.json();
  assert.equal(body.done, false);
  assert.equal(body.received, 4);
});

test('idempotent replay: re-PUT final chunk returns cache, no 2nd Drive write', async () => {
  const data = crypto.randomBytes(4);
  const { uploadId } = await (await startUpload({ name: 'i.bin', size: 4 })).json();
  await putChunk(uploadId, data, 0, 4); // completes → done

  const before = drive.stats.chunkCalls;
  const replay = await putChunk(uploadId, data, 0, 4); // lost-response retry
  assert.equal(replay.status, 201);
  const body = await replay.json();
  assert.equal(body.done, true);
  assert.equal(body.file.id, 'file-1');
  assert.equal(drive.stats.chunkCalls, before, 'must not re-upload to Drive');
});

test('idempotent status: after done, /status serves cache without querying Drive', async () => {
  const { uploadId } = await (await startUpload({ name: 'i2.bin', size: 3 })).json();
  await putChunk(uploadId, crypto.randomBytes(3), 0, 3); // done

  const before = drive.stats.queryCalls;
  const s = await status(uploadId);
  const body = await s.json();
  assert.equal(body.done, true);
  assert.equal(body.received, 3);
  assert.equal(drive.stats.queryCalls, before, 'cached, no Drive query');
});

test('finalize via /status: Drive already has all bytes (lost final response)', async () => {
  const { uploadId } = await (await startUpload({ name: 'f.bin', size: 5 })).json();
  await putChunk(uploadId, crypto.randomBytes(3), 0, 5); // partial, not done
  // Simulate the final chunk having landed on Drive but its response was lost.
  const sess = attached.sessions.get(uploadId);
  drive.forceComplete(sess.sessionUri);

  const s = await status(uploadId);
  const body = await s.json();
  assert.equal(body.done, true);
  assert.equal(body.received, 5);
  assert.equal(body.file.id, 'file-1');
});

test('unknown session → 404 for chunk and status', async () => {
  assert.equal((await putChunk('nope', Buffer.from('ab'), 0, 2)).status, 404);
  assert.equal((await status('nope')).status, 404);
});

test('bad start header → 400 (missing / negative)', async () => {
  const { uploadId } = await (await startUpload({ name: 'h.bin', size: 4 })).json();
  // missing x-chunk-start
  const miss = await fetch(`${base}/api/v1/cloud/upload/resumable/${uploadId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-chunk-total': '4' },
    body: Buffer.from('abcd'),
  });
  assert.equal(miss.status, 400);
  // negative start
  assert.equal((await putChunk(uploadId, Buffer.from('abcd'), -1, 4)).status, 400);
});

test('oversized chunk → 413 (memory guard)', async () => {
  const { uploadId } = await (await startUpload({ name: 'big.bin', size: 100 })).json();
  // chunkCap is 8 bytes in this harness; send 32 → aborted.
  const r = await putChunk(uploadId, crypto.randomBytes(32), 0, 100);
  assert.equal(r.status, 413);
});

test('Drive throws on chunk → 500 via error handler', async () => {
  const { uploadId } = await (await startUpload({ name: 'e.bin', size: 4 })).json();
  drive.failNextChunk();
  const r = await putChunk(uploadId, Buffer.from('abcd'), 0, 4);
  assert.equal(r.status, 500);
});

test('Drive unavailable → 503 on start/chunk/status', async () => {
  driveOn = false;
  try {
    assert.equal((await startUpload({ name: 'z', size: 1 })).status, 503);
    assert.equal((await putChunk('whatever', Buffer.from('a'), 0, 1)).status, 503);
    assert.equal((await status('whatever')).status, 503);
  } finally {
    driveOn = true;
  }
});
