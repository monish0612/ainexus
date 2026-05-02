'use strict';

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM LOGGER — Backend mirror of Flutter's TLog
//
//  ZERO-LATENCY: tg.d/i/w/e are synchronous queue pushes (~1µs).
//  Actual HTTP to Telegram happens in a background timer, batched,
//  fire-and-forget. A Telegram outage can never crash or slow
//  the server. Queue is capped to prevent memory leaks under load.
// ═══════════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

const BATCH_INTERVAL = 3000;
const MAX_BATCH = 10;
const MAX_MSG_LEN = 4000;
const MAX_QUEUE = 200;

const _queue = [];
let _flushing = false;
let _timer = null;

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _enqueue(emoji, tag, message, { error, immediate } = {}) {
  if (_queue.length >= MAX_QUEUE) {
    _queue.splice(0, _queue.length - MAX_QUEUE + MAX_BATCH);
  }

  const ts = new Date().toISOString().slice(11, 19);
  let text = `${emoji} <b>[${_esc(tag)}]</b>  <i>${ts}</i>\n<code>${_esc(message)}</code>`;
  if (error) {
    const errStr = error instanceof Error ? error.message : String(error);
    text += `\n⚠️ <pre>${_esc(errStr.slice(0, 500))}</pre>`;
  }

  _queue.push(text);

  if (immediate || _queue.length >= MAX_BATCH) {
    _flush();
  } else if (!_timer) {
    _timer = setTimeout(_flush, BATCH_INTERVAL);
  }
}

function _splitMessage(text) {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LEN);
    if (splitAt <= 0) splitAt = MAX_MSG_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

async function _flush() {
  if (!BOT_TOKEN || !CHAT_ID) return;
  if (_flushing || _queue.length === 0) return;
  _flushing = true;
  clearTimeout(_timer);
  _timer = null;

  const batch = _queue.splice(0, MAX_BATCH);
  const text = `🖥️ <b>Nexus API</b>\n\n${batch.join('\n─────────\n')}`;

  for (const chunk of _splitMessage(text)) {
    try {
      await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: chunk,
          parse_mode: 'HTML',
          disable_notification: true,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Telegram outage must never crash or slow the server
    }
  }

  _flushing = false;
  if (_queue.length > 0) _timer = setTimeout(_flush, BATCH_INTERVAL);
}

const tg = {
  d: (tag, msg) => _enqueue('🔵', tag, msg),
  i: (tag, msg) => _enqueue('🟢', tag, msg),
  w: (tag, msg, err) => _enqueue('🟡', tag, msg, { error: err }),
  e: (tag, msg, err) => _enqueue('🔴', tag, msg, { error: err, immediate: true }),
  fatal: (tag, msg, err) => _enqueue('💀', tag, msg, { error: err, immediate: true }),
};

module.exports = { tg };
