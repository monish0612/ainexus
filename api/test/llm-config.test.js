'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readGeminiApiKey,
  readTavilyApiKey,
  readXaiApiKey,
  readZyteApiKey,
  geminiModels,
  geminiProModel,
  llmConfigProblem,
} = require('../src/llm-config');

const VALID_KEY = 'AIzaTEST_CI_FAKE_KEY_4444444444444444444';
const OTHER_KEYS = {
  TAVILY_API_KEY: 'tvly-TEST_CI_FAKE_KEY_000000000',
  XAI_API_KEY: 'xai-TEST_CI_FAKE_KEY_0000000000000',
  ZYTE_API_KEY: 'TEST_CI_FAKE_ZYTE_KEY_00000000',
};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_FALLBACK_MODELS', 'GEMINI_PRO_MODEL', 'GOOGLE_API_KEY', 'GROUNDING_MODELS', 'XGROK_API_KEY', ...Object.keys(OTHER_KEYS)];
const BASE = { GEMINI_API_KEY: VALID_KEY, GEMINI_FALLBACK_MODELS: 'gemini-3.1-flash-lite-preview', ...OTHER_KEYS };

function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('all standard keys and a Gemini model list pass', () => {
  withEnv(BASE, () => {
    assert.equal(llmConfigProblem(), null);
    assert.equal(readGeminiApiKey(), VALID_KEY);
    assert.equal(readTavilyApiKey(), OTHER_KEYS.TAVILY_API_KEY);
    assert.equal(readXaiApiKey(), OTHER_KEYS.XAI_API_KEY);
    assert.equal(readZyteApiKey(), OTHER_KEYS.ZYTE_API_KEY);
  });
});

test('a missing, placeholder, or short Gemini key is a problem', () => {
  for (const key of [undefined, '', '   ', '${GEMINI_API_KEY}', '{{team.GEMINI_API_KEY}}', 'null', 'too-short']) {
    const env = { ...BASE };
    delete env.GEMINI_API_KEY;
    if (key !== undefined) env.GEMINI_API_KEY = key;
    withEnv(env, () => {
      assert.equal(readGeminiApiKey(), null);
      assert.match(llmConfigProblem(), /GEMINI_API_KEY/);
    });
  }
});

test('legacy names are not read', () => {
  const env = { ...OTHER_KEYS, GOOGLE_API_KEY: VALID_KEY, GROUNDING_MODELS: 'gemini-3.1-flash-lite-preview', XGROK_API_KEY: OTHER_KEYS.XAI_API_KEY };
  delete env.XAI_API_KEY;
  withEnv(env, () => {
    assert.equal(readGeminiApiKey(), null);
    assert.deepEqual(geminiModels(), []);
    assert.equal(readXaiApiKey(), null);
    assert.match(llmConfigProblem(), /GEMINI_API_KEY/);
  });
});

test('each non-Gemini provider key is required', () => {
  for (const name of Object.keys(OTHER_KEYS)) {
    const env = { ...BASE };
    delete env[name];
    withEnv(env, () => assert.match(llmConfigProblem(), new RegExp(name)));
  }
});

test('an empty model list is a problem', () => {
  for (const models of [undefined, '', ' , ,']) {
    const env = { ...BASE };
    delete env.GEMINI_FALLBACK_MODELS;
    if (models !== undefined) env.GEMINI_FALLBACK_MODELS = models;
    withEnv(env, () => {
      assert.deepEqual(geminiModels(), []);
      assert.match(llmConfigProblem(), /GEMINI_FALLBACK_MODELS is empty/);
    });
  }
});

test('a non-Gemini model in the list is a problem', () => {
  withEnv({ ...BASE, GEMINI_FALLBACK_MODELS: 'gemini-3.1-flash-lite-preview, groq/llama-3.3-70b-versatile' }, () => {
    assert.match(llmConfigProblem(), /Gemini ids only; got: groq\/llama-3\.3-70b-versatile/);
  });
});

test('the model list is trimmed and keeps order', () => {
  withEnv({ GEMINI_FALLBACK_MODELS: ' gemini-a , gemini-b,,gemini-c ' }, () => {
    assert.deepEqual(geminiModels(), ['gemini-a', 'gemini-b', 'gemini-c']);
  });
});

test('the pro model is optional', () => {
  withEnv({}, () => assert.equal(geminiProModel(), ''));
  withEnv({ GEMINI_PRO_MODEL: 'gemini-3.1-pro-preview' }, () => {
    assert.equal(geminiProModel(), 'gemini-3.1-pro-preview');
  });
});
