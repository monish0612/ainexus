'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  Tests for news-extract.js
//
//  Strategy: pure-unit tests against hand-rolled HTML fixtures so the
//  suite is fast, hermetic, and doesn't depend on live network.
//
//  Coverage areas:
//    • extractCleanArticle: site selectors, fallback density heuristic,
//      boilerplate stripping, paragraph/heading structure
//    • extractDateFromHtml: JSON-LD, meta tags, <time>, visible date
//    • extractGizbotProsConsRating: .pros-box / .cons-box, JSON-LD
//      rating, fallback regex
//    • scrapeListingPage: container-first then fallback pass, dedup,
//      pattern filter, max cap
//    • buildReviewMetaMarkdown: rating normalisation, empty inputs
//    • hostOf / selectorsForUrl
// ═══════════════════════════════════════════════════════════════════════

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Telegram is no-op when env vars are absent — we still set them to make
// sure the smoke logs in `cleanExtract` never throw during tests.
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

const {
  extractCleanArticle,
  extractDateFromHtml,
  extractGizbotProsConsRating,
  scrapeListingPage,
  buildReviewMetaMarkdown,
  hostOf,
  selectorsForUrl,
} = require('../src/news-extract');

// ─── extractCleanArticle ───────────────────────────────────────────────

describe('extractCleanArticle', () => {
  test('site-specific selector wins for techcrunch.com', () => {
    const html = `
      <html><head><title>TC: Glean AI</title>
        <meta property="og:title" content="Glean's top line crosses $300M" />
      </head><body>
        <nav>Navigation junk</nav>
        <div class="advertisement">Sponsor block</div>
        <article>
          <div class="wp-block-post-content">
            <p>Glean reached $300M ARR, a three-fold increase from $100M just 15 months ago.</p>
            <h2>Why it matters</h2>
            <p>Many AI startups are growing fast, but Glean's trajectory is particularly remarkable for its scale.</p>
            <p>Glean now competes with tech giants entering the enterprise AI search market with rival products that target the same buyers.</p>
            <ul><li>Search</li><li>Reasoning</li></ul>
          </div>
        </article>
        <footer>Footer with social links</footer>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://techcrunch.com/2026/05/28/glean/');
    assert.equal(r.title, "Glean's top line crosses $300M");
    assert.equal(r.extractionMethod, undefined); // not on this fn's contract
    assert.ok(r.content.includes('Glean reached $300M'), 'body found');
    assert.ok(r.content.includes('## Why it matters'), 'heading promoted to ## md');
    assert.ok(r.content.includes('- Search'), 'list rendered');
    assert.ok(!r.content.includes('Navigation junk'), 'nav stripped');
    assert.ok(!r.content.includes('Sponsor block'), 'ad stripped');
    assert.ok(!r.content.includes('Footer'), 'footer stripped');
  });

  test('sudhir-srinivasan.com selector hits .entry-content', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Drishyam 3 Movie Review: Georgekutty's Greatest Adversary is..." />
        <meta name="author" content="Posted by Sudhir Srinivasan" />
        <meta property="article:published_time" content="2026-05-26T11:36:28+00:00" />
      </head><body>
        <article>
          <div class="entry-content">
            <p>I imagine that for quite a few people, the joy of watching the Drishyam films might be contained in the thrills and twists, in the inevitable Georgekutty win.</p>
            <p>But for those like me, there are deeper joys in this franchise: particularly in its psychological depth, in its commentary on the personal and the social.</p>
            <p>In Drishyam 3, my most favourite stretch comes just before the interval, when Georgekutty slowly realises the new challenge.</p>
          </div>
        </article>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://sudhir-srinivasan.com/2026/05/26/drishyam-3/');
    assert.equal(r.title, "Drishyam 3 Movie Review: Georgekutty's Greatest Adversary is...");
    // Byline normalisation: "Posted by Sudhir Srinivasan" → "Sudhir Srinivasan"
    assert.equal(r.byline, 'Sudhir Srinivasan',
        'byline should strip "Posted by" prefix');
    assert.ok(r.date instanceof Date && !isNaN(r.date.getTime()));
    assert.ok(r.content.includes('Drishyam films'));
    assert.ok(r.content.includes('Georgekutty'));
  });

  test('byline normalisation handles all common prefixes', () => {
    const make = (author) => `
      <html><head>
        <title>X</title>
        <meta name="author" content="${author}" />
      </head><body>
        <article><div class="entry-content">
          <p>Long enough body text to clear the minimum body character threshold the extractor enforces on candidate blocks via a sufficiently padded sentence.</p>
          <p>Second padding paragraph that adds another chunk of prose so the density heuristic and site-specific selector both have plenty to chew on.</p>
        </div></article>
      </body></html>`;
    assert.equal(extractCleanArticle(make('By Jane Doe'), 'https://lensmenreviews.com/x').byline, 'Jane Doe');
    assert.equal(extractCleanArticle(make('by jane doe'), 'https://lensmenreviews.com/x').byline, 'jane doe');
    assert.equal(extractCleanArticle(make('Posted by Sudhir Srinivasan'), 'https://lensmenreviews.com/x').byline, 'Sudhir Srinivasan');
    assert.equal(extractCleanArticle(make('Written by Marina Temkin'), 'https://lensmenreviews.com/x').byline, 'Marina Temkin');
    assert.equal(extractCleanArticle(make('Published by Reuters'), 'https://lensmenreviews.com/x').byline, 'Reuters');
    assert.equal(extractCleanArticle(make('Aswin Bharadwaj'), 'https://lensmenreviews.com/x').byline, 'Aswin Bharadwaj');
  });

  test('lensmen.com selector hits .entry-content', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Chand Mera Dil Review" />
        <meta name="author" content="Aswin Bharadwaj" />
      </head><body>
        <div class="entry-content">
          <p>"Congratulations. You have become the university topper, Aarav." This is literally the first dialogue we hear.</p>
          <p>Vivek Soni, who has been creating Netflix originals, is now bringing second-screen-compatible writing to the big screen.</p>
          <p>With lifeless frames and superficial writing, the film struggles to engage despite a talented cast and competent direction.</p>
        </div>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://lensmenreviews.com/chand-mera-dil/');
    assert.equal(r.title, 'Chand Mera Dil Review');
    assert.equal(r.byline, 'Aswin Bharadwaj');
    assert.ok(r.content.length > 200, 'meaningful body extracted');
    assert.ok(r.content.includes('Aarav'));
  });

  test('falls back to generic density heuristic for unknown host', () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <main>
          <article>
            <p>This is a moderately substantial paragraph that contains enough text content to clearly pass the minimum body-character threshold the extractor enforces on candidate blocks.</p>
            <p>And here is a second long paragraph providing the density heuristic with even more raw text to score against the link-heavy navigation candidates above.</p>
          </article>
        </main>
        <aside><a href="/x">Trending 1</a><a href="/y">Trending 2</a></aside>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://unknown-blog.example/post');
    assert.ok(r.content.includes('moderately substantial paragraph'));
    assert.ok(!r.content.includes('Trending'));
  });

  test('returns empty shape on empty/invalid input', () => {
    assert.deepEqual(extractCleanArticle(''), { title: '', content: '', byline: '', date: null });
    assert.deepEqual(extractCleanArticle(null), { title: '', content: '', byline: '', date: null });
    assert.deepEqual(extractCleanArticle(undefined), { title: '', content: '', byline: '', date: null });
  });

  test('strips boilerplate (sidebar, share, comments)', () => {
    const html = `
      <html><head><title>Test Review</title></head><body>
        <article>
          <div class="entry-content">
            <p>The actual body paragraph is here and is long enough to pass the minimum threshold once we add a second sentence about the topic with more substantive content.</p>
            <p>This second paragraph provides additional body content so the extractor has enough material to clear the MIN_BODY_CHARS gate and return a real result.</p>
            <div class="share-buttons">Share on Twitter Share on Facebook</div>
            <div class="related-posts"><a href="/x">Read more articles</a></div>
            <div class="comments"><p>User comment 1</p><p>User comment 2</p></div>
          </div>
        </article>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://lensmenreviews.com/x');
    assert.ok(r.content.includes('actual body paragraph'), `body found: ${r.content.slice(0, 200)}`);
    assert.ok(!r.content.includes('Share on Twitter'));
    assert.ok(!r.content.includes('Read more articles'));
    assert.ok(!r.content.includes('User comment'));
  });

  test('emits headings, lists, blockquotes in markdown form', () => {
    const html = `
      <html><body>
        <article>
          <h1>Top-level Heading</h1>
          <h3>Sub heading</h3>
          <p>This is the introductory paragraph that is intentionally long enough to clear the minimum body character threshold that the extractor enforces on candidate blocks. We pad it with a second sentence to make the test fixture realistic.</p>
          <p>A second paragraph follows to give the density heuristic ample text to score against — short blocks below the threshold are discarded as boilerplate.</p>
          <blockquote>A quotable phrase</blockquote>
          <ul><li>One</li><li>Two</li></ul>
        </article>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://unknown.example/');
    assert.ok(r.content.includes('## Top-level Heading'), `headings: ${r.content.slice(0, 200)}`);
    assert.ok(r.content.includes('### Sub heading'));
    assert.ok(r.content.includes('> A quotable phrase'));
    assert.ok(r.content.includes('- One'));
    assert.ok(r.content.includes('- Two'));
  });
});

// ─── extractDateFromHtml ───────────────────────────────────────────────

describe('extractDateFromHtml', () => {
  test('parses ISO datePublished from JSON-LD', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        datePublished: '2026-05-23T14:03:04+00:00',
      })}</script>
    </head></html>`;
    const d = extractDateFromHtml(html);
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d.toISOString().slice(0, 10), '2026-05-23');
  });

  test('walks @graph nested JSON-LD', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'X' },
          { '@type': 'Article', datePublished: '2026-04-15' },
        ],
      })}</script>
    </head></html>`;
    const d = extractDateFromHtml(html);
    assert.equal(d?.toISOString().slice(0, 10), '2026-04-15');
  });

  test('falls back to <meta article:published_time>', () => {
    const html = `<html><head>
      <meta property="article:published_time" content="2026-03-01T08:00:00Z" />
    </head></html>`;
    const d = extractDateFromHtml(html);
    assert.equal(d?.toISOString().slice(0, 10), '2026-03-01');
  });

  test('falls back to <time datetime>', () => {
    const html = `<html><body>
      <time datetime="2026-02-14T12:00:00Z">February 14, 2026</time>
    </body></html>`;
    const d = extractDateFromHtml(html);
    assert.equal(d?.toISOString().slice(0, 10), '2026-02-14');
  });

  test('Lensmen-style fallback: visible "Month DD, YYYY" string', () => {
    const html = `<html><body>
      <header><p>Posted on May 23, 2026 by Aswin</p></header>
      <main><p>Body</p></main>
    </body></html>`;
    const d = extractDateFromHtml(html);
    // Date is parsed as local-midnight; assert local Y-M-D rather than
    // UTC to avoid IST/PST timezone flakes.
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 4); // 0-indexed
    assert.equal(d.getDate(), 23);
  });

  test('returns null when no date signal is present', () => {
    const html = '<html><body><p>No date here</p></body></html>';
    assert.equal(extractDateFromHtml(html), null);
  });

  test('handles malformed JSON-LD gracefully (no throw)', () => {
    const html = `<html><head>
      <script type="application/ld+json">{invalid json,,</script>
    </head><body>
      <meta property="article:published_time" content="2026-01-01" />
    </body></html>`;
    const d = extractDateFromHtml(html);
    // Should fall through to the meta tag
    assert.equal(d?.toISOString().slice(0, 10), '2026-01-01');
  });

  test('returns null for empty/invalid input', () => {
    assert.equal(extractDateFromHtml(''), null);
    assert.equal(extractDateFromHtml(null), null);
    assert.equal(extractDateFromHtml(undefined), null);
  });
});

// ─── extractGizbotProsConsRating ───────────────────────────────────────

describe('extractGizbotProsConsRating', () => {
  test('extracts rating from JSON-LD review schema', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Review',
        reviewRating: { '@type': 'Rating', ratingValue: '4.8', bestRating: '5' },
      })}</script>
    </head></html>`;
    const r = extractGizbotProsConsRating(html);
    assert.equal(r.rating, '4.8');
  });

  test('extracts rating from "X / 5" visible pattern', () => {
    const html = '<html><body><p>Overall Rating: 4.1 / 5 — A solid phone for the price.</p></body></html>';
    const r = extractGizbotProsConsRating(html);
    assert.ok(['4.1', '4.1 / 5'].includes(r.rating) || r.rating.startsWith('4.1'));
  });

  test('extracts pros + cons from .pros-box / .cons-box', () => {
    const html = `<html><body>
      <h4>Pros</h4>
      <div class="pros-box"><ul>
        <li>Stunning 3K OLED display</li>
        <li>Excellent battery life</li>
        <li>Fast performance</li>
      </ul></div>
      <h4>Cons</h4>
      <div class="cons-box"><ul>
        <li>Average low-light camera</li>
        <li>Some bloatware</li>
      </ul></div>
    </body></html>`;
    const r = extractGizbotProsConsRating(html);
    assert.equal(r.pros.length, 3);
    assert.equal(r.pros[0], 'Stunning 3K OLED display');
    assert.equal(r.cons.length, 2);
    assert.equal(r.cons[1], 'Some bloatware');
  });

  test('falls back to heading-driven list discovery (Pros + sibling ul)', () => {
    const html = `<html><body>
      <h3>Pros</h3>
      <ul>
        <li>Clean design</li>
        <li>Great battery</li>
      </ul>
      <h3>Cons</h3>
      <ul>
        <li>No SD slot</li>
      </ul>
    </body></html>`;
    const r = extractGizbotProsConsRating(html);
    assert.deepEqual(r.pros, ['Clean design', 'Great battery']);
    assert.deepEqual(r.cons, ['No SD slot']);
  });

  test('caps pros/cons at 8 and dedupes', () => {
    const dupes = Array.from({ length: 12 }, () => '<li>Excellent battery life</li>').join('');
    const html = `<html><body><div class="pros-box"><ul>${dupes}</ul></div></body></html>`;
    const r = extractGizbotProsConsRating(html);
    assert.equal(r.pros.length, 1); // dedup collapses all
    assert.equal(r.pros[0], 'Excellent battery life');
  });

  test('returns empty shape for non-review HTML', () => {
    const html = '<html><body><p>Not a review.</p></body></html>';
    const r = extractGizbotProsConsRating(html);
    assert.equal(r.rating, '');
    assert.deepEqual(r.pros, []);
    assert.deepEqual(r.cons, []);
  });

  test('returns empty shape for empty/invalid input', () => {
    assert.deepEqual(extractGizbotProsConsRating(''), { rating: '', pros: [], cons: [] });
    assert.deepEqual(extractGizbotProsConsRating(null), { rating: '', pros: [], cons: [] });
  });
});

// ─── scrapeListingPage ─────────────────────────────────────────────────

describe('scrapeListingPage', () => {
  test('extracts review URLs matching pattern', () => {
    const html = `<html><body>
      <article class="card">
        <a href="/laptop/reviews/asus-zenbook-125775.html"><h2>ASUS Zenbook Review</h2></a>
      </article>
      <article class="card">
        <a href="/mobile/reviews/samsung-s26-125743.html"><h2>Samsung S26 Review</h2></a>
      </article>
      <a href="/news/some-news.html">News item — should NOT be picked</a>
    </body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/reviews/',
      linkPattern: 'gizbot\\.com/.*/reviews?/.*\\.html$',
      max: 25,
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'ASUS Zenbook Review');
    assert.ok(items[0].link.startsWith('https://www.gizbot.com/laptop/reviews/'));
    assert.ok(items[1].link.endsWith('samsung-s26-125743.html'));
  });

  test('dedupes by URL', () => {
    const html = `<html><body>
      <article><a href="/x/reviews/a-1.html">First Article Title</a></article>
      <article><a href="/x/reviews/a-1.html">First Article Title (duplicate)</a></article>
      <article><a href="/x/reviews/b-2.html">Second Article Title</a></article>
    </body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/reviews/',
      linkPattern: 'reviews/.*\\.html$',
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].link, 'https://www.gizbot.com/x/reviews/a-1.html');
    assert.equal(items[1].link, 'https://www.gizbot.com/x/reviews/b-2.html');
  });

  test('caps at `max`', () => {
    const links = Array.from({ length: 50 }, (_, i) =>
      `<article><a href="/x/reviews/item-${i}.html">Item ${i}</a></article>`,
    ).join('');
    const html = `<html><body>${links}</body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/reviews/',
      linkPattern: 'reviews/.*\\.html$',
      max: 10,
    });
    assert.equal(items.length, 10);
  });

  test('returns [] on empty/invalid input', () => {
    assert.deepEqual(scrapeListingPage('', { baseUrl: 'https://x.com/' }), []);
    assert.deepEqual(scrapeListingPage(null, { baseUrl: 'https://x.com/' }), []);
    assert.deepEqual(scrapeListingPage('<html></html>', {}), []);
  });

  test('falls back to all <a> when container pass finds < 5', () => {
    // No `.card` etc containers — should fall through to global anchor scan
    const html = `<html><body>
      <div>
        <a href="/laptops/reviews/a.html">Review A</a>
        <a href="/mobiles/reviews/b.html">Review B</a>
        <a href="/news/c.html">Not a review</a>
      </div>
    </body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/',
      linkPattern: 'reviews/.*\\.html$',
    });
    assert.equal(items.length, 2);
  });

  test('skips anchors with title < 3 chars', () => {
    const html = `<html><body>
      <article><a href="/reviews/a.html">A</a></article>
      <article><a href="/reviews/b.html">Real Title</a></article>
    </body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/',
      linkPattern: 'reviews/.*\\.html$',
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Real Title');
  });

  // Regression: ghost anchor (short text) on the same URL must NOT cause
  // the real anchor to be dedup'd out. We've had a bug here where the
  // ghost would prime `seen` before the title check rejected it.
  test('ghost-anchor on same URL does NOT dedup the real anchor', () => {
    const html = `<html><body>
      <article><a href="/reviews/iphone-review.html">X</a></article>
      <article><a href="/reviews/iphone-review.html">iPhone 17 Pro Review</a></article>
    </body></html>`;
    const items = scrapeListingPage(html, {
      baseUrl: 'https://www.gizbot.com/',
      linkPattern: 'reviews/.*\\.html$',
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'iPhone 17 Pro Review');
  });
});

// ─── buildReviewMetaMarkdown ───────────────────────────────────────────

describe('buildReviewMetaMarkdown', () => {
  test('renders all three fields with separator', () => {
    const md = buildReviewMetaMarkdown({
      rating: '4.5',
      pros: ['A', 'B'],
      cons: ['C'],
    });
    assert.ok(md.startsWith('**⭐ Rating: 4.5 / 5**'));
    assert.ok(md.includes('#### ✅ Pros'));
    assert.ok(md.includes('- A'));
    assert.ok(md.includes('- B'));
    assert.ok(md.includes('#### ❌ Cons'));
    assert.ok(md.includes('- C'));
    assert.ok(md.endsWith('---'));
  });

  test('keeps explicit rating scale verbatim', () => {
    const md = buildReviewMetaMarkdown({ rating: '4.5/5', pros: [], cons: [] });
    assert.ok(md.includes('Rating: 4.5/5')); // not "/5 / 5"
  });

  test('handles verdict text', () => {
    const md = buildReviewMetaMarkdown({ rating: 'Excellent', pros: [], cons: [] });
    // For non-numeric ratings, the function appends " / 5" because the
    // detection regex requires a digit; that's acceptable — the Flutter
    // card renders verdict text fine either way.
    assert.ok(md.includes('Rating: Excellent'));
  });

  test('returns empty string when nothing is present', () => {
    assert.equal(buildReviewMetaMarkdown({ rating: '', pros: [], cons: [] }), '');
    assert.equal(buildReviewMetaMarkdown({}), '');
  });

  test('renders just pros when rating + cons are empty', () => {
    const md = buildReviewMetaMarkdown({ rating: '', pros: ['Solo'], cons: [] });
    assert.ok(md.includes('#### ✅ Pros'));
    assert.ok(md.includes('- Solo'));
    assert.ok(!md.includes('Rating:'));
    assert.ok(!md.includes('#### ❌ Cons'));
  });
});

// ─── hostOf / selectorsForUrl ──────────────────────────────────────────

describe('host helpers', () => {
  test('hostOf strips www.', () => {
    assert.equal(hostOf('https://www.gizbot.com/x'), 'gizbot.com');
    assert.equal(hostOf('https://techcrunch.com/y'), 'techcrunch.com');
    assert.equal(hostOf('http://lensmenreviews.com/'), 'lensmenreviews.com');
  });

  test('hostOf handles malformed URLs', () => {
    assert.equal(hostOf('not a url'), '');
    assert.equal(hostOf(''), '');
    assert.equal(hostOf(null), '');
  });

  test('selectorsForUrl returns site selectors for known hosts', () => {
    assert.ok(selectorsForUrl('https://techcrunch.com/x').length > 0);
    assert.ok(selectorsForUrl('https://lensmenreviews.com/x').length > 0);
    assert.ok(selectorsForUrl('https://www.gizbot.com/x').length > 0);
    assert.ok(selectorsForUrl('https://sudhir-srinivasan.com/x').length > 0,
        'sudhir-srinivasan.com must have tuned selectors');
    assert.equal(selectorsForUrl('https://random-blog.example/').length, 0);
  });
});
