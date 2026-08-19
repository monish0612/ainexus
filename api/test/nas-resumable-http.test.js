'use strict';

// HTTP lifecycle for chunked NAS uploads: start → chunks → MOVE, plus replay
// of the last chunk when the assemble step was the thing that failed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { attachNasResumableRoutes } = require('../src/nas-resumable');

const CHUNK = 8 * 1024 * 1024;

function makeNas() {
  const collections = new Map();
  const stats = { mkcol: 0, put: 0, move: 0, abort: 0 };
  let failMoveOnce = false;

  return {
    stats,
    CHUNK_SIZE: CHUNK,
    SIMPLE_THRESHOLD: 5 * 1024 * 1024,
    MAX_UPLOAD_BYTES: 32 * 1024 * 1024 * 1024,
    isConfigured: () => true,
    explain: (r) => `explained:${r}`,
    httpStatusFor: (r) => (r === 'too_large' ? 413 : 503),
    failNextMove() {
      failMoveOnce = true;
    },
    assembled(id) {
      return collections.get(id);
    },
    async createUploadCollection() {
      stats.mkcol += 1;
      const id = `dav${stats.mkcol}`;
      collections.set(id, { chunks: [], assembled: false, name: null });
      return { ok: true, id };
    },
    async putUploadChunk(id, index, body) {
      stats.put += 1;
      const c = collections.get(id);
      if (!c) return { ok: false, reason: 'not_found' };
      c.chunks[index - 1] = Buffer.from(body);
      return { ok: true };
    },
    async assembleUpload(id, destName, size) {
      stats.move += 1;
      if (failMoveOnce) {
        failMoveOnce = false;
        return { ok: false, reason: 'timeout' };
      }
      const c = collections.get(id);
      if (!c) return { ok: false, reason: 'not_found' };
      const buf = Buffer.concat(c.chunks.filter(Boolean));
      assert.equal(buf.length, size);
      c.assembled = true;
      c.name = destName;
      c.bytes = buf;
      return { ok: true, name: destName };
    },
    async abortUpload(id) {
      stats.abort += 1;
      collections.delete(id);
      return { ok: true };
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: (p) => `http://127.0.0.1:${port}${p}`,
      });
    });
  });
}

test('a two-chunk file is assembled in order and reported done', async () => {
  const nas = makeNas();
  const router = express.Router();
  router.use(express.json());
  const attached = attachNasResumableRoutes(router, { nasFiles: nas, chunkSize: CHUNK });
  const app = express();
  app.use(router);
  const { server, url } = await listen(app);

  try {
    const total = CHUNK + 1024;
    const start = await fetch(url('/nas/upload/resumable/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'film.mkv', size: total, mimeType: 'video/x-matroska' }),
    });
    assert.equal(start.status, 201);
    const { uploadId, chunkSize } = await start.json();
    assert.equal(chunkSize, CHUNK);

    const first = Buffer.alloc(CHUNK, 7);
    const last = Buffer.alloc(1024, 9);

    const a = await fetch(url(`/nas/upload/resumable/${uploadId}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-chunk-start': '0',
        'x-chunk-total': String(total),
      },
      body: first,
    });
    assert.equal(a.status, 200);
    assert.equal((await a.json()).done, false);

    const b = await fetch(url(`/nas/upload/resumable/${uploadId}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-chunk-start': String(CHUNK),
        'x-chunk-total': String(total),
      },
      body: last,
    });
    assert.equal(b.status, 201);
    const done = await b.json();
    assert.equal(done.done, true);
    assert.equal(done.file.name, 'film.mkv');

    const assembled = nas.assembled('dav1');
    assert.equal(assembled.assembled, true);
    assert.equal(assembled.bytes[0], 7);
    assert.equal(assembled.bytes[CHUNK], 9);
    assert.equal(nas.stats.move, 1);
  } finally {
    attached.stopSweeper();
    server.close();
  }
});

test('replaying the last chunk after a failed MOVE still commits the file', async () => {
  const nas = makeNas();
  nas.failNextMove();
  const router = express.Router();
  router.use(express.json());
  const attached = attachNasResumableRoutes(router, { nasFiles: nas, chunkSize: CHUNK });
  const app = express();
  app.use(router);
  const { server, url } = await listen(app);

  try {
    const total = 2048;
    const started = await (await fetch(url('/nas/upload/resumable/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clip.bin', size: total }),
    })).json();

    const chunk = Buffer.alloc(total, 3);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'x-chunk-start': '0',
      'x-chunk-total': String(total),
    };

    const fail = await fetch(url(`/nas/upload/resumable/${started.uploadId}`), {
      method: 'PUT',
      headers,
      body: chunk,
    });
    assert.equal(fail.status, 503);

    const retry = await fetch(url(`/nas/upload/resumable/${started.uploadId}`), {
      method: 'PUT',
      headers,
      body: chunk,
    });
    assert.equal(retry.status, 201);
    const body = await retry.json();
    assert.equal(body.done, true);
    assert.equal(nas.stats.move, 2);
  } finally {
    attached.stopSweeper();
    server.close();
  }
});

test('an oversized file is refused before Nextcloud is touched', async () => {
  const nas = makeNas();
  const router = express.Router();
  router.use(express.json());
  const attached = attachNasResumableRoutes(router, { nasFiles: nas, chunkSize: CHUNK });
  const app = express();
  app.use(router);
  const { server, url } = await listen(app);

  try {
    const res = await fetch(url('/nas/upload/resumable/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'huge.iso', size: nas.MAX_UPLOAD_BYTES + 1 }),
    });
    assert.equal(res.status, 413);
    assert.equal(nas.stats.mkcol, 0);
  } finally {
    attached.stopSweeper();
    server.close();
  }
});
