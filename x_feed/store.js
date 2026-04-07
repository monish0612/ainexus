'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Database operations (sync state, article CRUD, dedup)
// ═══════════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { getDb, nowIso } from '../db.js';
import { tg } from './config.js';

// ── GUID / ID generation ───────────────────────────────────────────────

export function buildGuid(handle, dateStr) {
  return `x-feed-${handle.toLowerCase()}-${dateStr}`;
}

export function buildArticleId(handle, dateStr) {
  const hash = createHash('sha1')
    .update(`${handle}|${dateStr}`)
    .digest('hex')
    .slice(0, 8);
  return `xf-${handle.toLowerCase()}-${dateStr}-${hash}`;
}

// ── Sync state ─────────────────────────────────────────────────────────

export function getSyncState(handle) {
  const db = getDb();
  return (
    db
      .prepare('SELECT * FROM x_feed_sync_state WHERE handle = ?')
      .get(handle) || null
  );
}

/**
 * Update sync state after a run.
 * @param {string} handle
 * @param {string} windowEnd  — ISO timestamp of the sync window end
 * @param {object} [meta]     — { postsProcessed, error }
 */
export function updateSyncState(handle, windowEnd, meta = {}) {
  const db = getDb();
  const now = nowIso();
  const { postsProcessed = 0, error = null } = meta;

  db.prepare(
    `
    INSERT INTO x_feed_sync_state
      (handle, last_window_end, last_sync_at, total_articles, total_posts_processed, last_error)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(handle) DO UPDATE SET
      last_window_end = excluded.last_window_end,
      last_sync_at = excluded.last_sync_at,
      total_posts_processed = total_posts_processed + excluded.total_posts_processed,
      last_error = excluded.last_error
  `,
  ).run(handle, windowEnd, now, postsProcessed, error);
}

export function incrementArticleCount(handle) {
  const db = getDb();
  db.prepare(
    'UPDATE x_feed_sync_state SET total_articles = total_articles + 1 WHERE handle = ?',
  ).run(handle);
}

// ── Article dedup ──────────────────────────────────────────────────────

export function articleExists(guid) {
  const db = getDb();
  return !!db.prepare('SELECT id FROM news_articles WHERE guid = ?').get(guid);
}

// ── Article insert ─────────────────────────────────────────────────────

export function insertDigestArticle({
  handle,
  dateStr,
  title,
  excerpt,
  category,
  tag,
  source,
  image,
  readTime,
  summaryMarkdown,
  publishedAt,
  contentMeta,
}) {
  const db = getDb();
  const now = nowIso();
  const guid = buildGuid(handle, dateStr);
  const articleId = buildArticleId(handle, dateStr);

  // Dedup guard
  if (articleExists(guid)) {
    tg.d('X-FEED/store', `Article ${guid} already exists — skip insert`);
    return null;
  }

  db.prepare(
    `
    INSERT INTO news_articles (
      id, title, category, tag, read_time, time_ago, date, image, excerpt, source,
      is_featured, content_json, saved, read, created_at, updated_at,
      guid, original_url, summary_markdown, published_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      0, ?, 0, 0, ?, ?,
      ?, ?, ?, ?
    )
  `,
  ).run(
    articleId,
    title,
    category,
    tag,
    readTime,
    'Today',
    dateStr,
    image,
    excerpt,
    source,
    JSON.stringify(contentMeta),
    now,
    now,
    guid,
    `https://x.com/${handle}`,
    summaryMarkdown,
    publishedAt,
  );

  // Promote to featured
  db.prepare(
    'UPDATE news_articles SET is_featured = 0 WHERE is_featured = 1',
  ).run();
  db.prepare(
    'UPDATE news_articles SET is_featured = 1 WHERE id = ?',
  ).run(articleId);

  incrementArticleCount(handle);
  tg.i(
    'X-FEED/store',
    `✓ Article stored: ${articleId} — "${title.slice(0, 50)}"`,
  );
  return articleId;
}
