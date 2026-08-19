'use strict';

/**
 * Files stored on the home NAS, reachable from the phone through this API.
 *
 * The Cloud tab can point at one of two places. Google Drive is 15 GB and lives at
 * Google's; this is the other one — the `Code` dataset on the TrueNAS box at home, which has
 * 275 GB free and is already exposed over SMB as `\\192.168.8.250\Code`. Uploads land in a
 * `Cloud Storage` folder inside it, so a file put there from the phone is simply *there* on
 * the share afterwards, with no sync step and no second copy.
 *
 * ── how it gets there ────────────────────────────────────────────────────────────
 *
 *   phone ──JWT──▶ this API ──WireGuard──▶ Nextcloud WebDAV ──▶ /mnt/Storage/Code/Cloud Storage
 *
 * Nextcloud is the transport rather than SMB for one reason: it is already there. The `Code`
 * directory is already mounted into Nextcloud as a read-write external storage, Nextcloud
 * already speaks WebDAV, and TCP 30027 is already open on the tunnel for Traefik. So this adds
 * no daemon on the NAS, no firewall rule, and nothing new to keep running. Speaking SMB from a
 * container would have needed all three.
 *
 * The connection is to 10.10.10.2:30027 over the tunnel, but with a `Host:` header of
 * cloud.monishlabs.com. Both parts matter. Going direct over the tunnel avoids hairpinning out
 * to the public IP and back in through Traefik and Caddy for a file that is already on the
 * other end of a private link. The Host header is needed because 10.10.10.2 is not one of
 * Nextcloud's trusted_domains and cloud.monishlabs.com is.
 *
 * ── the credential ───────────────────────────────────────────────────────────────
 *
 * NAS_WEBDAV_PASSWORD is a Nextcloud *app password*, not the account password. An app password
 * can be revoked on its own from Nextcloud's security settings without changing a password
 * shared with SMB, Jellyfin and TrueNAS, and it cannot be used to sign in to the web UI.
 *
 * Unset, everything here degrades to `not_configured` and says so. It never throws at boot and
 * never 500s: an API that refuses to start because an optional file destination has no password
 * would take news, expenses and Drive down with it.
 */

const { tg } = require('./telegram');
const cheerio = require('cheerio');
const crypto = require('crypto');

const DEFAULTS = {
  url: 'http://10.10.10.2:30027',
  host: 'cloud.monishlabs.com',
  user: 'monish',
  root: 'Code/Cloud Storage',
  timeoutMs: 15000,
  // Uploads get their own, much longer budget. A 2 GB film over a home uplink is not a stalled
  // request, and killing it at the timeout used for a directory listing would make large files
  // simply impossible rather than slow.
  uploadTimeoutMs: 30 * 60 * 1000,
  chunkTimeoutMs: 5 * 60 * 1000,
};

/** 8 MiB — same size Drive uses, a multiple of 256 KiB, and short enough that a dropped
 *  chunk is cheap to retry. Nextcloud requires every chunk but the last to be the same size. */
const CHUNK_SIZE = 8 * 1024 * 1024;

/** Below this, a single PUT is fewer round-trips and just as reliable. */
const SIMPLE_THRESHOLD = 5 * 1024 * 1024;

/** Hard ceiling so a mis-tapped 400 GB disk image cannot fill the pool from a phone. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024 * 1024;

function cfg() {
  return {
    url: (process.env.NAS_WEBDAV_URL || DEFAULTS.url).replace(/\/+$/, ''),
    host: process.env.NAS_WEBDAV_HOST || DEFAULTS.host,
    user: process.env.NAS_WEBDAV_USER || DEFAULTS.user,
    password: process.env.NAS_WEBDAV_PASSWORD || '',
    root: (process.env.NAS_WEBDAV_ROOT || DEFAULTS.root).replace(/^\/+|\/+$/g, ''),
    timeoutMs: Number(process.env.NAS_WEBDAV_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    uploadTimeoutMs:
      Number(process.env.NAS_WEBDAV_UPLOAD_TIMEOUT_MS) || DEFAULTS.uploadTimeoutMs,
    chunkTimeoutMs:
      Number(process.env.NAS_WEBDAV_CHUNK_TIMEOUT_MS) || DEFAULTS.chunkTimeoutMs,
  };
}

function isConfigured() {
  return Boolean(cfg().password);
}

// ── state ────────────────────────────────────────────────────────────────────────
// Transition tracking only, for the same reason nas-stats-service.js has it: the Files tab
// refreshes on every open and pull-to-refresh, and a NAS that is switched off would otherwise
// put a message into Telegram every few seconds.
let _wasHealthy = null;
let _rootEnsuredAt = 0;

function _resetForTests() {
  _wasHealthy = null;
  _rootEnsuredAt = 0;
}

function noteHealth(healthy, detail) {
  if (_wasHealthy === healthy) return;
  const first = _wasHealthy === null;
  _wasHealthy = healthy;
  if (first) return;

  if (healthy) {
    tg.i('Cloud/NAS', 'NAS file storage is reachable again; uploads will work.');
  } else if (detail === 'auth') {
    tg.e(
      'Cloud/NAS',
      'Nextcloud rejected the WebDAV app password (401). NAS uploads will fail until '
        + 'NAS_WEBDAV_PASSWORD here matches a valid app password for that account.',
    );
  } else {
    tg.w(
      'Cloud/NAS',
      `NAS file storage is not answering (${detail}); the Cloud tab will show it as `
        + 'unavailable. Google Drive, films and remote access are unaffected.',
    );
  }
}

// ── names ────────────────────────────────────────────────────────────────────────

/**
 * Reduce a client-supplied name to something that cannot escape the folder.
 *
 * This is the security boundary of the whole module. The name arrives from a phone, and it is
 * pasted into a URL path — so `../../../config/config.php` would otherwise be a perfectly good
 * way to read or overwrite Nextcloud's own configuration through an authenticated upload.
 * Separators and dot segments are therefore removed rather than escaped, because there is no
 * legitimate reason for either to appear in a file name typed by a person.
 *
 * Returns null when nothing usable survives, and the caller rejects the request. Silently
 * inventing a name would put the file somewhere the owner did not ask for.
 */
function safeName(raw) {
  if (typeof raw !== 'string') return null;
  // Strip any directory component first, then anything that could reintroduce one.
  let name = raw.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.startsWith('.')) name = `_${name.slice(1)}`;   // no hidden files by accident
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name || null;
}

function encodePath(p) {
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function urlFor(name) {
  const c = cfg();
  const base = `${c.url}/remote.php/dav/files/${encodeURIComponent(c.user)}`;
  const root = encodePath(c.root);
  return name ? `${base}/${root}/${encodeURIComponent(name)}` : `${base}/${root}/`;
}

/**
 * Nextcloud's chunked-upload collection. Separate from the files tree, so a half-sent
 * film cannot appear in the Cloud Storage folder until MOVE commits it.
 */
function uploadsUrl(id, piece) {
  const c = cfg();
  const base = `${c.url}/remote.php/dav/uploads/${encodeURIComponent(c.user)}/${encodeURIComponent(id)}`;
  return piece ? `${base}/${encodeURIComponent(piece)}` : base;
}

function chunkName(index) {
  return String(index).padStart(5, '0');
}

/**
 * Destination for the final MOVE. The public hostname, not 10.0.1.1: Nextcloud compares this
 * against trusted_domains, and the tunnel address is not one of them.
 */
function destHeader(name) {
  const c = cfg();
  return `https://${c.host}/remote.php/dav/files/${encodeURIComponent(c.user)}/${encodePath(c.root)}/${encodeURIComponent(name)}`;
}

function authHeader() {
  const c = cfg();
  return `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}`;
}

function baseHeaders() {
  return { Authorization: authHeader(), Host: cfg().host };
}

// ── requests ─────────────────────────────────────────────────────────────────────

/**
 * One WebDAV request. Never throws; returns a tagged result instead.
 *
 * The reasons are separated because they lead to different sentences on the phone. A refused
 * connection is "the NAS is off", a 401 is "the password here is wrong", and a 507 is "the pool
 * is full" — three different things for the owner to do, and collapsing them into "upload
 * failed" would leave him guessing at which.
 */
async function dav(method, url, { body, headers = {}, timeoutMs, duplex } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };

  const c = cfg();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...baseHeaders(), ...headers },
      body,
      ...(duplex ? { duplex } : {}),
      signal: AbortSignal.timeout(timeoutMs || c.timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'unreachable' };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', res };
  if (res.status === 404) return { ok: false, reason: 'not_found', res };
  if (res.status === 507) return { ok: false, reason: 'insufficient_storage', res };
  if (res.status === 423) return { ok: false, reason: 'locked', res };
  if (!res.ok && res.status !== 207) {
    return { ok: false, reason: 'upstream', status: res.status, res };
  }
  return { ok: true, res };
}

/**
 * Create the destination folder if it is not already there.
 *
 * MKCOL on an existing collection answers 405, which is success for our purposes — the point is
 * that the folder exists afterwards, not that we were the one to make it. Cached for an hour so
 * that a burst of uploads does not send a MKCOL before each one.
 */
async function ensureRoot() {
  if (Date.now() - _rootEnsuredAt < 3600_000) return { ok: true };
  const r = await dav('MKCOL', urlFor(null));
  // 405 = already there. Anything else that is "ok" means we just created it.
  if (r.ok || (r.reason === 'upstream' && r.status === 405)) {
    _rootEnsuredAt = Date.now();
    return { ok: true };
  }
  return r;
}

// ── operations ───────────────────────────────────────────────────────────────────

/**
 * Whether this is usable at all, for the UI to decide if it may offer the NAS as a destination.
 *
 * Deliberately answers the "not configured" case without touching the network: there is nothing
 * to learn from a request we know has no credential, and the phone should get that answer
 * instantly rather than after a connect timeout.
 */
async function status() {
  if (!isConfigured()) {
    return {
      configured: false,
      reachable: false,
      reason: 'not_configured',
      root: cfg().root,
    };
  }

  const r = await dav('PROPFIND', urlFor(null), { headers: { Depth: '0' } });
  const healthy = r.ok || r.reason === 'not_found';
  noteHealth(healthy, r.reason);

  return {
    configured: true,
    // not_found means Nextcloud answered and the folder simply is not there yet, which
    // ensureRoot fixes on first use. That is reachable, not broken.
    reachable: healthy,
    reason: healthy ? null : r.reason,
    root: cfg().root,
  };
}

/** Everything in the folder, newest first. */
async function list() {
  if (!isConfigured()) return { ok: false, reason: 'not_configured', files: [] };

  const r = await dav('PROPFIND', urlFor(null), {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
      + '<d:getcontentlength/><d:getlastmodified/><d:getcontenttype/>'
      + '<d:resourcetype/><d:getetag/></d:prop></d:propfind>',
  });

  // A folder that does not exist yet is empty, not an error. It is created on first upload.
  if (!r.ok && r.reason === 'not_found') {
    noteHealth(true);
    return { ok: true, files: [] };
  }
  if (!r.ok) {
    noteHealth(false, r.reason);
    return { ok: false, reason: r.reason, files: [] };
  }
  noteHealth(true);

  let xml;
  try {
    xml = await r.res.text();
  } catch {
    return { ok: false, reason: 'bad_payload', files: [] };
  }

  try {
    return { ok: true, files: parseListing(xml) };
  } catch (err) {
    tg.e('Cloud/NAS', `could not read the WebDAV listing: ${err.message}`, err);
    return { ok: false, reason: 'bad_payload', files: [] };
  }
}

/**
 * Turn a PROPFIND multistatus into plain file records.
 *
 * Parsed with cheerio in XML mode rather than a regex, and rather than a new dependency:
 * cheerio is already here for news extraction, and a file called `<d:href>` would otherwise be
 * an amusing way to break the listing.
 */
function parseListing(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];

  $('*').each((_, el) => {
    if (localName(el.tagName || el.name) !== 'response') return;
    const $el = $(el);

    const href = decodeURIComponent(text($, $el, 'href'));
    // The first entry of a Depth:1 listing is the collection itself.
    if (!href || href.endsWith('/')) return;
    // resourcetype carrying a <collection/> child means a subfolder.
    if ($el.find('*').filter((_i, c) => localName(c.tagName || c.name) === 'collection').length) {
      return;
    }

    const name = href.split('/').filter(Boolean).pop();
    if (!name) return;

    const sizeRaw = text($, $el, 'getcontentlength');
    const modified = text($, $el, 'getlastmodified');
    out.push({
      name,
      size: sizeRaw ? Number(sizeRaw) : null,
      mimeType: text($, $el, 'getcontenttype') || null,
      modified: modified ? new Date(modified).toISOString() : null,
      etag: (text($, $el, 'getetag') || '').replace(/"/g, '') || null,
    });
  });

  out.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
  return out;
}

/** Namespace-agnostic: Nextcloud uses `d:`, but the prefix is not guaranteed by the spec. */
function localName(tag) {
  return String(tag || '').split(':').pop().toLowerCase();
}

/**
 * First *non-empty* value for a property name anywhere in this response element.
 *
 * "Non-empty" rather than "first" because a real Nextcloud reply carries each response in two
 * propstat blocks: one 200 holding the properties that exist, and one 404 holding empty
 * placeholder elements for the ones that do not. A directory therefore contains both a real
 * <getlastmodified> and a bare <getcontentlength/>, and taking whichever came first in document
 * order would make the parser depend on Sabre/DAV emitting the 200 block first — which it does
 * today, and which nothing guarantees it will keep doing.
 */
function text($, $scope, wanted) {
  let found = '';
  $scope.find('*').each((_, el) => {
    if (found) return;
    if (localName(el.tagName || el.name) !== wanted) return;
    const val = $(el).text().trim();
    if (val) found = val;
  });
  return found;
}

/**
 * Stream a file up to the NAS.
 *
 * The body is the request stream itself, so a 2 GB upload never exists in this container's
 * memory. Node's fetch requires `duplex: 'half'` to accept a stream body at all.
 *
 * There is deliberately no retry. The stream has been consumed by the time a failure is known,
 * so a retry here could only send a truncated file — and the phone's Dio client already retries
 * at the layer that still has the bytes.
 */
async function upload(name, stream, { size, contentType } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };

  const clean = safeName(name);
  if (!clean) return { ok: false, reason: 'bad_name' };

  const ready = await ensureRoot();
  if (!ready.ok) {
    noteHealth(false, ready.reason);
    return { ok: false, reason: ready.reason };
  }

  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  // Without a length, undici uses chunked encoding, which Nextcloud accepts but cannot
  // range-check against the quota up front.
  if (Number.isFinite(size) && size > 0) headers['Content-Length'] = String(size);

  const r = await dav('PUT', urlFor(clean), {
    body: stream,
    headers,
    duplex: 'half',
    timeoutMs: cfg().uploadTimeoutMs,
  });

  if (!r.ok) {
    noteHealth(false, r.reason);
    return { ok: false, reason: r.reason };
  }
  noteHealth(true);
  return { ok: true, name: clean };
}

/**
 * Open a Nextcloud chunked-upload collection. The id is alphanumeric so it is safe in a
 * WebDAV path; the phone never sees the NAS, only this id.
 */
async function createUploadCollection() {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  const id = crypto.randomUUID().replace(/-/g, '');
  const r = await dav('MKCOL', uploadsUrl(id), { timeoutMs: cfg().timeoutMs });
  if (r.ok || (r.reason === 'upstream' && r.status === 405)) {
    return { ok: true, id };
  }
  noteHealth(false, r.reason);
  return { ok: false, reason: r.reason };
}

/**
 * One chunk. `index` is 1-based and becomes the padded name Nextcloud sorts on.
 * Chunks other than the last must be exactly CHUNK_SIZE; the last may be shorter.
 */
async function putUploadChunk(id, index, body, { contentType } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!id || !/^[a-z0-9]+$/i.test(id)) return { ok: false, reason: 'bad_name' };
  if (!Number.isInteger(index) || index < 1) return { ok: false, reason: 'bad_name' };

  const headers = { 'Content-Type': contentType || 'application/octet-stream' };
  if (body && typeof body.length === 'number') {
    headers['Content-Length'] = String(body.length);
  }

  const r = await dav('PUT', uploadsUrl(id, chunkName(index)), {
    body,
    headers,
    timeoutMs: cfg().chunkTimeoutMs,
  });
  if (!r.ok) {
    noteHealth(false, r.reason);
    return { ok: false, reason: r.reason };
  }
  noteHealth(true);
  return { ok: true };
}

/**
 * Commit the chunks into the Cloud Storage folder. Until this MOVE, the file is not there.
 */
async function assembleUpload(id, destName, size) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  const clean = safeName(destName);
  if (!clean) return { ok: false, reason: 'bad_name' };
  if (!id || !/^[a-z0-9]+$/i.test(id)) return { ok: false, reason: 'bad_name' };

  const ready = await ensureRoot();
  if (!ready.ok) {
    noteHealth(false, ready.reason);
    return { ok: false, reason: ready.reason };
  }

  const r = await dav('MOVE', uploadsUrl(id, '.file'), {
    headers: {
      Destination: destHeader(clean),
      Overwrite: 'T',
      'OC-Total-Length': String(size),
    },
    timeoutMs: cfg().uploadTimeoutMs,
  });
  if (!r.ok) {
    noteHealth(false, r.reason);
    return { ok: false, reason: r.reason };
  }
  noteHealth(true);
  return { ok: true, name: clean };
}

/** Drop an unfinished collection so a cancelled film does not sit in Nextcloud's uploads tree. */
async function abortUpload(id) {
  if (!id || !/^[a-z0-9]+$/i.test(id)) return { ok: true };
  const r = await dav('DELETE', uploadsUrl(id), { timeoutMs: cfg().timeoutMs });
  if (!r.ok && r.reason !== 'not_found') return { ok: false, reason: r.reason };
  return { ok: true };
}

/** The response object, for the route to pipe straight through to the phone. */
async function download(name) {
  const clean = safeName(name);
  if (!clean) return { ok: false, reason: 'bad_name' };
  const r = await dav('GET', urlFor(clean), { timeoutMs: cfg().uploadTimeoutMs });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, res: r.res };
}

async function remove(name) {
  const clean = safeName(name);
  if (!clean) return { ok: false, reason: 'bad_name' };
  const r = await dav('DELETE', urlFor(clean));
  // Already gone is the outcome the caller wanted.
  if (!r.ok && r.reason === 'not_found') return { ok: true, name: clean };
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, name: clean };
}

/** One sentence per failure, written for the person holding the phone. */
function explain(reason) {
  switch (reason) {
    case 'not_configured':
      return 'NAS storage is not set up on the server yet.';
    case 'auth':
      return 'The server\'s NAS password was rejected. It needs updating.';
    case 'unreachable':
      return 'Your NAS is not reachable — it may be switched off.';
    case 'timeout':
      return 'Your NAS took too long to respond.';
    case 'insufficient_storage':
      return 'There is not enough free space on the NAS.';
    case 'locked':
      return 'That file is being written by something else. Try again shortly.';
    case 'bad_name':
      return 'That file name cannot be used.';
    case 'not_found':
      return 'That file is no longer on the NAS.';
    case 'bad_payload':
      return 'The NAS sent a reply this app could not read.';
    case 'too_large':
      return 'That file is larger than NAS uploads allow.';
    default:
      return 'The NAS could not complete that just now.';
  }
}

/** 503 for "the far end is not available", 4xx for "this request was wrong". */
function httpStatusFor(reason) {
  switch (reason) {
    case 'bad_name': return 400;
    case 'not_found': return 404;
    case 'too_large': return 413;
    case 'insufficient_storage': return 507;
    case 'locked': return 409;
    case 'not_configured':
    case 'auth':
    case 'unreachable':
    case 'timeout':
    default:
      return 503;
  }
}

module.exports = {
  status,
  list,
  upload,
  download,
  remove,
  isConfigured,
  explain,
  httpStatusFor,
  createUploadCollection,
  putUploadChunk,
  assembleUpload,
  abortUpload,
  CHUNK_SIZE,
  SIMPLE_THRESHOLD,
  MAX_UPLOAD_BYTES,
  // Exported for the tests only.
  _resetForTests,
  safeName,
  parseListing,
  urlFor,
  uploadsUrl,
  destHeader,
  chunkName,
  ensureRoot,
};
