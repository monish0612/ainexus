import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, nowIso } from '../db.js';

export const budgetRouter = Router();

budgetRouter.get('/', (_req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM budget WHERE id = ?').get('current');
  const amount = row ? row.amount : 0;
  const updatedAt = row ? row.updated_at : nowIso();
  res.json({ budget: { amount, updatedAt } });
});

budgetRouter.post('/', (req, res) => {
  const db = getDb();
  const { amount } = req.body || {};
  if (amount == null || Number.isNaN(Number(amount))) {
    return res.status(400).json({ error: 'Numeric amount is required' });
  }
  const n = Number(amount);
  const ts = nowIso();

  db.prepare(`
    INSERT INTO budget (id, amount, updated_at) VALUES ('current', ?, ?)
    ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(n, ts);

  const histId = uuidv4();
  db.prepare(
    'INSERT INTO budget_history (id, amount, set_at) VALUES (?, ?, ?)',
  ).run(histId, n, ts);

  res.json({ budget: { amount: n, updatedAt: ts }, historyId: histId });
});

budgetRouter.get('/history', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, amount, set_at AS setAt FROM budget_history ORDER BY set_at DESC')
    .all();
  res.json({ history: rows });
});
