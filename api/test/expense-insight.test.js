'use strict';

// ═══════════════════════════════════════════════════════════════
//  EXPENSE-INSIGHT — contract tests (node:test, no network/LLM)
//
//  Locks in (a) the composer prompt's anti-hallucination contract
//  (token-only, no bare digits, JSON-only, personalized by name) and
//  (b) the response sanitizer (tone allow-list, chip cap/trim, length
//  clamps). Live LLM output can't be asserted deterministically, so we
//  assert the prompt instructions + the deterministic sanitizer.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExpenseInsightPrompt,
  sanitizeInsightResponse,
} = require('../src/expense-insight');

const SAMPLE_FACTS = {
  name: { display: 'Monish' },
  total: { display: '₹83,286', value: 83286 },
  'topCategory.name': { display: 'Food' },
  'topCategory.total': { display: '₹14,700', value: 14700 },
  'topCategory.pct': { display: '18%', value: 18 },
};

test('prompt addresses the user by name and forbids bare digits', () => {
  const p = buildExpenseInsightPrompt('Monish', SAMPLE_FACTS);
  assert.match(p, /named Monish/);
  assert.match(p, /NEVER write any number/);
  assert.match(p, /\{\{name\}\}/);
});

test('prompt lists the available token names from FACTS', () => {
  const p = buildExpenseInsightPrompt('Monish', SAMPLE_FACTS);
  for (const tok of Object.keys(SAMPLE_FACTS)) {
    assert.ok(p.includes(tok), `prompt must surface token "${tok}"`);
  }
});

test('prompt requires the strict JSON key contract and bans markdown/tables', () => {
  const p = buildExpenseInsightPrompt('Monish', SAMPLE_FACTS);
  for (const key of ['"greeting"', '"headline"', '"tip"', '"tone"', '"chips"']) {
    assert.ok(p.includes(key), `prompt must define ${key}`);
  }
  assert.match(p, /No markdown, no emojis, no tables/);
  assert.match(p, /VALID JSON only/);
});

test('prompt tolerates missing/garbage facts without throwing', () => {
  assert.doesNotThrow(() => buildExpenseInsightPrompt('there', null));
  assert.doesNotThrow(() => buildExpenseInsightPrompt('there', []));
  const p = buildExpenseInsightPrompt('there', undefined);
  assert.match(p, /\(none\)/);
});

test('sanitizer keeps a clean response intact', () => {
  const out = sanitizeInsightResponse({
    greeting: '  Hey {{name}},  ',
    headline: '{{topCategory.name}} leads.',
    tip: 'Trim it.',
    tone: 'warning',
    chips: ['Break down {{topCategory.name}}', 'Compare to last month'],
  });
  assert.equal(out.greeting, 'Hey {{name}},');
  assert.equal(out.tone, 'warning');
  assert.deepEqual(out.chips, ['Break down {{topCategory.name}}', 'Compare to last month']);
});

test('sanitizer clamps an unknown tone to info', () => {
  assert.equal(sanitizeInsightResponse({ tone: 'apocalyptic' }).tone, 'info');
  assert.equal(sanitizeInsightResponse({}).tone, 'info');
});

test('sanitizer caps chips at 4, drops non-strings / overlong / blanks', () => {
  const out = sanitizeInsightResponse({
    chips: ['a', 'b', 'c', 'd', 'e', '', '   ', 42, null, 'x'.repeat(49)],
  });
  assert.equal(out.chips.length, 4);
  assert.deepEqual(out.chips, ['a', 'b', 'c', 'd']);
});

test('sanitizer trims overlong narrative fields and ignores non-strings', () => {
  const out = sanitizeInsightResponse({
    greeting: 'g'.repeat(200),
    headline: 123,
    tip: undefined,
  });
  assert.equal(out.greeting.length, 160);
  assert.equal(out.headline, '');
  assert.equal(out.tip, '');
});

test('sanitizer is null-safe', () => {
  const out = sanitizeInsightResponse(null);
  assert.deepEqual(out, { greeting: '', headline: '', tip: '', tone: 'info', chips: [] });
});
