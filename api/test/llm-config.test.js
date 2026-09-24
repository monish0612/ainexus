'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readGoogleApiKey,
  geminiModels,
  geminiProModel,
  llmConfigProblem,
} = require('../src/llm-config');

const VALID_KEY = 'AIzaTEST_CI_FAKE_KEY_4444444444444444444';
const KEYS = ['GOOGLE_API_KEY', 'GROUNDING_MODELS', 'GEMINI_PRO_MODEL'];

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

test('a valid key and Gemini model list pass', () => {
  withEnv({ GOOGLE_API_KEY: VALID_KEY, GROUNDING_MODELS: 'gemini-3.1-flash-lite-preview' }, () => {
    assert.equal(llmConfigProblem(), null);
    assert.equal(readGoogleApiKey(), VALID_KEY);
  });
});

test('a missing, placeholder, or short key is a problem', () => {
  for (const key of [undefined, '', '   ', '${GOOGLE_API_KEY}', 'null', 'too-short']) {
    const env = { GROUNDING_MODELS: 'gemini-3.1-flash-lite-preview' };
    if (key !== undefined) env.GOOGLE_API_KEY = key;
    withEnv(env, () => {
      assert.equal(readGoogleApiKey(), null);
      assert.match(llmConfigProblem(), /GOOGLE_API_KEY/);
    });
  }
});

test('an empty model list is a problem', () => {
  for (const models of [undefined, '', ' , ,']) {
    const env = { GOOGLE_API_KEY: VALID_KEY };
    if (models !== undefined) env.GROUNDING_MODELS = models;
    withEnv(env, () => {
      assert.deepEqual(geminiModels(), []);
      assert.match(llmConfigProblem(), /GROUNDING_MODELS is empty/);
    });
  }
});

test('a non-Gemini model in the list is a problem', () => {
  withEnv({ GOOGLE_API_KEY: VALID_KEY, GROUNDING_MODELS: 'gemini-3.1-flash-lite-preview, groq/llama-3.3-70b-versatile' }, () => {
    assert.match(llmConfigProblem(), /Gemini ids only; got: groq\/llama-3\.3-70b-versatile/);
  });
});

test('the model list is trimmed and keeps order', () => {
  withEnv({ GROUNDING_MODELS: ' gemini-a , gemini-b,,gemini-c ' }, () => {
    assert.deepEqual(geminiModels(), ['gemini-a', 'gemini-b', 'gemini-c']);
  });
});

test('the pro model is optional', () => {
  withEnv({}, () => assert.equal(geminiProModel(), ''));
  withEnv({ GEMINI_PRO_MODEL: 'gemini-3.1-pro-preview' }, () => {
    assert.equal(geminiProModel(), 'gemini-3.1-pro-preview');
  });
});
