'use strict';

// Fire-and-forget client for the internal narration-orchestrator.
// Must never throw into news ingest, and must never touch LiteLLM/Gemini.

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { tg } = require('./telegram');

function baseUrl() {
  return String(process.env.NARRATION_ORCHESTRATOR_URL || '').replace(/\/$/, '');
}

function apiKey() {
  return process.env.NARRATION_API_KEY || '';
}

function enabled() {
  return baseUrl().length > 0;
}

async function postJson(path, body, { timeoutMs = 4000 } = {}) {
  const root = baseUrl();
  if (!root) return { skipped: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${root}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`orchestrator ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(path, { timeoutMs = 4000 } = {}) {
  const root = baseUrl();
  if (!root) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${root}${path}`, {
      headers: { 'X-API-Key': apiKey() },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`orchestrator ${res.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

const DEFAULT_NARRATION_MODEL = 'gemini-2.5-flash-lite';

async function narrationModel(pool) {
  if (!pool) return DEFAULT_NARRATION_MODEL;
  try {
    const r = await pool.query("SELECT value FROM user_preferences WHERE key = 'narration_model'");
    const value = String(r.rows[0]?.value || '').trim();
    if (/^gemini-[\w.]*flash/i.test(value)) return value;
  } catch { /* preference missing is fine */ }
  return DEFAULT_NARRATION_MODEL;
}

function enqueueFromIngest({ articleId, title, category, source, text, pool }) {
  if (!enabled()) return;
  const payload = {
    article_id: articleId,
    title: title || '',
    category: category || '',
    source: source || '',
    text: String(text || '').slice(0, 120000),
  };
  if (!payload.text.trim()) return;
  setImmediate(() => {
    narrationModel(pool).then((model) => postJson('/v1/jobs', { ...payload, model })).catch((err) => {
      tg.w('NARRATION/ingest', `enqueue failed ${articleId}: ${err.message}`.slice(0, 180));
    });
  });
}

async function ensureJob(payload) {
  if (!enabled()) return { status: 'fallback', reason: 'unconfigured' };
  // `force` lets a still-existing article recover from a leftover listen-complete
  // tombstone. Ingest enqueue must NOT set force — dropped ids stay dropped.
  return postJson('/v1/jobs', { ...payload, force: true }, { timeoutMs: 8000 });
}

async function jobStatus(articleId) {
  if (!enabled()) return { status: 'fallback', reason: 'unconfigured' };
  const rec = await getJson(`/v1/jobs/${encodeURIComponent(articleId)}`);
  return rec || { status: 'unknown' };
}

async function completeListen({ cacheKey, articleId }) {
  if (!enabled()) return { deleted: false, skipped: true };
  return postJson('/v1/complete', { cache_key: cacheKey, article_id: articleId });
}

function dropArticles(ids) {
  if (!enabled()) return;
  const unique = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!unique.length) return;
  setImmediate(() => {
    postJson('/v1/drop', { article_ids: unique }, { timeoutMs: 60000 }).catch((err) => {
      tg.w('NARRATION/drop', `drop failed ${unique.length} ids: ${err.message}`.slice(0, 180));
    });
  });
}

async function proxyAudio(req, res, cacheKey, { hd = false } = {}) {
  const root = baseUrl();
  if (!root) {
    res.status(503).json({ error: 'narration unconfigured' });
    return;
  }
  const url = `${root}/v1/audio/${encodeURIComponent(cacheKey)}.opus${hd ? '?hd=1' : ''}`;
  const headers = { 'X-API-Key': apiKey() };
  if (req.headers.range) headers.Range = req.headers.range;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const upstream = await fetch(url, { headers, signal: ctrl.signal });
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = upstream.headers.get(name);
      if (v) res.setHeader(name, v);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'narration audio proxy failed' });
    tg.w('NARRATION/audio', String(err.message || err).slice(0, 180));
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  enabled,
  narrationModel,
  enqueueFromIngest,
  ensureJob,
  jobStatus,
  completeListen,
  dropArticles,
  proxyAudio,
};
