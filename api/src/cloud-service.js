// ─────────────────────────────────────────────────────────────────────────────
//  Google Drive proxy — server-side mirror of the Flutter GoogleDriveService.
//
//  The Android app talks to Drive directly with a service account; a browser
//  can't safely hold that secret, so the web app calls this proxy instead. It
//  uses the SAME service account (env GOOGLE_DRIVE_SA_JSON) and the SAME folder
//  as the app, so files are shared across the app and the website.
//
//  Additive: nothing in the existing API or the Android app touches this.
// ─────────────────────────────────────────────────────────────────────────────
const { google } = require('googleapis');
const { tg } = require('./telegram');

const FOLDER_ID =
  process.env.GOOGLE_DRIVE_FOLDER_ID || '1ybi-QMnDHDSFLXiRQjFacrJ7uLGmFX13';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,starred,thumbnailLink';

let _auth = null;
let _drive = null;

function _readCredentials() {
  let raw = process.env.GOOGLE_DRIVE_SA_JSON;
  if (!raw || !raw.trim()) return null;
  raw = raw.trim();
  // Allow either a raw JSON string or a base64-encoded JSON blob (handy for
  // env systems that mangle newlines in the private key).
  if (!raw.startsWith('{')) {
    try {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    tg.e('Cloud', `GOOGLE_DRIVE_SA_JSON is not valid JSON: ${e.message}`);
    return null;
  }
}

function isDriveAvailable() {
  return _readCredentials() != null;
}

async function _getAuth() {
  if (_auth) return _auth;
  const credentials = _readCredentials();
  if (!credentials) {
    throw new Error('Google Drive service account is not configured (GOOGLE_DRIVE_SA_JSON).');
  }
  _auth = new google.auth.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  return _auth;
}

async function _getDrive() {
  if (_drive) return _drive;
  const auth = await _getAuth();
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

function _extOf(name) {
  const dot = (name || '').lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const _IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);

function mapFile(f) {
  const ext = _extOf(f.name);
  const mimeType = f.mimeType || 'application/octet-stream';
  return {
    id: f.id,
    name: f.name || 'Unnamed',
    mimeType,
    size: Number(f.size || 0),
    ext,
    createdTime: f.createdTime || null,
    modifiedTime: f.modifiedTime || null,
    starred: !!f.starred,
    thumbnailLink: f.thumbnailLink || null,
    isImage: mimeType.startsWith('image/') || _IMAGE_EXT.has(ext),
  };
}

async function listFiles({ pageToken, pageSize = 50, q } = {}) {
  const drive = await _getDrive();
  let query = `'${FOLDER_ID}' in parents and trashed = false`;
  if (q && String(q).trim()) {
    const escaped = String(q).replace(/'/g, "\\'");
    query += ` and (name contains '${escaped}' or fullText contains '${escaped}')`;
  }
  const { data } = await drive.files.list({
    q: query,
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    orderBy: 'modifiedTime desc',
    pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
    pageToken: pageToken || undefined,
  });
  return {
    files: (data.files || []).map(mapFile),
    nextPageToken: data.nextPageToken || null,
  };
}

async function getQuota() {
  const drive = await _getDrive();
  const { data } = await drive.about.get({ fields: 'storageQuota' });
  const q = data.storageQuota || {};
  return {
    usageBytes: Number(q.usage || 0),
    limitBytes: Number(q.limit || 16106127360),
  };
}

async function getFileMeta(fileId) {
  const drive = await _getDrive();
  const { data } = await drive.files.get({ fileId, fields: FILE_FIELDS });
  return mapFile(data);
}

/** Stream-upload a file. `body` is a Node Readable (no buffering). */
async function uploadStream({ name, mimeType, body }) {
  const drive = await _getDrive();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [FOLDER_ID] },
    media: { mimeType: mimeType || 'application/octet-stream', body },
    fields: FILE_FIELDS,
  });
  tg.i('Cloud', `Uploaded ${name} → ${data.id}`);
  return mapFile(data);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Resumable upload (chunked) — for large files / unreliable networks.
//
//  Drive's resumable protocol: create a session (returns a capability URI),
//  then PUT byte-ranges to it. A 308 means "resume incomplete" (more bytes
//  expected); 200/201 means the upload finished and the body is the file meta.
//  Chunks are proxied through our backend so the browser only ever talks to
//  our own origin (office-firewall friendly, no Google host allow-listing).
// ─────────────────────────────────────────────────────────────────────────────

const _RESUMABLE_START_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' +
  encodeURIComponent(FILE_FIELDS);

async function _accessToken() {
  const auth = await _getAuth();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Drive access token');
  return token;
}

// Drive replies with e.g. `Range: bytes=0-262143`; the next offset is end + 1.
// When no Range header is present, nothing has been committed yet → offset 0.
function _nextOffsetFromRange(rangeHeader) {
  if (!rangeHeader) return 0;
  const m = /bytes=\d+-(\d+)/.exec(rangeHeader);
  return m ? Number(m[1]) + 1 : 0;
}

/** Create a resumable session and return its session URI. */
async function startResumableSession({ name, mimeType }) {
  const token = await _accessToken();
  const res = await fetch(_RESUMABLE_START_URL, {
    method: 'POST',
    redirect: 'manual', // never auto-follow Drive's 3xx control responses
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
    },
    body: JSON.stringify({ name, parents: [FOLDER_ID] }),
  });
  if (res.status < 200 || res.status >= 300) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Resumable session start failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  const sessionUri = res.headers.get('location');
  if (!sessionUri) throw new Error('Resumable session URI missing from Drive response');
  return sessionUri;
}

/**
 * Upload one chunk to a resumable session.
 *   chunk : Buffer  start : byte offset of this chunk  total : full file size
 * Returns { done:false, received } while more bytes are expected, or
 *         { done:true, file } once Drive finalises the upload.
 */
async function uploadResumableChunk({ sessionUri, chunk, start, total }) {
  const len = chunk.length;
  const end = start + len - 1;
  const res = await fetch(sessionUri, {
    method: 'PUT',
    redirect: 'manual',
    headers: {
      'Content-Length': String(len),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
    body: chunk,
  });
  if (res.status === 308) {
    const received = _nextOffsetFromRange(res.headers.get('range'));
    return { done: false, received: received || start + len };
  }
  if (res.status === 200 || res.status === 201) {
    const data = await res.json();
    return { done: true, file: mapFile(data) };
  }
  const txt = await res.text().catch(() => '');
  throw new Error(`Chunk upload failed (${res.status}): ${txt.slice(0, 300)}`);
}

/** Ask Drive how many bytes it has already committed (used to resume). */
async function queryResumableOffset({ sessionUri, total }) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    redirect: 'manual',
    headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' },
  });
  if (res.status === 308) {
    return { done: false, received: _nextOffsetFromRange(res.headers.get('range')) };
  }
  if (res.status === 200 || res.status === 201) {
    const data = await res.json().catch(() => null);
    return { done: true, received: total, file: data ? mapFile(data) : null };
  }
  const txt = await res.text().catch(() => '');
  throw new Error(`Resumable status query failed (${res.status}): ${txt.slice(0, 200)}`);
}

/** Returns an axios-style { data: Readable } stream of the file bytes. */
async function downloadStream(fileId) {
  const drive = await _getDrive();
  return drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
}

async function deleteFile(fileId) {
  const drive = await _getDrive();
  await drive.files.delete({ fileId });
  tg.i('Cloud', `Deleted ${fileId}`);
}

async function setStar(fileId, starred) {
  const drive = await _getDrive();
  const { data } = await drive.files.update({
    fileId,
    requestBody: { starred: !!starred },
    fields: FILE_FIELDS,
  });
  return mapFile(data);
}

/** Fetch an authenticated thumbnail (resized) and return { buffer, contentType }. */
async function fetchThumbnail(fileId, size = 320) {
  const meta = await getFileMeta(fileId);
  if (!meta.thumbnailLink) return null;
  const auth = await _getAuth();
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
  const url = meta.thumbnailLink.replace(/=s\d+/, '') + `=s${size}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get('content-type') || 'image/jpeg' };
}

module.exports = {
  FOLDER_ID,
  isDriveAvailable,
  listFiles,
  getQuota,
  getFileMeta,
  uploadStream,
  startResumableSession,
  uploadResumableChunk,
  queryResumableOffset,
  downloadStream,
  deleteFile,
  setStar,
  fetchThumbnail,
};
