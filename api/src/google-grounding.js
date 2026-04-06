'use strict';

// ═══════════════════════════════════════════════════════════════
//  GOOGLE SEARCH GROUNDING — Gemini REST API (zero dependencies)
//
//  Calls Gemini directly with the `google_search` tool enabled.
//  Returns structured results with text, sources, and citations.
//
//  Uses native fetch — no @google/genai SDK needed.
// ═══════════════════════════════════════════════════════════════

const { tg } = require('./telegram');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GROUNDING_MODELS = (process.env.GROUNDING_MODELS || '')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

if (GROUNDING_MODELS.length === 0) {
  console.warn('[Grounding] ⚠️  GROUNDING_MODELS env var not set — grounding endpoints will fail until configured');
}

const DEFAULTS = {
  temperature: 1.0,
  maxOutputTokens: 4096,
  timeoutMs: 30000,
};

// ── Helpers ────────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new GroundingError('GOOGLE_API_KEY not configured', 'CONFIG');
  return key;
}

function pickModel(preferred) {
  if (preferred) return preferred;
  return GROUNDING_MODELS[0];
}

class GroundingError extends Error {
  constructor(message, code = 'UNKNOWN', status = 500) {
    super(message);
    this.name = 'GroundingError';
    this.code = code;
    this.status = status;
  }
}

function parseGroundingResponse(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new GroundingError(`Blocked by safety: ${blockReason}`, 'BLOCKED', 400);
    }
    throw new GroundingError('No candidates in Gemini response', 'EMPTY', 502);
  }

  const text = (candidate.content?.parts || [])
    .map(p => p.text)
    .filter(Boolean)
    .join('');

  const meta = candidate.groundingMetadata || {};

  const sources = (meta.groundingChunks || []).map((c, i) => ({
    index: i,
    title: c.web?.title || '',
    url: c.web?.uri || '',
  }));

  const citations = (meta.groundingSupports || []).map(s => ({
    text: s.segment?.text || '',
    startIndex: s.segment?.startIndex ?? 0,
    endIndex: s.segment?.endIndex ?? 0,
    sourceIndices: s.groundingChunkIndices || [],
  }));

  return {
    text,
    searchQueries: meta.webSearchQueries || [],
    sources,
    citations,
    usage: data.usageMetadata || null,
  };
}

// ── Core: Single grounded call ─────────────────────────────────

async function _groundedCallOnce(modelId, body, timeoutMs) {
  const apiKey = getApiKey();
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errText = await response.text();
    const status = response.status;

    if (status === 429) {
      throw new GroundingError(`Rate limited on ${modelId}`, 'RATE_LIMIT', 429);
    }
    if (status >= 500) {
      throw new GroundingError(`Gemini server error ${status}: ${errText.slice(0, 200)}`, 'SERVER', status);
    }
    throw new GroundingError(`Gemini ${status} [${modelId}]: ${errText.slice(0, 300)}`, 'API', status);
  }

  return response.json();
}

// ── Core: Grounded call with model fallback ────────────────────

async function groundedGenerate({
  prompt,
  systemInstruction,
  model,
  temperature,
  maxOutputTokens,
  timeoutMs,
}) {
  const models = model ? [model] : [...GROUNDING_MODELS];
  const temp = temperature ?? DEFAULTS.temperature;
  const maxTok = maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const timeout = timeoutMs ?? DEFAULTS.timeoutMs;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: temp,
      maxOutputTokens: maxTok,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  let lastError;
  for (const m of models) {
    try {
      const data = await _groundedCallOnce(m, body, timeout);
      const result = parseGroundingResponse(data);
      return { ...result, model: m };
    } catch (e) {
      lastError = e;
      if (models.length > 1) {
        console.warn(`[Grounding] ${m} failed, trying next... (${e.message.slice(0, 120)})`);
        tg.w('Grounding', `${m} failed, falling back`, e);
      }
    }
  }

  tg.e('Grounding', `All models exhausted: ${models.join(', ')}`, lastError);
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Grounded web search — ask anything, get real-time answers with sources.
 *
 * @param {string} query - The user's search query
 * @param {object} [options]
 * @param {string} [options.model] - Override Gemini model
 * @param {number} [options.temperature=1.0]
 * @param {number} [options.maxTokens=4096]
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<GroundedSearchResult>}
 */
async function groundedSearch(query, options = {}) {
  const t0 = Date.now();
  const modelHint = options.model || GROUNDING_MODELS[0] || 'default';
  console.log(`[Grounding] Search → model=${modelHint}, q="${query.slice(0, 80)}"`);
  tg.d('GroundedSearch', `model=${modelHint} q="${query.slice(0, 80)}"`);

  const result = await groundedGenerate({
    prompt: query,
    systemInstruction:
      'You are a helpful research assistant. Answer the user\'s question using the Google Search tool. ' +
      'Provide a comprehensive, well-structured answer. Use bullet points for lists. ' +
      'Always cite your sources inline.',
    model: options.model,
    temperature: options.temperature,
    maxOutputTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
  });

  const elapsed = Date.now() - t0;
  console.log(`[Grounding] Done in ${elapsed}ms — model=${result.model}, ${result.sources.length} sources`);
  tg.i('GroundedSearch', `✓ model=${result.model} ${elapsed}ms, ${result.sources.length} sources`);

  return result;
}

/**
 * Grounded content extraction — fetch real-time info about a URL/topic
 * when direct fetch and Zyte fail. Parallel alternative to Tavily.
 *
 * @param {string} url - The URL or topic to research
 * @param {string} [title] - Optional page title for context
 * @param {object} [options]
 * @returns {Promise<{content: string, extractionMethod: string, sources: Array}>}
 */
async function groundedExtract(url, title, options = {}) {
  const t0 = Date.now();
  const modelHint = options.model || GROUNDING_MODELS[0] || 'default';
  const query = title
    ? `Provide the full detailed content and key information from this article: "${title}" (${url})`
    : `Retrieve and summarize the full content from this URL: ${url}`;

  console.log(`[Grounding] Extract → model=${modelHint}, url="${url.slice(0, 80)}"`);
  tg.d('GroundedExtract', `model=${modelHint} url="${url.slice(0, 80)}"`);

  try {
    const result = await groundedGenerate({
      prompt: query,
      systemInstruction:
        'You are a content extraction assistant. Given a URL, use Google Search to find the article content. ' +
        'Return the FULL article text as faithfully as possible. Include all key details, quotes, and data points. ' +
        'Do NOT summarize — extract as much content as you can find.',
      model: options.model,
      temperature: 0.3,
      maxOutputTokens: options.maxTokens ?? 8192,
      timeoutMs: options.timeoutMs ?? 25000,
    });

    const elapsed = Date.now() - t0;
    console.log(`[Grounding] Extract done in ${elapsed}ms — model=${result.model}, ${result.text.length} chars`);
    tg.i('GroundedExtract', `✓ model=${result.model} ${elapsed}ms, ${result.text.length} chars`);

    return {
      content: result.text,
      extractionMethod: 'gemini-grounding',
      sources: result.sources,
    };
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.warn(`[Grounding] Extract failed in ${elapsed}ms: ${e.message.slice(0, 150)}`);
    tg.w('GroundedExtract', `Failed model=${modelHint} ${elapsed}ms`, e);
    return { content: '', extractionMethod: 'none', sources: [] };
  }
}

/**
 * Multi-turn grounded conversation — for article follow-up Q&A.
 *
 * Ultra-robust: tries the primary model with aggressive retries, then
 * falls back to every other GROUNDING_MODEL. Each model gets 3 attempts
 * with exponential backoff. Transient errors (429, 500+, network) trigger
 * retry; permanent errors (400, 403) skip to next model immediately.
 *
 * @param {Array<{role: string, text: string}>} history
 * @param {string} systemInstruction
 * @param {object} [options]
 * @returns {Promise<{text: string, model: string, sources: Array, searchQueries: Array}>}
 */
async function groundedConverse(history, systemInstruction, options = {}) {
  const primaryModel = options.model
    || process.env.GEMINI_PRO_MODEL
    || GROUNDING_MODELS[0];
  const fallbackModels = GROUNDING_MODELS.filter(m => m !== primaryModel);
  const allModels = [primaryModel, ...fallbackModels].filter(Boolean);

  if (allModels.length === 0) {
    throw new GroundingError('No grounding models configured', 'CONFIG', 0);
  }

  const timeout = options.timeoutMs ?? 60000;
  const maxTok = options.maxTokens ?? 8192;
  const temp = options.temperature ?? 0.7;
  const RETRIES_PER_MODEL = 3;

  const apiKey = getApiKey();

  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.text }],
  }));

  const body = {
    contents,
    tools: [{ google_search: {} }],
    generationConfig: { temperature: temp, maxOutputTokens: maxTok },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const t0 = Date.now();
  console.log(`[Grounding] Converse → models=[${allModels.join(',')}], ${history.length} turns`);
  tg.d('GroundedConverse', `models=[${allModels.join(',')}], ${history.length} turns`);

  let lastError;

  for (let mi = 0; mi < allModels.length; mi++) {
    const modelId = allModels[mi];
    const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(800 * Math.pow(2, attempt - 1), 4000);
          console.log(`[Grounding] Converse retry ${attempt + 1}/${RETRIES_PER_MODEL} model=${modelId} in ${delay}ms`);
          tg.w('GroundedConverse', `Retry ${attempt + 1}/${RETRIES_PER_MODEL} model=${modelId}`, lastError);
          await new Promise(r => setTimeout(r, delay));
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          const errText = await response.text();
          const status = response.status;
          const isRetryable = status === 429 || status >= 500;

          lastError = new GroundingError(
            `Gemini ${status} [${modelId}]: ${errText.slice(0, 300)}`,
            status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'API',
            status,
          );

          if (isRetryable && attempt < RETRIES_PER_MODEL - 1) continue;
          break; // non-retryable or retries exhausted → next model
        }

        const data = await response.json();
        const result = parseGroundingResponse(data);
        const elapsed = Date.now() - t0;
        const retryNote = (mi > 0 || attempt > 0)
          ? ` (model ${mi + 1}/${allModels.length}, attempt ${attempt + 1})`
          : '';
        console.log(`[Grounding] Converse done in ${elapsed}ms — model=${modelId}, ${result.sources.length} sources${retryNote}`);
        tg.i('GroundedConverse', `✓ model=${modelId} ${elapsed}ms, ${result.sources.length} sources${retryNote}`);

        return { ...result, model: modelId };
      } catch (e) {
        if (e.name === 'GroundingError') {
          lastError = e;
          break; // already handled above, skip to next model
        }
        lastError = e;
        const isNetwork = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(e.message);
        if (!isNetwork || attempt >= RETRIES_PER_MODEL - 1) break;
      }
    }

    if (allModels.length > 1) {
      console.warn(`[Grounding] ${modelId} exhausted, ${mi < allModels.length - 1 ? `trying ${allModels[mi + 1]}` : 'no more models'}`);
      tg.w('GroundedConverse', `${modelId} exhausted${mi < allModels.length - 1 ? `, trying ${allModels[mi + 1]}` : ''}`, lastError);
    }
  }

  const elapsed = Date.now() - t0;
  tg.e('GroundedConverse', `All ${allModels.length} models × ${RETRIES_PER_MODEL} retries exhausted in ${elapsed}ms: [${allModels.join(',')}]`, lastError);
  if (lastError?.name === 'GroundingError') throw lastError;
  throw new GroundingError(
    `All grounding models exhausted [${allModels.join(',')}]: ${(lastError?.message || 'unknown').slice(0, 200)}`,
    'EXHAUSTED',
    0,
  );
}

/**
 * Check if Google Search Grounding is available (key configured).
 */
function isGroundingAvailable() {
  return Boolean(process.env.GOOGLE_API_KEY);
}

/**
 * Resolve a UI mode ("lite" / "deep") to the actual Gemini model.
 * Flutter sends mode instead of a model name so nothing is hardcoded client-side.
 *
 * @param {string|undefined} mode   - "lite" or "deep" (default)
 * @param {string|undefined} deepModel - client-configured deep model (from app settings)
 * @returns {string|undefined} model ID or undefined (let groundedConverse pick its default)
 */
function resolveGroundingMode(mode, deepModel) {
  if (mode === 'lite' && GROUNDING_MODELS.length > 0) return GROUNDING_MODELS[0];
  if (deepModel) return deepModel;
  return undefined;
}

/**
 * Return the current grounding model config (for /api/v1/llm/config).
 */
function getGroundingConfig() {
  return {
    liteModel: GROUNDING_MODELS[0] || null,
    proModel: process.env.GEMINI_PRO_MODEL || GROUNDING_MODELS[0] || null,
    allGroundingModels: [...GROUNDING_MODELS],
  };
}

module.exports = {
  groundedSearch,
  groundedExtract,
  groundedGenerate,
  groundedConverse,
  isGroundingAvailable,
  resolveGroundingMode,
  getGroundingConfig,
  GroundingError,
};
