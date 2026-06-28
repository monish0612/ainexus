'use strict';

// ═══════════════════════════════════════════════════════════════
//  SAVED WORDS — router factory (extracted from index.js so the full
//  cross-device delete-sync lifecycle is unit-testable with a fake pool).
//
//  Cross-device delete sync mirrors saved-searches / expenses:
//    • per-id DELETE and bulk DELETE write a tombstone into
//      deleted_saved_words (id, deleted_at) BEFORE removing the row, so
//      other devices learn about the deletion on their next /tombstones pull.
//    • POST (re-save) clears any tombstone for that id ("undelete").
//    • GET /tombstones?since=<iso> returns the delta of deleted ids.
//
//  This fixes the bug where a word deleted on the web kept showing on the
//  phone (the phone's saved-words pull was insert-only with no delete log).
// ═══════════════════════════════════════════════════════════════

function buildSavedWordsRouter(express, pool, { log = console.log } = {}) {
  const router = express.Router();

  // GET all saved words
  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM saved_words ORDER BY saved_at DESC',
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /tombstones — incremental delete log. MUST be registered before any
  // '/:id' route so Express doesn't parse 'tombstones' as an :id param.
  // Wire shape: Array<{ id: string, deletedAt: ISO-8601 string }>
  router.get('/tombstones', async (req, res, next) => {
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
           FROM deleted_saved_words
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

  // POST create/upsert a saved word
  router.post('/', async (req, res, next) => {
    try {
      const { id, word, definition, pronunciation, partOfSpeech, savedAt, responseJson } =
        req.body || {};
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

      // Cross-device "undelete": if this id was deleted on another device and is
      // now being re-saved, drop any tombstone so the POST isn't undone when
      // other devices pull /tombstones.
      await pool.query('DELETE FROM deleted_saved_words WHERE id = $1', [id]);

      log('[SAVED_WORDS] Upserted:', id, word);
      res.json({ ok: true, id });
    } catch (err) {
      next(err);
    }
  });

  // DELETE all saved words (full-reset bulk clear). Declared BEFORE '/:id' so
  // the bare collection path matches here, not as an id. Tombstone EVERY current
  // id first so other devices sync the deletions.
  router.delete('/', async (_req, res, next) => {
    try {
      await pool.query(
        `INSERT INTO deleted_saved_words (id, deleted_at)
         SELECT id, NOW() FROM saved_words
         ON CONFLICT (id) DO UPDATE SET deleted_at = NOW()`,
      );
      const result = await pool.query('DELETE FROM saved_words');
      log('[SAVED_WORDS] Cleared all:', result.rowCount, 'rows deleted | tombstones written');
      res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
      next(err);
    }
  });

  // DELETE a saved word — hard delete + write a tombstone FIRST (idempotent
  // upsert) so cross-device sync still works even if a later step fails.
  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      await pool.query(
        `INSERT INTO deleted_saved_words (id, deleted_at)
         VALUES ($1, NOW())
         ON CONFLICT (id) DO UPDATE SET deleted_at = NOW()`,
        [id],
      );
      const result = await pool.query('DELETE FROM saved_words WHERE id = $1', [id]);
      log('[SAVED_WORDS] Deleted:', id, '| rows:', result.rowCount, '| tombstone written');
      res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildSavedWordsRouter };
