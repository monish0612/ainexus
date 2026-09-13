'use strict';

// Live network checks against the real TDS / MarkTechPost feeds and the
// capital-letter article that shipped as a gist dump. Skips (does not fail
// the suite) only when the origin is unreachable.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchHtml,
  extractCleanArticle,
  htmlToRichMarkdown,
  proseVisibleLen,
  isMostlyFencedCode,
  looksLikeBotBlockPage,
} = require('../src/news-extract');

const {
  parseFeedItems,
  buildFullContentExcerpt,
  shouldPreferExtractedOverRss,
  needsCodeDumpBodyRepair,
} = require('../src/news-service');

const TDS_ARTICLE =
  'https://towardsdatascience.com/one-capital-letter-was-silently-breaking-my-ai-support-bot-and-it-wasnt-in-the-new-model/';
const TDS_FEED = 'https://towardsdatascience.com/feed/';
const MTP_FEED = 'https://www.marktechpost.com/feed/';

function score(md, label) {
  const prose = proseVisibleLen(md);
  const dump = isMostlyFencedCode(md);
  const excerpt = buildFullContentExcerpt(md);
  return { label, prose, dump, excerpt, head: String(md || '').slice(0, 160) };
}

function assertReadableEssay(md, url) {
  const s = score(md, url);
  assert.equal(s.dump, false, `${url} stored as a code dump: ${s.head}`);
  assert.ok(s.prose >= 400, `${url} prose too thin (${s.prose}): ${s.head}`);
  assert.equal(/BANKING77_EXAMPLE_|import argparse/.test(s.excerpt), false, `excerpt is code: ${s.excerpt}`);
  assert.equal(/^\s*```/.test(s.excerpt), false, `excerpt starts with a fence: ${s.excerpt}`);
}

describe('live extract pipeline', { timeout: 90_000 }, () => {
  test('capital-letter TDS page is the essay, not the gist', async (t) => {
    let html;
    try {
      html = await fetchHtml(TDS_ARTICLE, { logTag: 'LIVE/tds-article' });
    } catch (e) {
      t.skip(`TDS page unreachable: ${e.message}`);
      return;
    }
    const r = extractCleanArticle(html, TDS_ARTICLE);
    assert.ok(r.content.includes('Picture a support inbox'), sHead(r.content));
    assert.equal(/import argparse/.test(r.content), false);
    assertReadableEssay(r.content, TDS_ARTICLE);
    assert.equal(needsCodeDumpBodyRepair(r.content), false);
  });

  test('TDS RSS items prefer live essay over gist-shaped content:encoded', async (t) => {
    let xml;
    try {
      xml = await fetchHtml(TDS_FEED, { logTag: 'LIVE/tds-rss' });
    } catch (e) {
      t.skip(`TDS RSS unreachable: ${e.message}`);
      return;
    }
    const items = parseFeedItems(xml).filter((i) => /towardsdatascience\.com/i.test(i.link || ''));
    assert.ok(items.length >= 1, 'TDS feed returned no story items');

    const sample = items.slice(0, 3);
    for (const item of sample) {
      const rssMd = htmlToRichMarkdown(item.html, { baseUrl: item.link });
      let html;
      try {
        html = await fetchHtml(item.link, { logTag: 'LIVE/tds-item' });
      } catch (e) {
        t.skip(`${item.link} unreachable: ${e.message}`);
        return;
      }
      const extracted = extractCleanArticle(html, item.link);
      const useExtract = shouldPreferExtractedOverRss(extracted.content, rssMd);
      const chosen = useExtract ? extracted.content : rssMd;
      assertReadableEssay(chosen, item.link);
      if (isMostlyFencedCode(rssMd) || proseVisibleLen(rssMd) < 400) {
        assert.equal(useExtract, true, `gist/thin RSS must lose to live extract for ${item.link}`);
      }
    }
  });

  test('MarkTechPost RSS first item still extracts as an article', async (t) => {
    let xml;
    try {
      xml = await fetchHtml(MTP_FEED, { logTag: 'LIVE/mtp-rss' });
    } catch (e) {
      t.skip(`MarkTechPost RSS unreachable: ${e.message}`);
      return;
    }
    if (looksLikeBotBlockPage(xml)) {
      t.skip('MarkTechPost RSS is WAF-blocked from this network');
      return;
    }
    const items = parseFeedItems(xml);
    if (items.length < 1) {
      t.skip('MarkTechPost RSS parsed to zero items');
      return;
    }
    const item = items[0];
    const rssMd = htmlToRichMarkdown(item.html, { baseUrl: item.link });
    let html;
    try {
      html = await fetchHtml(item.link, { logTag: 'LIVE/mtp-item' });
    } catch (e) {
      t.skip(`${item.link} unreachable: ${e.message}`);
      return;
    }
    const extracted = extractCleanArticle(html, item.link);
    const useExtract = shouldPreferExtractedOverRss(extracted.content, rssMd);
    const chosen = useExtract ? extracted.content : rssMd;
    assertReadableEssay(chosen, item.link);
  });
});

function sHead(md) {
  return String(md || '').slice(0, 180);
}
