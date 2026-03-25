import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, nowIso } from '../db.js';

export const expensesRouter = Router();

function rowToExpense(r) {
  return {
    id: r.id,
    amount: r.amount,
    description: r.description,
    category: r.category,
    bank: r.bank,
    cardType: r.card_type,
    date: r.date,
    isManualCategory: !!r.is_manual_category,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

expensesRouter.get('/', (req, res) => {
  const db = getDb();
  const { category, bank, from, to } = req.query;
  let sql = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(String(category));
  }
  if (bank) {
    sql += ' AND bank = ?';
    params.push(String(bank));
  }
  if (from) {
    sql += ' AND date >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND date <= ?';
    params.push(String(to));
  }
  sql += ' ORDER BY date DESC';

  const rows = db.prepare(sql).all(...params);
  res.json({ expenses: rows.map(rowToExpense) });
});

expensesRouter.post('/', (req, res) => {
  const db = getDb();
  const {
    amount,
    description,
    category,
    bank,
    cardType,
    date,
    isManualCategory,
  } = req.body || {};

  if (
    amount == null ||
    !description ||
    !category ||
    !bank ||
    !cardType
  ) {
    return res.status(400).json({
      error: 'amount, description, category, bank, and cardType are required',
    });
  }

  const id = uuidv4();
  const ts = nowIso();
  const dateVal = date || ts;

  db.prepare(
    `
    INSERT INTO expenses (
      id, amount, description, category, bank, card_type, date, is_manual_category, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    Number(amount),
    String(description),
    String(category),
    String(bank),
    String(cardType),
    dateVal,
    isManualCategory ? 1 : 0,
    ts,
    ts,
  );

  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  res.status(201).json({ expense: rowToExpense(row) });
});

expensesRouter.put('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Expense not found' });
  }

  const patch = req.body || {};
  const amount = patch.amount != null ? Number(patch.amount) : existing.amount;
  const description =
    patch.description != null ? String(patch.description) : existing.description;
  const category =
    patch.category != null ? String(patch.category) : existing.category;
  const bank = patch.bank != null ? String(patch.bank) : existing.bank;
  const cardType =
    patch.cardType != null ? String(patch.cardType) : existing.card_type;
  const date = patch.date != null ? String(patch.date) : existing.date;
  const isManualCategory =
    patch.isManualCategory != null
      ? patch.isManualCategory
        ? 1
        : 0
      : existing.is_manual_category;

  const ts = nowIso();
  db.prepare(
    `
    UPDATE expenses SET
      amount = ?, description = ?, category = ?, bank = ?, card_type = ?, date = ?,
      is_manual_category = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(
    amount,
    description,
    category,
    bank,
    cardType,
    date,
    isManualCategory,
    ts,
    id,
  );

  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  res.json({ expense: rowToExpense(row) });
});

expensesRouter.delete('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Expense not found' });
  }
  res.json({ ok: true, id });
});
