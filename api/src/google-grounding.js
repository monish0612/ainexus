'use strict';

// ═══════════════════════════════════════════════════════════════
//  GOOGLE SEARCH GROUNDING — Gemini REST API (zero dependencies)
//
//  Calls Gemini directly with the `google_search` tool enabled.
//  Returns structured results with text, sources, and citations.
//
//  Uses native fetch — no @google/genai SDK needed.
// ═══════════════════════════════════════════════════════════════

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GROUNDING_MODELS = (process.env.GROUNDING_MODELS || 'gemini-3.1-flash-lite-preview')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

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
      }
    }
  }

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
  console.log('[Grounding] Search →', query.slice(0, 100));

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
  console.log(`[Grounding] Done in ${elapsed}ms — ${result.sources.length} sources, ${result.searchQueries.length} queries`);

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
  const query = title
    ? `Provide the full detailed content and key information from this article: "${title}" (${url})`
    : `Retrieve and summarize the full content from this URL: ${url}`;

  console.log('[Grounding] Extract →', url);

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
    console.log(`[Grounding] Extract done in ${elapsed}ms — ${result.text.length} chars`);

    return {
      content: result.text,
      extractionMethod: 'gemini-grounding',
      sources: result.sources,
    };
  } catch (e) {
    console.warn(`[Grounding] Extract failed: ${e.message.slice(0, 150)}`);
    return { content: '', extractionMethod: 'none', sources: [] };
  }
}

/**
 * Multi-turn grounded conversation — for article follow-up Q&A.
 *
 * @param {Array<{role: string, text: string}>} history - Conversation so far
 * @param {string} systemInstruction - System prompt with article context
 * @param {object} [options]
 * @returns {Promise<{text: string, model: string, sources: Array, searchQueries: Array}>}
 */
async function groundedConverse(history, systemInstruction, options = {}) {
  const modelId = options.model
    || process.env.GEMINI_PRO_MODEL
    || 'gemini-3.1-pro-preview';
  const timeout = options.timeoutMs ?? 60000;
  const maxTok = options.maxTokens ?? 8192;
  const temp = options.temperature ?? 0.7;

  const apiKey = getApiKey();
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;

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
  console.log(`[Grounding] Converse (${modelId}) → ${history.length} turns`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new GroundingError(
      `Gemini ${response.status} [${modelId}]: ${errText.slice(0, 300)}`,
      response.status >= 500 ? 'SERVER' : 'API',
      response.status,
    );
  }

  const data = await response.json();
  const result = parseGroundingResponse(data);
  const elapsed = Date.now() - t0;
  console.log(`[Grounding] Converse done in ${elapsed}ms — ${result.sources.length} sources`);

  return { ...result, model: modelId };
}

/**
 * Check if Google Search Grounding is available (key configured).
 */
function isGroundingAvailable() {
  return Boolean(process.env.GOOGLE_API_KEY);
}

module.exports = {
  groundedSearch,
  groundedExtract,
  groundedGenerate,
  groundedConverse,
  isGroundingAvailable,
  GroundingError,
};
