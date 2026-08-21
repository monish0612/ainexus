'use strict';

// ═══════════════════════════════════════════════════════════════
//  ROUTE WIRING GUARD
//
//  Asserts that index.js actually gates EVERY data/AI router with
//  requireApp, that auth + client-log stay OPEN (so login and error
//  reporting work pre-auth), and that the app-login + client-log
//  routes exist. A regression here would silently expose data, so we
//  lock the wiring down at the source level.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index.js'),
  'utf8',
);

const PROTECTED = [
  'expenses',
  'news',
  'ai',
  'llm',
  'cloud',
  'budget',
  'salary',
  'category-learnings',
  'saved-words',
  'saved-searches',
  'article-chats',
  'user-preferences',
  'app-settings',
  'data-reset',
  'sync',
];

for (const name of PROTECTED) {
  test(`/api/v1/${name} is gated by requireApp`, () => {
    const re = new RegExp(
      `app\\.use\\('/api/v1/${name}',\\s*requireApp,`,
    );
    assert.match(
      SRC,
      re,
      `Expected '${name}' router to be mounted with requireApp`,
    );
  });
}

test('auth router is NOT gated (login must be reachable)', () => {
  assert.match(SRC, /app\.use\('\/api\/v1\/auth',\s*authRouter\)/);
  assert.doesNotMatch(SRC, /app\.use\('\/api\/v1\/auth',\s*requireApp/);
});

test('client-log route exists and is NOT gated by requireApp', () => {
  assert.match(SRC, /app\.post\('\/api\/v1\/client-log'/);
  assert.doesNotMatch(
    SRC,
    /app\.post\('\/api\/v1\/client-log',\s*requireApp/,
  );
});

test('app-login route exists with a dedicated rate limiter', () => {
  assert.match(SRC, /authRouter\.post\('\/app-login',\s*appLoginLimiter/);
});

test('cloud token-broker route exists on the (requireApp-gated) cloud router', () => {
  // The whole /cloud subtree is gated by requireApp, so the token broker is
  // auth-protected by construction. Confirm it exists and never lets a bearer
  // token be cached at any hop.
  assert.match(SRC, /cloudRouter\.get\('\/token'/);
  assert.match(SRC, /res\.setHeader\('Cache-Control',\s*'no-store'\)/);
});

test('Drive backup routes live on the (requireApp-gated) cloud router', () => {
  assert.match(SRC, /cloudRouter\.get\('\/backup'/);
  assert.match(SRC, /cloudRouter\.post\('\/backup'/);
  assert.match(SRC, /cloudRouter\.post\('\/backup\/restore'/);
  assert.match(SRC, /backupService\.startScheduler\(pool\)/);
});

test('app-auth helpers are imported into index.js', () => {
  assert.match(SRC, /require\('\.\/app-auth'\)/);
  for (const fn of ['requireApp', 'checkAppCredentials', 'makeAppToken', 'buildClientLog']) {
    assert.ok(SRC.includes(fn), `index.js should use ${fn}`);
  }
});
