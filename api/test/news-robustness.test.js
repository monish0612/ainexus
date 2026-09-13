'use strict';

// Deep regression coverage for the Medium/TDS gist-dump failure and the
// RSS-vs-live prefer rules. Hermetic: no network, no DB.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCleanArticle,
  htmlToRichMarkdown,
  visibleTextLen,
  proseVisibleLen,
  dropOversizedCodeFences,
  isMostlyFencedCode,
  preferStructuredBody,
  selectorsForUrl,
} = require('../src/news-extract');

const {
  buildFullContentExcerpt,
  buildFullContentMarkdown,
  shouldPreferExtractedOverRss,
  needsCodeDumpBodyRepair,
} = require('../src/news-service');

function giantPython(lines = 450) {
  return Array.from({ length: lines }, (_, i) => `BANKING77_EXAMPLE_${i} = "refund ${i}"`).join('\n');
}

function essay(times = 8) {
  return (
    'Picture a support inbox for a bank. Every message that comes in needs to be sorted into a category, a lost card, a refund request, a wrong charge, and sent to the right team. '
      .repeat(times)
      .trim()
  );
}

describe('fence size / code-share guards', () => {
  test('keeps an 80-line tutorial sample and drops an 8k+ dump', () => {
    const sample = '```python\n' + 'x = 1\n'.repeat(80) + '```';
    const dump = '```python\n' + 'x = 1\n'.repeat(4000) + '```';
    assert.ok(dropOversizedCodeFences(sample).includes('x = 1'));
    assert.equal(dropOversizedCodeFences(dump), '');
    assert.equal(isMostlyFencedCode(dump), true);
    assert.equal(isMostlyFencedCode(`${essay()}\n\n${sample}`), false);
  });

  test('empty / tiny / null never crash and are not "mostly code"', () => {
    assert.equal(isMostlyFencedCode(''), false);
    assert.equal(isMostlyFencedCode(null), false);
    assert.equal(isMostlyFencedCode('short'), false);
    assert.equal(dropOversizedCodeFences(''), '');
    assert.equal(dropOversizedCodeFences(null), '');
    assert.equal(proseVisibleLen(''), 0);
  });

  test('mixed 8k prose + 28k gist is treated as a code dump until the fence is dropped', () => {
    const mixed = `${essay(20)}\n\n\`\`\`python\n${giantPython(500)}\n\`\`\``;
    assert.equal(isMostlyFencedCode(mixed), true);
    const cleaned = dropOversizedCodeFences(mixed);
    assert.ok(cleaned.includes('Picture a support inbox'));
    assert.equal(cleaned.includes('BANKING77_EXAMPLE_200'), false);
    assert.equal(isMostlyFencedCode(cleaned), false);
  });
});

describe('needsCodeDumpBodyRepair', () => {
  test('flags a gist-only stored body', () => {
    const dump = '```python\n' + giantPython(400) + '\n```\n\n> Read Original Article';
    assert.equal(needsCodeDumpBodyRepair(dump), true);
  });

  test('does not flag a short legitimate Finshots-style piece', () => {
    const finshots = 'India’s latest inflation print cooled more than expected, and the bond market noticed. Traders now price a slower hike path than last week.';
    assert.ok(finshots.length > 80 && finshots.length < 400);
    assert.equal(needsCodeDumpBodyRepair(finshots), false);
  });

  test('does not flag a code-heavy tutorial that still has thousands of prose chars', () => {
    const tutorial = `${essay(20)}\n\n${'```python\nx = 1\ny = 2\nprint(x + y)\n```\n\n'.repeat(40)}`;
    assert.ok(proseVisibleLen(tutorial) > 2000);
    assert.equal(needsCodeDumpBodyRepair(tutorial), false);
  });

  test('does not flag a healthy long-form essay with a small sample', () => {
    const md = `${essay(12)}\n\n\`\`\`python\ndef add(a, b):\n    return a + b\n\`\`\`\n\nClosing paragraph that is still real prose about the experiment.`;
    assert.equal(needsCodeDumpBodyRepair(md), false);
  });

  test('flags a leftover after an oversized fence is stripped', () => {
    const md = `${essay(12)}\n\n\`\`\`python\n${giantPython(500)}\n\`\`\``;
    assert.equal(needsCodeDumpBodyRepair(md), true);
  });

  test('empty stored markdown is not a repair candidate', () => {
    assert.equal(needsCodeDumpBodyRepair(''), false);
    assert.equal(needsCodeDumpBodyRepair(null), false);
  });

  test('repair scan targets fence dumps, not the newest healthy essays', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/news-service.js'),
      'utf8',
    );
    assert.match(src, /summary_markdown LIKE \$2/);
    assert.match(src, /BANKING77/);
    assert.match(src, /position\(\$3 in summary_markdown\)/);
  });
});

describe('shouldPreferExtractedOverRss', () => {
  test('live essay beats a longer gist RSS body', () => {
    const gist = '```python\n' + giantPython(400) + '\n```';
    assert.equal(shouldPreferExtractedOverRss(essay(10), gist), true);
  });

  test('does not replace a full RSS newsletter with a thin extract', () => {
    const rss = essay(20);
    const thin = essay(4);
    assert.equal(shouldPreferExtractedOverRss(thin, rss), false);
  });

  test('does not replace good RSS with a gist extract', () => {
    const gist = '```python\n' + giantPython(400) + '\n```';
    assert.equal(shouldPreferExtractedOverRss(gist, essay(10)), false);
  });

  test('empty extract never wins', () => {
    assert.equal(shouldPreferExtractedOverRss('', essay(8)), false);
    assert.equal(shouldPreferExtractedOverRss('   ', essay(8)), false);
    assert.equal(shouldPreferExtractedOverRss('', ''), false);
  });

  test('after dropping a gist, a shorter live essay still wins', () => {
    const rss = `Teaser only.\n\n\`\`\`python\n${giantPython(400)}\n\`\`\``;
    assert.equal(shouldPreferExtractedOverRss(essay(10), rss), true);
  });
});

describe('RSS htmlToRichMarkdown vs live extract', () => {
  test('gist-only RSS fragment collapses to empty after the dump is dropped', () => {
    const html = `<pre class="language-python">${giantPython(400)}</pre>`;
    const md = htmlToRichMarkdown(html, { baseUrl: 'https://towardsdatascience.com/p/x' });
    assert.equal(md.includes('BANKING77_EXAMPLE_200'), false);
    assert.ok(visibleTextLen(md) < 200, `expected dump gone, got ${visibleTextLen(md)} chars`);
  });

  test('RSS teaser + gist keeps the teaser, not the dump', () => {
    const html = `<p>${essay(3)}</p><pre>${giantPython(400)}</pre>`;
    const md = htmlToRichMarkdown(html, { baseUrl: 'https://towardsdatascience.com/p/x' });
    assert.ok(md.includes('Picture a support inbox'));
    assert.equal(md.includes('BANKING77_EXAMPLE_200'), false);
  });

  test('live TDS-shaped HTML keeps the essay even when a gist sits beside it', () => {
    const gist = giantPython(400);
    const html = `
      <html><head><meta property="og:title" content="One Capital Letter" /></head>
      <body>
        <article>
          <section data-testid="storyContent">
            <p>${essay(3)}</p>
            <p>That is the problem this article is about: a model can sound correct to a person and still be wrong for the software that uses its answer.</p>
            <pre class="language-python">${gist}</pre>
          </section>
        </article>
        <div class="gist"><pre>${gist}</pre></div>
      </body></html>`;
    const r = extractCleanArticle(html, 'https://towardsdatascience.com/one-capital-letter/');
    assert.ok(r.content.includes('Picture a support inbox'));
    assert.equal(r.content.includes('BANKING77_EXAMPLE_200'), false);
    const excerpt = buildFullContentExcerpt(r.content);
    assert.ok(excerpt.includes('Picture a support inbox'));
    assert.equal(excerpt.includes('BANKING77'), false);
    const md = buildFullContentMarkdown({
      content: r.content,
      url: 'https://towardsdatascience.com/one-capital-letter/',
      source: 'Towards Data Science',
    });
    assert.ok(md.includes('Picture a support inbox'));
    assert.equal(md.includes('BANKING77_EXAMPLE_200'), false);
  });

  test('JSON-LD prose wins over a gist-only HTML body', () => {
    const dump = '```python\n' + giantPython(400) + '\n```';
    const json = essay(10);
    const picked = preferStructuredBody(json, dump);
    assert.ok(picked.includes('Picture a support inbox'));
    assert.equal(picked.includes('BANKING77'), false);
  });
});

describe('excerpt never leads with a fence or CTA', () => {
  test('skips fence, heading, and Read Original CTA', () => {
    const content = [
      '```python',
      'import argparse',
      'PATTERN = r"(?i)^refund"',
      '```',
      '',
      '## What this project builds',
      '',
      '> 📊 Read Original Article on Towards Data Science',
      '',
      'Authors: Amir Hossein Karami and Hamed Tahmooresi',
      '',
      essay(2),
      '',
      'A second paragraph of the essay so the splitter keeps explicit breaks.',
      '',
      'A third paragraph so we stay on the explicit-paragraph path.',
    ].join('\n');
    const out = buildFullContentExcerpt(content);
    assert.ok(out.includes('Picture a support inbox'), out);
    assert.equal(out.includes('import argparse'), false);
    assert.equal(/read original article/i.test(out), false);
    assert.equal(/^authors?:/i.test(out), false);
  });
});

describe('site selectors stay wired', () => {
  test('Medium custom domains share the storyContent stack', () => {
    const tds = selectorsForUrl('https://towardsdatascience.com/x');
    const medium = selectorsForUrl('https://medium.com/@x/y');
    assert.ok(tds.includes('[data-testid="storyContent"]'));
    assert.ok(tds.includes('article'));
    assert.deepEqual(tds, medium);
    assert.ok(selectorsForUrl('https://www.marktechpost.com/x').includes('div.entry-content'));
  });
});
