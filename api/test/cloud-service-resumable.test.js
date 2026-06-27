'use strict';

// ═══════════════════════════════════════════════════════════════
//  CLOUD-SERVICE — Drive resumable protocol (mocked fetch)
//
//  Verifies the HTTP semantics our helpers speak to Google Drive:
//    • uploadResumableChunk sends the right Content-Range and maps
//      308 (resume), 200/201 (done) and error statuses correctly.
//    • queryResumableOffset issues `bytes *​/total` and parses the
//      committed offset from the Range header.
//  No network / no auth is needed: these helpers PUT to the session
//  URI directly, so we stub global fetch and assert request + result.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const cloud = require('../src/cloud-service');

const realFetch = globalThis.fetch;
let calls;

function stubFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const resp = (status, { headers = {}, body = null } = {}) =>
  new Response(body, { status, headers });

// ── uploadResumableChunk ───────────────────────────────────────────────────

test('chunk: 308 + Range → done:false, received = end + 1', async () => {
  stubFetch(() => resp(308, { headers: { Range: 'bytes=0-3' } }));
  const out = await cloud.uploadResumableChunk({
    sessionUri: 'https://drive/s1',
    chunk: Buffer.alloc(4),
    start: 0,
    total: 10,
  });
  assert.deepEqual(out, { done: false, received: 4 });

  // Correct request shape.
  const { url, opts } = calls[0];
  assert.equal(url, 'https://drive/s1');
  assert.equal(opts.method, 'PUT');
  assert.equal(opts.redirect, 'manual');
  assert.equal(opts.headers['Content-Range'], 'bytes 0-3/10');
  assert.equal(opts.headers['Content-Length'], '4');
});

test('chunk: 308 without Range → falls back to start + len', async () => {
  stubFetch(() => resp(308));
  const out = await cloud.uploadResumableChunk({
    sessionUri: 'https://drive/s2',
    chunk: Buffer.alloc(6),
    start: 8,
    total: 100,
  });
  assert.deepEqual(out, { done: false, received: 14 });
  assert.equal(calls[0].opts.headers['Content-Range'], 'bytes 8-13/100');
});

test('chunk: 200 → done:true with mapped file', async () => {
  stubFetch(() =>
    resp(200, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'F1', name: 'pic.png', mimeType: 'image/png', size: '12' }),
    }),
  );
  const out = await cloud.uploadResumableChunk({
    sessionUri: 'https://drive/s3',
    chunk: Buffer.alloc(12),
    start: 0,
    total: 12,
  });
  assert.equal(out.done, true);
  assert.equal(out.file.id, 'F1');
  assert.equal(out.file.name, 'pic.png');
  assert.equal(out.file.size, 12);
  assert.equal(out.file.isImage, true);
});

test('chunk: 201 → done:true', async () => {
  stubFetch(() =>
    resp(201, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'F2', name: 'a.bin', size: '4' }),
    }),
  );
  const out = await cloud.uploadResumableChunk({
    sessionUri: 'https://drive/s4',
    chunk: Buffer.alloc(4),
    start: 0,
    total: 4,
  });
  assert.equal(out.done, true);
  assert.equal(out.file.id, 'F2');
});

test('chunk: error status → throws with status + snippet', async () => {
  stubFetch(() => resp(403, { body: 'quota exceeded' }));
  await assert.rejects(
    () =>
      cloud.uploadResumableChunk({
        sessionUri: 'https://drive/s5',
        chunk: Buffer.alloc(4),
        start: 0,
        total: 4,
      }),
    /Chunk upload failed \(403\).*quota exceeded/s,
  );
});

// ── queryResumableOffset ───────────────────────────────────────────────────

test('offset: 308 + Range → received = end + 1, sends bytes *​/total', async () => {
  stubFetch(() => resp(308, { headers: { Range: 'bytes=0-4' } }));
  const out = await cloud.queryResumableOffset({ sessionUri: 'https://drive/q1', total: 50 });
  assert.deepEqual(out, { done: false, received: 5 });
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers['Content-Range'], 'bytes */50');
});

test('offset: 308 without Range → received 0 (nothing committed)', async () => {
  stubFetch(() => resp(308));
  const out = await cloud.queryResumableOffset({ sessionUri: 'https://drive/q2', total: 50 });
  assert.deepEqual(out, { done: false, received: 0 });
});

test('offset: 200 → done:true with total + file', async () => {
  stubFetch(() =>
    resp(200, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'F3', name: 'done.bin', size: '9' }),
    }),
  );
  const out = await cloud.queryResumableOffset({ sessionUri: 'https://drive/q3', total: 9 });
  assert.equal(out.done, true);
  assert.equal(out.received, 9);
  assert.equal(out.file.id, 'F3');
});

test('offset: error status → throws', async () => {
  stubFetch(() => resp(500, { body: 'boom' }));
  await assert.rejects(
    () => cloud.queryResumableOffset({ sessionUri: 'https://drive/q4', total: 9 }),
    /Resumable status query failed \(500\)/,
  );
});
