'use strict';

// ═══════════════════════════════════════════════════════════════
//  BATCH ARTICLE SUMMARY — prompt + enrichment contract tests
//  (node:test, no network / LLM)
//
//  Locks in the rev. 5 upgrade of the news summarizer:
//    1. AUDIENCE ADAPTATION — tech stories explained like onboarding a
//       trainee software engineer, finance stories in zero-jargon layman
//       terms, every technical/finance term defined inline.
//    2. Shape D (thin/headline-only articles) must EXPLAIN the headline
//       instead of echoing the title, with an honest closing disclaimer,
//       and must never invent story-specific facts.
//    3. The client-parser-critical output structure (lede \n\n body
//       paragraphs \n\n "• " key-facts block, strict JSON keyed by id)
//       is unchanged.
//    4. index.js: /summarize-articles-batch accepts an optional per-
//       article `url` and deep-extracts real content for thin articles.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildBatchArticleSummaryPrompt } = require('../src/prompts');

const PROMPT = buildBatchArticleSummaryPrompt();

const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index.js'),
  'utf8',
);

// ── 1. Audience adaptation ──────────────────────────────────────

test('prompt has an AUDIENCE ADAPTATION section', () => {
  assert.ok(PROMPT.includes('AUDIENCE ADAPTATION'));
});

test('tech stories are explained for a brand-new trainee software engineer', () => {
  assert.match(PROMPT, /TECH \/ AI \/ SOFTWARE \/ PROGRAMMING/);
  assert.match(PROMPT, /trainee software\s+engineer/);
});

test('finance stories are explained in zero-jargon layman terms', () => {
  assert.match(PROMPT, /FINANCE \/ STOCKS \/ MARKETS \/ BUSINESS \/ ECONOMY/);
  assert.match(PROMPT, /never traded a\s+stock/);
  // Worked jargon examples the model can pattern-match on.
  for (const term of ['F&O', 'IPO', 'repo rate', 'brokerage']) {
    assert.ok(PROMPT.includes(term), `finance jargon example "${term}" must be present`);
  }
});

test('adaptation rules must not alter the output structure', () => {
  assert.match(PROMPT, /change the EXPLANATION STYLE only/);
  assert.match(PROMPT, /NEVER change the\noutput structure/);
});

// ── 2. Thin / headline-only shape D ─────────────────────────────

test('shape D explains the headline instead of echoing the title', () => {
  assert.match(PROMPT, /Do NOT just echo the title back/);
  assert.match(PROMPT, /EXPLAINS the headline in plain language/);
});

test('shape D carries the honest thin-content disclaimer', () => {
  assert.ok(PROMPT.includes(
    'Full article details were not available, so this brief is based on the headline.',
  ));
});

test('shape D still forbids inventing story-specific facts', () => {
  assert.match(PROMPT, /NEVER invent story-specific details/);
});

// ── 3. Client-parser-critical structure is unchanged ────────────

test('magazine structure survives: lede, body, key facts, blank-line separators', () => {
  assert.match(PROMPT, /PARAGRAPH 1 — LEDE/);
  assert.match(PROMPT, /PARAGRAPHS 2–4 — BODY/);
  assert.match(PROMPT, /KEY FACTS/);
  // The Flutter renderer splits on blank lines and "• " bullets.
  assert.ok(PROMPT.includes('\\n\\n'));
  assert.ok(PROMPT.includes('• '));
});

test('strict JSON envelope keyed by echoed id is unchanged', () => {
  assert.match(PROMPT, /"summaries": \[/);
  assert.match(PROMPT, /<echo the input id EXACTLY as received>/);
  assert.match(PROMPT, /one entry for EVERY input id/);
});

// ── 3b. Full-category coverage (rev. 6: reviews, interviews, all beats) ──

test('audience adaptation covers every requested category', () => {
  // The batch prompt is the single live path for AI news, AI-coding,
  // CEO/founder interviews, business/finance/stocks, gadgets and movies.
  assert.match(PROMPT, /incl\. AI-coding & dev-tools news/);
  assert.match(PROMPT, /LEADERSHIP \/ CEO & FOUNDER INTERVIEWS/);
  assert.match(PROMPT, /GADGETS \/ HARDWARE \/ CONSUMER-TECH PRODUCT REVIEWS/);
  assert.match(PROMPT, /MOVIES \/ TV \/ SHOWS \/ ENTERTAINMENT REVIEWS/);
});

test('review + interview summary shapes exist alongside A–D', () => {
  assert.match(PROMPT, /E\. REVIEW \(gadget \/ product \/ movie/);
  assert.match(PROMPT, /F\. INTERVIEW \/ PROFILE/);
  // Reviews stay balanced (no pure hype) and movie reviews stay spoiler-safe.
  assert.match(PROMPT, /never\n {5}turn a mixed review into pure hype/);
  assert.match(PROMPT, /NO spoilers of major twists or the ending/);
});

test('length target is normal-detailed (not short)', () => {
  assert.match(PROMPT, /Acceptable range: 240–320 words/);
  assert.match(PROMPT, /NORMAL-DETAILED depth/);
});

test('style asks for engaging+creative writing without markdown/emojis', () => {
  assert.match(PROMPT, /Engaging and creative, but never at the cost of clarity/);
  // The no-markdown / no-emoji guardrails the client parser relies on stay.
  assert.match(PROMPT, /NO emojis, NO markdown formatting/);
});

// ── 4. index.js enrichment wiring ───────────────────────────────

test('batch schema accepts an optional per-article url', () => {
  const schema = INDEX_SRC.match(
    /const AISummarizeArticlesBatchSchema = z\.object\(\{[\s\S]*?\}\);/,
  );
  assert.ok(schema, 'AISummarizeArticlesBatchSchema must exist');
  assert.match(schema[0], /url: z\.string\(\)\.max\(2000\)\.optional\(\)/);
});

test('batch handler deep-extracts thin articles with guard rails', () => {
  const handler = INDEX_SRC.match(
    /aiRouter\.post\('\/summarize-articles-batch'[\s\S]*?\n\}\);/,
  );
  assert.ok(handler, 'summarize-articles-batch handler must exist');
  const src = handler[0];
  // Thin gate + URL gate.
  assert.match(src, /\.trim\(\)\.length < 350/);
  assert.match(src, /\^https\?:/);
  // At most 3 enrichments, 25 s cap, reuses the shared extraction pipeline.
  assert.match(src, /_thin\.slice\(0, 3\)/);
  assert.match(src, /enrich timeout \(25s\)/);
  assert.match(src, /deepExtractContent\(a\.url/);
  // Enriched text wins, client content is the fallback.
  assert.match(src, /enrichedContent\.get\(a\.id\) \|\| a\.content/);
});
