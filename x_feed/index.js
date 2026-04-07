'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  X FEED — Public API & orchestration
//
//  This is the ONLY file imported by server.js and routes.
//  Orchestrates: fetch → summarize → store for each handle per day.
//
//  Sync window logic (post-9-PM catch-up):
//    • Tracks last_window_end per handle (a UTC timestamp)
//    • First run: window starts at midnight IST today
//    • Subsequent runs: window starts at last_window_end
//    • Window always ends at "now" (execution time)
//    • Posts after 9 PM automatically included in next day's digest
// ═══════════════════════════════════════════════════════════════════════

import { nowIso } from '../db.js';
import { tg, isXGrokAvailable, X_FEED_HANDLES } from './config.js';
import { sleep } from './retry.js';
import { getSyncState, updateSyncState, insertDigestArticle, buildGuid, articleExists } from './store.js';
import { fetchPostsSince } from './fetcher.js';
import { analyzePostImages } from './vision.js';
import { generateDigest } from './summarizer.js';
import {
  startScheduler,
  stopScheduler,
  isSchedulerActive,
  msUntilNextRun,
  todayISTString,
  formatDateLong,
  formatDateShort,
  startOfTodayISTasUTC,
  buildWindowLabels,
} from './scheduler.js';

// ── State ──────────────────────────────────────────────────────────────

let _activeSyncPromise = null;
let _lastRunResult = null;

// ── Process a single handle ────────────────────────────────────────────

async function processHandle(handleConfig) {
  const { handle, displayName, category, tag, defaultImage } = handleConfig;
  const t0 = Date.now();
  const today = todayISTString();
  const dateShort = formatDateShort(today);
  const dateLong = formatDateLong(today);
  const guid = buildGuid(handle, dateShort);

  tg.d('X-FEED/run', `▶ Processing @${handle} for ${dateShort}`);

  // ── 1. Check dedup — uses SAME date format as insertDigestArticle
  if (articleExists(guid)) {
    tg.d('X-FEED/run', `⏭ @${handle} ${dateShort} already has a digest — skipping`);
    return { handle, skipped: true, reason: 'exists' };
  }

  // ── 2. Determine sync window
  const state = getSyncState(handle);
  const windowStart = state?.last_window_end || startOfTodayISTasUTC();
  const windowEnd = new Date().toISOString();
  const { sinceLabel, untilLabel } = buildWindowLabels(windowStart, windowEnd);

  tg.d('X-FEED/run', `@${handle} window: ${sinceLabel} → ${untilLabel}`);

  // ── 3. Fetch posts
  let fetchResult;
  try {
    fetchResult = await fetchPostsSince(handle, sinceLabel, untilLabel);
  } catch (e) {
    tg.e('X-FEED/run', `Fetch failed for @${handle}`, e);
    updateSyncState(handle, windowEnd, { error: `fetch: ${e.message}` });
    return { handle, skipped: false, error: `fetch: ${e.message}` };
  }

  // ── 4. No posts → update window, skip article
  if (fetchResult.postsFound === 0) {
    tg.i('X-FEED/run', `No posts from @${handle} in window — window advanced`);
    updateSyncState(handle, windowEnd, { postsProcessed: 0 });
    return { handle, skipped: true, reason: 'no_posts' };
  }

  // ── 4b. Vision analysis — analyze images/charts in posts
  let visionResult = null;
  const hasAnyMedia = fetchResult.posts.some((p) => p.has_media);
  if (hasAnyMedia) {
    try {
      visionResult = await analyzePostImages(fetchResult.posts);
      tg.d(
        'X-FEED/run',
        `@${handle} vision: ${visionResult.analyzed}/${visionResult.totalImages} images (${visionResult.elapsed}ms)`,
      );
    } catch (e) {
      tg.w('X-FEED/run', `Vision analysis failed for @${handle} — continuing without: ${e.message}`);
    }
  }

  // ── 5. Generate digest article
  let digest;
  try {
    digest = await generateDigest(handleConfig, fetchResult, dateLong, dateShort, visionResult);
  } catch (e) {
    tg.e('X-FEED/run', `Summarize failed for @${handle}`, e);
    updateSyncState(handle, windowEnd, {
      postsProcessed: fetchResult.postsFound > 0 ? fetchResult.postsFound : 0,
      error: `summarize: ${e.message}`,
    });
    return { handle, skipped: false, error: `summarize: ${e.message}` };
  }

  if (!digest) {
    tg.w('X-FEED/run', `No digest generated for @${handle}`);
    updateSyncState(handle, windowEnd, { error: 'empty_digest' });
    return { handle, skipped: false, error: 'empty_digest' };
  }

  // ── 6. Store article
  const postsCount =
    fetchResult.postsFound > 0
      ? fetchResult.postsFound
      : fetchResult.posts.length;

  const readTime = Math.max(
    1,
    Math.round(
      digest.article.split(/\s+/).filter(Boolean).length / 220,
    ),
  );

  const publishedAt = new Date(
    today + 'T15:30:00.000Z',
  ).toISOString(); // 9 PM IST in UTC

  const contentMeta = {
    sourceId: `x-feed-${handle.toLowerCase()}`,
    xHandle: `@${handle}`,
    postsCount,
    originalUrl: `https://x.com/${handle}`,
    publishedAt,
    summaryMarkdown: digest.article,
    keyTopics: digest.keyTopics,
    blocks:
      digest.stats.length > 0
        ? [{ type: 'stat', items: digest.stats.map((s) => ({ value: s.value, label: s.label })) }]
        : [],
  };

  try {
    // ── 7. Update sync state FIRST — ensures row exists for incrementArticleCount
    updateSyncState(handle, windowEnd, { postsProcessed: postsCount });

    const articleId = insertDigestArticle({
      handle,
      dateStr: dateShort,
      title: digest.title,
      excerpt: digest.excerpt,
      category,
      tag,
      source: displayName,
      image: defaultImage,
      readTime,
      summaryMarkdown: digest.article,
      publishedAt,
      contentMeta,
    });

    if (!articleId) {
      return { handle, skipped: true, reason: 'exists' };
    }

    const elapsed = Date.now() - t0;
    const visionSummary = visionResult
      ? `Vision: ${visionResult.analyzed}/${visionResult.totalImages} (${visionResult.elapsed}ms)`
      : 'Vision: n/a';
    tg.i('X-FEED/run', [
      `✅ @${handle} digest complete!`,
      `Title: "${digest.title}"`,
      `Posts: ${postsCount} | Read: ${readTime} min`,
      `Fetch: ${fetchResult.elapsed}ms | ${visionSummary} | Summarize: ${digest.elapsed}ms | Total: ${elapsed}ms`,
    ].join(' | '));

    return {
      handle,
      skipped: false,
      success: true,
      articleId,
      title: digest.title,
      postsCount,
      readTime,
      imagesAnalyzed: visionResult?.analyzed || 0,
      elapsed,
    };
  } catch (e) {
    tg.e('X-FEED/run', `DB insert failed for @${handle}`, e);
    return { handle, skipped: false, error: `store: ${e.message}` };
  }
}

// ── Main sync orchestrator ─────────────────────────────────────────────

async function runDailySync({ reason = 'scheduled' } = {}) {
  if (_activeSyncPromise) {
    tg.d('X-FEED/sync', `Already running — dedup (reason=${reason})`);
    return _activeSyncPromise;
  }

  _activeSyncPromise = (async () => {
    const syncT0 = Date.now();
    const today = todayISTString();
    tg.i('X-FEED/sync', `▶ X Feed sync starting (reason=${reason}, date=${today})`);

    if (!isXGrokAvailable()) {
      const msg = 'xGrok unavailable — XGROK_API_KEY not set';
      tg.e('X-FEED/sync', msg);
      _lastRunResult = { success: false, error: msg, reason, timestamp: nowIso() };
      return _lastRunResult;
    }

    const results = [];
    let totalNew = 0;
    let totalErrors = 0;

    for (const handleConfig of X_FEED_HANDLES) {
      try {
        const result = await processHandle(handleConfig);
        results.push(result);
        if (result.success) totalNew++;
        if (result.error) totalErrors++;
      } catch (e) {
        totalErrors++;
        tg.e('X-FEED/sync', `Unhandled error for @${handleConfig.handle}`, e);
        results.push({
          handle: handleConfig.handle,
          skipped: false,
          error: e.message,
        });
      }

      // Rate limiting between handles
      if (X_FEED_HANDLES.length > 1) {
        await sleep(2000);
      }
    }

    const syncElapsed = Date.now() - syncT0;
    _lastRunResult = {
      success: totalErrors === 0,
      reason,
      timestamp: nowIso(),
      date: today,
      totalNew,
      totalErrors,
      results,
      elapsedMs: syncElapsed,
    };

    const summary = results
      .map((r) => {
        if (r.success) return `@${r.handle} ✅ "${r.title?.slice(0, 30)}"`;
        if (r.skipped) return `@${r.handle} ⏭ ${r.reason}`;
        return `@${r.handle} ❌ ${r.error?.slice(0, 50)}`;
      })
      .join(' | ');

    tg.i('X-FEED/sync', `✓ Done (${reason}): ${summary} — ${syncElapsed}ms`);
    return _lastRunResult;
  })().catch((e) => {
    tg.e('X-FEED/sync', `Sync CRASHED (${reason})`, e);
    _lastRunResult = {
      success: false,
      error: e.message,
      reason,
      timestamp: nowIso(),
    };
    throw e;
  });

  try {
    return await _activeSyncPromise;
  } finally {
    _activeSyncPromise = null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export function startXFeedScheduler() {
  startScheduler(runDailySync);
}

export function stopXFeedScheduler() {
  stopScheduler();
}

export async function manualXFeedSync() {
  return runDailySync({ reason: 'manual' });
}

export function getXFeedStatus() {
  const handles = X_FEED_HANDLES.map((h) => {
    const state = getSyncState(h.handle);
    return {
      handle: h.handle,
      displayName: h.displayName,
      lastWindowEnd: state?.last_window_end || null,
      lastSyncAt: state?.last_sync_at || null,
      totalArticles: state?.total_articles || 0,
      totalPostsProcessed: state?.total_posts_processed || 0,
      lastError: state?.last_error || null,
    };
  });

  return {
    schedulerActive: isSchedulerActive(),
    xgrokAvailable: isXGrokAvailable(),
    lastRunResult: _lastRunResult,
    handles,
    schedule: {
      timeIST: `${21}:00`,
      nextRunMs: msUntilNextRun(),
      nextRunHours: (msUntilNextRun() / 3600000).toFixed(1),
    },
  };
}
