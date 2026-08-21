'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const cloud = require('../src/cloud-service');
const backup = require('../src/backup-service');

describe('Drive backup names', () => {
  test('folder and file names are stable and Drive-safe', () => {
    assert.equal(cloud.BACKUP_FOLDER_NAME, 'AI Nexus Backups');
    assert.equal(cloud.BACKUP_FILE_NAME, 'nexus-backup.json');
    assert.equal(typeof cloud.ensureBackupFolder, 'function');
    assert.equal(typeof cloud.upsertBackupFile, 'function');
    assert.equal(typeof cloud.findBackupFile, 'function');
    // No path separators / control chars — Drive treats these as a single folder + file.
    assert.equal(/[\\/\0]/.test(cloud.BACKUP_FOLDER_NAME), false);
    assert.equal(/[\\/\0]/.test(cloud.BACKUP_FILE_NAME), false);
  });
});

describe('snapshot helpers', () => {
  test('jsonSafe turns Dates into ISO strings and leaves the rest', () => {
    const d = new Date('2026-08-21T05:00:00.000Z');
    assert.equal(backup.jsonSafe(d), '2026-08-21T05:00:00.000Z');
    assert.deepEqual(
      backup.jsonSafe({ n: 1, when: d, nested: { t: d } }),
      { n: 1, when: '2026-08-21T05:00:00.000Z', nested: { t: '2026-08-21T05:00:00.000Z' } },
    );
    assert.equal(backup.jsonSafe(null), null);
  });

  test('isValidSnapshot rejects garbage and wrong kinds', () => {
    assert.equal(backup.isValidSnapshot(null), false);
    assert.equal(backup.isValidSnapshot({ kind: 'nope', schemaVersion: 1, tables: {} }), false);
    assert.equal(backup.isValidSnapshot({ kind: backup.KIND, schemaVersion: 99, tables: {} }), false);
    assert.equal(backup.isValidSnapshot({ kind: backup.KIND, schemaVersion: 1, tables: {} }), true);
  });

  test('upsertSql refuses unknown tables and quotes reserved columns', () => {
    assert.throws(() => backup.upsertSql('users', ['id'], ['id']), /unknown table/);
    const sql = backup.upsertSql('article_chat_messages', ['id', 'text'], ['id']);
    assert.match(sql, /INSERT INTO "article_chat_messages"/);
    assert.match(sql, /"text" = EXCLUDED\."text"/);
    assert.match(sql, /ON CONFLICT \("id"\)/);
  });
});

describe('buildSnapshot', () => {
  test('copies user tables and drops follow-up chats for unsaved news', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('"expenses"')) {
          return { rows: [{ id: 'e1', amount: 40, description: 'tea', updated_at: new Date('2026-08-21T00:00:00Z') }] };
        }
        if (sql.includes('"news_articles"')) {
          return { rows: [{ id: 'saved-1', title: 'Keep me', saved: true }] };
        }
        if (sql.includes('"article_chat_messages"')) {
          return {
            rows: [
              { id: 'm1', article_id: 'saved-1', role: 'user', text: 'hi' },
              { id: 'm2', article_id: 'unsaved-9', role: 'user', text: 'drop' },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const snap = await backup.buildSnapshot(pool);
    assert.equal(snap.kind, backup.KIND);
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.tables.expenses.length, 1);
    assert.equal(snap.tables.expenses[0].updated_at, '2026-08-21T00:00:00.000Z');
    assert.equal(snap.tables.news_articles.length, 1);
    assert.deepEqual(snap.tables.article_chat_messages.map((r) => r.id), ['m1']);
    assert.equal(snap.counts.expenses, 1);
    assert.ok(snap.createdAt);
  });
});

describe('applySnapshot', () => {
  test('upserts live rows then applies expense tombstones', async () => {
    const log = [];
    const client = {
      async query(sql, params) {
        log.push({ sql, params });
        return { rows: [] };
      },
      release() { log.push({ sql: 'RELEASE' }); },
    };
    const pool = { connect: async () => client };
    const applied = await backup.applySnapshot(pool, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: {
        expenses: [{ id: 'e1', amount: 10, description: 'kept' }],
        deleted_expenses: [{ id: 'e-gone', deleted_at: '2026-08-20T00:00:00.000Z' }],
      },
    });
    assert.equal(applied.expenses, 1);
    assert.equal(applied.deleted_expenses, 1);
    assert.equal(log[0].sql, 'BEGIN');
    assert.equal(log[log.length - 2].sql, 'COMMIT');
    assert.equal(log[log.length - 1].sql, 'RELEASE');
    const expenseInsert = log.find((q) => q.sql.includes('INSERT INTO "expenses"'));
    assert.ok(expenseInsert);
    assert.equal(expenseInsert.params[0], 'e1');
    const delLive = log.find((q) => q.sql.includes('DELETE FROM "expenses"'));
    assert.ok(delLive);
    assert.equal(delLive.params[0], 'e-gone');
  });

  test('invalid snapshot does not touch the database', async () => {
    let connected = false;
    const pool = { connect: async () => { connected = true; return {}; } };
    await assert.rejects(
      () => backup.applySnapshot(pool, { kind: 'other', schemaVersion: 1, tables: {} }),
      /Invalid backup snapshot/,
    );
    assert.equal(connected, false);
  });
});

describe('runBackup overwrite', () => {
  test('writes one JSON file and reports overwritten=true', async () => {
    backup._resetForTests();
    const chunks = [];
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile(body) {
        for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        return {
          overwritten: true,
          folder: { id: 'folder-1', name: 'AI Nexus Backups' },
          file: { id: 'file-1', name: 'nexus-backup.json' },
        };
      },
    };
    const pool = { async query() { return { rows: [] }; } };
    const result = await backup.runBackup(pool, { reason: 'test', drive });
    assert.equal(result.success, true);
    assert.equal(result.overwritten, true);
    assert.equal(result.fileName, 'nexus-backup.json');
    assert.equal(result.folderName, 'AI Nexus Backups');
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(parsed.kind, backup.KIND);
    assert.ok(parsed.tables.expenses);
  });

  test('returns a clear failure when Drive is missing, without throwing', async () => {
    backup._resetForTests();
    const result = await backup.runBackup(
      { async query() { return { rows: [] }; } },
      { reason: 'test', drive: { isDriveAvailable: () => false } },
    );
    assert.equal(result.success, false);
    assert.match(result.error, /not configured/i);
  });
});

describe('restoreFromDrive', () => {
  test('reads the rolling file and applies it', async () => {
    const snapshot = {
      kind: backup.KIND,
      schemaVersion: 1,
      createdAt: '2026-08-21T06:00:00.000Z',
      tables: { expenses: [{ id: 'e2', amount: 5, description: 'restored' }] },
    };
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    const drive = {
      isDriveAvailable: () => true,
      async findBackupFile() {
        return { folder: { id: 'f' }, file: { id: 'file-1', name: 'nexus-backup.json' } };
      },
      async downloadStream() {
        return Readable.from([Buffer.from(JSON.stringify(snapshot), 'utf8')]);
      },
    };
    const out = await backup.restoreFromDrive({ connect: async () => client }, { drive });
    assert.equal(out.success, true);
    assert.equal(out.fileName, 'nexus-backup.json');
    assert.ok(log.some((q) => q.sql.includes('INSERT INTO "expenses"')));
  });
});
