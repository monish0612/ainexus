const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { tg } = require('./telegram');

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
    : url.includes('venturebeat') ? '⚡' : '🔗';

  return `${summary.trim()}\n\n---\n\n## ${srcIcon} Read Original Article\n\n> **Want to dive deeper?** Access the full article with original charts, images, and detailed analysis.\n\n**[📖 Read Full Article on ${srcName} →](${url})**\n`.trim();
}

function fallbackSummary(title, content, url, source) {
  const excerpt = normalizeWhitespace(content || '').slice(0, 650).trim();
  const base = `# ${title}\n\n## Article Preview\n\n${excerpt || 'Summary generation was unavailable for this article.'}\n`;
  return appendSourceLink(base, url, source);
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
  const modelsToTry = model
    ? [model]
    : priority && priority.length > 0
      ? [...priority]
      : [];

  if (modelsToTry.length === 0) {
    tg.e('NEWS-LLM', 'No models available — _LITELLM_MODEL_PRIORITY empty');
    throw new Error('No LiteLLM models available — _LITELLM_MODEL_PRIORITY is empty');
  }

  tg.d('NEWS-LLM', `Calling models=[${modelsToTry.join(',')}]`);

  let lastError;
  for (let i = 0; i < modelsToTry.length; i++) {
    const m = modelsToTry[i];
    const maxRetries = i === modelsToTry.length - 1 ? 3 : 2;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          tg.w('NEWS-LLM', `Retry ${attempt + 1}/${maxRetries} model=${m}`);
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
        const result = await _callLiteLLMOnce(m, messages, opts);
        tg.i('NEWS-LLM', `✓ model=${m} ${Date.now() - t0}ms`);
        return result;
      } catch (e) {
        lastError = e;
        if (!_isRetryable(e.message) || attempt >= maxRetries - 1) {
          if (modelsToTry.length > 1) {
            console.warn(`[NEWS-LLM] ${m} exhausted (${attempt + 1} attempts): ${e.message.slice(0, 100)}`);
            tg.w('NEWS-LLM', `${m} exhausted after ${attempt + 1} attempts`, e);
          }
          break;
        }
      }
    }
  }
  console.error(`[NEWS-LLM] All models exhausted: ${modelsToTry.join(', ')}`);
  tg.e('NEWS-LLM', `All models exhausted: ${modelsToTry.join(', ')} ${Date.now() - t0}ms`, lastError);
  throw lastError;
}

function preferredModel() {
  const priority = _getModelPriority();
  return priority?.[0] || null;
}

function fillTemplate(tpl, title, content) {
  return String(tpl || '').replaceAll('{title}', title).replaceAll('{content}', content);
}

async function generateSummary({ title, content, imageUrl, promptKey, settings, config, completeFn, fallbackCompleteFn }) {
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

  const _litellmComplete = (msgs, opts) => callLiteLLM(preferredModel(), msgs, opts);
  const _primaryComplete = completeFn || _litellmComplete;
  const _fallbackComplete = fallbackCompleteFn || (completeFn ? _litellmComplete : null);

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

async function processItem({ pool, item, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn }) {
  const existing = await pool.query('SELECT id FROM news_articles WHERE guid = $1', [item.guid]);
  if (existing.rows.length > 0) return false;

  const deleted = await pool.query('SELECT guid FROM deleted_guids WHERE guid = $1', [item.guid]);
  if (deleted.rows.length > 0) return false;

  const title = item.title || 'Untitled';
  const pubDate = parseDate(item.pubRaw);
  const source = feed.name || feed.id;
  let contentText = item.text || cleanHtml(item.html || '');

  // Deep extraction for paywalled / subscription-only feeds
  if (feed.deep_extract && typeof deepExtractFn === 'function' && item.link) {
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

  const t0 = Date.now();
  console.log(`[NEWS] Processing: "${title.slice(0, 60)}" from ${source} (${feed.prompt_key || 'summary_prompt'}) content=${contentText.length}ch${feed.deep_extract ? ' [deep]' : ''}`);

  let summary = await summaryLimiter(async () => {
    const gen = await generateSummary({
      title,
      content: contentText,
      imageUrl: item.image,
      promptKey: feed.prompt_key,
      settings,
      config,
      completeFn,
      fallbackCompleteFn,
    });
    if (settings.api_delay_seconds > 0) await sleep(settings.api_delay_seconds * 1000);
    return gen;
  });

  if (!summary) {
    summary = fallbackSummary(title, contentText, item.link, source);
  } else {
    summary = cleanSummaryArtifacts(summary);
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

async function processFeed({ pool, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn }) {
  const feedT0 = Date.now();
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
        processItem({ pool, item, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn }).catch((e) => {
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

async function syncNewsFeeds(pool, { reason = 'manual', getProviderFn, deepExtractFn } = {}) {
  if (activeSyncPromise) {
    tg.d('NEWS/sync', `Sync already in progress — deduplicating (reason=${reason})`);
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const syncT0 = Date.now();
    tg.d('NEWS/sync', `▶ Starting sync (reason=${reason})`);

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
          // When using an external provider, litellm is the automatic fallback
          fallbackCompleteFn = (msgs, opts) => callLiteLLM(preferredModel(), msgs, opts);
          console.log(`[NEWS] Using LLM provider: ${providerName} (with litellm fallback)`);
          tg.i('NEWS/sync', `Provider resolved: ${providerName} (litellm fallback ready) for reason=${reason}`);
        }
      } catch (e) {
        console.warn(`[NEWS] getProviderFn failed, falling back to LiteLLM:`, e.message?.slice(0, 100));
        tg.w('NEWS/sync', 'Provider resolution failed — using LiteLLM fallback', e);
      }
    }

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
          const n = await processFeed({ pool, feed, config, settings, summaryLimiter, completeFn, fallbackCompleteFn, deepExtractFn });
          counts[feed.id] = n;
          total += n;
        }),
      ),
    );

    // cleanup old articles — keep saved and read articles
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (settings.article_retention_days || 30));
    const { rowCount: purged } = await pool.query(
      `DELETE FROM news_articles
       WHERE published_at < $1
         AND saved = FALSE AND read = FALSE`,
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
  return { lastSyncAt, lastSyncResult, lastSyncError, inProgress: activeSyncPromise != null };
}

function startScheduler(pool, { getProviderFn, deepExtractFn } = {}) {
  if (schedulerHandle) return;
  const settings = getSettings(loadConfig());
  const intervalMinutes = Math.max(5, settings.refresh_interval_minutes);
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[NEWS] Scheduler starting: interval=${intervalMinutes}min, concurrent_feeds=${settings.max_concurrent_feeds}, concurrent_summaries=${settings.max_concurrent_summaries}`);
  tg.i('NEWS/scheduler', `Starting: interval=${intervalMinutes}min, feeds_concurrency=${settings.max_concurrent_feeds}, summary_concurrency=${settings.max_concurrent_summaries}`);

  syncNewsFeeds(pool, { reason: 'startup', getProviderFn, deepExtractFn }).catch((e) => {
    console.error('[NEWS] Initial sync failed:', e.message?.slice(0, 120));
    tg.e('NEWS/scheduler', 'Initial startup sync failed', e);
  });

  let consecutiveFailures = 0;
  schedulerHandle = setInterval(async () => {
    try {
      await syncNewsFeeds(pool, { reason: 'scheduled', getProviderFn, deepExtractFn });
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

module.exports = { syncNewsFeeds, getSyncState, startScheduler };
