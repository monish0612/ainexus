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

const { SMART_PARSE_SYSTEM_PROMPT } = require('../src/prompts');

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
