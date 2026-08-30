'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { skipGlobalApiRateLimit } = require('../src/rate-limit-skip');

function req(method, url, originalUrl) {
  return { method, url, originalUrl: originalUrl || url };
}

test('skips GET live stats and history under a /nexusai prefix', () => {
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats')), true);
  assert.equal(
    skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats', '/nexusai/api/v1/cloud/stats')),
    true,
  );
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats/')), true);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats?x=1')), true);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats/history')), true);
  assert.equal(
    skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats/history?range=30d')),
    true,
  );
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats/history/')), true);
});

test('does not skip neighbouring cloud routes or writes', () => {
  assert.equal(skipGlobalApiRateLimit(req('POST', '/api/v1/cloud/stats')), false);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/status')), false);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/quota')), false);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/ai/article-followup')), false);
  assert.equal(skipGlobalApiRateLimit(req('POST', '/api/v1/ai/article-followup')), false);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats/export')), false);
  assert.equal(skipGlobalApiRateLimit(req('GET', '/api/v1/cloud/stats-archive')), false);
});

test('skips resumable upload chunk paths', () => {
  assert.equal(
    skipGlobalApiRateLimit(req('PUT', '/api/v1/cloud/upload/resumable/abc/chunk')),
    true,
  );
  assert.equal(
    skipGlobalApiRateLimit(req('PUT', '/api/v1/cloud/nas/upload/resumable/abc/chunk')),
    true,
  );
});
