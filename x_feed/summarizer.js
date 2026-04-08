'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Digest article generator
//
//  Transforms raw X posts into a branded, simplified finance article
//  with "The Kobeissi Letter" creative header format.
// ═══════════════════════════════════════════════════════════════════════

import {
  tg,
  xgrokComplete,
  resolveXGrokModel,
  callLiteLLMFallback,
  SUMMARIZE_TIMEOUT_MS,
} from './config.js';
import { withRetry } from './retry.js';

// ── Build summarizer prompts ───────────────────────────────────────────

function buildSummarizerPrompts(handleConfig, dateLong, dateShort, postsContent, postsFound) {
  const system = [
    `You are a world-class financial journalist who writes the "${handleConfig.displayName}" daily market digest.`,
    '',
    'YOUR WRITING STYLE:',
    '• Use simple language a college student in India can understand',
    '• Explain every financial term in parentheses, e.g. "hawkish stance (signaling rate hikes)"',
    '• Connect global events to Indian market impact (Nifty, Sensex, INR) when relevant',
    '• Every sentence must add value — no filler, no fluff',
    '• Use markdown formatting for clean readability',
    '',
    'You MUST return a JSON object with this EXACT structure:',
    '{',
    '  "title": "<compelling title, 60-80 chars, e.g. Kobeissi Brief: Fed Signals, PCE Data & Tariff Shock>",',
    '  "excerpt": "<1-2 sentence summary, max 200 chars>",',
    '  "article": "<full markdown article — see structure below>",',
    '  "stats": [{"value": "<number/pct>", "label": "<what it measures>"}],',
    '  "key_topics": ["topic1", "topic2", "topic3"]',
    '}',
    '',
    'ARTICLE MARKDOWN STRUCTURE (inside "article" field):',
    '',
    '# 📊 The Kobeissi Letter',
    '',
    `### Daily Markets Brief — ${dateLong}`,
    '',
    '> One-line theme of today\'s market narrative',
    '',
    '---',
    '',
    '## 🔑 Key Takeaways',
    '- Bullet point 1',
    '- Bullet point 2',
    '- Bullet point 3',
    '',
    '## 📈 Detailed Analysis',
    '### <Sub-topic heading>',
    '<Clear explanation with numbers>',
    '',
    '### <Sub-topic heading>',
    '<Clear explanation with numbers>',
    '',
    '## 💡 What This Means For You',
    '<Simple, actionable insight for retail investors in India>',
    '',
    '---',
    '',
    `*Daily digest from [@${handleConfig.handle}](https://x.com/${handleConfig.handle}) on X — ${dateShort}*`,
  ].join('\n');

  const user = [
    `Here are the posts from ${handleConfig.displayName} (@${handleConfig.handle}) on X:`,
    `Date: ${dateLong}`,
    `Posts found: ${postsFound > 0 ? postsFound : 'extracted from search'}`,
    '',
    postsContent,
    '',
    'INSTRUCTIONS:',
    '1. Cover EVERY major point from the posts — do not skip anything',
    '2. Explain complex financial concepts in very simple terms',
    '3. Highlight all key numbers, percentages, and market data',
    '4. Explain WHY each development matters to a regular person',
    '5. Include 3-5 stat items with the most important numbers',
    '6. When "📊 IMAGE/CHART DATA" sections are present, these contain extracted data from',
    '   charts and images attached to the posts. INCORPORATE these data points, exact numbers,',
    '   and trend descriptions into the article — they often contain critical info not in the text',
    '',
    'Return ONLY the JSON object. No other text.',
  ].join('\n');

  return { system, user };
}

// ── Format posts for the prompt ────────────────────────────────────────

/**
 * @param {Array}  posts         — structured post objects from fetcher
 * @param {string} rawResponse   — raw text fallback
 * @param {Array}  [visionItems] — analysis results from vision.js
 */
function formatPostsContent(posts, rawResponse, visionItems = []) {
  if (posts.length > 0) {
    const visionByPost = new Map();
    for (const vi of visionItems) {
      if (!vi.success || !vi.analysis) continue;
      if (!visionByPost.has(vi.postIndex)) {
        visionByPost.set(vi.postIndex, []);
      }
      visionByPost.get(vi.postIndex).push(vi.analysis);
    }

    return posts
      .map((p, i) => {
        const parts = [`--- Post ${i + 1}`];
        if (p.time) parts[0] += ` (${p.time})`;
        if (p.has_media) parts[0] += ' [📊 has chart/media]';
        if (p.is_thread) parts[0] += ' [🧵 thread]';
        parts[0] += ' ---';
        parts.push(p.text);
        if (p.url) parts.push(`Link: ${p.url}`);

        const analyses = visionByPost.get(i);
        if (analyses && analyses.length > 0) {
          parts.push('');
          parts.push('📊 IMAGE/CHART DATA (extracted via vision analysis):');
          for (let j = 0; j < analyses.length; j++) {
            if (analyses.length > 1) parts.push(`[Image ${j + 1}]`);
            parts.push(analyses[j]);
          }
        }

        return parts.join('\n');
      })
      .join('\n\n');
  }
  return rawResponse || '';
}

// ── Core: generate digest ──────────────────────────────────────────────

/**
 * Generate a branded daily digest article from fetched posts.
 *
 * @param {Object} handleConfig  — from X_FEED_HANDLES
 * @param {Object} fetchResult   — from fetcher.fetchPostsSince
 * @param {string} dateLong      — e.g. "Monday, April 7, 2026"
 * @param {string} dateShort     — e.g. "Apr 7, 2026"
 * @param {Object} [visionResult] — from vision.analyzePostImages
 * @returns {Promise<DigestResult|null>}
 *
 * @typedef {Object} DigestResult
 * @property {string}  title
 * @property {string}  excerpt
 * @property {string}  article    — full markdown
 * @property {Array}   stats
 * @property {Array}   keyTopics
 * @property {string}  model
 * @property {number}  elapsed
 */
export async function generateDigest(handleConfig, fetchResult, dateLong, dateShort, visionResult = null) {
  const model = resolveXGrokModel('lite');
  const t0 = Date.now();
  const label = `@${handleConfig.handle} ${dateShort}`;

  tg.d('X-FEED/summarize', `▶ Generating digest for ${label}`);

  const { posts, rawResponse, postsFound } = fetchResult;
  const visionItems = visionResult?.items || [];
  const postsContent = formatPostsContent(posts, rawResponse, visionItems);

  if (!postsContent || postsContent.trim().length < 20) {
    tg.w('X-FEED/summarize', `No meaningful content to summarize for ${label}`);
    return null;
  }

  const { system, user } = buildSummarizerPrompts(
    handleConfig,
    dateLong,
    dateShort,
    postsContent,
    postsFound,
  );

  const digestMessages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let result;
  try {
    result = await withRetry(
      async () => {
        return xgrokComplete({
          model,
          messages: digestMessages,
          temperature: 0.4,
          maxTokens: 8000,
          timeoutMs: SUMMARIZE_TIMEOUT_MS,
        });
      },
      {
        maxAttempts: 3,
        tag: 'X-FEED/summarize',
        label: `digest ${label}`,
      },
    );
  } catch (xgrokErr) {
    const xgrokElapsed = Date.now() - t0;
    tg.w('X-FEED/summarize', `xGrok FAILED for ${label} ${xgrokElapsed}ms — falling back to LiteLLM: ${xgrokErr.message?.slice(0, 120)}`);
    try {
      result = await withRetry(
        async () => {
          return callLiteLLMFallback({
            messages: digestMessages,
            temperature: 0.4,
            maxTokens: 8000,
            timeoutMs: SUMMARIZE_TIMEOUT_MS,
          });
        },
        {
          maxAttempts: 3,
          tag: 'X-FEED/summarize',
          label: `LiteLLM-fallback ${label}`,
        },
      );
      tg.i('X-FEED/summarize', `✓ LiteLLM fallback SUCCEEDED for ${label} model=${result.model_used} ${Date.now() - t0}ms`);
    } catch (litellmErr) {
      tg.e('X-FEED/summarize', `LiteLLM fallback ALSO failed for ${label} ${Date.now() - t0}ms — no digest possible`, litellmErr);
      return null;
    }
  }

  const elapsed = Date.now() - t0;
  const content = result.content || '';

  // Try to extract structured JSON
  const parsed = extractDigestJSON(content);

  if (parsed) {
    tg.i(
      'X-FEED/summarize',
      `✓ ${label} digest: "${parsed.title.slice(0, 50)}" (${elapsed}ms, ${parsed.article.length} chars)`,
    );
    return {
      title: parsed.title,
      excerpt: parsed.excerpt,
      article: parsed.article,
      stats: parsed.stats,
      keyTopics: parsed.keyTopics,
      model: result.model_used || model,
      elapsed,
    };
  }

  // Fallback: raw content is long enough to be useful
  if (content.length > 200) {
    const fallbackTitle = `${handleConfig.displayName}: Market Brief — ${dateShort}`;
    tg.w(
      'X-FEED/summarize',
      `JSON parse failed for ${label} — using raw content fallback (${content.length} chars)`,
    );
    return {
      title: fallbackTitle,
      excerpt: `Daily market analysis from ${handleConfig.displayName}.`,
      article: content,
      stats: [],
      keyTopics: [],
      model: result.model_used || model,
      elapsed,
    };
  }

  tg.e('X-FEED/summarize', `Digest output too short for ${label} (${content.length} chars)`);
  return null;
}

// ── JSON extraction for digest ─────────────────────────────────────────

function extractDigestJSON(text) {
  if (!text) return null;

  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)?.[1]?.trim(),
    (() => {
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      return s !== -1 && e > s ? text.slice(s, e + 1) : null;
    })(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj.article === 'string' && obj.article.length > 100) {
        return {
          title: String(obj.title || '').slice(0, 120),
          excerpt: String(obj.excerpt || '').slice(0, 250),
          article: obj.article,
          stats: Array.isArray(obj.stats) ? obj.stats : [],
          keyTopics: Array.isArray(obj.key_topics) ? obj.key_topics : [],
        };
      }
    } catch {
      /* try next candidate */
    }
  }

  return null;
}
