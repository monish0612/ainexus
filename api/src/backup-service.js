'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Rolling Google Drive backup of *user* data (expenses, saved articles,
//  saved words, saved searches, salary, budget, settings).
//
//  One folder (`AI Nexus Backups`) + one file (`nexus-backup.json`). Every
//  run overwrites that same file. News-feed cache and other regenerable
//  tables are not included.
// ─────────────────────────────────────────────────────────────────────────────

const { Readable } = require('stream');
const { tg } = require('./telegram');
const cloudService = require('./cloud-service');

const SCHEMA_VERSION = 1;
const KIND = 'ai-nexus-user-backup';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 60 * 1000;

/**
 * Tables copied into the snapshot. `where` limits a table to user-owned
 * rows (saved articles only). Tombstone tables travel with the live rows
 * so a restore does not resurrect something the user already deleted.
 */
const TABLES = [
  { name: 'expenses', pk: ['id'] },
  { name: 'deleted_expenses', pk: ['id'] },
  { name: 'budget_entries', pk: ['id'] },
  { name: 'salary_entries', pk: ['id'] },
  { name: 'category_learnings', pk: ['keyword'] },
  { name: 'saved_words', pk: ['id'] },
  { name: 'deleted_saved_words', pk: ['id'] },
  { name: 'saved_searches', pk: ['id'] },
  { name: 'saved_search_chat_messages', pk: ['id'] },
  { name: 'saved_search_chat_summaries', pk: ['search_id'] },
  { name: 'deleted_saved_searches', pk: ['id'] },
  { name: 'news_articles', pk: ['id'], where: 'saved = TRUE' },
  { name: 'article_chat_messages', pk: ['id'] },
  { name: 'article_chat_summaries', pk: ['article_id'] },
  { name: 'user_preferences', pk: ['key'] },
  { name: 'app_settings', pk: ['key'] },
];

const TABLE_BY_NAME = Object.fromEntries(TABLES.map((t) => [t.name, t]));

let schedulerHandle = null;
let startupHandle = null;
let activePromise = null;
let lastRunAt = null;
let lastError = null;
let lastResult = null;

function jsonSafe(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function isValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.kind !== KIND) return false;
  const ver = Number(snapshot.schemaVersion);
  if (!Number.isFinite(ver) || ver < 1 || ver > SCHEMA_VERSION) return false;
  if (!snapshot.tables || typeof snapshot.tables !== 'object') return false;
  return true;
}

async function _selectTable(pool, spec) {
  const sql = spec.where
    ? `SELECT * FROM ${quoteIdent(spec.name)} WHERE ${spec.where}`
    : `SELECT * FROM ${quoteIdent(spec.name)}`;
  try {
    const { rows } = await pool.query(sql);
    return (rows || []).map(jsonSafe);
  } catch (err) {
    // Table missing on a brand-new DB — snapshot that table as empty.
    if (err && (err.code === '42P01' || /does not exist/i.test(err.message || ''))) {
      return [];
    }
    throw err;
  }
}

async function buildSnapshot(pool) {
  const tables = {};
  const counts = {};
  for (const spec of TABLES) {
    const rows = await _selectTable(pool, spec);
    tables[spec.name] = rows;
    counts[spec.name] = rows.length;
  }
  // Keep follow-up chats only for articles that are in this snapshot.
  const savedIds = new Set((tables.news_articles || []).map((r) => r.id));
  tables.article_chat_messages = (tables.article_chat_messages || []).filter(
    (r) => savedIds.has(r.article_id),
  );
  tables.article_chat_summaries = (tables.article_chat_summaries || []).filter(
    (r) => savedIds.has(r.article_id),
  );
  counts.article_chat_messages = tables.article_chat_messages.length;
  counts.article_chat_summaries = tables.article_chat_summaries.length;

  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    tables,
    counts,
  };
}

function _valuesFor(spec, row) {
  const cols = Object.keys(row).filter((c) => c && c !== '__proto__');
  if (!cols.length) return null;
  const pkOk = spec.pk.every((k) => row[k] != null && String(row[k]).length > 0);
  if (!pkOk) return null;
  return cols;
}

function upsertSql(tableName, columns, pk) {
  const spec = TABLE_BY_NAME[tableName];
  if (!spec) throw new Error(`Refusing to restore unknown table ${tableName}`);
  const colSql = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const pkSet = new Set(pk);
  const updates = columns
    .filter((c) => !pkSet.has(c))
    .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
  const conflict = pk.map(quoteIdent).join(', ');
  const updateSql = updates.length ? updates.join(', ') : quoteIdent(pk[0]);
  return (
    `INSERT INTO ${quoteIdent(tableName)} (${colSql}) VALUES (${placeholders}) ` +
    `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSql}`
  );
}

async function _upsertRows(client, spec, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cols = _valuesFor(spec, row);
    if (!cols) continue;
    const sql = upsertSql(spec.name, cols, spec.pk);
    const values = cols.map((c) => row[c]);
    await client.query(sql, values);
    n += 1;
  }
  return n;
}

async function applySnapshot(pool, snapshot) {
  if (!isValidSnapshot(snapshot)) {
    throw new Error('Invalid backup snapshot (kind/schemaVersion)');
  }
  const client = await pool.connect();
  const applied = {};
  try {
    await client.query('BEGIN');
    for (const spec of TABLES) {
      if (spec.name.startsWith('deleted_')) continue;
      applied[spec.name] = await _upsertRows(client, spec, snapshot.tables[spec.name]);
    }
    // Tombstones last: delete live rows the backup says are gone, then
    // record the tombstone so other devices stay in sync.
    applied.deleted_expenses = await _applyTombstones(
      client, 'expenses', 'deleted_expenses', snapshot.tables.deleted_expenses,
    );
    applied.deleted_saved_words = await _applyTombstones(
      client, 'saved_words', 'deleted_saved_words', snapshot.tables.deleted_saved_words,
    );
    applied.deleted_saved_searches = await _applyTombstones(
      client, 'saved_searches', 'deleted_saved_searches', snapshot.tables.deleted_saved_searches,
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return applied;
}

async function _applyTombstones(client, liveTable, tombTable, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let n = 0;
  for (const row of rows) {
    const id = row && row.id;
    if (!id) continue;
    await client.query(`DELETE FROM ${quoteIdent(liveTable)} WHERE ${quoteIdent('id')} = $1`, [id]);
    await client.query(
      `INSERT INTO ${quoteIdent(tombTable)} (${quoteIdent('id')}, ${quoteIdent('deleted_at')})
       VALUES ($1, COALESCE($2::timestamptz, NOW()))
       ON CONFLICT (${quoteIdent('id')}) DO NOTHING`,
      [id, row.deleted_at || null],
    );
    n += 1;
  }
  return n;
}

function getState() {
  return {
    folderName: cloudService.BACKUP_FOLDER_NAME,
    fileName: cloudService.BACKUP_FILE_NAME,
    intervalMs: _intervalMs(),
    lastRunAt,
    lastError,
    lastResult,
    running: !!activePromise,
  };
}

function _intervalMs() {
  const n = Number(process.env.BACKUP_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  return DEFAULT_INTERVAL_MS;
}

async function runBackup(pool, { reason = 'manual', drive = cloudService } = {}) {
  if (activePromise) return activePromise;
  if (!drive.isDriveAvailable()) {
    lastError = 'Google Drive is not configured';
    const result = { success: false, reason, error: lastError };
    lastResult = result;
    return result;
  }

  activePromise = (async () => {
    const t0 = Date.now();
    const snapshot = await buildSnapshot(pool);
    const json = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const body = Readable.from(json);
    const uploaded = await drive.upsertBackupFile(body, { mimeType: 'application/json' });
    lastRunAt = new Date().toISOString();
    lastError = null;
    lastResult = {
      success: true,
      reason,
      createdAt: snapshot.createdAt,
      bytes: json.length,
      counts: snapshot.counts,
      overwritten: !!uploaded.overwritten,
      folderId: uploaded.folder && uploaded.folder.id,
      folderName: (uploaded.folder && uploaded.folder.name) || cloudService.BACKUP_FOLDER_NAME,
      fileId: uploaded.file && uploaded.file.id,
      fileName: (uploaded.file && uploaded.file.name) || cloudService.BACKUP_FILE_NAME,
      elapsedMs: Date.now() - t0,
    };
    console.log(
      `[BACKUP] ${reason}: ${json.length}B overwritten=${lastResult.overwritten} ` +
      `expenses=${snapshot.counts.expenses || 0} savedArticles=${snapshot.counts.news_articles || 0} ` +
      `${lastResult.elapsedMs}ms`,
    );
    tg.i(
      'Backup',
      `✓ ${reason}: ${json.length}B file=${lastResult.fileName} overwritten=${lastResult.overwritten}`,
    );
    return lastResult;
  })().catch((err) => {
    lastError = (err && err.message) || String(err);
    lastResult = { success: false, reason, error: lastError };
    console.error(`[BACKUP] ${reason} FAILED:`, lastError.slice(0, 200));
    tg.e('Backup', `✗ ${reason}: ${lastError.slice(0, 150)}`, err);
    return lastResult;
  }).finally(() => {
    activePromise = null;
  });

  return activePromise;
}

async function restoreFromDrive(pool, { drive = cloudService } = {}) {
  if (!drive.isDriveAvailable()) {
    throw new Error('Google Drive is not configured');
  }
  const found = await drive.findBackupFile();
  if (!found || !found.file) {
    throw new Error('No nexus-backup.json found in AI Nexus Backups');
  }
  const stream = await drive.downloadStream(found.file.id);
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new Error('Backup file is not valid JSON');
  }
  const applied = await applySnapshot(pool, snapshot);
  tg.i('Backup', `Restore applied from ${found.file.id}`);
  return {
    success: true,
    fileId: found.file.id,
    fileName: found.file.name,
    createdAt: snapshot.createdAt || null,
    applied,
  };
}

function startScheduler(pool) {
  if (schedulerHandle) return;
  if (!cloudService.isDriveAvailable()) {
    console.log('[BACKUP] Scheduler skipped — Google Drive is not configured');
    return;
  }
  const interval = _intervalMs();
  schedulerHandle = setInterval(() => {
    runBackup(pool, { reason: 'scheduled' }).catch(() => {});
  }, interval);
  if (typeof schedulerHandle.unref === 'function') schedulerHandle.unref();

  startupHandle = setTimeout(() => {
    runBackup(pool, { reason: 'startup' }).catch(() => {});
  }, STARTUP_DELAY_MS);
  if (typeof startupHandle.unref === 'function') startupHandle.unref();

  console.log(`[BACKUP] Scheduler starting: folder="${cloudService.BACKUP_FOLDER_NAME}" file="${cloudService.BACKUP_FILE_NAME}" interval=${Math.round(interval / 60000)}min`);
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
}

function _resetForTests() {
  stopScheduler();
  activePromise = null;
  lastRunAt = null;
  lastError = null;
  lastResult = null;
}

module.exports = {
  SCHEMA_VERSION,
  KIND,
  TABLES,
  jsonSafe,
  isValidSnapshot,
  buildSnapshot,
  applySnapshot,
  upsertSql,
  runBackup,
  restoreFromDrive,
  getState,
  startScheduler,
  stopScheduler,
  _resetForTests,
};
