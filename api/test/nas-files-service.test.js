'use strict';

// Tests for the NAS file destination.
//
// Three things here are worth locking down, and only one of them is "does it work":
//
//   • Names from a phone end up in a URL path, so `../` must not be able to walk out of the
//     Cloud Storage folder into Nextcloud's own config. That is the security boundary.
//   • Every failure has to keep its identity. "Your NAS is off", "the password is wrong" and
//     "the pool is full" are three different things for the owner to do about it.
//   • An unset password must degrade, not crash. The API serves news, expenses and Drive from
//     the same process, and none of them should care that this one option has no credential.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Swap telegram.js for a recorder before the service requires it, matching the approach in
// nas-stats-service.test.js — the production module has no injection seam.
const sent = [];
const tgPath = require.resolve(path.join(__dirname, '..', 'src', 'telegram.js'));
require.cache[tgPath] = {
  id: tgPath,
  filename: tgPath,
  loaded: true,
  exports: {
    tg: {
      d: (...a) => sent.push(['d', ...a]),
      i: (...a) => sent.push(['i', ...a]),
      w: (...a) => sent.push(['w', ...a]),
      e: (...a) => sent.push(['e', ...a]),
      fatal: (...a) => sent.push(['fatal', ...a]),
    },
  },
};

const svc = require('../src/nas-files-service');

// ── a scripted WebDAV server ────────────────────────────────────

const realFetch = global.fetch;
let calls = [];
let script = () => ({ status: 207, body: multistatus() });

function installFetch() {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers || {} });
    const r = await script(String(url), opts, calls.length);
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(Object.entries(r.headers || {})),
      text: async () => r.body ?? '',
      body: r.stream ?? null,
    };
  };
}

function reset({ password = 'app-pw' } = {}) {
  sent.length = 0;
  svc._resetForTests();
  installFetch();
  process.env.NAS_WEBDAV_URL = 'http://10.10.10.2:30027';
  process.env.NAS_WEBDAV_HOST = 'cloud.monishlabs.com';
  process.env.NAS_WEBDAV_USER = 'monish';
  process.env.NAS_WEBDAV_ROOT = 'Code/Cloud Storage';
  if (password) process.env.NAS_WEBDAV_PASSWORD = password;
  else delete process.env.NAS_WEBDAV_PASSWORD;
}

/** A realistic Nextcloud Depth:1 reply: the collection, then two files and a subfolder. */
function multistatus() {
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/notes.txt</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>48</d:getcontentlength>
      <d:getlastmodified>Tue, 19 Aug 2026 09:24:11 GMT</d:getlastmodified>
      <d:getcontenttype>text/plain</d:getcontenttype>
      <d:getetag>"abc123"</d:getetag>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/holiday%20photo.jpg</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048576</d:getcontentlength>
      <d:getlastmodified>Wed, 20 Aug 2026 11:00:00 GMT</d:getlastmodified>
      <d:getcontenttype>image/jpeg</d:getcontenttype>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/subfolder/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
}

test.after(() => {
  global.fetch = realFetch;
  delete process.env.NAS_WEBDAV_PASSWORD;
});

// ── the security boundary ───────────────────────────────────────

test('a name cannot walk out of the folder', () => {
  // Each of these, pasted into the URL unchecked, would reach Nextcloud's own config.
  for (const evil of [
    '../../../config/config.php',
    '..\\..\\windows\\system32',
    '/etc/passwd',
    'a/../../b.txt',
    './../secret',
  ]) {
    const out = svc.safeName(evil);
    assert.ok(out === null || !/[\\/]/.test(out), `${evil} -> ${out}`);
    assert.ok(out === null || !out.includes('..'), `${evil} -> ${out}`);
  }

  assert.equal(svc.safeName('../../../config/config.php'), 'config.php');
  assert.equal(svc.safeName('/etc/passwd'), 'passwd');
});

test('the pathological names are refused outright', () => {
  assert.equal(svc.safeName('..'), null);
  assert.equal(svc.safeName('.'), null);
  assert.equal(svc.safeName(''), null);
  assert.equal(svc.safeName('   '), null);
  assert.equal(svc.safeName(null), null);
  assert.equal(svc.safeName(42), null);
  assert.equal(svc.safeName('/'), null);
});

test('ordinary names survive intact, including spaces and unicode', () => {
  assert.equal(svc.safeName('holiday photo.jpg'), 'holiday photo.jpg');
  assert.equal(svc.safeName('report_v2 (final).pdf'), 'report_v2 (final).pdf');
  assert.equal(svc.safeName('छुट्टी.txt'), 'छुट्टी.txt');
});

test('a dotfile is de-hidden rather than silently vanishing from the listing', () => {
  assert.equal(svc.safeName('.bashrc'), '_bashrc');
});

test('an absurdly long name is truncated but keeps its extension', () => {
  const out = svc.safeName(`${'a'.repeat(400)}.pdf`);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('.pdf'), 'the extension is what makes it openable');
});

test('control characters are stripped, not passed into a header', () => {
  assert.equal(svc.safeName('bad\u0000name\u001f.txt'), 'badname.txt');
});

test('the space in "Cloud Storage" is encoded, or curl-alikes fail to connect', () => {
  reset();
  const u = svc.urlFor('a b.txt');
  assert.ok(u.includes('Cloud%20Storage'), u);
  assert.ok(!/ /.test(u), 'a raw space in the URL is what made the first probe return http=000');
  assert.ok(u.endsWith('/a%20b.txt'));
});

// ── not configured ──────────────────────────────────────────────

test('with no password nothing is attempted and nothing throws', async () => {
  reset({ password: null });

  assert.equal(svc.isConfigured(), false);

  const s = await svc.status();
  assert.equal(s.configured, false);
  assert.equal(s.reason, 'not_configured');

  const l = await svc.list();
  assert.equal(l.ok, false);
  assert.equal(l.reason, 'not_configured');
  assert.deepEqual(l.files, []);

  const u = await svc.upload('a.txt', null, {});
  assert.equal(u.reason, 'not_configured');

  assert.equal(calls.length, 0, 'there is nothing to learn from a call with no credential');
});

test('not configured is a 503 with an explanation, never a 500', () => {
  assert.equal(svc.httpStatusFor('not_configured'), 503);
  assert.match(svc.explain('not_configured'), /not set up/i);
});

// ── listing ─────────────────────────────────────────────────────

test('a listing yields files only, newest first', async () => {
  reset();
  const out = await svc.list();

  assert.equal(out.ok, true);
  assert.equal(out.files.length, 2, 'the collection itself and the subfolder are not files');
  assert.equal(out.files[0].name, 'holiday photo.jpg', 'newest first');
  assert.equal(out.files[0].size, 2048576);
  assert.equal(out.files[0].mimeType, 'image/jpeg');
  assert.equal(out.files[1].name, 'notes.txt');
  assert.equal(out.files[1].etag, 'abc123', 'quotes stripped');
});

test('percent-encoded names are decoded for display', async () => {
  reset();
  const out = await svc.list();
  assert.ok(out.files.some((f) => f.name === 'holiday photo.jpg'),
    'the owner named it with a space; he should see it with a space');
});

test('the request carries the tunnel address but the trusted Host header', async () => {
  reset();
  await svc.list();

  assert.ok(calls[0].url.startsWith('http://10.10.10.2:30027/'), calls[0].url);
  assert.equal(calls[0].headers.Host, 'cloud.monishlabs.com',
    '10.10.10.2 is not in Nextcloud trusted_domains; the public name is');
  assert.match(calls[0].headers.Authorization, /^Basic /);
});

test('a folder that does not exist yet is empty, not broken', async () => {
  reset();
  script = () => ({ status: 404 });

  const out = await svc.list();
  assert.equal(out.ok, true, 'it is created on first upload; an empty tab is the truth');
  assert.deepEqual(out.files, []);
});

// Captured verbatim from the real Nextcloud at cloud.monishlabs.com. Worth keeping as a
// fixture because it does something the hand-written one above does not: every response
// carries *two* propstat blocks, a 200 with the properties that exist and a 404 with empty
// placeholders for the ones that do not. A parser that takes the first element it finds by
// name reads the empty placeholder instead of the value the moment Sabre reorders them.
const REAL_NEXTCLOUD_REPLY = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/</d:href><d:propstat><d:prop><d:getlastmodified>Wed, 19 Aug 2026 09:24:14 GMT</d:getlastmodified><d:resourcetype><d:collection/></d:resourcetype><d:getetag>&quot;6a85763e4dd3a&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength/><d:getcontenttype/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;

test('the real Nextcloud reply for an empty folder yields no files', async () => {
  reset();
  script = () => ({ status: 207, body: REAL_NEXTCLOUD_REPLY });

  const out = await svc.list();
  assert.equal(out.ok, true);
  assert.deepEqual(out.files, [], 'the only entry is the collection itself');
});

test('a 404 propstat placeholder never masks the real value', () => {
  // Same two-block shape, but for a file that does have a length — with the 404 block first,
  // which is the ordering the parser must not depend on.
  const reordered = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response>
  <d:href>/remote.php/dav/files/monish/Code/Cloud%20Storage/report.pdf</d:href>
  <d:propstat><d:prop><d:getcontenttype/></d:prop>
    <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  <d:propstat><d:prop>
      <d:getcontentlength>1234</d:getcontentlength>
      <d:getlastmodified>Wed, 19 Aug 2026 09:24:14 GMT</d:getlastmodified>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response></d:multistatus>`;

  const files = svc.parseListing(reordered);
  assert.equal(files.length, 1);
  assert.equal(files[0].size, 1234, 'the empty placeholder must not win');
  assert.equal(files[0].name, 'report.pdf');
});

test('a listing that is not XML is reported, not half-parsed', async () => {
  reset();
  script = () => ({ status: 207, body: '<<<not xml at all' });
  const out = await svc.list();
  // cheerio is forgiving, so the contract is only that it never throws and never invents files.
  assert.equal(out.ok, true);
  assert.deepEqual(out.files, []);
});

// ── failure identities ──────────────────────────────────────────

const failures = [
  ['a switched-off NAS', { throw: Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }) }, 'unreachable', /switched off/i],
  ['a wedged NAS', { throw: Object.assign(new Error('slow'), { name: 'TimeoutError' }) }, 'timeout', /too long/i],
  ['a rejected app password', { status: 401 }, 'auth', /password was rejected/i],
  ['a full pool', { status: 507 }, 'insufficient_storage', /free space/i],
  ['a locked file', { status: 423 }, 'locked', /being written/i],
];

for (const [label, reply, reason, message] of failures) {
  test(`${label} keeps its own identity`, async () => {
    reset();
    script = () => reply;

    const out = await svc.list();
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason);
    assert.match(svc.explain(reason), message);
  });
}

test('a full pool is 507 and a bad name is 400 — not all failures are the NAS\'s fault', () => {
  assert.equal(svc.httpStatusFor('insufficient_storage'), 507);
  assert.equal(svc.httpStatusFor('bad_name'), 400);
  assert.equal(svc.httpStatusFor('not_found'), 404);
  assert.equal(svc.httpStatusFor('unreachable'), 503);
});

// ── uploading ───────────────────────────────────────────────────

test('an upload creates the folder once, then puts the file', async () => {
  reset();
  script = (_url, opts) => (opts.method === 'MKCOL' ? { status: 201 } : { status: 201 });

  const out = await svc.upload('notes.txt', 'stream-stand-in', { contentType: 'text/plain' });

  assert.equal(out.ok, true);
  assert.equal(out.name, 'notes.txt');
  assert.equal(calls[0].method, 'MKCOL');
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].headers['Content-Type'], 'text/plain');
});

test('the folder is not re-created before every upload', async () => {
  reset();
  script = () => ({ status: 201 });

  await svc.upload('a.txt', 's', {});
  const afterFirst = calls.length;
  await svc.upload('b.txt', 's', {});

  const mkcols = calls.filter((c) => c.method === 'MKCOL').length;
  assert.equal(mkcols, 1, 'a burst of uploads should not send a MKCOL each');
  assert.equal(calls.length, afterFirst + 1);
});

test('an existing folder answers 405, which is success', async () => {
  reset();
  script = (_url, opts) => (opts.method === 'MKCOL' ? { status: 405 } : { status: 204 });

  const out = await svc.upload('a.txt', 's', {});
  assert.equal(out.ok, true, '405 means it is already there, which is what we wanted');
});

test('a traversal name is refused before anything is sent', async () => {
  reset();
  const out = await svc.upload('..', 's', {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad_name');
  assert.equal(calls.length, 0);
});

test('a failed upload names the cause rather than saying "failed"', async () => {
  reset();
  script = (_url, opts) => (opts.method === 'MKCOL' ? { status: 405 } : { status: 507 });

  const out = await svc.upload('big.iso', 's', {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'insufficient_storage');
});

test('the stream is sent as the body with duplex set, so large files are not buffered',
  async () => {
    reset();
    let sawDuplex = null;
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method, headers: opts.headers || {} });
      if (opts.method === 'PUT') sawDuplex = opts.duplex;
      return { ok: true, status: 201, headers: new Map(), text: async () => '' };
    };

    await svc.upload('film.mkv', 'a-stream', { size: 2 ** 31 });

    assert.equal(sawDuplex, 'half', 'node fetch refuses a stream body without this');
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(put.headers['Content-Length'], String(2 ** 31));
  });

// ── deleting ────────────────────────────────────────────────────

test('deleting something already gone is success, not a 404 to the user', async () => {
  reset();
  script = () => ({ status: 404 });

  const out = await svc.remove('gone.txt');
  assert.equal(out.ok, true, 'the caller wanted it absent, and it is absent');
});

test('a delete is aimed at the encoded path', async () => {
  reset();
  script = () => ({ status: 204 });

  await svc.remove('holiday photo.jpg');
  assert.equal(calls[0].method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/holiday%20photo.jpg'), calls[0].url);
});

// ── telegram ────────────────────────────────────────────────────

test('the first result is not announced, whatever it is', async () => {
  reset();
  script = () => ({ throw: Object.assign(new Error('off'), { name: 'TypeError' }) });

  await svc.list();
  assert.equal(sent.length, 0, 'opening the tab with the NAS off is not an event');
});

test('going away is announced once, not once per refresh', async () => {
  reset();
  script = () => ({ status: 207, body: multistatus() });
  await svc.list();                       // establishes healthy

  script = () => ({ throw: Object.assign(new Error('off'), { name: 'TypeError' }) });
  await svc.list();
  await svc.list();
  await svc.list();

  const warnings = sent.filter((m) => m[0] === 'w');
  assert.equal(warnings.length, 1, 'the Files tab refreshes constantly; this must not spam');
  assert.match(warnings[0][2], /not answering/i);
});

test('a rejected password is an error naming the variable to fix', async () => {
  reset();
  script = () => ({ status: 207, body: multistatus() });
  await svc.list();

  script = () => ({ status: 401 });
  await svc.list();

  const errors = sent.filter((m) => m[0] === 'e');
  assert.equal(errors.length, 1);
  assert.match(errors[0][2], /NAS_WEBDAV_PASSWORD/);
  assert.match(errors[0][2], /app password/i);
});

test('recovery is announced once', async () => {
  reset();
  script = () => ({ status: 207, body: multistatus() });
  await svc.list();

  script = () => ({ throw: Object.assign(new Error('off'), { name: 'TypeError' }) });
  await svc.list();

  script = () => ({ status: 207, body: multistatus() });
  await svc.list();
  await svc.list();

  const info = sent.filter((m) => m[0] === 'i');
  assert.equal(info.length, 1);
  assert.match(info[0][2], /reachable again/i);
});

test('no message ever carries the app password', async () => {
  reset({ password: 'super-secret-app-pw' });
  script = () => ({ status: 207, body: multistatus() });
  await svc.list();
  script = () => ({ status: 401 });
  await svc.list();

  const all = JSON.stringify(sent);
  assert.ok(!all.includes('super-secret-app-pw'), 'a credential must never reach Telegram');
});
