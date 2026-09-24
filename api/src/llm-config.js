'use strict';

// ═══════════════════════════════════════════════════════════════
//  LLM CONFIG — the one place Gemini settings are read from env
//
//  Env:
//    GOOGLE_API_KEY    required. Key with the Generative Language API enabled.
//    GROUNDING_MODELS  required. Comma-separated Gemini ids. The grounded-search
//                      model list, and the fallbacks tried after an explicitly
//                      requested Gemini model fails. Never used as a default:
//                      a call that names no model is rejected.
//    GEMINI_PRO_MODEL  optional. Deep grounded research model.
//
//  Values are read live on every call so tests can toggle them.
// ═══════════════════════════════════════════════════════════════

// Rejects a missing key and an unexpanded `${GOOGLE_API_KEY}` placeholder.
// Real Google API keys are 39 chars; anything under 30 is a mistake.
function readGoogleApiKey() {
  const raw = process.env.GOOGLE_API_KEY;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('${') || trimmed === '<unset>' || trimmed === 'null') return null;
  if (trimmed.length < 30) return null;
  return trimmed;
}

function geminiModels() {
  return (process.env.GROUNDING_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function geminiProModel() {
  return process.env.GEMINI_PRO_MODEL || '';
}

/** Returns what is wrong with the LLM env, or null when it is usable. */
function llmConfigProblem() {
  if (!readGoogleApiKey()) {
    return 'GOOGLE_API_KEY is missing, an unexpanded placeholder, or shorter than 30 chars';
  }
  const models = geminiModels();
  if (models.length === 0) {
    return 'GROUNDING_MODELS is empty — set at least one Gemini model id, e.g. gemini-3.1-flash-lite-preview';
  }
  const bad = models.filter((m) => !/^(models\/)?gemini/i.test(m));
  if (bad.length > 0) {
    return `GROUNDING_MODELS must list Gemini ids only; got: ${bad.join(', ')}`;
  }
  return null;
}

module.exports = {
  readGoogleApiKey,
  geminiModels,
  geminiProModel,
  llmConfigProblem,
};
