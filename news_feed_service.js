import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

import { getDb, nowIso } from './db.js';
import { callLiteLLM } from './litellm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'news_rss_feeds.json');

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

function loadNewsFeedConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error('Failed to load news RSS config:', error);
    return {
      feeds: [],
      settings: DEFAULT_SETTINGS,
      summary_prompt: {
        system: 'You are an expert educator who simplifies complex news.',
        template: 'Summarize this article.\n\nTitle: {title}\n\nContent:\n{content}',
      },
    };
  }
}

function getNewsSettings(config = loadNewsFeedConfig()) {
  return {
    ...DEFAULT_SETTINGS,
    ...(config.settings || {}),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(limit) {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  let activeCount = 0;
  const queue = [];

  const runNext = () => {
    if (activeCount >= normalizedLimit) {
      return;
    }

    const nextTask = queue.shift();
    if (!nextTask) {
      return;
    }

    activeCount += 1;
    nextTask();
  };

  return (task) =>
    new Promise((resolve, reject) => {
      const execute = () => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1;
            runNext();
          });
      };

      queue.push(execute);
      runNext();
    });
}

function stripCdata(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeHtmlEntities(value = '') {
  if (!value) {
    return '';
  }

  const named = {
    amp: '&',
    apos: "'",
    quot: '"',
    nbsp: ' ',
    ndash: '-',
    mdash: '-',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    hellip: '...',
    copy: '(c)',
    reg: '(r)',
    trade: '(tm)',
  };

  let output = String(value);
  for (let i = 0; i < 2; i += 1) {
    output = output
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
        String.fromCharCode(Number.parseInt(code, 16)),
      )
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
  }

  return output;
}

function stripTags(value = '') {
  return String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|article|section|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(value = '') {
  return String(value)
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function cleanHtmlContent(htmlContent = '') {
  const decoded = decodeHtmlEntities(stripCdata(htmlContent));
  return normalizeWhitespace(stripTags(decoded));
}

function extractTagValue(block, tagNames) {
  for (const tagName of tagNames) {
    const regex = new RegExp(
      `<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`,
      'i',
    );
    const match = block.match(regex);
    if (match?.[1]) {
      return decodeHtmlEntities(stripCdata(match[1].trim()));
    }
  }

  return '';
}

function extractLink(block) {
  const linkMatches = [...block.matchAll(/<link\b([^>]*)>/gi)];
  for (const match of linkMatches) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\shref=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) {
      continue;
    }

    const relMatch = attrs.match(/\srel=["']([^"']+)["']/i);
    const rel = relMatch?.[1]?.toLowerCase() ?? 'alternate';
    if (rel === 'alternate' || rel === 'self') {
      return hrefMatch[1].trim();
    }
  }

  return extractTagValue(block, ['link']);
}

function extractHtmlContent(block) {
  const candidates = [
    extractTagValue(block, ['content:encoded']),
    extractTagValue(block, ['content']),
    extractTagValue(block, ['summary']),
    extractTagValue(block, ['description']),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (!candidates.length) {
    return '';
  }

  return candidates.sort((a, b) => b.length - a.length)[0];
}

function absolutizeUrl(url, baseUrl) {
  if (!url) {
    return '';
  }

  try {
    return new URL(url, baseUrl || undefined).toString();
  } catch {
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    return url;
  }
}

function extractImageUrl(block, htmlContent, link) {
  const decodedHtml = decodeHtmlEntities(stripCdata(htmlContent || ''));

  const htmlImageMatch = decodedHtml.match(/<img\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/i);
  if (htmlImageMatch?.[1]) {
    return absolutizeUrl(htmlImageMatch[1].trim(), link);
  }

  const mediaAttrPatterns = [
    /<media:content\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
    /<media:thumbnail\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
    /<enclosure\b[^>]*\surl=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of mediaAttrPatterns) {
    const match = block.match(pattern);
    if (match?.[1]) {
      return absolutizeUrl(decodeHtmlEntities(match[1].trim()), link);
    }
  }

  const imageText = extractTagValue(block, ['image', 'thumbnail']);
  if (imageText) {
    return absolutizeUrl(imageText, link);
  }

  return '';
}

function buildStableGuid(rawGuid, link, title) {
  const candidate = (rawGuid || link || '').trim();
  if (candidate && candidate.length >= 12 && !candidate.endsWith('/')) {
    return candidate;
  }

  const hash = createHash('sha1');
  hash.update(`${link || ''}|${title || ''}`);
  return hash.digest('hex');
}

function parseFeedItems(xml) {
  const itemMatches = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryMatches =
    itemMatches.length > 0
      ? []
      : [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);

  const blocks = itemMatches.length > 0 ? itemMatches : entryMatches;

  return blocks
    .map((block) => {
      const title = normalizeWhitespace(extractTagValue(block, ['title'])) || 'Untitled';
      const link = extractLink(block);
      const rawGuid = extractTagValue(block, ['guid', 'id']);
      const guid = buildStableGuid(rawGuid, link, title);
      const publishedAtRaw = extractTagValue(block, [
        'pubDate',
        'published',
        'updated',
        'dc:date',
        'created',
      ]);
      const htmlContent = extractHtmlContent(block);
      const textContent = cleanHtmlContent(htmlContent);
      const imageUrl = extractImageUrl(block, htmlContent, link);

      return {
        title,
        link,
        guid,
        publishedAtRaw,
        htmlContent,
        textContent,
        imageUrl,
      };
    })
    .filter((item) => item.guid && (item.link || item.title));
}

function parsePublishedDate(value) {
  const fallback = new Date();
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed;
}

function formatPublishedLabel(date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatTimeAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hr ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }

  return formatPublishedLabel(date);
}

function fillPromptTemplate(template, title, content) {
  return String(template || '')
    .replaceAll('{title}', title)
    .replaceAll('{content}', content);
}

function preferredSummaryModel() {
  return (
    process.env.NEWS_SUMMARY_MODEL ||
    process.env.LITELLM_MODEL ||
    null
  );
}

function generateArticleSourceLink(url, sourceName = 'Source') {
  const safeSource = sourceName || 'Source';
  return [
    '',
    '---',
    '',
    '## Read Original Article',
    '',
    `Original source: **${safeSource}**`,
    '',
    `[Open original link](${url})`,
    '',
  ].join('\n');
}

function appendSourceLinkToSummary(summary, url, sourceName) {
  if (!summary || !url) {
    return summary;
  }

  if (summary.includes(url) || summary.includes('Read Original Article')) {
    return summary.trim();
  }

  return `${summary.trim()}\n${generateArticleSourceLink(url, sourceName)}`.trim();
}

function generateFallbackSummary(title, content, url, sourceName) {
  const plainContent = normalizeWhitespace(content || '');
  const excerpt = plainContent.slice(0, 650).trim();
  const base = [
    `# ${title}`,
    '',
    '## Article Preview',
    '',
    excerpt || 'Summary generation was unavailable for this article.',
    '',
  ].join('\n');

  return appendSourceLinkToSummary(base, url, sourceName);
}

function stripMarkdown(value = '') {
  return normalizeWhitespace(
    String(value)
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

function buildExcerpt(summary, fallbackText) {
  const source = stripMarkdown(summary || fallbackText || '');
  if (!source) {
    return 'New article available.';
  }

  if (source.length <= 220) {
    return source;
  }

  const truncated = source.slice(0, 217);
  const lastSpace = truncated.lastIndexOf(' ');
  const safe = lastSpace > 120 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe.trim()}...`;
}

function estimateReadTime(content) {
  const words = stripMarkdown(content).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

async function fetchFeedXml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'User-Agent': 'Nexus-AI-News/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Feed request failed with status ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateArticleSummary({
  title,
  content,
  imageUrl,
  promptKey,
  settings,
  config,
}) {
  if (!content || content.trim().length < 100) {
    return null;
  }

  const promptConfig = config[promptKey] || config.summary_prompt || {};
  const systemPrompt =
    promptConfig.system || 'You are an expert educator who simplifies complex news.';
  const isTechPrompt = promptKey === 'tech_summary_prompt';
  const contentLimit = isTechPrompt ? 8000 : 6000;
  const maxTokens = isTechPrompt
    ? Math.max(settings.max_summary_tokens || 2500, 3500)
    : settings.max_summary_tokens || 2500;
  const userPrompt = fillPromptTemplate(
    promptConfig.template || 'Summarize this article.\n\nTitle: {title}\n\nContent:\n{content}',
    title,
    content.slice(0, contentLimit),
  );

  const trySummary = async (useImage) => {
    const messages = [{ role: 'system', content: systemPrompt }];

    if (useImage && settings.enable_image_analysis && imageUrl) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: userPrompt });
    }

    const output = await callLiteLLM(preferredSummaryModel(), messages, {
      temperature: 0.35,
      max_tokens: maxTokens,
    });

    return String(output || '').trim();
  };

  try {
    if (settings.enable_image_analysis && imageUrl) {
      const imageSummary = await trySummary(true);
      if (imageSummary && imageSummary.length >= 50) {
        return imageSummary;
      }
    }
  } catch (error) {
    console.warn(`Image-assisted summary retrying without image for "${title}":`, error.message);
  }

  try {
    const summary = await trySummary(false);
    return summary && summary.length >= 50 ? summary : null;
  } catch (error) {
    console.error(`Summary generation failed for "${title}":`, error.message);
    return null;
  }
}

function articleExists(database, guid) {
  return database.prepare('SELECT id FROM news_articles WHERE guid = ?').get(guid);
}

function insertArticle(database, article) {
  database
    .prepare(
      `
        INSERT INTO news_articles (
          id, title, category, tag, read_time, time_ago, date, image, excerpt, source,
          is_featured, content_json, saved, read, created_at, updated_at, guid,
          original_url, summary_markdown, published_at
        ) VALUES (
          @id, @title, @category, @tag, @read_time, @time_ago, @date, @image, @excerpt, @source,
          @is_featured, @content_json, @saved, @read, @created_at, @updated_at, @guid,
          @original_url, @summary_markdown, @published_at
        )
      `,
    )
    .run(article);
}

function cleanupExpiredArticles(database, retentionDays) {
  database
    .prepare(
      `
        DELETE FROM news_articles
        WHERE datetime(COALESCE(published_at, created_at)) < datetime('now', ?)
      `,
    )
    .run(`-${retentionDays} days`);
}

function updateFeaturedArticle(database) {
  database.prepare('UPDATE news_articles SET is_featured = 0').run();
  database
    .prepare(
      `
        UPDATE news_articles
        SET is_featured = 1
        WHERE id = (
          SELECT id
          FROM news_articles
          ORDER BY datetime(COALESCE(published_at, created_at)) DESC, updated_at DESC
          LIMIT 1
        )
      `,
    )
    .run();
}

async function processFeedItem({ item, feedConfig, config, settings, summaryLimiter }) {
  const database = getDb();
  if (articleExists(database, item.guid)) {
    return false;
  }

  const title = item.title || 'Untitled';
  const publishedAt = parsePublishedDate(item.publishedAtRaw);
  const publishedLabel = formatPublishedLabel(publishedAt);
  const timeAgo = formatTimeAgo(publishedAt);
  const sourceName = feedConfig.name || feedConfig.id;
  const contentText = item.textContent || cleanHtmlContent(item.htmlContent || '');

  let summary = await summaryLimiter(async () => {
    const generated = await generateArticleSummary({
      title,
      content: contentText,
      imageUrl: item.imageUrl,
      promptKey: feedConfig.prompt_key,
      settings,
      config,
    });

    if (settings.api_delay_seconds > 0) {
      await sleep(settings.api_delay_seconds * 1000);
    }

    return generated;
  });

  if (!summary) {
    summary = generateFallbackSummary(title, contentText, item.link, sourceName);
  } else {
    summary = appendSourceLinkToSummary(summary, item.link, sourceName);
  }

  const now = nowIso();
  insertArticle(database, {
    id: `news-${uuidv4()}`,
    title,
    category: feedConfig.app_category || 'Technology',
    tag: feedConfig.category || null,
    read_time: estimateReadTime(summary),
    time_ago: timeAgo,
    date: publishedLabel,
    image: item.imageUrl || '',
    excerpt: buildExcerpt(summary, contentText),
    source: sourceName,
    is_featured: 0,
    content_json: JSON.stringify({
      sourceId: feedConfig.id,
      originalUrl: item.link || '',
      publishedAt: publishedAt.toISOString(),
    }),
    saved: 0,
    read: 0,
    created_at: now,
    updated_at: now,
    guid: item.guid,
    original_url: item.link || '',
    summary_markdown: summary,
    published_at: publishedAt.toISOString(),
  });

  return true;
}

async function processFeed({ feedConfig, config, settings, summaryLimiter }) {
  try {
    const xml = await fetchFeedXml(feedConfig.url);
    const items = parseFeedItems(xml).slice(0, settings.max_articles_per_feed);
    const results = await Promise.all(
      items.map((item) =>
        processFeedItem({
          item,
          feedConfig,
          config,
          settings,
          summaryLimiter,
        }).catch((error) => {
          console.error(`Failed to process article from ${feedConfig.id}:`, error.message);
          return false;
        }),
      ),
    );

    return results.filter(Boolean).length;
  } catch (error) {
    console.error(`Failed to process feed ${feedConfig.id}:`, error.message);
    return 0;
  }
}

export async function syncNewsFeeds({ reason = 'manual' } = {}) {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const config = loadNewsFeedConfig();
    const settings = getNewsSettings(config);
    const enabledFeeds = (config.feeds || []).filter((feed) => feed.enabled !== false);
    const feedLimiter = createLimiter(settings.max_concurrent_feeds);
    const summaryLimiter = createLimiter(settings.max_concurrent_summaries);

    const feedCounts = {};
    let totalNew = 0;

    await Promise.all(
      enabledFeeds.map((feedConfig) =>
        feedLimiter(async () => {
          const count = await processFeed({
            feedConfig,
            config,
            settings,
            summaryLimiter,
          });
          feedCounts[feedConfig.id] = count;
          totalNew += count;
        }),
      ),
    );

    const database = getDb();
    cleanupExpiredArticles(database, settings.article_retention_days);
    updateFeaturedArticle(database);

    lastSyncAt = nowIso();
    lastSyncError = null;
    lastSyncResult = {
      success: true,
      reason,
      syncedAt: lastSyncAt,
      totalNew,
      feeds: feedCounts,
    };

    return lastSyncResult;
  })().catch((error) => {
    lastSyncError = error.message || String(error);
    throw error;
  });

  try {
    return await activeSyncPromise;
  } finally {
    activeSyncPromise = null;
  }
}

export function getNewsSyncState() {
  return {
    lastSyncAt,
    lastSyncResult,
    lastSyncError,
    inProgress: activeSyncPromise != null,
  };
}

export function startNewsSyncScheduler() {
  if (schedulerHandle) {
    return;
  }

  const settings = getNewsSettings(loadNewsFeedConfig());
  const intervalMs = Math.max(5, settings.refresh_interval_minutes) * 60 * 1000;

  void syncNewsFeeds({ reason: 'startup' }).catch((error) => {
    console.error('Initial news sync failed:', error.message);
  });

  schedulerHandle = setInterval(() => {
    void syncNewsFeeds({ reason: 'scheduled' }).catch((error) => {
      console.error('Scheduled news sync failed:', error.message);
    });
  }, intervalMs);
}

export function stopNewsSyncScheduler() {
  if (!schedulerHandle) {
    return;
  }

  clearInterval(schedulerHandle);
  schedulerHandle = null;
}
