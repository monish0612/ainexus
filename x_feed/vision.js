'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Vision analysis for post images (charts, data, screenshots)
//
//  Uses Grok's image understanding via the Responses API to extract
//  structured data from finance charts, graphs, and visual content
//  embedded in X posts.
//
//  Flow:
//    1. Collect all image URLs from fetched posts
//    2. Validate & deduplicate URLs
//    3. Analyze each image in parallel (concurrency-limited)
//    4. Return enriched descriptions keyed by post index
// ═══════════════════════════════════════════════════════════════════════

import {
  tg,
  resolveXGrokModel,
  XGROK_API_BASE,
  VISION_TIMEOUT_MS,
  VISION_CONCURRENCY,
  VISION_MAX_RETRIES,
  VISION_MAX_IMAGES_PER_RUN,
} from './config.js';
import { withRetry, createLimiter } from './retry.js';

// ── Validate image URLs ─────────────────────────────────────────────

const ALLOWED_IMAGE_EXTENSIONS = /\.(jpe?g|png)(\?.*)?$/i;
const ALLOWED_IMAGE_HOSTS = [
  'pbs.twimg.com',
  'abs.twimg.com',
  'ton.twimg.com',
  'upload.wikimedia.org',
  'i.imgur.com',
];

function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_IMAGE_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return true;
    }
    if (ALLOWED_IMAGE_EXTENSIONS.test(parsed.pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Collect all images from posts ───────────────────────────────────

/**
 * @typedef {Object} ImageTask
 * @property {number} postIndex  — index in the posts array
 * @property {string} url        — direct image URL
 * @property {string} postText   — first 200 chars of the post text (context)
 */

function collectImageTasks(posts) {
  const tasks = [];
  const seen = new Set();

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    if (!post.has_media) continue;

    const urls = Array.isArray(post.media_urls) ? post.media_urls : [];

    for (const url of urls) {
      if (!isValidImageUrl(url)) continue;

      const normalized = url.split('?')[0].toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      tasks.push({
        postIndex: i,
        url,
        postText: (post.text || '').slice(0, 200),
      });
    }
  }

  return tasks;
}

// ── Build vision prompt ─────────────────────────────────────────────

function buildVisionPrompt(postText) {
  return [
    'You are a financial chart/image analyst. Analyze this image from a finance-focused X (Twitter) post.',
    '',
    'POST CONTEXT (the tweet text this image accompanied):',
    `"${postText}"`,
    '',
    'EXTRACT AND DESCRIBE:',
    '1. Chart type (line, bar, candlestick, area, table, screenshot, infographic, etc.)',
    '2. All numerical data points visible — exact values, prices, percentages, dates',
    '3. Axis labels, legends, time ranges covered',
    '4. Key trends: direction (up/down/sideways), inflection points, notable moves',
    '5. Any annotations, highlighted zones, or callout text on the chart',
    '6. Color coding or category distinctions',
    '',
    'RULES:',
    '- Be PRECISE with numbers — "$115.50" not "around $115"',
    '- If this is NOT a chart/graph (e.g. a meme, photo, logo), say "non-chart: <brief description>"',
    '- Keep output concise but data-dense — under 300 words',
    '- Focus on data that would help summarize a financial news article',
    '',
    'Return a plain text analysis. No JSON needed.',
  ].join('\n');
}

// ── Analyze a single image via Grok Responses API ───────────────────

async function analyzeOneImage(task, model) {
  const apiKey = process.env.XGROK_API_KEY;
  if (!apiKey) throw new Error('XGROK_API_KEY not configured');

  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: task.url,
            detail: 'high',
          },
          {
            type: 'input_text',
            text: buildVisionPrompt(task.postText),
          },
        ],
      },
    ],
    temperature: 0.1,
    max_output_tokens: 2048,
    store: false,
  };

  const response = await fetch(`${XGROK_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Grok Vision ${response.status}: ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  let text = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text') text += c.text || '';
      }
    }
  }

  return text.trim();
}

// ── Public: analyze all images from a set of posts ──────────────────

/**
 * Analyze all images found in fetched posts using Grok's vision model.
 *
 * @param {Array} posts      — posts array from fetcher
 * @returns {Promise<VisionResults>}
 *
 * @typedef {Object} VisionResults
 * @property {number}  totalImages     — images found
 * @property {number}  analyzed        — successfully analyzed
 * @property {number}  failed          — analysis failures
 * @property {number}  elapsed         — total ms
 * @property {Array<VisionItem>}  items — analysis results
 *
 * @typedef {Object} VisionItem
 * @property {number}  postIndex — maps back to the post in the posts array
 * @property {string}  url       — image URL
 * @property {string}  analysis  — vision model's description
 * @property {boolean} success
 */
export async function analyzePostImages(posts) {
  const t0 = Date.now();

  if (!posts || posts.length === 0) {
    return { totalImages: 0, analyzed: 0, failed: 0, elapsed: 0, items: [] };
  }

  const tasks = collectImageTasks(posts);

  if (tasks.length === 0) {
    tg.d('X-FEED/vision', 'No valid image URLs found in posts');
    return { totalImages: 0, analyzed: 0, failed: 0, elapsed: Date.now() - t0, items: [] };
  }

  if (tasks.length > VISION_MAX_IMAGES_PER_RUN) {
    tg.w(
      'X-FEED/vision',
      `Capping images: ${tasks.length} found, limit ${VISION_MAX_IMAGES_PER_RUN}`,
    );
    tasks.length = VISION_MAX_IMAGES_PER_RUN;
  }

  const model = resolveXGrokModel('lite');
  tg.i('X-FEED/vision', `▶ Analyzing ${tasks.length} image(s) from ${posts.length} posts (model=${model})`);

  const limit = createLimiter(VISION_CONCURRENCY);
  const items = [];
  let analyzed = 0;
  let failed = 0;

  const promises = tasks.map((task) =>
    limit(async () => {
      const shortUrl = task.url.length > 60
        ? task.url.slice(0, 57) + '...'
        : task.url;

      try {
        const analysis = await withRetry(
          () => analyzeOneImage(task, model),
          {
            maxAttempts: VISION_MAX_RETRIES,
            tag: 'X-FEED/vision',
            label: `image post#${task.postIndex + 1} ${shortUrl}`,
          },
        );

        if (analysis && analysis.length > 10) {
          analyzed++;
          tg.d('X-FEED/vision', `✓ Post#${task.postIndex + 1}: ${analysis.slice(0, 80)}...`);
          items.push({
            postIndex: task.postIndex,
            url: task.url,
            analysis,
            success: true,
          });
        } else {
          failed++;
          tg.w('X-FEED/vision', `Empty analysis for post#${task.postIndex + 1} ${shortUrl}`);
          items.push({
            postIndex: task.postIndex,
            url: task.url,
            analysis: '',
            success: false,
          });
        }
      } catch (e) {
        failed++;
        tg.e('X-FEED/vision', `Failed post#${task.postIndex + 1} ${shortUrl}: ${e.message}`);
        items.push({
          postIndex: task.postIndex,
          url: task.url,
          analysis: '',
          success: false,
        });
      }
    }),
  );

  await Promise.allSettled(promises);

  const elapsed = Date.now() - t0;
  tg.i(
    'X-FEED/vision',
    `✓ Vision complete: ${analyzed}/${tasks.length} analyzed, ${failed} failed (${elapsed}ms)`,
  );

  return {
    totalImages: tasks.length,
    analyzed,
    failed,
    elapsed,
    items: items.sort((a, b) => a.postIndex - b.postIndex),
  };
}
