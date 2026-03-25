import fetch from 'node-fetch';

function liteLLMBaseUrl() {
  return (process.env.LITELLM_URL || 'http://72.60.219.97:4000').replace(/\/$/, '');
}

function litellmHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  if (key) h.Authorization = `Bearer ${key.trim()}`;
  return h;
}

/**
 * @param {string} [model]
 * @param {Array<{role: string, content: string}>} messages
 * @param {Record<string, unknown>} [options]
 */
export async function callLiteLLM(model, messages, options = {}) {
  const response = await fetch(`${liteLLMBaseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: litellmHeaders(),
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      ...options,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LiteLLM non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message || `LiteLLM ${response.status}: ${text.slice(0, 300)}`,
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error('LiteLLM response missing choices[0].message.content');
  }
  return content;
}

export { liteLLMBaseUrl };
