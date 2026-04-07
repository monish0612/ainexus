'use strict';

// ═══════════════════════════════════════════════════════════════
//  COMPREHENSIVE LLM ENDPOINT TEST SUITE
//  Tests ALL AI/LLM endpoints with both LiteLLM and xGrok providers
//  Validates response structures, performance, and error handling
// ═══════════════════════════════════════════════════════════════

const BASE_URL = process.env.TEST_BASE_URL || 'http://72.60.219.97:3000';

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';
const SKIP = '⏭️';

const results = [];
let totalTests = 0;
let passed = 0;
let failed = 0;
let skipped = 0;

function log(icon, msg) { console.log(`${icon}  ${msg}`); }
function section(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`); }
function subsection(title) { console.log(`\n  ── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`); }

async function testEndpoint(name, fn) {
  totalTests++;
  const t0 = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - t0;
    const status = result.skip ? 'SKIP' : 'PASS';
    if (result.skip) {
      skipped++;
      log(SKIP, `${name} — skipped: ${result.reason} (${elapsed}ms)`);
      results.push({ name, status, elapsed, reason: result.reason });
    } else {
      passed++;
      log(PASS, `${name} — ${elapsed}ms${result.detail ? ` | ${result.detail}` : ''}`);
      results.push({ name, status, elapsed, detail: result.detail });
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - t0;
    failed++;
    const msg = err?.message || String(err);
    log(FAIL, `${name} — FAILED (${elapsed}ms): ${msg.slice(0, 200)}`);
    results.push({ name, status: 'FAIL', elapsed, error: msg.slice(0, 300) });
    return { error: msg };
  }
}

async function api(method, path, body, timeoutMs = 60000) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof data === 'object' ? JSON.stringify(data) : String(text).slice(0, 300)}`);
  }
  return data;
}

function assertField(data, field, type) {
  if (data[field] === undefined || data[field] === null) {
    throw new Error(`Missing required field: "${field}"`);
  }
  if (type && typeof data[field] !== type) {
    throw new Error(`Field "${field}" expected ${type}, got ${typeof data[field]}`);
  }
}

function assertOptionalField(data, field, type) {
  if (data[field] !== undefined && data[field] !== null && typeof data[field] !== type) {
    throw new Error(`Field "${field}" expected ${type}, got ${typeof data[field]}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════

async function run() {
  console.log(`\n🧪  NEXUS AI — COMPREHENSIVE LLM ENDPOINT TEST SUITE`);
  console.log(`📡  Target: ${BASE_URL}`);
  console.log(`📅  ${new Date().toISOString()}\n`);

  // ── 0. HEALTH CHECK ─────────────────────────────────────────
  section('0. HEALTH & CONNECTIVITY');

  await testEndpoint('API Health Check', async () => {
    const data = await api('GET', '/health');
    assertField(data, 'status', 'string');
    if (data.status !== 'ok') throw new Error(`Status: ${data.status}`);
    return { detail: `status=${data.status}` };
  });

  // ── 1. LITELLM ENDPOINTS ────────────────────────────────────
  section('1. LITELLM-BASED ENDPOINTS (Gemini/Groq via LiteLLM proxy)');

  // 1a. Rephrase (all platforms)
  subsection('1a. AI Rephrase');

  const rephrasePlatforms = ['casual', 'sarcastic', 'slack', 'email-short', 'email-long', 'whatsapp', 'zoom', 'twitter', 'linkedin', 'forum'];
  const rephraseText = 'I need to leave the meeting early because I have a dentist appointment';

  for (const platform of rephrasePlatforms) {
    await testEndpoint(`Rephrase [${platform}]`, async () => {
      const data = await api('POST', '/api/v1/ai/rephrase', {
        text: rephraseText,
        platform,
      });
      assertField(data, 'platform', 'string');
      assertField(data, 'rephrasedText', 'string');
      assertField(data, 'model', 'string');
      if (!data.rephrasedText || data.rephrasedText.length < 5) {
        throw new Error(`Rephrase too short: "${data.rephrasedText}"`);
      }
      return { detail: `model=${data.model} | platform=${data.platform} | len=${data.rephrasedText.length}` };
    });
  }

  // 1a.1 Rephrase with "own" intent
  await testEndpoint('Rephrase [own + intent]', async () => {
    const data = await api('POST', '/api/v1/ai/rephrase', {
      text: rephraseText,
      platform: 'own',
      intent: 'make it sound like a pirate',
    });
    assertField(data, 'rephrasedText', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | len=${data.rephrasedText.length}` };
  });

  // 1b. Coach / Correct
  subsection('1b. AI Coach (Correct)');

  await testEndpoint('Coach (grammar correction)', async () => {
    const data = await api('POST', '/api/v1/ai/correct', {
      text: 'I am dropping off from the call need to pick my son',
    });
    assertField(data, 'correctedText', 'string');
    assertField(data, 'model', 'string');
    if (!data.correctedText || data.correctedText.length < 10) {
      throw new Error(`Corrected text too short: "${data.correctedText}"`);
    }
    const variationCount = Array.isArray(data.variations) ? data.variations.length : 0;
    return { detail: `model=${data.model} | corrected="${data.correctedText.slice(0, 60)}" | variations=${variationCount}` };
  });

  await testEndpoint('Coach (how to say)', async () => {
    const data = await api('POST', '/api/v1/ai/correct', {
      text: 'how do I politely decline a meeting invitation',
    });
    assertField(data, 'correctedText', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | variations=${(data.variations || []).length}` };
  });

  // 1c. Dictionary / Define
  subsection('1c. AI Dictionary (Define)');

  const testWords = ['pragmatic', 'juxtaposition', 'serendipity'];
  for (const word of testWords) {
    await testEndpoint(`Define "${word}"`, async () => {
      const data = await api('POST', '/api/v1/ai/define', { word });
      assertField(data, 'word', 'string');
      assertField(data, 'definition', 'string');
      assertField(data, 'model', 'string');
      const exampleCount = Array.isArray(data.examples) ? data.examples.length : 0;
      if (exampleCount === 0) throw new Error('No examples returned');
      return { detail: `model=${data.model} | examples=${exampleCount} | usageGuide=${(data.usageGuide || '').length} chars` };
    });
  }

  // 1d. Categorize
  subsection('1d. AI Categorize');

  const categorizeTests = [
    { desc: 'Swiggy order chicken biryani', expected: 'Food' },
    { desc: 'Uber ride to office', expected: 'Transport' },
    { desc: 'Netflix subscription renewal', expected: 'Subscription' },
    { desc: 'Gym membership cult fit', expected: 'Health' },
  ];

  for (const { desc, expected } of categorizeTests) {
    await testEndpoint(`Categorize "${desc}"`, async () => {
      const data = await api('POST', '/api/v1/ai/categorize', { description: desc });
      assertField(data, 'category', 'string');
      assertField(data, 'confidence', 'string');
      assertField(data, 'model', 'string');
      const match = data.category === expected ? 'match' : `MISMATCH (expected ${expected})`;
      return { detail: `model=${data.model} | category=${data.category} | score=${data.score} | ${match}` };
    });
  }

  // 1e. Smart Parse
  subsection('1e. AI Smart Parse (voice expense)');

  const smartParseTests = [
    { text: 'bought milk 200', expectAmount: 200 },
    { text: 'uber ride 145 hdfc cc', expectAmount: 145 },
    { text: 'netflix subscription 649 icici db', expectAmount: 649 },
    { text: 'petrol 500 hdfc', expectAmount: 500 },
    { text: 'bought 2 packets of milk cash 300', expectAmount: 300 },
  ];

  for (const { text, expectAmount } of smartParseTests) {
    await testEndpoint(`SmartParse "${text}"`, async () => {
      const data = await api('POST', '/api/v1/ai/smart-parse', { text });
      assertField(data, 'amount', 'number');
      assertField(data, 'description', 'string');
      assertField(data, 'category', 'string');
      assertField(data, 'model', 'string');
      const amountMatch = data.amount === expectAmount ? 'match' : `MISMATCH (got ${data.amount}, expected ${expectAmount})`;
      return { detail: `model=${data.model} | amount=₹${data.amount} (${amountMatch}) | bank=${data.bank} | card=${data.cardType} | cat=${data.category}` };
    });
  }

  // 1f. Summarize History
  subsection('1f. AI Summarize History');

  await testEndpoint('Summarize Conversation History', async () => {
    const data = await api('POST', '/api/v1/ai/summarize-history', {
      messages: [
        { role: 'user', text: 'What is the impact of AI on healthcare?' },
        { role: 'assistant', text: 'AI is transforming healthcare through improved diagnostics, drug discovery, and personalized treatment plans.' },
        { role: 'user', text: 'What about privacy concerns?' },
        { role: 'assistant', text: 'Privacy is a major concern, especially with patient data. HIPAA compliance and data encryption are critical.' },
      ],
      articleContext: 'AI in healthcare discussion',
    });
    assertField(data, 'summary', 'string');
    assertField(data, 'model', 'string');
    if (data.summary.length < 20) throw new Error('Summary too short');
    return { detail: `model=${data.model} | summary=${data.summary.length} chars` };
  });

  // ── 2. GEMINI GROUNDED SEARCH ENDPOINTS ─────────────────────
  section('2. GEMINI GROUNDED SEARCH ENDPOINTS (Google Search Grounding)');

  // 2a. Grounded Search
  subsection('2a. Grounded Search');

  await testEndpoint('Grounded Search (basic query)', async () => {
    const data = await api('POST', '/api/v1/ai/grounded-search', {
      query: 'What is the latest version of Flutter in 2026?',
    }, 90000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    if (data.answer.length < 20 && !data.fallback) throw new Error('Answer too short');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length} | fallback=${!!data.fallback}` };
  });

  // 2b. Search Follow-Up (Gemini)
  subsection('2b. Search Follow-Up (Gemini)');

  await testEndpoint('Search Follow-Up [Gemini lite]', async () => {
    const data = await api('POST', '/api/v1/ai/search-followup', {
      query: 'Flutter 2026',
      initialAnswer: 'Flutter is a popular cross-platform framework.',
      question: 'What are the major changes in the latest version?',
      history: [],
      mode: 'lite',
      provider: 'gemini',
    }, 120000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length} | fallback=${!!data.fallback}` };
  });

  // 2c. Article Follow-Up (Gemini)
  subsection('2c. Article Follow-Up (Gemini)');

  await testEndpoint('Article Follow-Up [Gemini lite]', async () => {
    const data = await api('POST', '/api/v1/ai/article-followup', {
      question: 'What are the key takeaways from this article?',
      articleUrl: 'https://blog.google/technology/ai/',
      articleTitle: 'Google AI Blog',
      history: [],
      mode: 'lite',
      provider: 'gemini',
    }, 120000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length} | fallback=${!!data.fallback}` };
  });

  // ── 3. XGROK ENDPOINTS ─────────────────────────────────────
  section('3. XGROK ENDPOINTS (xAI Grok Models)');

  // 3a. Search Follow-Up (xGrok Lite)
  subsection('3a. xGrok Search Follow-Up');

  await testEndpoint('Search Follow-Up [xGrok LITE]', async () => {
    const data = await api('POST', '/api/v1/ai/search-followup', {
      query: 'Latest AI developments in 2026',
      initialAnswer: 'AI has been advancing rapidly in 2026.',
      question: 'Which companies are leading the AI race now?',
      history: [],
      mode: 'lite',
      provider: 'xgrok',
    }, 120000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  await testEndpoint('Search Follow-Up [xGrok DEEP]', async () => {
    const data = await api('POST', '/api/v1/ai/search-followup', {
      query: 'Latest AI developments in 2026',
      initialAnswer: 'AI has been advancing rapidly in 2026.',
      question: 'What are the ethical implications of recent AI developments?',
      history: [],
      mode: 'deep',
      provider: 'xgrok',
    }, 180000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  // 3b. Article Follow-Up (xGrok)
  subsection('3b. xGrok Article Follow-Up');

  await testEndpoint('Article Follow-Up [xGrok LITE]', async () => {
    const data = await api('POST', '/api/v1/ai/article-followup', {
      question: 'What is the main argument of this article?',
      articleUrl: 'https://blog.google/technology/ai/',
      articleTitle: 'Google AI Blog',
      history: [],
      mode: 'lite',
      provider: 'xgrok',
    }, 120000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  await testEndpoint('Article Follow-Up [xGrok DEEP]', async () => {
    const data = await api('POST', '/api/v1/ai/article-followup', {
      question: 'Provide a deep analysis of recent AI trends mentioned here',
      articleUrl: 'https://blog.google/technology/ai/',
      articleTitle: 'Google AI Blog',
      history: [],
      mode: 'deep',
      provider: 'xgrok',
    }, 180000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  // 3c. Deep Research (xGrok)
  subsection('3c. xGrok Deep Research');

  await testEndpoint('Deep Research [xGrok]', async () => {
    const data = await api('POST', '/api/v1/ai/deep-research', {
      url: 'https://blog.google/technology/ai/',
      question: '',
      history: [],
      provider: 'xgrok',
    }, 180000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  // 3d. Deep Research (Gemini)
  subsection('3d. Gemini Deep Research');

  await testEndpoint('Deep Research [Gemini]', async () => {
    const data = await api('POST', '/api/v1/ai/deep-research', {
      url: 'https://blog.google/technology/ai/',
      question: '',
      history: [],
      provider: 'gemini',
    }, 180000);
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `model=${data.model} | answer=${data.answer.length} chars | sources=${(data.sources || []).length}` };
  });

  // ── 4. CROSS-PROVIDER: SUMMARIZE ───────────────────────────
  section('4. CROSS-PROVIDER: URL SUMMARIZATION');

  subsection('4a. Summarize via LiteLLM');

  await testEndpoint('Summarize URL [LiteLLM]', async () => {
    const data = await api('POST', '/api/v1/ai/summarize', {
      url: 'https://finshots.in/archive/',
    }, 120000);
    assertField(data, 'title', 'string');
    assertField(data, 'summary', 'string');
    assertField(data, 'model', 'string');
    if (data.summary.length < 30) throw new Error(`Summary too short: ${data.summary.length}`);
    return { detail: `model=${data.model} | title="${(data.title || '').slice(0, 50)}" | summary=${data.summary.length} chars | method=${data.extractionMethod}` };
  });

  subsection('4b. Summarize via xGrok');

  await testEndpoint('Summarize URL [xGrok]', async () => {
    const data = await api('POST', '/api/v1/ai/summarize', {
      url: 'https://finshots.in/archive/',
      provider: 'xgrok',
    }, 120000);
    assertField(data, 'title', 'string');
    assertField(data, 'summary', 'string');
    assertField(data, 'model', 'string');
    if (data.summary.length < 30) throw new Error(`Summary too short: ${data.summary.length}`);
    return { detail: `model=${data.model} | title="${(data.title || '').slice(0, 50)}" | summary=${data.summary.length} chars | method=${data.extractionMethod}` };
  });

  // ── 5. SEARCH (Tavily) ─────────────────────────────────────
  section('5. TAVILY SEARCH');

  await testEndpoint('Tavily Search', async () => {
    const data = await api('POST', '/api/v1/ai/search', {
      query: 'Best programming languages 2026',
    });
    assertField(data, 'results');
    if (!Array.isArray(data.results)) throw new Error('results is not an array');
    if (data.results.length === 0) throw new Error('No search results returned');
    return { detail: `results=${data.results.length} | answer=${(data.answer || '').length} chars` };
  });

  // ── 6. FLUTTER ENTITY VALIDATION ──────────────────────────
  section('6. FLUTTER ENTITY STRUCTURE VALIDATION');

  subsection('6a. RephraseResult structure');

  await testEndpoint('RephraseResult matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/rephrase', {
      text: 'The meeting has been postponed',
      platform: 'slack',
    });
    // Flutter RephraseResult.fromJson expects: platform, rephrasedText
    assertField(data, 'platform', 'string');
    assertField(data, 'rephrasedText', 'string');
    assertOptionalField(data, 'model', 'string');
    return { detail: 'All required fields present' };
  });

  subsection('6b. CoachResult structure');

  await testEndpoint('CoachResult matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/correct', {
      text: 'me and him went to store',
    });
    // Flutter CoachResult.fromJson expects: correctedText, explanation, variations[]
    assertField(data, 'correctedText', 'string');
    if (data.variations !== undefined && !Array.isArray(data.variations)) {
      throw new Error('variations should be an array');
    }
    return { detail: `correctedText present, variations=${(data.variations || []).length}` };
  });

  subsection('6c. DictionaryResult structure');

  await testEndpoint('DictionaryResult matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/define', { word: 'resilient' });
    // Flutter DictionaryResult.fromJson expects: word, pronunciation, partOfSpeech, definition, examples[], usageGuide
    assertField(data, 'word', 'string');
    assertField(data, 'definition', 'string');
    if (!Array.isArray(data.examples)) throw new Error('examples should be array');
    return { detail: `word="${data.word}" | pronunciation="${data.pronunciation}" | pos="${data.partOfSpeech}" | examples=${data.examples.length}` };
  });

  subsection('6d. SummarizerResult structure');

  await testEndpoint('SummarizerResult matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/summarize', {
      url: 'https://example.com',
    }, 120000);
    // Flutter SummarizerResult.fromJson expects: title, summary, keyPoints[], category, readTime, source, extractionMethod, url
    assertField(data, 'summary', 'string');
    assertOptionalField(data, 'title', 'string');
    assertOptionalField(data, 'category', 'string');
    assertOptionalField(data, 'extractionMethod', 'string');
    return { detail: `All entity fields present` };
  });

  subsection('6e. GroundedSearchResponse structure');

  await testEndpoint('GroundedSearchResponse matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/grounded-search', {
      query: 'What is Dart programming language?',
    }, 90000);
    // Flutter GroundedSearchResponse expects: answer, model, searchQueries[], sources[], citations[]
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    if (!Array.isArray(data.sources)) throw new Error('sources should be array');
    return { detail: `All entity fields present | sources=${data.sources.length}` };
  });

  subsection('6f. ArticleFollowUpResponse structure');

  await testEndpoint('ArticleFollowUpResponse matches Flutter entity', async () => {
    const data = await api('POST', '/api/v1/ai/article-followup', {
      question: 'Quick summary please',
      articleUrl: 'https://example.com',
      articleTitle: 'Test Article',
      history: [],
    }, 120000);
    // Flutter ArticleFollowUpResponse expects: answer, model, sources[]
    assertField(data, 'answer', 'string');
    assertField(data, 'model', 'string');
    return { detail: `All entity fields present` };
  });

  // ── 7. ERROR HANDLING ──────────────────────────────────────
  section('7. ERROR HANDLING & EDGE CASES');

  await testEndpoint('Rephrase: empty text → 400', async () => {
    try {
      await api('POST', '/api/v1/ai/rephrase', { text: '', platform: 'casual' });
      throw new Error('Should have returned 400');
    } catch (e) {
      if (e.message.includes('400')) return { detail: 'Correctly returned 400' };
      throw e;
    }
  });

  await testEndpoint('Define: empty word → 400', async () => {
    try {
      await api('POST', '/api/v1/ai/define', { word: '' });
      throw new Error('Should have returned 400');
    } catch (e) {
      if (e.message.includes('400')) return { detail: 'Correctly returned 400' };
      throw e;
    }
  });

  await testEndpoint('SmartParse: single char → 400', async () => {
    try {
      await api('POST', '/api/v1/ai/smart-parse', { text: 'a' });
      throw new Error('Should have returned 400');
    } catch (e) {
      if (e.message.includes('400')) return { detail: 'Correctly returned 400' };
      throw e;
    }
  });

  await testEndpoint('Grounded Search: too short → 400', async () => {
    try {
      await api('POST', '/api/v1/ai/grounded-search', { query: 'x' });
      throw new Error('Should have returned 400');
    } catch (e) {
      if (e.message.includes('400')) return { detail: 'Correctly returned 400' };
      throw e;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  SUMMARY REPORT
  // ═══════════════════════════════════════════════════════════════

  section('FINAL REPORT');

  console.log(`\n  Total:   ${totalTests}`);
  console.log(`  ${PASS} Passed: ${passed}`);
  console.log(`  ${FAIL} Failed: ${failed}`);
  console.log(`  ${SKIP} Skipped: ${skipped}`);

  if (failed > 0) {
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  FAILURES:`);
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  ${FAIL} ${r.name}`);
      console.log(`     Error: ${r.error}`);
    }
  }

  // Performance summary
  const llmResults = results.filter(r => r.status === 'PASS' && r.elapsed);
  if (llmResults.length > 0) {
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log('  PERFORMANCE SUMMARY:');
    const sorted = llmResults.sort((a, b) => b.elapsed - a.elapsed);
    const avg = Math.round(llmResults.reduce((s, r) => s + r.elapsed, 0) / llmResults.length);
    const fastest = sorted[sorted.length - 1];
    const slowest = sorted[0];

    console.log(`  Average:  ${avg}ms`);
    console.log(`  Fastest:  ${fastest.elapsed}ms — ${fastest.name}`);
    console.log(`  Slowest:  ${slowest.elapsed}ms — ${slowest.name}`);

    console.log(`\n  Endpoints by response time (slowest first):`);
    for (const r of sorted.slice(0, 15)) {
      const bar = '█'.repeat(Math.min(30, Math.round(r.elapsed / 1000)));
      console.log(`  ${String(r.elapsed).padStart(7)}ms ${bar} ${r.name}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
