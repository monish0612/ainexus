'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  MOVIE AUDIENCE RESEARCH
//
//  Used by on-demand "AI Summarize" for Movies articles. The critic review
//  is already in the article body; this module fetches LIVE general-audience
//  reception (Twitter/X + the public web: IMDb, RT, Letterboxd, Reddit).
//
//  Search functions are injected so unit tests never hit the network.
//  Failures are silent — the summarizer still runs on the critic copy.
// ═══════════════════════════════════════════════════════════════════════

function isMovieCategory(category) {
  return String(category || '').trim().toLowerCase() === 'movies';
}

/**
 * Pulls the film name out of critic-site headlines.
 *
 *   "DC Movie Review: An unfiltered action thriller…" → "DC"
 *   "Mutiny Movie Review: A familiar revenge ride…"   → "Mutiny"
 *   "Chand Mera Dil Review"                           → "Chand Mera Dil"
 *   "The Invite"                                      → "The Invite"
 */
function extractMovieSearchTitle(articleTitle) {
  let t = String(articleTitle || '').trim();
  if (!t) return '';

  t = t.replace(
    /\s*[|\u2013\u2014\-]\s*(Only Kollywood|Times of India|TOI(?: English)? Reviews?|Lensmen Reviews?|Sudhir Srinivasan.*)$/i,
    '',
  ).trim();

  const movieReviewColon = t.match(/^(.*?)\s+Movie Review\s*[:\u2013\u2014\-]\s+/i);
  if (movieReviewColon && movieReviewColon[1].trim().length >= 1) {
    return movieReviewColon[1].trim();
  }

  const reviewColon = t.match(/^(.*?)\s+Review\s*[:\u2013\u2014\-]\s+/i);
  if (reviewColon && reviewColon[1].trim().length >= 2) {
    return reviewColon[1].trim();
  }

  t = t
    .replace(/\s+Movie Reviews?\s*$/i, '')
    .replace(/\s+Reviews?\s*$/i, '')
    .trim();

  return t || String(articleTitle || '').trim();
}

function buildAudienceResearchQuery(movieTitle, { source = '', year } = {}) {
  const y = Number(year) || new Date().getUTCFullYear();
  const src = String(source || '');
  let region = '';
  if (/kollywood|tamil|sudhir|lensmen/i.test(src)) {
    region = 'This is a Tamil / Indian cinema title — prefer that film over any Hollywood title with the same name. ';
  } else if (/times of india|toi english|hollywood/i.test(src)) {
    region = 'This is an English / Hollywood film. ';
  }

  return (
    `${region}How did GENERAL AUDIENCES (not professional critics) receive the movie "${movieTitle}" ` +
    `(release around ${y})? Search Twitter/X, Reddit, Letterboxd, IMDb user ratings, Rotten Tomatoes ` +
    `audience score, and recent public discussion. Report:\n` +
    `1. Overall audience sentiment (positive / mixed / negative) with short paraphrases of what real viewers said.\n` +
    `2. Published aggregate ratings WITH the scale (e.g. IMDb 6.4/10, RT audience 72%, Letterboxd 3.1/5). ` +
    `Omit any score you cannot verify.\n` +
    `3. What audiences praised vs complained about (acting, story, pacing, length, visuals).\n` +
    `4. Whether everyday viewers say it is worth watching in theatres or at home.\n` +
    `Do NOT spoil the ending or major twists. If several films share this name, pick the currently releasing / most recent match.`
  );
}

function formatAudienceBrief({ movieTitle, text, sources = [], provider = 'search' }) {
  const body = String(text || '').trim().slice(0, 3500);
  if (body.length < 40) return '';
  const srcLines = (Array.isArray(sources) ? sources : [])
    .slice(0, 8)
    .map((s) => {
      const title = (s && (s.title || '')).toString().trim();
      const url = (s && (s.url || '')).toString().trim();
      if (!title && !url) return '';
      return `- ${title || url}${url && title ? ` (${url})` : url && !title ? '' : ''}`;
    })
    .filter(Boolean)
    .join('\n');

  return [
    `ONLINE AUDIENCE RESEARCH for "${movieTitle}" (live web + Twitter/X via ${provider}).`,
    'This is GENERAL-AUDIENCE reception, NOT the critic review in the article body.',
    '',
    body,
    srcLines ? `\nSources:\n${srcLines}` : '',
  ].filter(Boolean).join('\n');
}

function _resultText(result) {
  if (!result || typeof result !== 'object') return '';
  return String(result.text || result.content || '').trim();
}

function _withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @returns {Promise<{ movieTitle: string, brief: string, provider: string } | null>}
 */
async function researchMovieAudience(article, deps = {}) {
  const movieTitle = extractMovieSearchTitle(article && article.title);
  if (!movieTitle) return null;

  const timeoutMs = Math.max(4000, Number(deps.timeoutMs) || 45000);
  const query = buildAudienceResearchQuery(movieTitle, {
    source: article.source,
    year: article.year,
  });
  const minChars = Number(deps.minChars) || 60;

  const trySearch = async (fn, provider, ms) => {
    if (typeof fn !== 'function') return null;
    const result = await _withTimeout(fn(query, { timeoutMs: ms, maxTokens: 1800, temperature: 0.2 }), ms, provider);
    const text = _resultText(result);
    if (text.length < minChars) return null;
    const brief = formatAudienceBrief({
      movieTitle,
      text,
      sources: result.sources,
      provider,
    });
    if (!brief) return null;
    return { movieTitle, brief, provider };
  };

  const xgrokOk = typeof deps.isXGrokAvailable === 'function'
    ? !!deps.isXGrokAvailable()
    : true;

  if (xgrokOk && typeof deps.xgrokSearch === 'function') {
    try {
      const hit = await trySearch(deps.xgrokSearch, 'xGrok web_search+x_search', timeoutMs);
      if (hit) return hit;
    } catch {
      // fall through to Gemini grounding
    }
  }

  if (typeof deps.groundedSearch === 'function') {
    try {
      const gTimeout = Math.min(timeoutMs, 18000);
      const hit = await trySearch(deps.groundedSearch, 'Google Search grounding', gTimeout);
      if (hit) return hit;
    } catch {
      // give up — summarizer still has the critic review
    }
  }

  return null;
}

/**
 * Research at most [max] Movies articles in parallel. Returns Map<id, result>.
 */
async function attachMovieAudienceResearch(articles, deps = {}) {
  const max = Math.max(1, Number(deps.max) || 2);
  const movies = (articles || []).filter((a) => isMovieCategory(a.category)).slice(0, max);
  const out = new Map();
  await Promise.all(movies.map(async (a) => {
    if (!a || !a.id) return;
    try {
      const result = await researchMovieAudience(a, deps);
      if (result && result.brief) out.set(a.id, result);
    } catch {
      // skip
    }
  }));
  return out;
}

module.exports = {
  isMovieCategory,
  extractMovieSearchTitle,
  buildAudienceResearchQuery,
  formatAudienceBrief,
  researchMovieAudience,
  attachMovieAudienceResearch,
};
