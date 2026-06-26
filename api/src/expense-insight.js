'use strict';

// ═══════════════════════════════════════════════════════════════
//  EXPENSE INSIGHT — generative, grounded recommendation composer
//
//  Pure (no network/LLM/DB) so it is unit-testable. The route in index.js
//  wires this prompt to callLiteLLM and runs the response through
//  sanitizeInsightResponse before returning it. Numbers are NEVER produced by
//  the model — it only emits {{token}} placeholders that the Flutter client
//  binds to real, pre-computed figures (and validates), which is what makes
//  the output dynamic yet impossible to hallucinate.
// ═══════════════════════════════════════════════════════════════

function buildExpenseInsightPrompt(firstName, facts) {
  const safeFacts = facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
  const tokenNames = Object.keys(safeFacts);
  return [
    `You are a warm, encouraging personal-finance coach for an Indian user named ${firstName}. Currency is INR (rupees).`,
    'You are given FACTS: a set of PRE-COMPUTED tokens about the user\'s own spending. Each token has a "display" string (already formatted) and sometimes a numeric "value". These are the ONLY truths you may reference.',
    `FACTS = ${JSON.stringify(safeFacts)}`,
    `Available token names: ${tokenNames.length ? tokenNames.join(', ') : '(none)'}.`,
    '',
    'Write a SHORT, dynamic, personalized recommendation as a JSON object with EXACTLY these keys:',
    '{',
    '  "greeting": string,  // a short personalized opener that addresses the user, MUST include {{name}} (e.g. "Hey {{name}},")',
    '  "headline": string,  // ONE punchy insight sentence; reference figures only via {{token}} placeholders',
    '  "tip": string,       // 1-2 sentences with ONE concrete, actionable money-saving suggestion grounded in the facts (e.g. which category to trim)',
    '  "tone": string,      // one of: "info" | "warning" | "positive"',
    '  "chips": string[]    // 2-4 SHORT (<=48 chars) follow-up questions the user could tap next, plain text, no tokens needed',
    '}',
    '',
    'CRITICAL RULES - these guarantee correctness:',
    '- NEVER write any number, amount, percentage, count, or date as digits. To mention ANY value you MUST use a {{token}} placeholder named EXACTLY as it appears in FACTS (e.g. {{total}}, {{topCategory.name}}, {{topCategory.total}}, {{topCategory.pct}}, {{momDelta}}, {{momDirection}}). The app substitutes the real, verified figure. Any bare digit will cause your whole response to be discarded.',
    '- Only use token names that exist in FACTS. Never invent a token. If a useful token is absent, simply phrase around it.',
    '- Always address the user by name via {{name}} in the greeting. Be specific and motivating, not generic.',
    '- Pick tone "warning" when spending rose or is heavily concentrated, "positive" when it dropped or they are doing well, otherwise "info".',
    '- No markdown, no emojis, no tables. Output VALID JSON only.',
  ].join('\n');
}

function sanitizeInsightResponse(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const str = (v, max) => {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > max ? t.slice(0, max) : t;
  };
  const allowedTones = ['info', 'warning', 'positive'];
  const tone = allowedTones.includes(p.tone) ? p.tone : 'info';
  const chips = [];
  if (Array.isArray(p.chips)) {
    for (const c of p.chips) {
      if (typeof c !== 'string') continue;
      const v = c.trim();
      if (!v || v.length > 48) continue;
      chips.push(v);
      if (chips.length >= 4) break;
    }
  }
  return {
    greeting: str(p.greeting, 160),
    headline: str(p.headline, 220),
    tip: str(p.tip, 320),
    tone,
    chips,
  };
}

module.exports = { buildExpenseInsightPrompt, sanitizeInsightResponse };
