import fetch from 'node-fetch';

function liteLLMBaseUrl() {
  const url = process.env.LITELLM_URL;
  if (!url) throw new Error('LITELLM_URL env var not set');
  return url.replace(/\/$/, '');
}

function litellmHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const key = process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY;
  if (key) h.Authorization = `Bearer ${key.trim()}`;
  return h;
}

function _getModelPriority() {
  const raw = process.env._LITELLM_MODEL_PRIORITY;
  if (raw) {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  return [];
}

/**
 * @param {string} [model]
 * @param {Array<{role: string, content: string}>} messages
 * @param {Record<string, unknown>} [options]
 */
export async function callLiteLLM(model, messages, options = {}) {
  const priority = _getModelPriority();
  const resolvedModel = model || (priority.length > 0 ? priority[0] : null);

  if (!resolvedModel) {
    throw new Error('No LiteLLM model available — set _LITELLM_MODEL_PRIORITY or pass model explicitly');
  }

  const response = await fetch(`${liteLLMBaseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: litellmHeaders(),
    body: JSON.stringify({
      model: resolvedModel,
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
