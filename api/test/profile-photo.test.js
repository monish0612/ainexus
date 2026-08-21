'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  sha256Hex,
  isJpeg,
  stripDataUrl,
  decodeJpegBase64,
  etagFor,
  ifNoneMatchHits,
  wipeProfilePhoto,
  buildProfilePhotoRouter,
  MIN_JPEG_BYTES,
  MAX_JPEG_BYTES,
} = require('../src/profile-photo');

function jpegFixture(n = 256, marker = 0x41) {
  const buf = Buffer.alloc(n, marker);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

function makePool() {
  let row = null;
  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT jpeg_b64, sha256, bytes, updated_at FROM profile_photo')) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO profile_photo')) {
      const [, jpeg_b64, sha256, bytes] = params;
      row = {
        id: 'app',
        jpeg_b64,
        sha256,
        bytes,
        updated_at: new Date('2026-08-21T08:00:00.000Z'),
      };
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM profile_photo')) {
      const had = !!row;
      row = null;
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    throw new Error(`unexpected sql: ${s}`);
  }
  return { query, get row() { return row; } };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function req(port, { method, path, json, headers = {} }) {
  const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let parsed = null;
          const ct = String(res.headers['content-type'] || '');
          if (ct.includes('application/json') && buf.length) {
            parsed = JSON.parse(buf.toString('utf8'));
          }
          resolve({ status: res.statusCode, headers: res.headers, buf, json: parsed });
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('isJpeg requires SOI + EOI and a real payload', () => {
  assert.equal(isJpeg(jpegFixture()), true);
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), false);
  assert.equal(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isJpeg(Buffer.alloc(0)), false);
});

test('stripDataUrl and decodeJpegBase64 cover data-URLs, junk, and size', () => {
  const jpeg = jpegFixture();
  const b64 = jpeg.toString('base64');
  assert.equal(stripDataUrl(`data:image/jpeg;base64,${b64}`), b64);
  assert.deepEqual(decodeJpegBase64(`data:image/jpeg;base64,${b64}`), jpeg);
  assert.deepEqual(decodeJpegBase64(`  ${b64}  `), jpeg);

  assert.throws(() => decodeJpegBase64(''), (e) => e.status === 400);
  assert.throws(() => decodeJpegBase64('!!!'), (e) => e.status === 400);
  assert.throws(
    () => decodeJpegBase64(Buffer.alloc(MAX_JPEG_BYTES + 8, 1).toString('base64')),
    (e) => e.status === 413,
  );
});

test('If-None-Match matches quoted and weak etags', () => {
  const sha = sha256Hex(jpegFixture());
  assert.equal(ifNoneMatchHits(etagFor(sha), sha), true);
  assert.equal(ifNoneMatchHits(`W/${etagFor(sha)}`, sha), true);
  assert.equal(ifNoneMatchHits(`${etagFor('nope')}, ${etagFor(sha)}`, sha), true);
  assert.equal(ifNoneMatchHits(etagFor('nope'), sha), false);
  assert.equal(ifNoneMatchHits('', sha), false);
});

test('HTTP: missing photo is 204 / exists:false, PUT then GET, 304, DELETE', async () => {
  const pool = makePool();
  const reasons = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/profile', buildProfilePhotoRouter(express, pool, {
    onMutate: (r) => reasons.push(r),
  }));
  const { server, port } = await listen(app);
  try {
    const miss = await req(port, { method: 'GET', path: '/api/v1/profile/photo' });
    assert.equal(miss.status, 204);
    const meta0 = await req(port, { method: 'GET', path: '/api/v1/profile/photo/meta' });
    assert.equal(meta0.json.exists, false);

    const jpeg = jpegFixture(300, 0x22);
    const put = await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: jpeg.toString('base64') },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.exists, true);
    assert.equal(put.json.sha256, sha256Hex(jpeg));
    assert.equal(put.json.bytes, jpeg.length);
    assert.deepEqual(reasons, ['profile-photo-save']);

    const got = await req(port, { method: 'GET', path: '/api/v1/profile/photo' });
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'image/jpeg');
    assert.equal(got.headers.etag, etagFor(put.json.sha256));
    assert.deepEqual(got.buf, jpeg);

    const cached = await req(port, {
      method: 'GET',
      path: '/api/v1/profile/photo',
      headers: { 'If-None-Match': etagFor(put.json.sha256) },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.buf.length, 0);

    const stale = await req(port, {
      method: 'GET',
      path: '/api/v1/profile/photo',
      headers: { 'If-None-Match': etagFor('deadbeef') },
    });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.buf, jpeg);

    const del = await req(port, { method: 'DELETE', path: '/api/v1/profile/photo' });
    assert.equal(del.status, 204);
    assert.ok(reasons.includes('profile-photo-delete'));
    const miss2 = await req(port, { method: 'GET', path: '/api/v1/profile/photo' });
    assert.equal(miss2.status, 204);

    const del2 = await req(port, { method: 'DELETE', path: '/api/v1/profile/photo' });
    assert.equal(del2.status, 204);
  } finally {
    server.close();
  }
});

test('HTTP: PUT rejects empty, PNG, and oversized payloads', async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/profile', buildProfilePhotoRouter(express, makePool()));
  const { server, port } = await listen(app);
  try {
    const empty = await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: '' },
    });
    assert.equal(empty.status, 400);

    const png = Buffer.alloc(200, 0);
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
    const bad = await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: png.toString('base64') },
    });
    assert.equal(bad.status, 400);

    const huge = jpegFixture(MAX_JPEG_BYTES + 1);
    const big = await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: huge.toString('base64') },
    });
    assert.equal(big.status, 413);
  } finally {
    server.close();
  }
});

test('HTTP: replace overwrites the rolling row; wipeProfilePhoto clears it', async () => {
  const pool = makePool();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/profile', buildProfilePhotoRouter(express, pool));
  const { server, port } = await listen(app);
  try {
    const a = jpegFixture(200, 0x11);
    const b = jpegFixture(220, 0x22);
    await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: a.toString('base64') },
    });
    const putB = await req(port, {
      method: 'PUT',
      path: '/api/v1/profile/photo',
      json: { jpegBase64: b.toString('base64') },
    });
    assert.equal(putB.json.sha256, sha256Hex(b));
    const got = await req(port, { method: 'GET', path: '/api/v1/profile/photo' });
    assert.deepEqual(got.buf, b);

    await wipeProfilePhoto(pool);
    const miss = await req(port, { method: 'GET', path: '/api/v1/profile/photo/meta' });
    assert.equal(miss.json.exists, false);
  } finally {
    server.close();
  }
});

test('MIN_JPEG_BYTES is the decode floor', () => {
  assert.ok(MIN_JPEG_BYTES >= 128);
  assert.equal(isJpeg(jpegFixture(MIN_JPEG_BYTES)), true);
  assert.equal(isJpeg(jpegFixture(MIN_JPEG_BYTES - 1)), false);
});
