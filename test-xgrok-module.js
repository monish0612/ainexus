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
  xgrokSearch,
  xgrokConverse,
  xgrokComplete,
  isXGrokAvailable,
  resolveXGrokModel,
  getXGrokConfig,
  XGrokError,
} = require('./api/src/xgrok');

const PASS = '\u2705';
const FAIL = '\u274C';
let passed = 0;
let failed = 0;
const results = [];

function log(icon, msg) { console.log(`${icon}  ${msg}`); }
function section(title) { console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`); }

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

async function run() {
  console.log('\n\uD83E\uDDEA  xGrok Module Direct Test');
  console.log(`\uD83D\uDD11  XGROK_API_KEY: ${process.env.XGROK_API_KEY ? 'SET (' + process.env.XGROK_API_KEY.slice(0, 8) + '...)' : 'NOT SET'}`);
  console.log(`\uD83D\uDCCB  Lite: ${process.env.XGROK_LITE_MODEL || 'default'}`);
  console.log(`\uD83D\uDCCB  Deep: ${process.env.XGROK_DEEP_MODEL || 'default'}`);

  // ── 0. Config checks ──────────────────────────────────────
  section('0. CONFIG & AVAILABILITY');

  await test('isXGrokAvailable()', async () => {
    const avail = isXGrokAvailable();
    if (!avail) throw new Error('xGrok not available — check XGROK_API_KEY');
    return `available=${avail}`;
  });

  await test('getXGrokConfig()', async () => {
    const cfg = getXGrokConfig();
    if (!cfg.available) throw new Error('Not available');
    if (!cfg.liteModel) throw new Error('No liteModel');
    if (!cfg.deepModel) throw new Error('No deepModel');
    return `lite=${cfg.liteModel}, deep=${cfg.deepModel}`;
  });

  await test('resolveXGrokModel(lite)', async () => {
    const m = resolveXGrokModel('lite');
    if (!m || !m.includes('grok')) throw new Error(`Unexpected: ${m}`);
    return `model=${m}`;
  });

  await test('resolveXGrokModel(deep)', async () => {
    const m = resolveXGrokModel('deep');
    if (!m || !m.includes('grok')) throw new Error(`Unexpected: ${m}`);
    return `model=${m}`;
  });

  // ── 1. xgrokSearch (Responses API + web_search) ───────────
  section('1. xgrokSearch (Responses API)');

  await test('xgrokSearch — LITE model', async () => {
    const liteModel = resolveXGrokModel('lite');
    const r = await xgrokSearch('What is the current population of India in 2026?', {
      model: liteModel,
      maxTokens: 2048,
      timeoutMs: 60000,
    });
    if (!r.text || r.text.length < 20) throw new Error(`Response too short: ${r.text?.length}`);
    if (!r.model || !r.model.includes('grok')) throw new Error(`Wrong model: ${r.model}`);
    return `model=${r.model} | len=${r.text.length} | sources=${r.sources?.length || 0} | searches=[${r.searchQueries?.join(', ')}]`;
  });

  await test('xgrokSearch — DEEP model', async () => {
    const deepModel = resolveXGrokModel('deep');
    const r = await xgrokSearch('Latest developments in quantum computing 2026', {
      model: deepModel,
      maxTokens: 4096,
      timeoutMs: 120000,
    });
    if (!r.text || r.text.length < 50) throw new Error(`Response too short: ${r.text?.length}`);
    if (!r.model || !r.model.includes('grok')) throw new Error(`Wrong model: ${r.model}`);
    return `model=${r.model} | len=${r.text.length} | sources=${r.sources?.length || 0} | searches=[${r.searchQueries?.join(', ')}]`;
  });

  // ── 2. xgrokConverse (Responses API + web_search) ─────────
  section('2. xgrokConverse (Responses API)');

  await test('xgrokConverse — single turn, LITE', async () => {
    const liteModel = resolveXGrokModel('lite');
    const history = [{ role: 'user', text: 'What are the top 3 tech companies by market cap right now?' }];
    const r = await xgrokConverse(history, 'You are a concise financial analyst.', {
      model: liteModel,
      maxTokens: 2048,
      timeoutMs: 60000,
    });
    if (!r.text || r.text.length < 30) throw new Error(`Too short: ${r.text?.length}`);
    if (!r.model?.includes('grok')) throw new Error(`Wrong model: ${r.model}`);
    return `model=${r.model} | len=${r.text.length} | sources=${r.sources?.length || 0}`;
  });

  await test('xgrokConverse — multi-turn, LITE', async () => {
    const liteModel = resolveXGrokModel('lite');
    const history = [
      { role: 'user', text: 'Who won the Cricket World Cup 2025?' },
      { role: 'assistant', text: 'India won the 2025 Champions Trophy.' },
      { role: 'user', text: 'Who was the player of the match in the final?' },
    ];
    const r = await xgrokConverse(history, 'You are a sports journalist.', {
      model: liteModel,
      maxTokens: 2048,
      timeoutMs: 60000,
    });
    if (!r.text || r.text.length < 10) throw new Error(`Too short: ${r.text?.length}`);
    if (!r.model?.includes('grok')) throw new Error(`Wrong model: ${r.model}`);
    return `model=${r.model} | len=${r.text.length} | sources=${r.sources?.length || 0}`;
  });

  await test('xgrokConverse — DEEP model', async () => {
    const deepModel = resolveXGrokModel('deep');
    const history = [{ role: 'user', text: 'Explain the current state of AI regulation in the EU in 2026.' }];
    const r = await xgrokConverse(history, 'You are a legal expert on technology policy.', {
      model: deepModel,
      maxTokens: 4096,
      timeoutMs: 120000,
    });
    if (!r.text || r.text.length < 50) throw new Error(`Too short: ${r.text?.length}`);
    if (!r.model?.includes('grok')) throw new Error(`Wrong model: ${r.model}`);
    return `model=${r.model} | len=${r.text.length} | sources=${r.sources?.length || 0}`;
  });

  // ── 3. xgrokComplete (Chat Completions API, no tools) ─────
  section('3. xgrokComplete (Chat Completions API)');

  await test('xgrokComplete — LITE model (summarize)', async () => {
    const liteModel = resolveXGrokModel('lite');
    const r = await xgrokComplete({
      model: liteModel,
      messages: [
        { role: 'system', content: 'You are a concise summarizer. Summarize in 2-3 sentences.' },
        { role: 'user', content: 'The Indian economy grew at 7.2% in Q3 2025, driven by strong domestic consumption and a revival in manufacturing. The Reserve Bank of India maintained its repo rate at 6.5%, signaling a cautious approach amid global uncertainties. However, agricultural output was impacted by uneven monsoon patterns, leading to a slight uptick in food inflation.' },
      ],
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: 30000,
    });
    if (!r.content || r.content.length < 20) throw new Error(`Too short: ${r.content?.length}`);
    if (!r.model_used?.includes('grok')) throw new Error(`Wrong model: ${r.model_used}`);
    return `model=${r.model_used} | len=${r.content.length}`;
  });

  await test('xgrokComplete — DEEP model (analysis)', async () => {
    const deepModel = resolveXGrokModel('deep');
    const r = await xgrokComplete({
      model: deepModel,
      messages: [
        { role: 'system', content: 'You are an expert analyst. Provide a concise analysis.' },
        { role: 'user', content: 'Compare the pros and cons of React Native vs Flutter for mobile app development in 2026.' },
      ],
      temperature: 0.5,
      maxTokens: 1500,
      timeoutMs: 60000,
    });
    if (!r.content || r.content.length < 50) throw new Error(`Too short: ${r.content?.length}`);
    if (!r.model_used?.includes('grok')) throw new Error(`Wrong model: ${r.model_used}`);
    return `model=${r.model_used} | len=${r.content.length}`;
  });

  // ── 4. Response structure validation ───────────────────────
  section('4. RESPONSE STRUCTURE VALIDATION');

  await test('Search result has correct shape', async () => {
    const liteModel = resolveXGrokModel('lite');
    const r = await xgrokSearch('Latest iPhone model 2026', {
      model: liteModel,
      maxTokens: 1024,
      timeoutMs: 60000,
    });
    const checks = [];
    if (typeof r.text !== 'string') throw new Error(`text not string: ${typeof r.text}`);
    checks.push('text:string');
    if (typeof r.model !== 'string') throw new Error(`model not string: ${typeof r.model}`);
    checks.push('model:string');
    if (!Array.isArray(r.sources)) throw new Error(`sources not array: ${typeof r.sources}`);
    checks.push(`sources:array(${r.sources.length})`);
    if (!Array.isArray(r.searchQueries)) throw new Error(`searchQueries not array`);
    checks.push(`searchQueries:array(${r.searchQueries.length})`);
    if (r.sources.length > 0) {
      const s = r.sources[0];
      if (!s.url) throw new Error('Source missing url');
      checks.push('source.url:present');
    }
    return checks.join(' | ');
  });

  await test('Complete result has correct shape', async () => {
    const liteModel = resolveXGrokModel('lite');
    const r = await xgrokComplete({
      model: liteModel,
      messages: [{ role: 'user', content: 'Say hello' }],
      maxTokens: 100,
      timeoutMs: 15000,
    });
    const checks = [];
    if (typeof r.content !== 'string') throw new Error(`content not string: ${typeof r.content}`);
    checks.push('content:string');
    if (typeof r.model_used !== 'string') throw new Error(`model_used not string`);
    checks.push('model_used:string');
    if (r.usage && typeof r.usage !== 'object') throw new Error(`usage not object`);
    checks.push('usage:object');
    return checks.join(' | ');
  });

  // ── 5. Error handling ──────────────────────────────────────
  section('5. ERROR HANDLING');

  await test('XGrokError thrown for bad API key', async () => {
    const origKey = process.env.XGROK_API_KEY;
    process.env.XGROK_API_KEY = 'xai-invalid-key-12345';
    try {
      await xgrokComplete({
        model: 'grok-4-1-fast-non-reasoning',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 10,
        timeoutMs: 10000,
      });
      throw new Error('Should have thrown');
    } catch (e) {
      if (e.message === 'Should have thrown') throw e;
      return `Correctly threw: ${e.constructor.name} (status=${e.status || 'N/A'})`;
    } finally {
      process.env.XGROK_API_KEY = origKey;
    }
  });

  // ── REPORT ─────────────────────────────────────────────────
  section('FINAL REPORT');

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
  for (const r of sorted.slice(0, 10)) {
    const bar = '\u2588'.repeat(Math.min(30, Math.ceil(r.ms / 2000)));
    console.log(`    ${String(r.ms).padStart(6)}ms ${bar} ${r.name}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
