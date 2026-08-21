'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Rolling Google Drive backup of *user* data (expenses, saved articles,
//  saved words, saved searches, salary, budget, settings).
//
//  One folder (`AI Nexus Backups`) + one file (`nexus-backup.json`). Every
//  run overwrites that same file. Deletes are stripped from the snapshot and
//  a coalesced rewrite is scheduled so Drive does not keep removed items.
// ─────────────────────────────────────────────────────────────────────────────

const { tg } = require('./telegram');
const cloudService = require('./cloud-service');

const SCHEMA_VERSION = 1;
const KIND = 'ai-nexus-user-backup';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const DEFAULT_MUTATION_DELAY_MS = 2500;
const MAX_DRIVE_ATTEMPTS = 4;
const MAX_CHAINED_RUNS = 3;

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
let debounceHandle = null;
let activePromise = null;
let dirty = false;
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

function isRetryableDriveError(err) {
  if (!err) return false;
  const status = Number(err.status || err.code || err.response?.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(err.code || '');
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  const msg = String(err.message || err);
  return /rate limit|userRateLimitExceeded|backendError|internal error|ECONNRESET|ETIMEDOUT|socket hang up|EPIPE|temporarily unavailable|\b429\b|\b503\b|\b502\b/i.test(msg);
}

async function withDriveRetry(fn, {
  maxAttempts = MAX_DRIVE_ATTEMPTS,
  sleeper = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryableDriveError(err) || attempt >= maxAttempts) throw err;
      const delay = Math.min(4000, 400 * 2 ** (attempt - 1));
      if (onRetry) onRetry({ attempt, maxAttempts, delay, err });
      await sleeper(delay);
    }
  }
  throw lastErr;
}

function _ids(rows, key = 'id') {
  return new Set((rows || []).map((r) => r && r[key]).filter((v) => v != null && String(v).length > 0));
}

/**
 * Drop rows the user already deleted/unsaved so a Drive overwrite cannot
 * resurrect them. Tombstone tables stay (they are the delete log).
 */
function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const tables = { ...(snapshot.tables || {}) };
  const deadWords = _ids(tables.deleted_saved_words);
  tables.saved_words = (tables.saved_words || []).filter((r) => r && r.id && !deadWords.has(r.id));

  const deadSearches = _ids(tables.deleted_saved_searches);
  tables.saved_searches = (tables.saved_searches || []).filter((r) => r && r.id && !deadSearches.has(r.id));
  tables.saved_search_chat_messages = (tables.saved_search_chat_messages || []).filter(
    (r) => r && r.search_id && !deadSearches.has(r.search_id),
  );
  tables.saved_search_chat_summaries = (tables.saved_search_chat_summaries || []).filter(
    (r) => r && r.search_id && !deadSearches.has(r.search_id),
  );

  tables.news_articles = (tables.news_articles || []).filter((r) => r && r.id && r.saved === true);
  const savedIds = _ids(tables.news_articles);
  tables.article_chat_messages = (tables.article_chat_messages || []).filter(
    (r) => r && savedIds.has(r.article_id),
  );
  tables.article_chat_summaries = (tables.article_chat_summaries || []).filter(
    (r) => r && savedIds.has(r.article_id),
  );

  const counts = {};
  for (const spec of TABLES) counts[spec.name] = (tables[spec.name] || []).length;
  return { ...snapshot, tables, counts };
}

async function _selectTable(pool, spec) {
  const sql = spec.where
    ? `SELECT * FROM ${quoteIdent(spec.name)} WHERE ${spec.where}`
    : `SELECT * FROM ${quoteIdent(spec.name)}`;
  try {
    const { rows } = await pool.query(sql);
    return (rows || []).map(jsonSafe);
  } catch (err) {
    if (err && (err.code === '42P01' || /does not exist/i.test(err.message || ''))) {
      return [];
    }
    throw err;
  }
}

async function buildSnapshot(pool) {
  const entries = await Promise.all(
    TABLES.map(async (spec) => [spec.name, await _selectTable(pool, spec)]),
  );
  const tables = Object.fromEntries(entries);
  const snapshot = sanitizeSnapshot({
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    tables,
  });
  return snapshot;
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

async function _deleteNotIn(client, table, pkCol, keepIds) {
  if (!keepIds.length) {
    await client.query(`DELETE FROM ${quoteIdent(table)}`);
    return;
  }
  await client.query(
    `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pkCol)} <> ALL($1::text[])`,
    [keepIds],
  );
}

async function applySnapshot(pool, snapshot) {
  if (!isValidSnapshot(snapshot)) {
    throw new Error('Invalid backup snapshot (kind/schemaVersion)');
  }
  const original = snapshot.tables || {};
  const clean = sanitizeSnapshot(snapshot);
  const client = await pool.connect();
  const applied = {};
  try {
    await client.query('BEGIN');
    for (const spec of TABLES) {
      if (spec.name.startsWith('deleted_')) continue;
      applied[spec.name] = await _upsertRows(client, spec, clean.tables[spec.name]);
    }
    applied.deleted_expenses = await _applyTombstones(
      client, 'expenses', 'deleted_expenses', clean.tables.deleted_expenses,
    );
    applied.deleted_saved_words = await _applyTombstones(
      client, 'saved_words', 'deleted_saved_words', clean.tables.deleted_saved_words,
    );
    applied.deleted_saved_searches = await _applyTombstones(
      client, 'saved_searches', 'deleted_saved_searches', clean.tables.deleted_saved_searches,
    );

    // Snapshot is canonical for user collections: anything deleted after the
    // previous Drive file, then overwritten, must not come back on restore.
    // Only prune tables that were actually present in the file so a partial
    // snapshot cannot wipe unrelated collections.
    if (Array.isArray(original.saved_words)) {
      await _deleteNotIn(client, 'saved_words', 'id', [..._ids(clean.tables.saved_words)]);
    }
    if (Array.isArray(original.saved_searches)) {
      const keep = [..._ids(clean.tables.saved_searches)];
      await _deleteNotIn(client, 'saved_search_chat_messages', 'search_id', keep);
      await _deleteNotIn(client, 'saved_search_chat_summaries', 'search_id', keep);
      await _deleteNotIn(client, 'saved_searches', 'id', keep);
    }
    if (Array.isArray(original.news_articles)) {
      const keep = [..._ids(clean.tables.news_articles)];
      if (!keep.length) {
        await client.query(`UPDATE news_articles SET saved = FALSE WHERE saved = TRUE`);
      } else {
        await client.query(
          `UPDATE news_articles SET saved = FALSE WHERE saved = TRUE AND id <> ALL($1::text[])`,
          [keep],
        );
      }
    }

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
    dirty,
  };
}

function _intervalMs() {
  const n = Number(process.env.BACKUP_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  return DEFAULT_INTERVAL_MS;
}

function _countLine(counts) {
  return (
    `expenses=${counts.expenses || 0} ` +
    `savedArticles=${counts.news_articles || 0} ` +
    `savedWords=${counts.saved_words || 0} ` +
    `savedSearches=${counts.saved_searches || 0}`
  );
}

async function _runOnce(pool, { reason, drive, sleeper }) {
  const t0 = Date.now();
  tg.i('Backup', `▶ ${reason} snapshot starting`, { immediate: true });
  const snapshot = await buildSnapshot(pool);
  const json = Buffer.from(JSON.stringify(snapshot), 'utf8');
  tg.d('Backup', `snapshot ${json.length}B ${_countLine(snapshot.counts)} ${Date.now() - t0}ms`);

  const uploaded = await withDriveRetry(
    () => drive.upsertBackupFile(json, { mimeType: 'application/json' }),
    {
      sleeper,
      onRetry: ({ attempt, maxAttempts, delay, err }) => {
        const why = (err && err.message) ? String(err.message).slice(0, 80) : 'transient';
        tg.w('Backup', `↻ Drive retry ${attempt}/${maxAttempts} in ${delay}ms (${why})`);
      },
    },
  );

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
  const line =
    `✓ ${reason}: ${json.length}B overwritten=${lastResult.overwritten} ` +
    `${_countLine(snapshot.counts)} ${lastResult.elapsedMs}ms`;
  console.log(`[BACKUP] ${line}`);
  tg.i('Backup', line, { immediate: true });
  return lastResult;
}

function runBackup(pool, {
  reason = 'manual',
  drive = cloudService,
  sleeper,
} = {}) {
  if (!drive.isDriveAvailable()) {
    lastError = 'Google Drive is not configured';
    lastResult = { success: false, reason, error: lastError };
    tg.w('Backup', `skipped ${reason}: Drive is not configured`);
    return Promise.resolve(lastResult);
  }
  if (activePromise) {
    dirty = true;
    tg.d('Backup', `coalesce ${reason} into in-flight run`);
    return activePromise;
  }

  activePromise = (async () => {
    let chained = 0;
    let result;
    do {
      dirty = false;
      result = await _runOnce(pool, { reason: chained ? `${reason}+catchup` : reason, drive, sleeper });
      chained += 1;
    } while (dirty && chained < MAX_CHAINED_RUNS);
    if (dirty) {
      tg.w('Backup', 'catchup cap reached — next scheduled run will pick up remaining deletes');
      dirty = false;
    }
    return result;
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

/**
 * Coalesce bursts of deletes/saves into one Drive overwrite so the rolling
 * file drops removed articles/words within seconds, not at the 6h tick.
 */
function scheduleBackupSoon(pool, {
  reason = 'mutation',
  drive = cloudService,
  delayMs = DEFAULT_MUTATION_DELAY_MS,
} = {}) {
  if (!drive.isDriveAvailable || !drive.isDriveAvailable()) return false;
  if (debounceHandle) clearTimeout(debounceHandle);
  const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : DEFAULT_MUTATION_DELAY_MS;
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    runBackup(pool, { reason, drive }).catch(() => {});
  }, delay);
  if (typeof debounceHandle.unref === 'function') debounceHandle.unref();
  return true;
}

async function restoreFromDrive(pool, { drive = cloudService, sleeper } = {}) {
  if (!drive.isDriveAvailable()) {
    throw new Error('Google Drive is not configured');
  }
  const found = await withDriveRetry(() => drive.findBackupFile(), { sleeper });
  if (!found || !found.file) {
    throw new Error('No nexus-backup.json found in AI Nexus Backups');
  }
  const stream = await withDriveRetry(() => drive.downloadStream(found.file.id), { sleeper });
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
  tg.i('Backup', `Restore applied file=${found.file.name} ${_countLine(snapshot.counts || {})}`, { immediate: true });
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
    tg.w('Backup', 'Scheduler skipped — Google Drive is not configured');
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
  tg.i('Backup', `scheduler on folder="${cloudService.BACKUP_FOLDER_NAME}" file="${cloudService.BACKUP_FILE_NAME}" every ${Math.round(interval / 60000)}min`);
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
  if (debounceHandle) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
}

function _resetForTests() {
  stopScheduler();
  activePromise = null;
  dirty = false;
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
  isRetryableDriveError,
  withDriveRetry,
  sanitizeSnapshot,
  buildSnapshot,
  applySnapshot,
  upsertSql,
  runBackup,
  scheduleBackupSoon,
  restoreFromDrive,
  getState,
  startScheduler,
  stopScheduler,
  _resetForTests,
};
