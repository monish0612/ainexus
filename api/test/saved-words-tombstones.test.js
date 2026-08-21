'use strict';

// ═══════════════════════════════════════════════════════════════
//  SAVED WORDS — cross-device delete-sync (tombstones) HTTP tests
//
//  Drives the real ./saved-words router over real HTTP, backed by a tiny
//  in-memory pool that understands exactly the SQL the router issues. This
//  verifies the contract that fixes the "word deleted on web still shows on
//  the phone" bug:
//    • per-id DELETE writes a tombstone + removes the row
//    • bulk DELETE tombstones every id
//    • POST (re-save) clears the tombstone ("undelete")
//    • GET /tombstones?since= returns the since-filtered delta
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { buildSavedWordsRouter } = require('../src/saved-words');

// ── Fake pool ──────────────────────────────────────────────────
// Two maps mirror the saved_words + deleted_saved_words tables. The query
// dispatcher matches on stable fragments of each SQL string the router emits.
function makePool() {
  const words = new Map(); // id -> row
  const tombstones = new Map(); // id -> Date
  // Monotonic clock so ORDER BY deleted_at and ?since filtering are deterministic.
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM saved_words')) {
      const rows = [...words.values()].sort((a, b) =>
        String(b.saved_at).localeCompare(String(a.saved_at)),
      );
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT id, deleted_at FROM deleted_saved_words')) {
      let rows = [...tombstones.entries()].map(([id, deleted_at]) => ({ id, deleted_at }));
      if (s.includes('WHERE deleted_at > $1')) {
        const since = new Date(params[0]).getTime();
        rows = rows.filter((r) => r.deleted_at.getTime() > since);
      }
      rows.sort((a, b) => a.deleted_at.getTime() - b.deleted_at.getTime());
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('INSERT INTO saved_words')) {
      const [id, word, definition, pronunciation, part_of_speech, saved_at, response_json] = params;
      words.set(id, { id, word, definition, pronunciation, part_of_speech, saved_at, response_json });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('DELETE FROM deleted_saved_words WHERE id = $1')) {
      const existed = tombstones.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO deleted_saved_words (id, deleted_at) SELECT id, NOW() FROM saved_words')) {
      for (const id of words.keys()) tombstones.set(id, now());
      return { rows: [], rowCount: words.size };
    }

    if (s.startsWith('INSERT INTO deleted_saved_words (id, deleted_at) VALUES ($1, NOW())')) {
      tombstones.set(params[0], now());
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('DELETE FROM saved_words WHERE id = $1')) {
      const existed = words.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (s.startsWith('DELETE FROM saved_words')) {
      const n = words.size;
      words.clear();
      return { rows: [], rowCount: n };
    }

    throw new Error('unhandled SQL in fake pool: ' + s);
  }

  return { query, _words: words, _tombstones: tombstones };
}

function startServer(opts = {}) {
  const pool = makePool();
  const app = express();
  app.use(express.json());
  app.use('/saved-words', buildSavedWordsRouter(express, pool, { log: () => {}, ...opts }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, pool, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function req(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

test('per-id delete writes a tombstone and removes the row', async () => {
  const { server, base } = await startServer();
  try {
    await req(base, 'POST', '/saved-words', { id: 'w1', word: 'serendipity', savedAt: '2026-01-01T00:00:00.000Z' });
    let list = await req(base, 'GET', '/saved-words');
    assert.equal(list.json.length, 1);

    const del = await req(base, 'DELETE', '/saved-words/w1');
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, 1);

    list = await req(base, 'GET', '/saved-words');
    assert.equal(list.json.length, 0, 'row gone');

    const tomb = await req(base, 'GET', '/saved-words/tombstones');
    assert.equal(tomb.json.length, 1);
    assert.equal(tomb.json[0].id, 'w1');
    assert.ok(tomb.json[0].deletedAt, 'tombstone carries deletedAt');
  } finally {
    server.close();
  }
});

test('GET /tombstones?since= returns only newer deletions', async () => {
  const { server, base } = await startServer();
  try {
    for (const id of ['a', 'b', 'c']) {
      await req(base, 'POST', '/saved-words', { id, word: id, savedAt: '2026-01-01T00:00:00.000Z' });
    }
    await req(base, 'DELETE', '/saved-words/a');
    await req(base, 'DELETE', '/saved-words/b');

    const all = await req(base, 'GET', '/saved-words/tombstones');
    assert.deepEqual(all.json.map((t) => t.id), ['a', 'b'], 'ordered oldest→newest');

    const watermark = all.json[0].deletedAt; // after first delete
    const delta = await req(base, 'GET', `/saved-words/tombstones?since=${encodeURIComponent(watermark)}`);
    assert.deepEqual(delta.json.map((t) => t.id), ['b'], 'only newer than watermark');
  } finally {
    server.close();
  }
});

test('re-saving a deleted id clears its tombstone (undelete)', async () => {
  const { server, base } = await startServer();
  try {
    await req(base, 'POST', '/saved-words', { id: 'w1', word: 'x', savedAt: '2026-01-01T00:00:00.000Z' });
    await req(base, 'DELETE', '/saved-words/w1');
    let tomb = await req(base, 'GET', '/saved-words/tombstones');
    assert.equal(tomb.json.length, 1);

    // Re-save same id → tombstone must be dropped so it isn't re-deleted elsewhere.
    await req(base, 'POST', '/saved-words', { id: 'w1', word: 'x', savedAt: '2026-01-02T00:00:00.000Z' });
    tomb = await req(base, 'GET', '/saved-words/tombstones');
    assert.equal(tomb.json.length, 0, 'tombstone cleared on re-save');

    const list = await req(base, 'GET', '/saved-words');
    assert.equal(list.json.length, 1);
  } finally {
    server.close();
  }
});

test('bulk delete tombstones every id', async () => {
  const { server, base } = await startServer();
  try {
    for (const id of ['a', 'b', 'c']) {
      await req(base, 'POST', '/saved-words', { id, word: id, savedAt: '2026-01-01T00:00:00.000Z' });
    }
    const del = await req(base, 'DELETE', '/saved-words');
    assert.equal(del.json.deleted, 3);

    const list = await req(base, 'GET', '/saved-words');
    assert.equal(list.json.length, 0);

    const tomb = await req(base, 'GET', '/saved-words/tombstones');
    assert.deepEqual(tomb.json.map((t) => t.id).sort(), ['a', 'b', 'c']);
  } finally {
    server.close();
  }
});

test('invalid ?since timestamp → 400', async () => {
  const { server, base } = await startServer();
  try {
    const res = await req(base, 'GET', '/saved-words/tombstones?since=not-a-date');
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST without id/word → 400', async () => {
  const { server, base } = await startServer();
  try {
    const res = await req(base, 'POST', '/saved-words', { word: '' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('delete and bulk-clear notify onMutate so Drive backup can drop the word', async () => {
  const reasons = [];
  const { server, base } = await startServer({ onMutate: (r) => reasons.push(r) });
  try {
    await req(base, 'POST', '/saved-words', { id: 'w1', word: 'x', savedAt: '2026-01-01T00:00:00.000Z' });
    await req(base, 'DELETE', '/saved-words/w1');
    await req(base, 'POST', '/saved-words', { id: 'w2', word: 'y', savedAt: '2026-01-01T00:00:00.000Z' });
    await req(base, 'DELETE', '/saved-words');
    assert.ok(reasons.includes('saved-word-delete'));
    assert.ok(reasons.includes('saved-words-clear'));
    assert.ok(reasons.includes('saved-word-upsert'));
  } finally {
    server.close();
  }
});

test("'tombstones' is not swallowed by the /:id route", async () => {
  const { server, base } = await startServer();
  try {
    // GET /tombstones must hit the tombstones handler (array), not a 404/:id.
    const res = await req(base, 'GET', '/saved-words/tombstones');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  } finally {
    server.close();
  }
});
