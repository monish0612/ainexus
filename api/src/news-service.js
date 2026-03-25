const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = fs.existsSync(path.resolve(__dirname, '../../news_rss_feeds.json'))
  ? path.resolve(__dirname, '../../news_rss_feeds.json')
  : path.resolve(__dirname, '../news_rss_feeds.json');

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
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[NEWS] Failed to load RSS config:', err.message);
    return { feeds: [], settings: DEFAULT_SETTINGS, summary_prompt: {} };
  }
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
    if (m?.[1]) return absolutize(m[1].trim(), link);
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
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
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
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1'),
  );
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
    : url.includes('kdnuggets') ? '💎' : url.includes('the-ken') ? '🔍' : '🔗';

  return `${summary.trim()}\n\n---\n\n## ${srcIcon} Read Original Article\n\n> **Want to dive deeper?** Access the full article with original charts, images, and detailed analysis.\n\n**[📖 Read Full Article on ${srcName} →](${url})**\n`.trim();
}

function fallbackSummary(title, content, url, source) {
  const excerpt = normalizeWhitespace(content || '').slice(0, 650).trim();
  const base = `# ${title}\n\n## Article Preview\n\n${excerpt || 'Summary generation was unavailable for this article.'}\n`;
  return appendSourceLink(base, url, source);
}

let _modelPriorityCache = null;

function getModelPriority() {
  if (_modelPriorityCache) return _modelPriorityCache;
  const raw = process.env._LITELLM_MODEL_PRIORITY;
  if (raw) {
    try { _modelPriorityCache = JSON.parse(raw); return _modelPriorityCache; } catch {}
  }
  return null;
}

async function _callLiteLLMOnce(model, messages, opts) {
  const baseUrl = (process.env.LITELLM_URL || 'http://72.60.219.97:4000').replace(/\/$/, '');
  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key.trim()}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, ...opts }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`LiteLLM non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data?.error?.message || `LiteLLM ${res.status} [${model}]: ${text.slice(0, 300)}`);
  return data?.choices?.[0]?.message?.content || '';
}

async function callLiteLLM(model, messages, opts = {}) {
  const priority = getModelPriority();
  const modelsToTry = model
    ? [model]
    : priority && priority.length > 0
      ? [...priority]
      : ['gemini/gemini-2.0-flash'];

  let lastError;
  for (const m of modelsToTry) {
    try {
      return await _callLiteLLMOnce(m, messages, opts);
    } catch (e) {
      lastError = e;
      if (modelsToTry.length > 1) {
        console.warn(`[NEWS-LLM] ${m} failed, trying fallback... (${e.message.slice(0, 100)})`);
      }
    }
  }
  throw lastError;
}

function preferredModel() {
  const priority = getModelPriority();
  return priority?.[0] || null;
}

function fillTemplate(tpl, title, content) {
  return String(tpl || '').replaceAll('{title}', title).replaceAll('{content}', content);
}

async function generateSummary({ title, content, imageUrl, promptKey, settings, config }) {
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

  const tryGen = async (useImg) => {
    const msgs = [{ role: 'system', content: sys }];
    if (useImg && settings.enable_image_analysis && imageUrl) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageUrl } }] });
    } else {
      msgs.push({ role: 'user', content: user });
    }
    return (await callLiteLLM(preferredModel(), msgs, { temperature: 0.35, max_tokens: maxTok })).trim();
  };

  if (settings.enable_image_analysis && imageUrl) {
    try {
      const s = await tryGen(true);
      if (s && s.length >= 50) return s;
    } catch (e) {
      console.warn(`[NEWS] Image summary retry for "${title}":`, e.message);
    }
  }

  try {
    const s = await tryGen(false);
    return s && s.length >= 50 ? s : null;
  } catch (e) {
    console.error(`[NEWS] Summary failed for "${title}":`, e.message);
    return null;
  }
}

async function processItem({ pool, item, feed, config, settings, summaryLimiter }) {
  const existing = await pool.query('SELECT id FROM news_articles WHERE guid = $1', [item.guid]);
  if (existing.rows.length > 0) return false;

  const deleted = await pool.query('SELECT guid FROM deleted_guids WHERE guid = $1', [item.guid]);
  if (deleted.rows.length > 0) return false;

  const title = item.title || 'Untitled';
  const pubDate = parseDate(item.pubRaw);
  const source = feed.name || feed.id;
  const contentText = item.text || cleanHtml(item.html || '');

  console.log(`[NEWS] Processing: "${title.slice(0, 60)}" from ${source} (${feed.prompt_key || 'summary_prompt'})`);

  let summary = await summaryLimiter(async () => {
    const gen = await generateSummary({
      title,
      content: contentText,
      imageUrl: item.image,
      promptKey: feed.prompt_key,
      settings,
      config,
    });
    if (settings.api_delay_seconds > 0) await sleep(settings.api_delay_seconds * 1000);
    return gen;
  });

  if (!summary) {
    summary = fallbackSummary(title, contentText, item.link, source);
  } else {
    summary = appendSourceLink(summary, item.link, source);
  }

  const { v4: uuidv4 } = require('uuid');
  const id = `news-${uuidv4()}`;
  const now = new Date().toISOString();

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
      id, title, feed.app_category || 'Technology', feed.category || null,
      readTime(summary), fmtTimeAgo(pubDate), fmtDate(pubDate), item.image || '',
      buildExcerpt(summary, contentText), source,
      false, JSON.stringify({ sourceId: feed.id, originalUrl: item.link || '', publishedAt: pubDate.toISOString() }),
      false, false, item.guid, item.link || '', summary,
      pubDate.toISOString(), now, now,
    ],
  );

  return true;
}

async function processFeed({ pool, feed, config, settings, summaryLimiter }) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let xml;
    try {
      const res = await fetch(feed.url, {
        signal: controller.signal,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'User-Agent': 'Nexus-AI-News/1.0' },
      });
      if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
      xml = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const allItems = parseFeedItems(xml);
    const todayItems = allItems.filter((item) => {
      const pubDate = parseDate(item.pubRaw);
      return isPublishedToday(pubDate);
    });
    const items = todayItems.slice(0, settings.max_articles_per_feed);

    if (allItems.length > 0 && items.length === 0) {
      console.log(`[NEWS] ${feed.id}: ${allItems.length} items found but none from today (${todayIST()})`);
    }

    const results = await Promise.all(
      items.map((item) =>
        processItem({ pool, item, feed, config, settings, summaryLimiter }).catch((e) => {
          console.error(`[NEWS] Item failed (${feed.id}):`, e.message);
          return false;
        }),
      ),
    );
    return results.filter(Boolean).length;
  } catch (e) {
    console.error(`[NEWS] Feed failed (${feed.id}):`, e.message);
    return 0;
  }
}

async function syncNewsFeeds(pool, { reason = 'manual' } = {}) {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = (async () => {
    const config = loadConfig();
    const settings = getSettings(config);
    const feeds = (config.feeds || []).filter((f) => f.enabled !== false);
    const feedLimiter = createLimiter(settings.max_concurrent_feeds);
    const summaryLimiter = createLimiter(settings.max_concurrent_summaries);
    const counts = {};
    let total = 0;

    await Promise.all(
      feeds.map((feed) =>
        feedLimiter(async () => {
          const n = await processFeed({ pool, feed, config, settings, summaryLimiter });
          counts[feed.id] = n;
          total += n;
        }),
      ),
    );

    // cleanup old articles — keep saved and read articles
    await pool.query(
      `DELETE FROM news_articles
       WHERE published_at < NOW() - INTERVAL '${settings.article_retention_days} days'
         AND saved = FALSE AND read = FALSE`,
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

    lastSyncAt = new Date().toISOString();
    lastSyncError = null;
    lastSyncResult = { success: true, reason, syncedAt: lastSyncAt, totalNew: total, feeds: counts };
    console.log(`[NEWS] Sync done (${reason}): ${total} new articles [IST date: ${todayIST()}]`);
    return lastSyncResult;
  })().catch((e) => {
    lastSyncError = e.message;
    throw e;
  });

  try {
    return await activeSyncPromise;
  } finally {
    activeSyncPromise = null;
  }
}

function getSyncState() {
  return { lastSyncAt, lastSyncResult, lastSyncError, inProgress: activeSyncPromise != null };
}

function startScheduler(pool) {
  if (schedulerHandle) return;
  const settings = getSettings(loadConfig());
  const interval = Math.max(5, settings.refresh_interval_minutes) * 60 * 1000;

  syncNewsFeeds(pool, { reason: 'startup' }).catch((e) => console.error('[NEWS] Initial sync failed:', e.message));

  schedulerHandle = setInterval(() => {
    syncNewsFeeds(pool, { reason: 'scheduled' }).catch((e) => console.error('[NEWS] Scheduled sync failed:', e.message));
  }, interval);
}

module.exports = { syncNewsFeeds, getSyncState, startScheduler };
