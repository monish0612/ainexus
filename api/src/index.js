const dotenvPath = require('path').resolve(__dirname, '../../.env');
require('dotenv').config({ path: dotenvPath });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const {
  REPHRASE_PLATFORMS,
  buildRephraseSystemPrompt,
  looksLikeReplyInsteadOfRephrase,
  REPHRASE_RETRY_NUDGE,
  COACH_SYSTEM_PROMPT,
  buildDictionarySystemPrompt,
  buildSummarizerSystemPrompt,
  buildBatchArticleSummaryPrompt,
  SMART_PARSE_SYSTEM_PROMPT,
  buildSmartParseSystemPrompt,
  CATEGORIZE_SYSTEM_PROMPT,
  IMAGE_LENS_PROMPT,
  buildVisionExpertPrompt,
} = require('./prompts');
const {
  groundedSearch,
  groundedExtract,
  groundedConverse,
  groundedSearchVision,
  groundedConverseVision,
  updateGroundingModels,
  isGroundingAvailable,
  resolveGroundingMode,
  getGroundingConfig,
} = require('./google-grounding');
const {
  xgrokSearch,
  xgrokConverse,
  xgrokSearchVision,
  xgrokConverseVision,
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
  getXGrokConfig,
} = require('./xgrok');
const crypto = require('crypto');
const {
  validateImagePayload: _validateImagePayloadShared,
  preprocessForVision,
  isSharpAvailable,
} = require('./image-preprocess');
const {
  register: registerProvider,
  complete: llmProviderComplete,
  completeWithFallback: llmProviderCompleteWithFallback,
  list: listProviders,
  has: hasProvider,
  getHealth: getProviderHealth,
} = require('./llm-providers');
const {
  geminiComplete,
  listAvailableModels: listGeminiModels,
  isGeminiModel,
  stripGeminiPrefix,
  normaliseModelId,
  GeminiDirectError,
  ERROR_CODES: GEMINI_ERROR_CODES,
  mapErrorToHttp: mapGeminiErrorToHttp,
} = require('./gemini-direct');
const { tg } = require('./telegram');
const {
  buildExpenseInsightPrompt,
  sanitizeInsightResponse,
} = require('./expense-insight');
const {
  checkAppCredentials,
  makeAppToken,
  requireApp,
  isAppAuthRequired,
  buildClientLog,
} = require('./app-auth');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 12;

// ── Validate critical env vars at boot ──────────────────────────
const _REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of _REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
  tg.e('DB/pool', 'Unexpected pool error', err);
});

// ═══════════════════════════════════════════════════════════════
//  PROCESS-LEVEL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled rejection:', reason);
  tg.e('Process', 'Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err.message);
  tg.fatal('Process', 'Uncaught exception — process may be unstable', err);
});

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
  // A single large file becomes many sequential chunk PUTs; exempt the
  // resumable-upload subtree so big uploads don't trip the per-minute cap.
  skip: (req) =>
    /\/api\/v1\/cloud\/upload\/resumable\//.test(req.originalUrl || req.url || ''),
});
app.use('/api/', apiLimiter);

app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ═══════════════════════════════════════════════════════════════
//  LITELLM — FULLY DYNAMIC MODEL DISCOVERY + SMART ROUTING
//
//  Zero hardcoded model names. All models are discovered at
//  runtime from LiteLLM's /v1/models endpoint.
//
//  Priority: non-Groq models first (sorted by version desc),
//  Groq/* models always last. Re-discovers every 5 minutes.
// ═══════════════════════════════════════════════════════════════

let modelPriorityList = [];
let _discoveryAttempts = 0;
const _REDISCOVERY_MS = 5 * 60 * 1000;
const _MAX_DISCOVERY_RETRIES = 5;
const _CALL_TIMEOUT_MS = 30_000;
const _MAX_RETRIES_PER_MODEL = 2;
const _MAX_RETRIES_LAST_MODEL = 3;

function _extractVersion(modelId) {
  const match = modelId.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function _isGroqModel(id) {
  const lower = id.toLowerCase();
  return lower.startsWith('groq/') || lower.includes('llama');
}

function _isRetryableError(msg) {
  return /429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
}

function _sortModelPriority(models) {
  const preferred = models.filter(m => !_isGroqModel(m));
  const groq = models.filter(m => _isGroqModel(m));
  preferred.sort((a, b) => _extractVersion(b) - _extractVersion(a));
  groq.sort((a, b) => _extractVersion(b) - _extractVersion(a));
  return [...preferred, ...groq];
}

// ── GET helper ─────────────────────────────────────────────────

async function getLiteLLM(path) {
  const response = await fetch(process.env.LITELLM_URL + path, {
    headers: { 'Authorization': 'Bearer ' + process.env.LITELLM_VIRTUAL_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM GET ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

// ── Discovery ──────────────────────────────────────────────────

async function discoverLiteLLMModels() {
  try {
    const data = await getLiteLLM('/v1/models');
    const models = (data?.data || []).map(m => m.id).filter(Boolean);

    if (models.length === 0) {
      const msg = 'No models returned from /v1/models — check LiteLLM config';
      console.warn(`[LiteLLM] ${msg}`);
      tg.w('LiteLLM', msg);
      return;
    }

    modelPriorityList = _sortModelPriority(models);
    process.env._LITELLM_MODEL_PRIORITY = JSON.stringify(modelPriorityList);
    _discoveryAttempts = 0;

    updateGroundingModels(models);

    const primary = modelPriorityList[0];
    const fallbacks = modelPriorityList.slice(1);
    const summary = `${models.length} models — Primary: ${primary}` +
      (fallbacks.length ? ` | Fallback: ${fallbacks.join(', ')}` : '');

    console.log(`[LiteLLM] Discovered ${summary}`);
    tg.i('LiteLLM', `Discovered ${summary}`);
  } catch (e) {
    _discoveryAttempts++;
    const msg = `Discovery failed (attempt ${_discoveryAttempts}/${_MAX_DISCOVERY_RETRIES}): ${e.message}`;
    console.warn(`[LiteLLM] ${msg}`);

    if (_discoveryAttempts >= _MAX_DISCOVERY_RETRIES) {
      tg.e('LiteLLM', msg, e);
    } else {
      tg.w('LiteLLM', msg, e);
      const delay = Math.min(1000 * Math.pow(2, _discoveryAttempts), 30_000);
      setTimeout(discoverLiteLLMModels, delay);
    }
  }
}

setInterval(discoverLiteLLMModels, _REDISCOVERY_MS).unref();

// ── Single completion call ─────────────────────────────────────

async function _callLiteLLMOnce(model, messages, { temperature, maxTokens }) {
  const response = await fetch(process.env.LITELLM_URL + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.LITELLM_VIRTUAL_KEY,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(_CALL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`LiteLLM ${response.status} [${model}]: ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model_used: data.model || model,
    usage: data.usage || null,
  };
}

// ── Smart caller with retry + fallback ─────────────────────────
//
// Routing matrix (in order):
//   1. Caller-supplied Gemini model       → direct Google REST API
//      (no proxy hop, the model id from Settings is sent verbatim
//      to generativelanguage.googleapis.com so a brand-new model
//      works the day Google ships it).
//   2. If the direct call fails for a recoverable reason
//      (model-not-found / rate-limit / server / network) AND
//      `modelPriorityList` has other Gemini candidates discovered
//      from LiteLLM, retry against those — this is the
//      "self-healing" path so a typo in Settings degrades to the
//      next best Gemini model instead of a hard failure.
//   3. Non-Gemini model id (e.g. `groq/llama-…`) or no model
//      supplied → fall back to the legacy LiteLLM proxy. This keeps
//      the Llama fallback alive for the edge case where every
//      Gemini call is rejected (e.g. paid-tier outage).
//
// The function always throws a `GeminiDirectError` when the entire
// chain fails on the Gemini path, so the global error handler can
// emit a rich `{error: {code, message, model}}` envelope to the
// client.

async function callLiteLLM({ messages, model, temperature = 0.7, maxTokens = 2048, jsonOutput = false }) {
  // ── Path 1: direct Gemini ──────────────────────────────────
  //
  // Triggered when:
  //   a) The caller explicitly passes a Gemini-shaped id
  //      (`gemini-…` or `gemini/…`) — typically the user's
  //      settings.liteModel from app preferences.
  //   b) No model is supplied and the discovered LiteLLM priority
  //      list contains at least one Gemini id — i.e. the
  //      auto-pick path. We pick the first Gemini id from the list
  //      and route DIRECT to Google (not back through the proxy)
  //      so the "we don't depend on LiteLLM" invariant holds for
  //      every Gemini code path, not just user-customised ones.
  const explicitGemini = isGeminiModel(model);
  const autoPickGemini = !model && modelPriorityList.some((m) => isGeminiModel(m));

  if (explicitGemini || autoPickGemini) {
    const userModel = explicitGemini ? stripGeminiPrefix(model) : null;
    const fallbacks = modelPriorityList
      .filter((m) => isGeminiModel(m))
      .map((m) => stripGeminiPrefix(m))
      .filter((m) => m && m !== userModel);
    const modelsToTry = userModel ? [userModel, ...fallbacks] : fallbacks;

    if (modelsToTry.length === 0) {
      throw new GeminiDirectError(
        'No Gemini models available — set a model in Settings → Gemini Lite model',
        GEMINI_ERROR_CODES.INVALID_MODEL,
        400,
      );
    }

    let lastError;
    for (let i = 0; i < modelsToTry.length; i++) {
      const m = modelsToTry[i];
      try {
        const result = await geminiComplete({
          model: m,
          messages,
          temperature,
          maxTokens,
          jsonOutput,
        });
        if (i > 0) {
          tg.w(
            'GeminiDirect',
            `Fallback ${m} succeeded after ${modelsToTry[0]} failed (${lastError?.code || 'unknown'})`,
          );
        }
        return result;
      } catch (e) {
        lastError = e;
        const recoverable =
          e instanceof GeminiDirectError &&
          (
            e.code === GEMINI_ERROR_CODES.MODEL_NOT_FOUND ||
            e.code === GEMINI_ERROR_CODES.RATE_LIMIT ||
            e.code === GEMINI_ERROR_CODES.SERVER ||
            e.code === GEMINI_ERROR_CODES.NETWORK ||
            e.code === GEMINI_ERROR_CODES.TIMEOUT ||
            e.code === GEMINI_ERROR_CODES.EMPTY
          );
        if (!recoverable) break;
      }
    }

    tg.e(
      'GeminiDirect',
      `All Gemini models exhausted (${modelsToTry.join(', ')}): ${lastError?.code || lastError?.message}`,
      lastError,
    );
    throw lastError;
  }

  // ── Path 2: legacy LiteLLM proxy (non-Gemini, e.g. Groq llama) ─
  //
  // Only used when the caller explicitly passes a non-Gemini id
  // (e.g. `groq/llama-3.3-70b-versatile`) OR the priority list has
  // no Gemini ids at all (degenerate case — proxy mis-configured).
  // The proxy is still the path of least resistance for Groq today;
  // a future PR can swap this to a `groq-direct.js` module the same
  // way Gemini was migrated.
  if (modelPriorityList.length === 0 && !model) {
    await discoverLiteLLMModels();
    if (modelPriorityList.length === 0) {
      const err = new Error('No LiteLLM models available — /v1/models returned empty');
      tg.e('LiteLLM', err.message);
      throw err;
    }
  }

  const modelsToTry = model ? [model] : [...modelPriorityList];
  let lastError;

  for (let i = 0; i < modelsToTry.length; i++) {
    const m = modelsToTry[i];
    const isLast = i === modelsToTry.length - 1;
    const maxRetries = isLast ? _MAX_RETRIES_LAST_MODEL : _MAX_RETRIES_PER_MODEL;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(500 * Math.pow(2, attempt), 4000);
          await new Promise(r => setTimeout(r, delay));
        }
        const result = await _callLiteLLMOnce(m, messages, { temperature, maxTokens });
        if (i > 0) {
          tg.w('LiteLLM', `Fallback to ${m} succeeded (primary ${modelsToTry[0]} was down)`);
        }
        return result;
      } catch (e) {
        lastError = e;
        const retryable = _isRetryableError(e.message);

        if (!retryable || attempt >= maxRetries - 1) {
          if (modelsToTry.length > 1) {
            console.warn(`[LLM] ${m} exhausted after ${attempt + 1} attempts: ${e.message.slice(0, 120)}`);
          }
          break;
        }
        console.warn(`[LLM] ${m} retry ${attempt + 1}/${maxRetries}: ${e.message.slice(0, 80)}`);
      }
    }
  }

  tg.e('LiteLLM', `All ${modelsToTry.length} models exhausted: ${modelsToTry.join(', ')}`, lastError);
  throw lastError;
}

// ── Model id normalisation ─────────────────────────────────────
// Clients send a bare Gemini model id (e.g. "gemini-3.1-flash-lite-preview")
// because that's what they store in app settings. The direct-Google path
// in `gemini-direct.js` consumes the bare id verbatim, while the legacy
// LiteLLM proxy path expects the provider-prefixed form
// ("gemini/gemini-3.1-flash-lite-preview").
//
// We keep both formats valid downstream:
//   • The direct path's `isGeminiModel` accepts both prefixed and bare ids
//     and strips the prefix before sending to Google.
//   • `_callLiteLLMOnce` (proxy path) sends whatever it gets; the proxy is
//     happy with `gemini/<id>`.
//
// Therefore we DO NOT prefix here any more — passing the bare id keeps
// the caller's intent intact and lets the routing layer decide which
// transport to use based on `isGeminiModel`.
function _normalizeLiteLLMGeminiId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed;
}

// Pick the model id for a "lite" call: `liteModel` from settings wins,
// then the legacy `model` field (which is already routed/prefixed by callers
// who set it manually), else null so the caller falls back to its default.
function _pickLiteLLMModel(liteModel, legacyModel) {
  const norm = _normalizeLiteLLMGeminiId(liteModel);
  if (norm) return norm;
  if (typeof legacyModel === 'string' && legacyModel.trim()) {
    return legacyModel.trim();
  }
  return null;
}

// ── Public accessors ───────────────────────────────────────────

function getPrimaryModel() {
  return modelPriorityList[0] || null;
}

function getFallbackModels() {
  return modelPriorityList.slice(1);
}

function getModelPriorityList() {
  return [...modelPriorityList];
}

// ── LLM error notifier for grounding outages ─────────────────
// When Gemini grounding is completely down (all models × retries
// exhausted), use Llama/Groq via LiteLLM to generate a friendly
// error message for the user. Does NOT answer the question —
// just explains the outage.

const _HARDCODED_ERROR_MSG =
  '⚠️ **Temporarily Unavailable**\n\n' +
  'I apologize, but the AI service (Google Gemini) is currently experiencing issues ' +
  'and I\'m unable to process your request right now.\n\n' +
  'Please try again in a moment — this is usually resolved quickly.';

async function _notifyGroundingError(groundingError) {
  const errMsg = groundingError instanceof Error
    ? groundingError.message
    : String(groundingError);

  try {
    const result = await callLiteLLM({
      messages: [
        {
          role: 'system',
          content:
            'You are Nexus AI assistant. The primary AI model (Google Gemini) is temporarily down. '
            + 'Write a brief, empathetic 2-3 sentence message to the user: '
            + '(1) Acknowledge the issue, (2) include the short technical reason, '
            + '(3) suggest trying again in a moment. Use markdown. Do NOT answer any question.',
        },
        {
          role: 'user',
          content: `Gemini API error: ${errMsg.slice(0, 400)}`,
        },
      ],
      maxTokens: 250,
      temperature: 0.2,
    });

    tg.i('LLM/error-notify', `✓ model=${result.model_used} — delivered Gemini outage notice`);
    return {
      text: result.content,
      model: `${result.model_used} (error-notice)`,
      sources: [],
      searchQueries: [],
      fallback: true,
    };
  } catch {
    return {
      text: _HARDCODED_ERROR_MSG,
      model: 'error-fallback',
      sources: [],
      searchQueries: [],
      fallback: true,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
//  ZOD SCHEMAS
// ═══════════════════════════════════════════════════════════════

const RegisterSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const TransactionSchema = z.object({
  id: z.string().uuid().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  category_id: z.string().optional(),
  description: z.string().max(500).optional(),
  type: z.enum(['income', 'expense']),
  transaction_date: z.string().datetime(),
});

const LLMCompleteSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })).min(1),
  model: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const LLMSummarizeSchema = z.object({
  text: z.string().min(1),
  max_length: z.number().int().positive().optional(),
  model: z.string().optional(),
});

const LLMCorrectSchema = z.object({
  text: z.string().min(1),
  tone: z.string().optional(),
  platform: z.string().optional(),
  platforms: z.array(z.string()).optional(),
  model: z.string().optional(),
});

const AIRephraseSchema = z.object({
  text: z.string().min(1).max(5000),
  platform: z.string().min(1),
  intent: z.string().max(500).optional(),
  model: z.string().optional(),
  liteModel: z.string().max(200).optional(),
});

const AICorrectSchema = z.object({
  text: z.string().min(1).max(2000),
  model: z.string().optional(),
  liteModel: z.string().max(200).optional(),
});

const AIDefineSchema = z.object({
  word: z.string().min(1).max(100),
  model: z.string().optional(),
  liteModel: z.string().max(200).optional(),
});

const AISummarizeSchema = z.object({
  url: z.string().url().max(2000),
  model: z.string().optional(),
  liteModel: z.string().max(200).optional(),
});

// Batch quick-summary for the For You "catch up" pile (Gemini Flash Lite).
// Client sends already-extracted text; server only does the LLM call.
// `url` is optional: when the client's local copy of an article is thin
// (headline-only feeds), the batch handler deep-extracts the real body
// content from the URL before summarizing — see the enrichment block in
// the /summarize-articles-batch route.
const AISummarizeArticlesBatchSchema = z.object({
  articles: z.array(z.object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    source: z.string().max(120).optional(),
    category: z.string().max(60).optional(),
    content: z.string().max(4000),
    url: z.string().max(2000).optional(),
  })).min(1).max(12),
  model: z.string().optional(),
  liteModel: z.string().max(200).optional(),
});

// Bulk mark-as-read for the For You "Clear All" / "Done" flows.
// Idempotent. Never touches saved=TRUE.
const NewsMarkAllReadSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(500),
});

const SyncPushSchema = z.object({
  changes: z.array(z.object({
    table_name: z.string(),
    record_id: z.string(),
    operation: z.enum(['insert', 'update', 'delete']),
    payload: z.record(z.any()).optional(),
  })),
});

const SyncPullSchema = z.object({
  last_synced_at: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════
//  VALIDATION HELPER
// ═══════════════════════════════════════════════════════════════

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: msg };
  }
  return { ok: true, data: result.data };
}

const AI_REPHRASE_PLATFORM_META = {
  own: {
    guidance: 'user-defined custom rephrase instruction',
    charLimit: null,
  },
  casual: {
    guidance: 'casual everyday conversational tone',
    charLimit: null,
  },
  sarcastic: {
    guidance: 'sarcastic witty tone with dry humor',
    charLimit: null,
  },
  'email-long': {
    guidance: 'formal long-form email with greeting, body, and sign-off',
    charLimit: null,
  },
  'email-short': {
    guidance: 'short concise email, ideally 1-2 lines',
    charLimit: 150,
  },
  slack: {
    guidance: 'short workplace chat message with conversational tone',
    charLimit: 200,
  },
  whatsapp: {
    guidance: 'warm personal message with natural flow',
    charLimit: 300,
  },
  twitter: {
    guidance: 'public social post with a strong hook',
    charLimit: 280,
  },
  linkedin: {
    guidance: 'professional post with insight and authority',
    charLimit: null,
  },
  teams: {
    guidance: 'structured team update with action-oriented clarity',
    charLimit: null,
  },
  zoom: {
    guidance: 'spoken meeting or live-call phrasing, brief and natural',
    charLimit: null,
  },
  forum: {
    guidance: 'online forum or community post, informative and engaging',
    charLimit: null,
  },
};

const AI_COACH_PLATFORM_META = {
  zoom: 'spoken meeting or live-call update, brief and natural',
  slack: 'workplace async chat message',
  whatsapp: 'personal messaging tone',
  email: 'professional written note or email sentence',
  teams: 'structured internal collaboration update',
};

const AI_COACH_TONE_META = {
  casual: 'friendly, approachable, and relaxed',
  professional: 'polished, respectful, and formal',
  urgent: 'direct, concise, and action-oriented',
};

const AI_DICTIONARY_CONTEXTS = [
  { label: 'Business Email', emoji: '✉️', color: '#F59E0B' },
  { label: 'Presentations', emoji: '🎤', color: '#A78BFA' },
  { label: 'Academic Writing', emoji: '📝', color: '#60A5FA' },
  { label: 'LinkedIn Posts', emoji: '💼', color: '#34D399' },
  { label: 'Casual Chat', emoji: '💬', color: '#4ADE80' },
  { label: 'Creative Writing', emoji: '✍️', color: '#F472B6' },
  { label: 'Interviews', emoji: '🤝', color: '#60A5FA' },
  { label: 'WhatsApp / Slack', emoji: '📱', color: '#94A3B8' },
];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value, limit = 10) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function readObjectValue(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const normalizedKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(obj)) {
    if (entryKey.toLowerCase() === normalizedKey) {
      return value;
    }
  }
  return undefined;
}

function readStringValue(obj, keys, fallback = '') {
  const source = asObject(obj) || {};
  for (const key of keys) {
    const value = asString(readObjectValue(source, key));
    if (value) {
      return value;
    }
  }
  return fallback;
}

function readStringArrayValue(obj, keys, limit = 10) {
  const source = asObject(obj) || {};
  for (const key of keys) {
    const values = asStringArray(readObjectValue(source, key), limit);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function parseJsonContent(content) {
  const trimmed = asString(content);
  if (!trimmed) {
    throw new Error('LLM returned empty content');
  }

  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error('LLM JSON parse failed');
}

function normalizeRephrasePlatformId(value) {
  const id = asString(value).toLowerCase();
  return AI_REPHRASE_PLATFORM_META[id] ? id : null;
}

function normalizeCoachPlatformId(value) {
  const id = asString(value).toLowerCase();
  const alias = id === 'linkedin' ? 'zoom' : id;
  return AI_COACH_PLATFORM_META[alias] ? alias : null;
}

function normalizeCoachToneId(value) {
  const id = asString(value).toLowerCase();
  return AI_COACH_TONE_META[id] ? id : null;
}

function titleCaseWord(word) {
  const trimmed = asString(word);
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase() : '';
}

function normalizeHexColor(value, fallback = '#94A3B8') {
  const raw = asString(value, fallback);
  if (!raw) return fallback;
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  return normalized.toUpperCase();
}

function normalizeRephraseResults(payload, requestedPlatforms, fallbackText) {
  const source = asObject(payload);
  const rawResults = Array.isArray(source?.platformResults)
    ? source.platformResults
    : Array.isArray(source?.platform_results)
      ? source.platform_results
      : Array.isArray(payload)
        ? payload
        : [];
  const byPlatformId = new Map();

  for (const item of rawResults) {
    const obj = asObject(item);
    if (!obj) continue;
    const platformId = normalizeRephrasePlatformId(
      readStringValue(obj, ['platformId', 'platform_id', 'platform']),
    );
    if (!platformId) continue;
    byPlatformId.set(platformId, obj);
  }

  return requestedPlatforms.map((platformId) => {
    const obj = byPlatformId.get(platformId) || asObject(readObjectValue(source || {}, platformId)) || {};
    return {
      platformId,
      text: readStringValue(
        obj,
        ['text', 'output', 'rephrasedText', 'rephrased_text'],
        fallbackText,
      ),
      whyItWorks: readStringArrayValue(
        obj,
        ['whyItWorks', 'why_it_works', 'why'],
        5,
      ),
      techniques: readStringArrayValue(obj, ['techniques', 'skills'], 8),
    };
  });
}

function normalizeCoachResponse(payload, targetPlatforms, targetTones, inputText) {
  const source = asObject(payload) || {};
  const variationSource = asObject(readObjectValue(source, 'variations'))
    || asObject(readObjectValue(source, 'platformVariations'))
    || asObject(readObjectValue(source, 'platform_variations'))
    || {};
  const corrected = readStringValue(
    source,
    ['corrected', 'correctedText', 'corrected_text'],
    inputText,
  );
  const variations = {};

  for (const platformId of targetPlatforms) {
    const platformPayload = asObject(readObjectValue(variationSource, platformId)) || {};
    variations[platformId] = {};
    for (const toneId of targetTones) {
      variations[platformId][toneId] = readStringValue(
        platformPayload,
        [toneId, toneId.toLowerCase(), toneId.charAt(0).toUpperCase() + toneId.slice(1)],
        corrected,
      );
    }
  }

  return {
    corrected,
    highlights: readStringArrayValue(source, ['highlights'], 10),
    variations,
    proTip: readStringValue(source, ['proTip', 'pro_tip', 'protip']),
  };
}

function fallbackDictionaryExamples(word) {
  const normalizedWord = asString(word).toLowerCase() || 'this word';
  return [
    `"${normalizedWord}" can add precision to formal communication when used correctly."`,
    `"She used ${normalizedWord} in her presentation to sound more exact and persuasive."`,
    `"Writers often choose ${normalizedWord} when a simpler term feels too vague."`,
    `"Understanding ${normalizedWord} helps you read advanced English with more confidence."`,
    `"The interview response felt stronger after he replaced a generic phrase with ${normalizedWord}."`,
    `"Using ${normalizedWord} in context makes your message more memorable."`,
    `"Students encounter ${normalizedWord} more often in academic and professional English."`,
    `"A well-placed ${normalizedWord} can improve tone as well as clarity."`,
    `"Her email sounded sharper after she chose ${normalizedWord} instead of a common alternative."`,
    `"When used naturally, ${normalizedWord} can make spoken and written English feel more polished."`,
  ];
}

function normalizeDictionaryResponse(payload, word) {
  const source = asObject(payload) || {};
  const titleWord = titleCaseWord(word);
  const rawUsageContexts = Array.isArray(readObjectValue(source, 'usageContexts'))
    ? readObjectValue(source, 'usageContexts')
    : Array.isArray(readObjectValue(source, 'usage_contexts'))
      ? readObjectValue(source, 'usage_contexts')
      : Array.isArray(readObjectValue(source, 'contexts'))
        ? readObjectValue(source, 'contexts')
        : [];
  const usageContexts = rawUsageContexts
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return null;
      const label = readStringValue(obj, ['label', 'name']);
      const emoji = readStringValue(obj, ['emoji', 'icon']);
      if (!label || !emoji) return null;
      return {
        label,
        emoji,
        color: normalizeHexColor(
          readStringValue(obj, ['colorHex', 'color_hex', 'color'], '#94A3B8'),
        ),
        fits: typeof obj.fits === 'boolean' ? obj.fits : false,
      };
    })
    .filter(Boolean);
  const examples = readStringArrayValue(source, ['examples'], 10);

  return {
    word: readStringValue(source, ['word'], titleWord),
    pronunciation: readStringValue(
      source,
      ['pronunciation'],
      `/${asString(word).toLowerCase() || 'word'}/`,
    ),
    partOfSpeech: readStringValue(
      source,
      ['partOfSpeech', 'part_of_speech'],
      'word',
    ),
    definition: readStringValue(
      source,
      ['definition'],
      `${titleWord || 'This word'} has a context-sensitive meaning in English communication.`,
    ),
    examples: examples.length > 0 ? examples : fallbackDictionaryExamples(titleWord),
    usageContexts: usageContexts.length > 0
      ? usageContexts
      : AI_DICTIONARY_CONTEXTS.map((context, index) => ({
          ...context,
          fits: index < 6,
        })),
  };
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES — HEALTH
// ═══════════════════════════════════════════════════════════════

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const tableCheck = await verifyTablesExist();
    res.json({
      status: tableCheck.ok ? 'ok' : 'degraded',
      database: 'connected',
      tables: tableCheck.ok ? 'all present' : `missing: ${tableCheck.missing.join(', ')}`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database connection failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — AUTH  /api/v1/auth
// ═══════════════════════════════════════════════════════════════

const authRouter = express.Router();

authRouter.post('/register', async (req, res, next) => {
  try {
    const v = validate(RegisterSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { name, email, password } = v.data;

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, membership_tier, member_since, created_at`,
      [name, email, passwordHash],
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const v = validate(LoginSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { email, password } = v.data;

    const result = await pool.query(
      `SELECT id, name, email, password_hash, avatar_url, membership_tier, member_since, created_at
       FROM users WHERE email = $1`,
      [email],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/profile', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, avatar_url, membership_tier, member_since, created_at
       FROM users WHERE id = $1`,
      [req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── Single-user app login → JWT for the shared data API ──────────────────────
// The clients gate themselves with a client-side credential check; this issues
// the server-signed token they attach to data requests. Brute-force-throttled
// independently of the global limiter.
const appLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});

authRouter.post('/app-login', appLoginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!checkAppCredentials(username, password)) {
    tg.w('AUTH', `app-login failed from ${req.ip || 'unknown'}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  try {
    const token = makeAppToken();
    tg.i('AUTH', `app-login ok (${String(username).trim().toLowerCase()})`);
    return res.json({ token, enforced: isAppAuthRequired() });
  } catch (err) {
    tg.e('AUTH', 'app-login token sign failed', err);
    return res.status(500).json({ error: 'Could not issue token' });
  }
});

app.use('/api/v1/auth', authRouter);

// ── Browser client-log relay → Telegram ──────────────────────────────────────
// Lets the website funnel runtime errors to the same Telegram channel as the
// backend WITHOUT ever shipping the bot token to the browser. Unauthenticated
// (so it can capture pre-/login errors) but tightly rate-limited and fully
// size-capped so it can never flood Telegram or be used for abuse.
const clientLogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many logs' },
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});

app.post('/api/v1/client-log', clientLogLimiter, (req, res) => {
  try {
    const { level, tag, message, line } = buildClientLog(req.body);
    if (!message) return res.status(204).end();
    if (level === 'warn' || level === 'warning') tg.w(tag, line);
    else if (level === 'info') tg.i(tag, line);
    else tg.e(tag, line);
  } catch {
    // Logging must never fail the caller.
  }
  return res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES — FINANCE  /api/v1/finance
// ═══════════════════════════════════════════════════════════════

const financeRouter = express.Router();
financeRouter.use(authenticate);

financeRouter.get('/balance', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS total_income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
       FROM transactions WHERE user_id = $1`,
      [req.userId],
    );
    const { total_income, total_expense } = result.rows[0];
    const income = parseFloat(total_income);
    const expense = parseFloat(total_expense);
    res.json({
      balance: income - expense,
      total_income: income,
      total_expense: expense,
    });
  } catch (err) {
    next(err);
  }
});

financeRouter.get('/transactions', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0, category, type, from, to } = req.query;
    const params = [req.userId];
    let where = 'WHERE t.user_id = $1';
    let idx = 2;

    if (category) {
      where += ` AND t.category_id = $${idx++}`;
      params.push(category);
    }
    if (type) {
      where += ` AND t.type = $${idx++}`;
      params.push(type);
    }
    if (from) {
      where += ` AND t.transaction_date >= $${idx++}`;
      params.push(from);
    }
    if (to) {
      where += ` AND t.transaction_date <= $${idx++}`;
      params.push(to);
    }

    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(
      `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       ${where}
       ORDER BY t.transaction_date DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      params,
    );

    res.json({ transactions: result.rows });
  } catch (err) {
    next(err);
  }
});

financeRouter.post('/transactions', async (req, res, next) => {
  try {
    const v = validate(TransactionSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { amount, currency, category_id, description, type, transaction_date } = v.data;
    const id = v.data.id || uuidv4();

    const result = await pool.query(
      `INSERT INTO transactions (id, user_id, amount, currency, category_id, description, type, transaction_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, req.userId, amount, currency, category_id, description, type, transaction_date],
    );

    res.status(201).json({ transaction: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

financeRouter.get('/spending', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const params = [req.userId];
    let dateFilter = '';
    let idx = 2;

    if (from) {
      dateFilter += ` AND t.transaction_date >= $${idx++}`;
      params.push(from);
    }
    if (to) {
      dateFilter += ` AND t.transaction_date <= $${idx++}`;
      params.push(to);
    }

    const result = await pool.query(
      `SELECT c.id, c.name, c.icon, c.color, COALESCE(SUM(t.amount), 0) AS total
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = $1 AND t.type = 'expense' ${dateFilter}
       GROUP BY c.id, c.name, c.icon, c.color, c.sort_order
       ORDER BY c.sort_order`,
      params,
    );

    res.json({ spending: result.rows });
  } catch (err) {
    next(err);
  }
});

financeRouter.get('/categories', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY sort_order');
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/finance', financeRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — NEWS  /api/v1/news  (no auth — public feed)
// ═══════════════════════════════════════════════════════════════

const { syncNewsFeeds, getSyncState, startScheduler } = require('./news-service');
const { startXFeedScheduler, manualXFeedSync, getXFeedStatus } = require('./x-feed-service');

/**
 * Shared provider resolver with in-memory TTL cache.
 * Reads the DB setting once per cache window (30s), validates the provider
 * is registered and healthy, and returns the complete function or null.
 */
const _providerCache = { value: null, expiresAt: 0 };
const _PROVIDER_CACHE_TTL_MS = 30_000;

async function _resolveNewsProvider() {
  const now = Date.now();

  // Return cached value if still fresh
  if (_providerCache.expiresAt > now) {
    return _providerCache.value;
  }

  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'news_summarize_provider'",
    );
    const name = rows[0]?.value || 'litellm';

    if (name === 'litellm') {
      _providerCache.value = null;
      _providerCache.expiresAt = now + _PROVIDER_CACHE_TTL_MS;
      return null;
    }

    // Validate that the requested provider is registered and available
    if (!hasProvider(name)) {
      console.warn(`[Providers] Requested provider "${name}" is unavailable — falling back to litellm`);
      tg.w('Providers', `"${name}" unavailable (circuit open or missing key?) — litellm fallback`);
      _providerCache.value = null;
      _providerCache.expiresAt = now + 10_000; // shorter TTL for errors
      return null;
    }

    const resolver = { name, complete: (msgs, opts) => llmProviderComplete(name, msgs, opts) };
    _providerCache.value = resolver;
    _providerCache.expiresAt = now + _PROVIDER_CACHE_TTL_MS;
    return resolver;
  } catch (e) {
    console.warn('[Providers] Failed to read news_summarize_provider:', e.message?.slice(0, 100));
    tg.w('Providers', 'DB read failed for news_summarize_provider — litellm fallback', e);
    _providerCache.value = null;
    _providerCache.expiresAt = now + 10_000;
    return null;
  }
}

/** Bust the cache when settings change (called from PUT endpoint). */
function _invalidateProviderCache() {
  _providerCache.expiresAt = 0;
}

// ── Settings-model resolvers (from user_preferences) ──────────────
//
// These power the news-service scheduler and any internal job that needs
// to honour the user's settings.liteModel / settings.xgrokLiteModel.
// Cached with a short TTL so a hot scheduler loop doesn't hammer Postgres.
const _settingsModelCache = {
  liteModel: { value: null, expiresAt: 0 },
  xgrokLiteModel: { value: null, expiresAt: 0 },
};
const _SETTINGS_MODEL_TTL_MS = 30_000;

async function _readUserPreference(key) {
  const { rows } = await pool.query(
    'SELECT value FROM user_preferences WHERE key = $1',
    [key],
  );
  const raw = rows[0]?.value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads `lite_model` from user_preferences. Returns the BARE id
 * (e.g. `gemini-3.1-flash-lite-preview`) — no `gemini/` prefix is
 * added any more because the direct-Google transport in
 * `gemini-direct.js` consumes the bare id verbatim. The legacy
 * LiteLLM proxy path also accepts the bare id (LiteLLM auto-detects
 * the provider from the id pattern), so this is safe for both
 * transports.
 */
async function getConfiguredLiteModel() {
  const cache = _settingsModelCache.liteModel;
  if (cache.expiresAt > Date.now()) return cache.value;
  try {
    const raw = await _readUserPreference('lite_model');
    const normalized = _normalizeLiteLLMGeminiId(raw);
    cache.value = normalized;
    cache.expiresAt = Date.now() + _SETTINGS_MODEL_TTL_MS;
    return normalized;
  } catch (e) {
    cache.expiresAt = Date.now() + 5_000; // shorter TTL on error
    tg.w('Settings', 'Failed to read user_preferences.lite_model — using fallback', e);
    return null;
  }
}

/** Reads `xgrok_lite_model` from user_preferences (raw, no prefixing). */
async function getConfiguredXGrokLiteModel() {
  const cache = _settingsModelCache.xgrokLiteModel;
  if (cache.expiresAt > Date.now()) return cache.value;
  try {
    const raw = await _readUserPreference('xgrok_lite_model');
    cache.value = raw;
    cache.expiresAt = Date.now() + _SETTINGS_MODEL_TTL_MS;
    return raw;
  } catch (e) {
    cache.expiresAt = Date.now() + 5_000;
    tg.w('Settings', 'Failed to read user_preferences.xgrok_lite_model — using fallback', e);
    return null;
  }
}

/** Bust the cache when the client just pushed a new value (called from /user-preferences). */
function _invalidateSettingsModelCache() {
  _settingsModelCache.liteModel.expiresAt = 0;
  _settingsModelCache.xgrokLiteModel.expiresAt = 0;
}

function _cleanArticleMarkdown(md) {
  if (!md) return md;
  return md
    .replace(/^[\s\u2550]+$/gm, '')
    .replace(/\u2550+/g, '')
    .replace(/^\s*FORMAT\s*[::\uFF1A].+$/gim, '')
    .replace(/^\s*TEMPLATE\s*[::\uFF1A].+$/gim, '')
    .replace(/^\s*\[FORMAT[^\]]*\]\s*$/gim, '')
    .replace(/^\s*\[TEMPLATE[^\]]*\]\s*$/gim, '')
    .replace(/^\s*\[UNIVERSAL RULES[^\]]*\]\s*$/gim, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/^\s*={3,}\s*$/gm, '')
    .replace(/^\s*_{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _cleanExcerpt(text) {
  if (!text) return text;
  return text
    .replace(/[\u2550\u2500\u2501]+/g, '')
    .replace(/FORMAT\s*[::\uFF1A]\s*(?:[A-Z]+[\s\/\-]*)+/g, '')
    .replace(/-{3,}/g, '')
    .replace(/={3,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function mapArticleRow(row) {
  let meta = {};
  try { meta = row.content_json ? JSON.parse(row.content_json) : {}; } catch {}

  return {
    id: row.id,
    title: row.title,
    excerpt: _cleanExcerpt(row.excerpt),
    source: row.source,
    category: row.category,
    imageUrl: row.image,
    readTime: row.read_time,
    timeAgo: row.time_ago || null,
    date: row.date,
    tag: row.tag || null,
    isFeatured: !!row.is_featured,
    isSaved: !!row.saved,
    isRead: !!row.read,
    originalUrl: row.original_url || meta.originalUrl || '',
    publishedAt: row.published_at || meta.publishedAt || null,
    // `isFullContent` tells the Flutter detail view to render the article
    // body verbatim and expose the on-demand "AI Summarize" button instead
    // of treating `summaryMarkdown` as a pre-baked AI summary. Set at write
    // time from the feed's `skip_summary` flag (see news-service.js). Older
    // rows persisted before this field shipped fall back to `false`, so
    // genuine AI summaries keep their existing behaviour.
    isFullContent: meta.isFullContent === true,
    summaryMarkdown: _cleanArticleMarkdown(row.summary_markdown || ''),
  };
}

const newsRouter = express.Router();

newsRouter.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM news_articles
       ORDER BY is_featured DESC, COALESCE(published_at, created_at) DESC, updated_at DESC`,
    );
    res.json({ articles: result.rows.map((r) => mapArticleRow(r)), sync: getSyncState() });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/refresh', async (_req, res, next) => {
  try {
    const result = await syncNewsFeeds(pool, {
      reason: 'manual',
      getProviderFn: _resolveNewsProvider,
      getLiteModelFn: getConfiguredLiteModel,
      getXGrokLiteModelFn: getConfiguredXGrokLiteModel,
      deepExtractFn: deepExtractContent,
    });
    const rows = await pool.query(
      `SELECT * FROM news_articles
       ORDER BY is_featured DESC, COALESCE(published_at, created_at) DESC, updated_at DESC`,
    );
    res.json({
      refreshed: true,
      result,
      articles: rows.rows.map((r) => mapArticleRow(r)),
      sync: getSyncState(),
    });
  } catch (err) {
    next(err);
  }
});

newsRouter.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM news_articles WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: mapArticleRow(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/:id/save', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT saved FROM news_articles WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Article not found' });
    const next_val = !cur.rows[0].saved;
    await pool.query('UPDATE news_articles SET saved = $1, updated_at = NOW() WHERE id = $2', [next_val, id]);
    const updated = await pool.query('SELECT * FROM news_articles WHERE id = $1', [id]);
    res.json({ article: mapArticleRow(updated.rows[0]), saved: next_val });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT guid, saved FROM news_articles WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Article not found' });

    // Saved articles are retained — reading one only records the flag so it
    // stops surfacing as a "new" alert while staying in the Saved tab.
    if (cur.rows[0].saved) {
      await pool.query('UPDATE news_articles SET read = TRUE, updated_at = NOW() WHERE id = $1', [id]);
      const updated = await pool.query('SELECT * FROM news_articles WHERE id = $1', [id]);
      return res.json({ article: mapArticleRow(updated.rows[0]) });
    }

    // Unsaved + read = consumed → delete permanently and tombstone the guid so
    // the RSS feed sync never re-imports it (and it disappears from the web,
    // which reads this table directly). Mirrors DELETE /news/:id.
    if (cur.rows[0].guid) {
      await pool.query(
        'INSERT INTO deleted_guids (guid) VALUES ($1) ON CONFLICT (guid) DO NOTHING',
        [cur.rows[0].guid],
      );
    }
    await pool.query('DELETE FROM news_articles WHERE id = $1', [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/news/mark-all-read
//
// Bulk delete for the For You "Clear All" / summary "Done" flows. Despite the
// legacy route name, a cleared article is consumed and removed for good:
// idempotent, takes an explicit id list (max 500) and only deletes rows that
// are NOT saved (saved=TRUE rows are never touched, matching the UX promise
// that the Saved tab is preserved end-to-end). Each deleted row's `guid` is
// tombstoned so the RSS sync can't re-import it and it leaves the website too.
// ─────────────────────────────────────────────────────────────────────────
newsRouter.post('/mark-all-read', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const v = validate(NewsMarkAllReadSchema, req.body);
    if (!v.ok) {
      tg.w('News/mark-all-read', `validation failed: ${v.error?.slice?.(0, 120) || 'unknown'}`);
      return res.status(400).json({ error: v.error });
    }

    const { ids } = v.data;
    tg.d('News/mark-all-read', `▶ delete ${ids.length} ids`);

    // Tombstone the guids of the unsaved rows we're about to delete, then
    // hard-delete them. Saved rows are excluded from both steps.
    await pool.query(
      `INSERT INTO deleted_guids (guid)
       SELECT guid FROM news_articles
       WHERE id = ANY($1::text[]) AND saved = FALSE AND guid IS NOT NULL
       ON CONFLICT (guid) DO NOTHING`,
      [ids],
    );
    const result = await pool.query(
      'DELETE FROM news_articles WHERE id = ANY($1::text[]) AND saved = FALSE',
      [ids],
    );
    // i-level so the daily Telegram digest shows when the catch-up clear-out
    // fires in production. Saved-row protection is surfaced explicitly
    // (requested - deleted = saved-or-missing rows).
    tg.i(
      'News/mark-all-read',
      `✓ deleted requested=${ids.length} removed=${result.rowCount} kept=${ids.length - result.rowCount} ${Date.now() - _t0}ms`,
    );
    // `updated` retained for backward-compat with any un-upgraded client.
    res.json({ requested: ids.length, deleted: result.rowCount, updated: result.rowCount, ok: true });
  } catch (err) {
    tg.e('News/mark-all-read', `FATAL ${Date.now() - _t0}ms ids=${req.body?.ids?.length || 0}: ${err.message?.slice(0, 200)}`, err);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/news/nuke
//
// Easter-egg "nuke": permanently deletes EVERY article — INCLUDING saved ones
// (no `saved = FALSE` guard, unlike mark-all-read). Every guid is tombstoned
// first so the RSS/X schedulers can't immediately re-import the same items.
// This does NOT re-trigger a feed sync — the user asked for a clean slate.
// ─────────────────────────────────────────────────────────────────────────
newsRouter.post('/nuke', async (_req, res, next) => {
  const _t0 = Date.now();
  try {
    await pool.query(
      `INSERT INTO deleted_guids (guid)
       SELECT guid FROM news_articles WHERE guid IS NOT NULL
       ON CONFLICT (guid) DO NOTHING`,
    );
    const result = await pool.query('DELETE FROM news_articles');
    tg.w(
      'News/nuke',
      `☢️ deleted ALL ${result.rowCount} article(s) incl. saved ${Date.now() - _t0}ms`,
    );
    res.json({ deleted: result.rowCount, ok: true });
  } catch (err) {
    tg.e('News/nuke', `FATAL ${Date.now() - _t0}ms: ${err.message?.slice(0, 200)}`, err);
    next(err);
  }
});

newsRouter.delete('/cleanup-mock', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM news_articles WHERE (image = '' OR image IS NULL) AND (summary_markdown = '' OR summary_markdown IS NULL)`,
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/clear-fallbacks', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM news_articles
       WHERE saved = FALSE
         AND (summary_markdown LIKE '# %\n\n## Article Preview%'
              OR summary_markdown LIKE '%<!-- summary-unavailable -->%'
              OR summary_markdown IS NULL
              OR LENGTH(summary_markdown) < 200)`,
    );
    res.json({ deleted: result.rowCount, message: 'Fallback articles cleared. Trigger /refresh to re-fetch with LLM summaries.' });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/force-resync', async (_req, res, next) => {
  try {
    await pool.query('DELETE FROM deleted_guids');
    const del = await pool.query('DELETE FROM news_articles WHERE saved = FALSE');
    const { syncNewsFeeds } = require('./news-service');
    const feedsPath = require('fs').existsSync(require('path').resolve(__dirname, '../../news_rss_feeds.json'))
      ? require('path').resolve(__dirname, '../../news_rss_feeds.json')
      : require('path').resolve(__dirname, '../news_rss_feeds.json');
    const config = JSON.parse(require('fs').readFileSync(feedsPath, 'utf8'));
    syncNewsFeeds(pool, {
      reason: 'force-resync',
      getProviderFn: _resolveNewsProvider,
      getLiteModelFn: getConfiguredLiteModel,
      getXGrokLiteModelFn: getConfiguredXGrokLiteModel,
      deepExtractFn: deepExtractContent,
    }).catch((e) => console.error('[NEWS] force-resync error:', e));
    res.json({ deleted: del.rowCount, message: 'All non-saved articles removed. Re-fetching with new prompts in background.' });
  } catch (err) {
    next(err);
  }
});

newsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const article = await pool.query('SELECT guid FROM news_articles WHERE id = $1', [id]);
    if (article.rows.length > 0 && article.rows[0].guid) {
      await pool.query(
        'INSERT INTO deleted_guids (guid) VALUES ($1) ON CONFLICT (guid) DO NOTHING',
        [article.rows[0].guid],
      );
    }
    await pool.query('DELETE FROM news_articles WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

newsRouter.post('/x-feed/sync', async (_req, res, next) => {
  try {
    const result = await manualXFeedSync();
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

newsRouter.get('/x-feed/status', async (_req, res, next) => {
  try {
    res.json(getXFeedStatus());
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/news', requireApp, newsRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — AI  /api/v1/ai
// ═══════════════════════════════════════════════════════════════

const aiRouter = express.Router();

aiRouter.post('/rephrase', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AIRephraseSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const platformId = normalizeRephrasePlatformId(val.data.platform) || 'casual';
    const intent = asString(val.data.intent || '').trim();
    const sourceText = asString(val.data.text || '');
    const systemPrompt = buildRephraseSystemPrompt(platformId, intent);
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, val.data.model);
    tg.d('AI/rephrase', `platform=${platformId}${intent ? ` intent="${intent.slice(0, 60)}"` : ''}, textLen=${sourceText.length}, model=${pickedModel || '(default)'}`);

    const runOnce = (extraSystem) => callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: extraSystem ? `${systemPrompt}\n\n${extraSystem}` : systemPrompt },
        { role: 'user', content: sourceText },
      ],
      maxTokens: 800,
      // Lower temp → more faithful rewrites, fewer conversational replies.
      temperature: 0.35,
    });

    let result = await runOnce(null);
    let parsed = parseJsonContent(result.content);
    let rephrasedText = asString(
      parsed?.rephrasedText || parsed?.rephrased_text || parsed?.text || '',
    );

    // One-shot retry when the model answers instead of rephrasing.
    if (rephrasedText && looksLikeReplyInsteadOfRephrase(sourceText, rephrasedText)) {
      tg.w('AI/rephrase', `reply-shaped output detected — retrying once (platform=${platformId})`);
      result = await runOnce(REPHRASE_RETRY_NUDGE);
      parsed = parseJsonContent(result.content);
      const retryText = asString(
        parsed?.rephrasedText || parsed?.rephrased_text || parsed?.text || '',
      );
      if (retryText && !looksLikeReplyInsteadOfRephrase(sourceText, retryText)) {
        rephrasedText = retryText;
      } else if (retryText && looksLikeReplyInsteadOfRephrase(sourceText, retryText)) {
        tg.w('AI/rephrase', 'retry still reply-shaped — falling back to source text');
        rephrasedText = sourceText;
      } else {
        rephrasedText = retryText || sourceText;
      }
    }

    tg.i('AI/rephrase', `✓ model=${result.model_used} ${Date.now() - _t0}ms, platform=${platformId}`);
    res.json({
      platform: platformId,
      rephrasedText: rephrasedText || sourceText,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/rephrase', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

aiRouter.post('/correct', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AICorrectSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, val.data.model);
    tg.d('AI/correct', `textLen=${(val.data.text || '').length}, model=${pickedModel || '(default)'}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: COACH_SYSTEM_PROMPT },
        { role: 'user', content: val.data.text },
      ],
      maxTokens: 1500,
      temperature: 0.4,
    });

    const parsed = parseJsonContent(result.content);
    console.log('[COACH] Raw LLM keys:', Object.keys(parsed || {}));

    const correctedText = asString(
      parsed?.correctedText || parsed?.corrected_text || parsed?.corrected || '',
    );
    const explanation = asString(
      parsed?.explanation || parsed?.reasoning || parsed?.reason || '',
    );

    // Extract variations — LLM may use many different key names
    const variationsSource =
      parsed?.variations || parsed?.alternatives || parsed?.options
      || parsed?.suggestions || parsed?.rewrites || parsed?.toneVariations
      || parsed?.tone_variations || [];

    let rawVariations;
    if (Array.isArray(variationsSource)) {
      rawVariations = variationsSource;
    } else if (variationsSource && typeof variationsSource === 'object') {
      // LLM returned variations as { "Casual": "text", "Professional": "text" }
      rawVariations = Object.entries(variationsSource).map(([key, val]) => {
        if (typeof val === 'string') return { label: key, text: val };
        if (val && typeof val === 'object') return { ...val, label: val.label || val.tone || key };
        return null;
      }).filter(Boolean);
    } else {
      rawVariations = [];
    }

    console.log('[COACH] Variations source type:', Array.isArray(variationsSource) ? 'array' : typeof variationsSource, '| count:', rawVariations.length);
    if (rawVariations.length > 0) {
      console.log('[COACH] First variation keys:', Object.keys(rawVariations[0] || {}));
      console.log('[COACH] First variation sample:', JSON.stringify(rawVariations[0]).slice(0, 200));
    }

    const variations = rawVariations
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const label = asString(
          item.label || item.tone || item.type || item.style || item.name || '',
        );
        const text = asString(
          item.text || item.content || item.message || item.response
          || item.output || item.value || item.sentence || item.version
          || item.rephrased || item.example || '',
        );
        return { label, text };
      })
      .filter(item => item.label && item.text);

    console.log('[COACH] Final variations count:', variations.length);

    tg.i('AI/correct', `✓ model=${result.model_used} ${Date.now() - _t0}ms, variations=${variations.length}`);
    res.json({
      correctedText: correctedText || val.data.text,
      explanation,
      variations,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/correct', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

aiRouter.post('/define', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AIDefineSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, val.data.model);
    tg.d('AI/define', `word="${val.data.word}", model=${pickedModel || '(default)'}`);

    const systemPrompt = buildDictionarySystemPrompt(val.data.word);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: val.data.word },
      ],
      maxTokens: 1800,
      temperature: 0.2,
    });

    const parsed = parseJsonContent(result.content);
    console.log('[DICT] Raw LLM keys:', Object.keys(parsed || {}));

    const word = asString(parsed?.word || '') || titleCaseWord(val.data.word);
    const pronunciation = asString(parsed?.pronunciation || parsed?.phonetic || '');
    const partOfSpeech = asString(
      parsed?.partOfSpeech || parsed?.part_of_speech || parsed?.pos || parsed?.type || '',
    );
    const definition = asString(
      parsed?.definition || parsed?.meaning || parsed?.explanation || '',
    );
    const examples = (Array.isArray(parsed?.examples) ? parsed.examples : [])
      .map(e => asString(e))
      .filter(Boolean)
      .slice(0, 10);

    // Extract usage guide — LLM may use many different key names
    const usageGuide = asString(
      parsed?.usageGuide || parsed?.usage_guide || parsed?.usage
      || parsed?.whenToUse || parsed?.when_to_use
      || parsed?.usageNotes || parsed?.usage_notes
      || parsed?.guide || parsed?.context || parsed?.notes
      || parsed?.situationsToUse || parsed?.situations_to_use
      || parsed?.howToUse || parsed?.how_to_use || '',
    );

    console.log('[DICT] usageGuide length:', usageGuide.length, '| first 80:', usageGuide.slice(0, 80));

    tg.i('AI/define', `✓ model=${result.model_used} ${Date.now() - _t0}ms, word="${word}"`);
    res.json({
      word,
      pronunciation,
      partOfSpeech,
      definition,
      examples,
      usageGuide,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/define', `Failed word="${val?.data?.word}" ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// HTML → text helper (aggressive boilerplate stripping)
function stripHtmlToText(html) {
  return html
    // Remove non-content tags entirely
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    // Strip pricing/subscription sections (class or id hints)
    .replace(/<(?:div|section|table)[^>]*(?:class|id)=["'][^"']*(?:pricing|plans?|subscription|paywall|cta|sidebar|widget|cookie|banner|popup|modal|newsletter|signup|sign-up|testimonial|review|faq|compare|comparison)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|table)>/gi, '')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    // Post-strip: remove common boilerplate phrases that survive tag removal
    .replace(/(?:subscribe|sign up|log ?in|create (?:an )?account)[^.]{0,80}(?:\$|USD|INR|EUR|GBP|\/\s*(?:year|month|mo))\b[^.]*\.?/gi, ' ')
    .replace(/(?:terms\s*(?:&|and)\s*conditions|privacy\s*policy|cookie\s*(?:policy|consent)|all\s*rights?\s*reserved)[^.]*\.?/gi, ' ')
    .replace(/(?:follow us|download (?:the |our )?app|available on|app store|google play|qr code)[^.]*\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleFromHtml(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1];
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag) return titleTag[1].trim();
  const h1Tag = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Tag) return h1Tag[1].trim();
  return '';
}

// Paywall detection regex — compiled once at module level for performance
const _PAYWALL_RX = /subscribe to (?:read|continue|access|unlock)|sign (?:in|up) to (?:read|continue|access|view)|create.*(?:free|an)\s*account|only available to (?:subscribers|members|premium)|sign up for (?:a |your )?free (?:account|trial)|paywall|premium content|login required|subscription required|become a (?:member|subscriber)|unlock (?:this|the|full) (?:story|article|content|piece)|start your (?:free )?trial|already a (?:subscriber|member)\??|you(?:'ve| have) reached (?:your|the) (?:free|limit)|register to (?:read|continue|access)|this (?:content|article|story) is (?:only )?(?:available|accessible) (?:to|for) (?:subscribers|members|premium)|free articles? remaining|reading limit|metered paywall|continue reading for free|get (?:full|unlimited|complete) access/i;

// ═══════════════════════════════════════════════════════════════════════
//  DEEP CONTENT EXTRACTION — Modular, reusable pipeline (Stages 1–4)
//
//  Used by:
//    1. POST /api/v1/ai/summarize  (URL summarizer screen)
//    2. RSS feed pipeline           (for feeds with deep_extract: true)
//
//  To add a new site: set "deep_extract": true in news_rss_feeds.json
// ═══════════════════════════════════════════════════════════════════════

async function deepExtractContent(url, { logTag = 'DeepExtract' } = {}) {
  const _t0 = Date.now();
  let content = '';
  let title = '';
  let extractionMethod = 'none';
  let _rawHtml = '';
  let paywallSource = 'none';

  // ── Stage 1: Direct HTTP fetch (free, fast, 1× retry on transient) ──
  const _s1 = Date.now();
  const _fetchOnce = () => fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });

  for (let _a1 = 0; _a1 < 2; _a1++) {
    try {
      if (_a1 > 0) await new Promise(r => setTimeout(r, 1500));
      const directRes = await _fetchOnce();

      if (directRes.ok) {
        const html = await directRes.text();
        _rawHtml = html;
        title = extractTitleFromHtml(html);
        const text = stripHtmlToText(html);
        if (text.length > 500) {
          content = text.slice(0, 12000);
          extractionMethod = 'direct-fetch';
          tg.d(logTag, `Stage1 ✓ direct-fetch ${Date.now() - _s1}ms ${content.length}ch title="${title.slice(0, 50)}"${_a1 ? ' (retry)' : ''}`);
        } else {
          tg.d(logTag, `Stage1 content too short ${Date.now() - _s1}ms ${text.length}ch${_a1 ? ' (retry)' : ''}`);
        }
        break;
      } else {
        tg.d(logTag, `Stage1 HTTP ${directRes.status} ${Date.now() - _s1}ms${_a1 ? ' (retry)' : ''}`);
        if (directRes.status < 500) break;
      }
    } catch (fetchErr) {
      const transient = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR|socket hang up|abort/i.test(fetchErr.message);
      tg.d(logTag, `Stage1 error ${Date.now() - _s1}ms: ${fetchErr.message?.slice(0, 80)}${_a1 ? ' (retry)' : ''}`);
      if (!transient || _a1 >= 1) break;
    }
  }

  // ── Stage 2: Paywall / blocked check (two-layer detection) ───────────
  let paywallDetected = false;

  if (content.length >= 500 && _rawHtml.length > 0) {
    const _liteText = _rawHtml.slice(0, 60000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    paywallDetected = _PAYWALL_RX.test(_liteText);

    if (paywallDetected) {
      paywallSource = 'regex';
      const _pwMatch = _liteText.match(_PAYWALL_RX);
      tg.d(logTag, `Stage2a REGEX ✓ "${_pwMatch?.[0]?.slice(0, 60)}" — LLM check skipped`);
    } else {
      const _s2 = Date.now();
      try {
        const llmCheck = await callLiteLLM({
          messages: [
            {
              role: 'system',
              content: 'You are a paywall detector. Analyze the text and decide if the full article content is NOT available (truncated, gated, preview-only, subscription required). Reply ONLY: {"paywalled":true} or {"paywalled":false}',
            },
            { role: 'user', content: content.slice(0, 1500) },
          ],
          temperature: 0,
          maxTokens: 20,
        });
        const llmParsed = parseJsonContent(llmCheck.content);
        if (llmParsed?.paywalled === true) {
          paywallDetected = true;
          paywallSource = 'llm';
          tg.d(logTag, `Stage2b LLM ✓ paywalled ${Date.now() - _s2}ms model=${llmCheck.model_used}`);
        } else {
          tg.d(logTag, `Stage2b LLM ✗ not paywalled ${Date.now() - _s2}ms model=${llmCheck.model_used}`);
        }
      } catch (llmErr) {
        tg.d(logTag, `Stage2b LLM error ${Date.now() - _s2}ms: ${llmErr.message?.slice(0, 80)} — assuming not paywalled`);
      }
    }
  }

  const isBlocked = content.length < 500 || paywallDetected;
  if (isBlocked) {
    tg.d(logTag, `Stage2 → BLOCKED (content=${content.length}ch paywall=${paywallSource}) — entering deep extraction`);
  }

  // ── Stage 3: Zyte headless browser extraction (1× retry on 429/5xx) ──
  const zyteKey = process.env.ZYTE_API_KEY;
  if (isBlocked && zyteKey) {
    const _s3 = Date.now();
    const _zyteOnce = () => fetch('https://api.zyte.com/v1/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(zyteKey + ':').toString('base64'),
      },
      body: JSON.stringify({ url, browserHtml: true, article: true }),
      signal: AbortSignal.timeout(45000),
    });

    for (let _a3 = 0; _a3 < 2; _a3++) {
      try {
        if (_a3 > 0) await new Promise(r => setTimeout(r, 2000));
        const zyteRes = await _zyteOnce();

        if (zyteRes.ok) {
          const zyteData = await zyteRes.json();
          const articleBody = zyteData?.article?.articleBody || '';
          const headline = zyteData?.article?.headline || '';
          const browserHtmlText = zyteData?.browserHtml
            ? stripHtmlToText(zyteData.browserHtml)
            : '';

          if (browserHtmlText.length > articleBody.length && browserHtmlText.length > 300) {
            content = browserHtmlText.slice(0, 12000);
            if (!title) title = extractTitleFromHtml(zyteData.browserHtml);
            if (headline) title = headline;
            extractionMethod = 'zyte-html';
            tg.d(logTag, `Stage3 ✓ zyte-html ${Date.now() - _s3}ms ${content.length}ch (browser=${browserHtmlText.length} > article=${articleBody.length})${_a3 ? ' (retry)' : ''}`);
          } else if (articleBody.length > 200) {
            content = articleBody.slice(0, 12000);
            title = headline || title;
            extractionMethod = 'zyte-article';
            tg.d(logTag, `Stage3 ✓ zyte-article ${Date.now() - _s3}ms ${content.length}ch (article=${articleBody.length} >= browser=${browserHtmlText.length})${_a3 ? ' (retry)' : ''}`);
          } else {
            tg.d(logTag, `Stage3 zyte insufficient ${Date.now() - _s3}ms article=${articleBody.length}ch browser=${browserHtmlText.length}ch`);
          }
          break;
        } else {
          const retryable = zyteRes.status === 429 || zyteRes.status >= 500;
          tg.w(logTag, `Stage3 Zyte HTTP ${zyteRes.status} ${Date.now() - _s3}ms${_a3 ? ' (retry)' : ''}${retryable && _a3 < 1 ? ' — will retry' : ''}`);
          if (!retryable || _a3 >= 1) break;
        }
      } catch (zyteErr) {
        tg.w(logTag, `Stage3 Zyte error ${Date.now() - _s3}ms: ${zyteErr.message?.slice(0, 80)}${_a3 ? ' (retry)' : ''}`);
        if (_a3 >= 1) break;
      }
    }
  }

  // ── Stage 4: Parallel fallback — Tavily ∥ Gemini Grounding ───────────
  const stillBlocked = content.length < 500 || (paywallDetected && extractionMethod === 'direct-fetch');
  if (stillBlocked) {
    const _s4 = Date.now();
    tg.d(logTag, `Stage4 ▶ parallel research (content=${content.length}ch method=${extractionMethod} paywall=${paywallSource})`);
    const searchQuery = title
      ? `Detailed information about: ${title}`
      : `Full content and details from: ${url}`;

    const runners = [];

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      runners.push(
        (async () => {
          const _rt = Date.now();
          try {
            const tavilyRes = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tavilyKey}`,
              },
              body: JSON.stringify({
                query: searchQuery,
                search_depth: 'advanced',
                max_results: 5,
              }),
              signal: AbortSignal.timeout(20000),
            });

            if (!tavilyRes.ok) {
              tg.d(logTag, `Stage4a Tavily HTTP ${tavilyRes.status} ${Date.now() - _rt}ms`);
              return { text: '', method: 'tavily-search' };
            }

            const tavilyData = await tavilyRes.json();
            const snippets = (tavilyData?.results || [])
              .map(r => r.content || '').filter(Boolean).join('\n\n');
            const answer = tavilyData?.answer || '';
            const combined = answer
              ? `Research Summary:\n${answer}\n\nDetailed Sources:\n${snippets}`
              : snippets;

            tg.d(logTag, `Stage4a Tavily ✓ ${Date.now() - _rt}ms ${combined.length}ch (${tavilyData?.results?.length || 0} results)`);
            return { text: combined, method: 'tavily-search' };
          } catch (e) {
            tg.d(logTag, `Stage4a Tavily error ${Date.now() - _rt}ms: ${e.message?.slice(0, 60)}`);
            return { text: '', method: 'tavily-search' };
          }
        })(),
      );
    }

    if (isGroundingAvailable()) {
      runners.push(
        (async () => {
          const _rg = Date.now();
          try {
            const gr = await groundedExtract(url, title, { timeoutMs: 25000 });
            tg.d(logTag, `Stage4b Grounding ✓ ${Date.now() - _rg}ms ${gr.content.length}ch method=${gr.extractionMethod}`);
            return { text: gr.content, method: gr.extractionMethod };
          } catch (e) {
            tg.d(logTag, `Stage4b Grounding error ${Date.now() - _rg}ms: ${e.message?.slice(0, 60)}`);
            return { text: '', method: 'gemini-grounding' };
          }
        })(),
      );
    }

    if (runners.length > 0) {
      const results = await Promise.all(runners);
      const best = results
        .filter(r => r.text.length > 200)
        .sort((a, b) => b.text.length - a.text.length)[0];

      if (best) {
        content = best.text.slice(0, 12000);
        extractionMethod = best.method;
        tg.d(logTag, `Stage4 ✓ winner=${best.method} ${Date.now() - _s4}ms ${content.length}ch (${runners.length} runners)`);
      } else {
        tg.w(logTag, `Stage4 ✗ all ${runners.length} runners <200ch ${Date.now() - _s4}ms`);
      }
    } else {
      tg.w(logTag, `Stage4 ✗ no runners (tavily=${!!tavilyKey} grounding=${isGroundingAvailable()})`);
    }
  }

  return { content, title, extractionMethod, paywallSource, elapsedMs: Date.now() - _t0 };
}

// ═══════════════════════════════════════════════════════════════════════

aiRouter.post('/summarize', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AISummarizeSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const url = val.data.url;
    const wantXGrok = req.body.provider === 'xgrok';
    const pickedLiteLLMModel = _pickLiteLLMModel(val.data.liteModel, val.data.model);
    tg.d('AI/summarize', `▶ url="${url.slice(0, 80)}" provider=${req.body.provider || 'litellm'} wantXGrok=${wantXGrok} model=${pickedLiteLLMModel || '(default)'}`);

    // ── Stages 1–4: Deep content extraction ──────────────────────────
    const extracted = await deepExtractContent(url, { logTag: 'AI/summarize' });
    const { title, extractionMethod, paywallSource } = extracted;
    let content = extracted.content;

    // ── Extraction gate ──────────────────────────────────────────────
    if (!content || content.length < 100) {
      const elapsed = Date.now() - _t0;
      tg.w('AI/summarize', `✗ EXTRACTION FAILED ${elapsed}ms — ${content.length}ch after all stages, url="${url.slice(0, 60)}"`);
      return res.status(422).json({
        error: 'Could not extract content from this URL. Ensure the link is complete (starts with https://) and the page is publicly accessible.',
      });
    }

    // ── Stage 5: LLM summarization (xGrok primary → LiteLLM fallback) ────
    //
    //   Retry stack:
    //     xgrokComplete → 3× internal retry with exponential backoff (800ms–4s)
    //     callLiteLLM   → 2× retry/model + 3× for last model, cascading models
    //
    const xgrokSummarizeModel = req.body.xgrokModel;
    const hasXGrok = isXGrokAvailable();
    const useXGrokSummarize = wantXGrok && hasXGrok;

    if (wantXGrok && !hasXGrok) {
      tg.w('AI/summarize', `Client requested xGrok but XGROK_API_KEY missing — falling back to LiteLLM`);
    }

    tg.d('AI/summarize', `Stage5 ▶ provider=${useXGrokSummarize ? 'xgrok' : 'litellm'} model=${xgrokSummarizeModel || 'default'} content=${content.length}ch method=${extractionMethod}`);

    const systemPrompt = buildSummarizerSystemPrompt(url);
    const summarizeMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `URL: ${url}\n\nExtracted content:\n${content.slice(0, 10000)}` },
    ];

    let llmResult;
    let usedProvider = useXGrokSummarize ? 'xgrok' : 'litellm';
    let didFallback = false;

    if (useXGrokSummarize) {
      const xModel = xgrokSummarizeModel || resolveXGrokModel('lite');
      const _s5 = Date.now();
      try {
        llmResult = await xgrokComplete({
          model: xModel,
          messages: summarizeMessages,
          maxTokens: 3000,
          temperature: 0.3,
        });
        usedProvider = 'xgrok';
        tg.i('AI/summarize', `Stage5 ✓ xGrok model=${llmResult.model_used} ${Date.now() - _s5}ms`);
      } catch (xgrokErr) {
        const xgrokElapsed = Date.now() - _s5;
        tg.w('AI/summarize', `Stage5 ✗ xGrok FAILED ${xgrokElapsed}ms model=${xModel}: ${xgrokErr.message?.slice(0, 150)} — fallback to LiteLLM`);
        const _s5b = Date.now();
        try {
          llmResult = await callLiteLLM({
            model: pickedLiteLLMModel || undefined,
            messages: summarizeMessages,
            maxTokens: 3000,
            temperature: 0.3,
          });
          usedProvider = 'litellm (fallback)';
          didFallback = true;
          tg.i('AI/summarize', `Stage5 ✓ LiteLLM fallback model=${llmResult.model_used} ${Date.now() - _s5b}ms (xGrok failed ${xgrokElapsed}ms)`);
        } catch (litellmErr) {
          tg.e('AI/summarize', `Stage5 ✗ ALL EXHAUSTED ${Date.now() - _t0}ms — xGrok ${xgrokElapsed}ms + LiteLLM ${Date.now() - _s5b}ms: ${litellmErr.message?.slice(0, 120)}`);
          throw litellmErr;
        }
      }
    } else {
      const _s5 = Date.now();
      llmResult = await callLiteLLM({
        model: pickedLiteLLMModel || undefined,
        messages: summarizeMessages,
        maxTokens: 3000,
        temperature: 0.3,
      });
      usedProvider = 'litellm';
      tg.d('AI/summarize', `Stage5 ✓ LiteLLM model=${llmResult.model_used} ${Date.now() - _s5}ms`);
    }

    // ── Parse & respond ──────────────────────────────────────────────────
    const parsed = parseJsonContent(llmResult.content);
    const summary = asString(parsed?.summary || parsed?.content || '');
    const rawKeyPoints = parsed?.keyPoints || parsed?.key_points || parsed?.highlights || parsed?.takeaways || [];
    const keyPoints = (Array.isArray(rawKeyPoints) ? rawKeyPoints : [])
      .map(p => asString(p)).filter(Boolean);

    const elapsed = Date.now() - _t0;
    tg.i('AI/summarize', `✓ DONE ${elapsed}ms provider=${usedProvider} model=${llmResult.model_used} method=${extractionMethod} paywall=${paywallSource} fallback=${didFallback} content=${content.length}ch summary=${summary.length}ch keys=${keyPoints.length} url="${url.slice(0, 60)}"`);
    res.json({
      title: asString(parsed?.title || title || ''),
      summary: summary || 'Summary could not be generated.',
      keyPoints,
      category: asString(parsed?.category || ''),
      readTime: typeof parsed?.readTime === 'number' ? parsed.readTime : (parseInt(parsed?.readTime) || 3),
      source: asString(parsed?.source || ''),
      extractionMethod,
      paywallSource,
      url,
      model: llmResult.model_used,
      providerUsed: usedProvider,
      fallback: didFallback,
      usage: llmResult.usage,
    });
  } catch (err) {
    tg.e('AI/summarize', `FATAL ${Date.now() - _t0}ms url="${req.body?.url?.slice(0, 60)}": ${err.message?.slice(0, 200)}`, err);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/v1/ai/summarize-articles-batch
//
//  Batch quick-summary for the News > For You "catch up" feature. Caller
//  sends N already-extracted articles (title + condensed body) and we
//  return a 1-2 sentence summary per id using Gemini 2.5 Flash Lite via
//  LiteLLM (with automatic cascading fallback to other models if Lite is
//  down — handled by callLiteLLM's model-priority list).
//
//  The Flutter client batches client-side (10 per request, 4 concurrent)
//  so this endpoint stays simple and fast: one LLM round-trip per request.
// ═══════════════════════════════════════════════════════════════════════
aiRouter.post('/summarize-articles-batch', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AISummarizeArticlesBatchSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { articles } = val.data;
    // Hard rule: the user's settings.liteModel is the source of truth. Only
    // fall back to a server-resolved model when the client has somehow
    // omitted both `liteModel` and the legacy `model` field — this should
    // never happen in normal operation because the Flutter SettingsController
    // always seeds liteModel before any AI call.
    let requestedModel = _pickLiteLLMModel(val.data.liteModel, val.data.model);
    if (!requestedModel) {
      const dbModel = await getConfiguredLiteModel();
      if (dbModel) {
        tg.w('AI/summarize-batch', `Client omitted liteModel — using server-cached settings model ${dbModel}`);
        requestedModel = dbModel;
      } else {
        tg.w('AI/summarize-batch', 'No liteModel set anywhere — falling back to LiteLLM priority list');
      }
    }

    tg.d('AI/summarize-batch', `▶ ${articles.length} articles model=${requestedModel || '(priority-list)'}`);

    // ── Thin-content enrichment ──────────────────────────────────────────
    // Feeds ingested without full-body extraction leave the client with
    // little more than the title, so the model can only produce a
    // headline-shape briefing ("the summary doesn't explain anything").
    // When the client supplies the article URL, deep-extract the real body
    // here first. Guard rails: only articles under 350 chars of content,
    // at most 3 per request (the on-demand reader flow sends exactly 1),
    // each capped at 25 s so a slow site can never stall the whole batch.
    // Any failure falls back silently to the client-provided content.
    const enrichedContent = new Map();
    const _thin = articles.filter((a) =>
      (a.content || '').trim().length < 350 && /^https?:\/\//i.test(a.url || ''));
    const _toEnrich = _thin.slice(0, 3);
    if (_toEnrich.length > 0) {
      const _e0 = Date.now();
      tg.d('AI/summarize-batch', `Enrich ▶ ${_toEnrich.length}/${articles.length} thin article(s) via deep-extract`);
      await Promise.all(_toEnrich.map(async (a) => {
        try {
          const extracted = await Promise.race([
            deepExtractContent(a.url, { logTag: 'AI/summarize-batch' }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('enrich timeout (25s)')), 25000)),
          ]);
          const text = (extracted?.content || '').trim();
          if (text.length >= 300) {
            enrichedContent.set(a.id, text.slice(0, 8000));
            tg.i('AI/summarize-batch', `Enrich ✓ id=${a.id} ${text.length}ch method=${extracted.extractionMethod} ${Date.now() - _e0}ms`);
          } else {
            tg.w('AI/summarize-batch', `Enrich ✗ id=${a.id} only ${text.length}ch — keeping client content`);
          }
        } catch (enrichErr) {
          tg.w('AI/summarize-batch', `Enrich ✗ id=${a.id}: ${enrichErr.message?.slice(0, 100)} — keeping client content`);
        }
      }));
    }

    const userPayload = articles.map((a) => ({
      id: a.id,
      title: a.title,
      source: a.source || '',
      category: a.category || '',
      content: enrichedContent.get(a.id) || a.content,
    }));

    const messages = [
      { role: 'system', content: buildBatchArticleSummaryPrompt() },
      { role: 'user', content: JSON.stringify({ articles: userPayload }) },
    ];

    // Token budgeting (rev. 4): switched from "one giant paragraph" to
    // structured magazine format (lede + 2-4 body paragraphs separated by
    // \n\n + optional "• " bullet block). Length range bumped to 220-280
    // words/article (ceiling 350) — see prompts.js for the structure.
    //
    // Token math:
    //   • 240 words × 10 articles ≈ 2400 words ≈ 3120 output tokens.
    //   • Structured output adds ~80 tokens/article in JSON envelope
    //     overhead vs. flat (each "\n\n" is 2 chars, bullet markers
    //     add 2 chars each, multiple paragraph boundaries add escape
    //     density). Envelope total ≈ 1000 tokens.
    //   • Nominal total ≈ 4100 tokens. Verbose batch (350-word ceiling
    //     hit by every article + lots of bullets) ≈ 5500 tokens.
    //   • maxTokens 6500 leaves ~18% headroom over verbose case AND stays
    //     comfortably below Flash Lite's 8K output ceiling.
    //   • Lower temperature (0.2) keeps output deterministic and
    //     discourages the model from padding paragraphs with filler.
    let llmResult;
    try {
      llmResult = await callLiteLLM({
        model: requestedModel || undefined,
        messages,
        maxTokens: 6500,
        temperature: 0.2,
      });
    } catch (firstErr) {
      // Settings-model failed (likely transient or temporarily missing on
      // LiteLLM). Retry once with the discovered priority list so the user
      // still gets a response — but logged loudly so we can investigate.
      tg.w('AI/summarize-batch', `Settings model ${requestedModel || '(none)'} failed: ${firstErr.message?.slice(0, 120)} — trying priority list`);
      llmResult = await callLiteLLM({
        messages,
        maxTokens: 6500,
        temperature: 0.2,
      });
    }

    let parsed;
    try {
      parsed = parseJsonContent(llmResult.content);
    } catch (parseErr) {
      tg.w('AI/summarize-batch', `JSON parse failed model=${llmResult.model_used} contentLen=${llmResult.content?.length || 0}: ${parseErr.message?.slice(0, 100)}`);
      parsed = { summaries: [] };
    }

    // Build a Map keyed by id so we tolerate model reordering / dropped items.
    const byId = new Map();
    const rawArr = Array.isArray(parsed?.summaries) ? parsed.summaries : [];
    for (const item of rawArr) {
      if (!item || typeof item !== 'object') continue;
      const id = asString(item.id);
      const summary = asString(item.summary);
      if (id && summary) byId.set(id, summary);
    }

    // Always echo every requested id; fill missing with a safe headline-only fallback
    // so the client can render something instead of getting a 200 with gaps.
    const summaries = articles.map((a) => ({
      id: a.id,
      summary: byId.get(a.id) || `Headline: ${a.title}`,
    }));

    const elapsed = Date.now() - _t0;
    const fallbacks = articles.length - byId.size;
    tg.i('AI/summarize-batch', `✓ ${articles.length} articles ${elapsed}ms model=${llmResult.model_used} fallback=${fallbacks}`);

    res.json({
      summaries,
      model: llmResult.model_used,
      count: articles.length,
      fallbackCount: fallbacks,
      usage: llmResult.usage,
    });
  } catch (err) {
    tg.e('AI/summarize-batch', `FATAL ${Date.now() - _t0}ms count=${req.body?.articles?.length || 0}: ${err.message?.slice(0, 200)}`, err);
    next(err);
  }
});

// POST /api/v1/ai/smart-parse
const AISmartParseSchema = z.object({
  text: z.string().min(2).max(6000),
  liteModel: z.string().max(200).optional(),
  // Generous bounds so a user with many cards / a long bank name never gets a
  // hard 400 on parsing; the prompt builder sanitises the contents anyway.
  banks: z.array(z.string().max(64)).max(100).optional(),
});

aiRouter.post('/smart-parse', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AISmartParseSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { text, banks } = val.data;
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, undefined);
    console.log('[AI] smart-parse →', text);
    tg.d('AI/smart-parse', `text="${text.slice(0, 60)}", model=${pickedModel || '(default)'}, banks=${(banks || []).length}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: buildSmartParseSystemPrompt(banks) },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      maxTokens: 500,
    });

    console.log('[AI] smart-parse raw:', result.content);

    let parsed;
    try {
      parsed = parseJsonContent(result.content);
    } catch {
      return res.status(422).json({ error: 'Failed to parse LLM response', raw: result.content });
    }

    tg.i('AI/smart-parse', `✓ model=${result.model_used} ${Date.now() - _t0}ms, category=${parsed.category || 'Others'}`);
    res.json({
      amount: typeof parsed.amount === 'number' ? parsed.amount : parseFloat(parsed.amount) || 0,
      description: parsed.description || text,
      bank: parsed.bank || '',
      cardType: parsed.cardType || parsed.card_type || '',
      category: parsed.category || 'Others',
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/smart-parse', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/smart-parse-image
//
// Vision variant of /smart-parse for the web app's receipt/bill scanning.
// The Android app does on-device OCR (ML Kit) then calls /smart-parse with the
// extracted text; browsers can't do that, so this endpoint accepts the image
// (base64) directly, runs it through the same image-preprocess pipeline, and
// asks the user's Gemini lite model to extract the expense fields using the
// EXACT same SMART_PARSE_SYSTEM_PROMPT. Response shape is identical to
// /smart-parse so the client maps it the same way. Additive — the Android app
// never calls this.
const AISmartParseImageSchema = z.object({
  image: z.string().min(8), // raw base64 (no data: prefix) or data URL
  imageMediaType: z.string().max(100).optional(),
  liteModel: z.string().max(200).optional(),
  deepModel: z.string().max(200).optional(),
  banks: z.array(z.string().max(64)).max(100).optional(),
});

aiRouter.post('/smart-parse-image', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AISmartParseImageSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    if (!isGroundingAvailable()) {
      tg.w('AI/smart-parse-image', 'No GOOGLE_API_KEY — vision receipt parse unavailable');
      return res.status(503).json({ error: 'Vision parsing is not configured on the server' });
    }

    const { image, imageMediaType, liteModel, deepModel, banks } = val.data;
    const validation = _validateImagePayloadShared(image, imageMediaType);
    if (!validation.ok) {
      tg.d('AI/smart-parse-image', `400 validation: ${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }

    const prep = await preprocessForVision(validation.base64, validation.mediaType);
    const visionModel = resolveGroundingMode('lite', deepModel, liteModel);

    tg.d('AI/smart-parse-image',
      `model=${visionModel || '(default)'} media=${prep.mediaType} bytes=${(prep.processedBytes / 1024).toFixed(0)}KB`);

    const result = await geminiComplete({
      model: visionModel,
      messages: [
        { role: 'system', content: buildSmartParseSystemPrompt(banks) },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${prep.mediaType};base64,${prep.base64}` },
            },
            {
              type: 'text',
              text: 'This is a receipt, bill, or payment screenshot. Extract the single expense '
                + '(pick the LARGEST grand-total, use the merchant name as description) and return ONLY the JSON object.',
            },
          ],
        },
      ],
      temperature: 0.1,
      maxTokens: 500,
      jsonOutput: true,
    });

    let parsed;
    try {
      parsed = parseJsonContent(result.content);
    } catch {
      return res.status(422).json({ error: 'Failed to parse LLM response', raw: result.content });
    }

    tg.i('AI/smart-parse-image', `✓ model=${result.model_used || visionModel} ${Date.now() - _t0}ms, category=${parsed.category || 'Others'}`);
    res.json({
      amount: typeof parsed.amount === 'number' ? parsed.amount : parseFloat(parsed.amount) || 0,
      description: parsed.description || '',
      bank: parsed.bank || '',
      cardType: parsed.cardType || parsed.card_type || '',
      category: parsed.category || 'Others',
      model: result.model_used || visionModel,
      usage: result.usage,
    });
  } catch (err) {
    if (err && (err.name === 'GeminiDirectError')) {
      tg.e('AI/smart-parse-image', `FATAL ${Date.now() - _t0}ms [${err.code}]`, err);
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    tg.e('AI/smart-parse-image', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/categorize
const AICategorizeSchema = z.object({
  description: z.string().min(2).max(500),
  liteModel: z.string().max(200).optional(),
});

aiRouter.post('/search', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const { query } = req.body || {};
    if (!query || String(query).trim().length < 2) {
      return res.status(400).json({ error: 'query is required (min 2 chars)' });
    }

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'TAVILY_API_KEY not configured' });
    }

    console.log('[AI] Tavily search →', String(query).trim());
    tg.d('AI/search', `model=tavily q="${String(query).trim().slice(0, 80)}"`);

    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: String(query).trim(),
        search_depth: 'advanced',
        include_answer: true,
        include_raw_content: false,
        max_results: 5,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!tavilyRes.ok) {
      const errText = await tavilyRes.text();
      console.warn('[AI] Tavily error:', tavilyRes.status, errText.slice(0, 200));
      return res.status(tavilyRes.status).json({
        error: `Tavily API error: ${errText.slice(0, 300)}`,
      });
    }

    const data = await tavilyRes.json();
    tg.i('AI/search', `✓ model=tavily ${Date.now() - _t0}ms, results=${(data.results || []).length}`);
    res.json({
      answer: data.answer || '',
      query: data.query || query,
      results: (data.results || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        content: r.content || '',
        score: r.score || 0,
      })),
    });
  } catch (err) {
    tg.e('AI/search', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/grounded-search  (Gemini + Google Search  OR  xGrok + web_search)
// Production-grade: primary provider → cross-provider fallback → LLM error notice.
// Both xgrokSearch and groundedSearch have internal retries (3× with backoff).
//
// Body params:
//   query              required, the search query (min 2 chars)
//   provider           optional, 'xgrok' to prefer xGrok, else Gemini
//   mode               optional, 'lite' (default) | 'deep' | 'thinking'
//   model              optional legacy, raw Gemini model override
//   xgrokModel         optional legacy, raw xGrok model override (treated as lite)
//   deepModel          optional, Gemini deep model id when mode='deep'
//   xgrokLiteModel     optional, xGrok lite model id when mode='lite'
//   xgrokDeepModel     optional, xGrok deep model id when mode='deep'
//   xgrokThinkingModel optional, xGrok thinking model id when mode='thinking'
//
// Default mode is 'lite' to preserve historical behaviour for callers that
// only sent {query, provider, xgrokModel?}.
aiRouter.post('/grounded-search', async (req, res, next) => {
  const _t0 = Date.now();
  let providerTag = 'gemini';
  try {
    const {
      query,
      model,
      provider,
      xgrokModel,
      mode,
      deepModel,
      liteModel,
      xgrokLiteModel,
      xgrokDeepModel,
      xgrokThinkingModel,
    } = req.body || {};
    if (!query || String(query).trim().length < 2) {
      return res.status(400).json({ error: 'query is required (min 2 chars)' });
    }

    const wantXGrok = provider === 'xgrok';
    const useXGrok = wantXGrok && isXGrokAvailable();
    const trimmedQ = String(query).trim();
    providerTag = useXGrok ? 'xgrok' : 'gemini';
    const hasGemini = isGroundingAvailable();
    const hasXGrok = isXGrokAvailable();

    // Normalise mode: lite is the safe default (matches legacy behaviour).
    const effMode = (mode === 'deep' || mode === 'thinking') ? mode : 'lite';
    const isDeep = effMode !== 'lite';

    // Resolve provider-specific models. Legacy `model`/`xgrokModel` take
    // precedence as raw overrides for callers that don't yet send `mode`.
    const resolvedGeminiModel = model
      ? String(model)
      : resolveGroundingMode(effMode, deepModel, liteModel);
    const resolvedXGrokModel = resolveXGrokModel(
      effMode,
      xgrokLiteModel || xgrokModel,
      xgrokDeepModel,
      xgrokThinkingModel,
    );

    // Adaptive timeouts — deep / thinking models need significantly longer.
    // These are upper bounds; the providers' own retries still apply within.
    const geminiTimeoutMs = isDeep ? 75000 : 30000;
    const xgrokTimeoutMs = isDeep ? 120000 : 75000;

    tg.d('AI/grounded-search',
      `provider=${providerTag} mode=${effMode} model=${useXGrok ? resolvedXGrokModel : (resolvedGeminiModel || 'default')} `
      + `q="${trimmedQ.slice(0, 80)}" gemini=${hasGemini} xgrok=${hasXGrok}`);

    if (!useXGrok && !hasGemini) {
      tg.e('AI/grounded-search', `No provider available: gemini=${hasGemini} xgrok=${hasXGrok}`);
      return res.status(503).json({ error: 'No search provider configured' });
    }

    let result;
    let usedProvider = providerTag;

    // ── Primary provider attempt ──────────────────────────────────────
    try {
      if (useXGrok) {
        result = await xgrokSearch(trimmedQ, {
          model: resolvedXGrokModel,
          timeoutMs: xgrokTimeoutMs,
        });
        if (result.sources) {
          result.sources = result.sources.map((s, i) => ({ index: i, title: s.title || '', url: s.url || '' }));
        }
      } else {
        result = await groundedSearch(trimmedQ, {
          model: resolvedGeminiModel,
          timeoutMs: geminiTimeoutMs,
        });
      }
    } catch (primaryErr) {
      const elapsed = Date.now() - _t0;
      tg.w('AI/grounded-search', `Primary ${providerTag} (${effMode}) failed ${elapsed}ms, attempting cross-provider fallback`, primaryErr);

      // ── Cross-provider fallback ───────────────────────────────────
      // Cross-fallback intentionally drops to LITE on the alternate provider
      // so the user still gets a result quickly when their preferred
      // deep/thinking path is unavailable.
      const canFallbackToGemini = useXGrok && hasGemini;
      const canFallbackToXGrok = !useXGrok && hasXGrok;

      if (canFallbackToGemini) {
        try {
          result = await groundedSearch(trimmedQ, {
            model: resolveGroundingMode('lite', undefined, liteModel),
            timeoutMs: 30000,
          });
          usedProvider = 'gemini (fallback)';
          tg.i('AI/grounded-search', `Cross-fallback xgrok→gemini succeeded ${Date.now() - _t0}ms`);
        } catch (fallbackErr) {
          tg.w('AI/grounded-search', `Cross-fallback gemini also failed`, fallbackErr);
        }
      } else if (canFallbackToXGrok) {
        try {
          const xModel = resolveXGrokModel('lite', xgrokLiteModel || xgrokModel);
          result = await xgrokSearch(trimmedQ, { model: xModel, timeoutMs: 75000 });
          if (result.sources) {
            result.sources = result.sources.map((s, i) => ({ index: i, title: s.title || '', url: s.url || '' }));
          }
          usedProvider = 'xgrok (fallback)';
          tg.i('AI/grounded-search', `Cross-fallback gemini→xgrok succeeded ${Date.now() - _t0}ms`);
        } catch (fallbackErr) {
          tg.w('AI/grounded-search', `Cross-fallback xgrok also failed`, fallbackErr);
        }
      }

      // ── All providers exhausted → graceful LLM error notice ────────
      if (!result) {
        tg.e('AI/grounded-search', `All providers exhausted ${Date.now() - _t0}ms, falling back to LLM error notice`);
        result = await _notifyGroundingError(primaryErr);
      }
    }

    const elapsed = Date.now() - _t0;
    if (!result.fallback) {
      tg.i('AI/grounded-search', `✓ provider=${usedProvider} mode=${effMode} model=${result.model} ${elapsed}ms, ${(result.sources || []).length} sources`);
    }
    res.json({
      answer: result.text,
      query: trimmedQ,
      model: result.model,
      mode: effMode,
      searchQueries: result.searchQueries || [],
      sources: result.sources || [],
      citations: result.citations || [],
      usage: result.usage,
      fallback: result.fallback || false,
    });
  } catch (err) {
    const elapsed = Date.now() - _t0;
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      tg.e('AI/grounded-search', `FATAL provider=${providerTag} ${elapsed}ms [${err.code}]`, err);
      return res.status(err.status || 500).json({
        error: err.message,
        code: err.code,
      });
    }
    tg.e('AI/grounded-search', `FATAL provider=${providerTag} ${elapsed}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/search-followup  (Gemini + Google Search — follow-up on a search result)
aiRouter.post('/search-followup', async (req, res, next) => {
  const _t0 = Date.now();
  let modelTag = 'default';
  try {
    const { query, initialAnswer, question, history, model, mode, deepModel, liteModel, provider, searchRequired, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel } = req.body || {};

    if (!question || String(question).trim().length < 2) {
      return res.status(400).json({ error: 'question is required (min 2 chars)' });
    }

    const useXGrok = provider === 'xgrok' && isXGrokAvailable();

    if (!useXGrok && !isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const resolvedModel = useXGrok
      ? resolveXGrokModel(mode, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel)
      : (model ? String(model) : resolveGroundingMode(mode, deepModel, liteModel));
    const safeQuery = String(query || '').slice(0, 500);
    const trimmedQ = String(question).trim();
    const histLen = Array.isArray(history) ? history.length : 0;
    modelTag = resolvedModel || mode || 'default';
    const providerTag = useXGrok ? 'xgrok' : 'gemini';
    const forceSearch = searchRequired !== false;
    const cacheKey = `sf::${providerTag}::${safeQuery}::${trimmedQ.slice(0, 200)}::${histLen}::${modelTag}`;
    tg.d('AI/search-followup', `provider=${providerTag} model=${modelTag} mode=${mode || 'deep'} hist=${histLen} forceSearch=${forceSearch}`);

    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[SearchFollowUp] DB cache hit — returning instantly');
      tg.d('AI/search-followup', `Cache hit model=${dbCached.model || modelTag} ${Date.now() - _t0}ms`);
      return res.json(dbCached);
    }

    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[SearchFollowUp] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const answerSnippet = String(initialAnswer || '').slice(0, 1500);
    const searchToolName = useXGrok ? 'web_search' : 'Google Search';

    const searchDirective = forceSearch
      ? `\n\nCRITICAL: You MUST use ${searchToolName} for EVERY response, without exception. ` +
        `Even if you believe you know the answer, ALWAYS search first to ensure accuracy and recency. ` +
        `NEVER rely on your training data alone — your training data is outdated. ` +
        `Search the web first, verify with live results, then compose your answer. ` +
        `If the question involves dates, events, scores, news, people, or anything that could change over time, searching is MANDATORY.`
      : '';

    const systemInstruction =
      `You are a knowledgeable research assistant with access to ${searchToolName}. ` +
      `The user previously searched for "${safeQuery}"` +
      (answerSnippet
        ? ` and received this initial answer:\n\n---\n${answerSnippet}\n---\n\n`
        : '. ') +
      `Answer follow-up questions using ${searchToolName} for the latest real-time information. ` +
      `Provide comprehensive, well-structured answers with markdown formatting. ` +
      `Cite sources when possible. Maintain conversation continuity across follow-ups.` +
      searchDirective;

    const turns = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h && h.role && h.text) {
          turns.push({ role: String(h.role), text: String(h.text).slice(0, 4000) });
        }
      }
    }
    turns.push({ role: 'user', text: trimmedQ });

    const converseOpts = { timeoutMs: 90000, maxTokens: 8192, temperature: 0.7 };
    if (resolvedModel) converseOpts.model = resolvedModel;

    const apiPromise = (async () => {
      try {
        const result = useXGrok
          ? await xgrokConverse(turns, systemInstruction, converseOpts)
          : await groundedConverse(turns, systemInstruction, converseOpts);
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources || [],
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (primaryErr) {
        const elapsedPrimary = Date.now() - _t0;
        tg.w('AI/search-followup', `Primary ${providerTag} FAILED ${elapsedPrimary}ms — attempting cross-provider fallback`, primaryErr);

        const canFallbackToGemini = useXGrok && isGroundingAvailable();
        const canFallbackToXGrok = !useXGrok && isXGrokAvailable();
        const fallbackOpts = { timeoutMs: 90000, maxTokens: 8192, temperature: 0.7 };

        if (canFallbackToGemini) {
          try {
            const fbResult = await groundedConverse(turns, systemInstruction, fallbackOpts);
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/search-followup', `✓ Cross-fallback xgrok→gemini SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/search-followup', `Cross-fallback gemini ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        } else if (canFallbackToXGrok) {
          try {
            const xModel = process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning';
            const fbResult = await xgrokConverse(turns, systemInstruction, { ...fallbackOpts, model: xModel });
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/search-followup', `✓ Cross-fallback gemini→xgrok SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/search-followup', `Cross-fallback xgrok ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        }

        _inflight.delete(cacheKey);
        tg.e('AI/search-followup', `ALL providers exhausted ${Date.now() - _t0}ms — delivering LLM error notice`);
        const fb = await _notifyGroundingError(primaryErr);
        return { answer: fb.text, model: fb.model, sources: [], searchQueries: [], fallback: true };
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!response.fallback) {
      tg.i('AI/search-followup', `✓ provider=${providerTag} model=${response.model || modelTag} ${Date.now() - _t0}ms, ${(response.sources || []).length} sources`);
    }
    if (!res.headersSent) res.json(response);
  } catch (err) {
    tg.e('AI/search-followup', `Failed model=${modelTag} ${Date.now() - _t0}ms`, err);
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ── Gemini response cache — survives client disconnects AND server restarts ───
// When the user minimizes the app, Android kills the TCP socket, but the Gemini
// call continues on the backend. Completed results are persisted in Postgres so
// the client's retry (even hours later) gets an instant cache hit.
//
// Architecture:
//   • Postgres `ai_response_cache` table — persistent, survives restarts (24h TTL)
//   • In-memory Map — only for in-flight promise deduplication (ephemeral)
const _inflight = new Map();

setInterval(async () => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ai_response_cache WHERE created_at < NOW() - INTERVAL '24 hours'`,
    );
    if (rowCount > 0) console.log(`[Cache] Cleaned ${rowCount} expired entries`);
  } catch { /* ignore cleanup errors */ }
  const now = Date.now();
  for (const [k, v] of _inflight) {
    if (!v.pending || now - v.ts > 5 * 60 * 1000) _inflight.delete(k);
  }
}, 10 * 60 * 1000).unref(); // every 10 minutes

async function _getFromDbCache(key) {
  try {
    const { rows } = await pool.query(
      `SELECT result_json FROM ai_response_cache
       WHERE cache_key = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [key],
    );
    return rows[0]?.result_json ?? null;
  } catch { return null; }
}

async function _putToDbCache(key, result) {
  try {
    await pool.query(
      `INSERT INTO ai_response_cache (cache_key, result_json)
       VALUES ($1, $2)
       ON CONFLICT (cache_key) DO UPDATE SET result_json = $2, created_at = NOW()`,
      [key, JSON.stringify(result)],
    );
  } catch (e) {
    console.warn('[Cache] DB write failed:', e.message?.slice(0, 120));
  }
}

// POST /api/v1/ai/deep-research  (Gemini 3.1 Pro / xGrok + search — thorough URL analysis)
aiRouter.post('/deep-research', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const { url, question, history, deepModel, provider, xgrokDeepModel, xgrokThinkingModel } = req.body || {};

    if (!url || String(url).trim().length < 5) {
      return res.status(400).json({ error: 'url is required' });
    }

    const useXGrok = provider === 'xgrok' && isXGrokAvailable();

    if (!useXGrok && !isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const resolvedModel = useXGrok
      ? resolveXGrokModel('deep', undefined, xgrokDeepModel, xgrokThinkingModel)
      : (deepModel || undefined);
    const providerTag = useXGrok ? 'xgrok' : 'gemini';
    const safeUrl = String(url).slice(0, 500);
    const safeQuestion = question ? String(question).trim() : '';
    const histLen = Array.isArray(history) ? history.length : 0;
    const cacheKey = `dr::${providerTag}::${safeUrl}::${(safeQuestion || 'init').slice(0, 200)}::${histLen}`;
    tg.d('AI/deep-research', `provider=${providerTag} model=${resolvedModel || 'default'} hist=${histLen} url="${safeUrl.slice(0, 60)}"`);

    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[DeepResearch] DB cache hit — returning instantly');
      return res.json(dbCached);
    }

    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[DeepResearch] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const searchToolName = useXGrok ? 'web_search' : 'Google Search';
    const systemInstruction =
      `You are an expert deep research analyst with access to ${searchToolName}. ` +
      `The user has provided a URL: ${safeUrl}\n\n` +
      `IMPORTANT: Use ${searchToolName} to find and read the ORIGINAL page at that URL plus any related articles, sources, and references. ` +
      `Provide an extremely thorough, well-structured analysis. Use markdown formatting with headers, bullet points, bold, and tables where appropriate.\n\n` +
      `If this is the first message (no conversation history), perform a DEEP RESEARCH analysis:\n` +
      `1. **Overview** — What is this page about?\n` +
      `2. **Key Findings** — Main points, data, arguments\n` +
      `3. **Context & Background** — Related information from other sources\n` +
      `4. **Critical Analysis** — Strengths, weaknesses, biases\n` +
      `5. **Related Sources** — Other articles/papers on the topic\n\n` +
      `If this is a follow-up question, answer it using the original URL content and any new web search results. ` +
      `Maintain conversation continuity.`;

    const turns = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h && h.role && h.text) {
          turns.push({ role: String(h.role), text: String(h.text).slice(0, 4000) });
        }
      }
    }
    turns.push({
      role: 'user',
      text: safeQuestion || `Perform a deep research analysis of: ${safeUrl}`,
    });

    const deepOpts = { model: resolvedModel, timeoutMs: 120000, maxTokens: 8192, temperature: 0.5 };

    const apiPromise = (async () => {
      try {
        const result = useXGrok
          ? await xgrokConverse(turns, systemInstruction, deepOpts)
          : await groundedConverse(turns, systemInstruction, deepOpts);
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources || [],
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (primaryErr) {
        const elapsedPrimary = Date.now() - _t0;
        tg.w('AI/deep-research', `Primary ${providerTag} FAILED ${elapsedPrimary}ms — attempting cross-provider fallback`, primaryErr);

        const canFallbackToGemini = useXGrok && isGroundingAvailable();
        const canFallbackToXGrok = !useXGrok && isXGrokAvailable();
        const fallbackDeepOpts = { timeoutMs: 120000, maxTokens: 8192, temperature: 0.5 };

        if (canFallbackToGemini) {
          try {
            const fbResult = await groundedConverse(turns, systemInstruction, fallbackDeepOpts);
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/deep-research', `✓ Cross-fallback xgrok→gemini SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/deep-research', `Cross-fallback gemini ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        } else if (canFallbackToXGrok) {
          try {
            const xModel = process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning';
            const fbResult = await xgrokConverse(turns, systemInstruction, { ...fallbackDeepOpts, model: xModel });
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/deep-research', `✓ Cross-fallback gemini→xgrok SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/deep-research', `Cross-fallback xgrok ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        }

        _inflight.delete(cacheKey);
        tg.e('AI/deep-research', `ALL providers exhausted ${Date.now() - _t0}ms — delivering LLM error notice`);
        const fb = await _notifyGroundingError(primaryErr);
        return { answer: fb.text, model: fb.model, sources: [], searchQueries: [], fallback: true };
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!response.fallback) {
      tg.i('AI/deep-research', `✓ provider=${providerTag} model=${response.model || resolvedModel || 'default'} ${Date.now() - _t0}ms, ${(response.sources || []).length} sources`);
    }
    if (!res.headersSent) res.json(response);
  } catch (err) {
    tg.e('AI/deep-research', `Failed ${Date.now() - _t0}ms`, err);
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// POST /api/v1/ai/article-followup  (Gemini/xGrok + search — multi-turn)
aiRouter.post('/article-followup', async (req, res, next) => {
  const _t0 = Date.now();
  let modelTag = 'default';
  try {
    const { articleUrl, articleTitle, question, history, model, mode, deepModel, liteModel, provider, searchRequired, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel } = req.body || {};

    if (!question || String(question).trim().length < 2) {
      return res.status(400).json({ error: 'question is required (min 2 chars)' });
    }

    const useXGrok = provider === 'xgrok' && isXGrokAvailable();

    if (!useXGrok && !isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const resolvedModel = useXGrok
      ? resolveXGrokModel(mode, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel)
      : (model ? String(model) : resolveGroundingMode(mode, deepModel, liteModel));
    const safeTitle = String(articleTitle || 'this article').slice(0, 200);
    const safeUrl = String(articleUrl || '').slice(0, 500);
    const trimmedQ = String(question).trim();
    const histLen = Array.isArray(history) ? history.length : 0;
    modelTag = resolvedModel || mode || 'default';
    const providerTag = useXGrok ? 'xgrok' : 'gemini';
    const forceSearch = searchRequired !== false;
    const cacheKey = `fu::${providerTag}::${safeUrl}::${trimmedQ.slice(0, 200)}::${histLen}::${modelTag}`;
    tg.d('AI/article-followup', `provider=${providerTag} model=${modelTag} mode=${mode || 'deep'} hist=${histLen} forceSearch=${forceSearch}`);

    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[FollowUp] DB cache hit — returning instantly');
      return res.json(dbCached);
    }

    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[FollowUp] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const searchToolName = useXGrok ? 'web_search' : 'Google Search';

    const searchDirective = forceSearch
      ? `\n\nCRITICAL: You MUST use ${searchToolName} for EVERY response, without exception. ` +
        `Even if you believe you know the answer, ALWAYS search first to ensure accuracy and recency. ` +
        `NEVER rely on your training data alone — your training data is outdated. ` +
        `Search the web first, verify with live results, then compose your answer. ` +
        `If the question involves dates, events, scores, news, people, or anything that could change over time, searching is MANDATORY.`
      : '';

    const systemInstruction =
      `You are an expert news analyst and research assistant. ` +
      `The user is reading an article titled "${safeTitle}"` +
      (safeUrl ? ` (source: ${safeUrl}).` : '.') +
      `\n\nIMPORTANT: Use the ${searchToolName} tool to find the ORIGINAL source article and any related real-time information. ` +
      `Do NOT rely on any pre-summarized version — always base your answers on the actual source content and live web data. ` +
      `Provide comprehensive, accurate, well-structured answers. Cite sources when possible. ` +
      `If the user asks a follow-up, use the conversation context to maintain continuity.` +
      searchDirective;

    const turns = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h && h.role && h.text) {
          turns.push({ role: String(h.role), text: String(h.text).slice(0, 4000) });
        }
      }
    }
    turns.push({ role: 'user', text: trimmedQ });

    const converseOpts = { timeoutMs: 90000, maxTokens: 8192, temperature: 0.7 };
    if (resolvedModel) converseOpts.model = resolvedModel;

    const apiPromise = (async () => {
      try {
        const result = useXGrok
          ? await xgrokConverse(turns, systemInstruction, converseOpts)
          : await groundedConverse(turns, systemInstruction, converseOpts);
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources || [],
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (primaryErr) {
        const elapsedPrimary = Date.now() - _t0;
        tg.w('AI/article-followup', `Primary ${providerTag} FAILED ${elapsedPrimary}ms — attempting cross-provider fallback`, primaryErr);

        const canFallbackToGemini = useXGrok && isGroundingAvailable();
        const canFallbackToXGrok = !useXGrok && isXGrokAvailable();
        const fallbackOpts = { timeoutMs: 90000, maxTokens: 8192, temperature: 0.7 };

        if (canFallbackToGemini) {
          try {
            const fbResult = await groundedConverse(turns, systemInstruction, fallbackOpts);
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/article-followup', `✓ Cross-fallback xgrok→gemini SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/article-followup', `Cross-fallback gemini ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        } else if (canFallbackToXGrok) {
          try {
            const xModel = process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning';
            const fbResult = await xgrokConverse(turns, systemInstruction, { ...fallbackOpts, model: xModel });
            const fbElapsed = Date.now() - _t0;
            tg.i('AI/article-followup', `✓ Cross-fallback gemini→xgrok SUCCEEDED ${fbElapsed}ms model=${fbResult.model}`);
            const payload = { answer: fbResult.text, model: fbResult.model, sources: fbResult.sources || [], searchQueries: fbResult.searchQueries || [] };
            await _putToDbCache(cacheKey, payload);
            _inflight.delete(cacheKey);
            return payload;
          } catch (fbErr) {
            tg.e('AI/article-followup', `Cross-fallback xgrok ALSO failed ${Date.now() - _t0}ms`, fbErr);
          }
        }

        _inflight.delete(cacheKey);
        tg.e('AI/article-followup', `ALL providers exhausted ${Date.now() - _t0}ms — delivering LLM error notice`);
        const fb = await _notifyGroundingError(primaryErr);
        return { answer: fb.text, model: fb.model, sources: [], searchQueries: [], fallback: true };
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!response.fallback) {
      tg.i('AI/article-followup', `✓ provider=${providerTag} model=${response.model || modelTag} ${Date.now() - _t0}ms, ${(response.sources || []).length} sources`);
    }
    if (!res.headersSent) res.json(response);
  } catch (err) {
    tg.e('AI/article-followup', `Failed model=${modelTag} ${Date.now() - _t0}ms`, err);
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ── Image vision helpers ──────────────────────────────────────────
// Wire-shape validation + sha1 cache key. Validation lives in
// `image-preprocess.js` so /image-search and /image-followup stay
// byte-for-byte aligned with the Flutter client.
function _hashImage(b64) {
  return crypto.createHash('sha1').update(b64).digest('hex').slice(0, 16);
}

// ── Hedged parallel executor ──────────────────────────────────────
// Pattern: fire `primaryFn` immediately. If it hasn't resolved within
// `hedgeMs`, fire `fallbackFn` in parallel. First resolved wins.
// If primary succeeds before the timer fires we never spend a second
// API call. If primary fails fast, fallback fires immediately.
//
// `tag` is used purely for telegram log breadcrumbs.
//
// Returns `{ result, winner, hedged }` where winner is 'primary' or
// 'fallback'. Both errors are aggregated into a single error with
// `primaryError`/`fallbackError` properties if both fail.
function _hedgedRace(primaryFn, fallbackFn, hedgeMs, tag) {
  return new Promise((resolve, reject) => {
    if (!fallbackFn) {
      Promise.resolve()
        .then(primaryFn)
        .then((result) => resolve({ result, winner: 'primary', hedged: false }))
        .catch(reject);
      return;
    }

    const tStart = Date.now();
    let settled = false;
    let primaryDone = false;
    let primaryErr = null;
    let fallbackPromise = null;
    let fallbackDone = false;
    let fallbackErr = null;
    let hedged = false;

    const settle = (winner, result) => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - tStart;
      if (winner === 'fallback') {
        tg.i(tag, `Hedged FALLBACK won in ${elapsed}ms`);
      } else if (hedged) {
        tg.d(tag, `Primary won despite hedge fired (fallback abandoned) in ${elapsed}ms`);
      }
      // Detach the loser so any later reject doesn't leak.
      if (fallbackPromise) fallbackPromise.catch(() => {});
      resolve({ result, winner, hedged });
    };

    const fail = () => {
      if (settled) return;
      // Only fail when BOTH have terminated unsuccessfully.
      const fallbackTerminal = !fallbackPromise || fallbackDone;
      if (!primaryDone || !fallbackTerminal) return;
      if (!primaryErr || (fallbackPromise && !fallbackErr)) return;
      settled = true;
      const aggMsg = `[primary] ${primaryErr?.message?.slice(0, 200)}`
        + (fallbackErr ? ` | [fallback] ${fallbackErr.message?.slice(0, 200)}` : '');
      const agg = new Error(`Both providers failed: ${aggMsg}`);
      agg.name = 'AggregateProviderError';
      agg.primaryError = primaryErr;
      agg.fallbackError = fallbackErr;
      reject(agg);
    };

    const startFallback = (reason) => {
      if (fallbackPromise || settled) return;
      hedged = true;
      tg.i(tag, `${reason}, firing fallback in parallel`);
      fallbackPromise = Promise.resolve()
        .then(fallbackFn)
        .then((result) => {
          fallbackDone = true;
          settle('fallback', result);
        })
        .catch((e) => {
          fallbackDone = true;
          fallbackErr = e;
          fail();
        });
    };

    const hedgeTimer = setTimeout(() => {
      if (primaryDone) return;
      startFallback(`Primary slow (>${hedgeMs}ms)`);
    }, hedgeMs);
    if (typeof hedgeTimer.unref === 'function') hedgeTimer.unref();

    // Fire primary immediately.
    Promise.resolve()
      .then(primaryFn)
      .then((result) => {
        primaryDone = true;
        clearTimeout(hedgeTimer);
        settle('primary', result);
      })
      .catch((e) => {
        primaryDone = true;
        primaryErr = e;
        clearTimeout(hedgeTimer);
        if (!fallbackPromise) {
          startFallback(`Primary failed fast (${e?.message?.slice(0, 80) || 'unknown'})`);
        } else {
          fail(); // fallback already running; settle when it terminates
        }
      });
  });
}

// Hedge delays — fire the backup provider in parallel after this many
// ms when the primary hasn't responded. Tuned per mode so deep/thinking
// requests (which legitimately take longer) don't trip the hedge.
const _HEDGE_DELAY_MS = {
  lite: 6000,
  deep: 18000,
  thinking: 18000,
};

// POST /api/v1/ai/image-search  (Gemini Vision / xGrok Vision + search)
//
// Single-shot multimodal grounded search. Mirrors /grounded-search:
// same provider/mode/model-slot routing, same response shape
// ({answer, query, model, sources, citations, searchQueries}), with
// `image` (base64) + `imageMediaType` added to the request body.
//
// Robustness contract:
//   • Validation rejects in <1ms (no provider call).
//   • Image is preprocessed (resize→1568px / re-encode JPEG q=82 /
//     EXIF strip) when sharp is available — large phone photos shrink
//     to <500KB before any network egress.
//   • Hedged parallel fallback fires the alternate provider in
//     parallel after a per-mode delay; first success wins.
//   • Every retry / fallback / cache-hit / preprocessing step emits
//     a telegram breadcrumb so prod issues are post-mortem-friendly.
//   • Final tier is `_notifyGroundingError` so the client always
//     gets a typed envelope, never a raw 500.
aiRouter.post('/image-search', async (req, res, next) => {
  const _t0 = Date.now();
  let providerTag = 'gemini';
  try {
    const {
      query,
      image,
      imageMediaType,
      model,
      provider,
      xgrokModel,
      mode,
      deepModel,
      liteModel,
      xgrokLiteModel,
      xgrokDeepModel,
      xgrokThinkingModel,
    } = req.body || {};

    const rawQ = String(query || '').trim();
    // When the user uploads an image and types nothing, fall back to the
    // canonical "lens" prompt — same wording as the Anthropic chat sample,
    // so the model identifies-then-explains exactly like the reference UX.
    const trimmedQ = rawQ.length > 0 ? rawQ : IMAGE_LENS_PROMPT;
    const validation = _validateImagePayloadShared(image, imageMediaType);
    if (!validation.ok) {
      tg.d('AI/image-search', `400 validation: ${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }

    const wantXGrok = provider === 'xgrok';
    const useXGrok = wantXGrok && isXGrokAvailable();
    providerTag = useXGrok ? 'xgrok' : 'gemini';
    const hasGemini = isGroundingAvailable();
    const hasXGrok = isXGrokAvailable();

    if (!useXGrok && !hasGemini) {
      tg.e('AI/image-search', `No vision provider available: gemini=${hasGemini} xgrok=${hasXGrok} requested=${provider || 'gemini'}`);
      return res.status(503).json({ error: 'No vision search provider configured' });
    }

    const effMode = (mode === 'deep' || mode === 'thinking') ? mode : 'lite';
    const isDeep = effMode !== 'lite';

    const resolvedGeminiModel = model
      ? String(model)
      : resolveGroundingMode(effMode, deepModel, liteModel);
    const resolvedXGrokModel = resolveXGrokModel(
      effMode,
      xgrokLiteModel || xgrokModel,
      xgrokDeepModel,
      xgrokThinkingModel,
    );

    // Server-side preprocessing — resize + recompress huge phone photos.
    const prep = await preprocessForVision(validation.base64, validation.mediaType);
    if (prep.downscaled || prep.processedBytes !== prep.originalBytes) {
      tg.d('AI/image-search',
        `prep ${(prep.originalBytes / 1024).toFixed(0)}KB → ${(prep.processedBytes / 1024).toFixed(0)}KB `
        + `(${prep.downscaled ? 'resized' : 'transcoded'}) ${prep.durationMs}ms sharp=${isSharpAvailable()}`);
    }

    // Vision payloads are larger and the model has to actually look at
    // the bytes — give both providers more headroom than the text path.
    const geminiTimeoutMs = isDeep ? 90000 : 45000;
    const xgrokTimeoutMs = isDeep ? 150000 : 90000;

    tg.d('AI/image-search',
      `provider=${providerTag} mode=${effMode} model=${useXGrok ? resolvedXGrokModel : (resolvedGeminiModel || 'default')} `
      + `q="${trimmedQ.slice(0, 80)}" media=${prep.mediaType} bytes=${(prep.processedBytes / 1024).toFixed(0)}KB `
      + `gemini=${hasGemini} xgrok=${hasXGrok}`);

    // ── Build provider call thunks ─────────────────────────────────
    // Wrap both so the cross-provider fallback path can race them.
    // Both providers receive THE SAME universal-expert system prompt
    // (lifted from the cursor_ai_image_chat_prompt.md sample) — the
    // only per-provider variance is the search-tool name.
    const geminiSysInstr = buildVisionExpertPrompt({ searchTool: 'google_search' });
    const xgrokSysInstr = buildVisionExpertPrompt({ searchTool: 'web_search' });

    const geminiCall = () => groundedSearchVision(trimmedQ, prep.base64, prep.mediaType, {
      model: useXGrok ? resolveGroundingMode('lite', undefined, liteModel) : resolvedGeminiModel,
      timeoutMs: geminiTimeoutMs,
      systemInstruction: geminiSysInstr,
    });
    const xgrokCall = async () => {
      const r = await xgrokSearchVision(trimmedQ, prep.base64, prep.mediaType, {
        model: useXGrok
          ? resolvedXGrokModel
          : resolveXGrokModel('lite', xgrokLiteModel || xgrokModel),
        timeoutMs: xgrokTimeoutMs,
        systemInstruction: xgrokSysInstr,
      });
      if (r.sources) {
        r.sources = r.sources.map((s, i) => ({ index: i, title: s.title || '', url: s.url || '' }));
      }
      return r;
    };

    const primaryFn = useXGrok ? xgrokCall : geminiCall;
    const fallbackFn = useXGrok
      ? (hasGemini ? geminiCall : null)
      : (hasXGrok ? xgrokCall : null);
    const hedgeMs = _HEDGE_DELAY_MS[effMode] || _HEDGE_DELAY_MS.lite;

    let result;
    let usedProvider = providerTag;
    try {
      const race = await _hedgedRace(primaryFn, fallbackFn, hedgeMs, 'AI/image-search');
      result = race.result;
      if (race.winner === 'fallback') {
        usedProvider = useXGrok ? 'gemini (hedged)' : 'xgrok (hedged)';
      }
    } catch (raceErr) {
      const elapsed = Date.now() - _t0;
      tg.e('AI/image-search', `Both providers failed ${elapsed}ms — delivering LLM error notice`, raceErr);
      const primary = raceErr.primaryError || raceErr;
      result = await _notifyGroundingError(primary);
    }

    const elapsed = Date.now() - _t0;
    if (!result.fallback) {
      tg.i('AI/image-search', `✓ provider=${usedProvider} mode=${effMode} model=${result.model} ${elapsed}ms, ${(result.sources || []).length} sources`);
    } else {
      tg.w('AI/image-search', `⚠ degraded notice delivered (provider=${providerTag} mode=${effMode}) ${elapsed}ms`);
    }
    res.json({
      answer: result.text,
      query: trimmedQ,
      model: result.model,
      mode: effMode,
      searchQueries: result.searchQueries || [],
      sources: result.sources || [],
      citations: result.citations || [],
      usage: result.usage,
      fallback: result.fallback || false,
    });
  } catch (err) {
    const elapsed = Date.now() - _t0;
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      tg.e('AI/image-search', `FATAL provider=${providerTag} ${elapsed}ms [${err.code}]`, err);
      return res.status(err.status || 500).json({
        error: err.message,
        code: err.code,
      });
    }
    tg.e('AI/image-search', `FATAL provider=${providerTag} ${elapsed}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/image-followup  (Gemini Vision / xGrok Vision — multi-turn)
//
// Multi-turn multimodal follow-up over an image. Mirrors
// /article-followup but the body also carries `image`, `imageMediaType`,
// and an optional `initialAnswer` from the original /image-search call
// (so turn #1 still has a grounding anchor when `history` is empty).
// Response: { answer, model, sources, searchQueries }.
//
// Same robustness contract as /image-search:
//   • Validation rejects in <1ms.
//   • Image is preprocessed before egress.
//   • DB cache + in-flight dedupe (image hash + question + history).
//   • Hedged parallel fallback — backup provider fires after a delay
//     so a slow primary doesn't block the user.
//   • Graceful `_notifyGroundingError` when both providers exhaust.
aiRouter.post('/image-followup', async (req, res, next) => {
  const _t0 = Date.now();
  let modelTag = 'default';
  let providerTag = 'gemini';
  try {
    const {
      query,
      initialAnswer,
      question,
      history,
      image,
      imageMediaType,
      model,
      mode,
      deepModel,
      liteModel,
      provider,
      searchRequired,
      xgrokLiteModel,
      xgrokDeepModel,
      xgrokThinkingModel,
    } = req.body || {};

    if (!question || String(question).trim().length < 2) {
      tg.d('AI/image-followup', `400 validation: question missing/too-short`);
      return res.status(400).json({ error: 'question is required (min 2 chars)' });
    }

    const validation = _validateImagePayloadShared(image, imageMediaType);
    if (!validation.ok) {
      tg.d('AI/image-followup', `400 validation: ${validation.error}`);
      return res.status(400).json({ error: validation.error });
    }

    const wantXGrok = provider === 'xgrok';
    const useXGrok = wantXGrok && isXGrokAvailable();
    providerTag = useXGrok ? 'xgrok' : 'gemini';
    const hasGemini = isGroundingAvailable();
    const hasXGrok = isXGrokAvailable();

    if (!useXGrok && !hasGemini) {
      tg.e('AI/image-followup', `No vision provider available: gemini=${hasGemini} xgrok=${hasXGrok} requested=${provider || 'gemini'}`);
      return res.status(503).json({ error: 'No vision search provider configured' });
    }

    const effMode = (mode === 'deep' || mode === 'thinking') ? mode : 'lite';

    const resolvedModel = useXGrok
      ? resolveXGrokModel(effMode, xgrokLiteModel, xgrokDeepModel, xgrokThinkingModel)
      : (model ? String(model) : resolveGroundingMode(effMode, deepModel, liteModel));
    const safeQuery = String(query || '').slice(0, 500);
    const safeInitial = String(initialAnswer || '').slice(0, 1500);
    const trimmedQ = String(question).trim();
    const histLen = Array.isArray(history) ? history.length : 0;
    modelTag = resolvedModel || effMode || 'default';
    const forceSearch = searchRequired !== false;

    // Server-side preprocessing — same shrink logic as /image-search.
    const prep = await preprocessForVision(validation.base64, validation.mediaType);
    if (prep.downscaled || prep.processedBytes !== prep.originalBytes) {
      tg.d('AI/image-followup',
        `prep ${(prep.originalBytes / 1024).toFixed(0)}KB → ${(prep.processedBytes / 1024).toFixed(0)}KB `
        + `(${prep.downscaled ? 'resized' : 'transcoded'}) ${prep.durationMs}ms sharp=${isSharpAvailable()}`);
    }

    // Image-bound cache key — different bytes ⇒ different conversation.
    // Use the PREPROCESSED bytes so a 12MP photo and its resized form
    // collapse onto the same cache slot (the model only ever sees the
    // resized form anyway).
    const imgKey = _hashImage(prep.base64);
    const cacheKey = `if::${providerTag}::${imgKey}::${trimmedQ.slice(0, 200)}::${histLen}::${modelTag}`;
    tg.d('AI/image-followup',
      `provider=${providerTag} model=${modelTag} mode=${effMode} hist=${histLen} `
      + `media=${prep.mediaType} bytes=${(prep.processedBytes / 1024).toFixed(0)}KB forceSearch=${forceSearch}`);

    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[ImageFollowUp] DB cache hit — returning instantly');
      tg.d('AI/image-followup', `Cache hit model=${dbCached.model || modelTag} ${Date.now() - _t0}ms`);
      return res.json(dbCached);
    }

    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[ImageFollowUp] Awaiting in-flight request from prior connection');
      tg.d('AI/image-followup', `In-flight dedup hit — sharing prior promise`);
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    // Shared universal-expert prompt — same wording for Gemini and
    // xGrok, with provider-specific tool name and follow-up context
    // (original query + initial answer) interpolated. This is the
    // SAME prompt as /image-search so the reply style stays
    // consistent across the upload→follow-up arc.
    const systemInstruction = buildVisionExpertPrompt({
      searchTool: useXGrok ? 'web_search' : 'google_search',
      isFollowUp: true,
      originalQuery: safeQuery,
      originalAnswer: safeInitial,
      searchRequired: forceSearch !== false,
    });

    const turns = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h && h.role && h.text) {
          turns.push({ role: String(h.role), text: String(h.text).slice(0, 4000) });
        }
      }
    }
    turns.push({ role: 'user', text: trimmedQ });

    const converseOpts = { timeoutMs: 120000, maxTokens: 8192, temperature: 0.7 };
    if (resolvedModel) converseOpts.model = resolvedModel;
    const fbConverseOpts = { timeoutMs: 120000, maxTokens: 8192, temperature: 0.7 };

    const geminiCall = () => groundedConverseVision(turns, systemInstruction, prep.base64, prep.mediaType, useXGrok ? fbConverseOpts : converseOpts);
    const xgrokCall = () => xgrokConverseVision(
      turns,
      systemInstruction,
      prep.base64,
      prep.mediaType,
      useXGrok ? converseOpts : { ...fbConverseOpts, model: process.env.XGROK_LITE_MODEL || 'grok-4-1-fast-non-reasoning' },
    );

    const primaryFn = useXGrok ? xgrokCall : geminiCall;
    const fallbackFn = useXGrok
      ? (hasGemini ? geminiCall : null)
      : (hasXGrok ? xgrokCall : null);
    const hedgeMs = _HEDGE_DELAY_MS[effMode] || _HEDGE_DELAY_MS.lite;

    const apiPromise = (async () => {
      try {
        const race = await _hedgedRace(primaryFn, fallbackFn, hedgeMs, 'AI/image-followup');
        const result = race.result;
        if (race.winner === 'fallback') {
          tg.i('AI/image-followup', `✓ Hedged ${useXGrok ? 'xgrok→gemini' : 'gemini→xgrok'} fallback won model=${result.model} ${Date.now() - _t0}ms`);
        }
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources || [],
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (raceErr) {
        _inflight.delete(cacheKey);
        tg.e('AI/image-followup', `ALL providers exhausted ${Date.now() - _t0}ms — delivering LLM error notice`, raceErr);
        const primary = raceErr.primaryError || raceErr;
        const fb = await _notifyGroundingError(primary);
        return { answer: fb.text, model: fb.model, sources: [], searchQueries: [], fallback: true };
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!response.fallback) {
      tg.i('AI/image-followup', `✓ provider=${providerTag} model=${response.model || modelTag} ${Date.now() - _t0}ms, ${(response.sources || []).length} sources`);
    } else {
      tg.w('AI/image-followup', `⚠ degraded notice delivered (provider=${providerTag} mode=${effMode}) ${Date.now() - _t0}ms`);
    }
    if (!res.headersSent) res.json(response);
  } catch (err) {
    tg.e('AI/image-followup', `Failed provider=${providerTag} model=${modelTag} ${Date.now() - _t0}ms`, err);
    if (err.name === 'GroundingError' || err.name === 'XGrokError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

aiRouter.post('/categorize', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AICategorizeSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { description } = val.data;
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, undefined);
    console.log('[AI] categorize →', description);
    tg.d('AI/categorize', `desc="${description.slice(0, 60)}", model=${pickedModel || '(default)'}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: CATEGORIZE_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.1,
      maxTokens: 300,
    });

    console.log('[AI] categorize raw:', result.content);

    let parsed;
    try {
      parsed = parseJsonContent(result.content);
    } catch {
      return res.status(422).json({ error: 'Failed to parse LLM response', raw: result.content });
    }

    tg.i('AI/categorize', `✓ model=${result.model_used} ${Date.now() - _t0}ms, category=${parsed.category || 'Others'}`);
    res.json({
      category: parsed.category || 'Others',
      confidence: parsed.confidence || 'matched',
      reasoning: parsed.reasoning || '',
      score: typeof parsed.score === 'number' ? parsed.score : 0.85,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/categorize', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// ── POST /api/v1/ai/expense-query ───────────────────────────────
// Natural-language → STRUCTURED expense query translator.
//
// The client (Flutter) sends a free-text question ("today's expenses",
// "highest spend", "swiggy orders with comments", "food this month"), the
// device's current local time, and the list of categories in use. Gemini
// returns a small JSON "query spec" — date range, category, free-text search,
// sort and mode. The app then runs that spec against its LOCAL Drift DB
// (indexed, paginated) so results are exact, complete and fully editable, and
// scale to very large histories. No expense rows ever leave the device — only
// the question + schema hints are sent, so this stays fast and private and is
// strictly superior to embedding/RAG for precise/aggregate queries.
const AIExpenseQuerySchema = z.object({
  question: z.string().min(1).max(500),
  now: z.string().max(40).optional(),
  categories: z.array(z.string().max(40)).max(60).optional(),
  liteModel: z.string().max(200).optional(),
});

function buildExpenseQueryPrompt(nowIso, categories) {
  const cats = (categories && categories.length)
    ? categories.join(', ')
    : 'Food, Grocery, Transport, Fuel, Travel, Entertainment, Subscription, Shopping, Electronics, Fashion, Bills, Rent, Insurance, Loan, Health, Medical, Education, Family, Friends, Personal, Investment, Gifts, Charity, Donation, Pets, Others';
  return [
    'You convert a user\'s natural-language question about THEIR OWN logged expenses into a strict JSON query specification. Expenses are stored locally with a naive LOCAL wall-clock timestamp (no timezone suffix).',
    `The user\'s current local date-time is: ${nowIso}. Treat this as "now" for relative ranges (today, yesterday, this week, last month, etc.). "Today" = from 00:00:00 of the current day (inclusive) to 00:00:00 of the next day (exclusive).`,
    `Known expense categories: ${cats}.`,
    '',
    'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
    '{',
    '  "title": string,        // <=40 chars, a short heading for the result screen, e.g. "Kodaikanal trip"',
    '  "answer": string,       // <=160 chars, a friendly one-line description of what you are showing',
    '  "startIso": string|null,// inclusive lower bound as naive local ISO "YYYY-MM-DDTHH:mm:ss", or null for no lower bound',
    '  "endIso": string|null,  // EXCLUSIVE upper bound as naive local ISO, or null',
    '  "category": string|null,// one of the known categories EXACTLY, or null if the question is not category-specific',
    '  "search": string|null,  // ONE distinctive keyword to match against description/category/comments (a merchant like "swiggy" or a place like "kodaikanal"), or null',
    '  "searchAny": string[],  // SEMANTIC EXPANSION: concrete keywords related to a fuzzy/conceptual ask. A row matches if it contains ANY of them. Empty [] when not needed.',
    '  "sort": string,         // one of: "date_desc", "date_asc", "amount_desc", "amount_asc"',
    '  "limit": number,        // max rows to return, 1..500 (use 500 for broad listings)',
    '  "mode": string,         // "summary" for aggregate questions (total/how much/average/highest/lowest); "chart" when the user asks to visualize/graph/plot/show a breakdown; otherwise "list"',
    '  "chartType": string,     // when mode is "chart", one of: "category" (spend per category), "daily" (spend per day), "monthly" (spend per month). Otherwise "none".',
    '  "topic": string          // "salary" when the question is about the user\'s monthly SALARY / income / take-home / pay / hike / raise / how much they earn / how much they saved this month; otherwise "expenses".',
    '}',
    '',
    'Rules:',
    '- For "highest"/"most expensive" use sort "amount_desc"; for "lowest"/"cheapest" use "amount_asc". For superlative single-item questions you may set limit to a small number (e.g. 5) but keep mode "summary".',
    '- Map merchant/brand words (swiggy, zomato, amazon, uber, netflix...) AND place/trip names (kodaikanal, goa, manali...) to the "search" field as a SINGLE most-distinctive keyword, NOT category, unless the user explicitly names a category. For trip/cost questions, extract the place name into "search" and set mode "summary" so the total is highlighted.',
    '- SEMANTIC SEARCH: when the ask is fuzzy/conceptual ("anything related to my car", "health stuff", "food delivery", "things for the house"), populate "searchAny" with 4-12 concrete, real-world keywords that would literally appear in an expense description/comment/category for that concept. Examples: car → ["car","fuel","petrol","diesel","garage","service","tyre","insurance","parking","toll","uber","ola"]; food delivery → ["swiggy","zomato","ubereats","dominos","kfc","mcdonald"]. Use lowercase single words. You MAY also set "category" if one category clearly dominates. Leave "searchAny" as [] for precise questions.',
    '- If the user names a category concept (food, travel, bills...), set "category" to the closest known category.',
    '- VISUALIZE: if the user says visualize/visualise/graph/chart/plot/breakdown/distribution/"show me a chart", set mode "chart". Pick chartType "daily" for a short window (<= ~45 days, e.g. "last month"), "monthly" for long windows (multiple months / a year), and "category" when they want a split by category. Still set the date range / filters as usual so the chart reflects exactly that slice.',
    '- If the question is generic ("show my expenses", "everything"), set startIso/endIso/category/search to null, searchAny [], sort "date_desc", mode "list", chartType "none".',
    '- SALARY/INCOME: set "topic" to "salary" when the user asks about their salary, in-hand/take-home pay, income, monthly earnings, a raise/hike/increment, salary history, or "how much did I save this month". The app then shows the dedicated salary stats screen (it has the real numbers). For salary questions write a generic "answer" like "Here\'s your salary overview." and keep the other fields at their generic defaults. For all other questions set "topic" to "expenses".',
    '',
    'CRITICAL — NEVER HALLUCINATE: You ONLY produce this query specification. You do NOT have the user\'s data and you NEVER state, estimate, or invent any specific amount, total, count, date, merchant, or expense in the "answer" or "title". The "answer" must be a generic description of WHAT will be shown (e.g. "Here are your car-related expenses.") with NO numbers — all totals/counts are computed by the app from the database. Never invent timestamps outside reasonable bounds. Output valid JSON only.',
  ].join('\n');
}

aiRouter.post('/expense-query', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AIExpenseQuerySchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { question } = val.data;
    const nowIso = (val.data.now && val.data.now.trim()) || new Date().toISOString().slice(0, 19);
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, undefined);
    console.log('[AI] expense-query →', question);
    tg.d('AI/expense-query', `q="${question.slice(0, 80)}", model=${pickedModel || '(default)'}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: buildExpenseQueryPrompt(nowIso, val.data.categories) },
        { role: 'user', content: question },
      ],
      temperature: 0.1,
      maxTokens: 500,
      jsonOutput: true,
    });

    console.log('[AI] expense-query raw:', result.content);

    let parsed;
    try {
      parsed = parseJsonContent(result.content);
    } catch {
      return res.status(422).json({ error: 'Failed to parse LLM response', raw: result.content });
    }

    const allowedSort = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];
    const sort = allowedSort.includes(parsed.sort) ? parsed.sort : 'date_desc';
    let limit = Number(parsed.limit);
    if (!Number.isFinite(limit)) limit = 500;
    limit = Math.max(1, Math.min(500, Math.round(limit)));
    const allowedModes = ['list', 'summary', 'chart'];
    const mode = allowedModes.includes(parsed.mode) ? parsed.mode : 'list';
    const allowedCharts = ['category', 'daily', 'monthly', 'none'];
    let chartType = allowedCharts.includes(parsed.chartType) ? parsed.chartType : 'none';
    // A chart request must have a concrete chart type; default to category.
    if (mode === 'chart' && chartType === 'none') chartType = 'category';
    if (mode !== 'chart') chartType = 'none';
    const allowedTopics = ['expenses', 'salary'];
    const topic = allowedTopics.includes(parsed.topic) ? parsed.topic : 'expenses';
    const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    // Semantic expansion terms: keep clean, deduped, capped — defensive against
    // a noisy model. These only ever become literal SQL search terms client-side.
    const searchAny = [];
    if (Array.isArray(parsed.searchAny)) {
      const seen = new Set();
      for (const t of parsed.searchAny) {
        if (typeof t !== 'string') continue;
        const v = t.trim();
        if (!v || v.length > 40) continue;
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        searchAny.push(v);
        if (searchAny.length >= 12) break;
      }
    }

    tg.i('AI/expense-query', `✓ model=${result.model_used} ${Date.now() - _t0}ms, sort=${sort} mode=${mode} chart=${chartType} topic=${topic} terms=${searchAny.length}`);
    res.json({
      title: str(parsed.title) || 'Results',
      answer: str(parsed.answer) || '',
      startIso: str(parsed.startIso),
      endIso: str(parsed.endIso),
      category: str(parsed.category),
      search: str(parsed.search),
      searchAny,
      sort,
      limit,
      mode,
      chartType,
      topic,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/expense-query', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// ── POST /api/v1/ai/expense-insight ─────────────────────────────
// GENERATIVE, GROUNDED expense recommendation composer.
//
// The client computes deterministic FACTS in code (totals, top category,
// month-over-month deltas, etc. — every number is real) and sends ONLY those
// pre-computed tokens plus the user's first name. The model's single job is to
// PHRASE and ARRANGE a short, dynamic, personalized recommendation — it never
// originates a number. To reference any value it must emit a {{token}}
// placeholder that the app binds to the real figure; any bare digit is
// rejected client-side by the grounding validator (which then falls back to a
// deterministic template). So the response is fully dynamic yet structurally
// impossible to hallucinate. No raw expense rows ever leave the device.
const AIExpenseInsightSchema = z.object({
  question: z.string().min(1).max(500),
  firstName: z.string().max(60).optional(),
  // The computed token map: { tokenName: { display: string, value?: number } }.
  facts: z.record(z.any()).optional(),
  liteModel: z.string().max(200).optional(),
});

aiRouter.post('/expense-insight', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const val = validate(AIExpenseInsightSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { question } = val.data;
    const firstName = (val.data.firstName && val.data.firstName.trim()) || 'there';
    const facts = (val.data.facts && typeof val.data.facts === 'object' && !Array.isArray(val.data.facts))
      ? val.data.facts
      : {};
    const pickedModel = _pickLiteLLMModel(val.data.liteModel, undefined);
    console.log('[AI] expense-insight →', question);
    tg.d('AI/expense-insight', `q="${question.slice(0, 60)}", name=${firstName}, tokens=${Object.keys(facts).length}, model=${pickedModel || '(default)'}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: [
        { role: 'system', content: buildExpenseInsightPrompt(firstName, facts) },
        { role: 'user', content: question },
      ],
      temperature: 0.45,
      maxTokens: 600,
      jsonOutput: true,
    });

    let parsed;
    try {
      parsed = parseJsonContent(result.content);
    } catch {
      return res.status(422).json({ error: 'Failed to parse LLM response', raw: result.content });
    }

    const clean = sanitizeInsightResponse(parsed);
    tg.i('AI/expense-insight', `✓ model=${result.model_used} ${Date.now() - _t0}ms tone=${clean.tone} chips=${clean.chips.length}`);
    res.json({
      ...clean,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('AI/expense-insight', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// POST /api/v1/ai/summarize-history — condensed summary of conversation history
aiRouter.post('/summarize-history', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const { messages, articleContext, liteModel } = req.body || {};

    if (!Array.isArray(messages) || messages.length < 2) {
      return res.status(400).json({ error: 'messages array required (min 2 entries)' });
    }
    const pickedModel = _pickLiteLLMModel(liteModel, undefined);

    const liteLLMMessages = [
      {
        role: 'system',
        content:
          'You are a conversation summarizer. ' +
          'Given a conversation history between a user and an AI assistant, ' +
          'produce a concise but comprehensive summary that captures ALL key topics discussed, ' +
          'questions asked, answers given, and important details/facts mentioned. ' +
          'The summary will be used as context for future conversations, so preserve: ' +
          '(1) specific facts and data points, (2) user preferences expressed, ' +
          '(3) conclusions reached, (4) any follow-up topics mentioned. ' +
          (articleContext ? `The conversation is about: "${String(articleContext).slice(0, 300)}". ` : '') +
          'Return ONLY the summary, no preamble or labels.',
      },
    ];

    const conversationText = messages
      .filter((m) => m && m.role && m.text)
      .map((m) => `${String(m.role).toUpperCase()}: ${String(m.text).slice(0, 3000)}`)
      .join('\n\n');

    liteLLMMessages.push({
      role: 'user',
      content: `Summarize the following conversation:\n\n${conversationText}`,
    });

    console.log(`[SummarizeHistory] ${messages.length} msgs, ctx="${(articleContext || '').slice(0, 50)}"`);
    tg.d('AI/summarize-history', `${messages.length} msgs, ctx="${(articleContext || '').slice(0, 50)}", model=${pickedModel || '(default)'}`);

    const result = await callLiteLLM({
      model: pickedModel || undefined,
      messages: liteLLMMessages,
      maxTokens: 1024,
      temperature: 0.3,
    });

    console.log(`[SummarizeHistory] Done — ${result.content.length} chars`);
    tg.i('AI/summarize-history', `✓ model=${result.model_used} ${Date.now() - _t0}ms, ${result.content.length} chars`);
    res.json({
      summary: result.content,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    console.error('[SummarizeHistory] Failed:', err.message);
    tg.e('AI/summarize-history', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

// ── GET /api/v1/ai/models ───────────────────────────────────────
// Dynamic model directory backed by Google's live `/v1beta/models`
// endpoint. The Settings screen calls this to populate the Gemini
// Lite dropdown so the user picks from models the configured API
// key can ACTUALLY invoke. Cached 5 min server-side (see
// `gemini-direct.js`) — pass `?refresh=1` to force a re-fetch.
//
// Response shape:
//   {
//     models: [{ id, displayName, description, inputTokenLimit, outputTokenLimit }],
//     primary: 'gemini-3.1-flash-lite-preview',
//     cachedAt: '2026-05-28T10:42:00.000Z'
//   }
aiRouter.get('/models', async (req, res, next) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await listGeminiModels({ force });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/ai', requireApp, aiRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — LLM  /api/v1/llm
// ═══════════════════════════════════════════════════════════════

const llmRouter = express.Router();
llmRouter.use(authenticate);

llmRouter.get('/health', async (_req, res, next) => {
  try {
    const data = await getLiteLLM('/health');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

llmRouter.get('/config', async (_req, res) => {
  const grounding = getGroundingConfig();
  const xgrok = getXGrokConfig();
  const providerHealth = getProviderHealth();

  let newsSummarizeProvider = 'litellm';
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'news_summarize_provider'");
    if (rows[0]?.value) newsSummarizeProvider = rows[0].value;
  } catch {}

  res.json({
    litellm: {
      primary: getPrimaryModel(),
      fallbacks: getFallbackModels(),
      all: getModelPriorityList(),
    },
    grounding,
    xgrok,
    providers: listProviders(),
    providerHealth,
    newsSummarizeProvider,
  });
});

llmRouter.get('/models', async (_req, res, next) => {
  try {
    const data = await getLiteLLM('/v1/models');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

llmRouter.post('/complete', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const v = validate(LLMCompleteSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { messages, model, max_tokens, temperature } = v.data;
    tg.d('LLM/complete', `model=${model || 'auto'} msgs=${messages.length}`);

    const result = await callLiteLLM({
      messages,
      model: model || undefined,
      maxTokens: max_tokens || 2048,
      temperature: temperature ?? 0.7,
    });

    tg.i('LLM/complete', `✓ model=${result.model_used} ${Date.now() - _t0}ms`);
    res.json({
      content: result.content,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('LLM/complete', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

llmRouter.post('/summarize', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const v = validate(LLMSummarizeSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { text, max_length, model } = v.data;
    tg.d('LLM/summarize', `model=${model || 'auto'} textLen=${(text || '').length}`);

    const result = await callLiteLLM({
      model: model || undefined,
      messages: [
        {
          role: 'system',
          content: `You are a concise summarizer. Summarize the following text in ${max_length || 3} sentences or fewer. Return ONLY the summary, no preamble.`,
        },
        { role: 'user', content: text },
      ],
      maxTokens: 512,
      temperature: 0.3,
    });

    tg.i('LLM/summarize', `✓ model=${result.model_used} ${Date.now() - _t0}ms`);
    res.json({
      summary: result.content,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('LLM/summarize', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

llmRouter.post('/correct', async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const v = validate(LLMCorrectSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { text, tone, platform, platforms, model } = v.data;
    tg.d('LLM/correct', `model=${model || 'auto'} tone=${tone || 'default'} textLen=${(text || '').length}`);
    const targetPlatforms = platforms || (platform ? [platform] : []);

    const systemPrompt = [
      'You are an expert communication coach and grammar specialist.',
      'You will receive text from the user. Your job is to correct grammar, spelling, punctuation, and improve clarity.',
      tone && `Adapt the tone to be ${tone}.`,
      targetPlatforms.length > 0 && `Also provide adapted variations for these platforms: ${targetPlatforms.join(', ')}.`,
      '',
      'You MUST respond in valid JSON with this exact structure:',
      '{',
      '  "corrected_text": "the corrected version of the input",',
      '  "tone_labels": ["label1", "label2"],',
      '  "platform_variations": { "Platform": "adapted text" },',
      '  "pro_tip": "one actionable writing tip"',
      '}',
      '',
      'Return ONLY the JSON object, no markdown fences, no explanation.',
    ].filter(Boolean).join('\n');

    const result = await callLiteLLM({
      model: model || undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      maxTokens: 1024,
      temperature: 0.3,
    });

    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      parsed = {
        corrected_text: result.content,
        tone_labels: tone ? [tone] : [],
        platform_variations: {},
        pro_tip: null,
      };
    }

    await pool.query(
      `INSERT INTO ai_conversations (user_id, input_text, corrected_text, platform, tone, model_used, messages)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.userId,
        text,
        parsed.corrected_text || result.content,
        targetPlatforms[0] || null,
        tone || null,
        result.model_used,
        JSON.stringify(parsed),
      ],
    );

    tg.i('LLM/correct', `✓ model=${result.model_used} ${Date.now() - _t0}ms, tone=${tone || 'default'}`);
    res.json({
      corrected: parsed.corrected_text || result.content,
      corrected_text: parsed.corrected_text || result.content,
      tone_labels: parsed.tone_labels || [],
      platform_variations: parsed.platform_variations || {},
      pro_tip: parsed.pro_tip || null,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    tg.e('LLM/correct', `Failed ${Date.now() - _t0}ms`, err);
    next(err);
  }
});

app.use('/api/v1/llm', requireApp, llmRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — APP SETTINGS  /api/v1/app-settings
// ═══════════════════════════════════════════════════════════════

const appSettingsRouter = express.Router();

const ALLOWED_SETTINGS_KEYS = new Set([
  'news_summarize_provider',
]);

const SETTINGS_VALUE_VALIDATORS = {
  news_summarize_provider: (v) => {
    const allowed = ['litellm', 'xgrok'];
    if (!allowed.includes(v)) return `Must be one of: ${allowed.join(', ')}`;
    return null;
  },
};

appSettingsRouter.get('/', async (_req, res, next) => {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query('SELECT key, value, updated_at FROM app_settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    tg.d('Settings', `GET all → ${rows.length} keys (${Date.now() - t0}ms)`);
    res.json(settings);
  } catch (err) {
    tg.e('Settings', `GET failed (${Date.now() - t0}ms)`, err);
    next(err);
  }
});

appSettingsRouter.put('/', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      return res.status(400).json({ error: 'key and value (both strings) are required' });
    }
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: "${key}". Allowed: ${[...ALLOWED_SETTINGS_KEYS].join(', ')}` });
    }

    const validator = SETTINGS_VALUE_VALIDATORS[key];
    if (validator) {
      const err = validator(value);
      if (err) return res.status(400).json({ error: `Invalid value for "${key}": ${err}` });
    }

    // For provider changes, validate the provider is actually available
    if (key === 'news_summarize_provider' && value !== 'litellm') {
      if (!hasProvider(value)) {
        tg.w('Settings', `Attempted to set provider="${value}" but it's unavailable`);
        return res.status(400).json({
          error: `Provider "${value}" is not available. Available: ${listProviders().join(', ')}`,
        });
      }
    }

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value],
    );

    // Bust the in-memory provider cache immediately
    _invalidateProviderCache();

    console.log(`[Settings] ${key} = ${value} (${Date.now() - t0}ms)`);
    tg.i('Settings', `✓ ${key} = ${value} (${Date.now() - t0}ms)`);
    res.json({ ok: true, key, value });
  } catch (err) {
    tg.e('Settings', `PUT failed key=${req.body?.key} (${Date.now() - t0}ms)`, err);
    next(err);
  }
});

app.use('/api/v1/app-settings', requireApp, appSettingsRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — DATA RESET EPOCH  /api/v1/data-reset
//
//  Global cross-device "nuke" propagation. A nuke POSTs here to bump
//  a generation counter; every device GETs it on launch/resume and
//  wipes its LOCAL copy when the server generation is newer than the
//  one it last applied. Two independent monotonic counters so the
//  scopes never interfere regardless of ordering:
//    • full_gen    — full-app reset (wipe every local table)
//    • expense_gen — expense-domain reset (clear financial tables)
//  A full reset implicitly subsumes an expense reset on the client.
// ═══════════════════════════════════════════════════════════════

const dataResetRouter = express.Router();

function _resetRow(r) {
  return {
    fullGen: Number(r.full_gen) || 0,
    expenseGen: Number(r.expense_gen) || 0,
    resetAt: r.reset_at ? new Date(r.reset_at).toISOString() : null,
  };
}

// GET current reset epoch.
dataResetRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM data_reset WHERE id = 1');
    if (rows.length === 0) {
      return res.json({ fullGen: 0, expenseGen: 0, resetAt: null });
    }
    res.json(_resetRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST a reset — bumps the generation for { scope: 'full' | 'expense' }.
dataResetRouter.post('/', async (req, res, next) => {
  try {
    const scope = (req.body && req.body.scope) === 'expense' ? 'expense' : 'full';
    const fullDelta = scope === 'full' ? 1 : 0;
    const expenseDelta = scope === 'expense' ? 1 : 0;
    const { rows } = await pool.query(
      `INSERT INTO data_reset (id, full_gen, expense_gen, reset_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         full_gen    = data_reset.full_gen + $1,
         expense_gen = data_reset.expense_gen + $2,
         reset_at    = NOW()
       RETURNING *`,
      [fullDelta, expenseDelta],
    );
    console.log(`[DATA_RESET] scope=${scope} →`, _resetRow(rows[0]));
    res.json(_resetRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/data-reset', requireApp, dataResetRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — USER PREFERENCES  /api/v1/user-preferences
//
//  Cross-device settings sync. Stores user-facing preferences
//  (theme, xGrok toggle, model names, provider choices, banks)
//  so every device converges to the same state.
//
//  Separate from app_settings (which controls backend pipelines).
// ═══════════════════════════════════════════════════════════════

const userPreferencesRouter = express.Router();

const MAX_PREF_KEY_LEN = 64;
const MAX_PREF_VALUE_LEN = 8192;
const MAX_PREF_BATCH_SIZE = 30;

// ── GET /  →  { key: value, … } ─────────────────────────────

userPreferencesRouter.get('/', async (_req, res, next) => {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM user_preferences ORDER BY key',
    );
    const prefs = {};
    for (const r of rows) prefs[r.key] = r.value;
    tg.d('UserPrefs', `GET all → ${rows.length} keys (${Date.now() - t0}ms)`);
    res.json(prefs);
  } catch (err) {
    tg.e('UserPrefs', `GET failed (${Date.now() - t0}ms)`, err);
    next(err);
  }
});

// ── PUT /  →  upsert single { key, value } ──────────────────

userPreferencesRouter.put('/', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      return res.status(400).json({ error: 'key and value (both strings) are required' });
    }
    if (key.length > MAX_PREF_KEY_LEN) {
      return res.status(400).json({ error: `Key exceeds max length (${MAX_PREF_KEY_LEN})` });
    }
    if (value.length > MAX_PREF_VALUE_LEN) {
      return res.status(400).json({ error: `Value exceeds max length (${MAX_PREF_VALUE_LEN})` });
    }

    await pool.query(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value],
    );

    if (key === 'lite_model' || key === 'xgrok_lite_model') {
      _invalidateSettingsModelCache();
    }
    if (key === 'news_summarize_provider') {
      _invalidateProviderCache();
    }

    const display = value.length > 60 ? value.slice(0, 60) + '…' : value;
    tg.d('UserPrefs', `PUT ${key}=${display} (${Date.now() - t0}ms)`);
    res.json({ ok: true, key, value });
  } catch (err) {
    tg.e('UserPrefs', `PUT failed key=${req.body?.key} (${Date.now() - t0}ms)`, err);
    next(err);
  }
});

// ── PUT /batch  →  upsert multiple [{ key, value }, …] ──────
//    Single multi-row INSERT for maximum throughput.

userPreferencesRouter.put('/batch', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries (non-empty array) is required' });
    }
    if (entries.length > MAX_PREF_BATCH_SIZE) {
      return res.status(400).json({ error: `Batch exceeds max size (${MAX_PREF_BATCH_SIZE})` });
    }

    for (const entry of entries) {
      if (!entry.key || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
        return res.status(400).json({ error: 'Each entry must have key and value (both strings)' });
      }
      if (entry.key.length > MAX_PREF_KEY_LEN) {
        return res.status(400).json({ error: `Key "${entry.key}" exceeds max length` });
      }
      if (entry.value.length > MAX_PREF_VALUE_LEN) {
        return res.status(400).json({ error: `Value for "${entry.key}" exceeds max length` });
      }
    }

    // Single multi-row upsert — one round-trip regardless of batch size
    const valueClauses = [];
    const params = [];
    for (let i = 0; i < entries.length; i++) {
      const ki = i * 2 + 1;
      const vi = i * 2 + 2;
      valueClauses.push(`($${ki}, $${vi}, NOW())`);
      params.push(entries[i].key, entries[i].value);
    }

    await pool.query(
      `INSERT INTO user_preferences (key, value, updated_at)
       VALUES ${valueClauses.join(', ')}
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      params,
    );

    const keys = entries.map((e) => e.key);
    if (keys.includes('lite_model') || keys.includes('xgrok_lite_model')) {
      _invalidateSettingsModelCache();
    }
    if (keys.includes('news_summarize_provider')) {
      _invalidateProviderCache();
    }

    tg.i('UserPrefs', `BATCH PUT ${entries.length} keys [${keys.join(', ')}] (${Date.now() - t0}ms)`);
    res.json({ ok: true, count: entries.length });
  } catch (err) {
    tg.e('UserPrefs', `BATCH PUT failed (${Date.now() - t0}ms)`, err);
    next(err);
  }
});

app.use('/api/v1/user-preferences', requireApp, userPreferencesRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — SYNC  /api/v1/sync
// ═══════════════════════════════════════════════════════════════

const syncRouter = express.Router();
syncRouter.use(authenticate);

const ALLOWED_SYNC_TABLES = ['transactions', 'ai_conversations'];

syncRouter.post('/push', async (req, res, next) => {
  try {
    const v = validate(SyncPushSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { changes } = v.data;
    const results = [];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const change of changes) {
        const { table_name, record_id, operation, payload } = change;

        if (!ALLOWED_SYNC_TABLES.includes(table_name)) {
          results.push({ record_id, status: 'error', message: `Table '${table_name}' is not syncable` });
          continue;
        }

        try {
          if (table_name === 'transactions') {
            if (operation === 'insert' || operation === 'update') {
              const p = payload || {};
              await client.query(
                `INSERT INTO transactions (id, user_id, amount, currency, category_id, description, type, transaction_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET
                   amount = EXCLUDED.amount,
                   currency = EXCLUDED.currency,
                   category_id = EXCLUDED.category_id,
                   description = EXCLUDED.description,
                   type = EXCLUDED.type,
                   transaction_date = EXCLUDED.transaction_date,
                   updated_at = NOW()`,
                [
                  record_id,
                  req.userId,
                  p.amount,
                  p.currency || 'USD',
                  p.category_id,
                  p.description,
                  p.type,
                  p.transaction_date,
                ],
              );
            } else if (operation === 'delete') {
              await client.query(
                'DELETE FROM transactions WHERE id = $1 AND user_id = $2',
                [record_id, req.userId],
              );
            }
          } else if (table_name === 'ai_conversations') {
            if (operation === 'insert' || operation === 'update') {
              const p = payload || {};
              await client.query(
                `INSERT INTO ai_conversations (id, user_id, input_text, corrected_text, feature, messages, model_used)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET
                   corrected_text = EXCLUDED.corrected_text,
                   messages = EXCLUDED.messages,
                   updated_at = NOW()`,
                [
                  record_id,
                  req.userId,
                  p.input_text || '',
                  p.corrected_text,
                  p.feature || 'text_correction',
                  p.messages ? JSON.stringify(p.messages) : null,
                  p.model_used,
                ],
              );
            } else if (operation === 'delete') {
              await client.query(
                'DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2',
                [record_id, req.userId],
              );
            }
          }

          await client.query(
            `INSERT INTO sync_log (user_id, table_name, record_id, operation, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.userId, table_name, record_id, operation, payload ? JSON.stringify(payload) : null],
          );

          results.push({ record_id, status: 'ok' });
        } catch (itemErr) {
          results.push({ record_id, status: 'error', message: itemErr.message });
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ results, synced_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

syncRouter.post('/pull', async (req, res, next) => {
  try {
    const v = validate(SyncPullSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const since = v.data.last_synced_at || '1970-01-01T00:00:00Z';

    const [transactions, conversations] = await Promise.all([
      pool.query(
        `SELECT * FROM transactions WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at`,
        [req.userId, since],
      ),
      pool.query(
        `SELECT * FROM ai_conversations WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at`,
        [req.userId, since],
      ),
    ]);

    res.json({
      transactions: transactions.rows,
      ai_conversations: conversations.rows,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/sync', requireApp, syncRouter);

// ═══════════════════════════════════════════════════════════════
//  SAVED WORDS
// ═══════════════════════════════════════════════════════════════

// Router (incl. cross-device delete-sync tombstones) lives in ./saved-words so
// the full lifecycle is unit-testable with a fake pool.
const { buildSavedWordsRouter } = require('./saved-words');
const savedWordsRouter = buildSavedWordsRouter(express, pool);

app.use('/api/v1/saved-words', requireApp, savedWordsRouter);

// ═══════════════════════════════════════════════════════════════
//  ARTICLE CHAT MESSAGES
// ═══════════════════════════════════════════════════════════════

const articleChatsRouter = express.Router();

// GET /api/v1/article-chats/:articleId — get all messages for an article
articleChatsRouter.get('/:articleId', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM article_chat_messages WHERE article_id = $1 ORDER BY created_at ASC',
      [articleId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/article-chats/:articleId — upsert a message
articleChatsRouter.post('/:articleId', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { id, role, text, model, sourcesJson, createdAt } = req.body;
    if (!id || !role) {
      return res.status(400).json({ error: 'id and role are required' });
    }

    await pool.query(
      `INSERT INTO article_chat_messages (id, article_id, role, text, model, sources_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         text = EXCLUDED.text,
         model = EXCLUDED.model,
         sources_json = EXCLUDED.sources_json`,
      [
        id,
        articleId,
        role,
        text || '',
        model || '',
        sourcesJson || '[]',
        createdAt || new Date().toISOString(),
      ],
    );

    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/article-chats/:articleId — delete all messages for an article
articleChatsRouter.delete('/:articleId', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const result = await pool.query(
      'DELETE FROM article_chat_messages WHERE article_id = $1',
      [articleId],
    );
    console.log('[ARTICLE_CHATS] Cleared:', articleId, '| rows:', result.rowCount);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/article-chats/:articleId/summary — get conversation summary
articleChatsRouter.get('/:articleId/summary', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { rows } = await pool.query(
      'SELECT summary_text, pairs_covered, updated_at FROM article_chat_summaries WHERE article_id = $1',
      [articleId],
    );
    if (rows.length === 0) {
      return res.json({});
    }
    res.json({
      summaryText: rows[0].summary_text,
      pairsCovered: rows[0].pairs_covered,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/article-chats/:articleId/summary — upsert conversation summary
articleChatsRouter.put('/:articleId/summary', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { summaryText, pairsCovered, updatedAt } = req.body || {};

    if (!summaryText || typeof pairsCovered !== 'number') {
      return res.status(400).json({ error: 'summaryText and pairsCovered are required' });
    }

    await pool.query(
      `INSERT INTO article_chat_summaries (article_id, summary_text, pairs_covered, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (article_id) DO UPDATE SET
         summary_text = EXCLUDED.summary_text,
         pairs_covered = EXCLUDED.pairs_covered,
         updated_at = EXCLUDED.updated_at`,
      [
        articleId,
        summaryText,
        pairsCovered,
        updatedAt || new Date().toISOString(),
      ],
    );

    console.log(`[ARTICLE_SUMMARY] Upserted: ${articleId} (${pairsCovered} pairs)`);
    res.json({ ok: true, articleId, pairsCovered });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/article-chats/:articleId/summary — delete conversation summary
articleChatsRouter.delete('/:articleId/summary', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const result = await pool.query(
      'DELETE FROM article_chat_summaries WHERE article_id = $1',
      [articleId],
    );
    console.log('[ARTICLE_SUMMARY] Deleted:', articleId, '| rows:', result.rowCount);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/article-chats', requireApp, articleChatsRouter);

// ═══════════════════════════════════════════════════════════════
//  SAVED SEARCHES (InsightAI bookmarked searches + chat history)
//
//  Mirrors the article-chats endpoints in shape and semantics so the
//  Flutter SavedSearchStore can use the proven local-first / fire-
//  and-forget sync pattern without any client-side branching.
//
//  Wire shape (camelCase outbound, tolerant of snake_case inbound) is
//  documented in lib/domain/entities/saved_search.dart.
// ═══════════════════════════════════════════════════════════════

const savedSearchesRouter = express.Router();

// Helper: parse responseJson which may arrive as a structured object or
// as a JSON-encoded string (Flutter's _decodedResponseJsonForWire sends
// the structured form when possible, falls back to the raw string).
function _stringifyResponseJson(value) {
  if (value == null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

// Maps a DB row to the camelCase wire shape SavedSearchEntry.fromJson()
// expects. Drift round-trips losslessly via this format.
function _rowToSavedSearch(row) {
  let parsedResponse = {};
  try {
    parsedResponse = JSON.parse(row.response_json || '{}');
  } catch {
    parsedResponse = row.response_json || '{}';
  }
  return {
    id: row.id,
    kind: row.kind || 'query',
    query: row.query || '',
    title: row.title || '',
    responseType: row.response_type || '',
    responseJson: parsedResponse,
    model: row.model || '',
    provider: row.provider || '',
    mode: row.mode || '',
    pinned: row.pinned !== false,
    savedAt: row.saved_at || '',
    updatedAt: row.updated_at || '',
  };
}

// GET /api/v1/saved-searches — list all saved searches (newest first)
savedSearchesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM saved_searches WHERE pinned = TRUE ORDER BY updated_at DESC',
    );
    res.json(rows.map(_rowToSavedSearch));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/saved-searches/tombstones — incremental delete log
//
// Cross-device delete sync: when Device A deletes a saved search, the
// row is removed AND a tombstone row is written into deleted_saved_searches
// (id, deleted_at). Device B periodically pulls this endpoint with
// ?since=<iso-timestamp> to find out which ids it should also remove
// locally. The watermark advances as Device B observes new tombstones,
// so the server only ever ships the delta (typically <50 rows).
//
// Wire shape:  Array<{ id: string, deletedAt: ISO-8601 string }>
//
// IMPORTANT: this route MUST be registered before `/:id` because Express
// matches in registration order — otherwise 'tombstones' would be parsed
// as `:id`.
savedSearchesRouter.get('/tombstones', async (req, res, next) => {
  try {
    const since = req.query.since;
    const params = [];
    let where = '';
    if (typeof since === 'string' && since.length > 0) {
      // PG accepts ISO-8601; if the client sends garbage we surface 400.
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'invalid since timestamp' });
      }
      params.push(d.toISOString());
      where = 'WHERE deleted_at > $1';
    }
    const { rows } = await pool.query(
      `SELECT id, deleted_at
         FROM deleted_saved_searches
         ${where}
        ORDER BY deleted_at ASC
        LIMIT 1000`,
      params,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        deletedAt:
          r.deleted_at instanceof Date
            ? r.deleted_at.toISOString()
            : String(r.deleted_at || ''),
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/saved-searches — upsert one saved search
savedSearchesRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const id = b.id;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required' });
    }
    const kind = b.kind || 'query';
    const query = b.query || '';
    const title = b.title || '';
    const responseType = b.responseType || b.response_type || '';
    const responseJson = _stringifyResponseJson(b.responseJson ?? b.response_json);
    const model = b.model || '';
    const provider = b.provider || '';
    const mode = b.mode || '';
    const pinned = b.pinned !== false;
    const savedAt = b.savedAt || b.saved_at || new Date().toISOString();
    const updatedAt = b.updatedAt || b.updated_at || savedAt;

    await pool.query(
      `INSERT INTO saved_searches
         (id, kind, query, title, response_type, response_json,
          model, provider, mode, pinned, saved_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         kind          = EXCLUDED.kind,
         query         = EXCLUDED.query,
         title         = EXCLUDED.title,
         response_type = EXCLUDED.response_type,
         response_json = EXCLUDED.response_json,
         model         = EXCLUDED.model,
         provider      = EXCLUDED.provider,
         mode          = EXCLUDED.mode,
         pinned        = EXCLUDED.pinned,
         saved_at      = EXCLUDED.saved_at,
         updated_at    = EXCLUDED.updated_at`,
      [
        id, kind, query, title, responseType, responseJson,
        model, provider, mode, pinned, savedAt, updatedAt,
      ],
    );
    // Cross-device "undelete": if the user deleted this id on a previous
    // device and then re-saved it (locally undelete + push), drop any
    // existing tombstone so the row's POST winning is not later undone
    // when other devices pull /tombstones.
    await pool.query(
      'DELETE FROM deleted_saved_searches WHERE id = $1',
      [id],
    );
    console.log(`[SAVED_SEARCHES] Upsert: ${id} (${responseType})`);
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/saved-searches/:id — fetch one saved search
savedSearchesRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM saved_searches WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(_rowToSavedSearch(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/saved-searches/:id — hard delete + write tombstone so
// other devices can sync the deletion on their next index pull.
//
// Order of operations is intentional:
//   1. Write the tombstone FIRST (idempotent INSERT … ON CONFLICT DO
//      UPDATE SET deleted_at = NOW()). Even if a later step fails, the
//      tombstone is already durable so cross-device sync still works.
//   2. Cascade-delete chat messages → summaries → parent row, in that
//      order, so we never leave child rows pointing at a missing parent
//      (FK-shaped cleanup, even though we don't enforce real FKs here).
// DELETE /api/v1/saved-searches — full-reset "nuke" bulk clear. Declared BEFORE
// the '/:id' route so the bare collection path matches here. Mirrors the per-id
// semantics across every row: tombstone EVERY current id first (so other
// devices sync the deletions), then cascade-delete chat messages → summaries →
// rows. Tombstoning before deleting keeps cross-device sync correct even if a
// later statement fails.
savedSearchesRouter.delete('/', async (_req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO deleted_saved_searches (id, deleted_at)
       SELECT id, NOW() FROM saved_searches
       ON CONFLICT (id) DO UPDATE SET deleted_at = NOW()`,
    );
    await pool.query('DELETE FROM saved_search_chat_messages');
    await pool.query('DELETE FROM saved_search_chat_summaries');
    const result = await pool.query('DELETE FROM saved_searches');
    console.log(
      `[SAVED_SEARCHES] Cleared all: ${result.rowCount} rows deleted | tombstones written`,
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

savedSearchesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(
      `INSERT INTO deleted_saved_searches (id, deleted_at)
       VALUES ($1, NOW())
       ON CONFLICT (id) DO UPDATE SET deleted_at = NOW()`,
      [id],
    );
    await pool.query(
      'DELETE FROM saved_search_chat_messages WHERE search_id = $1',
      [id],
    );
    await pool.query(
      'DELETE FROM saved_search_chat_summaries WHERE search_id = $1',
      [id],
    );
    const result = await pool.query(
      'DELETE FROM saved_searches WHERE id = $1',
      [id],
    );
    console.log(
      `[SAVED_SEARCHES] Delete: ${id} | rows: ${result.rowCount} | tombstone written`,
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/saved-searches/:id/chat — all chat messages for a search,
// oldest first (matches Flutter's `loadMessages` ordering).
savedSearchesRouter.get('/:id/chat', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, search_id, role, text, model, sources_json, created_at
         FROM saved_search_chat_messages
        WHERE search_id = $1
        ORDER BY created_at ASC`,
      [id],
    );
    // Map snake_case → the camelCase shape SavedSearchStore.pullMessagesFromServer accepts.
    res.json(
      rows.map((r) => ({
        id: r.id,
        searchId: r.search_id,
        role: r.role,
        text: r.text || '',
        model: r.model || '',
        sourcesJson: r.sources_json || '[]',
        createdAt: r.created_at || '',
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/saved-searches/:id/chat — upsert a chat message
savedSearchesRouter.post('/:id/chat', async (req, res, next) => {
  try {
    const { id: searchId } = req.params;
    const b = req.body || {};
    const id = b.id;
    const role = b.role;
    if (!id || !role) {
      return res.status(400).json({ error: 'id and role are required' });
    }

    await pool.query(
      `INSERT INTO saved_search_chat_messages
         (id, search_id, role, text, model, sources_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         text         = EXCLUDED.text,
         model        = EXCLUDED.model,
         sources_json = EXCLUDED.sources_json`,
      [
        id,
        searchId,
        role,
        b.text || '',
        b.model || '',
        b.sourcesJson || b.sources_json || '[]',
        b.createdAt || b.created_at || new Date().toISOString(),
      ],
    );

    // Bump parent updatedAt so the cross-device History list re-orders by
    // activity (best-effort — a missing parent row is fine, the message
    // can land before the parent in eventual-consistency scenarios).
    await pool.query(
      'UPDATE saved_searches SET updated_at = $1 WHERE id = $2',
      [b.createdAt || b.created_at || new Date().toISOString(), searchId],
    );

    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/saved-searches/:id/chat — clear all chat messages for a search
savedSearchesRouter.delete('/:id/chat', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM saved_search_chat_messages WHERE search_id = $1',
      [id],
    );
    console.log(`[SAVED_SEARCHES] Cleared chats: ${id} | rows: ${result.rowCount}`);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/saved-searches/:id/summary — get conversation summary
savedSearchesRouter.get('/:id/summary', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT summary_text, pairs_covered, updated_at FROM saved_search_chat_summaries WHERE search_id = $1',
      [id],
    );
    if (rows.length === 0) return res.json({});
    res.json({
      summaryText: rows[0].summary_text,
      pairsCovered: rows[0].pairs_covered,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/saved-searches/:id/summary — upsert conversation summary
savedSearchesRouter.put('/:id/summary', async (req, res, next) => {
  try {
    const { id: searchId } = req.params;
    const b = req.body || {};
    const summaryText = b.summaryText ?? b.summary_text;
    const pairsCovered = b.pairsCovered ?? b.pairs_covered;
    if (typeof summaryText !== 'string' || typeof pairsCovered !== 'number') {
      return res.status(400).json({ error: 'summaryText and pairsCovered are required' });
    }
    await pool.query(
      `INSERT INTO saved_search_chat_summaries
         (search_id, summary_text, pairs_covered, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (search_id) DO UPDATE SET
         summary_text  = EXCLUDED.summary_text,
         pairs_covered = EXCLUDED.pairs_covered,
         updated_at    = EXCLUDED.updated_at`,
      [
        searchId,
        summaryText,
        pairsCovered,
        b.updatedAt || b.updated_at || new Date().toISOString(),
      ],
    );
    console.log(`[SAVED_SEARCHES] Summary upsert: ${searchId} (${pairsCovered} pairs)`);
    res.json({ ok: true, searchId, pairsCovered });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/saved-searches/:id/summary — drop conversation summary
savedSearchesRouter.delete('/:id/summary', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM saved_search_chat_summaries WHERE search_id = $1',
      [id],
    );
    console.log(`[SAVED_SEARCHES] Summary delete: ${id} | rows: ${result.rowCount}`);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/saved-searches', requireApp, savedSearchesRouter);

// ═══════════════════════════════════════════════════════════════
//  EXPENSES
// ═══════════════════════════════════════════════════════════════

const expensesRouter = express.Router();

// GET all expenses
expensesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM expenses ORDER BY date DESC, created_at DESC',
    );
    res.json(rows.map(r => ({
      id: r.id,
      amount: parseFloat(r.amount),
      description: r.description,
      category: r.category,
      bank: r.bank,
      cardType: r.card_type,
      date: r.date,
      isManualCategory: !!r.is_manual_category,
      comments: r.comments || '',
      updatedAt:
        r.updated_at instanceof Date
          ? r.updated_at.toISOString()
          : (r.updated_at ? String(r.updated_at) : null),
    })));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/expenses/tombstones — incremental delete log for cross-device
// delete sync. When any device deletes an expense, the row is removed AND a
// tombstone (id, deleted_at) is written into deleted_expenses. Other devices
// pull this with ?since=<iso watermark> on launch/resume and apply the deletes
// locally. Wire shape: Array<{ id: string, deletedAt: ISO-8601 }>.
//
// MUST be registered before any '/:id' route so Express doesn't parse
// 'tombstones' as an :id param.
expensesRouter.get('/tombstones', async (req, res, next) => {
  try {
    const since = req.query.since;
    const params = [];
    let where = '';
    if (typeof since === 'string' && since.length > 0) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'invalid since timestamp' });
      }
      params.push(d.toISOString());
      where = 'WHERE deleted_at > $1';
    }
    const { rows } = await pool.query(
      `SELECT id, deleted_at
         FROM deleted_expenses
         ${where}
        ORDER BY deleted_at ASC
        LIMIT 1000`,
      params,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        deletedAt:
          r.deleted_at instanceof Date
            ? r.deleted_at.toISOString()
            : String(r.deleted_at || ''),
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST create/upsert expense
expensesRouter.post('/', async (req, res, next) => {
  try {
    const { id, amount, description, category, bank, cardType, date, isManualCategory, comments } = req.body;
    if (!id || amount == null) {
      return res.status(400).json({ error: 'id and amount are required' });
    }

    const upserted = await pool.query(
      `INSERT INTO expenses (id, amount, description, category, bank, card_type, date, is_manual_category, comments, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET
         amount = EXCLUDED.amount,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         bank = EXCLUDED.bank,
         card_type = EXCLUDED.card_type,
         date = EXCLUDED.date,
         is_manual_category = EXCLUDED.is_manual_category,
         comments = EXCLUDED.comments,
         updated_at = NOW()
       RETURNING updated_at`,
      [id, amount, description || '', category || '', bank || '', cardType || '', date || '', !!isManualCategory, comments || ''],
    );

    // Clear any tombstone for this id so a re-created/edited expense is not
    // re-deleted on other devices when they next pull /tombstones.
    await pool.query('DELETE FROM deleted_expenses WHERE id = $1', [id]);

    const ua = upserted.rows[0] && upserted.rows[0].updated_at;
    const updatedAt =
      ua instanceof Date ? ua.toISOString() : (ua ? String(ua) : null);

    console.log('[EXPENSES] Upserted:', id, description, amount);
    // Return the server-assigned updatedAt so the client can store it and keep
    // cross-device last-write-wins anchored to a single (server) clock.
    res.json({ ok: true, id, updatedAt });
  } catch (err) {
    next(err);
  }
});

// DELETE all expenses (easter egg clear)
expensesRouter.delete('/', async (_req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM expenses');
    console.log('[EXPENSES] Cleared all:', result.rowCount, 'rows deleted');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

// DELETE expense — hard delete + write a tombstone so other devices can sync
// the deletion on their next /tombstones pull. The tombstone is written FIRST
// (idempotent upsert) so cross-device delete sync stays correct even if a later
// step fails.
expensesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Truncate to milliseconds so the stored value exactly matches the
    // millisecond-precision ISO string the /tombstones GET emits — this keeps
    // the client's `?since=<watermark>` cursor strict (a tombstone is never
    // re-shipped to a device that has already applied it).
    await pool.query(
      `INSERT INTO deleted_expenses (id, deleted_at)
       VALUES ($1, date_trunc('milliseconds', NOW()))
       ON CONFLICT (id) DO UPDATE SET deleted_at = date_trunc('milliseconds', NOW())`,
      [id],
    );
    const result = await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    console.log('[EXPENSES] Deleted:', id, '| rows:', result.rowCount, '| tombstone written');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/expenses', requireApp, expensesRouter);

// ═══════════════════════════════════════════════════════════════
//  BUDGET
// ═══════════════════════════════════════════════════════════════

const budgetRouter = express.Router();

// GET all budget entries
budgetRouter.get('/history', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM budget_entries ORDER BY set_at DESC',
    );
    res.json(rows.map(r => ({
      id: r.id,
      amount: parseFloat(r.amount),
      setAt: r.set_at,
    })));
  } catch (err) {
    next(err);
  }
});

// POST create budget entry
budgetRouter.post('/', async (req, res, next) => {
  try {
    const { id, amount, setAt } = req.body;
    if (!id || amount == null) {
      return res.status(400).json({ error: 'id and amount are required' });
    }

    await pool.query(
      `INSERT INTO budget_entries (id, amount, set_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         amount = EXCLUDED.amount,
         set_at = EXCLUDED.set_at`,
      [id, amount, setAt || new Date().toISOString()],
    );

    console.log('[BUDGET] Upserted:', id, amount);
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// DELETE all budget history (easter egg clear)
budgetRouter.delete('/history', async (_req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM budget_entries');
    console.log('[BUDGET] Cleared history:', result.rowCount, 'rows deleted');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/budget', requireApp, budgetRouter);

// ═══════════════════════════════════════════════════════════════
//  SALARY  (monthly in-hand income — one entry per 'YYYY-MM')
// ═══════════════════════════════════════════════════════════════

const salaryRouter = express.Router();

// GET full salary history (newest month first)
salaryRouter.get('/history', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM salary_entries ORDER BY month DESC',
    );
    res.json(rows.map(r => ({
      id: r.id,
      month: r.month,
      amount: parseFloat(r.amount),
      setAt: r.set_at,
    })));
  } catch (err) {
    next(err);
  }
});

// POST upsert a month's salary (keyed by month so re-entry overwrites)
salaryRouter.post('/', async (req, res, next) => {
  try {
    const { id, month, amount, setAt } = req.body;
    if (!id || !month || amount == null) {
      return res
        .status(400)
        .json({ error: 'id, month and amount are required' });
    }
    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      return res.status(400).json({ error: "month must be 'YYYY-MM'" });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res
        .status(400)
        .json({ error: 'amount must be a non-negative finite number' });
    }

    await pool.query(
      `INSERT INTO salary_entries (id, month, amount, set_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (month) DO UPDATE SET
         id = EXCLUDED.id,
         amount = EXCLUDED.amount,
         set_at = EXCLUDED.set_at,
         updated_at = NOW()`,
      [id, month, amt, setAt || new Date().toISOString()],
    );

    console.log('[SALARY] Upserted:', month, amt);
    res.json({ ok: true, id, month });
  } catch (err) {
    next(err);
  }
});

// DELETE all salary history (easter egg clear)
salaryRouter.delete('/history', async (_req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM salary_entries');
    console.log('[SALARY] Cleared history:', result.rowCount, 'rows deleted');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/salary', requireApp, salaryRouter);

// ═══════════════════════════════════════════════════════════════
//  CATEGORY LEARNINGS
// ═══════════════════════════════════════════════════════════════

const learningsRouter = express.Router();

learningsRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT keyword, category FROM category_learnings ORDER BY keyword');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

learningsRouter.post('/', async (req, res, next) => {
  try {
    const { keyword, category } = req.body;
    if (!keyword || !category) {
      return res.status(400).json({ error: 'keyword and category are required' });
    }
    await pool.query(
      `INSERT INTO category_learnings (keyword, category)
       VALUES ($1, $2)
       ON CONFLICT (keyword) DO UPDATE SET category = EXCLUDED.category, updated_at = NOW()`,
      [keyword.toLowerCase(), category],
    );
    console.log('[LEARNINGS] Upserted:', keyword, '→', category);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

learningsRouter.post('/batch', async (req, res, next) => {
  try {
    const { learnings } = req.body;
    if (!Array.isArray(learnings)) {
      return res.status(400).json({ error: 'learnings array is required' });
    }
    for (const { keyword, category } of learnings) {
      if (keyword && category) {
        await pool.query(
          `INSERT INTO category_learnings (keyword, category)
           VALUES ($1, $2)
           ON CONFLICT (keyword) DO UPDATE SET category = EXCLUDED.category, updated_at = NOW()`,
          [keyword.toLowerCase(), category],
        );
      }
    }
    console.log('[LEARNINGS] Batch upserted:', learnings.length, 'items');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE all category learnings (full-reset "nuke" — bulk clear).
learningsRouter.delete('/', async (_req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM category_learnings');
    console.log('[LEARNINGS] Cleared all:', result.rowCount, 'rows deleted');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/category-learnings', requireApp, learningsRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — CLOUD  /api/v1/cloud   (Google Drive proxy for the web app)
// ═══════════════════════════════════════════════════════════════

const cloudService = require('./cloud-service');
const Busboy = require('busboy');

const cloudRouter = express.Router();

function ensureDrive(res) {
  if (!cloudService.isDriveAvailable()) {
    res.status(503).json({
      error: 'Cloud storage is not configured on the server (GOOGLE_DRIVE_SA_JSON).',
    });
    return false;
  }
  return true;
}

cloudRouter.get('/files', async (req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    const result = await cloudService.listFiles({
      pageToken: req.query.pageToken,
      pageSize: req.query.pageSize,
      q: req.query.q,
    });
    res.json(result);
  } catch (err) {
    tg.e('Cloud/files', `list failed: ${err.message}`, err);
    next(err);
  }
});

cloudRouter.get('/quota', async (_req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    res.json(await cloudService.getQuota());
  } catch (err) {
    next(err);
  }
});

// Token broker — hands a *trusted* (already requireApp-authenticated) client a
// short-lived Drive access token so the Android app can talk to Drive directly
// WITHOUT ever embedding the service-account private key in the APK.
cloudRouter.get('/token', async (_req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    const token = await cloudService.getAccessToken();
    // Never cache a bearer token at any hop.
    res.setHeader('Cache-Control', 'no-store');
    res.json(token);
  } catch (err) {
    tg.e('Cloud/token', `mint failed: ${err.message}`, err);
    next(err);
  }
});

// Streamed multipart upload → Drive (no full-file buffering).
cloudRouter.post('/upload', (req, res, next) => {
  if (!ensureDrive(res)) return;
  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { files: 1 } });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid upload request' });
  }

  let handled = false;
  let uploadPromise = null;

  busboy.on('file', (_name, fileStream, info) => {
    handled = true;
    const { filename, mimeType } = info;
    uploadPromise = cloudService
      .uploadStream({
        name: filename || `upload-${Date.now()}`,
        mimeType,
        body: fileStream,
      })
      .catch((err) => {
        fileStream.resume(); // drain
        throw err;
      });
  });

  busboy.on('close', async () => {
    if (!handled || !uploadPromise) {
      return res.status(400).json({ error: 'No file provided' });
    }
    try {
      const file = await uploadPromise;
      res.status(201).json({ file });
    } catch (err) {
      tg.e('Cloud/upload', `upload failed: ${err.message}`, err);
      next(err);
    }
  });

  busboy.on('error', (err) => {
    tg.e('Cloud/upload', `busboy error: ${err.message}`, err);
    next(err);
  });

  req.pipe(busboy);
});

// ── Resumable (chunked) upload — large files / unreliable office networks ──
// Routes live in ./cloud-resumable so the full lifecycle is unit-testable.
const { attachResumableRoutes } = require('./cloud-resumable');
attachResumableRoutes(cloudRouter, { cloudService, ensureDrive, tg });

cloudRouter.get('/files/:id/download', async (req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    const meta = await cloudService.getFileMeta(req.params.id);
    const driveRes = await cloudService.downloadStream(req.params.id);
    const inline = req.query.inline === '1';
    res.setHeader('Content-Type', meta.mimeType);
    if (meta.size) res.setHeader('Content-Length', String(meta.size));
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(meta.name)}"`,
    );
    driveRes.data.on('error', (err) => {
      tg.e('Cloud/download', `stream error: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    driveRes.data.pipe(res);
  } catch (err) {
    next(err);
  }
});

cloudRouter.get('/files/:id/thumbnail', async (req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    const size = Math.min(Math.max(Number(req.query.size) || 320, 32), 1024);
    const thumb = await cloudService.fetchThumbnail(req.params.id, size);
    if (!thumb) return res.status(404).end();
    res.setHeader('Content-Type', thumb.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(thumb.buffer);
  } catch (err) {
    next(err);
  }
});

cloudRouter.delete('/files/:id', async (req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    await cloudService.deleteFile(req.params.id);
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

cloudRouter.post('/files/:id/star', async (req, res, next) => {
  if (!ensureDrive(res)) return;
  try {
    let starred = req.body?.starred;
    if (typeof starred !== 'boolean') {
      const cur = await cloudService.getFileMeta(req.params.id);
      starred = !cur.starred;
    }
    const file = await cloudService.setStar(req.params.id, starred);
    res.json({ file, starred: file.starred });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/cloud', requireApp, cloudRouter);

// ═══════════════════════════════════════════════════════════════
//  404 + ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  // Gemini-direct failures carry rich diagnostic info — surface the
  // structured envelope to the client (toast layer) so the user can
  // see *why* a call failed (bad model id, rate-limit, safety block,
  // …) instead of a generic "Internal server error".
  if (err instanceof GeminiDirectError) {
    const status = mapGeminiErrorToHttp(err);
    console.error(`[ERROR] GeminiDirect ${err.code} (${status}) [${err.model || '-'}]: ${err.message}`);
    return res.status(status).json({
      error: {
        message: err.message,
        code: err.code,
        provider: 'gemini',
        model: err.model || null,
      },
    });
  }

  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  const isProd = process.env.NODE_ENV === 'production';
  // Always include a `code` in errors so the Flutter side can decide
  // between "show a generic toast" and "highlight the model-name
  // field in Settings" without needing string-matching heuristics.
  res.status(status).json({
    error: {
      message: isProd ? 'Internal server error' : (err.message || 'Unknown error'),
      code: err.code || 'INTERNAL',
    },
  });
});

// ═══════════════════════════════════════════════════════════════
//  DATABASE INIT — create tables if missing
//
//  Each table is created in its own query so a single failure
//  does not roll back every table. A periodic health check
//  (every 5 min) re-runs this if tables disappear at runtime.
// ═══════════════════════════════════════════════════════════════

const _REQUIRED_TABLES = [
  'users', 'categories', 'transactions', 'ai_conversations', 'sync_log',
  'news_articles', 'deleted_guids', 'article_chat_messages',
  'article_chat_summaries', 'saved_words', 'expenses', 'budget_entries',
  'salary_entries',
  'category_learnings', 'ai_response_cache', 'app_settings',
  'user_preferences', 'x_feed_sync_state',
  'saved_searches', 'saved_search_chat_messages',
  'saved_search_chat_summaries', 'deleted_saved_searches',
  'deleted_expenses', 'deleted_saved_words',
];

async function _runSafe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[DB] ${label} failed: ${e.message}`);
    tg.e('DB/init', `${label} failed`, e);
  }
}

async function verifyTablesExist() {
  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const existing = new Set(rows.map((r) => r.tablename));
    const missing = _REQUIRED_TABLES.filter((t) => !existing.has(t));
    return { ok: missing.length === 0, missing, existing: [...existing] };
  } catch (e) {
    return { ok: false, missing: _REQUIRED_TABLES, existing: [], error: e.message };
  }
}

async function initTables() {
  const t0 = Date.now();

  // Ensure pgcrypto is available for gen_random_uuid() on older PG versions
  await _runSafe('pgcrypto extension', () =>
    pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'),
  );

  // ── Core tables (created individually so one failure ≠ all fail) ──

  await _runSafe('users', () => pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      membership_tier VARCHAR(50) DEFAULT 'free',
      member_since TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('categories', () => pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      icon VARCHAR(50),
      color VARCHAR(20),
      sort_order INT DEFAULT 0
    )
  `));

  await _runSafe('transactions', () => pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'INR',
      category_id UUID REFERENCES categories(id),
      description TEXT,
      type VARCHAR(10) CHECK (type IN ('income', 'expense')),
      transaction_date TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('ai_conversations', () => pool.query(`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      input_text TEXT,
      corrected_text TEXT,
      feature VARCHAR(50) DEFAULT 'text_correction',
      platform VARCHAR(50),
      tone VARCHAR(50),
      model_used VARCHAR(100),
      messages JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('sync_log', () => pool.query(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      table_name VARCHAR(100) NOT NULL,
      record_id VARCHAR(255) NOT NULL,
      operation VARCHAR(20) NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('news_articles', () => pool.query(`
    CREATE TABLE IF NOT EXISTS news_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Technology',
      tag TEXT,
      read_time INTEGER NOT NULL DEFAULT 1,
      time_ago TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      is_featured BOOLEAN NOT NULL DEFAULT FALSE,
      content_json TEXT NOT NULL DEFAULT '{}',
      saved BOOLEAN NOT NULL DEFAULT FALSE,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      guid TEXT,
      original_url TEXT,
      summary_markdown TEXT,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('deleted_guids', () => pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_guids (
      guid TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('article_chat_messages', () => pool.query(`
    CREATE TABLE IF NOT EXISTS article_chat_messages (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      model TEXT DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('article_chat_summaries', () => pool.query(`
    CREATE TABLE IF NOT EXISTS article_chat_summaries (
      article_id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL,
      pairs_covered INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('saved_words', () => pool.query(`
    CREATE TABLE IF NOT EXISTS saved_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '',
      pronunciation TEXT DEFAULT '',
      part_of_speech TEXT DEFAULT '',
      saved_at TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // Cross-device delete sync for saved words — a tombstone is written here on
  // every per-id DELETE (and bulk clear); other devices pull the delta with
  // ?since=<watermark> and remove the rows locally so web→phone deletions
  // propagate (the phone's saved-words pull is otherwise insert-only).
  await _runSafe('deleted_saved_words', () => pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_saved_words (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('expenses', () => pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      amount DECIMAL(12,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      bank TEXT NOT NULL DEFAULT '',
      card_type TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      is_manual_category BOOLEAN NOT NULL DEFAULT FALSE,
      comments TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // Back-fill column for pre-existing expenses tables.
  await _runSafe('expenses.comments', () =>
    pool.query("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS comments TEXT NOT NULL DEFAULT ''"),
  );
  await _runSafe('expenses.updated_at', () =>
    pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()'),
  );

  // Cross-device delete sync for expenses — a tombstone is written here on
  // every per-id DELETE; other devices pull the delta with ?since=<watermark>
  // and apply the deletes locally so web→phone deletions propagate.
  await _runSafe('deleted_expenses', () => pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_expenses (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('budget_entries', () => pool.query(`
    CREATE TABLE IF NOT EXISTS budget_entries (
      id TEXT PRIMARY KEY,
      amount DECIMAL(12,2) NOT NULL,
      set_at TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // Monthly in-hand salary — one row per 'YYYY-MM' (month is unique so the
  // user's monthly re-entry/"reset" upserts cleanly).
  await _runSafe('salary_entries', () => pool.query(`
    CREATE TABLE IF NOT EXISTS salary_entries (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL UNIQUE,
      amount DECIMAL(12,2) NOT NULL,
      set_at TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('category_learnings', () => pool.query(`
    CREATE TABLE IF NOT EXISTS category_learnings (
      keyword TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await _runSafe('ai_response_cache', () => pool.query(`
    CREATE TABLE IF NOT EXISTS ai_response_cache (
      cache_key TEXT PRIMARY KEY,
      result_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('app_settings', () => pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  // Single-row global "data reset" epoch. A nuke on any device bumps the
  // relevant generation; every device compares it on launch/resume and wipes
  // its LOCAL copy when the server generation is newer than the one it last
  // applied. This is what makes a nuke propagate across devices even though the
  // per-domain pulls are additive (insert-only) and don't delete on their own.
  await _runSafe('data_reset', () => pool.query(`
    CREATE TABLE IF NOT EXISTS data_reset (
      id          INT PRIMARY KEY DEFAULT 1,
      full_gen    BIGINT NOT NULL DEFAULT 0,
      expense_gen BIGINT NOT NULL DEFAULT 0,
      reset_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));
  await _runSafe('seed data_reset', () => pool.query(`
    INSERT INTO data_reset (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `));

  await _runSafe('user_preferences', () => pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('x_feed_sync_state', () => pool.query(`
    CREATE TABLE IF NOT EXISTS x_feed_sync_state (
      handle TEXT PRIMARY KEY,
      last_window_end TEXT,
      last_sync_at TIMESTAMPTZ,
      total_articles INTEGER NOT NULL DEFAULT 0,
      total_posts_processed INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `));

  // ── Saved Searches (InsightAI bookmarked searches + chat) ──────
  // Mirrors the article_chat_* shape so the wire format and sync
  // semantics are identical to the proven news follow-up path.
  await _runSafe('saved_searches', () => pool.query(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'query',
      query TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      response_type TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      model TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '',
      pinned BOOLEAN NOT NULL DEFAULT TRUE,
      saved_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  await _runSafe('saved_search_chat_messages', () => pool.query(`
    CREATE TABLE IF NOT EXISTS saved_search_chat_messages (
      id TEXT PRIMARY KEY,
      search_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      model TEXT DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT ''
    )
  `));

  await _runSafe('saved_search_chat_summaries', () => pool.query(`
    CREATE TABLE IF NOT EXISTS saved_search_chat_summaries (
      search_id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL,
      pairs_covered INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `));

  // ── Cross-device delete sync for saved_searches ──────────────────
  // When a saved search is deleted on any device, we write a tombstone
  // here. Other devices pull this list with ?since=<watermark> on every
  // foreground transition and apply the deletes locally. Keeps the
  // saved-searches view consistent across all of a user's devices.
  await _runSafe('deleted_saved_searches', () => pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_saved_searches (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `));

  // ── Migrate legacy news_articles (id UUID → TEXT) ──────────────
  await _runSafe('news_articles id→TEXT', async () => {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'news_articles' AND column_name = 'id'`,
    );
    if (rows[0] && rows[0].data_type === 'uuid') {
      await pool.query('ALTER TABLE news_articles ALTER COLUMN id TYPE TEXT');
      console.log('[DB] Changed news_articles.id from UUID to TEXT');
    }
  });

  // ── Add columns that may be missing from older schema ──────────
  const colMigrations = [
    ['is_featured', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['content_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['saved', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['read', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['guid', 'TEXT'],
    ['original_url', 'TEXT'],
    ['summary_markdown', 'TEXT'],
    ['published_at', 'TIMESTAMPTZ'],
    ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['tag', 'TEXT'],
    ['read_time', 'INTEGER DEFAULT 1'],
    ['time_ago', "TEXT DEFAULT ''"],
    ['date', "TEXT DEFAULT ''"],
    ['image', "TEXT DEFAULT ''"],
    ['excerpt', "TEXT DEFAULT ''"],
    ['source', "TEXT DEFAULT ''"],
    ['title', 'TEXT'],
    ['category', "TEXT DEFAULT 'Technology'"],
  ];

  for (const [col, def] of colMigrations) {
    await _runSafe(`news_articles.${col}`, () =>
      pool.query(`ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS ${col} ${def}`),
    );
  }

  // ── Indexes ────────────────────────────────────────────────────
  await _runSafe('indexes', () => pool.query(`
    CREATE INDEX IF NOT EXISTS idx_acm_article ON article_chat_messages(article_id);
    CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_response_cache(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_news_guid ON news_articles(guid);
    CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at);
    CREATE INDEX IF NOT EXISTS idx_news_updated ON news_articles(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sscm_search ON saved_search_chat_messages(search_id);
    CREATE INDEX IF NOT EXISTS idx_saved_searches_updated ON saved_searches(updated_at);
    CREATE INDEX IF NOT EXISTS idx_dss_deleted_at ON deleted_saved_searches(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_updated ON expenses(updated_at);
    CREATE INDEX IF NOT EXISTS idx_de_deleted_at ON deleted_expenses(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_dsw_deleted_at ON deleted_saved_words(deleted_at)
  `));

  // ── Seed defaults ─────────────────────────────────────────────
  await _runSafe('seed app_settings', () => pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('news_summarize_provider', 'litellm')
    ON CONFLICT (key) DO NOTHING
  `));

  // ── Verify ────────────────────────────────────────────────────
  const check = await verifyTablesExist();
  if (check.ok) {
    console.log(`[DB] All ${_REQUIRED_TABLES.length} tables initialized (${Date.now() - t0}ms)`);
    tg.i('DB/init', `✓ All ${_REQUIRED_TABLES.length} tables ready (${Date.now() - t0}ms)`);
  } else {
    const msg = `CRITICAL: ${check.missing.length} tables still missing after init: ${check.missing.join(', ')}`;
    console.error(`[DB] ${msg}`);
    tg.e('DB/init', msg);
  }
}

// ── Periodic table health check (auto-recovery) ────────────────
let _tableHealthOk = true;
const _TABLE_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

setInterval(async () => {
  try {
    const check = await verifyTablesExist();
    if (!check.ok) {
      if (_tableHealthOk) {
        tg.e('DB/health', `Tables disappeared! Missing: ${check.missing.join(', ')} — auto-recovering`);
      }
      _tableHealthOk = false;
      console.warn(`[DB] Health check: ${check.missing.length} tables missing — running initTables()`);
      await initTables();
    } else if (!_tableHealthOk) {
      _tableHealthOk = true;
      tg.i('DB/health', '✓ Tables recovered after auto-repair');
      console.log('[DB] Health check: all tables restored');
    }
  } catch (e) {
    console.error('[DB] Health check error:', e.message);
  }
}, _TABLE_HEALTH_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

async function _initTablesWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initTables();
      const check = await verifyTablesExist();
      if (check.ok) return;
      if (attempt < maxRetries) {
        const delay = attempt * 2000;
        console.warn(`[DB] ${check.missing.length} tables missing after attempt ${attempt}/${maxRetries}, retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = attempt * 2000;
      console.error(`[DB] Init attempt ${attempt}/${maxRetries} failed: ${err.message}, retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

(async () => {
  try {
    await _initTablesWithRetry(3);
    await discoverLiteLLMModels();

    // ── Startup sanity check: confirm GOOGLE_API_KEY is usable ──
    //
    // The direct-Gemini transport is the primary path for every AI
    // feature now (rephrase, coach, news summarize, dictionary,
    // smart-parse, …). If the key is missing or unsubstituted
    // (`${GOOGLE_API_KEY}` placeholder, common with bare-node
    // startups), we surface ONE loud warning here so the operator
    // sees it instead of waiting for the first user complaint.
    // We do NOT crash — the legacy LiteLLM/xGrok path can still
    // service requests for non-Gemini models.
    try {
      const probe = await listGeminiModels({ force: true });
      console.log(`[Gemini] ✓ Direct API usable — ${probe.models.length} models accessible to GOOGLE_API_KEY`);
      tg.i('Gemini', `Direct API ✓ ${probe.models.length} models, primary=${probe.primary || 'none'}`);
    } catch (e) {
      const msg = e?.code === 'CONFIG'
        ? '⚠️  GOOGLE_API_KEY missing or unsubstituted — Gemini direct path WILL FAIL on every request. Set a valid key in backend/.env and restart.'
        : `⚠️  Gemini /models probe failed (${e?.code || 'unknown'}): ${String(e?.message || e).slice(0, 200)}`;
      console.warn(msg);
      tg.e('Gemini', msg, e);
    }

    // ── Register LLM providers for plug-and-play news ingestion ──
    registerProvider('litellm', {
      complete: async () => null,
      isAvailable: () => true,
      timeoutMs: 35_000,
    });

    registerProvider('xgrok', {
      complete: async (msgs, opts) => {
        // Prefer the model passed from the caller (resolved from
        // user_preferences.xgrok_lite_model). Falls back to env then to
        // the historic default — but the caller almost always supplies one.
        const model = (typeof opts?.model === 'string' && opts.model.trim())
          || process.env.XGROK_LITE_MODEL
          || 'grok-4-1-fast-non-reasoning';
        const t0 = Date.now();
        try {
          const result = await xgrokComplete({
            model,
            messages: msgs,
            temperature: opts.temperature ?? 0.35,
            maxTokens: opts.max_tokens ?? 2500,
            timeoutMs: opts.timeoutMs ?? 50_000,
          });
          tg.d('xGrok/provider', `✓ ${model} ${Date.now() - t0}ms tokens=${result.usage?.total_tokens || '?'}`);
          return result.content;
        } catch (e) {
          tg.e('xGrok/provider', `✗ ${model} ${Date.now() - t0}ms: ${e.message?.slice(0, 100)}`);
          throw e;
        }
      },
      isAvailable: () => isXGrokAvailable(),
      timeoutMs: 55_000,
      hasOwnRetry: true,
    });

    const registeredProviders = listProviders();
    console.log(`[Providers] Registered: ${registeredProviders.join(', ')}`);
    tg.i('Providers', `Registered: ${registeredProviders.join(', ')}`);

    // ── Start news scheduler with provider resolution ────────────
    startScheduler(pool, {
      getProviderFn: _resolveNewsProvider,
      getLiteModelFn: getConfiguredLiteModel,
      getXGrokLiteModelFn: getConfiguredXGrokLiteModel,
      deepExtractFn: deepExtractContent,
      ensureTablesFn: initTables,
    });

    // ── Start X Feed scheduler (8 AM + 9 PM IST daily digest) ───
    await startXFeedScheduler(pool);
  } catch (err) {
    console.error('[INIT] Startup error:', err.message);
    tg.e('Startup', 'Init failed — server will start but features may be degraded', err);
  }

  app.listen(PORT, () => {
    const primary = getPrimaryModel();
    const fallbacks = getFallbackModels();
    const grounding = getGroundingConfig();
    const xgrok = getXGrokConfig();

    console.log(`Nexus AI API running on port ${PORT}`);
    console.log(`LiteLLM: ${process.env.LITELLM_URL}`);
    console.log(`LiteLLM Primary: ${primary || 'none detected'}${fallbacks.length ? ` | Fallback: ${fallbacks.join(', ')}` : ''}`);
    console.log(`Grounding Lite: ${grounding.liteModel || 'none'} | Pro: ${grounding.proModel || 'none'}`);
    console.log(`xGrok: ${xgrok.available ? `Lite=${xgrok.liteModel} Deep=${xgrok.deepModel} Thinking=${xgrok.thinkingModel}` : 'not configured'}`);
    const xFeedInfo = getXFeedStatus();
    console.log(`X-Feed: ${xFeedInfo.schedulerActive ? `active (next in ${xFeedInfo.schedule.nextRunHours}h)` : 'disabled'}`);
    console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`);

    tg.i('Startup', `API running on :${PORT} — LLM: ${primary || 'none'} | Grounding: ${grounding.liteModel || 'none'} | xGrok: ${xgrok.available} | X-Feed: ${xFeedInfo.schedulerActive}`);
  });
})();

// ═══════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

async function _shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — draining…`);
  tg.i('Shutdown', `${signal} received — draining connections`);

  try {
    await pool.end();
    console.log('[SHUTDOWN] Database pool closed');
  } catch (e) {
    console.error('[SHUTDOWN] Pool close error:', e.message);
  }

  process.exit(0);
}

process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT', () => _shutdown('SIGINT'));
