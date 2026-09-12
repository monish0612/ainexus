'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'news-service.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const GEMINI = fs.readFileSync(path.join(__dirname, '..', 'src', 'gemini-direct.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'src', 'narration-client.js'), 'utf8');

test('narration ingest is fire-and-forget and does not await the orchestrator', () => {
  assert.match(SRC, /enqueueFromIngest/);
  assert.match(CLIENT, /setImmediate/);
  assert.doesNotMatch(CLIENT, /geminiComplete/);
  assert.doesNotMatch(CLIENT, /summarize-articles-batch/);
});

test('narration router is requireApp-gated in index.js', () => {
  assert.match(INDEX, /app\.use\('\/api\/v1\/narration',\s*requireApp,/);
});

test('gemini-direct.js is unchanged by narration (no narration require)', () => {
  assert.doesNotMatch(GEMINI, /narration/);
});
