'use strict';

// ═══════════════════════════════════════════════════════════════
//  xGROK — xAI Grok API client (Responses + Chat Completions)
//
//  Search/converse: /v1/responses (web_search + x_search tools)
//  Simple completions: /v1/chat/completions (no tools)
//
//  Endpoint: https://api.x.ai/v1
// ═══════════════════════════════════════════════════════════════

const { tg } = require('./telegram');

const XGROK_API_BASE = 'https://api.x.ai/v1';

const DEFAULTS = {
  temperature: 0.7,
  maxTokens: 8192,
  timeoutMs: 90_000,
};

const _MAX_RETRIES = 3;

class XGrokError extends Error {
  constructor(message, code = 'UNKNOWN', status = 500) {
    super(message);
    this.name = 'XGrokError';
    this.code = code;
    this.status = status;
  }
}

function getApiKey() {
  const key = process.env.XGROK_API_KEY;
  if (!key) throw new XGrokError('XGROK_API_KEY not configured', 'CONFIG', 503);
  return key;
}

function isXGrokAvailable() {
  return Boolean(process.env.XGROK_API_KEY);
}

function _isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function _isRetryableError(msg) {
  return /429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg);
}

// ═══════════════════════════════════════════════════════════════
//  CHAT COMPLETIONS — for simple completions (no tools)
// ═══════════════════════════════════════════════════════════════

async function _callCompletionOnce(model, messages, { temperature, maxTokens, timeoutMs }) {
  const apiKey = getApiKey();
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  const response = await fetch(`${XGROK_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    const status = response.status;
    throw new XGrokError(
      `xGrok ${status} [${model}]: ${text.slice(0, 300)}`,
      status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'API',
      status,
    );
  }

  const data = await response.json();
  return data;
}

// ═══════════════════════════════════════════════════════════════
//  RESPONSES API — for search-powered conversations
//  Uses /v1/responses with web_search and x_search tools
// ═══════════════════════════════════════════════════════════════

async function _callResponsesOnce(model, input, { temperature, maxTokens, tools, timeoutMs }) {
  const apiKey = getApiKey();
  const body = {
    model,
    input,
    temperature,
    max_output_tokens: maxTokens,
    store: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(`${XGROK_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    const status = response.status;
    throw new XGrokError(
      `xGrok ${status} [${model}]: ${text.slice(0, 300)}`,
      status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'API',
      status,
    );
  }

  return response.json();
}

function _parseResponsesResult(data, model) {
  const outputItems = data.output || [];
  let content = '';
  const sources = [];
  const searchQueries = [];

  for (const item of outputItems) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text') {
          content += c.text || '';
          if (Array.isArray(c.annotations)) {
            for (const ann of c.annotations) {
              if (ann.type === 'url_citation' && ann.url) {
                sources.push({
                  title: ann.title || '',
                  url: ann.url,
                });
              }
            }
          }
        }
      }
    }
  }

  const usage = data.usage || null;
  const toolDetails = usage?.server_side_tool_usage_details;
  if (toolDetails) {
    const webCalls = toolDetails.web_search_calls || 0;
    const xCalls = toolDetails.x_search_calls || 0;
    if (webCalls > 0) searchQueries.push(`web_search (${webCalls} calls)`);
    if (xCalls > 0) searchQueries.push(`x_search (${xCalls} calls)`);
  }

  if (!content) {
    throw new XGrokError('No content in xGrok Responses output', 'EMPTY', 502);
  }

  return {
    text: content,
    model: data.model || model,
    sources,
    searchQueries,
    usage,
  };
}

function _parseCompletionResult(data, model) {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new XGrokError('No choices in xGrok response', 'EMPTY', 502);
  }
  return {
    text: choice.message?.content || '',
    model: data.model || model,
    sources: [],
    searchQueries: [],
    usage: data.usage || null,
  };
}

// ── Generic retry wrapper ─────────────────────────────────────

async function _callWithRetry(callFn, model) {
  let lastError;
  for (let attempt = 0; attempt < _MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(800 * Math.pow(2, attempt - 1), 4000);
        await new Promise(r => setTimeout(r, delay));
      }
      return await callFn();
    } catch (e) {
      lastError = e;
      const retryable = e instanceof XGrokError
        ? _isRetryableStatus(e.status)
        : _isRetryableError(e.message);
      if (!retryable || attempt >= _MAX_RETRIES - 1) break;
      console.warn(`[xGrok] ${model} retry ${attempt + 1}/${_MAX_RETRIES}: ${e.message.slice(0, 100)}`);
      tg.w('xGrok', `Retry ${attempt + 1}/${_MAX_RETRIES} model=${model}`, e);
    }
  }
  tg.e('xGrok', `All ${_MAX_RETRIES} retries exhausted model=${model}`, lastError);
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * xGrok grounded search — single question with web_search tool.
 * Uses the Responses API for real-time web search.
 */
async function xgrokSearch(query, options = {}) {
  const t0 = Date.now();
  const model = options.model || process.env.XGROK_DEFAULT_MODEL || 'grok-4-1-fast-non-reasoning';
  console.log(`[xGrok] Search → model=${model}, q="${query.slice(0, 80)}"`);
  tg.d('xGrokSearch', `model=${model} q="${query.slice(0, 80)}"`);

  const input = [
    {
      role: 'system',
      content:
        'You are an expert researcher. Answer the user\'s question using real-time web search. ' +
        'Provide a comprehensive, well-structured answer with markdown formatting. Cite sources when possible.',
    },
    { role: 'user', content: query },
  ];

  const result = await _callWithRetry(async () => {
    const data = await _callResponsesOnce(model, input, {
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      temperature: options.temperature ?? DEFAULTS.temperature,
      maxTokens: options.maxTokens ?? DEFAULTS.maxTokens,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    });
    return _parseResponsesResult(data, model);
  }, model);

  const elapsed = Date.now() - t0;
  console.log(`[xGrok] Search done in ${elapsed}ms — model=${result.model}`);
  tg.i('xGrokSearch', `✓ model=${result.model} ${elapsed}ms, ${result.sources.length} sources`);
  return result;
}

/**
 * xGrok multi-turn conversation with web_search tool.
 * Uses the Responses API for grounded conversations.
 */
async function xgrokConverse(history, systemInstruction, options = {}) {
  const model = options.model || process.env.XGROK_DEFAULT_MODEL || 'grok-4-1-fast-non-reasoning';
  const timeout = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxTok = options.maxTokens ?? DEFAULTS.maxTokens;
  const temp = options.temperature ?? DEFAULTS.temperature;

  const t0 = Date.now();
  console.log(`[xGrok] Converse → model=${model}, ${history.length} turns`);
  tg.d('xGrokConverse', `model=${model}, ${history.length} turns`);

  const input = [];
  if (systemInstruction) {
    input.push({ role: 'system', content: systemInstruction });
  }
  for (const h of history) {
    input.push({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.text,
    });
  }

  const result = await _callWithRetry(async () => {
    const data = await _callResponsesOnce(model, input, {
      temperature: temp,
      maxTokens: maxTok,
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      timeoutMs: timeout,
    });
    return _parseResponsesResult(data, model);
  }, model);

  const elapsed = Date.now() - t0;
  console.log(`[xGrok] Converse done in ${elapsed}ms — model=${result.model}`);
  tg.i('xGrokConverse', `✓ model=${result.model} ${elapsed}ms, ${result.sources.length} sources`);

  return result;
}

/**
 * xGrok simple completion (no tools) — for summarization, rephrase, etc.
 * Uses Chat Completions API (faster, no web search overhead).
 */
async function xgrokComplete({
  model,
  messages,
  temperature = 0.3,
  maxTokens = 3000,
  timeoutMs = 60_000,
}) {
  const result = await _callWithRetry(async () => {
    const data = await _callCompletionOnce(model, messages, { temperature, maxTokens, timeoutMs });
    return _parseCompletionResult(data, model);
  }, model);

  return {
    content: result.text,
    model_used: result.model,
    usage: result.usage,
  };
}

/**
 * Resolve xGrok model for a given depth mode.
 *
 * @param {'lite'|'deep'|'thinking'|undefined} mode
 * @param {string|undefined} xgrokLiteModel - from app settings
 * @param {string|undefined} xgrokDeepModel - from app settings
 * @param {string|undefined} xgrokThinkingModel - from app settings
 * @returns {string}
 */
function resolveXGrokModel(mode, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel) {
  if (mode === 'lite') {
    return xgrokLiteModel || process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning';
  }
  if (mode === 'thinking') {
    return xgrokThinkingModel || process.env.XGROK_THINKING_MODEL || 'grok-4-1-fast-reasoning';
  }
  return xgrokDeepModel || process.env.XGROK_DEEP_MODEL || 'grok-4-0709';
}

function getXGrokConfig() {
  return {
    available: isXGrokAvailable(),
    liteModel: process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning',
    deepModel: process.env.XGROK_DEEP_MODEL || 'grok-4-0709',
    thinkingModel: process.env.XGROK_THINKING_MODEL || 'grok-4-1-fast-reasoning',
  };
}

module.exports = {
  callXGrok: xgrokComplete,
  xgrokSearch,
  xgrokConverse,
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
  getXGrokConfig,
  XGrokError,
};
