'use strict';

// ═══════════════════════════════════════════════════════════════
//  X-FEED SERVICE — unit tests (node:test, no DB / network / LLM)
//
//  Locks in the "once per day, 8 AM IST" behaviour change:
//    • Schedule is a SINGLE 8 AM IST run (no second evening run).
//    • Digest dedup key is day-based + time-independent, so the
//      scheduled run, a restart catch-up, and a manual sync all map
//      to ONE article per day.
//    • The fetch window falls back to 24h (covers the full prior day
//      / "yesterday") when there is no saved cursor yet.
//    • The summarizer prompt emits the modern, mobile-safe layout
//      (verbatim section headers, blockquote TL;DR, no tables/HTML).
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEDULE_TIMES_IST,
  X_FEED_HANDLES,
  getCurrentSlot,
  buildGuid,
  buildArticleId,
  computeWindowStart,
  msUntilNextRun,
  buildSummarizerPrompts,
  extractDigestJSON,
} = require('../src/x-feed-service');

// ── Schedule: exactly one daily run at 8 AM IST ──────────────────

test('SCHEDULE_TIMES_IST has a single 8 AM IST slot', () => {
  assert.equal(SCHEDULE_TIMES_IST.length, 1, 'must run once per day');
  assert.deepEqual(SCHEDULE_TIMES_IST[0], { hour: 8, minute: 0 });
});

test('msUntilNextRun is always within the next 24 hours', () => {
  const ms = msUntilNextRun();
  assert.ok(ms >= 0, 'never negative');
  assert.ok(ms <= 24 * 60 * 60 * 1000, 'a single daily run is at most 24h away');
});

// ── Once-per-day dedup (time-independent) ────────────────────────

test('getCurrentSlot is a constant daily key (time-independent)', () => {
  assert.equal(getCurrentSlot(), 'daily');
  // Calling it repeatedly (i.e. at different wall-clock times) is stable.
  assert.equal(getCurrentSlot(), getCurrentSlot());
});

test('buildGuid is day-keyed and stable regardless of trigger time', () => {
  const g1 = buildGuid('KobeissiLetter', 'Jun 25, 2026', getCurrentSlot());
  const g2 = buildGuid('KobeissiLetter', 'Jun 25, 2026', getCurrentSlot());
  assert.equal(g1, g2, 'same day → same guid (scheduled == manual == catch-up)');
  assert.ok(g1.endsWith('-daily'));
  assert.ok(g1.includes('kobeissiletter'));

  const otherDay = buildGuid('KobeissiLetter', 'Jun 26, 2026', getCurrentSlot());
  assert.notEqual(g1, otherDay, 'different day → different guid');
});

test('buildArticleId is deterministic and namespaced', () => {
  const a = buildArticleId('KobeissiLetter', 'Jun 25, 2026', 'daily');
  const b = buildArticleId('KobeissiLetter', 'Jun 25, 2026', 'daily');
  assert.equal(a, b, 'stable hash for the same day');
  assert.ok(a.startsWith('xf-kobeissiletter-'));
});

// ── Window covers the full prior day ─────────────────────────────

test('computeWindowStart uses the saved cursor when present', () => {
  const cursor = '2026-06-24T02:30:00.000Z';
  assert.equal(
    computeWindowStart({ last_window_end: cursor }),
    cursor,
    'resume exactly where the last run stopped',
  );
});

test('computeWindowStart falls back to 24h ago (covers yesterday) with no cursor', () => {
  const now = Date.parse('2026-06-25T02:30:00.000Z');
  const expected = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(computeWindowStart(null, now), expected);
  assert.equal(computeWindowStart({}, now), expected, 'empty state row also backfills 24h');
});

// ── Modern, mobile-safe digest layout ────────────────────────────

test('buildSummarizerPrompts emits the modern layout contract', () => {
  const handle = X_FEED_HANDLES[0];
  const { system, user } = buildSummarizerPrompts(
    handle,
    'Thursday, June 25, 2026',
    'Jun 25, 2026',
    '--- Post 1 ---\nMarkets rallied today.',
    1,
  );

  // Verbatim section headers the renderer styles nicely.
  for (const heading of [
    '## 🔑 Key Takeaways',
    '## 🗣️ In Plain English',
    '## 📈 What Actually Happened',
    '## 📊 By the Numbers',
    '## 💡 What This Means For You',
  ]) {
    assert.ok(system.includes(heading), `missing section: ${heading}`);
  }

  // TL;DR is delivered as a blockquote callout.
  assert.ok(system.includes('> 💡 **TL;DR'), 'TL;DR blockquote callout');
  // Masthead uses the human display name + a source link to the handle.
  assert.ok(system.includes(`# 📊 ${handle.displayName}`));
  assert.ok(system.includes(`https://x.com/${handle.handle}`));

  // Mobile-safety guardrails: no tables / HTML in the rendered article.
  assert.ok(
    /DO NOT use HTML, tables/.test(system),
    'prompt must forbid tables/HTML to avoid mobile overflow',
  );

  // The posts content is forwarded to the model verbatim.
  assert.ok(user.includes('Markets rallied today.'));
  assert.ok(user.includes('**Bold** all key numbers'));
});

// ── Digest JSON extraction robustness (regression guard) ─────────

test('extractDigestJSON parses a fenced ```json block', () => {
  const body =
    'Here you go:\n```json\n' +
    JSON.stringify({
      title: 'Kobeissi Brief: Big Day',
      excerpt: 'Markets moved a lot today in plain English.',
      article: '# 📊 The Kobeissi Letter\n\nA sufficiently long article body that easily clears the one-hundred character minimum gate for parsing.',
      stats: [{ value: '4%', label: 'how much stocks fell' }],
      key_topics: ['stocks', 'rates'],
    }) +
    '\n```';

  const parsed = extractDigestJSON(body);
  assert.ok(parsed, 'should parse');
  assert.equal(parsed.title, 'Kobeissi Brief: Big Day');
  assert.equal(parsed.stats.length, 1);
  assert.equal(parsed.keyTopics.length, 2);
});

test('extractDigestJSON rejects a too-short article', () => {
  const body = JSON.stringify({ title: 'x', excerpt: 'y', article: 'too short' });
  assert.equal(extractDigestJSON(body), null);
});
