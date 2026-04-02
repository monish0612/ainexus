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
  COACH_SYSTEM_PROMPT,
  buildDictionarySystemPrompt,
  buildSummarizerSystemPrompt,
  SMART_PARSE_SYSTEM_PROMPT,
  CATEGORIZE_SYSTEM_PROMPT,
} = require('./prompts');
const {
  groundedSearch,
  groundedExtract,
  groundedConverse,
  isGroundingAvailable,
} = require('./google-grounding');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 12;

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

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
//  LITELLM HELPER
// ═══════════════════════════════════════════════════════════════

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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM ${response.status} [${model}]: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model_used: data.model || model,
    usage: data.usage || null,
  };
}

async function callLiteLLM({
  messages,
  model,
  temperature = 0.7,
  maxTokens = 2048,
}) {
  const modelsToTry = model
    ? [model]
    : modelPriorityList.length > 0
      ? [...modelPriorityList]
      : ['gemini/gemini-2.0-flash'];

  let lastError;
  for (const m of modelsToTry) {
    try {
      return await _callLiteLLMOnce(m, messages, { temperature, maxTokens });
    } catch (e) {
      lastError = e;
      if (modelsToTry.length > 1) {
        console.warn(`[LLM] ${m} failed, trying next fallback... (${e.message.slice(0, 120)})`);
      }
    }
  }
  throw lastError;
}

async function getLiteLLM(path) {
  const response = await fetch(process.env.LITELLM_URL + path, {
    headers: {
      'Authorization': 'Bearer ' + process.env.LITELLM_VIRTUAL_KEY,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM GET ${response.status}: ${text}`);
  }
  return response.json();
}

// ═══════════════════════════════════════════════════════════════
//  LITELLM MODEL AUTO-DETECTION (priority + fallback)
// ═══════════════════════════════════════════════════════════════

let modelPriorityList = [];

function extractVersion(modelId) {
  const match = modelId.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

async function discoverLiteLLMModels() {
  try {
    const data = await getLiteLLM('/v1/models');
    const models = (data?.data || []).map((m) => m.id).filter(Boolean);
    if (models.length === 0) {
      console.warn('[LiteLLM] No models found on server');
      return;
    }

    console.log(`[LiteLLM] Available models: ${models.join(', ')}`);

    const geminiModels = models.filter((m) => m.toLowerCase().includes('gemini'));
    const nonGemini = models.filter((m) => !m.toLowerCase().includes('gemini'));

    // Sort Gemini by version descending (3.1 > 3.0 > 2.0)
    geminiModels.sort((a, b) => extractVersion(b) - extractVersion(a));

    modelPriorityList = [...geminiModels, ...nonGemini];

    process.env._LITELLM_MODEL_PRIORITY = JSON.stringify(modelPriorityList);

    console.log(`[LiteLLM] Priority order: ${modelPriorityList.join(' → ')}`);
    console.log(`[LiteLLM] Primary: ${modelPriorityList[0]}${modelPriorityList.length > 1 ? ` | Fallback: ${modelPriorityList.slice(1).join(', ')}` : ''}`);
  } catch (e) {
    console.warn('[LiteLLM] Could not auto-detect models:', e.message);
  }
}

function getPrimaryModel() {
  return modelPriorityList[0] || null;
}

function getFallbackModels() {
  return modelPriorityList.slice(1);
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
  text: z.string().min(1).max(2000),
  platform: z.string().min(1),
  model: z.string().optional(),
});

const AICorrectSchema = z.object({
  text: z.string().min(1).max(2000),
  model: z.string().optional(),
});

const AIDefineSchema = z.object({
  word: z.string().min(1).max(100),
  model: z.string().optional(),
});

const AISummarizeSchema = z.object({
  url: z.string().url().max(2000),
  model: z.string().optional(),
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
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
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

app.use('/api/v1/auth', authRouter);

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

function mapArticleRow(row) {
  let meta = {};
  try { meta = row.content_json ? JSON.parse(row.content_json) : {}; } catch {}

  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
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
    summaryMarkdown: row.summary_markdown || '',
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
    const result = await syncNewsFeeds(pool, { reason: 'manual' });
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
    const cur = await pool.query('SELECT * FROM news_articles WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Article not found' });
    await pool.query('UPDATE news_articles SET read = TRUE, updated_at = NOW() WHERE id = $1', [id]);
    const updated = await pool.query('SELECT * FROM news_articles WHERE id = $1', [id]);
    res.json({ article: mapArticleRow(updated.rows[0]) });
  } catch (err) {
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
    syncNewsFeeds(pool, config).catch((e) => console.error('[NEWS] force-resync error:', e));
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

app.use('/api/v1/news', newsRouter);

// ═══════════════════════════════════════════════════════════════
//  ROUTES — AI  /api/v1/ai
// ═══════════════════════════════════════════════════════════════

const aiRouter = express.Router();

aiRouter.post('/rephrase', async (req, res, next) => {
  try {
    const val = validate(AIRephraseSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const platformId = normalizeRephrasePlatformId(val.data.platform) || 'casual';
    const systemPrompt = buildRephraseSystemPrompt(platformId);

    const result = await callLiteLLM({
      model: val.data.model || undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: val.data.text },
      ],
      maxTokens: 800,
      temperature: 0.5,
    });

    const parsed = parseJsonContent(result.content);
    const rephrasedText = asString(
      parsed?.rephrasedText || parsed?.rephrased_text || parsed?.text || '',
    );

    res.json({
      platform: platformId,
      rephrasedText: rephrasedText || val.data.text,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.post('/correct', async (req, res, next) => {
  try {
    const val = validate(AICorrectSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const result = await callLiteLLM({
      model: val.data.model || undefined,
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

    res.json({
      correctedText: correctedText || val.data.text,
      explanation,
      variations,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.post('/define', async (req, res, next) => {
  try {
    const val = validate(AIDefineSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const systemPrompt = buildDictionarySystemPrompt(val.data.word);

    const result = await callLiteLLM({
      model: val.data.model || undefined,
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
    next(err);
  }
});

// HTML → text helper
function stripHtmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
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

aiRouter.post('/summarize', async (req, res, next) => {
  try {
    const val = validate(AISummarizeSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const url = val.data.url;
    console.log('[SUMMARIZE] Starting for URL:', url);

    let content = '';
    let title = '';
    let extractionMethod = 'none';

    // ── Stage 1: Direct HTTP fetch (free, fast) ──────────────────────────
    try {
      console.log('[SUMMARIZE] Stage 1: Direct HTTP fetch...');
      const directRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      if (directRes.ok) {
        const html = await directRes.text();
        title = extractTitleFromHtml(html);
        const text = stripHtmlToText(html);
        if (text.length > 500) {
          content = text.slice(0, 12000);
          extractionMethod = 'direct-fetch';
          console.log('[SUMMARIZE] Direct fetch got', content.length, 'chars, title:', title.slice(0, 60));
        } else {
          console.log('[SUMMARIZE] Direct fetch got only', text.length, 'chars — too short');
        }
      } else {
        console.warn('[SUMMARIZE] Direct fetch status:', directRes.status);
      }
    } catch (fetchErr) {
      console.warn('[SUMMARIZE] Direct fetch error:', fetchErr.message?.slice(0, 100));
    }

    // ── Stage 2: Paywall / blocked check ─────────────────────────────────
    const isBlocked = content.length < 500
      || /subscribe to (read|continue)|sign in to continue|create.*free.*account|paywall|premium content|login required/i.test(content);

    // ── Stage 3: Zyte browser extraction (for JS-heavy/paywalled sites) ──
    const zyteKey = process.env.ZYTE_API_KEY;
    if (isBlocked && zyteKey) {
      try {
        console.log('[SUMMARIZE] Stage 3: Trying Zyte browser extraction...');
        const zyteRes = await fetch('https://api.zyte.com/v1/extract', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(zyteKey + ':').toString('base64'),
          },
          body: JSON.stringify({
            url,
            browserHtml: true,
            actions: [{ action: 'scrollPage' }],
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (zyteRes.ok) {
          const zyteData = await zyteRes.json();
          const articleBody = zyteData?.article?.articleBody || '';
          const headline = zyteData?.article?.headline || '';

          if (articleBody.length > 200) {
            content = articleBody.slice(0, 12000);
            title = headline || title;
            extractionMethod = 'zyte-article';
            console.log('[SUMMARIZE] Zyte article:', content.length, 'chars');
          } else if (zyteData?.browserHtml) {
            const text = stripHtmlToText(zyteData.browserHtml);
            if (text.length > 300) {
              content = text.slice(0, 12000);
              if (!title) title = extractTitleFromHtml(zyteData.browserHtml);
              extractionMethod = 'zyte-html';
              console.log('[SUMMARIZE] Zyte HTML:', content.length, 'chars');
            }
          }
        } else {
          console.warn('[SUMMARIZE] Zyte status:', zyteRes.status);
        }
      } catch (zyteErr) {
        console.warn('[SUMMARIZE] Zyte error:', zyteErr.message?.slice(0, 100));
      }
    }

    // ── Stage 4: Parallel fallback (Tavily + Gemini Grounding race) ──────
    const stillBlocked = content.length < 500;
    if (stillBlocked) {
      console.log('[SUMMARIZE] Stage 4: Parallel research fallback...');
      const searchQuery = title
        ? `Detailed information about: ${title}`
        : `Full content and details from: ${url}`;

      const runners = [];

      // 4a: Tavily
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (tavilyKey) {
        runners.push(
          (async () => {
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

              if (!tavilyRes.ok) return { text: '', method: 'tavily-search' };

              const tavilyData = await tavilyRes.json();
              const snippets = (tavilyData?.results || [])
                .map(r => r.content || '').filter(Boolean).join('\n\n');
              const answer = tavilyData?.answer || '';
              const combined = answer
                ? `Research Summary:\n${answer}\n\nDetailed Sources:\n${snippets}`
                : snippets;

              return { text: combined, method: 'tavily-search' };
            } catch (e) {
              console.warn('[SUMMARIZE] Tavily error:', e.message?.slice(0, 100));
              return { text: '', method: 'tavily-search' };
            }
          })(),
        );
      }

      // 4b: Gemini Google Search Grounding
      if (isGroundingAvailable()) {
        runners.push(
          (async () => {
            try {
              const gr = await groundedExtract(url, title, { timeoutMs: 25000 });
              return { text: gr.content, method: gr.extractionMethod };
            } catch (e) {
              console.warn('[SUMMARIZE] Grounding error:', e.message?.slice(0, 100));
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
          console.log(`[SUMMARIZE] Best fallback: ${best.method} (${content.length} chars)`);
        }
      }
    }

    if (!content || content.length < 100) {
      return res.status(422).json({
        error: 'Could not extract content from this URL. Ensure the link is complete (starts with https://) and the page is publicly accessible.',
      });
    }

    // ── Stage 5: LLM summarization ────────────────────────────────────────
    console.log('[SUMMARIZE] Stage 5: LLM →', content.length, 'chars (method:', extractionMethod, ')');

    const systemPrompt = buildSummarizerSystemPrompt(url);
    const llmResult = await callLiteLLM({
      model: val.data.model || undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `URL: ${url}\n\nExtracted content:\n${content.slice(0, 10000)}` },
      ],
      maxTokens: 3000,
      temperature: 0.3,
    });

    const parsed = parseJsonContent(llmResult.content);
    console.log('[SUMMARIZE] LLM keys:', Object.keys(parsed || {}));

    const summary = asString(parsed?.summary || parsed?.content || '');
    const rawKeyPoints = parsed?.keyPoints || parsed?.key_points || parsed?.highlights || parsed?.takeaways || [];
    const keyPoints = (Array.isArray(rawKeyPoints) ? rawKeyPoints : [])
      .map(p => asString(p)).filter(Boolean);

    res.json({
      title: asString(parsed?.title || title || ''),
      summary: summary || 'Summary could not be generated.',
      keyPoints,
      category: asString(parsed?.category || ''),
      readTime: typeof parsed?.readTime === 'number' ? parsed.readTime : (parseInt(parsed?.readTime) || 3),
      source: asString(parsed?.source || ''),
      extractionMethod,
      url,
      model: llmResult.model_used,
      usage: llmResult.usage,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ai/smart-parse
const AISmartParseSchema = z.object({
  text: z.string().min(2).max(5000),
});

aiRouter.post('/smart-parse', async (req, res, next) => {
  try {
    const val = validate(AISmartParseSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { text } = val.data;
    console.log('[AI] smart-parse →', text);

    const result = await callLiteLLM({
      messages: [
        { role: 'system', content: SMART_PARSE_SYSTEM_PROMPT },
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
    next(err);
  }
});

// POST /api/v1/ai/categorize
const AICategorizeSchema = z.object({
  description: z.string().min(2).max(500),
});

aiRouter.post('/search', async (req, res, next) => {
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
    next(err);
  }
});

// POST /api/v1/ai/grounded-search  (Gemini + Google Search)
aiRouter.post('/grounded-search', async (req, res, next) => {
  try {
    const { query, model } = req.body || {};
    if (!query || String(query).trim().length < 2) {
      return res.status(400).json({ error: 'query is required (min 2 chars)' });
    }

    if (!isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured for grounding' });
    }

    const result = await groundedSearch(String(query).trim(), { model });

    res.json({
      answer: result.text,
      query: String(query).trim(),
      model: result.model,
      searchQueries: result.searchQueries,
      sources: result.sources,
      citations: result.citations,
      usage: result.usage,
    });
  } catch (err) {
    if (err.name === 'GroundingError') {
      return res.status(err.status || 500).json({
        error: err.message,
        code: err.code,
      });
    }
    next(err);
  }
});

// POST /api/v1/ai/search-followup  (Gemini 3.1 Pro + Google Search — follow-up on a search result)
aiRouter.post('/search-followup', async (req, res, next) => {
  try {
    const { query, initialAnswer, question, history, model } = req.body || {};

    if (!question || String(question).trim().length < 2) {
      return res.status(400).json({ error: 'question is required (min 2 chars)' });
    }

    if (!isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const safeQuery = String(query || '').slice(0, 500);
    const trimmedQ = String(question).trim();
    const histLen = Array.isArray(history) ? history.length : 0;
    const modelTag = model ? String(model) : 'default';
    const cacheKey = `sf::${safeQuery}::${trimmedQ.slice(0, 200)}::${histLen}::${modelTag}`;

    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[SearchFollowUp] DB cache hit — returning instantly');
      return res.json(dbCached);
    }

    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[SearchFollowUp] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const answerSnippet = String(initialAnswer || '').slice(0, 1500);
    const systemInstruction =
      `You are a knowledgeable research assistant with access to Google Search. ` +
      `The user previously searched for "${safeQuery}"` +
      (answerSnippet
        ? ` and received this initial answer:\n\n---\n${answerSnippet}\n---\n\n`
        : '. ') +
      `Answer follow-up questions using Google Search for the latest real-time information. ` +
      `Provide comprehensive, well-structured answers with markdown formatting. ` +
      `Cite sources when possible. Maintain conversation continuity across follow-ups.`;

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
    if (model) converseOpts.model = String(model);

    const apiPromise = (async () => {
      try {
        const result = await groundedConverse(turns, systemInstruction, converseOpts);
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources,
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (err) {
        _inflight.delete(cacheKey);
        throw err;
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!res.headersSent) res.json(response);
  } catch (err) {
    if (err.name === 'GroundingError') {
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

// POST /api/v1/ai/deep-research  (Gemini 3.1 Pro + Google Search — thorough URL analysis)
aiRouter.post('/deep-research', async (req, res, next) => {
  try {
    const { url, question, history } = req.body || {};

    if (!url || String(url).trim().length < 5) {
      return res.status(400).json({ error: 'url is required' });
    }

    if (!isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const safeUrl = String(url).slice(0, 500);
    const safeQuestion = question ? String(question).trim() : '';
    const histLen = Array.isArray(history) ? history.length : 0;
    const cacheKey = `dr::${safeUrl}::${(safeQuestion || 'init').slice(0, 200)}::${histLen}`;

    // 1) Check Postgres (persists across restarts, 24h TTL)
    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[DeepResearch] DB cache hit — returning instantly');
      return res.json(dbCached);
    }

    // 2) Check in-flight promise (same request from a prior disconnected client)
    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[DeepResearch] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const systemInstruction =
      `You are an expert deep research analyst with access to Google Search. ` +
      `The user has provided a URL: ${safeUrl}\n\n` +
      `IMPORTANT: Use Google Search to find and read the ORIGINAL page at that URL plus any related articles, sources, and references. ` +
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

    const apiPromise = (async () => {
      try {
        const result = await groundedConverse(turns, systemInstruction, {
          timeoutMs: 120000,
          maxTokens: 8192,
          temperature: 0.5,
        });
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources,
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (err) {
        _inflight.delete(cacheKey);
        throw err;
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!res.headersSent) res.json(response);
  } catch (err) {
    if (err.name === 'GroundingError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// POST /api/v1/ai/article-followup  (Gemini 3.1 Pro + Google Search — multi-turn)
aiRouter.post('/article-followup', async (req, res, next) => {
  try {
    const { articleUrl, articleTitle, question, history } = req.body || {};

    if (!question || String(question).trim().length < 2) {
      return res.status(400).json({ error: 'question is required (min 2 chars)' });
    }

    if (!isGroundingAvailable()) {
      return res.status(503).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const safeTitle = String(articleTitle || 'this article').slice(0, 200);
    const safeUrl = String(articleUrl || '').slice(0, 500);
    const trimmedQ = String(question).trim();
    const histLen = Array.isArray(history) ? history.length : 0;
    const cacheKey = `fu::${safeUrl}::${trimmedQ.slice(0, 200)}::${histLen}`;

    // 1) Check Postgres (persists across restarts, 24h TTL)
    const dbCached = await _getFromDbCache(cacheKey);
    if (dbCached) {
      console.log('[FollowUp] DB cache hit — returning instantly');
      return res.json(dbCached);
    }

    // 2) Check in-flight promise (same request from a prior disconnected client)
    const flight = _inflight.get(cacheKey);
    if (flight?.pending) {
      console.log('[FollowUp] Awaiting in-flight request from prior connection');
      try { return res.json(await flight.pending); } catch { /* fall through */ }
    }

    const systemInstruction =
      `You are an expert news analyst and research assistant. ` +
      `The user is reading an article titled "${safeTitle}"` +
      (safeUrl ? ` (source: ${safeUrl}).` : '.') +
      `\n\nIMPORTANT: Use the Google Search tool to find the ORIGINAL source article and any related real-time information. ` +
      `Do NOT rely on any pre-summarized version — always base your answers on the actual source content and live web data. ` +
      `Provide comprehensive, accurate, well-structured answers. Cite sources when possible. ` +
      `If the user asks a follow-up, use the conversation context to maintain continuity.`;

    const turns = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h && h.role && h.text) {
          turns.push({ role: String(h.role), text: String(h.text).slice(0, 4000) });
        }
      }
    }
    turns.push({ role: 'user', text: trimmedQ });

    const apiPromise = (async () => {
      try {
        const result = await groundedConverse(turns, systemInstruction, {
          timeoutMs: 90000,
          maxTokens: 8192,
          temperature: 0.7,
        });
        const payload = {
          answer: result.text,
          model: result.model,
          sources: result.sources,
          searchQueries: result.searchQueries || [],
        };
        await _putToDbCache(cacheKey, payload);
        _inflight.delete(cacheKey);
        return payload;
      } catch (err) {
        _inflight.delete(cacheKey);
        throw err;
      }
    })();

    _inflight.set(cacheKey, { pending: apiPromise, ts: Date.now() });

    const response = await apiPromise;
    if (!res.headersSent) res.json(response);
  } catch (err) {
    if (err.name === 'GroundingError') {
      return res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

aiRouter.post('/categorize', async (req, res, next) => {
  try {
    const val = validate(AICategorizeSchema, req.body);
    if (!val.ok) return res.status(400).json({ error: val.error });

    const { description } = val.data;
    console.log('[AI] categorize →', description);

    const result = await callLiteLLM({
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

    res.json({
      category: parsed.category || 'Others',
      confidence: parsed.confidence || 'matched',
      reasoning: parsed.reasoning || '',
      score: typeof parsed.score === 'number' ? parsed.score : 0.85,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/ai', aiRouter);

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

llmRouter.get('/models', async (_req, res, next) => {
  try {
    const data = await getLiteLLM('/v1/models');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

llmRouter.post('/complete', async (req, res, next) => {
  try {
    const v = validate(LLMCompleteSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { messages, model, max_tokens, temperature } = v.data;

    const result = await callLiteLLM({
      messages,
      model: model || undefined,
      maxTokens: max_tokens || 2048,
      temperature: temperature ?? 0.7,
    });

    res.json({
      content: result.content,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    next(err);
  }
});

llmRouter.post('/summarize', async (req, res, next) => {
  try {
    const v = validate(LLMSummarizeSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { text, max_length, model } = v.data;

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

    res.json({
      summary: result.content,
      model: result.model_used,
      usage: result.usage,
    });
  } catch (err) {
    next(err);
  }
});

llmRouter.post('/correct', async (req, res, next) => {
  try {
    const v = validate(LLMCorrectSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { text, tone, platform, platforms, model } = v.data;
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
    next(err);
  }
});

app.use('/api/v1/llm', llmRouter);

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

app.use('/api/v1/sync', syncRouter);

// ═══════════════════════════════════════════════════════════════
//  SAVED WORDS
// ═══════════════════════════════════════════════════════════════

const savedWordsRouter = express.Router();

// GET all saved words
savedWordsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM saved_words ORDER BY saved_at DESC',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST create/upsert a saved word
savedWordsRouter.post('/', async (req, res, next) => {
  try {
    const { id, word, definition, pronunciation, partOfSpeech, savedAt, responseJson } = req.body;
    if (!id || !word) {
      return res.status(400).json({ error: 'id and word are required' });
    }

    await pool.query(
      `INSERT INTO saved_words (id, word, definition, pronunciation, part_of_speech, saved_at, response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         word = EXCLUDED.word,
         definition = EXCLUDED.definition,
         pronunciation = EXCLUDED.pronunciation,
         part_of_speech = EXCLUDED.part_of_speech,
         response_json = EXCLUDED.response_json`,
      [
        id,
        word,
        definition || '',
        pronunciation || '',
        partOfSpeech || '',
        savedAt || new Date().toISOString(),
        responseJson || '{}',
      ],
    );

    console.log('[SAVED_WORDS] Upserted:', id, word);
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// DELETE a saved word
savedWordsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM saved_words WHERE id = $1', [id]);
    console.log('[SAVED_WORDS] Deleted:', id, '| rows:', result.rowCount);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/saved-words', savedWordsRouter);

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

app.use('/api/v1/article-chats', articleChatsRouter);

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
    })));
  } catch (err) {
    next(err);
  }
});

// POST create/upsert expense
expensesRouter.post('/', async (req, res, next) => {
  try {
    const { id, amount, description, category, bank, cardType, date, isManualCategory } = req.body;
    if (!id || amount == null) {
      return res.status(400).json({ error: 'id and amount are required' });
    }

    await pool.query(
      `INSERT INTO expenses (id, amount, description, category, bank, card_type, date, is_manual_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         amount = EXCLUDED.amount,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         bank = EXCLUDED.bank,
         card_type = EXCLUDED.card_type,
         date = EXCLUDED.date,
         is_manual_category = EXCLUDED.is_manual_category,
         updated_at = NOW()`,
      [id, amount, description || '', category || '', bank || '', cardType || '', date || '', !!isManualCategory],
    );

    console.log('[EXPENSES] Upserted:', id, description, amount);
    res.json({ ok: true, id });
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

// DELETE expense
expensesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    console.log('[EXPENSES] Deleted:', id, '| rows:', result.rowCount);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1/expenses', expensesRouter);

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

app.use('/api/v1/budget', budgetRouter);

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

app.use('/api/v1/category-learnings', learningsRouter);

// ═══════════════════════════════════════════════════════════════
//  404 + ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ═══════════════════════════════════════════════════════════════
//  DATABASE INIT — create tables if missing
// ═══════════════════════════════════════════════════════════════

async function initTables() {
  await pool.query(`
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
    );

    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      icon VARCHAR(50),
      color VARCHAR(20),
      sort_order INT DEFAULT 0
    );

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
    );

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
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      table_name VARCHAR(100) NOT NULL,
      record_id VARCHAR(255) NOT NULL,
      operation VARCHAR(20) NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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
    );

    CREATE TABLE IF NOT EXISTS deleted_guids (
      guid TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS article_chat_messages (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      model TEXT DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_acm_article ON article_chat_messages(article_id);

    CREATE TABLE IF NOT EXISTS saved_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '',
      pronunciation TEXT DEFAULT '',
      part_of_speech TEXT DEFAULT '',
      saved_at TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      amount DECIMAL(12,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      bank TEXT NOT NULL DEFAULT '',
      card_type TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      is_manual_category BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS budget_entries (
      id TEXT PRIMARY KEY,
      amount DECIMAL(12,2) NOT NULL,
      set_at TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_learnings (
      keyword TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ai_response_cache (
      cache_key TEXT PRIMARY KEY,
      result_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_response_cache (created_at);

  `);

  // Fix column type: old table may have `id UUID` but news-service generates TEXT ids
  try {
    await pool.query('ALTER TABLE news_articles ALTER COLUMN id TYPE TEXT');
    console.log('[DB] Changed news_articles.id from UUID to TEXT');
  } catch (e) {
    // already TEXT or doesn't exist yet — ignore
  }

  // Migrate existing news_articles table — add columns that may be missing
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
    try {
      await pool.query(`ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (e) {
      // column already exists — ignore
    }
  }

  // Create indexes after migration so columns are guaranteed to exist
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_news_guid ON news_articles(guid);
      CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at);
      CREATE INDEX IF NOT EXISTS idx_news_updated ON news_articles(updated_at);
    `);
  } catch (e) {
    console.warn('[DB] Index creation warning:', e.message);
  }

  console.log('[DB] Tables initialized');
}

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

(async () => {
  try {
    await initTables();
    await discoverLiteLLMModels();
    startScheduler(pool);
  } catch (err) {
    console.error('[INIT] Startup error:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Nexus AI API running on port ${PORT}`);
    console.log(`LiteLLM: ${process.env.LITELLM_URL}`);
    console.log(`Model: ${getPrimaryModel() || 'none detected'}${getFallbackModels().length > 0 ? ` (fallback: ${getFallbackModels().join(', ')})` : ''}`);
    console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`);
  });
})();
