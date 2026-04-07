'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Post fetcher via Grok Responses API + x_search tool
//
//  Uses timestamp-based windowing:
//    • "since" = last_window_end (or start-of-today on first run)
//    • "until" = now (at execution time)
//    • Posts after 9 PM automatically roll into next day's digest
// ═══════════════════════════════════════════════════════════════════════

import {
  tg,
  resolveXGrokModel,
  XGROK_API_BASE,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
} from './config.js';
import { withRetry } from './retry.js';

// ── JSON extraction (robust multi-strategy) ────────────────────────────

function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  // 2. Inside ```json ... ``` fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  // 3. First { ... last }
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(trimmed.slice(objStart, objEnd + 1));
    } catch {
      /* continue */
    }
  }

  // 4. First [ ... last ]
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
    } catch {
      /* continue */
    }
  }

  return null;
}

// ── Parse response items from Grok Responses API ───────────────────────

function extractResponseText(data) {
  let text = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text') text += c.text || '';
      }
    }
  }
  return text;
}

// ── Build the fetch prompt ─────────────────────────────────────────────

function buildFetchPrompt(handle, sinceLabel, untilLabel) {
  const system = [
    'You are a data extraction agent with access to X (Twitter) search.',
    'Your ONLY job is to search X and return structured JSON.',
    'NEVER add commentary, explanations, or text outside the JSON.',
    'If you find zero posts, return exactly: {"posts_found": 0, "posts": []}',
  ].join(' ');

  const user = [
    `Search X for all ORIGINAL posts from @${handle}.`,
    '',
    `Time window: from ${sinceLabel} to ${untilLabel}`,
    '',
    'RULES:',
    '- Include ONLY original posts by this user',
    '- EXCLUDE all retweets, reposts, and quote-tweets',
    '- EXCLUDE replies to other users (replies to their OWN thread are OK)',
    '- Include the COMPLETE text of every post — do NOT truncate',
    '- If a post is part of a thread, include each individual post',
    '- For media: include ALL direct image URLs (jpg/jpeg/png) from the post',
    '  These are typically https://pbs.twimg.com/media/... URLs',
    '  Do NOT include video URLs, GIF URLs, or link preview thumbnails',
    '',
    'Return ONLY this JSON structure:',
    '{',
    '  "posts_found": <number>,',
    '  "posts": [',
    '    {',
    '      "text": "<complete post text>",',
    '      "time": "<posting time, e.g. 2:30 PM IST>",',
    '      "has_media": <true|false>,',
    '      "media_urls": ["<direct image URL>", ...],',
    '      "has_links": <true|false>,',
    '      "url": "<post URL or empty string>",',
    '      "is_thread": <true|false>',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  return { system, user };
}

// ── Core fetch function ────────────────────────────────────────────────

/**
 * Fetch original posts from a handle within a time window.
 *
 * @param {string} handle       — X handle without @
 * @param {string} sinceLabel   — human-readable "since" time (for the prompt)
 * @param {string} untilLabel   — human-readable "until" time
 * @returns {Promise<FetchResult>}
 *
 * @typedef {Object} FetchResult
 * @property {number}  postsFound   — count (-1 if JSON extraction failed)
 * @property {Array}   posts        — structured post objects
 * @property {string}  rawResponse  — raw model output (fallback)
 * @property {string}  model        — model used
 * @property {number}  elapsed      — total ms
 */
export async function fetchPostsSince(handle, sinceLabel, untilLabel) {
  const model = resolveXGrokModel('lite');
  const t0 = Date.now();
  const logLabel = `@${handle} [${sinceLabel} → ${untilLabel}]`;

  tg.d('X-FEED/fetch', `▶ Fetching posts: ${logLabel} (model=${model})`);

  const apiKey = process.env.XGROK_API_KEY;
  if (!apiKey) throw new Error('XGROK_API_KEY not configured');

  const { system, user } = buildFetchPrompt(handle, sinceLabel, untilLabel);

  const body = {
    model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_output_tokens: 16384,
    store: false,
    tools: [{ type: 'x_search' }],
  };

  const result = await withRetry(
    async () => {
      const response = await fetch(`${XGROK_API_BASE}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(
          `Grok API ${response.status}: ${errText.slice(0, 300)}`,
        );
        err.status = response.status;
        throw err;
      }

      return response.json();
    },
    {
      maxAttempts: MAX_RETRIES,
      tag: 'X-FEED/fetch',
      label: `fetch ${logLabel}`,
    },
  );

  const responseText = extractResponseText(result);
  const elapsed = Date.now() - t0;

  if (!responseText) {
    tg.e('X-FEED/fetch', `Empty response for ${logLabel} (${elapsed}ms)`);
    return { postsFound: 0, posts: [], rawResponse: '', model, elapsed };
  }

  const parsed = extractJSON(responseText);

  if (parsed && typeof parsed.posts_found === 'number') {
    tg.i(
      'X-FEED/fetch',
      `✓ ${logLabel}: ${parsed.posts_found} posts (${elapsed}ms)`,
    );
    return {
      postsFound: parsed.posts_found,
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      rawResponse: responseText,
      model: result.model || model,
      elapsed,
    };
  }

  // Fallback: JSON extraction failed but we have text
  tg.w(
    'X-FEED/fetch',
    `JSON parse failed for ${logLabel} — using raw text fallback (${responseText.length} chars)`,
  );
  return {
    postsFound: -1,
    posts: [],
    rawResponse: responseText,
    model: result.model || model,
    elapsed,
  };
}
