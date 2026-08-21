'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isMovieCategory,
  extractMovieSearchTitle,
  buildAudienceResearchQuery,
  formatAudienceBrief,
  researchMovieAudience,
  attachMovieAudienceResearch,
} = require('../src/movie-audience-research');

describe('isMovieCategory', () => {
  test('matches Movies only (case / whitespace tolerant)', () => {
    assert.equal(isMovieCategory('Movies'), true);
    assert.equal(isMovieCategory(' movies '), true);
    assert.equal(isMovieCategory('MOVIES'), true);
    assert.equal(isMovieCategory('General'), false);
    assert.equal(isMovieCategory('Finance'), false);
    assert.equal(isMovieCategory('AI News'), false);
    assert.equal(isMovieCategory(''), false);
    assert.equal(isMovieCategory(null), false);
  });
});

describe('extractMovieSearchTitle', () => {
  test('Only Kollywood "Film Movie Review: blurb"', () => {
    assert.equal(
      extractMovieSearchTitle('DC Movie Review: An unfiltered action thriller that hits hard'),
      'DC',
    );
    assert.equal(
      extractMovieSearchTitle('Magudam Movie Review: Vishal’s directorial debut has scale but lacks a tight screenplay'),
      'Magudam',
    );
    assert.equal(
      extractMovieSearchTitle('Vishwanath And Sons Movie Review: A refreshing Suriya in a wholesome family entertainer'),
      'Vishwanath And Sons',
    );
    assert.equal(
      extractMovieSearchTitle('GDN Movie Review: A heartfelt tribute to an extraordinary visionary'),
      'GDN',
    );
  });

  test('TOI English listing titles and critic headlines', () => {
    assert.equal(extractMovieSearchTitle('Mutiny'), 'Mutiny');
    assert.equal(
      extractMovieSearchTitle('Mutiny Movie Review: A familiar revenge ride with Jason Statham in fine form'),
      'Mutiny',
    );
    assert.equal(extractMovieSearchTitle('Spider-Man: Brand New Day'), 'Spider-Man: Brand New Day');
    assert.equal(extractMovieSearchTitle('The Invite'), 'The Invite');
  });

  test('Lensmen / Sudhir "Name Review" without Movie', () => {
    assert.equal(extractMovieSearchTitle('Chand Mera Dil Review'), 'Chand Mera Dil');
    assert.equal(
      extractMovieSearchTitle("Drishyam 3 Movie Review: Georgekutty's Greatest Adversary is..."),
      'Drishyam 3',
    );
  });

  test('strips publication suffix after a dash or pipe', () => {
    assert.equal(
      extractMovieSearchTitle('DC Movie Review: An unfiltered action thriller - Only Kollywood'),
      'DC',
    );
    assert.equal(
      extractMovieSearchTitle('Mutiny Movie Review | Times of India'),
      'Mutiny',
    );
  });

  test('empty / junk', () => {
    assert.equal(extractMovieSearchTitle(''), '');
    assert.equal(extractMovieSearchTitle(null), '');
    assert.equal(extractMovieSearchTitle('   '), '');
  });
});

describe('buildAudienceResearchQuery', () => {
  test('asks for Twitter/X, IMDb, RT, Letterboxd and forbids spoilers', () => {
    const q = buildAudienceResearchQuery('DC', { source: 'Only Kollywood', year: 2026 });
    assert.match(q, /Twitter\/X/);
    assert.match(q, /IMDb/);
    assert.match(q, /Letterboxd/);
    assert.match(q, /Rotten Tomatoes/);
    assert.match(q, /Do NOT spoil/);
    assert.match(q, /Tamil \/ Indian/);
    assert.match(q, /"DC"/);
    assert.match(q, /2026/);
  });

  test('TOI English source prefers Hollywood disambiguation', () => {
    const q = buildAudienceResearchQuery('Mutiny', { source: 'TOI English Reviews' });
    assert.match(q, /Hollywood/);
    assert.doesNotMatch(q, /Tamil/);
  });
});

describe('formatAudienceBrief', () => {
  test('returns empty when the search text is too thin', () => {
    assert.equal(formatAudienceBrief({ movieTitle: 'DC', text: 'ok' }), '');
  });

  test('labels the block as general-audience, not the critic', () => {
    const brief = formatAudienceBrief({
      movieTitle: 'DC',
      text: 'Audiences on X called the action brutal but the runtime tight. IMDb users have it around 7.4/10.',
      sources: [{ title: 'IMDb', url: 'https://www.imdb.com/title/tt123' }],
      provider: 'xGrok web_search+x_search',
    });
    assert.match(brief, /GENERAL-AUDIENCE/);
    assert.match(brief, /NOT the critic review/);
    assert.match(brief, /"DC"/);
    assert.match(brief, /7\.4\/10/);
    assert.match(brief, /imdb\.com/);
  });
});

describe('researchMovieAudience', () => {
  test('prefers xGrok (web + X) and does not call grounding on success', async () => {
    let groundedCalls = 0;
    const result = await researchMovieAudience(
      { title: 'DC Movie Review: hits hard', source: 'Only Kollywood' },
      {
        timeoutMs: 5000,
        isXGrokAvailable: () => true,
        xgrokSearch: async () => ({
          text: 'Twitter users loved Lokesh in the action blocks. Letterboxd sits near 3.5/5. IMDb users 7.2/10.',
          sources: [{ title: 'X', url: 'https://x.com/a' }],
        }),
        groundedSearch: async () => {
          groundedCalls += 1;
          return { text: 'should not run' };
        },
      },
    );
    assert.ok(result);
    assert.equal(result.provider, 'xGrok web_search+x_search');
    assert.match(result.brief, /7\.2\/10/);
    assert.equal(groundedCalls, 0);
  });

  test('falls back to Gemini grounding when xGrok throws', async () => {
    const result = await researchMovieAudience(
      { title: 'Mutiny Movie Review: Statham', source: 'TOI English Reviews' },
      {
        timeoutMs: 5000,
        isXGrokAvailable: () => true,
        xgrokSearch: async () => { throw new Error('xgrok down'); },
        groundedSearch: async () => ({
          text: 'RT audience score is 64 percent. Reddit called it formulaic but still fun for Jason Statham fans who wanted a ship-bound brawler.',
          sources: [],
        }),
      },
    );
    assert.ok(result);
    assert.equal(result.provider, 'Google Search grounding');
    assert.match(result.brief, /64 percent/);
  });

  test('returns null when both providers fail — summarizer must still run', async () => {
    const result = await researchMovieAudience(
      { title: 'DC Movie Review: x', source: 'Only Kollywood' },
      {
        timeoutMs: 200,
        isXGrokAvailable: () => true,
        xgrokSearch: async () => { throw new Error('nope'); },
        groundedSearch: async () => { throw new Error('nope'); },
      },
    );
    assert.equal(result, null);
  });

  test('skips xGrok when unavailable and uses grounding', async () => {
    let xCalls = 0;
    const result = await researchMovieAudience(
      { title: 'The Invite', source: 'TOI English Reviews' },
      {
        isXGrokAvailable: () => false,
        xgrokSearch: async () => { xCalls += 1; return { text: 'x' }; },
        groundedSearch: async () => ({
          text: 'Letterboxd users are split — some found it sharp, others cold. Average around 3.2/5.',
        }),
      },
    );
    assert.equal(xCalls, 0);
    assert.ok(result);
    assert.equal(result.movieTitle, 'The Invite');
  });
});

describe('attachMovieAudienceResearch', () => {
  test('only Movies articles are researched; Finance/AI are skipped', async () => {
    const calls = [];
    const map = await attachMovieAudienceResearch(
      [
        { id: 'm1', category: 'Movies', title: 'DC Movie Review: hard' },
        { id: 'f1', category: 'Finance', title: 'RBI holds rates' },
        { id: 'a1', category: 'AI News', title: 'OpenAI launches X' },
        { id: 'g1', category: 'General', title: 'iPhone review' },
      ],
      {
        xgrokSearch: async (q) => {
          calls.push(q);
          return { text: 'Twitter and Letterboxd users mostly loved the stunts. IMDb users have it around 7.0/10 overall with praise for the lead.' };
        },
        isXGrokAvailable: () => true,
      },
    );
    assert.equal(map.size, 1);
    assert.ok(map.has('m1'));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /"DC"/);
  });

  test('caps concurrent movie research', async () => {
    const titles = [];
    await attachMovieAudienceResearch(
      [
        { id: '1', category: 'Movies', title: 'One Movie Review: a' },
        { id: '2', category: 'Movies', title: 'Two Movie Review: b' },
        { id: '3', category: 'Movies', title: 'Three Movie Review: c' },
      ],
      {
        max: 2,
        xgrokSearch: async (q) => {
          titles.push(q);
          return { text: 'Viewers on X said it was fine. Letterboxd 3.0/5 from early logs.' };
        },
        isXGrokAvailable: () => true,
      },
    );
    assert.equal(titles.length, 2);
  });
});
