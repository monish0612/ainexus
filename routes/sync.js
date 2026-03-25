import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, nowIso } from '../db.js';

export const syncRouter = Router();

function mapExpenseRow(r) {
  return {
    id: r.id,
    amount: r.amount,
    description: r.description,
    category: r.category,
    bank: r.bank,
    cardType: r.card_type,
    date: r.date,
    isManualCategory: !!r.is_manual_category,
    updatedAt: r.updated_at,
  };
}

function mapNewsRow(r) {
  let content = [];
  try {
    content = JSON.parse(r.content_json);
  } catch {
    content = [];
  }
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    tag: r.tag || undefined,
    readTime: r.read_time,
    timeAgo: r.time_ago,
    date: r.date,
    image: r.image,
    excerpt: r.excerpt,
    source: r.source,
    isFeatured: !!r.is_featured,
    saved: !!r.saved,
    read: !!r.read,
    content,
    updatedAt: r.updated_at,
  };
}

function mapCloudRow(r) {
  let tags;
  if (r.tags_json) {
    try {
      tags = JSON.parse(r.tags_json);
    } catch {
      tags = undefined;
    }
  }
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    ext: r.ext,
    date: r.date_label,
    starred: !!r.starred,
    description: r.description || undefined,
    tags,
    featured: !!r.featured,
    updatedAt: r.updated_at,
  };
}

function applyMutation(db, item) {
  const { table_name: table, record_id: rid, operation: op, payload } = item;
  const ts = nowIso();
  const p = payload && typeof payload === 'object' ? payload : {};

  if (table === 'expenses') {
    if (op === 'delete') {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(rid);
      return;
    }
    if (op === 'insert' || op === 'update') {
      const id = p.id || rid || uuidv4();
      const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
      if (op === 'insert' && existing) {
        throw new Error(`Expense ${id} already exists`);
      }
      const amount = p.amount != null ? Number(p.amount) : existing?.amount;
      const description = p.description ?? existing?.description;
      const category = p.category ?? existing?.category;
      const bank = p.bank ?? existing?.bank;
      const cardType = p.cardType ?? existing?.card_type;
      const date = p.date ?? existing?.date ?? ts;
      const isManualCategory =
        p.isManualCategory != null
          ? p.isManualCategory
            ? 1
            : 0
          : existing?.is_manual_category ?? 0;

      if (
        amount == null ||
        !description ||
        !category ||
        !bank ||
        !cardType
      ) {
        throw new Error('expenses payload missing required fields');
      }

      db.prepare(
        `
        INSERT INTO expenses (
          id, amount, description, category, bank, card_type, date, is_manual_category, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          amount = excluded.amount,
          description = excluded.description,
          category = excluded.category,
          bank = excluded.bank,
          card_type = excluded.card_type,
          date = excluded.date,
          is_manual_category = excluded.is_manual_category,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        amount,
        description,
        category,
        bank,
        cardType,
        date,
        isManualCategory,
        existing?.created_at || ts,
        ts,
      );
    }
    return;
  }

  if (table === 'category_learnings') {
    if (op === 'delete') {
      db.prepare('DELETE FROM category_learnings WHERE keyword = ?').run(rid);
      return;
    }
    const keyword = p.keyword || rid;
    const category = p.category;
    if (!keyword || !category) {
      throw new Error('category_learnings needs keyword and category');
    }
    db.prepare(
      `
      INSERT INTO category_learnings (keyword, category, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(keyword) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at
    `,
    ).run(String(keyword), String(category), ts);
    return;
  }

  if (table === 'saved_words') {
    if (op === 'delete') {
      db.prepare('DELETE FROM saved_words WHERE id = ?').run(rid);
      return;
    }
    const id = p.id || rid || uuidv4();
    const word = p.word;
    const definition = p.definition;
    if (!word || !definition) {
      throw new Error('saved_words needs word and definition');
    }
    db.prepare(
      `
      INSERT INTO saved_words (id, word, pronunciation, definition, example, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        word = excluded.word,
        pronunciation = excluded.pronunciation,
        definition = excluded.definition,
        example = excluded.example,
        updated_at = excluded.updated_at
    `,
    ).run(
      id,
      String(word),
      p.pronunciation != null ? String(p.pronunciation) : null,
      String(definition),
      p.example != null ? String(p.example) : null,
      p.createdAt || ts,
      ts,
    );
    return;
  }

  throw new Error(`Unsupported sync table: ${table}`);
}

syncRouter.post('/', (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const items = body.items || body.queue || body.changes;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Expected items array (or queue/changes)' });
  }

  const processed = [];
  const errors = [];

  for (const item of items) {
    const qid = item.id || uuidv4();
    const ts = nowIso();
    try {
      db.prepare(
        `
        INSERT INTO sync_queue (id, table_name, record_id, operation, payload_json, client_id, created_at, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        qid,
        String(item.table_name || item.table || ''),
        String(item.record_id || item.recordId || ''),
        String(item.operation || item.op || ''),
        item.payload != null ? JSON.stringify(item.payload) : null,
        item.client_id || null,
        ts,
        null,
      );

      applyMutation(db, {
        table_name: item.table_name || item.table,
        record_id: item.record_id || item.recordId,
        operation: item.operation || item.op,
        payload: item.payload,
      });

      db.prepare('UPDATE sync_queue SET processed_at = ? WHERE id = ?').run(nowIso(), qid);
      processed.push(qid);
    } catch (e) {
      errors.push({ id: qid, error: String(e.message || e) });
    }
  }

  res.json({ ok: errors.length === 0, processed, errors });
});

syncRouter.get('/pull', (req, res) => {
  const db = getDb();
  const since = req.query.since ? String(req.query.since) : null;
  const serverTime = nowIso();

  const filter = since
    ? 'WHERE updated_at > ?'
    : '';
  const args = since ? [since] : [];

  const expenses = db
    .prepare(`SELECT * FROM expenses ${filter} ORDER BY date DESC`)
    .all(...args)
    .map(mapExpenseRow);

  const budgetRow = db.prepare('SELECT * FROM budget WHERE id = ?').get('current');
  const budget = {
    amount: budgetRow?.amount ?? 0,
    updatedAt: budgetRow?.updated_at ?? serverTime,
  };

  const budgetHistory = db
    .prepare(
      `${since ? 'SELECT * FROM budget_history WHERE set_at > ? ORDER BY set_at DESC' : 'SELECT * FROM budget_history ORDER BY set_at DESC'}`,
    )
    .all(...(since ? [since] : []))
    .map((r) => ({ id: r.id, amount: r.amount, setAt: r.set_at }));

  const newsArticles = db
    .prepare(`SELECT * FROM news_articles ${filter} ORDER BY updated_at DESC`)
    .all(...args)
    .map(mapNewsRow);

  const cloudFiles = db
    .prepare(`SELECT * FROM cloud_files ${filter} ORDER BY updated_at DESC`)
    .all(...args)
    .map(mapCloudRow);

  const savedWords = db
    .prepare(`SELECT * FROM saved_words ${filter} ORDER BY word ASC`)
    .all(...args)
    .map((r) => ({
      id: r.id,
      word: r.word,
      pronunciation: r.pronunciation,
      definition: r.definition,
      example: r.example,
      updatedAt: r.updated_at,
    }));

  const learnRows = db
    .prepare(
      since
        ? 'SELECT * FROM category_learnings WHERE updated_at > ?'
        : 'SELECT * FROM category_learnings',
    )
    .all(...(since ? [since] : []));
  const categoryLearnings = {};
  for (const r of learnRows) {
    categoryLearnings[r.keyword] = r.category;
  }

  res.json({
    serverTime,
    since,
    expenses,
    budget,
    budget_history: budgetHistory,
    news_articles: newsArticles,
    cloud_files: cloudFiles,
    saved_words: savedWords,
    category_learnings: categoryLearnings,
  });
});
