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
  assert.doesNotMatch(SRC, /enqueueFromIngest/);
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

test('clear-all and delete drop narrator audio, ingest still enqueues immediately', () => {
  assert.match(CLIENT, /\/v1\/drop/);
  assert.match(CLIENT, /dropArticles/);
  assert.match(INDEX, /dropArticles\(result\.rows\.map/);
  assert.match(INDEX, /dropArticles\(\[id\]\)/);
  assert.match(SRC, /dropArticles/);
  assert.doesNotMatch(SRC, /enqueueFromIngest/);
  assert.doesNotMatch(CLIENT, /geminiComplete/);
});

test('listen-complete does not delete audio; ensure can recover leftover tombstones', () => {
  const PROXY = fs.readFileSync(path.join(__dirname, '..', 'src', 'narration-proxy.js'), 'utf8');
  assert.match(CLIENT, /force:\s*true/);
  assert.doesNotMatch(
    CLIENT.slice(CLIENT.indexOf('function enqueueFromIngest'), CLIENT.indexOf('async function ensureJob')),
    /force:\s*true/,
  );
  assert.match(PROXY, /article_dropped/);
  assert.match(PROXY, /rec\.status === 'deleted'/);
});

test('mark-all-read keeps saved audio; nuke deletes every row including saved', () => {
  const mark = INDEX.slice(
    INDEX.indexOf("newsRouter.post('/mark-all-read'"),
    INDEX.indexOf("newsRouter.post('/nuke'"),
  );
  const nuke = INDEX.slice(
    INDEX.indexOf("newsRouter.post('/nuke'"),
    INDEX.indexOf("newsRouter.delete('/cleanup-mock'"),
  );
  assert.match(mark, /AND saved = FALSE/);
  assert.match(mark, /dropArticles\(result\.rows\.map/);
  assert.match(nuke, /DELETE FROM news_articles RETURNING id/);
  assert.match(nuke, /dropArticles\(result\.rows\.map/);
});
