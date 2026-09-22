'use strict';

/**
 * LiteLLM /v1/models discovery alerting.
 *
 * The old loop retried with setTimeout AND a 5-minute interval, so the
 * attempt counter climbed forever (Telegram showed "attempt 892/5") and
 * every tick paged after the cap. One outage should page once. Recovery
 * pages once. The last good model list stays in use while discovery is down.
 */

function noteDiscoveryResult(state, { ok, now }) {
  const prev = state || { attempts: 0, alerted: false, downSince: 0 };
  if (ok) {
    return {
      state: { attempts: 0, alerted: false, downSince: 0 },
      telegram: prev.alerted ? 'recovered' : null,
    };
  }
  const attempts = prev.attempts + 1;
  const downSince = prev.downSince || now;
  const sustained = attempts >= 3;
  const telegram = sustained && !prev.alerted ? 'down' : null;
  return {
    state: {
      attempts,
      alerted: prev.alerted || telegram === 'down',
      downSince,
    },
    telegram,
  };
}

module.exports = { noteDiscoveryResult };
