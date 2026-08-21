'use strict';

// HackerNoon Top Story + TechBeat — viewer-grade ingest.
// Hermetic: no live network. Fixtures mimic the real 2026 HTML/RSS shape.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

const {
  extractCleanArticle,
  scrapeListingPage,
  htmlToRichMarkdown,
  visibleTextLen,
  canonicalArticleUrl,
  selectorsForUrl,
  tidyHackernoonMarkdown,
  hackernoonTechbeatDigestUrl,
  hackernoonTechbeatDigestCandidates,
  isHackernoonStoryPermalink,
  preferStructuredBody,
  decodeBasicEntities,
} = require('../src/news-extract');

const {
  parseFeedItems,
  filterItemsByLinkPattern,
  filterDroppedFeedItems,
  feedArticleCap,
  dedupeFeedItems,
  appendSourceLink,
  buildFullContentMarkdown,
  buildFullContentExcerpt,
} = require('../src/news-service');

const HN_STORY_PATTERN =
  'https?://(?:www\\.)?hackernoon\\.com/(?!tagged/|techbeat/|u/|c/|feed/)(?!\\d{1,2}-\\d{1,2}-\\d{4}-techbeat(?:/|\\?|$))[a-z0-9][a-z0-9$._-]{11,}/?(?:\\?.*)?$';

const HN_ARTICLE_HTML = `<!DOCTYPE html><html><head>
  <meta property="og:title" content="Self-Hosting AI Models on a Raspberry Pi 5: A Complete Guide | HackerNoon" />
  <meta property="og:image" content="https://hackernoon.imgix.net/images/pi5-cover.png" />
  <meta name="author" content="Octopi" />
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    headline: 'Self-Hosting AI Models on a Raspberry Pi 5',
    datePublished: '2026-08-20T15:59:59.000Z',
    articleBody:
      'JSON-LD PLAINTEXT BODY that is deliberately longer than the HTML so a naive length comparison would throw away images. '.repeat(8) +
      'Photo by Amanda Jones on Unsplash Photo by Amanda Jones on Unsplash Amanda Jones Unsplash',
  })}</script>
</head><body>
  <nav>Discover Anything Signup Write New Story</nav>
  <div class="share-bar">Tweet this</div>
  <div class="story-body">
    <div class="prose">
      <p>I’ve been running an AI agent on a Raspberry Pi 5 for the past three months. It writes code, browses the web, and even deployed a production SaaS last week.</p>
      <h2>Why Bother?</h2>
      <p>I was burning through $40-60 a month on API fees before I moved inference onto the Pi sitting on my desk at home.</p>
      <pre><code class="language-bash">curl -fsSL https://ollama.com/install.sh | sh</code></pre>
      <figure><img alt="Raspberry Pi 5 on a desk" src="https://hackernoon.imgix.net/images/pi5.png" width="800" height="420"/></figure>
      <p>If you’ve got a Pi 5 sitting in a drawer, go install Ollama. You’ll be talking to a local LLM in ten minutes.</p>
      <p>Photo by Amanda Jones on Unsplash</p>
    </div>
  </div>
  <aside class="related">More stories you might like</aside>
  <footer>Subscribe to the HackerNoon Newsletter</footer>
</body></html>`;

const HN_DIGEST_HTML = `<!DOCTYPE html><html><body>
  <a href="/8-20-2026-techbeat">The TechBeat: Claude Code (8/20/2026)</a>
  <a href="https://hackernoon.com/homepage-has-a-new-baby?ref=hackernoon.com">Homepage Has a New Baby</a>
  <a href="https://hackernoon.com/navigating-claude-code-the-full-workflow?ref=hackernoon.com">Navigating Claude Code: The Full Workflow</a>
  <a href="/tagged/ai">AI tag</a>
  <a href="https://hackernoon.com/u/techbeat">@techbeat</a>
  <a href="https://hackernoon.com/how-i-built-a-$5-a-month-ai-baby-monitor-on-raspberry-pi">How I Built a $5-a-Month AI Baby Monitor</a>
  <a href="https://hackernoon.com/complement-your-devpost-hackathon-with-a-hackernoon-blogging-contest-for-maximum-media-mentions">Complement Your DevPost Hackathon with a HackerNoon Blogging Contest</a>
  <a href="https://hackernoon.com/designing-agent-memory-five-gates-a-bigger-context-window-cannot-replace">Designing Agent Memory: Five Gates a Bigger Context Window Cannot Replace</a>
  <a href="Read more">Read more</a>
</body></html>`;

const HN_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>HackerNoon - hackernoon-top-story</title>
  <item>
    <title>Self-Hosting AI Models on a Raspberry Pi 5</title>
    <link>https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference?source=rss</link>
    <guid>https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference?source=rss</guid>
    <pubDate>Thu, 20 Aug 2026 15:59:59 GMT</pubDate>
    <category>ai-agents</category>
    <category>hackernoon-top-story</category>
    <content:encoded><![CDATA[<p>Running AI locally on commodity hardware is getting better fast. Read All</p>]]></content:encoded>
  </item>
  <item>
    <title>MemeCore Arrives on Nasdaq Through $1 Billion Landmark Treasury Transaction</title>
    <link>https://hackernoon.com/memecore-arrives-on-nasdaq-through-$1-billion-landmark-treasury-transaction?source=rss</link>
    <guid>https://hackernoon.com/memecore-arrives-on-nasdaq-through-$1-billion-landmark-treasury-transaction?source=rss</guid>
    <pubDate>Thu, 20 Aug 2026 21:26:33 GMT</pubDate>
    <category>press-release</category>
    <category>good-company</category>
    <content:encoded><![CDATA[<p>Sponsored announcement.</p>]]></content:encoded>
  </item>
  <item>
    <title>Complement Your DevPost Hackathon with a HackerNoon Blogging Contest</title>
    <link>https://hackernoon.com/complement-your-devpost-hackathon-with-a-hackernoon-blogging-contest-for-maximum-media-mentions?source=rss</link>
    <guid>https://hackernoon.com/complement-your-devpost-hackathon-with-a-hackernoon-blogging-contest-for-maximum-media-mentions?source=rss</guid>
    <pubDate>Thu, 20 Aug 2026 15:07:45 GMT</pubDate>
    <category>hackernoon-top-story</category>
    <content:encoded><![CDATA[<p>Promo.</p>]]></content:encoded>
  </item>
  <item>
    <title>Designing Agent Memory</title>
    <link>https://hackernoon.com/designing-agent-memory-five-gates-a-bigger-context-window-cannot-replace?source=rss</link>
    <guid>https://hackernoon.com/designing-agent-memory-five-gates-a-bigger-context-window-cannot-replace?source=rss</guid>
    <pubDate>Thu, 20 Aug 2026 07:48:21 GMT</pubDate>
    <category>artificial-intelligence</category>
    <content:encoded><![CDATA[<p>A million-token window enlarges the warehouse.</p>]]></content:encoded>
  </item>
</channel></rss>`;

function livePattern() {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../news_rss_feeds.json'), 'utf8'));
  const top = cfg.feeds.find((f) => f.id === 'hackernoon_top_story');
  return top.item_link_pattern;
}

describe('HackerNoon story permalinks', () => {
  test('accepts long story slugs including $ and tracking query', () => {
    assert.equal(
      isHackernoonStoryPermalink(
        'https://hackernoon.com/how-i-built-a-$5-a-month-ai-baby-monitor-on-raspberry-pi?source=rss',
      ),
      true,
    );
    assert.equal(
      isHackernoonStoryPermalink(
        'https://hackernoon.com/navigating-claude-code-the-full-workflow?ref=hackernoon.com',
      ),
      true,
    );
  });

  test('rejects digest, tag, author, calendar, and short paths', () => {
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/8-20-2026-techbeat'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/tagged/hackernoon-top-story'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/techbeat/2026/08/20'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/u/techbeat'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/c/hackernoon'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/feed'), false);
    assert.equal(isHackernoonStoryPermalink('https://hackernoon.com/new'), false);
    assert.equal(isHackernoonStoryPermalink('https://example.com/some-long-enough-slug-here'), false);
    assert.equal(isHackernoonStoryPermalink(''), false);
    assert.equal(isHackernoonStoryPermalink(null), false);
  });
});

describe('HackerNoon TechBeat digest dates', () => {
  test('uses unpadded M-D-YYYY (live URL shape)', () => {
    const d = new Date(Date.UTC(2026, 7, 20)); // Aug 20
    assert.equal(hackernoonTechbeatDigestUrl(d), 'https://hackernoon.com/8-20-2026-techbeat');
  });

  test('lookback walks UTC midnight and de-dupes', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 15, 0, 0)); // 1 Jan 2026
    const urls = hackernoonTechbeatDigestCandidates(d, 3);
    assert.deepEqual(urls, [
      'https://hackernoon.com/1-1-2026-techbeat',
      'https://hackernoon.com/12-31-2025-techbeat',
      'https://hackernoon.com/12-30-2025-techbeat',
    ]);
  });

  test('clamps lookback to 1..14 and survives bad dates', () => {
    assert.equal(hackernoonTechbeatDigestCandidates(new Date(Date.UTC(2026, 7, 21)), 0).length, 1);
    assert.equal(hackernoonTechbeatDigestCandidates(new Date(Date.UTC(2026, 7, 21)), 99).length, 14);
    assert.ok(hackernoonTechbeatDigestUrl('nope').startsWith('https://hackernoon.com/'));
  });
});

describe('extractCleanArticle — HackerNoon viewer path', () => {
  test('prefers .story-body .prose (images + code) over longer JSON-LD', () => {
    const r = extractCleanArticle(
      HN_ARTICLE_HTML,
      'https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference',
    );
    assert.match(r.title, /Self-Hosting AI Models/);
    assert.doesNotMatch(r.title, /\| HackerNoon/);
    assert.equal(r.image, 'https://hackernoon.imgix.net/images/pi5-cover.png');
    assert.ok(r.content.includes('I’ve been running an AI agent'), r.content);
    assert.ok(r.content.includes('## Why Bother?'), r.content);
    assert.ok(r.content.includes('```bash'), r.content);
    assert.ok(r.content.includes('![Raspberry Pi 5 on a desk](https://hackernoon.imgix.net/images/pi5.png)'), r.content);
    assert.equal(r.content.includes('JSON-LD PLAINTEXT BODY'), false, 'must not clobber rich HTML with JSON-LD');
    assert.equal(r.content.includes('Discover Anything'), false);
    assert.equal(r.content.includes('Tweet this'), false);
    assert.equal(r.content.includes('More stories you might like'), false);
    assert.equal(r.content.includes('Subscribe to the HackerNoon Newsletter'), false);
    assert.equal(r.content.includes('Photo by Amanda Jones'), false);
    assert.ok(r.date instanceof Date);
    assert.equal(r.date.toISOString().slice(0, 10), '2026-08-20');
  });

  test('JSON-LD fallback when the prose block is missing', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Article',
        articleBody:
          'Want to know what&apos;s trending right now?\n\nNavigating Claude Code\n\nNavigating Claude Code\n\n' +
          'A complete workflow for agentic coding on a real codebase with tests, reviews, and rollback. '.repeat(4),
      })}</script>
    </head><body><main><p>Discover Anything Signup</p></main></body></html>`;
    const r = extractCleanArticle(html, 'https://hackernoon.com/navigating-claude-code-the-full-workflow');
    assert.ok(visibleTextLen(r.content) >= 200, r.content);
    assert.ok(r.content.includes("what's trending") || r.content.includes('agentic coding'), r.content);
    // Duplicate heading collapsed.
    assert.equal((r.content.match(/Navigating Claude Code/g) || []).length, 1, r.content);
  });

  test('empty / garbage HTML never throws', () => {
    assert.equal(extractCleanArticle('', 'https://hackernoon.com/x').content, '');
    assert.equal(extractCleanArticle(null, 'https://hackernoon.com/x').content, '');
    const r = extractCleanArticle('<html><body>short</body></html>', 'https://hackernoon.com/x');
    assert.equal(typeof r.content, 'string');
  });
});

describe('HackerNoon digest listing scrape', () => {
  test('keeps ranked stories, drops digest / tags / authors / Read more', () => {
    const raw = scrapeListingPage(HN_DIGEST_HTML, {
      baseUrl: 'https://hackernoon.com/8-20-2026-techbeat',
      linkPattern: HN_STORY_PATTERN,
      max: 20,
    });
    const stories = raw.filter((it) => isHackernoonStoryPermalink(it.link));
    const kept = filterDroppedFeedItems(stories, {
      drop_title_pattern: 'blogging contest|shipaton|^the techbeat by hackernoon',
      drop_link_pattern: 'homepage-has-a-new-baby',
    });
    const titles = kept.map((s) => s.title);
    assert.ok(titles.includes('Navigating Claude Code: The Full Workflow'));
    assert.ok(titles.includes('How I Built a $5-a-Month AI Baby Monitor'));
    assert.ok(titles.includes('Designing Agent Memory: Five Gates a Bigger Context Window Cannot Replace'));
    assert.equal(titles.some((t) => /TechBeat: Claude Code/i.test(t)), false);
    assert.equal(titles.some((t) => t === 'AI tag' || t === '@techbeat' || t === 'Read more'), false);
    // Rank order preserved (Claude before $5 baby monitor before agent memory).
    const claude = titles.indexOf('Navigating Claude Code: The Full Workflow');
    const baby = titles.indexOf('How I Built a $5-a-Month AI Baby Monitor');
    assert.ok(claude < baby);
  });

  test('live config pattern matches digest story hrefs and rejects the digest itself', () => {
    const pattern = livePattern();
    const items = [
      { title: 'digest', link: 'https://hackernoon.com/8-20-2026-techbeat' },
      { title: 'rss', link: 'https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference?source=rss' },
      { title: 'dollar', link: 'https://hackernoon.com/how-i-built-a-$5-a-month-ai-baby-monitor-on-raspberry-pi' },
      { title: 'tag', link: 'https://hackernoon.com/tagged/hackernoon-top-story' },
      { title: 'hub', link: 'https://hackernoon.com/techbeat/2026/08/20' },
    ];
    const out = filterItemsByLinkPattern(items, pattern);
    assert.deepEqual(out.map((i) => i.title), ['rss', 'dollar']);
  });
});

describe('RSS parse + intelligent filters', () => {
  test('parseFeedItems keeps categories, teaser HTML, and tracking guid', () => {
    const items = parseFeedItems(HN_RSS);
    assert.equal(items.length, 4);
    assert.ok(items[0].categories.includes('hackernoon-top-story'));
    assert.ok(items[0].link.includes('?source=rss'));
    assert.ok(items[0].html.includes('commodity hardware'));
    assert.ok(items[1].categories.includes('press-release'));
  });

  test('drops sponsored tags and contest titles, keeps editorial AI stories', () => {
    const items = parseFeedItems(HN_RSS);
    const kept = filterDroppedFeedItems(items, {
      drop_category_tags: ['press-release', 'good-company', 'chainwire'],
      drop_title_pattern: 'blogging contest|shipaton',
    });
    assert.deepEqual(kept.map((i) => i.title), [
      'Self-Hosting AI Models on a Raspberry Pi 5',
      'Designing Agent Memory',
    ]);
  });

  test('invalid drop_title_pattern does not throw', () => {
    const items = [{ title: 'Hello', link: 'https://hackernoon.com/hello-there-long-slug', categories: [] }];
    const out = filterDroppedFeedItems(items, { drop_title_pattern: '(unclosed' });
    assert.equal(out.length, 1);
  });

  test('HTML-instead-of-RSS and empty XML produce zero items', () => {
    assert.deepEqual(parseFeedItems(''), []);
    assert.deepEqual(parseFeedItems('<html><body>not a feed</body></html>'), []);
    assert.deepEqual(parseFeedItems('<?xml version="1.0"?><rss><channel></channel></rss>'), []);
  });

  test('canonical + dedupe collapse ?source=rss vs ?ref= twins', () => {
    const items = [
      { title: 'A', link: 'https://hackernoon.com/navigating-claude-code-the-full-workflow?source=rss' },
      { title: 'A again', link: 'https://www.hackernoon.com/navigating-claude-code-the-full-workflow?ref=hackernoon.com' },
      { title: 'B', link: 'https://hackernoon.com/designing-agent-memory-five-gates-a-bigger-context-window-cannot-replace' },
    ];
    const out = dedupeFeedItems(items);
    assert.equal(out.length, 2);
    assert.equal(
      canonicalArticleUrl(items[0].link),
      canonicalArticleUrl(items[1].link),
    );
  });
});

describe('caps, excerpt, source link', () => {
  test('feedArticleCap prefers per-feed max_articles', () => {
    assert.equal(feedArticleCap({ max_articles: 5 }, { max_articles_per_feed: 3 }), 5);
    assert.equal(feedArticleCap({}, { max_articles_per_feed: 3 }), 3);
    assert.equal(feedArticleCap({ max_articles: 0 }, { max_articles_per_feed: 3 }), 3);
    assert.equal(feedArticleCap({ max_articles: 'nope' }, { max_articles_per_feed: 10 }), 10);
  });

  test('full-content markdown keeps code/images and pins a HackerNoon source link', () => {
    const r = extractCleanArticle(
      HN_ARTICLE_HTML,
      'https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference',
    );
    const md = buildFullContentMarkdown({
      content: r.content,
      url: 'https://hackernoon.com/self-hosting-ai-models-on-a-raspberry-pi-5-a-complete-guide-to-free-private-local-ai-inference',
      source: 'HackerNoon Top Story',
    });
    assert.ok(md.includes('```bash'));
    assert.ok(md.includes('![Raspberry Pi 5 on a desk]'));
    assert.ok(md.includes('🌙'));
    assert.ok(md.includes('Read Original Article'));
    assert.equal(md.includes('<!-- summary-unavailable -->'), false);
    const excerpt = buildFullContentExcerpt(r.content);
    assert.ok(excerpt.length <= 240);
    assert.ok(excerpt.includes('Raspberry Pi') || excerpt.includes('AI agent'));
  });

  test('appendSourceLink is idempotent for hackernoon URLs', () => {
    const once = appendSourceLink('Body.\n\nMore.', 'https://hackernoon.com/x-long-enough', 'HackerNoon');
    const twice = appendSourceLink(once, 'https://hackernoon.com/x-long-enough', 'HackerNoon');
    assert.equal(once, twice);
  });
});

describe('helpers', () => {
  test('decodeBasicEntities and tidyHackernoonMarkdown', () => {
    assert.equal(decodeBasicEntities('what&apos;s up &amp; more'), "what's up & more");
    const tidy = tidyHackernoonMarkdown(
      'Hello hacker. Photo by Amanda Jones on Unsplash Photo by Amanda Jones on Unsplash Amanda Jones Unsplash',
    );
    assert.equal(tidy.includes('Photo by'), false);
    assert.equal(tidy.includes('Unsplash'), false);
    assert.match(tidy, /Hello hacker/);
    assert.equal(tidyHackernoonMarkdown('Body paragraph here.\n\n---\n\n---').includes('---'), false);
  });

  test('preferStructuredBody: images keep HTML, teasers lose to JSON-LD', () => {
    const htmlWithImg = 'A real article paragraph that is long enough to clear the minimum. '.repeat(4) +
      '\n\n![cover](https://cdn.example/x.png)';
    const json = 'JSON body that is even longer than the HTML on purpose so a naive compare would switch. '.repeat(8);
    assert.ok(preferStructuredBody(json, htmlWithImg).includes('!['));
    const htmlWithCode = 'A real article paragraph that is long enough to clear the minimum. '.repeat(4) +
      '\n\n```js\nconsole.log(1)\n```';
    assert.ok(preferStructuredBody(json, htmlWithCode).includes('```js'));
    const teaser = 'Short synopsis only that is still over two hundred characters so the site selector would otherwise keep this teaser instead of the real critic copy from JSON-LD.';
    assert.ok(preferStructuredBody(json, teaser).includes('JSON body'));
  });

  test('htmlToRichMarkdown on a teaser RSS fragment is not treated as a full article', () => {
    const md = htmlToRichMarkdown('<p>Running AI locally on commodity hardware is getting better fast. Read All</p>', {
      baseUrl: 'https://hackernoon.com/x',
    });
    assert.ok(visibleTextLen(md) < 200);
  });

  test('selectors exist for www and bare host', () => {
    assert.ok(selectorsForUrl('https://www.hackernoon.com/x').includes('div.story-body'));
    assert.ok(selectorsForUrl('https://hackernoon.com/x').includes('div.prose'));
  });
});
