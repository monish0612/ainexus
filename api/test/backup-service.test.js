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
  test('TABLES includes the rolling profile photo', () => {
    assert.ok(backup.TABLES.some((t) => t.name === 'profile_photo' && t.pk[0] === 'id'));
  });

  test('jsonSafe turns Dates into ISO strings and leaves the rest', () => {
    const d = new Date('2026-08-21T05:00:00.000Z');
    assert.equal(backup.jsonSafe(d), '2026-08-21T05:00:00.000Z');
    assert.deepEqual(
      backup.jsonSafe({ n: 1, when: d, nested: { t: d } }),
      { n: 1, when: '2026-08-21T05:00:00.000Z', nested: { t: '2026-08-21T05:00:00.000Z' } },
    );
    assert.equal(backup.jsonSafe(null), null);
    assert.equal(backup.jsonSafe(Buffer.from('hi')), Buffer.from('hi').toString('base64'));
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
    assert.ok(Object.prototype.hasOwnProperty.call(snap.counts, 'profile_photo'));
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
        chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
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
    const parsed = JSON.parse(chunks[0].toString('utf8'));
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

  test('unwraps googleapis { data: stream } download responses', async () => {
    const snapshot = {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { expenses: [{ id: 'e4', amount: 3 }] },
    };
    const log = [];
    const client = {
      async query(sql) { log.push(sql); return { rows: [] }; },
      release() {},
    };
    const drive = {
      isDriveAvailable: () => true,
      async findBackupFile() {
        return { folder: { id: 'f' }, file: { id: 'file-1', name: 'nexus-backup.json' } };
      },
      async downloadStream() {
        return { data: Readable.from([Buffer.from(JSON.stringify(snapshot), 'utf8')]) };
      },
    };
    const out = await backup.restoreFromDrive({ connect: async () => client }, { drive });
    assert.equal(out.success, true);
    assert.ok(log.some((sql) => sql.includes('INSERT INTO "expenses"')));
  });

  test('rejects invalid JSON without applying', async () => {
    const drive = {
      isDriveAvailable: () => true,
      async findBackupFile() {
        return { folder: { id: 'f' }, file: { id: 'file-1', name: 'nexus-backup.json' } };
      },
      async downloadStream() {
        return Readable.from([Buffer.from('{not json', 'utf8')]);
      },
    };
    await assert.rejects(
      () => backup.restoreFromDrive({ connect: async () => { throw new Error('should not connect'); } }, { drive }),
      /not valid JSON/,
    );
  });

  test('retries a transient findBackupFile failure', async () => {
    const snapshot = {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { expenses: [{ id: 'e3', amount: 2 }] },
    };
    let finds = 0;
    const log = [];
    const client = {
      async query(sql) { log.push(sql); return { rows: [] }; },
      release() {},
    };
    const drive = {
      isDriveAvailable: () => true,
      async findBackupFile() {
        finds += 1;
        if (finds < 2) {
          const err = new Error('502');
          err.status = 502;
          throw err;
        }
        return { folder: { id: 'f' }, file: { id: 'file-1', name: 'nexus-backup.json' } };
      },
      async downloadStream() {
        return Readable.from([Buffer.from(JSON.stringify(snapshot), 'utf8')]);
      },
    };
    const out = await backup.restoreFromDrive({ connect: async () => client }, { drive, sleeper: async () => {} });
    assert.equal(out.success, true);
    assert.equal(finds, 2);
    assert.ok(log.some((sql) => sql.includes('INSERT INTO "expenses"')));
  });

  test('rejects when the rolling file is missing', async () => {
    const drive = {
      isDriveAvailable: () => true,
      async findBackupFile() {
        return { folder: { id: 'f' }, file: null };
      },
    };
    await assert.rejects(
      () => backup.restoreFromDrive({ connect: async () => ({}) }, { drive }),
      /No nexus-backup/,
    );
  });
});

describe('sanitizeSnapshot deletes stay out of the Drive file', () => {
  test('drops tombstoned words, searches, and unsaved articles plus their chats', () => {
    const snap = backup.sanitizeSnapshot({
      kind: backup.KIND,
      schemaVersion: 1,
      tables: {
        saved_words: [{ id: 'keep' }, { id: 'gone' }, { id: '' }],
        deleted_saved_words: [{ id: 'gone' }],
        saved_searches: [{ id: 's-keep' }, { id: 's-gone' }],
        saved_search_chat_messages: [
          { id: 'm1', search_id: 's-keep' },
          { id: 'm2', search_id: 's-gone' },
        ],
        saved_search_chat_summaries: [
          { search_id: 's-keep' },
          { search_id: 's-gone' },
        ],
        deleted_saved_searches: [{ id: 's-gone' }],
        news_articles: [
          { id: 'a1', saved: true, title: 'keep' },
          { id: 'a2', saved: false, title: 'unsaved' },
          { id: 'a3', saved: true, title: 'also' },
        ],
        article_chat_messages: [
          { id: 'c1', article_id: 'a1' },
          { id: 'c2', article_id: 'a2' },
        ],
        article_chat_summaries: [
          { article_id: 'a1' },
          { article_id: 'a2' },
        ],
      },
    });
    assert.deepEqual(snap.tables.saved_words.map((r) => r.id), ['keep']);
    assert.deepEqual(snap.tables.saved_searches.map((r) => r.id), ['s-keep']);
    assert.deepEqual(snap.tables.saved_search_chat_messages.map((r) => r.id), ['m1']);
    assert.deepEqual(snap.tables.saved_search_chat_summaries.map((r) => r.search_id), ['s-keep']);
    assert.deepEqual(snap.tables.news_articles.map((r) => r.id), ['a1', 'a3']);
    assert.deepEqual(snap.tables.article_chat_messages.map((r) => r.id), ['c1']);
    assert.equal(snap.counts.saved_words, 1);
    assert.equal(snap.counts.news_articles, 2);
    assert.equal(snap.tables.deleted_saved_words.length, 1, 'tombstones stay in the file');
  });
});

describe('buildSnapshot edge cases', () => {
  test('missing tables become empty instead of failing the whole backup', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('"expenses"')) {
          const err = new Error('relation "expenses" does not exist');
          err.code = '42P01';
          throw err;
        }
        return { rows: [] };
      },
    };
    const snap = await backup.buildSnapshot(pool);
    assert.deepEqual(snap.tables.expenses, []);
    assert.equal(snap.counts.expenses, 0);
  });

  test('delete-then-snapshot omits the removed word and article', async () => {
    let words = [{ id: 'w1', word: 'keep' }, { id: 'w2', word: 'drop' }];
    let deletedWords = [];
    let articles = [
      { id: 'a1', saved: true, title: 'keep' },
      { id: 'a2', saved: true, title: 'drop' },
    ];
    const pool = {
      async query(sql) {
        if (sql.includes('"deleted_saved_words"')) return { rows: deletedWords };
        if (sql.includes('"saved_words"')) return { rows: words };
        if (sql.includes('"news_articles"')) return { rows: articles };
        return { rows: [] };
      },
    };
    const before = await backup.buildSnapshot(pool);
    assert.deepEqual(before.tables.saved_words.map((r) => r.id).sort(), ['w1', 'w2']);
    assert.deepEqual(before.tables.news_articles.map((r) => r.id).sort(), ['a1', 'a2']);

    words = [{ id: 'w1', word: 'keep' }];
    deletedWords = [{ id: 'w2' }];
    articles = [{ id: 'a1', saved: true, title: 'keep' }];
    const after = await backup.buildSnapshot(pool);
    assert.deepEqual(after.tables.saved_words.map((r) => r.id), ['w1']);
    assert.deepEqual(after.tables.deleted_saved_words.map((r) => r.id), ['w2']);
    assert.deepEqual(after.tables.news_articles.map((r) => r.id), ['a1']);
  });

  test('jsonSafe serializes bigint', () => {
    assert.equal(backup.jsonSafe(10n), '10');
  });
});

describe('Drive retry', () => {
  test('classifies transient Drive failures', () => {
    assert.equal(backup.isRetryableDriveError({ status: 429 }), true);
    assert.equal(backup.isRetryableDriveError({ status: 503 }), true);
    assert.equal(backup.isRetryableDriveError({ code: 'ECONNRESET' }), true);
    assert.equal(backup.isRetryableDriveError({ message: 'userRateLimitExceeded' }), true);
    assert.equal(backup.isRetryableDriveError({ status: 400, message: 'bad' }), false);
    assert.equal(backup.isRetryableDriveError({ status: 404 }), false);
    assert.equal(backup.isRetryableDriveError(null), false);
  });

  test('retries 429 then succeeds, with exponential backoff', async () => {
    let n = 0;
    const delays = [];
    const retries = [];
    const err = Object.assign(new Error('429 rate limit'), { status: 429 });
    const out = await backup.withDriveRetry(
      async () => {
        n += 1;
        if (n < 3) throw err;
        return 'ok';
      },
      {
        sleeper: async (ms) => { delays.push(ms); },
        onRetry: (info) => retries.push(info.attempt),
      },
    );
    assert.equal(out, 'ok');
    assert.equal(n, 3);
    assert.deepEqual(delays, [400, 800]);
    assert.deepEqual(retries, [1, 2]);
  });

  test('does not retry a 400', async () => {
    let n = 0;
    const err = Object.assign(new Error('bad request'), { status: 400 });
    await assert.rejects(
      () => backup.withDriveRetry(async () => {
        n += 1;
        throw err;
      }, { sleeper: async () => {} }),
      /bad request/,
    );
    assert.equal(n, 1);
  });

  test('runBackup retries a 503 upsert then uploads a Buffer', async () => {
    backup._resetForTests();
    let n = 0;
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile(body) {
        n += 1;
        assert.equal(Buffer.isBuffer(body), true);
        if (n < 2) {
          const err = new Error('backendError');
          err.status = 503;
          throw err;
        }
        return {
          overwritten: true,
          folder: { name: 'AI Nexus Backups' },
          file: { name: 'nexus-backup.json' },
        };
      },
    };
    const result = await backup.runBackup(
      { async query() { return { rows: [] }; } },
      { reason: 'test', drive, sleeper: async () => {} },
    );
    assert.equal(result.success, true);
    assert.equal(n, 2);
  });

  test('runBackup reports failure without throwing after retries are exhausted', async () => {
    backup._resetForTests();
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile() {
        const err = new Error('503');
        err.status = 503;
        throw err;
      },
    };
    const result = await backup.runBackup(
      { async query() { return { rows: [] }; } },
      { reason: 'test', drive, sleeper: async () => {} },
    );
    assert.equal(result.success, false);
    assert.match(result.error, /503/);
  });
});

describe('catchup after delete during backup', () => {
  test('second overwrite omits the word deleted mid-upload', async () => {
    backup._resetForTests();
    let words = [{ id: 'keep' }, { id: 'gone' }];
    const bodies = [];
    const pool = {
      async query(sql) {
        if (sql.includes('"deleted_saved_words"')) return { rows: [] };
        if (sql.includes('"saved_words"')) return { rows: words };
        return { rows: [] };
      },
    };
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile(body) {
        bodies.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
        if (bodies.length === 1) {
          words = [{ id: 'keep' }];
          backup.runBackup(pool, { reason: 'saved-word-delete', drive, sleeper: async () => {} });
        }
        return {
          overwritten: bodies.length > 1,
          folder: { name: 'AI Nexus Backups' },
          file: { name: 'nexus-backup.json' },
        };
      },
    };
    const result = await backup.runBackup(pool, { reason: 'startup', drive, sleeper: async () => {} });
    assert.equal(result.success, true);
    assert.equal(bodies.length, 2);
    const first = JSON.parse(bodies[0].toString('utf8')).tables.saved_words.map((r) => r.id);
    const second = JSON.parse(bodies[1].toString('utf8')).tables.saved_words.map((r) => r.id);
    assert.deepEqual(first, ['keep', 'gone']);
    assert.deepEqual(second, ['keep']);
  });

  test('overlapping runBackup shares one in-flight promise', async () => {
    backup._resetForTests();
    let entered = 0;
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile() {
        entered += 1;
        await new Promise((r) => setTimeout(r, 25));
        return {
          overwritten: false,
          folder: { name: 'AI Nexus Backups' },
          file: { name: 'nexus-backup.json' },
        };
      },
    };
    const pool = { async query() { return { rows: [] }; } };
    const p1 = backup.runBackup(pool, { reason: 'a', drive, sleeper: async () => {} });
    const p2 = backup.runBackup(pool, { reason: 'b', drive, sleeper: async () => {} });
    assert.equal(p1, p2);
    await p1;
    assert.ok(entered >= 1);
    backup._resetForTests();
  });
});

describe('scheduleBackupSoon', () => {
  test('coalesces a burst of deletes into one Drive overwrite', async () => {
    backup._resetForTests();
    let n = 0;
    const drive = {
      isDriveAvailable: () => true,
      async upsertBackupFile() {
        n += 1;
        return {
          overwritten: true,
          folder: { name: 'AI Nexus Backups' },
          file: { name: 'nexus-backup.json' },
        };
      },
    };
    const pool = { async query() { return { rows: [] }; } };
    assert.equal(backup.scheduleBackupSoon(pool, { reason: 'a', drive, delayMs: 15 }), true);
    assert.equal(backup.scheduleBackupSoon(pool, { reason: 'b', drive, delayMs: 15 }), true);
    assert.equal(backup.scheduleBackupSoon(pool, { reason: 'c', drive, delayMs: 15 }), true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(n, 1);
    backup._resetForTests();
  });

  test('no-ops when Drive is not configured', () => {
    backup._resetForTests();
    const scheduled = backup.scheduleBackupSoon(
      { async query() { return { rows: [] }; } },
      { drive: { isDriveAvailable: () => false }, delayMs: 0 },
    );
    assert.equal(scheduled, false);
  });
});

describe('applySnapshot prune', () => {
  test('deletes saved words that are no longer in the snapshot', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: {
        saved_words: [{ id: 'keep', word: 'alpha' }],
        deleted_saved_words: [{ id: 'gone' }],
      },
    });
    const prune = log.find((q) => q.sql.includes('DELETE FROM "saved_words"') && q.sql.includes('<> ALL'));
    assert.ok(prune);
    assert.deepEqual(prune.params[0], ['keep']);
    const tomb = log.find((q) => q.sql.includes('DELETE FROM "saved_words"') && q.sql.includes('= $1'));
    assert.ok(tomb);
    assert.equal(tomb.params[0], 'gone');
  });

  test('unsaves articles that were dropped from the snapshot', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: {
        news_articles: [{ id: 'keep', saved: true, title: 'still' }],
      },
    });
    const unsave = log.find((q) => q.sql.includes('UPDATE news_articles SET saved = FALSE'));
    assert.ok(unsave);
    assert.deepEqual(unsave.params[0], ['keep']);
  });

  test('does not wipe collections omitted from a partial snapshot', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { expenses: [{ id: 'e1', amount: 1 }] },
    });
    assert.equal(log.some((q) => q.sql === 'DELETE FROM "saved_words"'), false);
    assert.equal(log.some((q) => q.sql.includes('UPDATE news_articles')), false);
    assert.equal(log.some((q) => q.sql.includes('DELETE FROM "profile_photo"')), false);
  });

  test('empty saved_words array wipes the live table', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { saved_words: [] },
    });
    assert.ok(log.some((q) => q.sql === 'DELETE FROM "saved_words"'));
  });

  test('empty profile_photo array wipes the live photo; omitted key does not', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { profile_photo: [] },
    });
    assert.ok(log.some((q) => q.sql === 'DELETE FROM "profile_photo"'));
  });

  test('skips rows with missing primary keys', async () => {
    const log = [];
    const client = {
      async query(sql, params) { log.push({ sql, params }); return { rows: [] }; },
      release() {},
    };
    const applied = await backup.applySnapshot({ connect: async () => client }, {
      kind: backup.KIND,
      schemaVersion: 1,
      tables: { expenses: [{ amount: 9, description: 'no id' }, { id: 'ok', amount: 1 }] },
    });
    assert.equal(applied.expenses, 1);
  });
});

describe('applySnapshot failures', () => {
  test('rolls back when an upsert fails', async () => {
    const log = [];
    const client = {
      async query(sql) {
        log.push(sql);
        if (sql.includes('INSERT INTO "expenses"')) throw new Error('boom');
        return { rows: [] };
      },
      release() { log.push('RELEASE'); },
    };
    await assert.rejects(
      () => backup.applySnapshot({ connect: async () => client }, {
        kind: backup.KIND,
        schemaVersion: 1,
        tables: { expenses: [{ id: 'e1', amount: 1 }] },
      }),
      /boom/,
    );
    assert.ok(log.includes('BEGIN'));
    assert.ok(log.includes('ROLLBACK'));
    assert.ok(log.includes('RELEASE'));
    assert.equal(log.includes('COMMIT'), false);
  });
});
