'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED SERVICE — PostgreSQL-compatible daily X post digest scheduler
//
//  Fetches posts from tracked X handles via Grok Responses API (x_search),
//  generates digest articles, and stores them as news_articles.
//
//  Ported from backend/x_feed/* (SQLite) → PostgreSQL for Docker deployment.
//  Schedule: twice daily — 8 AM IST (08:00) and 9 PM IST (21:00).
// ═══════════════════════════════════════════════════════════════════════

const { createHash } = require('crypto');
const { tg } = require('./telegram');
const {
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
} = require('./xgrok');

// ── Constants ───────────────────────────────────────────────────────────

const SCHEDULE_TIMES_IST = [
  { hour: 8, minute: 0 },   // 8 AM IST — morning digest
  { hour: 21, minute: 0 },  // 9 PM IST — evening digest
];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const X_FEED_HANDLES = [
  {
    handle: 'KobeissiLetter',
    displayName: 'The Kobeissi Letter',
    category: 'Finance',
    tag: 'Daily Brief',
    defaultImage:
      'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
  },
];

const XGROK_API_BASE = 'https://api.x.ai/v1';
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 120_000;
const SUMMARIZE_TIMEOUT_MS = 90_000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10_000;
const CATCHUP_THRESHOLD_MS = 10 * 60 * 60 * 1000; // 10h — less than the smallest trigger gap (11h)

const VISION_TIMEOUT_MS = 60_000;
const VISION_CONCURRENCY = 3;
const VISION_MAX_RETRIES = 2;
const VISION_MAX_IMAGES_PER_RUN = 20;

async function _callLiteLLMFallback({ messages, temperature = 0.7, maxTokens = 4096, timeoutMs = 60_000 }) {
  const baseUrl = String(process.env.LITELLM_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('LITELLM_URL not configured — cannot fallback');

  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key.trim()}`;

  let model = null;
  try {
    const raw = process.env._LITELLM_MODEL_PRIORITY;
    if (raw) {
      const list = JSON.parse(raw);
      if (list.length > 0) model = list[0];
    }
  } catch {}

  const body = { messages, max_tokens: maxTokens, temperature };
  if (model) body.model = model;

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM fallback ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model_used: data.model || model || 'litellm-fallback',
    usage: data.usage || null,
  };
}

// ── State ───────────────────────────────────────────────────────────────

let _pool = null;
let _timer = null;
let _activeSyncPromise = null;
let _lastRunResult = null;

// ── Time-slot helpers (morning vs evening) ──────────────────────────────

function getCurrentSlot() {
  const istHour = nowIST().getUTCHours();
  return istHour < 14 ? 'morning' : 'evening';
}

function slotLabel(slot) {
  return slot === 'morning' ? 'Morning Brief' : 'Evening Brief';
}

// ── Retry / utility helpers ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(error) {
  if (!error) return false;
  const msg = error.message || String(error);
  if (/429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|EPIPE/i.test(msg)) return true;
  if (error.status && (error.status === 429 || error.status >= 500)) return true;
  return false;
}

function backoffDelay(attempt) {
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  const jitter = Math.random() * capped * 0.3;
  return Math.round(capped + jitter);
}

async function withRetry(fn, { maxAttempts = 3, tag = 'X-FEED', label = 'op' } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1);
        tg.w(tag, `Retry ${attempt}/${maxAttempts - 1} for ${label} (wait ${delay}ms)`);
        await sleep(delay);
      }
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      const isLast = attempt >= maxAttempts - 1;
      if (!retryable || isLast) {
        tg.e(tag, `${label} FAILED (${retryable ? 'exhausted' : 'non-retryable'}, attempt ${attempt + 1}/${maxAttempts})`, error);
        break;
      }
    }
  }
  throw lastError;
}

function createLimiter(concurrency) {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const next = queue.shift();
    next();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => { active--; runNext(); });
      });
      runNext();
    });
}

// ── IST time helpers ────────────────────────────────────────────────────

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function todayISTString() {
  return nowIST().toISOString().slice(0, 10);
}

function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function startOfTodayISTasUTC() {
  const ist = nowIST();
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS).toISOString();
}

function buildWindowLabels(sinceISO, untilISO) {
  const sinceIST = new Date(new Date(sinceISO).getTime() + IST_OFFSET_MS);
  const untilIST = new Date(new Date(untilISO).getTime() + IST_OFFSET_MS);

  const fmtDate = (d) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  const fmtTime = (d) => {
    let h = d.getUTCHours();
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm} IST`;
  };

  return {
    sinceLabel: `${fmtTime(sinceIST)} on ${fmtDate(sinceIST)}`,
    untilLabel: `${fmtTime(untilIST)} on ${fmtDate(untilIST)}`,
  };
}

// ── Scheduling ──────────────────────────────────────────────────────────

function msUntilNextRun() {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  let bestMs = Infinity;

  for (const { hour, minute } of SCHEDULE_TIMES_IST) {
    const target = new Date(istNow);
    target.setUTCHours(hour, minute, 0, 0);
    if (target <= istNow) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    const targetUTC = new Date(target.getTime() - IST_OFFSET_MS);
    const ms = targetUTC.getTime() - now.getTime();
    if (ms < bestMs) bestMs = ms;
  }

  return Math.max(0, bestMs);
}

function scheduleNextRun() {
  if (_timer) { clearTimeout(_timer); _timer = null; }

  const ms = msUntilNextRun();
  const hours = (ms / 3600000).toFixed(1);
  const nextIST = new Date(Date.now() + ms + IST_OFFSET_MS);
  const label = nextIST.toISOString().slice(0, 19).replace('T', ' ') + ' IST';

  tg.i('X-FEED/sched', `Next run in ${hours}h at ${label}`);
  console.log(`[X-FEED] Next run in ${hours}h at ${label}`);

  _timer = setTimeout(async () => {
    try {
      await runDailySync({ reason: 'scheduled' });
    } catch (e) {
      tg.e('X-FEED/sched', 'Scheduled run failed', e);
    }
    scheduleNextRun();
  }, ms);
}

// ── Database operations (PostgreSQL) ────────────────────────────────────

async function ensureXFeedTable() {
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS x_feed_sync_state (
      handle TEXT PRIMARY KEY,
      last_window_end TEXT,
      last_sync_at TIMESTAMPTZ,
      total_articles INTEGER NOT NULL DEFAULT 0,
      total_posts_processed INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `);
}

async function getSyncState(handle) {
  const { rows } = await _pool.query(
    'SELECT * FROM x_feed_sync_state WHERE handle = $1',
    [handle],
  );
  return rows[0] || null;
}

async function updateSyncState(handle, windowEnd, { postsProcessed = 0, error = null } = {}) {
  const now = new Date().toISOString();
  await _pool.query(
    `INSERT INTO x_feed_sync_state (handle, last_window_end, last_sync_at, total_articles, total_posts_processed, last_error)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT(handle) DO UPDATE SET
       last_window_end = EXCLUDED.last_window_end,
       last_sync_at = EXCLUDED.last_sync_at,
       total_posts_processed = x_feed_sync_state.total_posts_processed + EXCLUDED.total_posts_processed,
       last_error = EXCLUDED.last_error`,
    [handle, windowEnd, now, postsProcessed, error],
  );
}

async function incrementArticleCount(handle) {
  await _pool.query(
    'UPDATE x_feed_sync_state SET total_articles = total_articles + 1 WHERE handle = $1',
    [handle],
  );
}

function buildGuid(handle, dateStr, slot) {
  return `x-feed-${handle.toLowerCase()}-${dateStr}-${slot}`;
}

function buildArticleId(handle, dateStr, slot) {
  const hash = createHash('sha1').update(`${handle}|${dateStr}|${slot}`).digest('hex').slice(0, 8);
  return `xf-${handle.toLowerCase()}-${dateStr}-${slot.charAt(0)}-${hash}`;
}

async function articleExists(guid) {
  const { rows } = await _pool.query('SELECT id FROM news_articles WHERE guid = $1', [guid]);
  return rows.length > 0;
}

async function insertDigestArticle({ handle, dateStr, slot, title, excerpt, category, tag, source, image, readTime, summaryMarkdown, publishedAt, contentMeta }) {
  const guid = buildGuid(handle, dateStr, slot);
  const articleId = buildArticleId(handle, dateStr, slot);
  const now = new Date().toISOString();

  if (await articleExists(guid)) {
    tg.d('X-FEED/store', `Article ${guid} already exists — skip insert`);
    return null;
  }

  await _pool.query(
    `INSERT INTO news_articles (
       id, title, category, tag, read_time, time_ago, date, image, excerpt, source,
       is_featured, content_json, saved, read, created_at, updated_at,
       guid, original_url, summary_markdown, published_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       FALSE, $11, FALSE, FALSE, $12, $13,
       $14, $15, $16, $17
     )`,
    [
      articleId, title, category, tag, readTime, 'Today', dateStr, image, excerpt, source,
      JSON.stringify(contentMeta), now, now,
      guid, `https://x.com/${handle}`, summaryMarkdown, publishedAt,
    ],
  );

  await _pool.query('UPDATE news_articles SET is_featured = FALSE WHERE is_featured = TRUE');
  await _pool.query('UPDATE news_articles SET is_featured = TRUE WHERE id = $1', [articleId]);
  await incrementArticleCount(handle);

  tg.i('X-FEED/store', `✓ Article stored: ${articleId} — "${title.slice(0, 50)}"`);
  return articleId;
}

// ── Fetcher: post retrieval via Grok x_search ───────────────────────────

function extractResponseText(data) {
  let text = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text') text += c.text || '';
      }
    }
  }
  return text;
}

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  try { return JSON.parse(trimmed); } catch { /* continue */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch { /* continue */ }
  }

  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch { /* continue */ }
  }

  return null;
}

function buildFetchPrompt(handle, sinceLabel, untilLabel) {
  const system = [
    'You are a data extraction agent with access to X (Twitter) search.',
    'Your ONLY job is to search X and return structured JSON.',
    'NEVER add commentary, explanations, or text outside the JSON.',
    'If you find zero posts, return exactly: {"posts_found": 0, "posts": []}',
  ].join(' ');

  const user = [
    `Search X for all ORIGINAL posts from @${handle}.`,
    '',
    `Time window: from ${sinceLabel} to ${untilLabel}`,
    '',
    'RULES:',
    '- Include ONLY original posts by this user',
    '- EXCLUDE all retweets, reposts, and quote-tweets',
    '- EXCLUDE replies to other users (replies to their OWN thread are OK)',
    '- Include the COMPLETE text of every post — do NOT truncate',
    '- If a post is part of a thread, include each individual post',
    '- For media: include ALL direct image URLs (jpg/jpeg/png) from the post',
    '  These are typically https://pbs.twimg.com/media/... URLs',
    '  Do NOT include video URLs, GIF URLs, or link preview thumbnails',
    '',
    'Return ONLY this JSON structure:',
    '{',
    '  "posts_found": <number>,',
    '  "posts": [',
    '    {',
    '      "text": "<complete post text>",',
    '      "time": "<posting time, e.g. 2:30 PM IST>",',
    '      "has_media": <true|false>,',
    '      "media_urls": ["<direct image URL>", ...],',
    '      "has_links": <true|false>,',
    '      "url": "<post URL or empty string>",',
    '      "is_thread": <true|false>',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  return { system, user };
}

async function fetchPostsSince(handle, sinceLabel, untilLabel) {
  const model = resolveXGrokModel('lite');
  const t0 = Date.now();
  const logLabel = `@${handle} [${sinceLabel} → ${untilLabel}]`;

  tg.d('X-FEED/fetch', `▶ Fetching posts: ${logLabel} (model=${model})`);

  const apiKey = process.env.XGROK_API_KEY;
  if (!apiKey) throw new Error('XGROK_API_KEY not configured');

  const { system, user } = buildFetchPrompt(handle, sinceLabel, untilLabel);

  const body = {
    model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_output_tokens: 16384,
    store: false,
    tools: [{ type: 'x_search' }],
  };

  const result = await withRetry(
    async () => {
      const response = await fetch(`${XGROK_API_BASE}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`Grok API ${response.status}: ${errText.slice(0, 300)}`);
        err.status = response.status;
        throw err;
      }
      return response.json();
    },
    { maxAttempts: MAX_RETRIES, tag: 'X-FEED/fetch', label: `fetch ${logLabel}` },
  );

  const responseText = extractResponseText(result);
  const elapsed = Date.now() - t0;

  if (!responseText) {
    tg.e('X-FEED/fetch', `Empty response for ${logLabel} (${elapsed}ms)`);
    return { postsFound: 0, posts: [], rawResponse: '', model, elapsed };
  }

  const parsed = extractJSON(responseText);

  if (parsed && typeof parsed.posts_found === 'number') {
    tg.i('X-FEED/fetch', `✓ ${logLabel}: ${parsed.posts_found} posts (${elapsed}ms)`);
    return {
      postsFound: parsed.posts_found,
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      rawResponse: responseText,
      model: result.model || model,
      elapsed,
    };
  }

  tg.w('X-FEED/fetch', `JSON parse failed for ${logLabel} — using raw text fallback (${responseText.length} chars)`);
  return { postsFound: -1, posts: [], rawResponse: responseText, model: result.model || model, elapsed };
}

// ── Vision: image analysis ──────────────────────────────────────────────

const ALLOWED_IMAGE_EXTENSIONS = /\.(jpe?g|png)(\?.*)?$/i;
const ALLOWED_IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com', 'ton.twimg.com'];

function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_IMAGE_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) return true;
    if (ALLOWED_IMAGE_EXTENSIONS.test(parsed.pathname)) return true;
    return false;
  } catch { return false; }
}

function collectImageTasks(posts) {
  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < posts.length; i++) {
    if (!posts[i].has_media) continue;
    for (const url of (Array.isArray(posts[i].media_urls) ? posts[i].media_urls : [])) {
      if (!isValidImageUrl(url)) continue;
      const key = url.split('?')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ postIndex: i, url, postText: (posts[i].text || '').slice(0, 200) });
    }
  }
  return tasks;
}

async function analyzeOneImage(task, model) {
  const apiKey = process.env.XGROK_API_KEY;
  if (!apiKey) throw new Error('XGROK_API_KEY not configured');

  const prompt = [
    'You are a financial chart/image analyst. Analyze this image from a finance-focused X post.',
    '', 'POST CONTEXT:', `"${task.postText}"`,
    '', 'EXTRACT: chart type, all numerical data points, axis labels, trends, annotations.',
    'Be PRECISE with numbers. If NOT a chart, say "non-chart: <brief>". Keep under 300 words.',
  ].join('\n');

  const response = await fetch(`${XGROK_API_BASE}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [
        { type: 'input_image', image_url: task.url, detail: 'high' },
        { type: 'input_text', text: prompt },
      ] }],
      temperature: 0.1,
      max_output_tokens: 2048,
      store: false,
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Grok Vision ${response.status}: ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  return extractResponseText(await response.json()).trim();
}

async function analyzePostImages(posts) {
  const t0 = Date.now();
  if (!posts || posts.length === 0) return { totalImages: 0, analyzed: 0, failed: 0, elapsed: 0, items: [] };

  const tasks = collectImageTasks(posts);
  if (tasks.length === 0) return { totalImages: 0, analyzed: 0, failed: 0, elapsed: Date.now() - t0, items: [] };
  if (tasks.length > VISION_MAX_IMAGES_PER_RUN) tasks.length = VISION_MAX_IMAGES_PER_RUN;

  const model = resolveXGrokModel('lite');
  tg.i('X-FEED/vision', `▶ Analyzing ${tasks.length} image(s) (model=${model})`);

  const limit = createLimiter(VISION_CONCURRENCY);
  const items = [];
  let analyzed = 0, failed = 0;

  await Promise.allSettled(tasks.map((task) =>
    limit(async () => {
      try {
        const analysis = await withRetry(() => analyzeOneImage(task, model), {
          maxAttempts: VISION_MAX_RETRIES, tag: 'X-FEED/vision', label: `image post#${task.postIndex + 1}`,
        });
        if (analysis && analysis.length > 10) {
          analyzed++;
          items.push({ postIndex: task.postIndex, url: task.url, analysis, success: true });
        } else {
          failed++;
          items.push({ postIndex: task.postIndex, url: task.url, analysis: '', success: false });
        }
      } catch (e) {
        failed++;
        items.push({ postIndex: task.postIndex, url: task.url, analysis: '', success: false });
      }
    }),
  ));

  tg.i('X-FEED/vision', `✓ Vision: ${analyzed}/${tasks.length} analyzed, ${failed} failed (${Date.now() - t0}ms)`);
  return { totalImages: tasks.length, analyzed, failed, elapsed: Date.now() - t0, items: items.sort((a, b) => a.postIndex - b.postIndex) };
}

// ── Summarizer: digest generation ───────────────────────────────────────

function formatPostsContent(posts, rawResponse, visionItems = []) {
  if (posts.length > 0) {
    const visionByPost = new Map();
    for (const vi of visionItems) {
      if (!vi.success || !vi.analysis) continue;
      if (!visionByPost.has(vi.postIndex)) visionByPost.set(vi.postIndex, []);
      visionByPost.get(vi.postIndex).push(vi.analysis);
    }
    return posts.map((p, i) => {
      const parts = [`--- Post ${i + 1}`];
      if (p.time) parts[0] += ` (${p.time})`;
      if (p.has_media) parts[0] += ' [📊 has chart/media]';
      if (p.is_thread) parts[0] += ' [🧵 thread]';
      parts[0] += ' ---';
      parts.push(p.text);
      if (p.url) parts.push(`Link: ${p.url}`);
      const analyses = visionByPost.get(i);
      if (analyses?.length > 0) {
        parts.push('', '📊 IMAGE/CHART DATA (extracted via vision analysis):');
        analyses.forEach((a, j) => { if (analyses.length > 1) parts.push(`[Image ${j + 1}]`); parts.push(a); });
      }
      return parts.join('\n');
    }).join('\n\n');
  }
  return rawResponse || '';
}

function buildSummarizerPrompts(handleConfig, dateLong, dateShort, postsContent, postsFound) {
  const system = [
    `You are a world-class financial journalist who writes the "${handleConfig.displayName}" daily market digest.`,
    '', 'YOUR WRITING STYLE:',
    '• Use simple language a college student in India can understand',
    '• Explain every financial term in parentheses, e.g. "hawkish stance (signaling rate hikes)"',
    '• Connect global events to Indian market impact (Nifty, Sensex, INR) when relevant',
    '• Every sentence must add value — no filler, no fluff',
    '• Use markdown formatting for clean readability',
    '', 'You MUST return a JSON object with this EXACT structure:',
    '{', '  "title": "<compelling title, 60-80 chars>",',
    '  "excerpt": "<1-2 sentence summary, max 200 chars>",',
    '  "article": "<full markdown article — see structure below>",',
    '  "stats": [{"value": "<number/pct>", "label": "<what it measures>"}],',
    '  "key_topics": ["topic1", "topic2", "topic3"]', '}',
    '', 'ARTICLE MARKDOWN STRUCTURE (inside "article" field):',
    '', '# 📊 The Kobeissi Letter', '',
    `### Daily Markets Brief — ${dateLong}`, '',
    '> One-line theme of today\'s market narrative', '', '---', '',
    '## 🔑 Key Takeaways', '- Bullet point 1', '- Bullet point 2', '- Bullet point 3', '',
    '## 📈 Detailed Analysis', '### <Sub-topic heading>', '<Clear explanation with numbers>', '',
    '## 💡 What This Means For You', '<Simple, actionable insight for retail investors in India>', '',
    '---', '',
    `*Daily digest from [@${handleConfig.handle}](https://x.com/${handleConfig.handle}) on X — ${dateShort}*`,
  ].join('\n');

  const user = [
    `Here are the posts from ${handleConfig.displayName} (@${handleConfig.handle}) on X:`,
    `Date: ${dateLong}`, `Posts found: ${postsFound > 0 ? postsFound : 'extracted from search'}`,
    '', postsContent, '',
    'INSTRUCTIONS:',
    '1. Cover EVERY major point from the posts — do not skip anything',
    '2. Explain complex financial concepts in very simple terms',
    '3. Highlight all key numbers, percentages, and market data',
    '4. Explain WHY each development matters to a regular person',
    '5. Include 3-5 stat items with the most important numbers',
    '6. When "📊 IMAGE/CHART DATA" sections are present, INCORPORATE these data points into the article',
    '', 'Return ONLY the JSON object. No other text.',
  ].join('\n');

  return { system, user };
}

function extractDigestJSON(text) {
  if (!text) return null;
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)?.[1]?.trim(),
    (() => { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); return s !== -1 && e > s ? text.slice(s, e + 1) : null; })(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj.article === 'string' && obj.article.length > 100) {
        return {
          title: String(obj.title || '').slice(0, 120),
          excerpt: String(obj.excerpt || '').slice(0, 250),
          article: obj.article,
          stats: Array.isArray(obj.stats) ? obj.stats : [],
          keyTopics: Array.isArray(obj.key_topics) ? obj.key_topics : [],
        };
      }
    } catch { /* next */ }
  }
  return null;
}

async function generateDigest(handleConfig, fetchResult, dateLong, dateShort, visionResult = null) {
  const model = resolveXGrokModel('lite');
  const t0 = Date.now();
  const label = `@${handleConfig.handle} ${dateShort}`;

  tg.d('X-FEED/summarize', `▶ Generating digest for ${label}`);

  const postsContent = formatPostsContent(fetchResult.posts, fetchResult.rawResponse, visionResult?.items || []);
  if (!postsContent || postsContent.trim().length < 20) {
    tg.w('X-FEED/summarize', `No meaningful content for ${label}`);
    return null;
  }

  const { system, user } = buildSummarizerPrompts(handleConfig, dateLong, dateShort, postsContent, fetchResult.postsFound);

  const digestMessages = [{ role: 'system', content: system }, { role: 'user', content: user }];

  let result;
  try {
    result = await withRetry(
      () => xgrokComplete({ model, messages: digestMessages, temperature: 0.4, maxTokens: 8000, timeoutMs: SUMMARIZE_TIMEOUT_MS }),
      { maxAttempts: 3, tag: 'X-FEED/summarize', label: `digest ${label}` },
    );
  } catch (xgrokErr) {
    const xgrokElapsed = Date.now() - t0;
    tg.w('X-FEED/summarize', `xGrok FAILED for ${label} ${xgrokElapsed}ms — falling back to LiteLLM: ${xgrokErr.message?.slice(0, 120)}`);
    try {
      result = await withRetry(
        () => _callLiteLLMFallback({ messages: digestMessages, temperature: 0.4, maxTokens: 8000, timeoutMs: SUMMARIZE_TIMEOUT_MS }),
        { maxAttempts: 3, tag: 'X-FEED/summarize', label: `LiteLLM-fallback ${label}` },
      );
      tg.i('X-FEED/summarize', `✓ LiteLLM fallback SUCCEEDED for ${label} model=${result.model_used} ${Date.now() - t0}ms`);
    } catch (litellmErr) {
      tg.e('X-FEED/summarize', `LiteLLM fallback ALSO failed for ${label} ${Date.now() - t0}ms — no digest possible`, litellmErr);
      return null;
    }
  }

  const elapsed = Date.now() - t0;
  const content = result.content || '';
  const parsed = extractDigestJSON(content);

  if (parsed) {
    tg.i('X-FEED/summarize', `✓ ${label}: "${parsed.title.slice(0, 50)}" (${elapsed}ms, ${parsed.article.length} chars)`);
    return { title: parsed.title, excerpt: parsed.excerpt, article: parsed.article, stats: parsed.stats, keyTopics: parsed.keyTopics, model: result.model_used || model, elapsed };
  }

  if (content.length > 200) {
    tg.w('X-FEED/summarize', `JSON parse failed for ${label} — raw content fallback (${content.length} chars)`);
    return {
      title: `${handleConfig.displayName}: Market Brief — ${dateShort}`,
      excerpt: `Daily market analysis from ${handleConfig.displayName}.`,
      article: content, stats: [], keyTopics: [], model: result.model_used || model, elapsed,
    };
  }

  tg.e('X-FEED/summarize', `Digest too short for ${label} (${content.length} chars)`);
  return null;
}

// ── Process a single handle ─────────────────────────────────────────────

async function processHandle(handleConfig) {
  const { handle, displayName, category, tag, defaultImage } = handleConfig;
  const t0 = Date.now();
  const today = todayISTString();
  const dateShort = formatDateShort(today);
  const dateLong = formatDateLong(today);
  const slot = getCurrentSlot();
  const guid = buildGuid(handle, dateShort, slot);

  tg.d('X-FEED/run', `▶ Processing @${handle} for ${dateShort} [${slot}]`);

  if (await articleExists(guid)) {
    tg.d('X-FEED/run', `⏭ @${handle} ${dateShort} [${slot}] already has a digest — skipping`);
    return { handle, skipped: true, reason: 'exists', slot };
  }

  const state = await getSyncState(handle);
  const windowStart = state?.last_window_end || startOfTodayISTasUTC();
  const windowEnd = new Date().toISOString();
  const { sinceLabel, untilLabel } = buildWindowLabels(windowStart, windowEnd);

  tg.d('X-FEED/run', `@${handle} window: ${sinceLabel} → ${untilLabel}`);

  let fetchResult;
  try {
    fetchResult = await fetchPostsSince(handle, sinceLabel, untilLabel);
  } catch (e) {
    tg.e('X-FEED/run', `Fetch failed for @${handle} [${slot}]`, e);
    try { await updateSyncState(handle, windowEnd, { error: `fetch: ${e.message}` }); } catch (dbErr) {
      tg.e('X-FEED/run', `DB state update also failed for @${handle}`, dbErr);
    }
    return { handle, skipped: false, error: `fetch: ${e.message}`, slot };
  }

  if (fetchResult.postsFound === 0) {
    tg.i('X-FEED/run', `No posts from @${handle} [${slot}] in window — window advanced`);
    try { await updateSyncState(handle, windowEnd, { postsProcessed: 0 }); } catch (dbErr) {
      tg.e('X-FEED/run', `DB state update failed for @${handle}`, dbErr);
    }
    return { handle, skipped: true, reason: 'no_posts', slot };
  }

  let visionResult = null;
  if (fetchResult.posts.some((p) => p.has_media)) {
    try {
      visionResult = await analyzePostImages(fetchResult.posts);
      tg.d('X-FEED/run', `@${handle} [${slot}] vision: ${visionResult.analyzed}/${visionResult.totalImages} images (${visionResult.elapsed}ms)`);
    } catch (e) {
      tg.w('X-FEED/run', `Vision failed for @${handle} [${slot}] — continuing: ${e.message}`);
    }
  }

  let digest;
  try {
    digest = await generateDigest(handleConfig, fetchResult, dateLong, dateShort, visionResult);
  } catch (e) {
    tg.e('X-FEED/run', `Summarize failed for @${handle} [${slot}]`, e);
    try { await updateSyncState(handle, windowEnd, { postsProcessed: fetchResult.postsFound > 0 ? fetchResult.postsFound : 0, error: `summarize: ${e.message}` }); } catch (dbErr) {
      tg.e('X-FEED/run', `DB state update also failed for @${handle}`, dbErr);
    }
    return { handle, skipped: false, error: `summarize: ${e.message}`, slot };
  }

  if (!digest) {
    tg.w('X-FEED/run', `No digest generated for @${handle} [${slot}]`);
    try { await updateSyncState(handle, windowEnd, { error: 'empty_digest' }); } catch (dbErr) {
      tg.e('X-FEED/run', `DB state update also failed for @${handle}`, dbErr);
    }
    return { handle, skipped: false, error: 'empty_digest', slot };
  }

  const postsCount = fetchResult.postsFound > 0 ? fetchResult.postsFound : fetchResult.posts.length;
  const readTimeVal = Math.max(1, Math.round(digest.article.split(/\s+/).filter(Boolean).length / 220));
  const publishedAt = new Date(today + 'T15:30:00.000Z').toISOString();

  const contentMeta = {
    sourceId: `x-feed-${handle.toLowerCase()}`,
    xHandle: `@${handle}`,
    postsCount,
    slot,
    originalUrl: `https://x.com/${handle}`,
    publishedAt,
    summaryMarkdown: digest.article,
    keyTopics: digest.keyTopics,
    blocks: digest.stats.length > 0
      ? [{ type: 'stat', items: digest.stats.map((s) => ({ value: s.value, label: s.label })) }]
      : [],
  };

  try {
    await updateSyncState(handle, windowEnd, { postsProcessed: postsCount });

    const articleId = await insertDigestArticle({
      handle, dateStr: dateShort, slot, title: digest.title, excerpt: digest.excerpt,
      category, tag: slotLabel(slot), source: displayName, image: defaultImage,
      readTime: readTimeVal, summaryMarkdown: digest.article,
      publishedAt, contentMeta,
    });

    if (!articleId) return { handle, skipped: true, reason: 'exists', slot };

    const elapsed = Date.now() - t0;
    const visionSummary = visionResult ? `Vision: ${visionResult.analyzed}/${visionResult.totalImages} (${visionResult.elapsed}ms)` : 'Vision: n/a';
    tg.i('X-FEED/run', [
      `✅ @${handle} [${slot}] digest complete!`,
      `Title: "${digest.title}"`,
      `Posts: ${postsCount} | Read: ${readTimeVal} min`,
      `Fetch: ${fetchResult.elapsed}ms | ${visionSummary} | Summarize: ${digest.elapsed}ms | Total: ${elapsed}ms`,
    ].join(' | '));

    return { handle, skipped: false, success: true, slot, articleId, title: digest.title, postsCount, readTime: readTimeVal, elapsed };
  } catch (e) {
    tg.e('X-FEED/run', `DB insert failed for @${handle} [${slot}]`, e);
    return { handle, skipped: false, error: `store: ${e.message}`, slot };
  }
}

// ── Main sync orchestrator ──────────────────────────────────────────────

async function runDailySync({ reason = 'scheduled' } = {}) {
  if (_activeSyncPromise) {
    tg.d('X-FEED/sync', `Already running — dedup (reason=${reason})`);
    return _activeSyncPromise;
  }

  _activeSyncPromise = (async () => {
    const syncT0 = Date.now();
    const today = todayISTString();
    const slot = getCurrentSlot();
    tg.i('X-FEED/sync', `▶ X Feed sync starting (reason=${reason}, slot=${slot}, date=${today})`);

    if (!_pool) {
      const msg = 'Database pool not initialized';
      tg.e('X-FEED/sync', msg);
      _lastRunResult = { success: false, error: msg, reason, timestamp: new Date().toISOString() };
      return _lastRunResult;
    }

    if (!isXGrokAvailable()) {
      const msg = 'xGrok unavailable — XGROK_API_KEY not set';
      tg.e('X-FEED/sync', msg);
      _lastRunResult = { success: false, error: msg, reason, timestamp: new Date().toISOString() };
      return _lastRunResult;
    }

    const results = [];
    let totalNew = 0, totalErrors = 0;

    for (const handleConfig of X_FEED_HANDLES) {
      try {
        const result = await processHandle(handleConfig);
        results.push(result);
        if (result.success) totalNew++;
        if (result.error) totalErrors++;
      } catch (e) {
        totalErrors++;
        tg.e('X-FEED/sync', `Unhandled error for @${handleConfig.handle}`, e);
        results.push({ handle: handleConfig.handle, skipped: false, error: e.message });
      }

      if (X_FEED_HANDLES.length > 1) await sleep(2000);
    }

    const syncElapsed = Date.now() - syncT0;
    _lastRunResult = {
      success: totalErrors === 0, reason, timestamp: new Date().toISOString(),
      date: today, totalNew, totalErrors, results, elapsedMs: syncElapsed,
    };

    const summary = results.map((r) => {
      const s = r.slot ? `[${r.slot}]` : '';
      if (r.success) return `@${r.handle}${s} ✅ "${r.title?.slice(0, 30)}"`;
      if (r.skipped) return `@${r.handle}${s} ⏭ ${r.reason}`;
      return `@${r.handle}${s} ❌ ${r.error?.slice(0, 50)}`;
    }).join(' | ');

    tg.i('X-FEED/sync', `✓ Done (${reason}, ${slot}): ${summary} — ${syncElapsed}ms`);
    return _lastRunResult;
  })().catch((e) => {
    tg.e('X-FEED/sync', `Sync CRASHED (${reason})`, e);
    _lastRunResult = { success: false, error: e.message, reason, timestamp: new Date().toISOString() };
    throw e;
  });

  try { return await _activeSyncPromise; }
  finally { _activeSyncPromise = null; }
}

// ── Public API ──────────────────────────────────────────────────────────

async function startXFeedScheduler(pool) {
  _pool = pool;

  if (!isXGrokAvailable()) {
    console.log('[X-FEED] xGrok not available — scheduler disabled');
    tg.w('X-FEED/sched', 'xGrok API key not set — scheduler disabled');
    return;
  }

  await ensureXFeedTable();

  const handles = X_FEED_HANDLES.map((h) => `@${h.handle}`).join(', ');
  const timeLabel = SCHEDULE_TIMES_IST.map((t) => `${t.hour}:${String(t.minute).padStart(2, '0')}`).join(' & ') + ' IST';
  console.log(`[X-FEED] Scheduler starting: handles=[${handles}] times=${timeLabel}`);
  tg.i('X-FEED/sched', `Starting: handles=[${handles}], schedule=${timeLabel}`);

  const needsCatchUp = await (async () => {
    for (const h of X_FEED_HANDLES) {
      const state = await getSyncState(h.handle);
      if (!state || !state.last_window_end) return true;
      const lastSync = new Date(state.last_sync_at || 0).getTime();
      if (Date.now() - lastSync > CATCHUP_THRESHOLD_MS) return true;
    }
    return false;
  })();

  if (needsCatchUp) {
    tg.i('X-FEED/sched', 'Catch-up needed — triggering startup sync in 10s');
    setTimeout(() => {
      runDailySync({ reason: 'startup-catchup' }).catch((e) => {
        tg.e('X-FEED/sched', 'Startup catch-up failed', e);
      });
    }, 10_000);
  }

  scheduleNextRun();
}

function stopXFeedScheduler() {
  if (_timer) { clearTimeout(_timer); _timer = null; tg.i('X-FEED/sched', 'Scheduler stopped'); }
}

async function manualXFeedSync() {
  return runDailySync({ reason: 'manual' });
}

function getXFeedStatus() {
  const handlesInfo = X_FEED_HANDLES.map((h) => ({
    handle: h.handle,
    displayName: h.displayName,
  }));

  return {
    schedulerActive: _timer !== null,
    xgrokAvailable: isXGrokAvailable(),
    lastRunResult: _lastRunResult,
    handles: handlesInfo,
    schedule: {
      timesIST: SCHEDULE_TIMES_IST.map((t) => `${t.hour}:${String(t.minute).padStart(2, '0')}`),
      nextRunMs: msUntilNextRun(),
      nextRunHours: (msUntilNextRun() / 3600000).toFixed(1),
    },
  };
}

module.exports = {
  startXFeedScheduler,
  stopXFeedScheduler,
  manualXFeedSync,
  getXFeedStatus,
};
