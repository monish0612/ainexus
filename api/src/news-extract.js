'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  NEWS-EXTRACT — trafilatura-grade clean main-content extraction
//
//  Designed as a lightweight Node port of the Python `trafilatura`
//  approach used for the Movies + General feeds. Site-specific selectors
//  do the heavy lifting; a generic "largest text block" heuristic is the
//  fallback so a tomorrow-feed without a hand-tuned selector still works.
//
//  Public surface (all pure or fetch-once, all retried):
//    • fetchHtml(url, opts)              — robust GET with retry + UA
//    • extractCleanArticle(html, url)    — { title, content, byline, date }
//    • extractGizbotProsConsRating(html) — { rating, pros[], cons[] }
//    • extractDateFromHtml(html)         — Lensmen-style HTML date fallback
//    • scrapeListingPage(html, opts)     — Gizbot listing → [{title,link,image}]
//    • cleanExtract(url, opts)           — one-shot pipeline w/ retry + tg logs
//
//  Failure mode: every helper returns gracefully on bad input (empty
//  string, empty object, empty array). Callers can rely on shapes never
//  being null. All hot paths emit telegram logs via `./telegram`.
//
//  Tests live in `test/news-extract.test.js`.
// ═══════════════════════════════════════════════════════════════════════

const cheerio = require('cheerio');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { tg } = require('./telegram');

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Header set deliberately tuned for maximum compatibility across our
// target sites. Two non-obvious requirements:
//   1. Node's `fetch` auto-injects `Sec-Fetch-Mode: cors`, which Gizbot
//      (and increasingly other bot-protected sites) interpret as
//      "browser fetch() call to a third-party origin" and 403. We
//      override to `navigate` so the request looks like a normal
//      top-level page navigation.
//   2. We do NOT advertise `br` in Accept-Encoding because Node's
//      undici doesn't always auto-decompress brotli responses cleanly,
//      and some origins (also Gizbot) flag bare-brotli requests.
const DEFAULT_HEADERS = {
  'User-Agent': DEFAULT_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// Site-specific main-content selectors. Order matters — the first match
// that yields ≥ MIN_BODY_CHARS wins. We deliberately list multiple
// fallbacks per host because WordPress themes (Lensmen) and bespoke CMSes
// (TechCrunch, Gizbot) routinely rename their wrapper class on theme
// updates. Keeping a stack of 3-4 here is cheap insurance.
const SITE_SELECTORS = {
  'techcrunch.com': [
    'div.article-content',
    'div.wp-block-post-content',
    'div.entry-content',
    'article .post-content',
    'article',
  ],
  'lensmenreviews.com': [
    'div.entry-content',
    'div.post-content',
    'div.td-post-content',
    'article .content',
    'article',
  ],
  'sudhir-srinivasan.com': [
    // WordPress.com theme — entry-content wraps the review body cleanly,
    // with only ~5% link-noise (the "Read More" inline links).
    'div.entry-content',
    'article .entry-content',
    'div.post-content',
    'article',
  ],
  'artificialintelligence-news.com': [
    // Standard WordPress Gutenberg site — the `content:encoded` block in
    // the RSS feed already ships the full article body wrapped in
    // `wp-block-paragraph` / `wp-block-heading` elements, so 99% of the
    // time `cleanExtract` never needs to hit the live page. These
    // selectors are the safety net for the rare "RSS body too short"
    // path that triggers a fetch-and-extract (long-form features that
    // exceed the feed's truncation budget).
    'div.entry-content',
    'div.wp-block-post-content',
    'article .entry-content',
    'article',
  ],
  'gizbot.com': [
    // Real production selector observed on review pages — wraps the
    // entire body including section.overview-section blocks.
    'div.ds-article-content-desc',
    'div.article_main',
    'div.article-content',
    'div.post-content',
    'div.story-content',
    'article',
  ],
};

const BOILERPLATE_SELECTORS = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside',
  'form', 'iframe', 'svg', 'button', 'input', 'select', 'textarea',
  // ad / promotional containers (class & id substring match)
  '[class*="advertisement" i]', '[class*="ads-" i]', '[class*="-ads" i]',
  '[class*="adsense" i]', '[class*="taboola" i]', '[class*="outbrain" i]',
  '[id*="ad-" i]', '[id*="-ad" i]',
  // social / share / subscribe
  '[class*="share" i]', '[class*="social" i]', '[class*="subscribe" i]',
  '[class*="newsletter" i]', '[class*="signup" i]',
  // recirculation widgets
  '[class*="related" i]', '[class*="recommend" i]', '[class*="trending" i]',
  '[class*="popular" i]', '[class*="more-stories" i]',
  // comments / author / meta junk
  '[class*="comment" i]', '[class*="author-bio" i]', '[class*="breadcrumb" i]',
  // cookie / popup / modal
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="popup" i]',
  '[class*="modal" i]', '[class*="banner" i]',
  // figure captions can survive but rarely add value to TTS / markdown
  'figure figcaption', '.wp-caption-text',
];

const MIN_BODY_CHARS = 200; // a "good" main-content block must clear this
const MAX_BODY_CHARS = 18000; // upstream LLM context cap; trim hard here

// ─── Helpers ────────────────────────────────────────────────────────────

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function selectorsForUrl(url) {
  const host = hostOf(url);
  for (const [domain, sel] of Object.entries(SITE_SELECTORS)) {
    if (host.endsWith(domain)) return sel;
  }
  return [];
}

function _shortErr(e) {
  return (e && (e.message || String(e)) || 'unknown').slice(0, 120);
}

// ─── HTML normalization ─────────────────────────────────────────────────

/**
 * Strips boilerplate, walks the chosen main-content block and emits a
 * paragraph-and-heading text stream that downstream markdown formatters
 * (`buildFullContentMarkdown` in news-service.js) can lay out cleanly.
 *
 * Returns paragraphs joined by `\n\n` so the upstream paragraph splitter
 * hits the explicit-blank-line path (≥ 3 paras) rather than the
 * sentence-grouped fallback.
 */
function _flattenMainBlock($, mainEl) {
  const paragraphs = [];

  mainEl.find(BOILERPLATE_SELECTORS.join(',')).remove();
  mainEl.find('br').replaceWith('\n');

  // Walk direct + nested block-level descendants in document order.
  // We intentionally ignore raw spans / inline text outside p/h*/li/blockquote
  // because those are 99% nav glue, byline rows, or pagination hints.
  mainEl.find('h1, h2, h3, h4, p, li, blockquote, pre').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const raw = $el.text().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return;
    if (raw.length < 2) return;

    if (tag === 'h1' || tag === 'h2') {
      paragraphs.push(`## ${raw}`);
    } else if (tag === 'h3' || tag === 'h4') {
      paragraphs.push(`### ${raw}`);
    } else if (tag === 'blockquote') {
      paragraphs.push(`> ${raw}`);
    } else if (tag === 'li') {
      paragraphs.push(`- ${raw}`);
    } else if (tag === 'pre') {
      // Preserve as fenced block; this is rare in news content but TC + Gizbot
      // occasionally embed code snippets.
      paragraphs.push('```\n' + raw + '\n```');
    } else {
      paragraphs.push(raw);
    }
  });

  // Collapse adjacent identical lines that some themes emit (e.g. heading
  // duplicated as <h2> AND <p><strong>...</strong></p>).
  const deduped = [];
  for (const p of paragraphs) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== p) {
      deduped.push(p);
    }
  }

  return deduped.join('\n\n').trim();
}

// ─── extractCleanArticle ────────────────────────────────────────────────

/**
 * Extracts main article content from raw HTML in trafilatura style.
 *
 * Algorithm:
 *   1. Site-specific selector stack (when host has a tuned entry).
 *   2. Generic fallback: pick the descendant with the highest text-length
 *      density (text chars ÷ link chars) under <main>/<article>/<body>.
 *   3. If both fail, return `''` — the caller decides whether to fall
 *      back to the raw RSS excerpt.
 */
function extractCleanArticle(html, url = '') {
  if (!html || typeof html !== 'string') {
    return { title: '', content: '', byline: '', date: null };
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    tg.d('NEWS/extract', `cheerio.load failed: ${_shortErr(e)}`);
    return { title: '', content: '', byline: '', date: null };
  }

  // ── Title (og:title > <title> > h1) ───────────────────────────────────
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    '';

  // ── Byline ────────────────────────────────────────────────────────────
  const byline =
    $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    $('[rel="author"]').first().text() ||
    $('.author, .byline, .post-author').first().text() ||
    '';

  // ── Date (multiple signals; prefer JSON-LD > og: > <time>) ────────────
  const date = extractDateFromHtml(html, $);

  // Drop boilerplate before content selection so density math is accurate.
  $(BOILERPLATE_SELECTORS.join(',')).remove();

  // ── Strategy 1: site-specific selectors ───────────────────────────────
  let content = '';
  for (const sel of selectorsForUrl(url)) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const flat = _flattenMainBlock($, el);
    if (flat.length >= MIN_BODY_CHARS) {
      content = flat;
      break;
    }
  }

  // ── Strategy 2: generic density heuristic ─────────────────────────────
  if (!content) {
    let bestText = '';
    let bestScore = 0;
    const candidates = $('article, main, [role="main"], div').slice(0, 200);
    candidates.each((_, el) => {
      const $el = $(el);
      // Skip obvious wrappers
      if ($el.find('article, main').length > 0) return;
      const flat = _flattenMainBlock($, $el);
      if (flat.length < MIN_BODY_CHARS) return;
      // Density = text length ÷ (link char count + 1) — penalises link
      // farms / nav menus that survived boilerplate stripping.
      const linkChars = $el.find('a').text().length || 0;
      const score = flat.length / (linkChars + 1);
      if (score > bestScore) {
        bestScore = score;
        bestText = flat;
      }
    });
    content = bestText;
  }

  if (content.length > MAX_BODY_CHARS) {
    content = content.slice(0, MAX_BODY_CHARS);
  }

  return {
    title: title.trim(),
    content: content.trim(),
    // Normalise common byline prefixes ("By ...", "Posted by ...",
    // "Written by ...") to a bare author name. Themes vary wildly here —
    // this regex keeps a single clean form across all 4 supported feeds.
    byline: byline
      .trim()
      .replace(/^(?:posted|written|published)\s+by\s+/i, '')
      .replace(/^by\s+/i, '')
      .trim(),
    date,
  };
}

// ─── extractDateFromHtml — multi-signal date discovery ─────────────────

/**
 * Best-effort published-date extraction from arbitrary article HTML.
 *
 * Signals (highest precedence first):
 *   1. JSON-LD `datePublished` / `dateCreated`
 *   2. <meta property="article:published_time">
 *   3. <meta property="og:updated_time"> / itemprop=datePublished
 *   4. <time datetime="...">
 *   5. Visible "Month DD, YYYY" string anywhere in the document
 *
 * Returns a JS `Date` or `null`. Never throws.
 */
function extractDateFromHtml(html, $maybe) {
  if (!html || typeof html !== 'string') return null;
  const $ = $maybe || cheerio.load(html);

  const tryDate = (s) => {
    if (!s || typeof s !== 'string') return null;
    const cleaned = s.trim().replace(/\s+/g, ' ');
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  };

  // 1. JSON-LD blocks
  const lds = $('script[type="application/ld+json"]').toArray();
  for (const node of lds) {
    const raw = $(node).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        const d =
          tryDate(cur.datePublished) ||
          tryDate(cur.dateCreated) ||
          tryDate(cur.uploadDate);
        if (d) return d;
        if (Array.isArray(cur['@graph'])) stack.push(...cur['@graph']);
      }
    } catch {
      // ignore malformed JSON-LD — sites ship broken blobs all the time
    }
  }

  // 2-3. Meta tags
  const metaCandidates = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[property="og:updated_time"]',
    'meta[itemprop="datePublished"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[name="date"]',
  ];
  for (const sel of metaCandidates) {
    const v = $(sel).attr('content');
    const d = tryDate(v);
    if (d) return d;
  }

  // 4. <time datetime="...">
  const timeAttr = $('time[datetime]').first().attr('datetime');
  const dTime = tryDate(timeAttr);
  if (dTime) return dTime;
  const timeText = $('time').first().text();
  const dTimeText = tryDate(timeText);
  if (dTimeText) return dTimeText;

  // 5. Visible "Month DD, YYYY" anywhere in body text. Scoped to the first
  //    60 KB so we don't regex-scan an entire 1 MB document.
  const slice = html.slice(0, 60_000);
  const m = slice.match(
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/,
  );
  if (m) return tryDate(m[0]);

  return null;
}

// ─── extractGizbotProsConsRating ───────────────────────────────────────

/**
 * Pulls structured review metadata from a Gizbot review page.
 *
 * Returns: { rating: string, pros: string[], cons: string[] }
 *
 * Rating: a stringified score ("4.1", "4.1/5", or a verdict like "Good")
 * preferred in that order. Empty string when nothing convincing is found.
 *
 * Pros / Cons: emitted as plain strings, deduped, capped at 8 entries
 * each and 200 chars per entry — that's enough to render nicely in the
 * mobile detail modal without overwhelming the user.
 */
function extractGizbotProsConsRating(html) {
  const out = { rating: '', pros: [], cons: [] };
  if (!html || typeof html !== 'string') return out;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return out;
  }

  // ── Rating ──────────────────────────────────────────────────────────
  // Try structured signals first (review schema), then visible patterns.
  const ldRating = (() => {
    const nodes = $('script[type="application/ld+json"]').toArray();
    for (const node of nodes) {
      try {
        const parsed = JSON.parse($(node).contents().text());
        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          const r = cur.reviewRating || cur.aggregateRating;
          if (r && r.ratingValue != null) return String(r.ratingValue);
          if (Array.isArray(cur['@graph'])) stack.push(...cur['@graph']);
        }
      } catch {
        // ignore
      }
    }
    return '';
  })();

  if (ldRating) {
    out.rating = ldRating;
  } else {
    const text = $('body').text();
    const patterns = [
      /\bGizbot\s*Rating[:\s]*(\d+(?:\.\d+)?)/i,
      /\bOverall\s*Rating[:\s]*(\d+(?:\.\d+)?)/i,
      /\bRating[:\s]*(\d+(?:\.\d+)?)\s*\/\s*5\b/i,
      /\bScore[:\s]*(\d+(?:\.\d+)?)/i,
      /\b(\d+(?:\.\d+)?)\s*\/\s*5\b/, // generic "X/5" — last because noisy
      /\bVerdict[:\s]*(Good|Average|Excellent|Poor|Mediocre|Recommended)\b/i,
    ];
    for (const rx of patterns) {
      const m = text.match(rx);
      if (m && m[1]) {
        out.rating = m[1].trim();
        break;
      }
    }
  }

  // ── Strategy A: site-specific class names (Gizbot ships pros-box /
  //    cons-box divs with a nested <ul>). This is the highest-signal
  //    path and runs first because it sidesteps heading-distance issues.
  const extractListFrom = (sel) => {
    const $box = $(sel).first();
    if ($box.length === 0) return [];
    return $box
      .find('li')
      .toArray()
      .map((li) => $(li).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  };
  out.pros = extractListFrom('.pros-box, [class*="pros-box"], [class*="ProsBox"], .pros-list, [class*="pros-list"]');
  out.cons = extractListFrom('.cons-box, [class*="cons-box"], [class*="ConsBox"], .cons-list, [class*="cons-list"]');

  // ── Strategy B: heading-driven (also covers Lensmen / generic sites).
  //    We walk a bounded number of forward siblings AND their descendants
  //    so a heading separated from its list by intermediate <div> wrappers
  //    still resolves correctly. This is the part the original Python
  //    sample uses via `find_next(['ul','ol'])` — same idea here.
  const findNearbyList = ($h) => {
    // First, classic next-sibling search.
    const direct = $h.nextAll('ul, ol').first();
    if (direct.length) return direct;
    // Then walk forward up to 6 siblings looking inside each one.
    let sib = $h.next();
    let hops = 0;
    while (sib.length && hops < 6) {
      const found = sib.find('ul, ol').first();
      if (found.length) return found;
      sib = sib.next();
      hops++;
    }
    // Finally, climb to parent and try its forward siblings.
    const parent = $h.parent();
    if (parent.length) {
      let psib = parent.next();
      let phops = 0;
      while (psib.length && phops < 4) {
        const found = psib.find('ul, ol').first();
        if (found.length) return found;
        psib = psib.next();
        phops++;
      }
    }
    return null;
  };

  const collectList = (heading) => {
    const $list = findNearbyList(heading);
    if (!$list || $list.length === 0) return [];
    return $list
      .find('li')
      .toArray()
      .map((li) => $(li).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  };

  $('h2, h3, h4, h5, strong, b, p').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim().toLowerCase();
    if (!text || text.length > 40) return; // headings only

    if (out.pros.length === 0 && /^(pros|advantages|the good|what works)\b/.test(text)) {
      out.pros = collectList($el);
    } else if (out.cons.length === 0 && /^(cons|disadvantages|the bad|what doesn'?t work)\b/.test(text)) {
      out.cons = collectList($el);
    }
  });

  // ── Fallback: regex on raw HTML ─────────────────────────────────────
  if (out.pros.length === 0 || out.cons.length === 0) {
    const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

    if (out.pros.length === 0) {
      const prosBlock = html.match(
        /(?:>\s*|^\s*)(?:PROS|Pros|Advantages|The Good)[:\s<]{0,40}([\s\S]{0,1200}?)(?:CONS|Cons|Disadvantages|Verdict|Conclusion|<\/(?:article|section|div)>)/i,
      );
      if (prosBlock) {
        const items = stripTags(prosBlock[1])
          .split(/(?:•|\u2022|\u25CF|\n|\.|;)/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 6 && s.length <= 200);
        if (items.length) out.pros = items;
      }
    }

    if (out.cons.length === 0) {
      const consBlock = html.match(
        /(?:>\s*|^\s*)(?:CONS|Cons|Disadvantages|The Bad)[:\s<]{0,40}([\s\S]{0,1200}?)(?:Verdict|Conclusion|Final|<\/(?:article|section|div)>)/i,
      );
      if (consBlock) {
        const items = stripTags(consBlock[1])
          .split(/(?:•|\u2022|\u25CF|\n|\.|;)/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 6 && s.length <= 200);
        if (items.length) out.cons = items;
      }
    }
  }

  // De-dup + cap to keep the rendered card visually balanced.
  out.pros = [...new Set(out.pros.map((s) => s.trim()))]
    .filter((s) => s.length > 3 && s.length <= 200)
    .slice(0, 8);
  out.cons = [...new Set(out.cons.map((s) => s.trim()))]
    .filter((s) => s.length > 3 && s.length <= 200)
    .slice(0, 8);

  return out;
}

// ─── Listing-page scraper (no-RSS feeds — Gizbot, etc.) ─────────────────

/**
 * Walks a category / listing page and returns the article-detail links
 * that match the configured pattern. Returns up to `max` deduped items
 * shaped exactly like the parseFeedItems() output so the downstream
 * RSS pipeline (dedup → fetch → extract → store) is identical.
 *
 * `linkPattern` is a regex string applied to the absolute href; only
 * matches are kept. Sites without a clean URL convention can pass
 * `.*` here and rely on the selector to narrow.
 */
function scrapeListingPage(html, { baseUrl, linkPattern = '.*', max = 25 } = {}) {
  if (!html || typeof html !== 'string' || !baseUrl) return [];

  const out = [];
  const seen = new Set();
  const rx = new RegExp(linkPattern, 'i');

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  // Pass 1: anchors inside article/card containers (high signal).
  const containerSel = 'article, .card, .post, .review-card, .listing-item, .story, .news-card, .item-list, .list-item';
  $(containerSel).each((_, container) => {
    $(container).find('a[href]').each((__, a) => {
      _maybeAdd($, a, baseUrl, rx, seen, out, max);
    });
  });

  // Pass 2: all anchors (fallback).
  if (out.length < 5) {
    $('a[href]').each((_, a) => {
      _maybeAdd($, a, baseUrl, rx, seen, out, max);
    });
  }

  return out.slice(0, max);
}

function _maybeAdd($, a, baseUrl, rx, seen, out, max) {
  if (out.length >= max) return;
  const href = $(a).attr('href');
  if (!href) return;
  let abs;
  try {
    abs = new URL(href, baseUrl).toString();
  } catch {
    return;
  }
  if (!rx.test(abs)) return;
  if (seen.has(abs)) return;

  // Title: anchor text > nested heading > image alt
  const title =
    $(a).text().replace(/\s+/g, ' ').trim() ||
    $(a).find('h1, h2, h3, h4').first().text().replace(/\s+/g, ' ').trim() ||
    $(a).find('img').attr('alt') ||
    '';

  // Skip ghost anchors. We do NOT call `seen.add(abs)` until after this
  // check — otherwise a short ghost anchor on a URL that ALSO has a real
  // anchor elsewhere on the page would dedup out the real one.
  if (title.length < 3) return;

  seen.add(abs);
  const image = $(a).find('img').attr('src') || $(a).find('img').attr('data-src') || '';
  out.push({ title, link: abs, image });
}

// ─── fetchHtml — retried GET with timeout + UA + logging ───────────────

/**
 * Robust HTML fetcher with multi-strategy fallback.
 *
 * Strategy chain (in order, stops on first 200):
 *   1. Native `fetch` — fast, the happy path for ~90% of sites
 *   2. `curl` subprocess — Cloudflare and other bot-mitigation layers
 *      fingerprint Node's undici TLS handshake (JA3/JA4) and routinely
 *      403 it; curl uses OpenSSL with a different fingerprint and is
 *      treated as a real browser. We only invoke curl on 403/blocked
 *      responses (or when fetch errors transiently and exhausts retries)
 *      so the typical hit doesn't pay subprocess overhead.
 *
 * Transient errors (timeouts, ECONNRESET, 5xx) get exponential backoff
 * within native fetch first; we only escalate to curl after fetch gives
 * up. 4xx responses are NOT retried by native fetch — they're terminal
 * for that strategy — but 403 specifically escalates to curl since
 * that's the canonical Cloudflare-bot symptom.
 */
async function fetchHtml(url, { timeoutMs = 15_000, retries = 2, logTag = 'NEWS/extract' } = {}) {
  let lastErr = null;
  let escalateToCurl = false;

  // ── Stage 1: native fetch ───────────────────────────────────────────
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff));
    }
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: DEFAULT_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const msg = `HTTP ${res.status} ${Date.now() - t0}ms${attempt ? ` (retry ${attempt})` : ''}`;
        if (res.status === 403) {
          // Don't waste retries — escalate to curl immediately.
          tg.d(logTag, `fetchHtml ${msg} — escalating to curl fallback`);
          escalateToCurl = true;
          break;
        }
        if (!retryable || attempt >= retries) {
          tg.w(logTag, `fetchHtml fail ${msg} ${url}`);
          throw new Error(msg);
        }
        tg.d(logTag, `fetchHtml ${msg} — will retry`);
        continue;
      }
      const html = await res.text();
      if (attempt > 0) tg.d(logTag, `fetchHtml ✓ ${Date.now() - t0}ms (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})`);
      return html;
    } catch (e) {
      lastErr = e;
      const transient = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR|socket hang up|abort|timeout/i.test(e.message || '');
      tg.d(logTag, `fetchHtml error ${Date.now() - t0}ms: ${_shortErr(e)}${attempt ? ` (retry ${attempt})` : ''}`);
      if (!transient && attempt === 0) {
        // First-attempt non-transient (likely TLS / DNS) → curl fallback.
        escalateToCurl = true;
        break;
      }
      if (attempt >= retries) {
        // Exhausted retries — give curl one shot before giving up.
        escalateToCurl = true;
        break;
      }
    }
  }

  // ── Stage 2: curl subprocess fallback (Cloudflare bypass) ───────────
  if (escalateToCurl) {
    try {
      return await _fetchHtmlViaCurl(url, { timeoutMs, logTag });
    } catch (curlErr) {
      tg.w(logTag, `curl fallback failed: ${_shortErr(curlErr)} ${url}`);
      throw curlErr;
    }
  }

  throw lastErr || new Error('fetchHtml: unknown failure');
}

/**
 * Spawns the system `curl` to fetch a URL. Curl uses OpenSSL's TLS
 * fingerprint which (unlike undici) is accepted by Cloudflare and most
 * bot-mitigation services. We pass `-f` to fail on HTTP errors and
 * `--max-time` for a hard timeout the same as our fetch budget.
 *
 * Throws if curl is unavailable (ENOENT) or returns non-zero. The
 * `cleanExtract` caller surfaces this via a `clean-empty` extractionMethod
 * and the caller falls back to the RSS excerpt — so a missing curl on
 * the host gracefully degrades rather than crashing the news sync.
 */
async function _fetchHtmlViaCurl(url, { timeoutMs, logTag }) {
  const t0 = Date.now();
  const headerArgs = [];
  for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
    headerArgs.push('-H', `${k}: ${v}`);
  }
  const args = [
    '-sSL',
    '--compressed',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-A', DEFAULT_HEADERS['User-Agent'],
    ...headerArgs,
    url,
  ];
  try {
    const { stdout } = await execFileP('curl', args, {
      maxBuffer: 32 * 1024 * 1024, // 32 MB cap — way over typical article size
      windowsHide: true,
      timeout: timeoutMs + 2000, // hard kill safety buffer
    });
    const html = stdout || '';
    tg.d(logTag, `curl ✓ ${Date.now() - t0}ms ${html.length}ch`);
    if (!html) throw new Error('curl returned empty body');
    return html;
  } catch (e) {
    if (e.code === 'ENOENT') {
      tg.w(logTag, 'curl not found on PATH — fallback unavailable');
    }
    throw e;
  }
}

// ─── cleanExtract — one-shot pipeline (fetch → extract → telemetry) ────

/**
 * Returns the same shape the existing `deepExtractFn` callers expect, so
 * this can be wired into `processItem` as a drop-in replacement for
 * feeds whose `extraction_strategy === 'clean'`:
 *
 *   { content, title, byline, date, extractionMethod, paywallSource }
 *
 * `extractionMethod` is one of `clean-site` (a tuned selector matched),
 * `clean-generic` (density heuristic chose the body), or `clean-empty`
 * (extraction failed — caller will fall back to RSS excerpt).
 */
async function cleanExtract(url, { logTag = 'NEWS/clean-extract', timeoutMs = 15_000, retries = 2 } = {}) {
  const t0 = Date.now();
  let html = '';
  try {
    html = await fetchHtml(url, { timeoutMs, retries, logTag });
  } catch (e) {
    tg.w(logTag, `Fetch FAILED ${Date.now() - t0}ms ${url}: ${_shortErr(e)}`);
    return { content: '', title: '', byline: '', date: null, extractionMethod: 'fetch-failed', paywallSource: 'none' };
  }

  const r = extractCleanArticle(html, url);
  const method = r.content
    ? selectorsForUrl(url).length > 0
      ? 'clean-site'
      : 'clean-generic'
    : 'clean-empty';

  tg.d(
    logTag,
    `${method} ${Date.now() - t0}ms ${r.content.length}ch title="${(r.title || '').slice(0, 50)}" ${url.slice(0, 80)}`,
  );

  return {
    content: r.content,
    title: r.title,
    byline: r.byline,
    date: r.date,
    extractionMethod: method,
    paywallSource: 'none',
    rawHtml: html, // exposed so callers can run Gizbot pros/cons extraction
  };
}

// ─── Pros/Cons/Rating → structured markdown (presentation helper) ──────

/**
 * Builds a Markdown header block that fronts a Gizbot article with its
 * rating + pros + cons. Returns an empty string when there's nothing
 * structured to render so the caller can append unconditionally.
 *
 * Shape (deliberately compact — the body still follows below):
 *
 *   **⭐ Rating: 4.1 / 5**
 *
 *   #### ✅ Pros
 *   - Clean and unique design
 *   - Excellent battery life
 *
 *   #### ❌ Cons
 *   - Average low-light camera
 *
 *   ---
 */
function buildReviewMetaMarkdown({ rating, pros = [], cons = [] }) {
  const parts = [];
  if (rating) {
    const ratingStr = /\/\s*\d/.test(rating) ? rating : `${rating} / 5`;
    parts.push(`**⭐ Rating: ${ratingStr}**`);
  }
  if (pros && pros.length) {
    parts.push('#### ✅ Pros');
    for (const p of pros) parts.push(`- ${p}`);
  }
  if (cons && cons.length) {
    parts.push('#### ❌ Cons');
    for (const c of cons) parts.push(`- ${c}`);
  }
  if (parts.length === 0) return '';
  parts.push('---');
  return parts.join('\n\n');
}

module.exports = {
  // Public pipeline
  cleanExtract,
  fetchHtml,
  scrapeListingPage,
  // Pure extractors
  extractCleanArticle,
  extractDateFromHtml,
  extractGizbotProsConsRating,
  buildReviewMetaMarkdown,
  // Internals exposed for tests
  hostOf,
  selectorsForUrl,
  SITE_SELECTORS,
  BOILERPLATE_SELECTORS,
};
