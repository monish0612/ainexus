'use strict';
// Smoke test: hit the 3 real URLs and confirm the new extractor produces
// usable content. Run via: node backend/api/scripts/extract-smoke.js
// Logs are intentionally compact so you can eyeball quality at a glance.

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const {
  cleanExtract,
  scrapeListingPage,
  fetchHtml,
  extractGizbotProsConsRating,
  buildReviewMetaMarkdown,
} = require('../src/news-extract');

(async () => {
  console.log('='.repeat(80));
  console.log('TEST 1 — TechCrunch AI feed: extract a single recent article');
  console.log('='.repeat(80));
  try {
    const rss = await fetchHtml('https://techcrunch.com/category/artificial-intelligence/feed/', { logTag: 'SMOKE' });
    const m = rss.match(/<item[\s\S]*?<link>([^<]+)<\/link>/i);
    if (m) {
      const url = m[1].trim();
      console.log('URL:', url);
      const r = await cleanExtract(url, { logTag: 'SMOKE/tc' });
      console.log('Title:', r.title?.slice(0, 80));
      console.log('Date:', r.date?.toISOString());
      console.log('Byline:', r.byline);
      console.log('Method:', r.extractionMethod);
      console.log('Content chars:', r.content.length);
      console.log('Content preview:');
      console.log(r.content.slice(0, 600));
      console.log('---');
    }
  } catch (e) {
    console.error('TC failed:', e.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('TEST 2 — Lensmen Reviews: extract a single recent review');
  console.log('='.repeat(80));
  try {
    const rss = await fetchHtml('https://lensmenreviews.com/reviews/feed/', { logTag: 'SMOKE' });
    const m = rss.match(/<item[\s\S]*?<link>([^<]+)<\/link>/i);
    if (m) {
      const url = m[1].trim();
      console.log('URL:', url);
      const r = await cleanExtract(url, { logTag: 'SMOKE/lensmen' });
      console.log('Title:', r.title?.slice(0, 80));
      console.log('Date:', r.date?.toISOString());
      console.log('Byline:', r.byline);
      console.log('Method:', r.extractionMethod);
      console.log('Content chars:', r.content.length);
      console.log('Content preview:');
      console.log(r.content.slice(0, 600));
      console.log('---');
    }
  } catch (e) {
    console.error('Lensmen failed:', e.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('TEST 3 — Sudhir Srinivasan film reviews');
  console.log('='.repeat(80));
  try {
    const rss = await fetchHtml('https://sudhir-srinivasan.com/category/film-reviews/feed/', { logTag: 'SMOKE' });
    const m = rss.match(/<item[\s\S]*?<link>([^<]+)<\/link>/i);
    if (m) {
      const url = m[1].trim();
      console.log('URL:', url);
      const r = await cleanExtract(url, { logTag: 'SMOKE/sudhir' });
      console.log('Title:', r.title?.slice(0, 80));
      console.log('Date:', r.date?.toISOString());
      console.log('Byline:', r.byline);
      console.log('Method:', r.extractionMethod);
      console.log('Content chars:', r.content.length);
      console.log('Content preview:');
      console.log(r.content.slice(0, 600));
      console.log('---');
    }
  } catch (e) {
    console.error('Sudhir failed:', e.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('TEST 4 — Gizbot listing → fetch first review → extract pros/cons/rating');
  console.log('='.repeat(80));
  // (Gizbot block below — keeping original logic)
  try {
    const listingHtml = await fetchHtml('https://www.gizbot.com/reviews/', { logTag: 'SMOKE' });
    const links = scrapeListingPage(listingHtml, {
      baseUrl: 'https://www.gizbot.com/reviews/',
      linkPattern: 'https?://(?:www\\.)?gizbot\\.com/.*/reviews?/.*\\.html$',
      max: 5,
    });
    console.log(`Found ${links.length} review links. First 3:`);
    links.slice(0, 3).forEach((l, i) => console.log(`  ${i + 1}. ${l.title.slice(0, 60)} → ${l.link}`));
    if (links.length === 0) {
      console.log('No links found — listing pattern may need adjusting.');
      return;
    }
    const url = links[0].link;
    const r = await cleanExtract(url, { logTag: 'SMOKE/gizbot' });
    console.log('\nFirst review:');
    console.log('Title:', r.title?.slice(0, 80));
    console.log('Date:', r.date?.toISOString());
    console.log('Method:', r.extractionMethod);
    console.log('Content chars:', r.content.length);
    const meta = extractGizbotProsConsRating(r.rawHtml);
    console.log('Rating:', meta.rating || '(none)');
    console.log('Pros:', meta.pros);
    console.log('Cons:', meta.cons);
    console.log('\nReview metadata markdown:');
    console.log(buildReviewMetaMarkdown(meta) || '(empty)');
    console.log('\nContent preview:');
    console.log(r.content.slice(0, 400));
  } catch (e) {
    console.error('Gizbot failed:', e.message);
  }
})().then(() => process.exit(0));
