'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseFeedItems,
  resolveConfigPath,
  filterItemsByLinkPattern,
  dedupeFeedItems,
  movieTitleKey,
} = require('../src/news-service');

test('API image ships news_rss_feeds.json next to the service', () => {
  const apiCopy = path.resolve(__dirname, '../news_rss_feeds.json');
  assert.ok(fs.existsSync(apiCopy), `missing ${apiCopy}`);
  const cfg = JSON.parse(fs.readFileSync(apiCopy, 'utf8'));
  assert.ok(Array.isArray(cfg.feeds) && cfg.feeds.length >= 10, 'expected the RSS/listing feed list');
  const ids = new Set(cfg.feeds.map((f) => f.id));
  for (const id of ['finshots', 'lensmen_reviews', 'sudhir_film_reviews', 'gizbot_reviews', 'techcrunch_ai', 'onlykollywood_reviews', 'toi_english_reviews', 'hackernoon_top_story', 'hackernoon_techbeat']) {
    assert.ok(ids.has(id), `expected feed ${id}`);
  }
  assert.ok(cfg.feeds.every((f) => f.enabled !== false), 'all listed feeds should be enabled');
});

test('repo-root and api copies of the feed list stay in sync', () => {
  const apiCopy = path.resolve(__dirname, '../news_rss_feeds.json');
  const rootCopy = path.resolve(__dirname, '../../news_rss_feeds.json');
  if (!fs.existsSync(rootCopy)) return;
  assert.equal(
    fs.readFileSync(apiCopy, 'utf8'),
    fs.readFileSync(rootCopy, 'utf8'),
    'api/news_rss_feeds.json drifted from the repo-root copy',
  );
});

test('resolveConfigPath finds a real feed list', () => {
  const p = resolveConfigPath();
  assert.ok(fs.existsSync(p), p);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(cfg.feeds.length >= 10);
});

test('parseFeedItems reads RSS 2.0 <item> blocks', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title>Movie review: Coolie</title>
        <link>https://example.com/coolie</link>
        <guid>https://example.com/coolie</guid>
        <pubDate>Mon, 17 Aug 2026 04:00:00 GMT</pubDate>
        <description>A review body.</description>
      </item>
      <item>
        <title>Another piece</title>
        <link>https://example.com/two</link>
        <guid>https://example.com/two</guid>
      </item>
    </channel></rss>`;
  const items = parseFeedItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Movie review: Coolie');
  assert.equal(items[0].link, 'https://example.com/coolie');
  assert.ok(items[0].pubRaw.includes('2026'));
});

test('parseFeedItems falls back to Atom <entry> when there are no <item>s', () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom story</title>
        <id>urn:example:1</id>
        <link href="https://example.com/atom"/>
        <published>2026-08-17T08:00:00+05:30</published>
        <content type="html">Hello from atom.</content>
      </entry>
    </feed>`;
  const items = parseFeedItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Atom story');
  assert.ok(items[0].link.includes('example.com/atom'));
});

test('Only Kollywood + TOI Movies feeds are listing/RSS-safe', () => {
  const apiCopy = path.resolve(__dirname, '../news_rss_feeds.json');
  const cfg = JSON.parse(fs.readFileSync(apiCopy, 'utf8'));
  const byId = Object.fromEntries(cfg.feeds.map((f) => [f.id, f]));

  const ok = byId.onlykollywood_reviews;
  assert.equal(ok.app_category, 'Movies');
  assert.equal(ok.skip_summary, true);
  assert.equal(ok.extract_review_meta, true);
  assert.ok(ok.url.endsWith('/category/movie-reviews/feed/'));
  assert.ok(!ok.source_type, 'Only Kollywood must use RSS, not a listing scrape of one article');
  assert.match(ok.listing_link_pattern, /onlykollywood/);

  const toi = byId.toi_english_reviews;
  assert.equal(toi.app_category, 'Movies');
  assert.equal(toi.source_type, 'listing');
  assert.equal(toi.extract_review_meta, true);
  assert.equal(toi.url, 'https://timesofindia.indiatimes.com/entertainment/english/movie-reviews');
  assert.match(toi.listing_link_pattern, /english\/movie-reviews/);
  assert.doesNotMatch(toi.listing_link_pattern, /hindi/);
});

test('HackerNoon feeds land in AI News with viewer-grade extraction', () => {
  const apiCopy = path.resolve(__dirname, '../news_rss_feeds.json');
  const cfg = JSON.parse(fs.readFileSync(apiCopy, 'utf8'));
  const byId = Object.fromEntries(cfg.feeds.map((f) => [f.id, f]));

  const top = byId.hackernoon_top_story;
  assert.ok(top, 'hackernoon_top_story missing');
  assert.equal(top.app_category, 'AI News');
  assert.equal(top.skip_summary, true);
  assert.equal(top.extraction_strategy, 'clean');
  assert.equal(top.url, 'https://hackernoon.com/tagged/hackernoon-top-story/feed');
  assert.ok(!top.source_type, 'top-story must use the tagged RSS, not the HTML listing');
  assert.equal(top.max_age_days, 4);
  assert.equal(top.max_articles, 5);
  assert.ok(top.drop_category_tags.includes('press-release'));
  assert.match(top.item_link_pattern, /hackernoon/);

  const beat = byId.hackernoon_techbeat;
  assert.ok(beat, 'hackernoon_techbeat missing');
  assert.equal(beat.app_category, 'AI News');
  assert.equal(beat.skip_summary, true);
  assert.equal(beat.source_type, 'listing');
  assert.equal(beat.listing_digest, 'hackernoon-techbeat');
  assert.equal(beat.extract_review_meta, undefined);
  assert.equal(beat.url, 'https://hackernoon.com/techbeat');
  assert.match(beat.drop_link_pattern, /homepage-has-a-new-baby/);
  assert.match(beat.listing_link_pattern, /hackernoon/);
  assert.doesNotMatch(beat.listing_link_pattern, /tagged\/hackernoon-top-story\/feed/);
});

test('filterItemsByLinkPattern drops news URLs from the OK reviews feed', () => {
  const pattern = 'https?://(?:www\\.)?onlykollywood\\.com/[a-z0-9-]+-(?:movie-)?review/?$';
  const items = [
    { title: 'DC Movie Review', link: 'https://www.onlykollywood.com/dc-movie-review/' },
    { title: 'Box office news', link: 'https://www.onlykollywood.com/dc-box-office-day-14/' },
    { title: 'Cuckoo', link: 'https://www.onlykollywood.com/cuckoo-review/' },
  ];
  const out = filterItemsByLinkPattern(items, pattern);
  assert.deepEqual(out.map((i) => i.title), ['DC Movie Review', 'Cuckoo']);
});

test('dedupeFeedItems collapses same film twice in one Movies batch', () => {
  const items = [
    { title: 'DC Movie Review: An unfiltered action thriller that hits hard', link: 'https://www.onlykollywood.com/dc-movie-review/' },
    { title: 'DC Movie Review', link: 'https://www.onlykollywood.com/dc-movie-review/?share=1' },
    { title: 'GDN Movie Review: A heartfelt tribute', link: 'https://www.onlykollywood.com/gdn-movie-review/' },
  ];
  const out = dedupeFeedItems(items, { byTitle: true });
  assert.equal(out.length, 2);
  assert.equal(movieTitleKey(items[0].title), 'dc');
  assert.equal(movieTitleKey(items[1].title), 'dc');
});
