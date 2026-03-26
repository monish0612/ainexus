import { Router } from 'express';
import fetch from 'node-fetch';
import { callLiteLLM } from '../litellm.js';

export const aiRouter = Router();

/** From docs/figma_source/aiCategorize.ts */
const KEYWORD_RULES = {
  Food: [
    'restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'breakfast', 'pizza',
    'burger', 'swiggy', 'zomato', 'food', 'eat', 'meal', 'snack', 'biryani',
    'curry', 'hotel', 'dosa', 'idli', 'paratha', 'chicken', 'mutton', 'fish',
    'dhaba', 'chai', 'tea', 'barbeque', 'bbq', 'sushi', 'pasta', 'sandwich',
    'bread', 'bakery', 'cake', 'dessert', 'ice cream', 'maggi', 'noodles',
    'cloud kitchen', 'tiffin', 'mess',
  ],
  Grocery: [
    'grocery', 'vegetables', 'veggies', 'fruits', 'market', 'supermarket',
    'bigbasket', 'dmart', 'reliance', 'fresh', 'milk', 'eggs', 'flour',
    'oil', 'masala', 'spices', 'dal', 'provisions', 'store', 'kirana',
    'zepto', 'blinkit', 'instamart', 'nature basket', 'grofers',
  ],
  Transport: [
    'uber', 'ola', 'cab', 'taxi', 'fuel', 'petrol', 'diesel', 'bus', 'metro',
    'train', 'auto', 'travel', 'flight', 'ticket', 'rapido', 'namma', 'bmtc',
    'irctc', 'parking', 'toll', 'ferry', 'rickshaw', 'indigo', 'spicejet',
    'airindia', 'vistara', 'go air', 'interstate', 'bpcl', 'iocl', 'hpcl',
  ],
  Entertainment: [
    'movie', 'netflix', 'spotify', 'amazon prime', 'game', 'concert', 'show',
    'cinema', 'theatre', 'hotstar', 'youtube premium', 'prime video', 'disney',
    'zee5', 'sonyliv', 'arcade', 'bowling', 'stream', 'subscription', 'gaming',
    'steam', 'playstation', 'xbox', 'apple music', 'gaana', 'jio cinema',
    'bookmyshow', 'pvr', 'inox',
  ],
  Shopping: [
    'amazon', 'flipkart', 'clothes', 'shoes', 'mall', 'myntra', 'meesho',
    'nykaa', 'shirt', 'dress', 'pant', 'jeans', 'watch', 'bag', 'apparel',
    'fashion', 'accessories', 'electronics', 'gadget', 'phone', 'laptop',
    'headphone', 'earphone', 'ajio', 'limeroad', 'purplle',
  ],
  Bills: [
    'electricity', 'water', 'gas', 'internet', 'broadband', 'recharge',
    'bill', 'rent', 'emi', 'insurance', 'bsnl', 'airtel', 'jio', 'vi',
    'wifi', 'mobile', 'prepaid', 'postpaid', 'utility', 'maintenance',
    'society', 'cable', 'tata sky', 'dish tv', 'loan', 'premium', 'bescom',
    'mseb', 'tneb', 'adani electricity',
  ],
  Health: [
    'medicine', 'doctor', 'hospital', 'pharmacy', 'gym', 'health', 'medical',
    'clinic', 'apollo', 'medplus', 'fitpass', 'cult', 'physio', 'dental',
    'optical', 'tablet', 'capsule', 'diagnostic', 'lab', 'test',
    'consultation', 'yoga', 'fitness', 'protein', 'supplement',
  ],
};

const VALID_CATEGORIES = [
  'Food', 'Grocery', 'Transport', 'Entertainment',
  'Shopping', 'Bills', 'Health', 'Others',
];

function tokenise(text) {
  return text
    .toLowerCase()
    .split(/[\s,\-_/().]+/)
    .filter((w) => w.length > 2);
}

function categorizeWithRules(description, learnings) {
  const tokens = tokenise(description);
  const fullText = description.toLowerCase();

  const learnedVotes = {};
  const matchedLearningTokens = [];
  for (const token of tokens) {
    if (learnings && learnings[token]) {
      learnedVotes[learnings[token]] = (learnedVotes[learnings[token]] || 0) + 1;
      matchedLearningTokens.push(token);
    }
  }
  if (Object.keys(learnedVotes).length > 0) {
    const top = Object.entries(learnedVotes).sort((a, b) => b[1] - a[1])[0];
    return {
      category: top[0],
      confidence: 'learned',
      reasoning: `AI remembered your correction — keyword "${matchedLearningTokens[0]}" → ${top[0]}`,
      score: 0.97,
      source: 'rules',
    };
  }

  for (const [category, keywords] of Object.entries(KEYWORD_RULES)) {
    for (const keyword of keywords) {
      if (fullText.includes(keyword)) {
        return {
          category,
          confidence: 'matched',
          reasoning: `Detected merchant/keyword "${keyword}" → ${category}`,
          score: 0.82,
          source: 'rules',
        };
      }
    }
  }

  return {
    category: 'Others',
    confidence: 'default',
    reasoning: 'No clear category signal — defaulting to Others',
    score: 0.3,
    source: 'rules',
  };
}

function extractJsonObject(text) {
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

aiRouter.post('/categorize', async (req, res) => {
  try {
    const { description, learnings } = req.body || {};
    if (!description || String(description).trim().length < 2) {
      return res.status(400).json({
        category: 'Others',
        reasoning: 'Description too short to classify',
        score: 0,
        confidence: 'default',
        source: 'rules',
      });
    }

    const desc = String(description).trim();
    const learn = learnings && typeof learnings === 'object' ? learnings : {};
    const local = categorizeWithRules(desc, learn);

    const needsLlm =
      local.category === 'Others' &&
      local.confidence === 'default' &&
      local.score <= 0.35;

    if (!needsLlm) {
      return res.json(local);
    }

    const system =
      'You are an expense categorizer. Given a description, return the category from: Food, Grocery, Transport, Entertainment, Shopping, Bills, Health, Others. Return JSON only: {"category","reasoning","score"} where score is 0-1.';

    const raw = await callLiteLLM(null, [
      { role: 'system', content: system },
      { role: 'user', content: desc },
    ], { temperature: 0.2 });

    const parsed = extractJsonObject(raw);
    if (!parsed || !parsed.category) {
      return res.json(local);
    }

    let cat = String(parsed.category);
    if (!VALID_CATEGORIES.includes(cat)) cat = 'Others';

    return res.json({
      category: cat,
      reasoning: String(parsed.reasoning || 'LiteLLM classification'),
      score: Math.min(1, Math.max(0, Number(parsed.score) || 0.75)),
      confidence: 'matched',
      source: 'llm',
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

aiRouter.post('/rephrase', async (req, res) => {
  try {
    const { text, platform } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    const plat = platform || 'General';
    const system = `Rephrase the following text for ${plat}. Keep the core meaning. Return the rephrased text only, no quotes or preamble.`;
    const out = await callLiteLLM(null, [
      { role: 'system', content: system },
      { role: 'user', content: String(text) },
    ], { temperature: 0.6 });
    res.json({ platform: plat, rephrased: out.trim() });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

aiRouter.post('/correct', async (req, res) => {
  try {
    const { text, platform, tone } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    const plat = platform || 'General';
    const ton = tone || 'neutral';
    const system =
      `Correct the English in the following text for ${plat} using ${ton} tone. ` +
      'Return JSON only: {"corrected": string, "corrections": array of { "from": string, "to": string, "reason": string } }.';

    const raw = await callLiteLLM(null, [
      { role: 'system', content: system },
      { role: 'user', content: String(text) },
    ], { temperature: 0.4 });

    const parsed = extractJsonObject(raw);
    if (parsed && parsed.corrected != null) {
      return res.json({
        platform: plat,
        tone: ton,
        corrected: String(parsed.corrected),
        corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      });
    }

    res.json({
      platform: plat,
      tone: ton,
      corrected: raw.trim(),
      corrections: [],
      raw,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

aiRouter.post('/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query || String(query).trim().length < 2) {
      return res.status(400).json({ error: 'query is required (min 2 chars)' });
    }

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'TAVILY_API_KEY not configured' });
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: String(query).trim(),
        search_depth: 'advanced',
        include_answer: true,
        include_raw_content: false,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: `Tavily API error: ${errText.slice(0, 300)}`,
      });
    }

    const data = await response.json();
    res.json({
      answer: data.answer || '',
      query: data.query || query,
      results: (data.results || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        content: r.content || '',
        score: r.score || 0,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

aiRouter.post('/define', async (req, res) => {
  try {
    const { word } = req.body || {};
    if (!word || String(word).trim().length < 1) {
      return res.status(400).json({ error: 'word is required' });
    }
    const w = String(word).trim();
    const system =
      `Define the word '${w}'. Return JSON only with: word, pronunciation, partOfSpeech, definitions (array of strings), examples (array of strings), contexts (array of strings).`;

    const raw = await callLiteLLM(null, [
      { role: 'system', content: system },
      { role: 'user', content: w },
    ], { temperature: 0.35 });

    const parsed = extractJsonObject(raw);
    if (parsed) {
      return res.json(parsed);
    }
    res.status(502).json({ error: 'Could not parse dictionary JSON from model', raw });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});
