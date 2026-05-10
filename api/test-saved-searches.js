'use strict';

// ═══════════════════════════════════════════════════════════════
//  SAVED-SEARCHES ROUTER CONTRACT TESTS
//
//  Verifies the wire shape and SQL contract of the new
//  /api/v1/saved-searches Express router added in src/index.js.
//
//  Strategy:
//    1. Mock pg.Pool (records every .query() call, returns
//       deterministic rows).
//    2. Mock telegram, helmet, cors, express-rate-limit so importing
//       src/index.js is a no-op for unrelated subsystems.
//    3. Use supertest-style raw req/res driving via the Express app
//       to send requests and assert on the recorded SQL + the JSON
//       responses.
//
//  Run: node test-saved-searches.js
//  Exits 0 on success, 1 on failure.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;
const failures = [];

function log(msg) { process.stdout.write(`${msg}\n`); }
function ok(name) { passed++; log(`  ✅ ${name}`); }
function bad(name, why) {
  failed++;
  failures.push(`${name} — ${why}`);
  log(`  ❌ ${name}\n     ${why}`);
}

function assert(cond, name, why = 'assertion failed') {
  cond ? ok(name) : bad(name, why);
}

function assertEq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    ok(name);
  } else {
    bad(name, `expected ${e}, got ${a}`);
  }
}

function assertContains(s, needle, name) {
  if (typeof s === 'string' && s.includes(needle)) {
    ok(name);
  } else {
    bad(name, `expected substring "${needle}" in ${JSON.stringify(s)}`);
  }
}

// ── Mock infrastructure ─────────────────────────────────────────

// pg mock — records every query() call. Each test arranges a queue of
// canned responses keyed by SQL fragment.
const queryLog = [];
const cannedResponses = []; // [{ match: regex|string, rows, rowCount }]

function _mockQuery(text, values) {
  queryLog.push({ text: String(text).trim(), values: values || [] });
  // Find the first matching response and consume it.
  for (let i = 0; i < cannedResponses.length; i++) {
    const c = cannedResponses[i];
    const matches = typeof c.match === 'string'
      ? text.includes(c.match)
      : c.match.test(text);
    if (matches) {
      cannedResponses.splice(i, 1);
      return Promise.resolve({ rows: c.rows || [], rowCount: c.rowCount || 0 });
    }
  }
  // Default: empty rows.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

function clearMocks() {
  queryLog.length = 0;
  cannedResponses.length = 0;
}

// Replace pg before requiring src/index.js
const pgMock = {
  Pool: function () {
    return { query: _mockQuery, on: () => {} };
  },
};
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'),
  filename: require.resolve('pg'),
  loaded: true,
  exports: pgMock,
};

// Mock telegram so the bot never sends anything during tests.
const telegramPath = path.resolve(__dirname, 'src', 'telegram.js');
require.cache[require.resolve(telegramPath)] = {
  id: telegramPath,
  filename: telegramPath,
  loaded: true,
  exports: {
    tg: {
      d: () => {},
      i: () => {},
      w: () => {},
      e: () => {},
      fatal: () => {},
    },
  },
};

// Required env vars before src/index.js boots.
process.env.DATABASE_URL = 'postgres://test';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '0'; // ephemeral

// Mock express-rate-limit (no-op middleware) so the test doesn't trip
// rate limiting after a few requests.
const rateLimitPath = require.resolve('express-rate-limit');
require.cache[rateLimitPath] = {
  id: rateLimitPath,
  filename: rateLimitPath,
  loaded: true,
  exports: () => (req, res, next) => next(),
};

// Capture the express app instance from src/index.js so we can host it on
// our own ephemeral http server. Patch app.listen to a no-op so the
// production code's call doesn't bind a real port.
const origExpress = require('express');
let capturedApp = null;
const expressShim = function () {
  const app = origExpress();
  capturedApp = app;
  app.listen = function (_port, cb) {
    if (typeof cb === 'function') cb();
    return { close: (cb2) => cb2 && cb2() };
  };
  return app;
};
Object.setPrototypeOf(expressShim, origExpress);
Object.assign(expressShim, origExpress);
require.cache[require.resolve('express')] = {
  id: require.resolve('express'),
  filename: require.resolve('express'),
  loaded: true,
  exports: expressShim,
};

const indexPath = path.resolve(__dirname, 'src', 'index.js');
require(indexPath);

if (!capturedApp) {
  log('FATAL: failed to capture express app — cannot run tests');
  process.exit(1);
}

// Bind the captured app to an ephemeral port so express's full request
// pipeline (body parser, helmet, CORS, etc.) runs as it would in production.
let _testServer = null;
let _testPort = 0;

function _startServer() {
  return new Promise((resolve, reject) => {
    _testServer = http.createServer(capturedApp);
    _testServer.listen(0, '127.0.0.1', () => {
      _testPort = _testServer.address().port;
      resolve();
    });
    _testServer.on('error', reject);
  });
}

function _stopServer() {
  return new Promise((resolve) => {
    if (_testServer) _testServer.close(() => resolve());
    else resolve();
  });
}

function _request(method, urlPath, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: _testPort,
      path: urlPath,
      headers: payload === null
        ? {}
        : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  log('\n═════════════════════════════════════════════════');
  log(' SAVED-SEARCHES ROUTER — CONTRACT TESTS');
  log('═════════════════════════════════════════════════\n');

  await _startServer();

  // ── 1. POST /api/v1/saved-searches — upsert ────────────────────
  log('▸ POST /api/v1/saved-searches');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_searches/i, rowCount: 1 });
    const r = await _request('POST', '/api/v1/saved-searches', {
      body: {
        id: 'abc-123',
        kind: 'url',
        query: 'https://example.com',
        title: 'Example',
        responseType: 'summarizer',
        responseJson: { title: 'x', keyPoints: ['a', 'b'] },
        model: 'gemini',
        provider: '',
        mode: '',
        savedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pinned: true,
      },
    });
    assertEq(r.statusCode, 200, 'POST returns 200');
    assertEq(r.body.ok, true, 'POST body ok=true');
    assertEq(r.body.id, 'abc-123', 'POST body echoes id');

    // Verify the SQL we issued.
    const insert = queryLog.find((q) => /INSERT INTO saved_searches/i.test(q.text));
    assert(insert, 'INSERT issued', 'no INSERT call recorded');
    if (insert) {
      // Verify ALL the column placeholders are bound IN ORDER. The router
      // contract is: $1=id, $2=kind, $3=query, $4=title, $5=response_type,
      // $6=response_json (string!), $7=model, $8=provider, $9=mode,
      // $10=pinned, $11=saved_at, $12=updated_at.
      const v = insert.values;
      assertEq(v[0], 'abc-123', '  $1 = id');
      assertEq(v[1], 'url',     '  $2 = kind');
      assertEq(v[2], 'https://example.com', '  $3 = query');
      assertEq(v[3], 'Example', '  $4 = title');
      assertEq(v[4], 'summarizer', '  $5 = response_type');
      // responseJson is JSON-encoded into a string.
      const expectedJson = JSON.stringify({ title: 'x', keyPoints: ['a', 'b'] });
      assertEq(v[5], expectedJson, '  $6 = response_json (stringified)');
      assertEq(v[6], 'gemini', '  $7 = model');
      assertEq(v[9], true, '  $10 = pinned (true)');
      assertContains(insert.text, 'ON CONFLICT (id) DO UPDATE',
          '  uses ON CONFLICT for upsert idempotency');
    }
  }

  // ── 2. POST accepts JSON-string responseJson too (the fallback path) ─
  log('\n▸ POST tolerates pre-stringified responseJson');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_searches/i, rowCount: 1 });
    const r = await _request('POST', '/api/v1/saved-searches', {
      body: {
        id: 'abc-456',
        responseType: 'tavily',
        responseJson: '{"answer":"y"}', // already a string
      },
    });
    assertEq(r.statusCode, 200, 'POST returns 200');
    const insert = queryLog.find((q) => /INSERT INTO saved_searches/i.test(q.text));
    assert(insert, 'INSERT issued');
    if (insert) {
      assertEq(insert.values[5], '{"answer":"y"}',
          '  pre-stringified responseJson is stored verbatim');
    }
  }

  // ── 3. POST validation — id required ───────────────────────────
  log('\n▸ POST validation');
  {
    clearMocks();
    const r = await _request('POST', '/api/v1/saved-searches', { body: {} });
    assertEq(r.statusCode, 400, 'POST without id returns 400');
    assertContains(JSON.stringify(r.body), 'id', 'error mentions id');
    assertEq(queryLog.length, 0, '  no SQL issued for invalid request');
  }

  // ── 4. GET /api/v1/saved-searches — list ───────────────────────
  log('\n▸ GET /api/v1/saved-searches');
  {
    clearMocks();
    cannedResponses.push({
      match: /SELECT \* FROM saved_searches/i,
      rows: [
        {
          id: 'row-1',
          kind: 'query',
          query: 'q',
          title: 't',
          response_type: 'tavily',
          response_json: '{"answer":"hi"}',
          model: 'gemini',
          provider: '',
          mode: '',
          pinned: true,
          saved_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches');
    assertEq(r.statusCode, 200, 'GET returns 200');
    assert(Array.isArray(r.body), 'GET returns an array',
        `expected array, got ${typeof r.body}`);
    assertEq(r.body.length, 1, 'GET returns one row');
    const row = r.body[0];
    // The wire shape is camelCase and responseJson is decoded back to an object.
    assertEq(row.id, 'row-1',           '  id');
    assertEq(row.kind, 'query',         '  kind');
    assertEq(row.responseType, 'tavily', '  responseType (camelCase)');
    assertEq(row.responseJson, { answer: 'hi' },
        '  responseJson is decoded to object on the wire');
    assertEq(row.pinned, true,           '  pinned');
    assertEq(row.savedAt, '2026-01-01T00:00:00Z', '  savedAt (camelCase)');
    assertEq(row.updatedAt, '2026-01-01T00:00:00Z', '  updatedAt (camelCase)');

    // The SELECT must filter on pinned = TRUE.
    const sel = queryLog.find((q) => /SELECT \* FROM saved_searches/i.test(q.text));
    assertContains(sel.text, 'pinned = TRUE',
        '  GET filters out drafts (pinned = TRUE)');
    assertContains(sel.text, 'ORDER BY updated_at DESC',
        '  GET orders by updated_at DESC for "newest activity first"');
  }

  // ── 5. DELETE writes tombstone + cascades to chats + summary ──
  log('\n▸ DELETE /api/v1/saved-searches/:id (tombstone + cascade)');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO deleted_saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_messages/i, rowCount: 2 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_summaries/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM saved_searches/i, rowCount: 1 });
    const r = await _request('DELETE', '/api/v1/saved-searches/abc-123');
    assertEq(r.statusCode, 200, 'DELETE returns 200');
    assertEq(r.body.ok, true,    'DELETE body ok=true');
    assertEq(r.body.deleted, 1,  'DELETE body deleted=1');

    // Tombstone is written FIRST so cross-device delete sync is durable
    // even if a later cascade fails.
    const tomb = queryLog.find((q) => /INSERT INTO deleted_saved_searches/i.test(q.text));
    assert(tomb, 'tombstone INSERT issued',
        'no INSERT INTO deleted_saved_searches recorded');
    if (tomb) {
      assertEq(tomb.values, ['abc-123'], '  tombstone bound by id');
      assertContains(tomb.text, 'ON CONFLICT (id) DO UPDATE',
          '  tombstone insert is idempotent (re-deleting same id is safe)');
      assertContains(tomb.text, 'deleted_at = NOW()',
          '  tombstone records the deletion timestamp on each delete');
    }
    // Order: tombstone first, then cascades, then parent.
    const tombIdx  = queryLog.findIndex((q) => /INSERT INTO deleted_saved_searches/i.test(q.text));
    const chatIdx  = queryLog.findIndex((q) => /DELETE FROM saved_search_chat_messages/i.test(q.text));
    const sumIdx   = queryLog.findIndex((q) => /DELETE FROM saved_search_chat_summaries/i.test(q.text));
    const ssIdx    = queryLog.findIndex((q) => /^DELETE FROM saved_searches /i.test(q.text));
    assert(tombIdx >= 0 && chatIdx > tombIdx && sumIdx > tombIdx && ssIdx > tombIdx,
        'tombstone is written BEFORE any cascade (durability guarantee)',
        `order: tomb=${tombIdx} chats=${chatIdx} sum=${sumIdx} parent=${ssIdx}`);

    // Verify all three deletes were issued — chats first, summary, then parent.
    const chatDel = queryLog.find((q) => /DELETE FROM saved_search_chat_messages/i.test(q.text));
    const sumDel  = queryLog.find((q) => /DELETE FROM saved_search_chat_summaries/i.test(q.text));
    const ssDel   = queryLog.find((q) => /^DELETE FROM saved_searches /i.test(q.text));
    assert(chatDel, 'cascade-deletes chat messages');
    assert(sumDel,  'cascade-deletes summary');
    assert(ssDel,   'deletes saved_searches row');
    if (chatDel) assertEq(chatDel.values, ['abc-123'], '  chats bound by id');
    if (sumDel)  assertEq(sumDel.values,  ['abc-123'], '  summary bound by id');
    if (ssDel)   assertEq(ssDel.values,   ['abc-123'], '  parent bound by id');
  }

  // ── 5b. POST upsert clears any tombstone (cross-device "undelete") ──
  log('\n▸ POST upsert clears tombstone for the same id');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM deleted_saved_searches/i, rowCount: 1 });
    const r = await _request('POST', '/api/v1/saved-searches', {
      body: { id: 'redo-1', responseType: 'tavily' },
    });
    assertEq(r.statusCode, 200, 'POST returns 200');
    const upsert = queryLog.find((q) => /INSERT INTO saved_searches/i.test(q.text));
    const clear  = queryLog.find((q) => /DELETE FROM deleted_saved_searches/i.test(q.text));
    assert(upsert, 'upsert INSERT issued');
    assert(clear, 'tombstone clear DELETE issued',
        'POST must wipe any prior tombstone for the same id');
    if (clear) {
      assertEq(clear.values, ['redo-1'],
          '  tombstone clear bound by id');
    }
    // Order: upsert first, then tombstone clear (so even if the clear
    // fails we still have the row resurrected).
    const upsertIdx = queryLog.findIndex((q) => /INSERT INTO saved_searches/i.test(q.text));
    const clearIdx  = queryLog.findIndex((q) => /DELETE FROM deleted_saved_searches/i.test(q.text));
    assert(clearIdx > upsertIdx,
        'tombstone clear is issued AFTER the upsert',
        `order: upsert=${upsertIdx} clear=${clearIdx}`);
  }

  // ── 5c. GET /tombstones — incremental delete log ──────────────
  log('\n▸ GET /api/v1/saved-searches/tombstones');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM deleted_saved_searches/i,
      rows: [
        { id: 'gone-1', deleted_at: new Date('2026-01-01T00:00:00Z') },
        { id: 'gone-2', deleted_at: new Date('2026-01-02T00:00:00Z') },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches/tombstones');
    assertEq(r.statusCode, 200, 'GET tombstones returns 200');
    assert(Array.isArray(r.body), 'returns an array');
    assertEq(r.body.length, 2, 'returns both tombstones');
    assertEq(r.body[0].id, 'gone-1',          '  [0].id');
    assertEq(r.body[0].deletedAt,
        '2026-01-01T00:00:00.000Z',
        '  [0].deletedAt (camelCase, ISO-8601)');
    assertEq(r.body[1].id, 'gone-2',          '  [1].id');

    const sel = queryLog.find((q) => /FROM deleted_saved_searches/i.test(q.text));
    assertContains(sel.text, 'ORDER BY deleted_at ASC',
        '  ordered ascending so client watermark advances monotonically');
    assertContains(sel.text, 'LIMIT 1000',
        '  capped at 1000 rows so a huge backlog is paginated naturally');
  }

  // ── 5d. GET /tombstones?since=<iso> filters by watermark ──────
  log('\n▸ GET /tombstones?since=<iso>');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM deleted_saved_searches/i,
      rows: [
        { id: 'recent-1', deleted_at: new Date('2026-02-01T00:00:00Z') },
      ],
    });
    const r = await _request(
      'GET',
      '/api/v1/saved-searches/tombstones?since=2026-01-15T00%3A00%3A00Z',
    );
    assertEq(r.statusCode, 200, 'GET with since= returns 200');
    assertEq(r.body.length, 1, 'returns only the delta');
    assertEq(r.body[0].id, 'recent-1', '  [0].id');

    const sel = queryLog.find((q) => /FROM deleted_saved_searches/i.test(q.text));
    assertContains(sel.text, 'WHERE deleted_at > $1',
        '  applies the since filter via parameterised query (no SQL injection risk)');
    assertEq(sel.values, ['2026-01-15T00:00:00.000Z'],
        '  since= is normalised to ISO-8601 before binding');
  }

  // ── 5e. GET /tombstones with invalid since= → 400 ─────────────
  log('\n▸ GET /tombstones with garbage since= → 400');
  {
    clearMocks();
    const r = await _request(
      'GET',
      '/api/v1/saved-searches/tombstones?since=NOT_A_DATE',
    );
    assertEq(r.statusCode, 400, 'returns 400 for invalid since=');
    assertContains(JSON.stringify(r.body), 'invalid since',
        'error mentions invalid since timestamp');
    assertEq(queryLog.length, 0, '  no SQL issued for invalid request');
  }

  // ── 5f. /tombstones is matched BEFORE /:id (Express ordering) ──
  log('\n▸ /tombstones is NOT misread as /:id');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM deleted_saved_searches/i,
      rows: [],
    });
    const r = await _request('GET', '/api/v1/saved-searches/tombstones');
    assertEq(r.statusCode, 200,
        'tombstones is routed to the tombstones handler, NOT to GET /:id');
    // The /:id handler would have queried saved_searches; we should see
    // ONLY the tombstones SELECT.
    const wrongRoute = queryLog.find(
        (q) => /SELECT \* FROM saved_searches WHERE id = \$1/i.test(q.text));
    assert(!wrongRoute,
        '  no GET /:id query issued — Express ordering correct');
  }

  // ── 6. GET /:id/chat — wire shape ──────────────────────────────
  log('\n▸ GET /api/v1/saved-searches/:id/chat');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM saved_search_chat_messages/i,
      rows: [
        {
          id: 'msg-1', search_id: 's-1', role: 'user', text: 'hi',
          model: '', sources_json: '[]', created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'msg-2', search_id: 's-1', role: 'assistant', text: 'hello',
          model: 'gemini', sources_json: '[{"index":1,"title":"a","url":"u"}]',
          created_at: '2026-01-01T00:00:01Z',
        },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches/s-1/chat');
    assertEq(r.statusCode, 200, 'GET chat returns 200');
    assertEq(r.body.length, 2, 'GET chat returns 2 messages');
    assertEq(r.body[0].id, 'msg-1', '  msg[0].id');
    assertEq(r.body[0].searchId, 's-1', '  msg[0].searchId (camelCase)');
    assertEq(r.body[0].role, 'user', '  msg[0].role');
    assertEq(r.body[0].text, 'hi', '  msg[0].text');
    assertEq(r.body[1].sourcesJson,
        '[{"index":1,"title":"a","url":"u"}]',
        '  msg[1].sourcesJson preserved verbatim');
    assertEq(r.body[1].createdAt, '2026-01-01T00:00:01Z',
        '  msg[1].createdAt (camelCase)');

    // SQL ordering contract.
    const sel = queryLog.find((q) => /FROM saved_search_chat_messages/i.test(q.text));
    assertContains(sel.text, 'ORDER BY created_at ASC',
        '  GET chat orders oldest-first');
    assertEq(sel.values, ['s-1'], '  GET chat bound by search id');
  }

  // ── 7. POST /:id/chat — upsert + parent updated_at bump ────────
  log('\n▸ POST /api/v1/saved-searches/:id/chat');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_search_chat_messages/i, rowCount: 1 });
    cannedResponses.push({ match: /UPDATE saved_searches SET updated_at/i, rowCount: 1 });
    const r = await _request('POST', '/api/v1/saved-searches/s-1/chat', {
      body: {
        id: 'msg-3',
        role: 'user',
        text: 'next ask',
        model: '',
        sourcesJson: '[]',
        createdAt: '2026-02-01T00:00:00Z',
      },
    });
    assertEq(r.statusCode, 200, 'POST chat returns 200');
    assertEq(r.body.ok, true,    'POST chat body ok=true');

    const ins = queryLog.find((q) => /INSERT INTO saved_search_chat_messages/i.test(q.text));
    assert(ins, 'chat INSERT issued');
    if (ins) {
      assertEq(ins.values[0], 'msg-3', '  $1 = msg id');
      assertEq(ins.values[1], 's-1',   '  $2 = search id');
      assertEq(ins.values[2], 'user',  '  $3 = role');
      assertEq(ins.values[3], 'next ask', '  $4 = text');
      assertContains(ins.text, 'ON CONFLICT (id) DO UPDATE',
          '  chat insert uses ON CONFLICT for idempotent re-sends');
    }
    const upd = queryLog.find((q) => /UPDATE saved_searches SET updated_at/i.test(q.text));
    assert(upd, 'parent updated_at bump issued');
    if (upd) {
      assertEq(upd.values[0], '2026-02-01T00:00:00Z',
          '  parent updated_at bumped to message createdAt');
      assertEq(upd.values[1], 's-1', '  parent bound by id');
    }
  }

  // ── 8. POST /:id/chat validation ───────────────────────────────
  log('\n▸ POST chat validation');
  {
    clearMocks();
    const r = await _request('POST', '/api/v1/saved-searches/s-1/chat', {
      body: { /* missing id and role */ text: 'oops' },
    });
    assertEq(r.statusCode, 400, '400 when id+role missing');
    assertEq(queryLog.filter((q) => /INSERT/i.test(q.text)).length, 0,
        'no INSERT for invalid chat body');
  }

  // ── 9. PUT /:id/summary upsert ─────────────────────────────────
  log('\n▸ PUT /api/v1/saved-searches/:id/summary');
  {
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_search_chat_summaries/i, rowCount: 1 });
    const r = await _request('PUT', '/api/v1/saved-searches/s-1/summary', {
      body: {
        summaryText: 'A rolling summary of the conversation.',
        pairsCovered: 7,
        updatedAt: '2026-03-01T00:00:00Z',
      },
    });
    assertEq(r.statusCode, 200, 'PUT summary returns 200');
    assertEq(r.body.ok, true, 'PUT summary body ok=true');
    assertEq(r.body.pairsCovered, 7, 'PUT summary echoes pairsCovered');

    const ins = queryLog.find((q) => /INSERT INTO saved_search_chat_summaries/i.test(q.text));
    assert(ins, 'summary INSERT issued');
    if (ins) {
      assertEq(ins.values[0], 's-1', '  $1 = search id');
      assertEq(ins.values[1], 'A rolling summary of the conversation.',
          '  $2 = summary text');
      assertEq(ins.values[2], 7, '  $3 = pairs covered');
      assertContains(ins.text, 'ON CONFLICT (search_id) DO UPDATE',
          '  summary upsert keyed on search_id');
    }
  }

  // ── 10. PUT summary validation ─────────────────────────────────
  log('\n▸ PUT summary validation');
  {
    clearMocks();
    const r = await _request('PUT', '/api/v1/saved-searches/s-1/summary', {
      body: { summaryText: 'x' /* missing pairsCovered */ },
    });
    assertEq(r.statusCode, 400, 'PUT without pairsCovered returns 400');
  }

  // ── 11. GET /:id/summary returns {} when no row ────────────────
  log('\n▸ GET summary missing → empty object');
  {
    clearMocks();
    cannedResponses.push({ match: /SELECT summary_text/i, rows: [] });
    const r = await _request('GET', '/api/v1/saved-searches/s-1/summary');
    assertEq(r.statusCode, 200, 'returns 200 even when missing');
    assertEq(r.body, {}, 'returns empty object so client treats as "no summary"');
  }

  // ── 12. GET /:id 404 when no row ───────────────────────────────
  log('\n▸ GET /:id missing → 404');
  {
    clearMocks();
    cannedResponses.push({ match: /SELECT \* FROM saved_searches WHERE id/i, rows: [] });
    const r = await _request('GET', '/api/v1/saved-searches/missing-id');
    assertEq(r.statusCode, 404, 'returns 404 for missing id');
  }

  // ── 13. responseJson parses string-encoded data on read ───────
  log('\n▸ responseJson string vs object reconciliation');
  {
    clearMocks();
    cannedResponses.push({
      match: /SELECT \* FROM saved_searches WHERE id/i,
      rows: [{
        id: 'row-x',
        kind: 'query',
        query: 'q',
        title: 't',
        response_type: 'grounded',
        response_json: 'NOT VALID JSON',
        model: 'gemini',
        provider: '',
        mode: '',
        pinned: true,
        saved_at: '',
        updated_at: '',
      }],
    });
    const r = await _request('GET', '/api/v1/saved-searches/row-x');
    assertEq(r.statusCode, 200, 'GET single returns 200');
    // The router falls back to the raw string when DB content is malformed
    // — better to ship verbatim than crash the response.
    assertEq(r.body.responseJson, 'NOT VALID JSON',
        'malformed responseJson is shipped verbatim (no crash)');
  }

  // ── 9. DELETE on already-gone row still writes tombstone (idempotent) ──
  log('\n▸ DELETE on already-gone id still writes tombstone');
  {
    clearMocks();
    // INSERT … ON CONFLICT … DO UPDATE — server treats a re-delete as a
    // refresh of the existing tombstone (deleted_at = NOW()), not a no-op.
    cannedResponses.push({ match: /INSERT INTO deleted_saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_messages/i, rowCount: 0 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_summaries/i, rowCount: 0 });
    cannedResponses.push({ match: /DELETE FROM saved_searches/i, rowCount: 0 });
    const r = await _request('DELETE', '/api/v1/saved-searches/already-gone');
    assertEq(r.statusCode, 200, 'returns 200 even when no rows match');
    assertEq(r.body.deleted, 0,
        'deleted=0 when the row was already gone (cascade was a no-op)');
    const tomb = queryLog.find((q) => /INSERT INTO deleted_saved_searches/i.test(q.text));
    assert(tomb,
        'tombstone INSERT issued even for an already-deleted row',
        'cross-device delete sync must remain durable on re-deletes');
    if (tomb) {
      assertContains(tomb.text, 'ON CONFLICT (id) DO UPDATE',
          '  re-delete refreshes deleted_at via ON CONFLICT');
    }
  }

  // ── 10. POST then DELETE then POST: tombstone life-cycle ──────
  log('\n▸ POST → DELETE → POST: tombstone is cleared on resurrection');
  {
    // First POST → tombstone clear runs (no-op if absent).
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM deleted_saved_searches/i, rowCount: 0 });
    let r = await _request('POST', '/api/v1/saved-searches', {
      body: { id: 'lifecycle-1', responseType: 'tavily' },
    });
    assertEq(r.statusCode, 200, 'first POST returns 200');
    const clear1 = queryLog.find((q) => /DELETE FROM deleted_saved_searches/i.test(q.text));
    assert(clear1, 'POST always issues a tombstone clear (idempotent)');

    // DELETE → writes tombstone.
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO deleted_saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_messages/i, rowCount: 0 });
    cannedResponses.push({ match: /DELETE FROM saved_search_chat_summaries/i, rowCount: 0 });
    cannedResponses.push({ match: /DELETE FROM saved_searches/i, rowCount: 1 });
    r = await _request('DELETE', '/api/v1/saved-searches/lifecycle-1');
    assertEq(r.statusCode, 200, 'DELETE returns 200');

    // Second POST → resurrection. Must clear the tombstone.
    clearMocks();
    cannedResponses.push({ match: /INSERT INTO saved_searches/i, rowCount: 1 });
    cannedResponses.push({ match: /DELETE FROM deleted_saved_searches/i, rowCount: 1 });
    r = await _request('POST', '/api/v1/saved-searches', {
      body: { id: 'lifecycle-1', responseType: 'tavily' },
    });
    assertEq(r.statusCode, 200, 'resurrection POST returns 200');
    const upsert = queryLog.find((q) => /INSERT INTO saved_searches/i.test(q.text));
    const clear2 = queryLog.find((q) => /DELETE FROM deleted_saved_searches/i.test(q.text));
    assert(upsert, 'upsert ran on resurrection');
    assert(clear2,
        'tombstone clear ran on resurrection — other devices won\'t delete it');
    if (clear2) {
      assertEq(clear2.values, ['lifecycle-1'],
          '  tombstone clear bound by id');
    }
  }

  // ── 11. GET tombstones with empty since= (just "?since=") returns all ──
  log('\n▸ GET tombstones with empty since= returns ALL (treat empty as no filter)');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM deleted_saved_searches/i,
      rows: [
        { id: 'all-1', deleted_at: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches/tombstones?since=');
    assertEq(r.statusCode, 200,
        'empty since= is treated as "no filter", not as garbage');
    assertEq(r.body.length, 1, 'returns the row');
    const sel = queryLog.find((q) => /FROM deleted_saved_searches/i.test(q.text));
    assert(!/WHERE deleted_at/i.test(sel.text),
        '  no WHERE clause when since= is empty (matches null-watermark client)');
  }

  // ── 12. GET tombstones returns valid camelCase ISO-8601 even when DB ──
  //         column is a string (some envs ship TIMESTAMPTZ as text)
  log('\n▸ GET tombstones tolerates TIMESTAMPTZ returned as a string');
  {
    clearMocks();
    cannedResponses.push({
      match: /FROM deleted_saved_searches/i,
      rows: [
        // Some node-postgres + driver combos return text instead of Date.
        { id: 'as-str-1', deleted_at: '2026-03-01T12:34:56.789Z' },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches/tombstones');
    assertEq(r.statusCode, 200, 'returns 200');
    assertEq(r.body[0].deletedAt, '2026-03-01T12:34:56.789Z',
        '  string TIMESTAMPTZ is shipped verbatim (still ISO-8601)');
  }

  // ── 13. Bare /saved-searches GET still works (no tombstones leak) ──
  log('\n▸ GET / (rows) does NOT also include tombstones');
  {
    clearMocks();
    cannedResponses.push({
      match: /SELECT \* FROM saved_searches/i,
      rows: [
        {
          id: 's-only',
          kind: 'query',
          query: 'q',
          title: '',
          response_type: 'tavily',
          response_json: '{}',
          model: '',
          provider: '',
          mode: '',
          pinned: true,
          saved_at: '',
          updated_at: '',
        },
      ],
    });
    const r = await _request('GET', '/api/v1/saved-searches');
    assertEq(r.statusCode, 200, 'returns 200');
    assertEq(r.body.length, 1, 'returns one row');
    // The DB call is ONLY against saved_searches — no leak from tombstones.
    const sel = queryLog.find((q) => /FROM deleted_saved_searches/i.test(q.text));
    assert(!sel,
        'GET / must NOT query deleted_saved_searches — separate endpoint',
        'tombstone reads are isolated to /tombstones for clarity');
  }

  // ── Summary ────────────────────────────────────────────────────
  log('\n═════════════════════════════════════════════════');
  log(` Passed: ${passed}    Failed: ${failed}`);
  if (failed > 0) {
    log('\nFailures:');
    failures.forEach((f) => log(`  • ${f}`));
  }
  log('═════════════════════════════════════════════════\n');
  await _stopServer();
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch(async (e) => {
  log(`\n💥 Test runner crashed: ${e.stack || e}`);
  try { await _stopServer(); } catch (_) {}
  process.exit(1);
});
