'use strict';

// ═══════════════════════════════════════════════════════════════
//  APP-AUTH — contract tests (node:test, no network/DB)
//
//  Covers: constant-time compare, credential check (env-driven),
//  JWT round-trip + expiry/tamper rejection, the requireApp gate in
//  both enforced + permissive modes, and client-log sanitization/caps.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Deterministic env BEFORE requiring the module under test.
process.env.JWT_SECRET = 'test-secret-please-ignore';
process.env.APP_AUTH_USERNAME = 'monish';
process.env.APP_AUTH_PASSWORD = 'Chennaisuper.23';
delete process.env.APP_AUTH_REQUIRED;

const {
  constantTimeEqual,
  checkAppCredentials,
  makeAppToken,
  verifyAppToken,
  requireApp,
  isAppAuthRequired,
  buildClientLog,
} = require('../src/app-auth');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
}

test('constantTimeEqual: equal, unequal, length-mismatch', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, ''), true); // both coerce to ''
});

test('checkAppCredentials: correct pair passes (case/space tolerant user)', () => {
  assert.equal(checkAppCredentials('monish', 'Chennaisuper.23'), true);
  assert.equal(checkAppCredentials('  MONISH ', 'Chennaisuper.23'), true);
});

test('checkAppCredentials: env leftover still accepts the shipped password', () => {
  process.env.APP_AUTH_PASSWORD = 'Tundra-Lantern-Zephyr-20';
  try {
    assert.equal(checkAppCredentials('monish', 'Chennaisuper.23'), true);
    assert.equal(checkAppCredentials('monish', 'Tundra-Lantern-Zephyr-20'), true);
    assert.equal(checkAppCredentials('monish', 'wrong'), false);
  } finally {
    process.env.APP_AUTH_PASSWORD = 'Chennaisuper.23';
  }
});

test('checkAppCredentials: wrong user / wrong pass / empty all fail', () => {
  assert.equal(checkAppCredentials('monish', 'wrong'), false);
  assert.equal(checkAppCredentials('intruder', 'Chennaisuper.23'), false);
  assert.equal(checkAppCredentials('', ''), false);
  assert.equal(checkAppCredentials(undefined, undefined), false);
  // password is case-sensitive
  assert.equal(checkAppCredentials('monish', 'chennaisuper.23'), false);
});

test('JWT round-trip: makeAppToken → verifyAppToken yields scope app', () => {
  const token = makeAppToken();
  const decoded = verifyAppToken(token);
  assert.equal(decoded.scope, 'app');
  assert.ok(decoded.exp > decoded.iat);
});

test('verifyAppToken rejects a tampered / foreign-signed token', () => {
  const foreign = jwt.sign({ scope: 'app' }, 'a-different-secret');
  assert.throws(() => verifyAppToken(foreign));
  assert.throws(() => verifyAppToken('not.a.jwt'));
});

test('verifyAppToken rejects an expired token', () => {
  const expired = jwt.sign({ scope: 'app' }, process.env.JWT_SECRET, {
    expiresIn: -10,
  });
  assert.throws(() => verifyAppToken(expired), /expired/i);
});

test('requireApp PERMISSIVE (flag off): no token → passes', () => {
  delete process.env.APP_AUTH_REQUIRED;
  assert.equal(isAppAuthRequired(), false);
  let called = false;
  const res = fakeRes();
  requireApp({ headers: {} }, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('requireApp PERMISSIVE: invalid token is ignored, still passes', () => {
  delete process.env.APP_AUTH_REQUIRED;
  let called = false;
  const res = fakeRes();
  requireApp(
    { headers: { authorization: 'Bearer garbage' } },
    res,
    () => {
      called = true;
    },
  );
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('requireApp PERMISSIVE: valid token is attached as req.appAuth', () => {
  delete process.env.APP_AUTH_REQUIRED;
  const token = makeAppToken();
  const req = { headers: { authorization: `Bearer ${token}` } };
  let called = false;
  requireApp(req, fakeRes(), () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(req.appAuth.scope, 'app');
});

test('requireApp ENFORCED (flag on): missing token → 401', () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  assert.equal(isAppAuthRequired(), true);
  let called = false;
  const res = fakeRes();
  requireApp({ headers: {} }, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  delete process.env.APP_AUTH_REQUIRED;
});

test('requireApp ENFORCED: invalid token → 401', () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  const res = fakeRes();
  let called = false;
  requireApp(
    { headers: { authorization: 'Bearer nope' } },
    res,
    () => {
      called = true;
    },
  );
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  delete process.env.APP_AUTH_REQUIRED;
});

test('requireApp ENFORCED: valid token → passes', () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  const token = makeAppToken();
  let called = false;
  const res = fakeRes();
  requireApp(
    { headers: { authorization: `Bearer ${token}` } },
    res,
    () => {
      called = true;
    },
  );
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
  delete process.env.APP_AUTH_REQUIRED;
});

test('requireApp ignores a non-Bearer / malformed header', () => {
  process.env.APP_AUTH_REQUIRED = 'true';
  const res = fakeRes();
  requireApp({ headers: { authorization: 'Basic abc' } }, res, () => {});
  assert.equal(res.statusCode, 401); // treated as no token
  delete process.env.APP_AUTH_REQUIRED;
});

test('buildClientLog: defaults level to error, builds WEB tag', () => {
  const r = buildClientLog({ message: 'boom' });
  assert.equal(r.level, 'error');
  assert.equal(r.tag, 'WEB');
  assert.match(r.line, /boom/);
});

test('buildClientLog: context becomes tag suffix; level normalized', () => {
  const r = buildClientLog({ level: 'WARN', message: 'x', context: 'NewsPage' });
  assert.equal(r.level, 'warn');
  assert.equal(r.tag, 'WEB:NewsPage');
});

test('buildClientLog: caps every field so Telegram can never be flooded', () => {
  const big = 'A'.repeat(5000);
  const r = buildClientLog({
    message: big,
    url: big,
    userAgent: big,
    stack: big,
    context: big,
  });
  assert.ok(r.message.length <= 600);
  assert.ok(r.tag.length <= 4 + 120); // "WEB:" + clipped context
  assert.ok(r.line.length <= 600 + 300 + 200 + 900 + 16);
});

test('buildClientLog: empty/garbage body yields empty message (caller drops it)', () => {
  assert.equal(buildClientLog(undefined).message, '');
  assert.equal(buildClientLog({}).message, '');
  assert.equal(buildClientLog('not-an-object').message, '');
});
