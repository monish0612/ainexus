'use strict';

// ═══════════════════════════════════════════════════════════════
//  GEMINI DIRECT — talk to Google Gemini's REST API straight
//
//  Why this exists
//  ───────────────
//  The app no longer relies on the LiteLLM proxy as the single
//  gateway for Gemini calls. The proxy's `model_list` enumerates
//  only the *exact* Gemini ids it knows — every time Google ships
//  a new Flash / Lite / Pro generation, or even a "preview" -> GA
//  rename, the proxy returns "model not found" for the new id and
//  every downstream feature (news summaries, rephrase, coach,
//  dictionary, smart-parse, …) silently degrades.
//
//  This module bypasses the proxy entirely for Gemini ids. Whatever
//  bare model name the user types into Settings is forwarded to
//  `generativelanguage.googleapis.com/v1beta/models/<id>:generateContent`
//  using GOOGLE_API_KEY. Google's API is the source of truth: a
//  brand-new model the day it launches works without redeploying
//  the proxy config.
//
//  What this module does NOT do
//  ────────────────────────────
//  • No grounded-search (that's `google-grounding.js` — it uses the
//    same REST API but with the `google_search` tool enabled and
//    parses `groundingMetadata` for citations).
//  • No xGrok / Groq / non-Google providers — see `xgrok.js` and
//    the LiteLLM fallback path in `index.js`.
//  • No multi-turn conversation memory — the caller is expected to
//    pass the full message history in OpenAI chat format
//    (`{role, content}[]`).
//
//  Error contract
//  ──────────────
//  Every failure throws a [GeminiDirectError] whose `code` is one
//  of the constants in `ERROR_CODES`. Route handlers map the code
//  to an HTTP status (`mapErrorToHttp`) and surface a user-facing
//  message; the Flutter toast layer pulls the message out of the
//  error envelope and shows it verbatim. This is what makes
//  "model not found" diagnosable end-to-end instead of degrading
//  into a generic "Rephrase failed" toast.
// ═══════════════════════════════════════════════════════════════

const { tg } = require('./telegram');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2; // total attempts = MAX_RETRIES + 1
const MODEL_LIST_TTL_MS = 5 * 60_000; // 5 min cache for /models discovery

// ── Typed error class (HTTP-status-aware) ──────────────────────

const ERROR_CODES = Object.freeze({
  CONFIG: 'CONFIG', // GOOGLE_API_KEY missing
  INVALID_MODEL: 'INVALID_MODEL', // empty / non-string model id
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND', // Google returned 404 for this model
  RATE_LIMIT: 'RATE_LIMIT', // 429
  BLOCKED: 'BLOCKED', // safety filter
  EMPTY: 'EMPTY', // 200 OK but no candidate text
  API: 'API', // 4xx other than the above
  SERVER: 'SERVER', // 5xx from Google
  TIMEOUT: 'TIMEOUT', // AbortSignal.timeout fired
  NETWORK: 'NETWORK', // fetch threw (DNS, connection reset, …)
});

class GeminiDirectError extends Error {
  constructor(message, code = ERROR_CODES.API, status = 500, model = null) {
    super(message);
    this.name = 'GeminiDirectError';
    this.code = code;
    this.status = status;
    this.model = model;
  }
}

function mapErrorToHttp(err) {
  if (!(err instanceof GeminiDirectError)) return 500;
  switch (err.code) {
    case ERROR_CODES.CONFIG:
      return 503;
    case ERROR_CODES.INVALID_MODEL:
      return 400;
    case ERROR_CODES.MODEL_NOT_FOUND:
      return 404;
    case ERROR_CODES.RATE_LIMIT:
      return 429;
    case ERROR_CODES.BLOCKED:
      return 400;
    case ERROR_CODES.EMPTY:
      return 502;
    case ERROR_CODES.TIMEOUT:
      return 504;
    case ERROR_CODES.NETWORK:
      return 502;
    case ERROR_CODES.SERVER:
      return err.status || 502;
    case ERROR_CODES.API:
    default:
      return err.status || 502;
  }
}

// ── Model id helpers ───────────────────────────────────────────

/** Strip a leading `gemini/` so we can route via Google's REST API. */
function stripGeminiPrefix(id) {
  if (typeof id !== 'string') return '';
  return id.trim().replace(/^gemini\//i, '');
}

/**
 * Cheap heuristic — is this model id one we can route through the
 * direct Google REST API? Accepts:
 *   • "gemini/gemini-3.1-flash-lite-preview"
 *   • "gemini-3.1-flash-lite"
 *   • "models/gemini-2.5-flash"
 *   • Anything starting with "gemini-"
 * Rejects:
 *   • "groq/llama-3.3-70b-versatile"
 *   • "grok-4-0709"
 *   • Empty / non-string
 */
function isGeminiModel(id) {
  if (typeof id !== 'string') return false;
  const t = id.trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith('groq/') || t.startsWith('grok')) return false;
  return t.startsWith('gemini') || t.startsWith('models/gemini');
}

/** Normalise to the bare id Google expects in the URL path. */
function normaliseModelId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().replace(/^models\//i, '').replace(/^gemini\//i, '');
}

// ── OpenAI <-> Gemini message conversion ───────────────────────

/**
 * Convert OpenAI-style messages (`{role, content}[]` where content is
 * a string or a parts array) into Gemini's `{systemInstruction,
 * contents}` request body. Multimodal content arrays are forwarded
 * verbatim under each part's `inline_data` / `text` slot.
 *
 * Behaviour:
 *   • All consecutive `system` messages are concatenated into a
 *     single `systemInstruction` block (Gemini only honours one).
 *   • `assistant` -> `model` (Gemini's name for the assistant role).
 *   • `user` stays as `user`.
 *   • Unknown roles are dropped with a warning so we never silently
 *     send malformed bodies to Google.
 */
async function _convertMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new GeminiDirectError(
      'messages must be an array',
      ERROR_CODES.INVALID_MODEL,
      400,
    );
  }

  const systemParts = [];
  const contents = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '').toLowerCase();
    const rawContent = msg.content;

    const parts = await _contentToParts(rawContent);
    if (parts.length === 0) continue;

    if (role === 'system') {
      // Gemini wants plain text in systemInstruction. Strip any
      // inline_data parts (rare for system) so we don't 400.
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) systemParts.push(p.text);
      }
      continue;
    }

    const geminiRole = role === 'assistant' || role === 'model' ? 'model' : 'user';
    contents.push({ role: geminiRole, parts });
  }

  // Gemini requires at least one user-role content; if the caller
  // only sent a system message (some pre-flight checks do this) we
  // synthesise a minimal user prompt so the request is well-formed.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  }

  const body = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  return body;
}

// Cap remote-image fetches at 10 MB to defend the server from a
// malicious / oversized image URL. Gemini also rejects payloads
// larger than this in practice.
const _MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

async function _fetchImageAsInlineData(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
      // Some news CDNs serve a different MIME type to non-browsers — fake
      // a sane UA + Accept so we get the binary image we asked for.
      headers: {
        'User-Agent': 'Mozilla/5.0 (NexusAI)',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!res.ok) {
      console.warn(`[GeminiDirect] Image fetch failed (${res.status}) ${url.slice(0, 80)} — dropping image`);
      return null;
    }
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > _MAX_INLINE_IMAGE_BYTES) {
      console.warn(`[GeminiDirect] Image too large (${contentLength}b) ${url.slice(0, 80)} — dropping`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > _MAX_INLINE_IMAGE_BYTES) {
      console.warn(`[GeminiDirect] Image too large after download (${buf.length}b) — dropping`);
      return null;
    }
    let mimeType = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(mimeType)) {
      // Some CDNs reply with octet-stream; sniff from the URL extension.
      const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
      const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
      mimeType = map[ext] || 'image/jpeg';
    }
    return { mime_type: mimeType, data: buf.toString('base64') };
  } catch (e) {
    console.warn(`[GeminiDirect] Image fetch error ${url.slice(0, 80)}: ${String(e?.message || e).slice(0, 100)}`);
    return null;
  }
}

async function _contentToParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? [{ text: content }] : [];
  }
  if (Array.isArray(content)) {
    const out = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        out.push({ text: item.text });
        continue;
      }
      if (item.type === 'image_url' && item.image_url?.url) {
        const dataUrl = String(item.image_url.url);
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          out.push({ inline_data: { mime_type: match[1], data: match[2] } });
          continue;
        }
        // Remote image URL — Gemini's REST API only takes base64 inline
        // data for arbitrary HTTP image sources, so we fetch it
        // server-side here. Bounded download (8s timeout, 10 MB cap)
        // so a slow / huge image can't stall the request.
        const inlineData = await _fetchImageAsInlineData(dataUrl);
        if (inlineData) {
          out.push({ inline_data: inlineData });
        }
        // If fetch failed we silently drop the image part — the text
        // path still runs, and the news pipeline's text-only fallback
        // covers the multimodal failure case.
        continue;
      }
      if (item.inline_data?.data) {
        out.push({ inline_data: item.inline_data });
      }
    }
    return out;
  }
  return [];
}

// ── Single-shot call ───────────────────────────────────────────

// Detects a missing OR unsubstituted env placeholder (e.g. when
// `backend/.env` has `GOOGLE_API_KEY=${GOOGLE_API_KEY}` and the
// shell never expanded it — a real-world deploy gotcha on bare
// `node` startup vs. `docker-compose up` where the substitution
// happens at runtime). Both shapes produce the same user-facing
// CONFIG error, so the toast layer can say "Server isn't configured
// for Gemini yet" instead of "API key not valid".
function _readGoogleApiKey() {
  const raw = process.env.GOOGLE_API_KEY;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Common "env-var not expanded" sentinels.
  if (trimmed.startsWith('${') || trimmed === '<unset>' || trimmed === 'null') return null;
  // Real Google API keys are 39+ chars and start with `AIza`. We
  // accept anything ≥ 30 chars to allow for future formats while
  // still catching obvious mistakes.
  if (trimmed.length < 30) return null;
  return trimmed;
}

async function _callGeminiOnce({ modelId, body, timeoutMs }) {
  const apiKey = _readGoogleApiKey();
  if (!apiKey) {
    throw new GeminiDirectError(
      'GOOGLE_API_KEY is not configured on the server. Set it in backend/.env and restart.',
      ERROR_CODES.CONFIG,
      503,
      modelId,
    );
  }

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(modelId)}:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.name === 'TimeoutError' || /aborted|timeout/i.test(msg)) {
      throw new GeminiDirectError(
        `Gemini request timed out after ${timeoutMs}ms`,
        ERROR_CODES.TIMEOUT,
        504,
        modelId,
      );
    }
    throw new GeminiDirectError(
      `Network error talking to Gemini: ${msg.slice(0, 200)}`,
      ERROR_CODES.NETWORK,
      502,
      modelId,
    );
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new GeminiDirectError(
      `Gemini returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
      ERROR_CODES.API,
      response.status,
      modelId,
    );
  }

  if (!response.ok) {
    // Google's error body shape:
    //   { error: { code, message, status, details: [...] } }
    const errObj = data?.error || {};
    const status = response.status;
    const apiMsg = String(errObj.message || text || '').slice(0, 400);

    if (status === 404 || /not\s*found|unsupported|not\s*available/i.test(apiMsg)) {
      throw new GeminiDirectError(
        `Gemini model "${modelId}" not found or not enabled on your API key. Open Settings → Gemini Lite model and pick one that exists in https://ai.google.dev/gemini-api/docs/models. (Google said: ${apiMsg})`,
        ERROR_CODES.MODEL_NOT_FOUND,
        404,
        modelId,
      );
    }
    if (status === 429) {
      throw new GeminiDirectError(
        `Gemini is rate-limiting requests for ${modelId}. Try again in a moment.`,
        ERROR_CODES.RATE_LIMIT,
        429,
        modelId,
      );
    }
    if (status >= 500) {
      throw new GeminiDirectError(
        `Gemini server error ${status}: ${apiMsg}`,
        ERROR_CODES.SERVER,
        status,
        modelId,
      );
    }
    throw new GeminiDirectError(
      `Gemini ${status} for ${modelId}: ${apiMsg}`,
      ERROR_CODES.API,
      status,
      modelId,
    );
  }

  return data;
}

function _parseGeminiResponse(data, modelId) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new GeminiDirectError(
        `Gemini blocked this request: ${blockReason}`,
        ERROR_CODES.BLOCKED,
        400,
        modelId,
      );
    }
    throw new GeminiDirectError(
      'Gemini returned no candidates (empty response). Try a different model.',
      ERROR_CODES.EMPTY,
      502,
      modelId,
    );
  }

  // Gemini sometimes blocks mid-response and reports the reason via
  // finishReason; surface it so the caller can decide whether to retry.
  const finishReason = candidate.finishReason;
  const text = (candidate.content?.parts || [])
    .map((p) => p.text)
    .filter((s) => typeof s === 'string')
    .join('');

  if (!text && finishReason && finishReason !== 'STOP') {
    throw new GeminiDirectError(
      `Gemini stopped without producing text (finishReason=${finishReason})`,
      finishReason === 'SAFETY' ? ERROR_CODES.BLOCKED : ERROR_CODES.EMPTY,
      finishReason === 'SAFETY' ? 400 : 502,
      modelId,
    );
  }

  return {
    content: text,
    model_used: modelId,
    finish_reason: finishReason || null,
    usage: _normaliseUsage(data?.usageMetadata),
  };
}

function _normaliseUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    prompt_tokens: meta.promptTokenCount ?? null,
    completion_tokens: meta.candidatesTokenCount ?? null,
    total_tokens: meta.totalTokenCount ?? null,
  };
}

// ── Retry decision ─────────────────────────────────────────────

function _isRetryable(err) {
  if (!(err instanceof GeminiDirectError)) return false;
  return (
    err.code === ERROR_CODES.RATE_LIMIT ||
    err.code === ERROR_CODES.SERVER ||
    err.code === ERROR_CODES.TIMEOUT ||
    err.code === ERROR_CODES.NETWORK
  );
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Run a chat completion through Gemini's REST API.
 *
 * @param {object} opts
 * @param {string} opts.model              - Bare Gemini model id ("gemini-3.1-flash-lite-preview")
 * @param {Array}  opts.messages           - OpenAI-style messages
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=2048]
 * @param {boolean} [opts.jsonOutput=false]- Force JSON mime type
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{content:string, model_used:string, usage:object|null}>}
 */
async function geminiComplete({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 2048,
  jsonOutput = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!model || typeof model !== 'string' || !model.trim()) {
    throw new GeminiDirectError(
      'A Gemini model id is required (set it in Settings → Gemini Lite model).',
      ERROR_CODES.INVALID_MODEL,
      400,
    );
  }

  const modelId = normaliseModelId(model);
  const baseBody = await _convertMessages(messages);
  baseBody.generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
    ...(jsonOutput ? { responseMimeType: 'application/json' } : {}),
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        tg.w('GeminiDirect', `Retry ${attempt}/${MAX_RETRIES} model=${modelId} in ${delay}ms (${lastError?.code || 'unknown'})`);
        await new Promise((r) => setTimeout(r, delay));
      }
      const t0 = Date.now();
      const raw = await _callGeminiOnce({ modelId, body: baseBody, timeoutMs });
      const parsed = _parseGeminiResponse(raw, modelId);
      tg.d('GeminiDirect', `✓ ${modelId} ${Date.now() - t0}ms tokens=${parsed.usage?.total_tokens || '?'}`);
      return parsed;
    } catch (e) {
      lastError = e instanceof GeminiDirectError
        ? e
        : new GeminiDirectError(String(e?.message || e), ERROR_CODES.NETWORK, 502, modelId);
      if (!_isRetryable(lastError) || attempt >= MAX_RETRIES) break;
    }
  }
  throw lastError;
}

// ── Dynamic model discovery (cached) ───────────────────────────

let _modelListCache = { value: null, expiresAt: 0, lastError: null };

/**
 * Fetch the list of Gemini models the configured GOOGLE_API_KEY can
 * actually invoke. Cached for [MODEL_LIST_TTL_MS]. Returns
 * `{models: string[], primary: string|null, cachedAt: ISO}`.
 *
 * Filters out:
 *   • embedding-only models (`embedding-*`, `text-embedding-*`)
 *   • models that don't list `generateContent` in supportedGenerationMethods
 *
 * The result is used to:
 *   • Populate the Settings dropdown so the user picks from a known
 *     working list (instead of typing a bad id).
 *   • Power the server's "is this model id valid?" pre-check before
 *     burning a full retry budget on a 404.
 */
async function listAvailableModels({ force = false } = {}) {
  const now = Date.now();
  if (!force && _modelListCache.value && _modelListCache.expiresAt > now) {
    return _modelListCache.value;
  }

  const apiKey = _readGoogleApiKey();
  if (!apiKey) {
    const err = new GeminiDirectError(
      'GOOGLE_API_KEY is not configured on the server. Set it in backend/.env and restart.',
      ERROR_CODES.CONFIG,
      503,
    );
    _modelListCache.lastError = err.message;
    throw err;
  }

  const url = `${GEMINI_API_BASE}/models?key=${apiKey}&pageSize=100`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GeminiDirectError(
        `Failed to list Gemini models (${res.status}): ${text.slice(0, 200)}`,
        res.status === 429 ? ERROR_CODES.RATE_LIMIT : ERROR_CODES.API,
        res.status,
      );
    }
    const data = await res.json();
    const all = Array.isArray(data?.models) ? data.models : [];

    // Filter to generateContent-capable text/multimodal models. The
    // raw list includes embedders, fine-tuning targets, and TTS-only
    // variants that are useless for our chat workflow.
    const filtered = all
      .filter((m) => {
        const name = String(m?.name || '').replace(/^models\//, '');
        const methods = m?.supportedGenerationMethods || [];
        if (!name) return false;
        if (/embedding|tts|imagen|veo|aqa/i.test(name)) return false;
        return methods.includes('generateContent');
      })
      .map((m) => ({
        id: String(m.name).replace(/^models\//, ''),
        displayName: m.displayName || '',
        description: m.description || '',
        inputTokenLimit: m.inputTokenLimit || null,
        outputTokenLimit: m.outputTokenLimit || null,
      }));

    // Sort: prefer non-experimental, then newer versions first.
    filtered.sort((a, b) => {
      const expA = /(\bexperimental\b|-exp(?:-|$))/i.test(a.id) ? 1 : 0;
      const expB = /(\bexperimental\b|-exp(?:-|$))/i.test(b.id) ? 1 : 0;
      if (expA !== expB) return expA - expB;
      const verA = parseFloat((a.id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      const verB = parseFloat((b.id.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      return verB - verA;
    });

    // Pick a sensible primary: first non-experimental flash/lite.
    const primary =
      filtered.find((m) => /flash/i.test(m.id) && !/pro/i.test(m.id))?.id
      || filtered[0]?.id
      || null;

    const value = {
      models: filtered,
      primary,
      cachedAt: new Date().toISOString(),
    };
    _modelListCache = { value, expiresAt: now + MODEL_LIST_TTL_MS, lastError: null };
    return value;
  } catch (e) {
    _modelListCache.lastError = String(e?.message || e);
    if (e instanceof GeminiDirectError) throw e;
    throw new GeminiDirectError(
      `Could not list Gemini models: ${String(e?.message || e).slice(0, 200)}`,
      ERROR_CODES.NETWORK,
      502,
    );
  }
}

/** Quick check used by the route layer to give a faster 404 with a
 *  better message when the user mistypes a model id. Returns true if
 *  the model is in our cached list OR if discovery hasn't happened
 *  yet (in which case we fall through to a real call and let Google
 *  decide). */
function isModelKnown(id) {
  if (!_modelListCache.value) return true; // unknown — don't block
  const normalised = normaliseModelId(id);
  return _modelListCache.value.models.some((m) => m.id === normalised);
}

module.exports = {
  geminiComplete,
  listAvailableModels,
  isModelKnown,
  isGeminiModel,
  stripGeminiPrefix,
  normaliseModelId,
  GeminiDirectError,
  ERROR_CODES,
  mapErrorToHttp,
};
