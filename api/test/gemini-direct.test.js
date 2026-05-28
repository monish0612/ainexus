'use strict';

// ═══════════════════════════════════════════════════════════════
//  GEMINI-DIRECT — unit tests (node:test, no external runners)
//
//  Coverage:
//    • Model-id helpers: isGeminiModel, normaliseModelId, stripGeminiPrefix
//    • Error mapping: GeminiDirectError → HTTP status
//    • Message conversion: OpenAI → Gemini body shape
//    • Error envelopes: 404 → MODEL_NOT_FOUND, 429 → RATE_LIMIT, 5xx → SERVER
//    • Retry behaviour for recoverable failures
//
//  We monkey-patch global.fetch to fake Google's REST API so no
//  network calls are made — these tests run in CI without a key.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  geminiComplete,
  isGeminiModel,
  normaliseModelId,
  stripGeminiPrefix,
  GeminiDirectError,
  ERROR_CODES,
  mapErrorToHttp,
} = require('../src/gemini-direct');

// ── Helpers ────────────────────────────────────────────────────

function withFakeFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (k) => headers[k.toLowerCase()] || null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

// Ensure the module sees a valid-LOOKING key even in CI — the real
// network path is faked, but `_readGoogleApiKey()` requires ≥30
// chars so it can detect unsubstituted env placeholders in
// production. Use a 40-char fake that mimics the real shape.
process.env.GOOGLE_API_KEY = 'AIzaTEST_CI_FAKE_KEY_4444444444444444444';

// ── Model id helpers ───────────────────────────────────────────

test('isGeminiModel: bare gemini id', () => {
  assert.equal(isGeminiModel('gemini-3.1-flash-lite'), true);
  assert.equal(isGeminiModel('gemini-2.5-flash'), true);
  assert.equal(isGeminiModel('gemini-2.5-pro'), true);
});

test('isGeminiModel: prefixed forms', () => {
  assert.equal(isGeminiModel('gemini/gemini-3.1-flash-lite-preview'), true);
  assert.equal(isGeminiModel('models/gemini-2.5-flash'), true);
});

test('isGeminiModel: rejects non-gemini providers', () => {
  assert.equal(isGeminiModel('groq/llama-3.3-70b-versatile'), false);
  assert.equal(isGeminiModel('grok-4-1-fast-non-reasoning'), false);
  assert.equal(isGeminiModel('openai/gpt-4o'), false);
});

test('isGeminiModel: rejects empty / non-string', () => {
  assert.equal(isGeminiModel(''), false);
  assert.equal(isGeminiModel('   '), false);
  assert.equal(isGeminiModel(null), false);
  assert.equal(isGeminiModel(undefined), false);
  assert.equal(isGeminiModel(123), false);
});

test('normaliseModelId: strips both gemini/ and models/ prefixes', () => {
  assert.equal(normaliseModelId('gemini/gemini-3.1-flash-lite-preview'), 'gemini-3.1-flash-lite-preview');
  assert.equal(normaliseModelId('models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(normaliseModelId('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(normaliseModelId('  gemini-3.1-flash-lite  '), 'gemini-3.1-flash-lite');
});

test('stripGeminiPrefix: only removes the gemini/ prefix', () => {
  assert.equal(stripGeminiPrefix('gemini/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(stripGeminiPrefix('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(stripGeminiPrefix('models/gemini-2.5-flash'), 'models/gemini-2.5-flash');
});

// ── Error mapping ──────────────────────────────────────────────

test('mapErrorToHttp: known codes', () => {
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.MODEL_NOT_FOUND)), 404);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.RATE_LIMIT)), 429);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.TIMEOUT)), 504);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.NETWORK)), 502);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.BLOCKED)), 400);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.CONFIG)), 503);
  assert.equal(mapErrorToHttp(new GeminiDirectError('x', ERROR_CODES.INVALID_MODEL)), 400);
});

test('mapErrorToHttp: SERVER preserves the original status', () => {
  const err = new GeminiDirectError('x', ERROR_CODES.SERVER, 503);
  assert.equal(mapErrorToHttp(err), 503);
});

test('mapErrorToHttp: non-GeminiDirectError returns 500', () => {
  assert.equal(mapErrorToHttp(new Error('plain')), 500);
});

// ── API key sanity (unsubstituted placeholder detection) ────────

test('geminiComplete: CONFIG error when GOOGLE_API_KEY is missing', async () => {
  const originalKey = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    await assert.rejects(
      () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof GeminiDirectError && err.code === ERROR_CODES.CONFIG,
    );
  } finally {
    process.env.GOOGLE_API_KEY = originalKey;
  }
});

test('geminiComplete: CONFIG error when key is the unsubstituted ${...} placeholder', async () => {
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = '${GOOGLE_API_KEY}';
  try {
    await assert.rejects(
      () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof GeminiDirectError && err.code === ERROR_CODES.CONFIG,
    );
  } finally {
    process.env.GOOGLE_API_KEY = originalKey;
  }
});

test('geminiComplete: CONFIG error when key is suspiciously short', async () => {
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'too-short';
  try {
    await assert.rejects(
      () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof GeminiDirectError && err.code === ERROR_CODES.CONFIG,
    );
  } finally {
    process.env.GOOGLE_API_KEY = originalKey;
  }
});

// ── Validation ─────────────────────────────────────────────────

test('geminiComplete: throws INVALID_MODEL for empty/missing model', async () => {
  await assert.rejects(
    () => geminiComplete({ model: '', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GeminiDirectError && err.code === ERROR_CODES.INVALID_MODEL,
  );
  await assert.rejects(
    () => geminiComplete({ model: undefined, messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof GeminiDirectError && err.code === ERROR_CODES.INVALID_MODEL,
  );
});

// ── Happy path ─────────────────────────────────────────────────

test('geminiComplete: success returns content + usage', async () => {
  await withFakeFetch(
    async (_url) =>
      jsonResponse(200, {
        candidates: [{
          content: { parts: [{ text: 'Hello world.' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      }),
    async () => {
      const r = await geminiComplete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(r.content, 'Hello world.');
      assert.equal(r.model_used, 'gemini-2.5-flash');
      assert.equal(r.usage.total_tokens, 16);
    },
  );
});

test('geminiComplete: forwards bare id verbatim (whatever user set in Settings)', async () => {
  let receivedUrl = '';
  await withFakeFetch(
    async (url) => {
      receivedUrl = url;
      return jsonResponse(200, {
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini-3.1-flash-lite-preview',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.ok(receivedUrl.includes('/models/gemini-3.1-flash-lite-preview'),
        `URL should contain bare model id: ${receivedUrl}`);
    },
  );
});

test('geminiComplete: strips gemini/ prefix before hitting Google', async () => {
  let receivedUrl = '';
  await withFakeFetch(
    async (url) => {
      receivedUrl = url;
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.ok(receivedUrl.includes('/models/gemini-2.5-pro'),
        `URL should strip prefix: ${receivedUrl}`);
      assert.ok(!receivedUrl.includes('/models/gemini%2F'),
        `URL should NOT contain encoded slash: ${receivedUrl}`);
    },
  );
});

// ── Error envelopes ────────────────────────────────────────────

test('geminiComplete: 404 from Google → MODEL_NOT_FOUND', async () => {
  await withFakeFetch(
    async () => jsonResponse(404, { error: { message: 'models/gemini-foo is not found for API version v1beta', code: 404 } }),
    async () => {
      await assert.rejects(
        () => geminiComplete({ model: 'gemini-foo', messages: [{ role: 'user', content: 'hi' }] }),
        (e) =>
          e instanceof GeminiDirectError &&
          e.code === ERROR_CODES.MODEL_NOT_FOUND &&
          e.status === 404 &&
          e.model === 'gemini-foo',
      );
    },
  );
});

test('geminiComplete: 429 → RATE_LIMIT', async () => {
  // 429 is retryable so we need to fake enough responses to exhaust retries.
  let calls = 0;
  await withFakeFetch(
    async () => {
      calls++;
      return jsonResponse(429, { error: { message: 'Quota exceeded', code: 429 } });
    },
    async () => {
      await assert.rejects(
        () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e instanceof GeminiDirectError && e.code === ERROR_CODES.RATE_LIMIT,
      );
      assert.ok(calls >= 2, `expected at least 2 attempts due to retry, got ${calls}`);
    },
  );
});

test('geminiComplete: safety block → BLOCKED', async () => {
  await withFakeFetch(
    async () => jsonResponse(200, {
      promptFeedback: { blockReason: 'SAFETY' },
    }),
    async () => {
      await assert.rejects(
        () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e instanceof GeminiDirectError && e.code === ERROR_CODES.BLOCKED,
      );
    },
  );
});

test('geminiComplete: finishReason=SAFETY mid-stream → BLOCKED', async () => {
  await withFakeFetch(
    async () => jsonResponse(200, {
      candidates: [{
        content: { parts: [] },
        finishReason: 'SAFETY',
      }],
    }),
    async () => {
      await assert.rejects(
        () => geminiComplete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }),
        (e) => e instanceof GeminiDirectError && e.code === ERROR_CODES.BLOCKED,
      );
    },
  );
});

// ── Message conversion ─────────────────────────────────────────

test('geminiComplete: system messages are folded into systemInstruction', async () => {
  let receivedBody = null;
  await withFakeFetch(
    async (_url, opts) => {
      receivedBody = JSON.parse(opts.body);
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello' },
        ],
      });
      assert.ok(receivedBody.systemInstruction, 'systemInstruction missing');
      assert.equal(receivedBody.systemInstruction.parts[0].text, 'be brief');
      assert.equal(receivedBody.contents.length, 1);
      assert.equal(receivedBody.contents[0].role, 'user');
      assert.equal(receivedBody.contents[0].parts[0].text, 'hello');
    },
  );
});

test('geminiComplete: assistant → model role mapping', async () => {
  let receivedBody = null;
  await withFakeFetch(
    async (_url, opts) => {
      receivedBody = JSON.parse(opts.body);
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'what is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'thanks' },
        ],
      });
      const roles = receivedBody.contents.map((c) => c.role);
      assert.deepEqual(roles, ['user', 'model', 'user']);
    },
  );
});

test('geminiComplete: jsonOutput sets responseMimeType', async () => {
  let receivedBody = null;
  await withFakeFetch(
    async (_url, opts) => {
      receivedBody = JSON.parse(opts.body);
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'json please' }],
        jsonOutput: true,
      });
      assert.equal(receivedBody.generationConfig.responseMimeType, 'application/json');
    },
  );
});

// ── Inline base64 image support ────────────────────────────────

test('geminiComplete: inline data:base64 image is forwarded as inline_data', async () => {
  let receivedBody = null;
  await withFakeFetch(
    async (_url, opts) => {
      receivedBody = JSON.parse(opts.body);
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    },
    async () => {
      await geminiComplete({
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      });
      const parts = receivedBody.contents[0].parts;
      assert.equal(parts.length, 2);
      assert.equal(parts[1].inline_data.mime_type, 'image/png');
      assert.equal(parts[1].inline_data.data, 'AAAA');
    },
  );
});
