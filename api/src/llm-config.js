'use strict';

// ═══════════════════════════════════════════════════════════════
//  PROVIDER CONFIG — the one place AI provider settings are read from env
//
//  Env (standard names, supplied by Coolify team variables):
//    GEMINI_API_KEY          required. Key with the Generative Language API enabled.
//    GEMINI_FALLBACK_MODELS  required. Comma-separated Gemini ids. The grounded-search
//                            model list, and the fallbacks tried after an explicitly
//                            requested Gemini model fails. Never used as a default:
//                            a call that names no model is rejected.
//    GEMINI_PRO_MODEL        optional. Deep grounded research model.
//    TAVILY_API_KEY          required. Tavily web search.
//    XAI_API_KEY             required. xAI Grok.
//    ZYTE_API_KEY            required. Zyte article extraction.
//
//  Values are read live on every call so tests can toggle them.
// ═══════════════════════════════════════════════════════════════

// Rejects a missing value and an unexpanded `${NAME}` / `{{team.NAME}}` placeholder.
function readKey(name, minLength) {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('${') || trimmed.startsWith('{{') || trimmed === '<unset>' || trimmed === 'null') return null;
  if (trimmed.length < minLength) return null;
  return trimmed;
}

function readGeminiApiKey() {
  return readKey('GEMINI_API_KEY', 30);
}

function readTavilyApiKey() {
  return readKey('TAVILY_API_KEY', 20);
}

function readXaiApiKey() {
  return readKey('XAI_API_KEY', 20);
}

function readZyteApiKey() {
  return readKey('ZYTE_API_KEY', 20);
}

function geminiModels() {
  return (process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function geminiProModel() {
  return process.env.GEMINI_PRO_MODEL || '';
}

/** Returns what is wrong with the provider env, or null when it is usable. */
function llmConfigProblem() {
  if (!readGeminiApiKey()) {
    return 'GEMINI_API_KEY is missing, an unexpanded placeholder, or shorter than 30 chars';
  }
  const models = geminiModels();
  if (models.length === 0) {
    return 'GEMINI_FALLBACK_MODELS is empty — set at least one Gemini model id, e.g. gemini-3.1-flash-lite-preview';
  }
  const bad = models.filter((m) => !/^(models\/)?gemini/i.test(m));
  if (bad.length > 0) {
    return `GEMINI_FALLBACK_MODELS must list Gemini ids only; got: ${bad.join(', ')}`;
  }
  for (const [name, read] of [['TAVILY_API_KEY', readTavilyApiKey], ['XAI_API_KEY', readXaiApiKey], ['ZYTE_API_KEY', readZyteApiKey]]) {
    if (!read()) return `${name} is missing, an unexpanded placeholder, or shorter than 20 chars`;
  }
  return null;
}

module.exports = {
  readGeminiApiKey,
  readTavilyApiKey,
  readXaiApiKey,
  readZyteApiKey,
  geminiModels,
  geminiProModel,
  llmConfigProblem,
};
