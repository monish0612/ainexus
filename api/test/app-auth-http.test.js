'use strict';

// ═══════════════════════════════════════════════════════════════
//  APP-AUTH — HTTP integration tests (real Express + real sockets)
//
//  Spins a tiny Express app wired EXACTLY like index.js (same module
//  functions, same middleware placement) and drives it over real HTTP
//  with fetch. Catches anything the pure-unit tests can't: header
//  parsing, JSON body handling, 401 status/flow, token round-trip
//  across the wire, and the client-log relay shape.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'http-int-secret';
process.env.APP_AUTH_USERNAME = 'monish';
process.env.APP_AUTH_PASSWORD = 'Chennaisuper.23';
delete process.env.APP_AUTH_REQUIRED;

const {
  checkAppCredentials,
  makeAppToken,
  verifyAppToken,
  requireApp,
  buildClientLog,
} = require('../src/app-auth');

// Captured "telegram" lines so we can assert the relay without network.
const tgCaptured = [];

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/v1/auth/app-login', (req, res) => {
    const { username, password } = req.body || {};
    if (!checkAppCredentials(username, password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    return res.json({ token: makeAppToken() });
  });

  app.post('/api/v1/client-log', (req, res) => {
    const { level, tag, message, line } = buildClientLog(req.body);
    if (message) tgCaptured.push({ level, tag, line });
    return res.status(204).end();
  });

  // Protected exactly like index.js: requireApp before the router.
  app.use('/api/v1/expenses', requireApp);
  app.get('/api/v1/expenses', (req, res) =>
    res.json({ ok: true, scope: req.appAuth ? req.appAuth.scope : null }),
  );

  return app;
}

let server;
let base;

test.before(async () => {
  const app = buildApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (path, headers = {}) =>
  fetch(base + path, { method: 'GET', headers });

test('app-login: valid creds → 200 + verifiable scoped token', async () => {
  const r = await post('/api/v1/auth/app-login', {
    username: 'monish',
    password: 'Chennaisuper.23',
  });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.ok(token);
  assert.equal(verifyAppToken(token).scope, 'app');
});

test('app-login: wrong password / unknown user / empty → 401', async () => {
  assert.equal(
    (await post('/api/v1/auth/app-login', { username: 'monish', password: 'x' }))
      .status,
    401,
  );
  assert.equal(
    (await post('/api/v1/auth/app-login', { username: 'eve', password: 'Chennaisuper.23' }))
      .status,
    401,
  );
  assert.equal((await post('/api/v1/auth/app-login', {})).status, 401);
});

test('expenses PERMISSIVE (flag off): reachable without a token', async () => {
  delete process.env.APP_AUTH_REQUIRED;
  const r = await get('/api/v1/expenses');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.scope, null);
});

test('expenses PERMISSIVE: a valid token is still attached (scope app)', async () => {
  delete process.env.APP_AUTH_REQUIRED;
  const token = makeAppToken();
  const r = await get('/api/v1/expenses', { Authorization: `Bearer ${token}` });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.scope, 'app');
});

test('expenses ENFORCED: no token → 401, valid token → 200', async () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  try {
    assert.equal((await get('/api/v1/expenses')).status, 401);
    assert.equal(
      (await get('/api/v1/expenses', { Authorization: 'Bearer garbage' })).status,
      401,
    );

    // Full round-trip: login → use issued token → 200.
    const login = await post('/api/v1/auth/app-login', {
      username: 'monish',
      password: 'Chennaisuper.23',
    });
    const { token } = await login.json();
    const ok = await get('/api/v1/expenses', {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).scope, 'app');
  } finally {
    delete process.env.APP_AUTH_REQUIRED;
  }
});

test('expenses ENFORCED: non-Bearer Authorization header → 401', async () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  try {
    const r = await get('/api/v1/expenses', { Authorization: 'Basic abc123' });
    assert.equal(r.status, 401);
  } finally {
    delete process.env.APP_AUTH_REQUIRED;
  }
});

test('client-log: forwards a normalized WEB line, returns 204', async () => {
  tgCaptured.length = 0;
  const r = await post('/api/v1/client-log', {
    level: 'error',
    message: 'render boom',
    context: 'NewsPage',
    url: 'https://app/x',
  });
  assert.equal(r.status, 204);
  assert.equal(tgCaptured.length, 1);
  assert.equal(tgCaptured[0].tag, 'WEB:NewsPage');
  assert.match(tgCaptured[0].line, /render boom/);
});

test('client-log: oversized payload is capped (cannot flood Telegram)', async () => {
  tgCaptured.length = 0;
  const big = 'Z'.repeat(20000);
  const r = await post('/api/v1/client-log', {
    message: big,
    stack: big,
    url: big,
  });
  assert.equal(r.status, 204);
  assert.equal(tgCaptured.length, 1);
  assert.ok(tgCaptured[0].line.length < 2500);
});

test('client-log: empty body → 204 and nothing relayed', async () => {
  tgCaptured.length = 0;
  const r = await post('/api/v1/client-log', {});
  assert.equal(r.status, 204);
  assert.equal(tgCaptured.length, 0);
});
