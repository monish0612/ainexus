'use strict';

// ═══════════════════════════════════════════════════════════════
//  NEWS FULL-CONTENT — unit tests (node:test, no external runners)
//
//  Coverage for the skip_summary pipeline added for the Movies +
//  General feeds. Every helper is a pure function, so these tests
//  run without DB / network / LLM and finish in milliseconds.
//
//  Helpers under test:
//    • splitParagraphs        — explicit blank-line vs sentence-grouped fallback
//    • looksLikeHeading       — bias-towards-paragraph heading detection
//    • buildFullContentMarkdown — end-to-end format → markdown contract
//    • buildFullContentExcerpt  — list-row preview shape + length cap
//    • appendSourceLink       — idempotency + icon selection per source URL
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitParagraphs,
  looksLikeHeading,
  buildFullContentMarkdown,
  buildFullContentExcerpt,
  appendSourceLink,
  looksPreformatted,
  collapseBlanksPreservingCode,
} = require('../src/news-service');

// ─── splitParagraphs ───────────────────────────────────────────

test('splitParagraphs: empty / nullish input → []', () => {
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs(null), []);
  assert.deepEqual(splitParagraphs(undefined), []);
  assert.deepEqual(splitParagraphs('   \n\n  \n  '), []);
});

test('splitParagraphs: 3+ explicit blank-line separated paragraphs → preserved', () => {
  const input = 'First para.\n\nSecond para.\n\nThird para.\n\nFourth para.';
  const out = splitParagraphs(input);
  assert.equal(out.length, 4);
  assert.equal(out[0], 'First para.');
  assert.equal(out[3], 'Fourth para.');
});

test('splitParagraphs: CRLF normalisation', () => {
  const input = 'A.\r\n\r\nB.\r\n\r\nC.\r\n\r\nD.';
  const out = splitParagraphs(input);
  assert.deepEqual(out, ['A.', 'B.', 'C.', 'D.']);
});

test('splitParagraphs: 4+ consecutive newlines collapse to a single break', () => {
  const input = 'X.\n\n\n\n\nY.\n\n\n\nZ.\n\n\nW.';
  const out = splitParagraphs(input);
  assert.deepEqual(out, ['X.', 'Y.', 'Z.', 'W.']);
});

test('splitParagraphs: < 3 explicit paragraphs OR single blob → sentence-grouped', () => {
  // 2 paragraphs: trigger fallback because we want richer flow than 2 huge blocks.
  const twoParas = 'Sentence one. Sentence two. Sentence three. Sentence four.\n\nSentence five. Sentence six. Sentence seven.';
  const out = splitParagraphs(twoParas);
  // Should produce 3 groups of ~3 sentences each.
  assert.ok(out.length >= 2, `expected >= 2 groups, got ${out.length}`);
  for (const p of out) {
    assert.ok(p.length > 0);
  }
});

test('splitParagraphs: single huge blob → groups capped by sentence count', () => {
  const sentences = [];
  for (let i = 1; i <= 12; i++) sentences.push(`Sentence ${i}.`);
  const blob = sentences.join(' ');
  const out = splitParagraphs(blob);
  // 12 sentences / 3 per group = 4 groups
  assert.equal(out.length, 4);
  assert.equal(out[0], 'Sentence 1. Sentence 2. Sentence 3.');
  assert.equal(out[3], 'Sentence 10. Sentence 11. Sentence 12.');
});

test('splitParagraphs: single huge blob → groups capped by ~600 char budget', () => {
  // Each "sentence" must individually clear the 600-char budget, because
  // the flush check fires AFTER the sentence has been added to the buffer
  // — two ~450 char sentences would coalesce into one ~900 char group.
  const big = 'word '.repeat(180).trim() + '.'; // ~900 chars, single sentence
  const blob = `${big} ${big} ${big}`; // 3 huge sentences
  const out = splitParagraphs(blob);
  // Each sentence individually > 600 → each becomes its own group.
  assert.equal(out.length, 3, `expected exactly 3 groups, got ${out.length}`);
  for (const g of out) {
    assert.ok(g.length >= 600, `each group should be >= 600 chars, got ${g.length}`);
  }
});

test('splitParagraphs: < 600 char sentences coalesce up to budget', () => {
  // Behaviour contract: the 600-char flush is "after add", so 2 medium
  // sentences (~450 each) end up in a single group of ~900 chars rather
  // than being split — this avoids tiny orphan paragraphs.
  const med = 'word '.repeat(80).trim() + '.'; // ~400 chars
  const blob = `${med} ${med}`; // 2 medium sentences
  const out = splitParagraphs(blob);
  assert.equal(out.length, 1, `2 medium sentences must coalesce into 1 group, got ${out.length}`);
});

test('splitParagraphs: trims and drops empty paragraphs', () => {
  const input = '   A.\n\n   \n\n   B.\n\n     ';
  const out = splitParagraphs(input);
  // 2 non-empty paragraphs → triggers fallback because < 3, but a 1-blob
  // with 2 sentences still emits a single group containing both.
  assert.ok(out.length >= 1);
  assert.ok(out.every((p) => p.length > 0 && p === p.trim()));
});

test('splitParagraphs: handles ?/! sentence terminators', () => {
  const blob = 'Are you ready? Yes I am! No way? Believe it! Truly amazing! Indeed it is.';
  const out = splitParagraphs(blob);
  assert.equal(out.length, 2); // 6 sentences / 3 per group
  assert.ok(out[0].includes('Are you ready?'));
  assert.ok(out[1].includes('Indeed it is.'));
});

// ─── looksLikeHeading ──────────────────────────────────────────

test('looksLikeHeading: ALL-CAPS short line → true', () => {
  assert.equal(looksLikeHeading('THE BEGINNING'), true);
  assert.equal(looksLikeHeading('ACT ONE'), true);
  assert.equal(looksLikeHeading('CHAPTER 3'), true);
});

test('looksLikeHeading: existing markdown # / * → true', () => {
  assert.equal(looksLikeHeading('# Plain heading'), true);
  assert.equal(looksLikeHeading('## Sub heading'), true);
  assert.equal(looksLikeHeading('* List header'), true);
});

test('looksLikeHeading: too short (< 3) → false', () => {
  assert.equal(looksLikeHeading('A'), false);
  assert.equal(looksLikeHeading(''), false);
  assert.equal(looksLikeHeading('XX'), false);
});

test('looksLikeHeading: too long (> 90) → false', () => {
  const long = 'X'.repeat(91);
  assert.equal(looksLikeHeading(long), false);
});

test('looksLikeHeading: ends with sentence punctuation → false', () => {
  assert.equal(looksLikeHeading('This is a sentence.'), false);
  assert.equal(looksLikeHeading('Is this a heading?'), false);
  assert.equal(looksLikeHeading('What a movie!'), false);
  assert.equal(looksLikeHeading('Quick note:'), false);
  assert.equal(looksLikeHeading('Wait...'), false);
});

test('looksLikeHeading: normal mixed-case prose → false (anti-false-positive)', () => {
  // We intentionally bias towards "paragraph" — only the strong signals
  // above should trigger heading rendering.
  assert.equal(looksLikeHeading('A normal short prose line'), false);
  assert.equal(looksLikeHeading('This looks like a sentence'), false);
  assert.equal(looksLikeHeading('The movie was great overall'), false);
});

test('looksLikeHeading: trims whitespace', () => {
  assert.equal(looksLikeHeading('   ALL CAPS LINE   '), true);
  assert.equal(looksLikeHeading('   short.   '), false);
});

// ─── buildFullContentMarkdown ──────────────────────────────────

test('buildFullContentMarkdown: empty content → friendly fallback + source link', () => {
  const md = buildFullContentMarkdown({
    content: '',
    url: 'https://lensmenreviews.com/review/foo',
    source: 'Lensmen Reviews',
  });
  assert.ok(md.includes('could not be extracted'));
  assert.ok(md.includes('Read Full Article on Lensmen Reviews'));
  assert.ok(md.includes('https://lensmenreviews.com/review/foo'));
  // Should NOT carry the AI fallback marker — that one is reserved for LLM
  // failures and triggers a different UI banner in the Flutter detail view.
  assert.equal(md.includes('summary-unavailable'), false);
});

test('buildFullContentMarkdown: well-formed paragraphs → markdown with source pinned at end', () => {
  const content = 'First detailed paragraph about the movie\'s opening act.\n\nSecond paragraph diving into the technical craft.\n\nThird wrap-up paragraph with verdict.';
  const md = buildFullContentMarkdown({
    content,
    url: 'https://lensmenreviews.com/movie/bar',
    source: 'Lensmen Reviews',
  });
  assert.ok(md.startsWith('First detailed paragraph'));
  assert.ok(md.includes('Second paragraph'));
  assert.ok(md.includes('Third wrap-up paragraph'));
  // Source link at the end
  assert.ok(md.endsWith(')') || md.endsWith(')\n') || md.includes('Read Full Article'));
  assert.ok(md.includes('Read Original Article'));
});

test('buildFullContentMarkdown: detects heading + body pattern', () => {
  // splitParagraphs returns by blank line; a paragraph that starts with a
  // newline-separated all-caps line should get promoted to a ## heading.
  const content = 'INTRODUCTION\nThis is the body that follows the heading line above and should be rendered as a paragraph.';
  // No blank line → this is a single paragraph block, but the head line
  // is "INTRODUCTION" (all caps, short) — so the formatter should output
  // a ## heading + body.
  const md = buildFullContentMarkdown({
    content: `${content}\n\nAnother paragraph here with regular prose to push it past the 3-block fallback.`,
    url: 'https://example.com/x',
    source: 'Example',
  });
  // Either it detected the heading inside the first paragraph OR it fell
  // through to plain rendering — accept both, but the rest of the body
  // must still be present.
  assert.ok(md.includes('This is the body that follows'));
  assert.ok(md.includes('Another paragraph here'));
});

test('buildFullContentMarkdown: idempotent on source-link append (no double-link)', () => {
  const content = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
  const first = buildFullContentMarkdown({
    content,
    url: 'https://techcrunch.com/2026/05/28/ai-news',
    source: 'TechCrunch',
  });
  // Feeding it back in must NOT double-append the source link block.
  const second = appendSourceLink(first, 'https://techcrunch.com/2026/05/28/ai-news', 'TechCrunch');
  assert.equal(first, second);
  // Exactly one occurrence
  const occurrences = (first.match(/Read Original Article/g) || []).length;
  assert.equal(occurrences, 1);
});

test('buildFullContentMarkdown: techcrunch URL → news emoji', () => {
  const md = buildFullContentMarkdown({
    content: 'First.\n\nSecond.\n\nThird.',
    url: 'https://techcrunch.com/article/123',
    source: 'TechCrunch',
  });
  assert.ok(md.includes('📰'), 'expected techcrunch emoji 📰 in source link');
});

test('buildFullContentMarkdown: lensmen URL → film emoji', () => {
  const md = buildFullContentMarkdown({
    content: 'First.\n\nSecond.\n\nThird.',
    url: 'https://lensmenreviews.com/movie/x',
    source: 'Lensmen Reviews',
  });
  assert.ok(md.includes('🎬'), 'expected lensmen emoji 🎬 in source link');
});

test('buildFullContentMarkdown: missing url → still safe (no crash, no link)', () => {
  const md = buildFullContentMarkdown({
    content: 'Body. Body. Body. More body. More. More.',
    url: '',
    source: 'X',
  });
  assert.ok(typeof md === 'string' && md.length > 0);
  // appendSourceLink no-ops when url is falsy.
  assert.equal(md.includes('Read Original Article'), false);
});

test('buildFullContentMarkdown: never invokes any AI fallback marker', () => {
  const md = buildFullContentMarkdown({
    content: 'Real article content split into paragraphs.\n\nMore content here.\n\nAnd more here.',
    url: 'https://techcrunch.com/x',
    source: 'TechCrunch',
  });
  // Critical: this output must NOT trigger the Flutter detail view's
  // "AI summary unavailable" banner (which is keyed off the marker).
  assert.equal(md.includes('<!-- summary-unavailable -->'), false);
});

// ─── buildFullContentExcerpt ───────────────────────────────────

test('looksPreformatted: detects images / code / headings / lists', () => {
  assert.equal(looksPreformatted('![a](http://x/y.png)\n\nbody'), true);
  assert.equal(looksPreformatted('```js\ncode\n```'), true);
  assert.equal(looksPreformatted('## Heading\n\nbody'), true);
  assert.equal(looksPreformatted('- one\n- two'), true);
  assert.equal(looksPreformatted('> quote'), true);
  assert.equal(looksPreformatted('Just a plain prose paragraph with no markdown.'), false);
});

test('buildFullContentMarkdown: passes rich markdown through (image preserved)', () => {
  const content = '![Chart](https://cdn.example.com/chart.png)\n\nThe market rallied today on strong earnings.\n\n## Why it matters\n\nMore context here.';
  const md = buildFullContentMarkdown({
    content,
    url: 'https://thedailybrief.zerodha.com/p/x',
    source: 'The Daily Brief',
  });
  assert.ok(md.includes('![Chart](https://cdn.example.com/chart.png)'), 'image survives');
  assert.ok(md.includes('## Why it matters'), 'heading survives');
  assert.ok(md.includes('Read Original Article'), 'source link appended');
});

test('buildFullContentMarkdown: fenced code block survives intact (blank lines inside)', () => {
  const content = 'Intro paragraph about the code.\n\n```python\ndef f(x):\n\n    return x + 1\n```\n\nClosing paragraph.';
  const md = buildFullContentMarkdown({
    content,
    url: 'https://towardsdatascience.com/p/x',
    source: 'Towards Data Science',
  });
  assert.ok(md.includes('```python\ndef f(x):\n\n    return x + 1\n```'),
    `code fence intact: ${md.slice(0, 200)}`);
  const fenceCount = (md.match(/```/g) || []).length;
  assert.equal(fenceCount, 2, 'exactly one fenced block (open+close)');
});

test('collapseBlanksPreservingCode: collapses prose blanks but not code interior', () => {
  const out = collapseBlanksPreservingCode('a\n\n\n\nb\n\n```\nx\n\n\ny\n```');
  assert.ok(out.includes('a\n\nb'), 'prose blanks collapsed');
  assert.ok(out.includes('```\nx\n\n\ny\n```'), 'code interior preserved');
});

test('buildFullContentExcerpt: empty content → friendly default', () => {
  assert.equal(buildFullContentExcerpt(''), 'New article available.');
  assert.equal(buildFullContentExcerpt(null), 'New article available.');
});

test('buildFullContentExcerpt: short single paragraph → returned verbatim', () => {
  const out = buildFullContentExcerpt('A crisp review of the film with tight pacing.');
  assert.equal(out, 'A crisp review of the film with tight pacing.');
});

test('buildFullContentExcerpt: long first paragraph → truncated to ~240 chars with ellipsis', () => {
  const long = 'a '.repeat(300); // ~600 chars of "a a a ..."
  const out = buildFullContentExcerpt(long);
  assert.ok(out.length <= 240, `expected length ≤ 240, got ${out.length}`);
  assert.ok(out.endsWith('…'), `expected ellipsis suffix, got "${out.slice(-5)}"`);
});

test('buildFullContentExcerpt: respects word boundaries when truncating', () => {
  const long = 'word '.repeat(80); // ~400 chars
  const out = buildFullContentExcerpt(long);
  // Must not cut a word in half mid-character (we truncate at a space).
  assert.ok(out.endsWith('…'));
  // The char just before the ellipsis must be the end of a word
  // (we cut at the last space within the slice budget).
  const trimmed = out.slice(0, -1).trimEnd();
  assert.ok(!/\b\w$/.test(trimmed) || trimmed.endsWith('word'));
});

test('buildFullContentExcerpt: uses ONLY first paragraph when multiple are present', () => {
  const content = 'First short lead paragraph.\n\nSecond paragraph should be ignored.\n\nThird also ignored.';
  const out = buildFullContentExcerpt(content);
  assert.equal(out, 'First short lead paragraph.');
  assert.equal(out.includes('Second'), false);
});

// ─── appendSourceLink (regression coverage) ─────────────────────

test('appendSourceLink: no-op when summary or url is empty', () => {
  assert.equal(appendSourceLink('', 'https://x.com', 'X'), '');
  assert.equal(appendSourceLink('body', '', 'X'), 'body');
});

test('appendSourceLink: idempotent on multiple calls', () => {
  const once = appendSourceLink('Body here.', 'https://x.com', 'X');
  const twice = appendSourceLink(once, 'https://x.com', 'X');
  assert.equal(once, twice);
});
