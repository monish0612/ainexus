import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, nowIso } from '../db.js';

export const cloudRouter = Router();

function mapFileRow(r) {
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
    ...(r.description ? { description: r.description } : {}),
    ...(tags ? { tags } : {}),
    featured: !!r.featured,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

cloudRouter.get('/files', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM cloud_files ORDER BY (featured = 1) DESC, updated_at DESC')
    .all();
  res.json({ files: rows.map(mapFileRow) });
});

cloudRouter.post('/upload', (req, res) => {
  const db = getDb();
  const {
    name,
    size,
    ext,
    date,
    description,
    tags,
    starred,
    featured,
  } = req.body || {};

  if (!name || size == null || !ext) {
    return res.status(400).json({ error: 'name, size, and ext are required' });
  }

  const id = uuidv4();
  const ts = nowIso();
  const dateLabel = date || 'Just now';
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags ? JSON.stringify([tags]) : null;

  db.prepare(
    `
    INSERT INTO cloud_files (
      id, name, size, ext, date_label, starred, description, tags_json, featured, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    String(name),
    Number(size),
    String(ext),
    String(dateLabel),
    starred ? 1 : 0,
    description != null ? String(description) : null,
    tagsJson,
    featured ? 1 : 0,
    ts,
    ts,
  );

  db.prepare(
    'INSERT INTO cloud_sync_history (id, file_id, mode, message, at) VALUES (?, ?, ?, ?, ?)',
  ).run(uuidv4(), id, 'upload', `${name} — metadata recorded`, ts);

  const row = db.prepare('SELECT * FROM cloud_files WHERE id = ?').get(id);
  res.status(201).json({ file: mapFileRow(row) });
});

cloudRouter.delete('/files/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const info = db.prepare('DELETE FROM cloud_files WHERE id = ?').run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'File not found' });
  }
  const ts = nowIso();
  db.prepare(
    'INSERT INTO cloud_sync_history (id, file_id, mode, message, at) VALUES (?, ?, ?, ?, ?)',
  ).run(uuidv4(), id, 'delete', 'File removed', ts);
  res.json({ ok: true, id });
});

cloudRouter.post('/files/:id/star', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const row = db.prepare('SELECT starred FROM cloud_files WHERE id = ?').get(id);
  if (!row) {
    return res.status(404).json({ error: 'File not found' });
  }
  const next = row.starred ? 0 : 1;
  const ts = nowIso();
  db.prepare('UPDATE cloud_files SET starred = ?, updated_at = ? WHERE id = ?').run(
    next,
    ts,
    id,
  );
  const updated = db.prepare('SELECT * FROM cloud_files WHERE id = ?').get(id);
  res.json({ file: mapFileRow(updated), starred: !!next });
});

cloudRouter.get('/sync-history', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, file_id AS fileId, mode, message, at FROM cloud_sync_history ORDER BY at DESC LIMIT 100',
    )
    .all();
  res.json({ history: rows });
});
