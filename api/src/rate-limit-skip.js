'use strict';

/**
 * Global /api/ limiter skip. Live 1 Hz gauges and resumable uploads must not
 * spend the per-IP budget (a miss here 429s article-followup in ~30ms).
 *
 * originalUrl may be prefixed (/nexusai/api/v1/cloud/stats) so we match on
 * /cloud/stats, not a full /api/v1 path. POST is never skipped.
 */
function skipGlobalApiRateLimit(req) {
  const u = String((req && (req.originalUrl || req.url)) || '');
  if (/\/cloud\/upload\/resumable\//.test(u)
    || /\/nas\/upload\/resumable\//.test(u)) {
    return true;
  }
  if (!req || req.method !== 'GET') return false;
  // /cloud/stats, optional /history, optional trailing slash, optional query.
  // Must NOT match /cloud/stats/export or /cloud/status.
  return /\/cloud\/stats(\/history)?\/?(?:\?|$)/.test(u);
}

module.exports = { skipGlobalApiRateLimit };
