'use strict';

// ═══════════════════════════════════════════════════════════════
//  APP AUTH — single-user JWT gate for the shared data API
//
//  The mobile + web clients share one backend. Historically the data
//  routers (expenses, news, cloud, …) were OPEN. This module adds a
//  signed-JWT gate that both clients obtain via POST /auth/app-login.
//
//  SAFE-BY-DEFAULT ROLLOUT: enforcement is controlled by the env flag
//  APP_AUTH_REQUIRED (default "false"). While false, requests still pass
//  (and any token present is validated + attached), so deploying the
//  backend NEVER breaks an older client. Once both clients ship token
//  support, flip APP_AUTH_REQUIRED=true to enforce.
//
//  Env:
//    JWT_SECRET            (required to sign/verify — already used by users auth)
//    APP_AUTH_REQUIRED     "true" to enforce on data routes (default false)
//    APP_AUTH_USERNAME     canonical username (default "monish")
//    APP_AUTH_PASSWORD     canonical password (default the app's built-in)
//    APP_AUTH_TTL_DAYS     token lifetime in days (default 45, matches session)
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

// Read env LIVE (not cached) so tests — and a runtime restart — can toggle.
function isAppAuthRequired() {
  return String(process.env.APP_AUTH_REQUIRED || 'false').toLowerCase() === 'true';
}
function _appUsername() {
  return String(process.env.APP_AUTH_USERNAME || 'monish').trim().toLowerCase();
}
function _appPassword() {
  return process.env.APP_AUTH_PASSWORD || 'Chennaisuper.23';
}
function _ttlDays() {
  const n = parseInt(process.env.APP_AUTH_TTL_DAYS || '45', 10);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

/** Length-aware constant-time string compare (no early-exit on mismatch). */
function constantTimeEqual(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** Validate submitted credentials against the configured single-user pair. */
function checkAppCredentials(username, password) {
  const u = String(username == null ? '' : username).trim().toLowerCase();
  const p = String(password == null ? '' : password);
  // Evaluate BOTH before combining so the result timing doesn't reveal which
  // field was wrong.
  const okUser = constantTimeEqual(u, _appUsername());
  const okPass = constantTimeEqual(p, _appPassword());
  return okUser && okPass;
}

/** Sign a short-scoped app token. Throws if JWT_SECRET is missing. */
function makeAppToken() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return jwt.sign({ scope: 'app' }, secret, { expiresIn: `${_ttlDays()}d` });
}

/** Verify a token; throws on invalid/expired (jsonwebtoken semantics). */
function verifyAppToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function _bearer(req) {
  const h = req && req.headers && req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t.length > 0 ? t : null;
}

/**
 * Express middleware gating a router. When enforcement is OFF it always calls
 * next() (still attaching req.appAuth if a valid token happens to be present).
 * When ON it requires a valid Bearer JWT, else 401.
 */
function requireApp(req, res, next) {
  const enforce = isAppAuthRequired();
  const token = _bearer(req);
  if (token) {
    try {
      req.appAuth = verifyAppToken(token);
    } catch {
      if (enforce) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      // Not enforcing → ignore a bad token rather than blocking the request.
    }
  } else if (enforce) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
}

const _clip = (v, n) => String(v == null ? '' : v).slice(0, n);

/**
 * Normalize + size-cap a browser client-log payload into a Telegram-ready line.
 * All fields are clipped so a malicious/huge payload can never flood Telegram.
 */
function buildClientLog(body) {
  const b = body && typeof body === 'object' ? body : {};
  const levelRaw = _clip(b.level, 12).toLowerCase();
  const level = ['info', 'warn', 'warning', 'error'].includes(levelRaw)
    ? levelRaw
    : 'error';
  const message = _clip(b.message, 600).trim();
  const context = _clip(b.context, 120).trim();
  const url = _clip(b.url, 300).trim();
  const userAgent = _clip(b.userAgent, 200).trim();
  const stack = _clip(b.stack, 900).trim();

  const tag = `WEB${context ? ':' + context : ''}`;
  const parts = [];
  if (message) parts.push(message);
  if (url) parts.push(`@ ${url}`);
  if (userAgent) parts.push(userAgent);
  if (stack) parts.push(stack);
  return { level, tag, message, line: parts.join('\n') };
}

module.exports = {
  constantTimeEqual,
  checkAppCredentials,
  makeAppToken,
  verifyAppToken,
  requireApp,
  isAppAuthRequired,
  buildClientLog,
};
