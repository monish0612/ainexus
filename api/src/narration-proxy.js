'use strict';

const {
  enabled,
  ensureJob,
  jobStatus,
  completeListen,
  proxyAudio,
} = require('./narration-client');

function buildNarrationRouter(express, pool) {
  const router = express.Router();

  router.get('/:id', async (req, res, next) => {
    try {
      const rec = await jobStatus(req.params.id);
      res.json({ articleId: req.params.id, ...rec, configured: enabled() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/ensure', async (req, res, next) => {
    try {
      const id = req.params.id;
      const existing = await pool.query(
        'SELECT title, category, source, summary_markdown FROM news_articles WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        return res.json({ status: 'deleted', reason: 'article_dropped', configured: enabled() });
      }
      const row = existing.rows[0];
      let title = String(req.body?.title || '') || row.title || '';
      let category = String(req.body?.category || '') || row.category || '';
      let source = String(req.body?.source || '') || row.source || '';
      let text = String(req.body?.text || '');
      if (!text.trim()) text = row.summary_markdown || '';
      if (!text.trim()) {
        return res.json({ status: 'fallback', reason: 'empty_text', configured: enabled() });
      }
      const rec = await ensureJob({
        article_id: id,
        title,
        category,
        source,
        text: text.slice(0, 120000),
        hd: !!req.body?.hd,
      });
      res.json({ articleId: id, ...rec, configured: enabled() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/complete', async (req, res, next) => {
    try {
      const rec = await completeListen({
        articleId: req.params.id,
        cacheKey: req.body?.cacheKey || req.body?.cache_key,
      });
      res.json({ articleId: req.params.id, ...rec });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/audio', async (req, res, next) => {
    try {
      const rec = await jobStatus(req.params.id);
      const cacheKey = rec?.cache_key || rec?.cacheKey;
      if (!cacheKey || rec.status === 'fallback' || rec.status === 'deleted') {
        return res.status(404).json({ error: 'audio not ready' });
      }
      await proxyAudio(req, res, cacheKey, { hd: req.query.hd === '1' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildNarrationRouter };
