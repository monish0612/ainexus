'use strict';

// ═══════════════════════════════════════════════════════════════
//  SMART-PARSE PROMPT — contract tests (node:test, no network/LLM)
//
//  Locks in the bank/card transaction-alert (SMS / push notification)
//  handling added so that text shared into the app (e.g. an HDFC/Axis
//  "Spent Rs.X ... At MERCHANT" alert) gets parsed into an expense the
//  same way bill OCR text does. We can't assert live LLM output
//  deterministically, so we assert the SYSTEM PROMPT contains the
//  instructions + worked examples that make that parse reliable.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SMART_PARSE_SYSTEM_PROMPT,
  buildSmartParseSystemPrompt,
} = require('../src/prompts');

test('prompt still requests the strict 5-field JSON contract', () => {
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /"amount": number, "description": "string", "bank": "string", "cardType": "string", "category": "string"/,
  );
});

test('prompt has a dedicated bank/card transaction alert section', () => {
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /BANK \/ CARD TRANSACTION ALERT \(SMS \/ PUSH NOTIFICATION\)/,
  );
});

test('prompt lists the transaction trigger verbs', () => {
  for (const verb of ['Spent', 'Sent', 'Txn', 'Debited', 'Paid']) {
    assert.ok(
      SMART_PARSE_SYSTEM_PROMPT.includes(verb),
      `trigger verb "${verb}" must be documented`,
    );
  }
});

test('prompt instructs merchant extraction after "At"/"To" and cleanup', () => {
  assert.match(SMART_PARSE_SYSTEM_PROMPT, /text right after "At" or "To"/);
  // ALL-CAPS / glued name normalisation examples.
  assert.match(SMART_PARSE_SYSTEM_PROMPT, /SANTHOSH SUPER STORES.*Santhosh Super Stores/);
  assert.match(SMART_PARSE_SYSTEM_PROMPT, /NOBROKER TECHNOLOGIES.*Nobroker Technologies/);
});

test('prompt handles UPI VPA handles and person payees', () => {
  assert.match(SMART_PARSE_SYSTEM_PROMPT, /UPI VPA/);
  assert.match(SMART_PARSE_SYSTEM_PROMPT, /B\. Kamalakannan/);
});

test('prompt tells the model to IGNORE the boilerplate noise', () => {
  for (const noise of ['Not You?', 'SMS BLOCK', 'Avl Limit', 'Ref']) {
    assert.ok(
      SMART_PARSE_SYSTEM_PROMPT.includes(noise),
      `boilerplate token "${noise}" must be called out as ignorable`,
    );
  }
});

test('prompt never falls back to CASH when a real bank is named', () => {
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /NEVER fall back to CASH for these alerts/,
  );
});

// ── Bank-config awareness (cards added in Settings after release) ──────────

test('default prompt (no banks) keeps the built-in bank set', () => {
  const p = buildSmartParseSystemPrompt();
  assert.match(p, /3\. BANK \(string\): One of "HDFC", "ICICI", "AXIS", "SCAPIA", "CASH"\./);
  // The exported constant is the no-arg default.
  assert.equal(p, SMART_PARSE_SYSTEM_PROMPT);
});

test('configured banks are injected into the BANK field + aliases', () => {
  const p = buildSmartParseSystemPrompt(['HDFC', 'KOTAK', 'SCAPIA']);
  // The newly added KOTAK card is now part of the allowed list...
  assert.match(p, /3\. BANK \(string\): One of "HDFC", "KOTAK", "SCAPIA", "CASH"\./);
  // ...with a lowercase alias so voice/STT maps "kotak" → "KOTAK".
  assert.match(p, /"kotak" → "KOTAK"/);
  // CASH is always retained as the default fallback.
  assert.match(p, /★ CRITICAL DEFAULT: If NO bank from this list is mentioned, default to "CASH"\./);
  // The SMS detection line also references the configured list.
  assert.match(p, /map it to one of these: "HDFC", "KOTAK", "SCAPIA", "CASH"/);
});

test('builder sanitises dirty bank input (case, dups, empties, CASH)', () => {
  const p = buildSmartParseSystemPrompt(['hdfc', 'HDFC', '  kotak  ', '', 'CASH', null]);
  // Deduped + uppercased + CASH stripped from the configured part, then re-added once.
  assert.match(p, /3\. BANK \(string\): One of "HDFC", "KOTAK", "CASH"\./);
  // No empty / null bank tokens leak in.
  assert.doesNotMatch(p, /"" →/);
});

test('empty / non-array banks fall back to the default set', () => {
  for (const arg of [[], undefined, null, 'HDFC', 42]) {
    const p = buildSmartParseSystemPrompt(arg);
    assert.match(p, /One of "HDFC", "ICICI", "AXIS", "SCAPIA", "CASH"\./);
  }
});

test('multi-word bank names are upper-cased and aliased verbatim', () => {
  const p = buildSmartParseSystemPrompt(['Bank Of Baroda', 'IDFC First']);
  assert.match(p, /One of "BANK OF BARODA", "IDFC FIRST", "CASH"\./);
  assert.match(p, /"bank of baroda" → "BANK OF BARODA"/);
  assert.match(p, /"idfc first" → "IDFC FIRST"/);
});

test('a large bank list still yields a valid, CASH-terminated contract', () => {
  const many = Array.from({ length: 60 }, (_, i) => `BANK${i}`);
  const p = buildSmartParseSystemPrompt(many);
  // CASH is always the last entry + JSON contract intact.
  assert.match(p, /"BANK59", "CASH"\./);
  assert.match(
    p,
    /"amount": number, "description": "string", "bank": "string", "cardType": "string", "category": "string"/,
  );
  // Every configured bank made it into the list.
  for (const b of ['"BANK0"', '"BANK30"', '"BANK59"']) {
    assert.ok(p.includes(b), `${b} must be present`);
  }
});

test('prompt includes worked examples for every sample alert template', () => {
  // CC card spend → Grocery
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /SANTHOSH SUPER STORES[\s\S]*?"amount":842[\s\S]*?"bank":"HDFC"[\s\S]*?"cardType":"CC"[\s\S]*?"category":"Grocery"/,
  );
  // Axis fuel spend, DB default, decimal amount preserved
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /STAR FUEL S[\s\S]*?"amount":3790\.37[\s\S]*?"bank":"AXIS"[\s\S]*?"cardType":"DB"[\s\S]*?"category":"Fuel"/,
  );
  // UPI person transfer → Friends
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /KAMALAKANNAN[\s\S]*?"amount":350[\s\S]*?"description":"B\. Kamalakannan"[\s\S]*?"category":"Friends"/,
  );
  // UPI VPA → Paytm brand
  assert.match(
    SMART_PARSE_SYSTEM_PROMPT,
    /paytm\.s29gayk@pty[\s\S]*?"description":"Paytm"/,
  );
});
