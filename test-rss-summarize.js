import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch { /* ok */ }

const {
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
} = require('./api/src/xgrok');

const { buildSummarizerSystemPrompt } = require('./api/src/prompts');

const PASS = '\u2705';
const FAIL = '\u274C';
const WARN = '\u26A0\uFE0F';
let passed = 0;
let failed = 0;
const results = [];

function log(icon, msg) { console.log(`${icon}  ${msg}`); }
function section(title) { console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`); }
function subsection(title) { console.log(`\n  -- ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`); }

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    passed++;
    log(PASS, `${name} -- ${ms}ms${detail ? ` | ${detail}` : ''}`);
    results.push({ name, ms, status: 'PASS' });
  } catch (e) {
    const ms = Date.now() - t0;
    failed++;
    log(FAIL, `${name} -- ${ms}ms | ${e.message?.slice(0, 300)}`);
    results.push({ name, ms, status: 'FAIL', error: e.message?.slice(0, 300) });
  }
}

// ── LiteLLM client (same as used by index.js and news-service.js) ────
const LITELLM_URL = process.env.LITELLM_URL?.replace(/\/$/, '') || '';
const LITELLM_KEY = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY || '';

async function callLiteLLMDirect(messages, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (LITELLM_KEY) headers.Authorization = `Bearer ${LITELLM_KEY.trim()}`;

  const res = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model || 'gemini/gemini-3.1-flash-lite-preview',
      messages,
      temperature: opts.temperature ?? 0.35,
      max_tokens: opts.max_tokens ?? 3000,
    }),
    signal: AbortSignal.timeout(45000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`LiteLLM non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data?.error?.message || `LiteLLM ${res.status}: ${text.slice(0, 300)}`);

  return {
    content: data?.choices?.[0]?.message?.content || '',
    model_used: data?.model || opts.model || 'unknown',
    usage: data?.usage || null,
  };
}

// ── URL content extraction (same pipeline as index.js Stage 1) ───────

function stripHtmlToText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|article|section|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1];
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag) return titleTag[1].trim();
  return '';
}

async function fetchAndExtract(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const title = extractTitle(html);
  const text = stripHtmlToText(html);
  return { title, text: text.slice(0, 12000), length: text.length };
}

// ── JSON parsing helper (same as index.js) ───────────────────────────

function parseJsonContent(raw) {
  if (!raw) return {};
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  else if (s.startsWith('```')) s = s.replace(/^```\s*/, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { return { summary: s }; }
}

// ── RSS feed parser (same as news-service.js) ────────────────────────

function parseFeedItems(xml) {
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0]);
  const entries = items.length === 0
    ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m => m[0])
    : [];
  return (items.length > 0 ? items : entries).map(b => {
    const title = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || 'Untitled';
    const link = b.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1]?.trim()
      || b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]?.trim()
      || '';
    const desc = b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
    const content = b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
      || b.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
      || desc;
    const pubDate = b.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i)?.[1]?.trim()
      || b.match(/<published[^>]*>([^<]+)<\/published>/i)?.[1]?.trim()
      || '';
    return { title, link, desc, content: stripHtmlToText(content), pubDate };
  }).filter(i => i.title && i.link);
}


// ═══════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════

async function run() {
  console.log('\n\uD83E\uDDEA  RSS FEED & URL SUMMARIZE — Comprehensive Test Suite');
  console.log(`\uD83D\uDD11  xGrok: ${isXGrokAvailable() ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
  console.log(`\uD83D\uDD17  LiteLLM: ${LITELLM_URL || 'NOT SET'}`);
  console.log(`\uD83D\uDCCB  Lite Model: ${resolveXGrokModel('lite')}`);
  console.log(`\uD83D\uDCCB  Deep Model: ${resolveXGrokModel('deep')}`);

  // ═══════════════════════════════════════════════════════════════
  section('1. RSS FEED PARSING & CONTENT EXTRACTION');
  // ═══════════════════════════════════════════════════════════════

  const TEST_FEEDS = [
    { id: 'finshots', url: 'https://finshots.in/archive/rss/', name: 'Finshots' },
    { id: 'marktechpost', url: 'https://www.marktechpost.com/feed/', name: 'MarkTechPost' },
  ];

  const feedArticles = {};

  for (const feed of TEST_FEEDS) {
    subsection(`RSS: ${feed.name}`);

    await test(`Fetch RSS feed: ${feed.name}`, async () => {
      const res = await fetch(feed.url, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'User-Agent': 'Nexus-AI-News/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      if (xml.length < 100) throw new Error(`RSS response too short: ${xml.length}`);
      return `${xml.length} bytes, status=${res.status}`;
    });

    await test(`Parse RSS items: ${feed.name}`, async () => {
      const res = await fetch(feed.url, {
        headers: { Accept: 'application/rss+xml, */*', 'User-Agent': 'Nexus-AI-News/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const xml = await res.text();
      const items = parseFeedItems(xml);
      if (items.length === 0) throw new Error('No items parsed from feed');
      feedArticles[feed.id] = items;

      const first = items[0];
      if (!first.title) throw new Error('First item missing title');
      if (!first.link) throw new Error('First item missing link');
      return `${items.length} items | first: "${first.title.slice(0, 50)}" | link=${first.link.slice(0, 60)}`;
    });

    await test(`Extract content from first article: ${feed.name}`, async () => {
      const items = feedArticles[feed.id];
      if (!items?.length) throw new Error('No parsed items available');

      const url = items[0].link;
      const extracted = await fetchAndExtract(url);
      if (extracted.length < 200) throw new Error(`Extracted only ${extracted.length} chars — too short`);
      return `title="${extracted.title.slice(0, 50)}" | ${extracted.length} chars total | used ${extracted.text.length} chars`;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  section('2. URL SUMMARIZE — LiteLLM (Gemini)');
  // ═══════════════════════════════════════════════════════════════

  const TEST_URLS = [
    'https://finshots.in/archive/',
    feedArticles.finshots?.[0]?.link,
    feedArticles.marktechpost?.[0]?.link,
  ].filter(Boolean);

  for (const url of TEST_URLS) {
    const shortUrl = url.length > 60 ? url.slice(0, 57) + '...' : url;

    await test(`Summarize [LiteLLM]: ${shortUrl}`, async () => {
      const extracted = await fetchAndExtract(url);
      if (extracted.text.length < 100) throw new Error(`Cannot extract content: ${extracted.text.length} chars`);

      const systemPrompt = buildSummarizerSystemPrompt(url);
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `URL: ${url}\n\nExtracted content:\n${extracted.text.slice(0, 10000)}` },
      ];

      const result = await callLiteLLMDirect(messages, { temperature: 0.3, max_tokens: 3000 });

      if (!result.content || result.content.length < 50) {
        throw new Error(`Summary too short: ${result.content?.length} chars`);
      }

      const parsed = parseJsonContent(result.content);
      const summary = parsed?.summary || parsed?.content || result.content;
      const keyPoints = parsed?.keyPoints || parsed?.key_points || [];
      const title = parsed?.title || extracted.title;

      const checks = [];
      checks.push(`model=${result.model_used}`);
      checks.push(`title="${(title || '').slice(0, 50)}"`);
      checks.push(`summary=${summary.length} chars`);
      if (Array.isArray(keyPoints)) checks.push(`keyPoints=${keyPoints.length}`);
      if (parsed?.category) checks.push(`cat=${parsed.category}`);
      if (parsed?.readTime) checks.push(`readTime=${parsed.readTime}min`);
      return checks.join(' | ');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  section('3. URL SUMMARIZE — xGrok (Lite Model)');
  // ═══════════════════════════════════════════════════════════════

  for (const url of TEST_URLS) {
    const shortUrl = url.length > 60 ? url.slice(0, 57) + '...' : url;

    await test(`Summarize [xGrok Lite]: ${shortUrl}`, async () => {
      const extracted = await fetchAndExtract(url);
      if (extracted.text.length < 100) throw new Error(`Cannot extract content: ${extracted.text.length} chars`);

      const systemPrompt = buildSummarizerSystemPrompt(url);
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `URL: ${url}\n\nExtracted content:\n${extracted.text.slice(0, 10000)}` },
      ];

      const liteModel = resolveXGrokModel('lite');
      const result = await xgrokComplete({
        model: liteModel,
        messages,
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 60000,
      });

      if (!result.content || result.content.length < 50) {
        throw new Error(`Summary too short: ${result.content?.length} chars`);
      }
      if (!result.model_used?.includes('grok')) {
        throw new Error(`Wrong model used: ${result.model_used} (expected grok)`);
      }

      const parsed = parseJsonContent(result.content);
      const summary = parsed?.summary || parsed?.content || result.content;
      const keyPoints = parsed?.keyPoints || parsed?.key_points || [];
      const title = parsed?.title || extracted.title;

      const checks = [];
      checks.push(`model=${result.model_used}`);
      checks.push(`title="${(title || '').slice(0, 50)}"`);
      checks.push(`summary=${summary.length} chars`);
      if (Array.isArray(keyPoints)) checks.push(`keyPoints=${keyPoints.length}`);
      if (parsed?.category) checks.push(`cat=${parsed.category}`);
      return checks.join(' | ');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  section('4. URL SUMMARIZE — xGrok (Deep Model)');
  // ═══════════════════════════════════════════════════════════════

  // Only test one URL with deep model (slow but thorough)
  const deepTestUrl = TEST_URLS[1] || TEST_URLS[0];
  if (deepTestUrl) {
    const shortUrl = deepTestUrl.length > 60 ? deepTestUrl.slice(0, 57) + '...' : deepTestUrl;
    await test(`Summarize [xGrok Deep]: ${shortUrl}`, async () => {
      const extracted = await fetchAndExtract(deepTestUrl);
      if (extracted.text.length < 100) throw new Error(`Cannot extract: ${extracted.text.length}`);

      const systemPrompt = buildSummarizerSystemPrompt(deepTestUrl);
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `URL: ${deepTestUrl}\n\nExtracted content:\n${extracted.text.slice(0, 10000)}` },
      ];

      const deepModel = resolveXGrokModel('deep');
      const result = await xgrokComplete({
        model: deepModel,
        messages,
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 120000,
      });

      if (!result.content || result.content.length < 50) throw new Error(`Too short: ${result.content?.length}`);
      if (!result.model_used?.includes('grok')) throw new Error(`Wrong model: ${result.model_used}`);

      const parsed = parseJsonContent(result.content);
      const summary = parsed?.summary || parsed?.content || result.content;
      return `model=${result.model_used} | summary=${summary.length} chars`;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  section('5. NEWS-SERVICE SUMMARIZE PIPELINE (End-to-End)');
  // ═══════════════════════════════════════════════════════════════

  // Simulate the exact generateSummary() flow from news-service.js
  // with both LiteLLM and xGrok as the primary provider

  const newsConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'news_rss_feeds.json'), 'utf8'));
  const summaryPromptConfig = newsConfig.summary_prompt || {};
  const sys = summaryPromptConfig.system || 'You are an expert educator who simplifies complex news.';

  // Get a real article from RSS to test with
  const testArticle = feedArticles.finshots?.[0] || feedArticles.marktechpost?.[0];
  let articleContent = testArticle?.content || '';
  let articleTitle = testArticle?.title || 'Test Article';

  // If RSS content is too short, fetch the full page
  if (articleContent.length < 200 && testArticle?.link) {
    try {
      const ext = await fetchAndExtract(testArticle.link);
      articleContent = ext.text;
      if (ext.title) articleTitle = ext.title;
    } catch { /* use what we have */ }
  }

  subsection('5a. News Summary Pipeline — LiteLLM provider');

  await test(`News summary [LiteLLM]: "${articleTitle.slice(0, 50)}"`, async () => {
    if (articleContent.length < 100) throw new Error('Article content too short for testing');

    const template = summaryPromptConfig.template
      || 'Summarize this article.\n\nTitle: {title}\n\nContent:\n{content}';
    const userMsg = template.replaceAll('{title}', articleTitle).replaceAll('{content}', articleContent.slice(0, 8000));

    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ];

    const result = await callLiteLLMDirect(messages, { temperature: 0.35, max_tokens: 2500 });

    if (!result.content || result.content.length < 50) throw new Error(`Too short: ${result.content?.length}`);
    return `model=${result.model_used} | output=${result.content.length} chars`;
  });

  subsection('5b. News Summary Pipeline — xGrok provider');

  await test(`News summary [xGrok Lite]: "${articleTitle.slice(0, 50)}"`, async () => {
    if (articleContent.length < 100) throw new Error('Article content too short');

    const template = summaryPromptConfig.template
      || 'Summarize this article.\n\nTitle: {title}\n\nContent:\n{content}';
    const userMsg = template.replaceAll('{title}', articleTitle).replaceAll('{content}', articleContent.slice(0, 8000));

    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ];

    const liteModel = resolveXGrokModel('lite');
    const result = await xgrokComplete({
      model: liteModel,
      messages,
      temperature: 0.35,
      maxTokens: 2500,
      timeoutMs: 60000,
    });

    if (!result.content || result.content.length < 50) throw new Error(`Too short: ${result.content?.length}`);
    if (!result.model_used?.includes('grok')) throw new Error(`Wrong model: ${result.model_used}`);
    return `model=${result.model_used} | output=${result.content.length} chars`;
  });

  // ═══════════════════════════════════════════════════════════════
  section('6. RESPONSE QUALITY COMPARISON');
  // ═══════════════════════════════════════════════════════════════

  // Compare LiteLLM vs xGrok summary quality for the same content
  if (articleContent.length > 200) {
    await test('Quality comparison: LiteLLM vs xGrok on same article', async () => {
      const systemPrompt = buildSummarizerSystemPrompt(testArticle?.link || 'https://example.com');
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `URL: ${testArticle?.link || 'https://example.com'}\n\nExtracted content:\n${articleContent.slice(0, 8000)}` },
      ];

      const [litellmResult, xgrokResult] = await Promise.all([
        callLiteLLMDirect(messages, { temperature: 0.3, max_tokens: 3000 }),
        xgrokComplete({
          model: resolveXGrokModel('lite'),
          messages,
          temperature: 0.3,
          maxTokens: 3000,
          timeoutMs: 60000,
        }),
      ]);

      const litellmParsed = parseJsonContent(litellmResult.content);
      const xgrokParsed = parseJsonContent(xgrokResult.content);

      const litellmSummary = litellmParsed?.summary || litellmParsed?.content || litellmResult.content;
      const xgrokSummary = xgrokParsed?.summary || xgrokParsed?.content || xgrokResult.content;

      const litellmKP = Array.isArray(litellmParsed?.keyPoints || litellmParsed?.key_points) ? (litellmParsed?.keyPoints || litellmParsed?.key_points).length : 0;
      const xgrokKP = Array.isArray(xgrokParsed?.keyPoints || xgrokParsed?.key_points) ? (xgrokParsed?.keyPoints || xgrokParsed?.key_points).length : 0;

      return [
        `LiteLLM: model=${litellmResult.model_used}, summary=${litellmSummary.length}ch, keyPoints=${litellmKP}`,
        `xGrok: model=${xgrokResult.model_used}, summary=${xgrokSummary.length}ch, keyPoints=${xgrokKP}`,
      ].join(' || ');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  section('7. EDGE CASES & ERROR HANDLING');
  // ═══════════════════════════════════════════════════════════════

  await test('Summarize with very short content (graceful)', async () => {
    const messages = [
      { role: 'system', content: buildSummarizerSystemPrompt('https://example.com') },
      { role: 'user', content: 'URL: https://example.com\n\nExtracted content:\nThis is a very short article about nothing.' },
    ];

    const result = await callLiteLLMDirect(messages, { temperature: 0.3, max_tokens: 1000 });
    if (!result.content) throw new Error('No content returned for short input');
    return `model=${result.model_used} | output=${result.content.length} chars (handled gracefully)`;
  });

  await test('xGrok summarize with short content', async () => {
    const messages = [
      { role: 'system', content: buildSummarizerSystemPrompt('https://example.com') },
      { role: 'user', content: 'URL: https://example.com\n\nExtracted content:\nBrief news update about quarterly earnings.' },
    ];

    const result = await xgrokComplete({
      model: resolveXGrokModel('lite'),
      messages,
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 30000,
    });
    if (!result.content) throw new Error('No content');
    if (!result.model_used?.includes('grok')) throw new Error(`Wrong model: ${result.model_used}`);
    return `model=${result.model_used} | output=${result.content.length} chars`;
  });

  await test('RSS feed with tech article (MarkTechPost)', async () => {
    const techArticle = feedArticles.marktechpost?.[0];
    if (!techArticle?.link) throw new Error('No MarkTechPost article available');

    const extracted = await fetchAndExtract(techArticle.link);
    const messages = [
      { role: 'system', content: buildSummarizerSystemPrompt(techArticle.link) },
      { role: 'user', content: `URL: ${techArticle.link}\n\nExtracted content:\n${extracted.text.slice(0, 10000)}` },
    ];

    const result = await xgrokComplete({
      model: resolveXGrokModel('lite'),
      messages,
      temperature: 0.3,
      maxTokens: 3000,
      timeoutMs: 60000,
    });

    if (!result.content || result.content.length < 50) throw new Error(`Too short: ${result.content?.length}`);
    if (!result.model_used?.includes('grok')) throw new Error(`Wrong model: ${result.model_used}`);
    return `model=${result.model_used} | "${techArticle.title.slice(0, 40)}" | ${result.content.length} chars`;
  });

  // ═══════════════════════════════════════════════════════════════
  section('FINAL REPORT');
  // ═══════════════════════════════════════════════════════════════

  const total = passed + failed;
  console.log(`\n  Total:   ${total}`);
  console.log(`  ${PASS} Passed: ${passed}`);
  console.log(`  ${FAIL} Failed: ${failed}`);
  console.log('');

  if (failed > 0) {
    console.log('  FAILED TESTS:');
    for (const r of results) {
      if (r.status === 'FAIL') {
        console.log(`    ${FAIL} ${r.name}: ${r.error}`);
      }
    }
    console.log('');
  }

  console.log('  PERFORMANCE:');
  const sorted = [...results].sort((a, b) => b.ms - a.ms);
  for (const r of sorted.slice(0, 15)) {
    const bar = '\u2588'.repeat(Math.min(30, Math.ceil(r.ms / 2000)));
    const icon = r.status === 'PASS' ? PASS : FAIL;
    console.log(`    ${icon} ${String(r.ms).padStart(6)}ms ${bar} ${r.name.slice(0, 60)}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
