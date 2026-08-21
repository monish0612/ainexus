const { test } = require('node:test');
const assert = require('node:assert');

// Ensure no SA creds are present for the availability test.
delete process.env.GOOGLE_DRIVE_SA_JSON;

const cloud = require('../src/cloud-service');

test('cloud-service exposes the expected proxy API', () => {
  for (const fn of [
    'isDriveAvailable',
    'getAccessToken',
    'listFiles',
    'getQuota',
    'getFileMeta',
    'uploadStream',
    'downloadStream',
    'deleteFile',
    'setStar',
    'fetchThumbnail',
    'ensureBackupFolder',
    'upsertBackupFile',
    'findBackupFile',
  ]) {
    assert.strictEqual(typeof cloud[fn], 'function', `${fn} should be a function`);
  }
});

test('isDriveAvailable is false without credentials', () => {
  assert.strictEqual(cloud.isDriveAvailable(), false);
});

test('isDriveAvailable parses a raw JSON service account', () => {
  process.env.GOOGLE_DRIVE_SA_JSON = JSON.stringify({
    type: 'service_account',
    client_email: 'x@y.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n',
  });
  assert.strictEqual(cloud.isDriveAvailable(), true);
  delete process.env.GOOGLE_DRIVE_SA_JSON;
});

test('isDriveAvailable parses a base64-encoded service account', () => {
  const json = JSON.stringify({ type: 'service_account', client_email: 'a@b.com' });
  process.env.GOOGLE_DRIVE_SA_JSON = Buffer.from(json, 'utf8').toString('base64');
  assert.strictEqual(cloud.isDriveAvailable(), true);
  delete process.env.GOOGLE_DRIVE_SA_JSON;
});

test('listFiles rejects clearly when Drive is not configured', async () => {
  await assert.rejects(() => cloud.listFiles({}), /not configured/i);
});

test('getAccessToken rejects clearly when Drive is not configured', async () => {
  delete process.env.GOOGLE_DRIVE_SA_JSON;
  await assert.rejects(() => cloud.getAccessToken(), /not configured/i);
});

test('default folder id matches the Android app', () => {
  assert.strictEqual(cloud.FOLDER_ID, '1ybi-QMnDHDSFLXiRQjFacrJ7uLGmFX13');
});

test('Cloud file listing excludes Drive folders so the backup folder stays hidden', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/cloud-service.js'), 'utf8');
  assert.match(src, /mimeType != '\$\{FOLDER_MIME\}'/);
  assert.match(src, /BACKUP_FOLDER_NAME = 'AI Nexus Backups'/);
});
