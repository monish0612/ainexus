'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseFeedItems,
  resolveConfigPath,
} = require('../src/news-service');

test('API image ships news_rss_feeds.json next to the service', () => {
  const apiCopy = path.resolve(__dirname, '../news_rss_feeds.json');
  assert.ok(fs.existsSync(apiCopy), `missing ${apiCopy}`);
  const cfg = JSON.parse(fs.readFileSync(apiCopy, 'utf8'));
  assert.ok(Array.isArray(cfg.feeds) && cfg.feeds.length >= 10, 'expected the RSS/listing feed list');
  const ids = new Set(cfg.feeds.map((f) => f.id));
  for (const id of ['finshots', 'lensmen_reviews', 'sudhir_film_reviews', 'gizbot_reviews', 'techcrunch_ai']) {
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
