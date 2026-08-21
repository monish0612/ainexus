const { createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { tg } = require('./telegram');
const execFileP = promisify(execFile);
const {
  geminiComplete,
  isGeminiModel,
  stripGeminiPrefix,
  GeminiDirectError,
  ERROR_CODES: GEMINI_ERROR_CODES,
} = require('./gemini-direct');
// Trafilatura-grade clean extraction for `extraction_strategy: 'clean'`
// feeds (Movies / General) and the Gizbot listing scraper. Imported
// directly — no DI — because `news-extract.js` has no upstream deps on
// us. See `news-extract.js` for the public surface.
const {
  cleanExtract,
  fetchHtml,
  scrapeListingPage,
  extractGizbotProsConsRating,
  buildReviewMetaMarkdown,
  extractDateFromHtml,
  htmlToRichMarkdown,
  visibleTextLen,
  canonicalArticleUrl,
} = require('./news-extract');

// Prefer the copy that ships inside the API image (`api/news_rss_feeds.json`).
// Coolify/compose builds whose context is `./api` never see the repo-root
// file, which used to load `{ feeds: [] }` — X/Twitter still arrived via
// x-feed-service, but every RSS/listing article (movies, Finshots, etc.) vanished.
function resolveConfigPath() {
  const candidates = [
    process.env.NEWS_FEEDS_PATH,
    path.resolve(__dirname, '../news_rss_feeds.json'),
    path.resolve(__dirname, '../../news_rss_feeds.json'),
    '/app/news_rss_feeds.json',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[1] || path.resolve(__dirname, '../news_rss_feeds.json');
}

const CONFIG_PATH = resolveConfigPath();
const RSS_FETCH_TIMEOUT_MS = 45_000;
const RSS_UA = 'Nexus-AI-News/1.0';
const FEED_BUDGET_MS = 120_000;

const DEFAULT_SETTINGS = {
  refresh_interval_minutes: 30,
  max_articles_per_feed: 10,
  max_concurrent_feeds: 3,
  max_concurrent_summaries: 3,
  api_delay_seconds: 1.0,
  enable_image_analysis: true,
  article_retention_days: 30,
  max_summary_tokens: 2500,
};

let schedulerHandle = null;
let activeSyncPromise = null;
let lastSyncResult = null;
let lastSyncAt = null;
let lastSyncError = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.feeds)) parsed.feeds = [];
    return parsed;
  } catch (err) {
    console.error(`[NEWS] Failed to load RSS config from ${CONFIG_PATH}:`, err.message);
    tg.e('NEWS/config', `Failed to load ${CONFIG_PATH}: ${err.message}`);
    return { feeds: [], settings: DEFAULT_SETTINGS, summary_prompt: {} };
  }
}

function enabledFeeds(config) {
  return (config.feeds || []).filter((f) => f.enabled !== false);
}

function feedPriority(feed) {
  // Small / date-window feeds first so a hung 2 MB Substack download cannot
  // starve Movies / Gizbot / AI News of the 3 concurrent slots.
  if (feed.source_type === 'listing') return 0;
  if (Number(feed.max_age_days) > 0) return 1;
  const cat = String(feed.app_category || '');
  if (cat === 'General' || cat === 'AI News') return 2;
  return 3;
}

function getSettings(config) {
  return { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createLimiter(limit) {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            runNext();
          });
      });
      runNext();
    });
}

function escapeRegExp(v) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCdata(v = '') {
  return v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeHtmlEntities(v = '') {
  if (!v) return '';
  const named = {
    amp: '&', apos: "'", quot: '"', nbsp: ' ', ndash: '-', mdash: '-',
    rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...',
    copy: '(c)', reg: '(r)', trade: '(tm)',
  };
  let out = String(v);
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
      .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
      .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
  }
  return out;
}

function stripTags(v = '') {
  return String(v)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|article|section|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(v = '') {
  return String(v)
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function cleanHtml(html = '') {
  return normalizeWhitespace(stripTags(decodeHtmlEntities(stripCdata(html))));
}

function extractTag(block, tags) {
  for (const tag of tags) {
    const re = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'i');
    const m = block.match(re);
    if (m?.[1]) return decodeHtmlEntities(stripCdata(m[1].trim()));
  }
  return '';
}

function extractLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)];
  for (const m of links) {
    const href = m[1]?.match(/\shref=["']([^"']+)["']/i);
    if (!href?.[1]) continue;
    const rel = m[1]?.match(/\srel=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? 'alternate';
    if (rel === 'alternate' || rel === 'self') return href[1].trim();
  }
  return extractTag(block, ['link']);
}

function extractHtmlContent(block) {
  return ['content:encoded', 'content', 'summary', 'description']
    .map((t) => String(extractTag(block, [t]) || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
}

function absolutize(url, base) {
  if (!url) return '';
  try { return new URL(url, base || undefined).toString(); }
  catch { return url.startsWith('//') ? `https:${url}` : url; }
}

function extractImage(block, html, link) {
  const decoded = decodeHtmlEntities(stripCdata(html || ''));
  const imgMatch = decoded.match(/<img\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/i);
  if (imgMatch?.[1]) return absolutize(imgMatch[1].trim(), link);
  for (const re of [
    /<media:content\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
    /<media:thumbnail\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
    /<enclosure\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
  ]) {
    const m = block.match(re);
    if (m?.[1]) return absolutize(decodeHtmlEntities(m[1].trim()), link);
  }
  const t = extractTag(block, ['image', 'thumbnail']);
  return t ? absolutize(t, link) : '';
}

function stableGuid(raw, link, title) {
  const c = (raw || link || '').trim();
  if (c && c.length >= 12 && !c.endsWith('/')) return c;
  return createHash('sha1').update(`${link || ''}|${title || ''}`).digest('hex');
}

function parseFeedItems(xml) {
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const entries = items.length > 0 ? [] : [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return (items.length > 0 ? items : entries)
    .map((b) => {
      const title = normalizeWhitespace(extractTag(b, ['title'])) || 'Untitled';
      const link = extractLink(b);
      const guid = stableGuid(extractTag(b, ['guid', 'id']), link, title);
      const pubRaw = extractTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'created']);
      const html = extractHtmlContent(b);
      return { title, link, guid, pubRaw, html, text: cleanHtml(html), image: extractImage(b, html, link) };
    })
    .filter((i) => i.guid && (i.link || i.title));
}

function filterItemsByLinkPattern(items, pattern) {
  if (!pattern || !Array.isArray(items)) return items || [];
  let rx;
  try {
    rx = new RegExp(pattern, 'i');
  } catch {
    return items;
  }
  return items.filter((i) => rx.test(i.link || ''));
}

function movieTitleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\bmovie reviews?\b.*$/i, '')
    .replace(/\breviews?\b.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeFeedItems(items, { byTitle = false } = {}) {
  const byUrl = new Set();
  const titles = new Set();
  const out = [];
  for (const item of items || []) {
    const urlKey = canonicalArticleUrl(item.link) || String(item.link || '').toLowerCase();
    if (urlKey && byUrl.has(urlKey)) continue;
    const titleKey = byTitle ? movieTitleKey(item.title) : '';
    if (titleKey && titleKey.length >= 2 && titles.has(titleKey)) continue;
    if (urlKey) byUrl.add(urlKey);
    if (titleKey) titles.add(titleKey);
    out.push(item);
  }
  return out;
}

function parseDate(v) {
  if (!v) return new Date();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function dateToIST(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function isPublishedToday(pubDate) {
  return dateToIST(pubDate) === todayIST();
}

function fmtDate(d) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

function fmtTimeAgo(d) {
  const mins = Math.max(1, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return fmtDate(d);
}

function stripMd(v = '') {
  return normalizeWhitespace(
    String(v)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\|/g, ' ')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
      .replace(/[\u2550\u2500\u2501\u2503]+/g, ' ')
      .replace(/^\s*FORMAT\s*[::\uFF1A].+$/gim, '')
      .replace(/^\s*-{3,}\s*$/gm, ' ')
      .replace(/^\s*={3,}\s*$/gm, ' '),
  );
}

function cleanSummaryArtifacts(text) {
  if (!text) return text;
  return text
    .replace(/^[\s\u2550]+$/gm, '')
    .replace(/\u2550+/g, '')
    .replace(/^\s*FORMAT\s*[::\uFF1A].+$/gim, '')
    .replace(/^\s*TEMPLATE\s*[::\uFF1A].+$/gim, '')
    .replace(/^\s*\[TEMPLATE[^\]]*\]\s*$/gim, '')
    .replace(/^\s*\[UNIVERSAL RULES\]\s*$/gim, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/^\s*={3,}\s*$/gm, '')
    .replace(/^\s*_{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildExcerpt(summary, fallback) {
  const src = stripMd(summary || fallback || '');
  if (!src) return 'New article available.';
  if (src.length <= 220) return src;
  const t = src.slice(0, 217);
  const sp = t.lastIndexOf(' ');
  return `${(sp > 120 ? t.slice(0, sp) : t).trim()}...`;
}

function readTime(content) {
  return Math.max(1, Math.round(stripMd(content).split(/\s+/).filter(Boolean).length / 220));
}

function appendSourceLink(summary, url, source) {
  if (!summary || !url) return summary;
  if (summary.includes(url) || summary.includes('Read Original Article') || summary.includes('Read Full Article')) return summary.trim();

  const srcName = source || 'Source';
  const srcIcon = url.includes('finshots') ? '📰' : url.includes('zerodha') ? '📈'
    : url.includes('marktechpost') ? '🤖' : url.includes('machinelearningmastery') ? '🧠'
    : url.includes('towardsai') ? '🚀' : url.includes('towardsdatascience') ? '📊'
    : url.includes('kdnuggets') ? '💎' : url.includes('the-ken') ? '🔍'
    : url.includes('venturebeat') ? '⚡' : url.includes('techcrunch') ? '📰'
    : url.includes('artificialintelligence-news') ? '✨'
    : url.includes('lensmen') ? '🎬' : url.includes('sudhir-srinivasan') ? '🎬'
    : url.includes('gizbot') ? '📱' : '🔗';

  return `${summary.trim()}\n\n---\n\n## ${srcIcon} Read Original Article\n\n> **Want to dive deeper?** Access the full article with original charts, images, and detailed analysis.\n\n**[📖 Read Full Article on ${srcName} →](${url})**\n`.trim();
}

// ─────────────────────────────────────────────────────────────────────────
// FULL-CONTENT FORMATTER (skip_summary feeds)
// ─────────────────────────────────────────────────────────────────────────
//
// For feeds with `skip_summary: true` we DO NOT run the article through any
// LLM. Instead, we take the deep-extracted plain-text content and convert
// it into clean, readable Markdown the Flutter detail screen can render
// with its existing `_SummaryMarkdown` widget. The goal is "newspaper-grade
// readability" — proper paragraph breaks, sensible heading detection, and
// no junk leftover from the source HTML strip.
//
// The output is intentionally structured the SAME way an AI summary would
// be (title-less, paragraphs + optional section headings, ends with a
// "Read Original Article" link) so every downstream consumer — markdown
// renderer, TTS extractor, follow-up grounder — works without any
// branching on category.
// ─────────────────────────────────────────────────────────────────────────

function splitParagraphs(text) {
  if (!text) return [];
  const normalised = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Collapse any 3+ newlines to a clean paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // First pass: split on existing double newlines.
  const explicit = normalised.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (explicit.length >= 3) return explicit;

  // Fall-back: a single huge blob (Zyte / direct-fetch routes often return
  // one long line). Sentence-segment then group into ~3-sentence paragraphs
  // so the article is actually readable instead of a 12 000-char wall.
  const oneLine = normalised.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return [];
  const sentences = oneLine.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) || [oneLine];
  const groups = [];
  let buf = [];
  let bufLen = 0;
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    buf.push(s);
    bufLen += s.length;
    // Cap paragraphs around ~600 chars OR 3 sentences for mobile reading.
    if (buf.length >= 3 || bufLen >= 600) {
      groups.push(buf.join(' '));
      buf = [];
      bufLen = 0;
    }
  }
  if (buf.length > 0) groups.push(buf.join(' '));
  return groups;
}

// Lightweight heading detector: an all-caps short line, or a line that ends
// without sentence punctuation and is followed by long body text. Used very
// conservatively — getting it wrong is uglier than rendering the line as a
// regular paragraph, so we bias towards "treat as paragraph" unless the
// signal is unambiguous.
function looksLikeHeading(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[.!?:;…]$/.test(t)) return false;
  if (/^[A-Z0-9][^a-z]{2,}$/.test(t)) return true; // ALL CAPS
  if (/^[#*]+\s+/.test(t)) return true;            // existing md heading
  return false;
}

function escapeMd(s) {
  return String(s || '').replace(/([*_`~])/g, '\\$1');
}

// True when `content` already carries markdown block structure (rich
// extraction output: images, fenced code, headings, lists, blockquotes).
// Such content must NOT go through the sentence-grouping paragraph
// splitter — that would shatter fenced code blocks at blank lines and
// re-run heading detection on image lines. We pass it through verbatim.
function looksPreformatted(content) {
  if (!content) return false;
  return (
    content.includes('```') ||
    /(^|\n)!\[[^\]]*\]\(/.test(content) ||
    /(^|\n)#{1,3}\s/.test(content) ||
    /(^|\n)>\s/.test(content) ||
    /(^|\n)[-*]\s+\S/.test(content)
  );
}

// Collapse 3+ blank lines to a single paragraph break WITHOUT touching the
// interior of fenced code blocks (where blank lines are significant).
function collapseBlanksPreservingCode(md) {
  return String(md)
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\n{3,}/g, '\n\n')))
    .join('')
    .trim();
}

function buildFullContentMarkdown({ content, url, source }) {
  // Fast path: rich markdown from the extractor already has the right
  // block structure — just tidy blank lines and pin the source link.
  if (looksPreformatted(content)) {
    return appendSourceLink(collapseBlanksPreservingCode(content), url, source);
  }

  const paragraphs = splitParagraphs(content);
  if (paragraphs.length === 0) {
    // CAREFUL: the prose here must NOT contain the literal substring
    // "Read Original Article" or "Read Full Article" — `appendSourceLink`
    // uses those as "link already present" sentinels and would early-return
    // without attaching the actual source-link block. Phrased neutrally so
    // the appended link below it always renders.
    return appendSourceLink(
      `> _The article body could not be extracted at fetch time. Open the source link below to view the full piece on ${source || 'the source site'}._`,
      url,
      source,
    );
  }

  const mdBlocks = [];
  for (const para of paragraphs) {
    const firstNl = para.indexOf('\n');
    const head = firstNl >= 0 ? para.slice(0, firstNl) : para;
    const rest = firstNl >= 0 ? para.slice(firstNl + 1).trim() : '';
    if (rest && looksLikeHeading(head)) {
      mdBlocks.push(`## ${escapeMd(head.replace(/^[#*]+\s+/, '').trim())}`);
      mdBlocks.push(rest);
    } else {
      mdBlocks.push(para);
    }
  }

  return appendSourceLink(mdBlocks.join('\n\n').trim(), url, source);
}

function buildFullContentExcerpt(content) {
  const paras = splitParagraphs(content);
  const src = (paras[0] || content || '').replace(/\s+/g, ' ').trim();
  if (!src) return 'New article available.';
  if (src.length <= 240) return src;
  const t = src.slice(0, 237);
  const sp = t.lastIndexOf(' ');
  return `${(sp > 140 ? t.slice(0, sp) : t).trim()}…`;
}

// Sentinel emitted when the LLM call could not produce a summary for an
// article (model id not found, rate limited, blocked, …). Kept short
// and visually distinct from a real summary so the user immediately
// recognises it as a failure marker rather than mistaking the leading
// chunk of the article body for "the AI summary".
//
// Detection helpers downstream (the `news/clear-fallbacks` SQL clean-up,
// the Flutter detail screen's banner) match the `[summary-unavailable]`
// HTML comment marker so they don't have to depend on cosmetic copy.
const SUMMARY_UNAVAILABLE_MARKER = '<!-- summary-unavailable -->';

function fallbackSummary(title, content, url, source, reason) {
  const safeReason = reason ? String(reason).slice(0, 200) : '';
  const lines = [
    SUMMARY_UNAVAILABLE_MARKER,
    `> **Summary couldn't be generated for this article.**`,
    safeReason
      ? `> _Reason: ${safeReason}_`
      : `> _The AI service was unavailable. Tap "Read Original Article" below to view the full piece._`,
  ];
  const base = lines.join('\n');
  return appendSourceLink(base, url, source);
}

function isFallbackSummary(md) {
  if (!md || typeof md !== 'string') return false;
  return md.includes(SUMMARY_UNAVAILABLE_MARKER);
}

let _modelPriorityCache = null;

function _getModelPriority() {
  if (_modelPriorityCache) return _modelPriorityCache;
  const raw = process.env._LITELLM_MODEL_PRIORITY;
  if (raw) {
    try { _modelPriorityCache = JSON.parse(raw); return _modelPriorityCache; } catch {}
  }
  return null;
}

function _isRetryable(msg) {
  return /429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
}

async function _callLiteLLMOnce(model, messages, opts) {
  const baseUrl = String(process.env.LITELLM_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('LITELLM_URL env var not set');

  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key.trim()}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, ...opts }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`LiteLLM non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data?.error?.message || `LiteLLM ${res.status} [${model}]: ${text.slice(0, 300)}`);
  return data?.choices?.[0]?.message?.content || '';
}

async function callLiteLLM(model, messages, opts = {}) {
  const t0 = Date.now();
  const priority = _getModelPriority();

  // Build the candidate list. If the caller specified a Gemini model,
  // try that one first and use any other Gemini ids from the priority
  // list as automatic fallbacks (handles "user typed a bad model name"
  // gracefully so news summaries never silently degrade to the
  // "# title / ## Article Preview" fallback marker).
  const callerModel = typeof model === 'string' ? model.trim() : '';
  let modelsToTry;
  if (callerModel) {
    const fallbacks = (priority || []).filter((m) => m && m !== callerModel);
    modelsToTry = [callerModel, ...fallbacks];
  } else if (priority && priority.length > 0) {
    modelsToTry = [...priority];
  } else {
    modelsToTry = [];
  }

  if (modelsToTry.length === 0) {
    tg.e('NEWS-LLM', 'No models available — caller did not pass a model and _LITELLM_MODEL_PRIORITY is empty');
    throw new Error('No LLM models available — set a Gemini model in Settings or wait for LiteLLM discovery to complete');
  }

  tg.d('NEWS-LLM', `Calling models=[${modelsToTry.join(',')}]`);

  let lastError;
  for (let i = 0; i < modelsToTry.length; i++) {
    const m = modelsToTry[i];
    const isLast = i === modelsToTry.length - 1;
    const maxRetries = isLast ? 3 : 2;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          tg.w('NEWS-LLM', `Retry ${attempt + 1}/${maxRetries} model=${m}`);
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
        const result = await _callOne(m, messages, opts);
        tg.i('NEWS-LLM', `✓ model=${m} ${Date.now() - t0}ms${i > 0 ? ' (fallback)' : ''}`);
        return result;
      } catch (e) {
        lastError = e;
        const retryable = _isRetryableInThisLayer(e);

        // Non-retryable inside this model — break and try the next
        // candidate in the outer loop (don't burn the retry budget).
        if (!retryable || attempt >= maxRetries - 1) {
          if (modelsToTry.length > 1) {
            console.warn(
              `[NEWS-LLM] ${m} exhausted (${attempt + 1} attempts): ${(e.message || '').slice(0, 100)}`,
            );
            tg.w('NEWS-LLM', `${m} exhausted after ${attempt + 1} attempts → trying next candidate`, e);
          }
          break;
        }
      }
    }
  }
  console.error(`[NEWS-LLM] All models exhausted: ${modelsToTry.join(', ')}`);
  tg.e(
    'NEWS-LLM',
    `All models exhausted: ${modelsToTry.join(', ')} ${Date.now() - t0}ms`,
    lastError,
  );
  throw lastError;
}

// Single-call dispatcher: Gemini ids go direct to Google's REST API,
// everything else falls back to the legacy LiteLLM proxy. This keeps
// xGrok / Groq routing intact while letting a freshly-released Gemini
// model work without redeploying the proxy.
async function _callOne(modelId, messages, opts) {
  const bare = stripGeminiPrefix(modelId);
  if (isGeminiModel(modelId)) {
    const result = await geminiComplete({
      model: bare,
      messages,
      temperature: opts.temperature ?? 0.35,
      maxTokens: opts.max_tokens ?? opts.maxTokens ?? 2500,
      jsonOutput: !!opts.jsonOutput,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    return result.content || '';
  }
  return _callLiteLLMOnce(modelId, messages, opts);
}

function _isRetryableInThisLayer(err) {
  if (err instanceof GeminiDirectError) {
    return (
      err.code === GEMINI_ERROR_CODES.RATE_LIMIT ||
      err.code === GEMINI_ERROR_CODES.SERVER ||
      err.code === GEMINI_ERROR_CODES.NETWORK ||
      err.code === GEMINI_ERROR_CODES.TIMEOUT
    );
  }
  return _isRetryable(err.message);
}

function preferredModel() {
  const priority = _getModelPriority();
  return priority?.[0] || null;
}

// Compact, user-facing error reason for the `summary-unavailable`
// fallback. We slice + sanitise so it stays one line in the article
// detail screen ("Reason: …") and never leaks a stack trace.
function _shortErrorReason(err) {
  if (!err) return '';
  if (err instanceof GeminiDirectError) {
    const code = err.code ? `[${err.code}] ` : '';
    return `${code}${String(err.message || '').slice(0, 160)}`;
  }
  const raw = String(err.message || err);
  return raw.slice(0, 200);
}

function fillTemplate(tpl, title, content) {
  return String(tpl || '').replaceAll('{title}', title).replaceAll('{content}', content);
}

async function generateSummary({ title, content, imageUrl, promptKey, settings, config, completeFn, fallbackCompleteFn, liteModel, xgrokLiteModel }) {
  if (!content || content.trim().length < 100) return null;

  const pcfg = config[promptKey] || config.summary_prompt || {};
  const sys = pcfg.system || 'You are an expert educator who simplifies complex news.';
  const isTech = promptKey === 'tech_summary_prompt';
  const limit = isTech ? 10000 : 8000;
  const maxTok = settings.max_summary_tokens || 3500;
  const user = fillTemplate(
    pcfg.template || 'Summarize this article.\n\nTitle: {title}\n\nContent:\n{content}',
    title,
    content.slice(0, limit),
  );

  // Honour the user's settings.liteModel for ALL server-side LiteLLM calls.
  // Falls back to the discovered priority list only when the setting is unset
  // (e.g. on a fresh server before any client has synced their preferences).
  const _litellmComplete = (msgs, opts) =>
    callLiteLLM(liteModel || preferredModel(), msgs, opts);
  // For external providers (xGrok), prefer the user's configured xgrokLiteModel
  // so xGrok-routed news summaries also match what the Settings page shows.
  const _externalComplete = completeFn
    ? (msgs, opts) => completeFn(msgs, { ...opts, model: xgrokLiteModel || opts.model })
    : null;
  const _primaryComplete = _externalComplete || _litellmComplete;
  const _fallbackComplete = fallbackCompleteFn
    ? (msgs, opts) => fallbackCompleteFn(msgs, { ...opts, model: liteModel || opts.model })
    : (completeFn ? _litellmComplete : null);

  const buildMsgs = (useImg) => {
    const msgs = [{ role: 'system', content: sys }];
    if (useImg && settings.enable_image_analysis && imageUrl) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageUrl } }] });
    } else {
      msgs.push({ role: 'user', content: user });
    }
    return msgs;
  };

  const _tryComplete = async (completor, tag, useImg) => {
    const msgs = buildMsgs(useImg);
    const result = await completor(msgs, { temperature: 0.35, max_tokens: maxTok });
    const text = (typeof result === 'string' ? result : result?.text || result?.content || '').trim();
    if (!text || text.length < 50) {
      throw new Error(`${tag} returned insufficient output (${text.length} chars)`);
    }
    return text;
  };

  const t0 = Date.now();
  const providerTag = completeFn ? 'external' : 'litellm';
  const modelName = completeFn ? providerTag : (preferredModel() || 'auto');
  tg.d('NEWS/summary', `provider=${providerTag} model=${modelName} title="${title.slice(0, 60)}"`);

  // Strategy 1: Image analysis via LiteLLM (multimodal only — external providers skip this)
  if (settings.enable_image_analysis && imageUrl && !completeFn) {
    try {
      const s = await _tryComplete(_primaryComplete, providerTag, true);
      tg.i('NEWS/summary', `✓ ${providerTag} ${Date.now() - t0}ms (img) "${title.slice(0, 40)}"`);
      return s;
    } catch (e) {
      console.warn(`[NEWS] Image summary failed for "${title.slice(0, 50)}":`, e.message?.slice(0, 100));
      tg.w('NEWS/summary', `Image fallback ${providerTag} "${title.slice(0, 40)}"`, e);
    }
  }

  // Strategy 2: Text-only via primary provider
  try {
    const s = await _tryComplete(_primaryComplete, providerTag, false);
    tg.i('NEWS/summary', `✓ ${providerTag} ${Date.now() - t0}ms (text) "${title.slice(0, 40)}"`);
    return s;
  } catch (primaryErr) {
    const elapsed = Date.now() - t0;
    console.error(`[NEWS] Primary summary failed for "${title.slice(0, 50)}" (${providerTag}, ${elapsed}ms):`, primaryErr.message?.slice(0, 120));
    tg.e('NEWS/summary', `Primary FAIL ${providerTag} ${elapsed}ms "${title.slice(0, 40)}"`, primaryErr);

    // Strategy 3: Automatic fallback to LiteLLM if primary was external
    if (_fallbackComplete) {
      try {
        const s = await _tryComplete(_fallbackComplete, 'litellm-fallback', false);
        const fbElapsed = Date.now() - t0;
        console.log(`[NEWS] Fallback litellm ✓ for "${title.slice(0, 50)}" (${fbElapsed}ms)`);
        tg.i('NEWS/summary', `✓ litellm-fallback ${fbElapsed}ms (after ${providerTag} fail) "${title.slice(0, 40)}"`);
        return s;
      } catch (fallbackErr) {
        const fbElapsed = Date.now() - t0;
        console.error(`[NEWS] Fallback also failed for "${title.slice(0, 50)}" (${fbElapsed}ms):`, fallbackErr.message?.slice(0, 120));
        tg.e('NEWS/summary', `BOTH providers failed ${fbElapsed}ms "${title.slice(0, 40)}"`, fallbackErr);
      }
    }

    return null;
  }
}

async function processItem({ pool, item, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn, liteModel, xgrokLiteModel }) {
  const existing = await pool.query('SELECT id FROM news_articles WHERE guid = $1', [item.guid]);
  if (existing.rows.length > 0) return false;

  const deleted = await pool.query('SELECT guid FROM deleted_guids WHERE guid = $1', [item.guid]);
  if (deleted.rows.length > 0) return false;

  // Same review, different guid (RSS ?p= vs permalink, www vs bare host).
  if (item.link) {
    const canon = canonicalArticleUrl(item.link);
    const urlDup = await pool.query(
      `SELECT id FROM news_articles
        WHERE original_url = $1 OR original_url = $2 OR original_url = $3
        LIMIT 1`,
      [item.link, canon, canon ? `${canon}/` : ''],
    );
    if (urlDup.rows.length > 0) return false;
  }

  const title = item.title || 'Untitled';
  let pubDate = parseDate(item.pubRaw);
  const hadRssPubDate = !!item.pubRaw;
  const source = feed.name || feed.id;
  // Rich markdown straight from the RSS body (`content:encoded`). Preserves
  // the images / headings / lists / code that the plain-text `item.text`
  // drops. This is the base — and the fallback when live-page clean
  // extraction comes back empty (Substack / WordPress feeds that already
  // ship the full body in the feed, e.g. the Zerodha newsletters).
  const rssRichMarkdown = item.html
    ? htmlToRichMarkdown(item.html, { baseUrl: item.link })
    : '';
  let contentText = rssRichMarkdown || item.text || cleanHtml(item.html || '');

  // Structured review metadata (Gizbot only — set by clean-extract branch).
  let reviewMeta = null;
  let extractedTitle = '';

  // ── Extraction dispatch ────────────────────────────────────────────────
  //   • extraction_strategy: 'clean' → trafilatura-grade cheerio extractor
  //     (TechCrunch / Lensmen / Gizbot). Also surfaces a parsed publication
  //     date and the raw HTML — which we feed into the Gizbot pros/cons
  //     extractor when feed.id === 'gizbot_reviews'.
  //   • feed.deep_extract (legacy) → multi-stage Zyte/grounding fallback
  //     for paywalled sites. Still used by Finance/AI News.
  //   • Otherwise → trust the RSS body verbatim.
  const useCleanExtract = feed.extraction_strategy === 'clean' && item.link;

  if (useCleanExtract) {
    const _ce0 = Date.now();
    const _logTag = `NEWS/${feed.id}`;
    try {
      const extracted = await cleanExtract(item.link, { logTag: _logTag });
      // Prefer the live-page extraction ONLY when it actually has MORE
      // visible text than the rich RSS body we already hold. This stops a
      // thin page (Substack cover-image + paywall teaser) from clobbering a
      // full `content:encoded` body, while still upgrading feeds whose RSS
      // ships only a teaser (Lensmen, TechCrunch, Towards Data Science).
      const extractedText = visibleTextLen(extracted.content || '');
      if (extracted.content && extractedText >= 200 && extractedText >= visibleTextLen(contentText)) {
        const rssLen = contentText.length;
        contentText = extracted.content;
        if (extracted.title) extractedTitle = extracted.title;
        // Late-discovered publication date — used by feeds whose RSS
        // doesn't carry pubDate (Lensmen) and as a sanity check for the
        // rest. We never DOWNGRADE to RSS if the page disagrees because
        // structured page-level dates are higher signal than RSS feeds
        // that lie about pubDate (looking at you, Lensmen).
        if (extracted.date instanceof Date && !isNaN(extracted.date.getTime())) {
          pubDate = extracted.date;
        }
        tg.i(
          _logTag,
          `Clean extract ✓ ${Date.now() - _ce0}ms method=${extracted.extractionMethod} ${contentText.length}ch (RSS had ${rssLen}ch) date=${pubDate.toISOString().slice(0, 10)} "${title.slice(0, 50)}"`,
        );
      } else {
        tg.w(
          _logTag,
          `Clean extract empty ${Date.now() - _ce0}ms (${extracted.extractionMethod || 'unknown'}) — falling back to RSS for "${title.slice(0, 40)}"`,
        );
      }

      // Structured review meta (Gizbot gadgets, Only Kollywood, TOI films).
      // Runs even when the main-content fetch was short, because rating
      // widgets often live outside the article body selector.
      const wantReviewMeta = feed.extract_review_meta === true || feed.id === 'gizbot_reviews';
      if (wantReviewMeta) {
        const htmlForMeta = extracted.rawHtml || item.html || '';
        if (htmlForMeta) {
          try {
            const meta = extractGizbotProsConsRating(htmlForMeta);
            if (meta && (meta.rating || meta.pros.length || meta.cons.length)) {
              reviewMeta = meta;
              tg.d(
                _logTag,
                `Review meta: rating="${meta.rating || '-'}" pros=${meta.pros.length} cons=${meta.cons.length}`,
              );
            }
          } catch (rmErr) {
            tg.w(_logTag, `Review meta extraction failed: ${rmErr.message?.slice(0, 80)}`);
          }
        }
      }
    } catch (ceErr) {
      tg.w(
        `NEWS/${feed.id}`,
        `Clean extract FAILED ${Date.now() - _ce0}ms "${title.slice(0, 40)}": ${ceErr.message?.slice(0, 80)} — using RSS content`,
      );
    }
  } else if (feed.deep_extract && typeof deepExtractFn === 'function' && item.link) {
    const _dt0 = Date.now();
    const _logTag = `NEWS/${feed.id}`;
    try {
      const extracted = await deepExtractFn(item.link, { logTag: _logTag });
      if (extracted.content && extracted.content.length > contentText.length && extracted.content.length >= 200) {
        const rssLen = contentText.length;
        contentText = extracted.content;
        tg.i(_logTag, `Deep extract ✓ ${Date.now() - _dt0}ms method=${extracted.extractionMethod} paywall=${extracted.paywallSource} ${contentText.length}ch (RSS had ${rssLen}ch) "${title.slice(0, 50)}"`);
      } else {
        tg.d(_logTag, `Deep extract returned ${extracted.content?.length || 0}ch ≤ RSS ${contentText.length}ch — using RSS "${title.slice(0, 40)}"`);
      }
    } catch (deepErr) {
      tg.w(_logTag, `Deep extract FAILED ${Date.now() - _dt0}ms "${title.slice(0, 40)}": ${deepErr.message?.slice(0, 80)} — using RSS content`);
    }
  }

  if (!reviewMeta && (feed.extract_review_meta === true || feed.id === 'gizbot_reviews') && item.html) {
    try {
      const meta = extractGizbotProsConsRating(item.html);
      if (meta && (meta.rating || meta.pros.length || meta.cons.length)) {
        reviewMeta = meta;
      }
    } catch {
      // RSS fragment parse is best-effort.
    }
  }

  // ── Late date filter ──────────────────────────────────────────────────
  // For feeds whose RSS lacks pubDate (Lensmen) or that bypass the RSS
  // today-filter entirely (listing-source feeds like Gizbot), we evaluate
  // the freshness cutoff HERE — after extraction has resolved a real
  // publication date. `feed.max_age_days` lets a feed opt into a wider
  // window than today-only (Lensmen + Gizbot publish < 1 article/day).
  const maxAgeDays = Math.max(0, Number(feed.max_age_days || 0));
  if (maxAgeDays > 0) {
    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
    if (pubDate < cutoff) {
      tg.d(
        `NEWS/${feed.id}`,
        `Skip stale article (${pubDate.toISOString().slice(0, 10)} < ${cutoff.toISOString().slice(0, 10)}, max_age=${maxAgeDays}d) "${title.slice(0, 50)}"`,
      );
      return false;
    }
  } else if (!hadRssPubDate && feed.source_type !== 'listing') {
    // Strict default: any feed that didn't ship pubDate AND didn't opt
    // into max_age_days falls back to "must be today".
    if (!isPublishedToday(pubDate)) {
      tg.d(`NEWS/${feed.id}`, `Skip non-today article (date=${pubDate.toISOString().slice(0, 10)}) "${title.slice(0, 40)}"`);
      return false;
    }
  }

  // Use the extracted page title if RSS / listing title was thin.
  const finalTitle = (title === 'Untitled' || title.length < 8) && extractedTitle ? extractedTitle : title;

  const t0 = Date.now();
  const skipSummary = feed.skip_summary === true;
  console.log(
    `[NEWS] Processing: "${finalTitle.slice(0, 60)}" from ${source} ` +
    `(${skipSummary ? 'full-content' : feed.prompt_key || 'summary_prompt'}) ` +
    `content=${contentText.length}ch${feed.deep_extract ? ' [deep]' : ''}${useCleanExtract ? ' [clean]' : ''}` +
    `${skipSummary ? ' [skip-summary]' : ''}${reviewMeta ? ' [review-meta]' : ''}`,
  );

  let summary;
  let summaryErrorReason = null;

  if (skipSummary) {
    // Full-content feeds (Movies / General): never call the LLM. We just
    // format the deep-extracted plain text into clean Markdown so the
    // existing detail-view renderer can display it as-if it were an AI
    // summary. The follow-up chat still uses the LLM — that path is
    // unaffected because it's a separate endpoint.
    try {
      summary = buildFullContentMarkdown({
        content: contentText,
        url: item.link,
        source,
      });
      // Gizbot-only: prepend a structured Rating / Pros / Cons header
      // block ABOVE the full body. Keeping it in the same summaryMarkdown
      // means the Flutter detail view renders it through the same
      // MarkdownBody pipeline — no schema changes required.
      if (reviewMeta) {
        const metaMd = buildReviewMetaMarkdown(reviewMeta);
        if (metaMd) {
          summary = `${metaMd}\n\n${summary}`;
        }
      }
      tg.i(
        'NEWS/full-content',
        `✓ ${feed.id} ${Date.now() - t0}ms ${contentText.length}ch → ${summary.length}ch md "${finalTitle.slice(0, 50)}"`,
      );
    } catch (e) {
      summaryErrorReason = _shortErrorReason(e);
      tg.e('NEWS/full-content', `Format FAILED ${feed.id} "${finalTitle.slice(0, 40)}"`, e);
      summary = fallbackSummary(finalTitle, contentText, item.link, source, summaryErrorReason);
    }
  } else {
    summary = await summaryLimiter(async () => {
      try {
        const gen = await generateSummary({
          title: finalTitle,
          content: contentText,
          imageUrl: item.image,
          promptKey: feed.prompt_key,
          settings,
          config,
          completeFn,
          fallbackCompleteFn,
          liteModel,
          xgrokLiteModel,
        });
        if (settings.api_delay_seconds > 0) await sleep(settings.api_delay_seconds * 1000);
        return gen;
      } catch (e) {
        summaryErrorReason = _shortErrorReason(e);
        return null;
      }
    });

    if (!summary) {
      summary = fallbackSummary(finalTitle, contentText, item.link, source, summaryErrorReason);
    } else {
      summary = cleanSummaryArtifacts(summary);
      summary = appendSourceLink(summary, item.link, source);
    }
  }

  const { v4: uuidv4 } = require('uuid');
  const id = `news-${uuidv4()}`;
  const now = new Date().toISOString();

  // When the LLM call failed we don't want the news list to show
  // "Summary couldn't be generated for this article…" as the preview
  // — that's only useful inside the detail view (where the banner
  // explains the failure). For the list excerpt, fall through to a
  // stripped chunk of the original RSS content so the user can still
  // judge whether to open the article.
  const excerptSummary = isFallbackSummary(summary) ? '' : summary;

  await pool.query(
    `INSERT INTO news_articles (
      id, title, category, tag, read_time, time_ago, date, image, excerpt, source,
      is_featured, content_json, saved, read, guid, original_url, summary_markdown,
      published_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20
    )`,
    [
      id, finalTitle, feed.app_category || 'Technology', feed.category || null,
      readTime(summary), fmtTimeAgo(pubDate), fmtDate(pubDate), item.image || '',
      buildExcerpt(excerptSummary, contentText), source,
      false, JSON.stringify({ sourceId: feed.id, originalUrl: item.link || '', publishedAt: pubDate.toISOString(), isFullContent: skipSummary }),
      false, false, item.guid, item.link || '', summary,
      pubDate.toISOString(), now, now,
    ],
  );

  return true;
}

async function processFeed({ pool, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn, liteModel, xgrokLiteModel }) {
  const feedT0 = Date.now();
  try {
    // Listing-source feeds (e.g. Gizbot reviews — no RSS) take a separate
    // ingestion path that scrapes a category page for article URLs. The
    // rest of the pipeline (dedup → fetch → clean extract → store) is
    // identical to RSS once we have a list of items.
    let allItems;
    if (feed.source_type === 'listing') {
      allItems = await _fetchListingItems(feed);
    } else {
      allItems = await _fetchRssItems(feed);
    }

    allItems = filterItemsByLinkPattern(
      allItems,
      feed.listing_link_pattern || feed.item_link_pattern,
    );
    allItems = dedupeFeedItems(allItems, {
      byTitle: feed.app_category === 'Movies',
    });

    // Date filter strategy:
    //   • Strict "today only" for the legacy RSS feeds we trust pubDate on
    //   • Defer to processItem for feeds with `max_age_days` (Lensmen/Gizbot
    //     don't ship a usable RSS date; we extract from the page itself)
    //   • Defer for listing-source feeds (no RSS pubDate at all)
    const deferDateFilter =
      feed.source_type === 'listing' ||
      (typeof feed.max_age_days === 'number' && feed.max_age_days > 0);

    let items;
    if (deferDateFilter) {
      items = allItems.slice(0, settings.max_articles_per_feed);
    } else {
      // Sort newest-first so both the today-filter and the past-article
      // backfill below pick the freshest entries.
      const sorted = [...allItems].sort(
        (a, b) => parseDate(b.pubRaw) - parseDate(a.pubRaw),
      );
      const todayItems = sorted.filter((item) => isPublishedToday(parseDate(item.pubRaw)));

      if (todayItems.length > 0) {
        items = todayItems.slice(0, settings.max_articles_per_feed);
      } else if (sorted.length > 0) {
        // Nothing fresh today — backfill the most-recent past article(s) so
        // the feed is never empty (low-cadence sources, weekends, holidays).
        // `processItem` dedups by guid, so already-stored pieces are skipped
        // and this only fills genuine gaps rather than re-adding old news.
        items = sorted.slice(0, Math.min(settings.max_articles_per_feed, 2));
        console.log(
          `[NEWS] ${feed.id}: no items from today (${todayIST()}) — backfilling ${items.length} most-recent past article(s)`,
        );
        tg.d('NEWS/feed', `${feed.id}: no today items — backfilling ${items.length} recent past article(s)`);
      } else {
        items = [];
      }
    }

    const results = await Promise.all(
      items.map((item) =>
        processItem({ pool, item, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn, liteModel, xgrokLiteModel }).catch((e) => {
          console.error(`[NEWS] Item failed (${feed.id}):`, e.message?.slice(0, 120));
          tg.w('NEWS/item', `Item fail feed=${feed.id} "${item?.title?.slice(0, 40) || '?'}"`, e);
          return false;
        }),
      ),
    );
    const processed = results.filter(Boolean).length;
    if (processed > 0) {
      tg.d('NEWS/feed', `${feed.id}: ${processed}/${items.length} new (${Date.now() - feedT0}ms)`);
    }
    return processed;
  } catch (e) {
    const elapsed = Date.now() - feedT0;
    console.error(`[NEWS] Feed failed (${feed.id}, ${elapsed}ms):`, e.message?.slice(0, 120));
    tg.e('NEWS/feed', `Feed failed: ${feed.id} (${elapsed}ms)`, e);
    return 0;
  }
}

// ─── Per-source-type loaders ───────────────────────────────────────────

async function _fetchRssXmlViaCurl(url, timeoutMs) {
  const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileP('curl', [
    '-sSL',
    '--compressed',
    '--max-time', String(seconds),
    '-A', RSS_UA,
    '-H', 'Accept: application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    url,
  ], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs + 2000,
  });
  const xml = stdout || '';
  if (!xml) throw new Error('curl returned empty RSS body');
  return xml;
}

async function _fetchRssXml(feed) {
  const headers = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'User-Agent': RSS_UA,
    'Accept-Encoding': 'gzip, deflate',
  };
  let lastErr;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(feed.url, {
        headers,
        signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
      const xml = await res.text();
      if (!xml || xml.length < 20) throw new Error('Feed empty body');
      return xml;
    } catch (fetchErr) {
      lastErr = fetchErr;
      if (attempt === 0) {
        console.warn(`[NEWS] Feed ${feed.id} fetch failed (attempt 1/2), retrying`);
        await sleep(1500);
      }
    }
  }
  try {
    tg.d('NEWS/feed', `${feed.id}: native fetch failed — trying curl fallback`);
    return await _fetchRssXmlViaCurl(feed.url, RSS_FETCH_TIMEOUT_MS);
  } catch (curlErr) {
    throw lastErr || curlErr;
  }
}

async function _fetchRssItems(feed) {
  const xml = await _fetchRssXml(feed);
  const items = parseFeedItems(xml);
  if (items.length === 0) {
    const head = String(xml).slice(0, 120).replace(/\s+/g, ' ');
    tg.w('NEWS/feed', `${feed.id}: RSS parsed 0 items (${xml.length}ch) head="${head}"`);
  } else {
    tg.d('NEWS/feed', `${feed.id}: RSS ${items.length} item(s) ${xml.length}ch`);
  }
  return items;
}

/**
 * Listing-page loader for sites without an RSS feed (Gizbot reviews).
 *
 * Pulls the category index page, extracts article links matching the
 * configured pattern, then synthesises feed-item shapes so the rest of
 * the pipeline (dedup → processItem → clean-extract → store) treats
 * them identically to RSS items.
 *
 * The publication date is intentionally left blank — `processItem` will
 * derive it from the article page during clean extraction. The dedup
 * GUID is a stable SHA1 over the canonical article URL, so re-running
 * the scraper any number of times never produces duplicates.
 */
async function _fetchListingItems(feed) {
  const t0 = Date.now();
  const logTag = `NEWS/${feed.id}`;
  let html;
  try {
    html = await fetchHtml(feed.url, { timeoutMs: 20_000, retries: 2, logTag });
  } catch (e) {
    tg.e(logTag, `Listing fetch failed: ${e.message?.slice(0, 120)}`, e);
    throw e;
  }

  const rawItems = scrapeListingPage(html, {
    baseUrl: feed.url,
    linkPattern: feed.listing_link_pattern || '.*',
    max: Math.max(20, (feed.max_listing_links || 20)),
  });

  const items = rawItems.map((raw) => {
    const link = canonicalArticleUrl(raw.link) || raw.link;
    return {
      title: raw.title || 'Untitled',
      link: raw.link,
      guid: stableGuid(link, raw.link, raw.title),
      pubRaw: '', // resolved during clean extraction
      html: '',
      text: '',
      image: raw.image || '',
    };
  });

  tg.d(logTag, `Listing scrape ✓ ${Date.now() - t0}ms ${items.length} link(s) found`);
  return items;
}

async function syncNewsFeeds(pool, { reason = 'manual', getProviderFn, getLiteModelFn, getXGrokLiteModelFn, deepExtractFn, ensureTablesFn } = {}) {
  if (activeSyncPromise) {
    tg.d('NEWS/sync', `Sync already in progress — deduplicating (reason=${reason})`);
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const syncT0 = Date.now();
    tg.d('NEWS/sync', `▶ Starting sync (reason=${reason})`);

    // Pre-check: ensure critical tables exist before querying
    if (typeof ensureTablesFn === 'function') {
      try { await ensureTablesFn(); } catch (e) {
        console.error('[NEWS] Table pre-check failed:', e.message);
      }
    }

    // Resolve the user's configured lite/xgrok-lite models ONCE per cycle.
    // This drives the model used for every article summary in this sync,
    // matching what the Settings page on every device will report.
    let liteModel = null;
    let xgrokLiteModel = null;
    if (typeof getLiteModelFn === 'function') {
      try {
        liteModel = await getLiteModelFn();
      } catch (e) {
        tg.w('NEWS/sync', 'getLiteModelFn failed — falling back to LiteLLM priority', e);
      }
    }
    if (typeof getXGrokLiteModelFn === 'function') {
      try {
        xgrokLiteModel = await getXGrokLiteModelFn();
      } catch (e) {
        tg.w('NEWS/sync', 'getXGrokLiteModelFn failed — falling back to env default', e);
      }
    }
    tg.d('NEWS/sync', `Models resolved: lite=${liteModel || '(priority-list)'} xgrokLite=${xgrokLiteModel || '(env-default)'}`);

    // Resolve the LLM provider once per sync cycle (not per article).
    let completeFn = null;
    let fallbackCompleteFn = null;
    let providerName = 'litellm';

    if (typeof getProviderFn === 'function') {
      try {
        const provider = await getProviderFn();
        if (provider && typeof provider.complete === 'function') {
          completeFn = provider.complete;
          providerName = provider.name || 'external';
          // When using an external provider, litellm is the automatic fallback.
          // The fallback also uses the user's settings.liteModel.
          fallbackCompleteFn = (msgs, opts) => callLiteLLM(liteModel || preferredModel(), msgs, opts);
          console.log(`[NEWS] Using LLM provider: ${providerName} (with litellm fallback)`);
          tg.i('NEWS/sync', `Provider resolved: ${providerName} (litellm fallback ready, liteModel=${liteModel || '(priority)'}) for reason=${reason}`);
        }
      } catch (e) {
        console.warn(`[NEWS] getProviderFn failed, falling back to LiteLLM:`, e.message?.slice(0, 100));
        tg.w('NEWS/sync', 'Provider resolution failed — using LiteLLM fallback', e);
      }
    }

    const config = loadConfig();
    const settings = getSettings(config);
    const feeds = enabledFeeds(config).slice().sort((a, b) => feedPriority(a) - feedPriority(b));
    if (feeds.length === 0) {
      tg.e('NEWS/sync', `No RSS feeds loaded from ${CONFIG_PATH} — X-feed will still work, everything else will be empty`);
    }
    const feedLimiter = createLimiter(settings.max_concurrent_feeds);
    const summaryLimiter = createLimiter(settings.max_concurrent_summaries);
    const counts = {};
    let total = 0;

    await Promise.all(
      feeds.map((feed) =>
        feedLimiter(async () => {
          let timer;
          const budget = new Promise((resolve) => {
            timer = setTimeout(() => {
              tg.w('NEWS/feed', `${feed.id}: exceeded ${FEED_BUDGET_MS}ms budget — not blocking the rest of the sync`);
              resolve(0);
            }, FEED_BUDGET_MS);
          });
          try {
            const n = await Promise.race([
              processFeed({ pool, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn, liteModel, xgrokLiteModel }),
              budget,
            ]);
            counts[feed.id] = n;
            total += n;
          } finally {
            clearTimeout(timer);
          }
        }),
      ),
    );

    // Cleanup — keep ONLY saved + still-unread articles.
    //
    //   • read + unsaved  → consumed; delete regardless of age. (New flow
    //     already deletes these at the read/clear endpoints; this is the
    //     backstop AND the one-time sweep that clears the legacy clog of
    //     read rows that older builds left behind.)
    //   • unread + unsaved older than the retention window → age out, using
    //     created_at as a fallback when published_at is NULL so undated rows
    //     can't linger forever.
    //   • saved → never purged.
    //
    // Tombstone the guids of consumed (read, unsaved) rows first so the feed
    // sync can't re-import something the user already cleared.
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (settings.article_retention_days || 30));
    await pool.query(
      `INSERT INTO deleted_guids (guid)
       SELECT guid FROM news_articles
       WHERE saved = FALSE AND read = TRUE AND guid IS NOT NULL
       ON CONFLICT (guid) DO NOTHING`,
    );
    const { rowCount: purged } = await pool.query(
      `DELETE FROM news_articles
       WHERE saved = FALSE
         AND (
           read = TRUE
           OR (published_at IS NOT NULL AND published_at < $1)
           OR (published_at IS NULL AND created_at < $1)
         )`,
      [cutoffDate.toISOString()],
    );

    // mark latest unread article as featured
    await pool.query('UPDATE news_articles SET is_featured = FALSE WHERE is_featured = TRUE');
    await pool.query(
      `UPDATE news_articles SET is_featured = TRUE
       WHERE id = (
         SELECT id FROM news_articles WHERE read = FALSE
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1
       )`,
    );

    const syncElapsed = Date.now() - syncT0;
    lastSyncAt = new Date().toISOString();
    lastSyncError = null;
    lastSyncResult = {
      success: true,
      reason,
      syncedAt: lastSyncAt,
      totalNew: total,
      feeds: counts,
      provider: providerName,
      elapsedMs: syncElapsed,
      purged,
    };
    console.log(`[NEWS] Sync done (${reason}): ${total} new, ${purged} purged, provider=${providerName}, ${syncElapsed}ms [IST: ${todayIST()}]`);
    tg.i('NEWS/sync', `✓ ${reason}: ${total} new, ${purged} purged, provider=${providerName}, ${syncElapsed}ms across ${feeds.length} feeds`);
    return lastSyncResult;
  })().catch((e) => {
    lastSyncError = e.message;
    console.error(`[NEWS] Sync FAILED (${reason}):`, e.message?.slice(0, 200));
    tg.e('NEWS/sync', `Sync FAILED (${reason}): ${e.message?.slice(0, 150)}`, e);
    throw e;
  });

  try {
    return await activeSyncPromise;
  } finally {
    activeSyncPromise = null;
  }
}

function getSyncState() {
  let feedsConfigured = 0;
  try { feedsConfigured = enabledFeeds(loadConfig()).length; } catch { /* ignore */ }
  return {
    lastSyncAt,
    lastSyncResult,
    lastSyncError,
    inProgress: activeSyncPromise != null,
    feedsConfigured,
    configPath: CONFIG_PATH,
  };
}

function startScheduler(pool, { getProviderFn, getLiteModelFn, getXGrokLiteModelFn, deepExtractFn, ensureTablesFn } = {}) {
  if (schedulerHandle) return;
  const config = loadConfig();
  const settings = getSettings(config);
  const feedCount = enabledFeeds(config).length;
  const intervalMinutes = Math.max(5, settings.refresh_interval_minutes);
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[NEWS] Scheduler starting: feeds=${feedCount} config=${CONFIG_PATH} interval=${intervalMinutes}min, concurrent_feeds=${settings.max_concurrent_feeds}, concurrent_summaries=${settings.max_concurrent_summaries}`);
  if (feedCount === 0) {
    tg.e('NEWS/scheduler', `Starting with 0 RSS feeds (config=${CONFIG_PATH}) — only X-feed articles will appear`);
  } else {
    tg.i('NEWS/scheduler', `Starting: ${feedCount} feeds from ${CONFIG_PATH}, interval=${intervalMinutes}min, feeds_concurrency=${settings.max_concurrent_feeds}, summary_concurrency=${settings.max_concurrent_summaries}`);
  }

  syncNewsFeeds(pool, { reason: 'startup', getProviderFn, getLiteModelFn, getXGrokLiteModelFn, deepExtractFn, ensureTablesFn }).catch((e) => {
    console.error('[NEWS] Initial sync failed:', e.message?.slice(0, 120));
    tg.e('NEWS/scheduler', 'Initial startup sync failed', e);
  });

  let consecutiveFailures = 0;
  schedulerHandle = setInterval(async () => {
    try {
      await syncNewsFeeds(pool, { reason: 'scheduled', getProviderFn, getLiteModelFn, getXGrokLiteModelFn, deepExtractFn, ensureTablesFn });
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      console.error(`[NEWS] Scheduled sync failed (${consecutiveFailures} consecutive):`, e.message?.slice(0, 120));
      if (consecutiveFailures >= 3) {
        tg.e('NEWS/scheduler', `${consecutiveFailures} consecutive scheduler failures — investigate`, e);
      }
    }
  }, intervalMs);
}

module.exports = {
  syncNewsFeeds,
  getSyncState,
  startScheduler,
  isFallbackSummary,
  SUMMARY_UNAVAILABLE_MARKER,
  // Exposed for unit tests — the full-content (skip_summary) pipeline.
  // Pure functions; safe to import without bootstrapping the scheduler.
  splitParagraphs,
  looksLikeHeading,
  buildFullContentMarkdown,
  buildFullContentExcerpt,
  appendSourceLink,
  looksPreformatted,
  collapseBlanksPreservingCode,
  parseFeedItems,
  resolveConfigPath,
  filterItemsByLinkPattern,
  dedupeFeedItems,
  movieTitleKey,
  canonicalArticleUrl,
};
