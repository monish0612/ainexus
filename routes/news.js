import { Router } from 'express';

import { getDb, nowIso } from '../db.js';
import { getNewsSyncState, syncNewsFeeds } from '../news_feed_service.js';

export const newsRouter = Router();

function parseContentMeta(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mapArticleRow(row, { includeSummary = false } = {}) {
  const meta = parseContentMeta(row.content_json);

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
    feedId: meta.sourceId || null,
    ...(includeSummary ? { summaryMarkdown: row.summary_markdown || '' } : {}),
  };
}

function getAllArticles() {
  const db = getDb();
  return db
    .prepare(
      `
        SELECT *
        FROM news_articles
        ORDER BY
          (is_featured = 1) DESC,
          datetime(COALESCE(published_at, created_at)) DESC,
          updated_at DESC
      `,
    )
    .all();
}

newsRouter.get('/', (_req, res) => {
  const rows = getAllArticles();
  res.json({
    articles: rows.map((row) => mapArticleRow(row)),
    sync: getNewsSyncState(),
  });
});

newsRouter.post('/refresh', async (_req, res, next) => {
  try {
    const result = await syncNewsFeeds({ reason: 'manual' });
    const rows = getAllArticles();
    res.json({
      refreshed: true,
      result,
      articles: rows.map((row) => mapArticleRow(row)),
      sync: getNewsSyncState(),
    });
  } catch (error) {
    next(error);
  }
});

newsRouter.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json({ article: mapArticleRow(row, { includeSummary: true }) });
});

newsRouter.post('/:id/save', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const row = db.prepare('SELECT saved FROM news_articles WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Article not found' });
  }
  const next = row.saved ? 0 : 1;
  const ts = nowIso();
  db.prepare('UPDATE news_articles SET saved = ?, updated_at = ? WHERE id = ?').run(
    next,
    ts,
    id,
  );
  const updated = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
  res.json({ article: mapArticleRow(updated), saved: !!next });
});

newsRouter.post('/:id/read', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'Article not found' });
  }
  const ts = nowIso();
  db.prepare('UPDATE news_articles SET read = 1, updated_at = ? WHERE id = ?').run(ts, id);
  const updated = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(id);
  res.json({ article: mapArticleRow(updated) });
});
