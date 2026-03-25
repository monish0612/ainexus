import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'nexus.db');

/** @type {import('better-sqlite3').Database | null} */
let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized — call initDatabase() first');
  }
  return dbInstance;
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition};`);
  }
}

function ensureNewsSchema(database) {
  ensureColumn(database, 'news_articles', 'guid', 'guid TEXT');
  ensureColumn(database, 'news_articles', 'original_url', 'original_url TEXT');
  ensureColumn(database, 'news_articles', 'summary_markdown', 'summary_markdown TEXT');
  ensureColumn(database, 'news_articles', 'published_at', 'published_at TEXT');

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_news_guid ON news_articles(guid);
    CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at);
  `);
}

function cleanupLegacyNewsSeeds(database) {
  database
    .prepare(
      `
        DELETE FROM news_articles
        WHERE id LIKE 'art-%'
          AND guid IS NULL
          AND original_url IS NULL
      `,
    )
    .run();
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      bank TEXT NOT NULL,
      card_type TEXT NOT NULL,
      date TEXT NOT NULL,
      is_manual_category INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budget (
      id TEXT PRIMARY KEY DEFAULT 'current',
      amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budget_history (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      set_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      tag TEXT,
      read_time INTEGER NOT NULL,
      time_ago TEXT NOT NULL,
      date TEXT NOT NULL,
      image TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      source TEXT NOT NULL,
      is_featured INTEGER NOT NULL DEFAULT 0,
      content_json TEXT NOT NULL,
      saved INTEGER NOT NULL DEFAULT 0,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      ext TEXT NOT NULL,
      date_label TEXT NOT NULL,
      starred INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      tags_json TEXT,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_sync_history (
      id TEXT PRIMARY KEY,
      file_id TEXT,
      mode TEXT NOT NULL,
      message TEXT,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
      pronunciation TEXT,
      definition TEXT NOT NULL,
      example TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT,
      client_id TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS category_learnings (
      keyword TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
    CREATE INDEX IF NOT EXISTS idx_expenses_bank ON expenses(bank);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE INDEX IF NOT EXISTS idx_news_updated ON news_articles(updated_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_updated ON cloud_files(updated_at);
  `);

  ensureNewsSchema(database);
}

function nowIso() {
  return new Date().toISOString();
}

/** Mirrors docs/figma_source/NewsData.ts ARTICLES */
const SEED_ARTICLES = [
  {
    id: 'art-001',
    title: 'Quantum leap: New AI model decodes complex proteins in seconds',
    category: 'Tech',
    tag: 'Breaking',
    readTime: 4,
    timeAgo: '12 min ago',
    date: 'Mar 20, 2026',
    image: 'https://images.unsplash.com/photo-1717501219345-06ea2bf3eb80?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'Researchers unveil a model that resolves protein structures 1,000x faster than existing tools, potentially revolutionizing drug discovery timelines.',
    source: 'Tech Pulse',
    isFeatured: true,
    content: [
      {
        type: 'paragraph',
        text: "A team at Stanford's Computational Biology Lab has released ProteoAI-2, a transformer-based model capable of decoding the three-dimensional structure of previously uncharacterized proteins in under two seconds — a task that once consumed weeks of supercomputer time.",
      },
      {
        type: 'paragraph',
        text: 'The breakthrough hinges on a novel attention mechanism the team calls "geometric folding attention," which encodes physical constraints directly into the model architecture rather than treating protein folding as a pure sequence prediction problem.',
      },
      { type: 'heading', text: 'A New Paradigm in Drug Discovery' },
      {
        type: 'paragraph',
        text: 'Pharmaceutical companies have already begun licensing the model. Analysts at Goldman Sachs estimate that reducing early-stage target identification from 3 years to under 6 months could shave $800 million off the average drug development cost.',
      },
      {
        type: 'quote',
        text: "We're not just accelerating drug discovery — we're fundamentally changing what questions we can ask about life itself.",
        author: 'Dr. Sarah Chen',
        role: 'Lead Researcher, Stanford',
      },
      { type: 'heading', text: 'The Road Ahead' },
      {
        type: 'paragraph',
        text: "ProteoAI-2 is available under a research license on the project's GitHub repository. The team plans to release an enterprise API in Q2 2026 with support for custom fine-tuning on proprietary datasets.",
      },
      {
        type: 'stat',
        items: [
          { value: '99.9%', label: 'Structure accuracy' },
          { value: '<2s', label: 'Per protein' },
          { value: '18K+', label: 'Proteins solved' },
        ],
      },
    ],
  },
  {
    id: 'art-002',
    title: 'Market rally continues as central banks signal potential rate cuts',
    category: 'Finance',
    readTime: 3,
    timeAgo: '28 min ago',
    date: 'Mar 20, 2026',
    image: 'https://images.unsplash.com/photo-1767424196045-030bbde122a4?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'Global equities hit a 14-month high after Fed Chair signals a June rate cut is "on the table," sending the S&P 500 up 2.4% in a single session.',
    source: 'Global Markets',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'Stock markets surged worldwide on Thursday after Federal Reserve Chair Jerome Powell hinted in Congressional testimony that a rate reduction in June remains a live possibility, provided inflation data continues its downward trajectory.',
      },
      {
        type: 'paragraph',
        text: 'The S&P 500 added 2.4%, the Nasdaq Composite rose 3.1%, and European indices posted their best single-day gains since November 2024. Bond yields fell sharply, with the 10-year Treasury dropping 18 basis points to 3.94%.',
      },
      {
        type: 'quote',
        text: 'The market is finally pricing in a Goldilocks scenario — moderate growth, cooling inflation, and accommodative central banks.',
        author: 'Marcus Webb',
        role: 'Chief Strategist, Barclays',
      },
      { type: 'heading', text: 'Sector Rotation in Focus' },
      {
        type: 'paragraph',
        text: 'Technology and real estate led the charge, while defensive sectors like utilities lagged. Emerging market ETFs recorded their highest single-day inflows of 2026, suggesting renewed appetite for risk assets.',
      },
      {
        type: 'stat',
        items: [
          { value: '+2.4%', label: 'S&P 500' },
          { value: '+3.1%', label: 'Nasdaq' },
          { value: '3.94%', label: '10Y Yield' },
        ],
      },
    ],
  },
  {
    id: 'art-003',
    title: 'Advanced encryption: How AI is defending against quantum attacks',
    category: 'Tech',
    tag: 'Exclusive',
    readTime: 5,
    timeAgo: '2 hr ago',
    date: 'Mar 20, 2026',
    image: 'https://images.unsplash.com/photo-1761496847215-46592435aab0?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'NIST finalizes post-quantum cryptography standards, and a new wave of AI-powered key-management systems is already deploying them at enterprise scale.',
    source: 'Tech Pulse',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'The U.S. National Institute of Standards and Technology officially finalized its first set of post-quantum cryptographic (PQC) standards this week, marking the end of a decade-long standardization effort and triggering an urgent migration cycle for government and financial systems.',
      },
      { type: 'heading', text: 'Why Classical Encryption Is Vulnerable' },
      {
        type: 'paragraph',
        text: "Today's RSA and ECC encryption rely on mathematical problems — factoring large numbers or computing discrete logarithms — that would take classical computers millions of years to break. Quantum computers running Shor's algorithm could solve these problems in hours once hardware matures sufficiently.",
      },
      {
        type: 'quote',
        text: 'The threat isn\'t theoretical anymore. Adversaries are harvesting encrypted data today to decrypt it once quantum hardware is viable — a strategy called "harvest now, decrypt later."',
        author: 'Ravi Shankar',
        role: 'CISO, Axis Bank',
      },
      {
        type: 'paragraph',
        text: 'CrowdStrike and Palo Alto Networks have both announced PQC-native endpoint products. Analysts expect the market for quantum-safe security software to reach $12 billion by 2028.',
      },
      {
        type: 'stat',
        items: [
          { value: '4', label: 'NIST standards finalized' },
          { value: '$12B', label: 'Market by 2028' },
          { value: '2031', label: 'Estimated Q-day' },
        ],
      },
    ],
  },
  {
    id: 'art-004',
    title: "DeepMind's Gemini Ultra 2 achieves human-level reasoning on 43 benchmarks",
    category: 'AI Labs',
    tag: 'Trending',
    readTime: 4,
    timeAgo: '3 hr ago',
    date: 'Mar 20, 2026',
    image: 'https://images.unsplash.com/photo-1760629863094-5b1e8d1aae74?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      "Google DeepMind's newest frontier model scores above 90th-percentile human performance across mathematics, coding, scientific reasoning, and legal analysis.",
    source: 'AI Insider',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'Google DeepMind released Gemini Ultra 2 to enterprise customers on Thursday, posting benchmark results that outpace GPT-5 on 38 of 50 standard evaluations. The model achieves scores in the 90th percentile of human performance on graduate-level mathematics, competitive programming, and bar exam simulations.',
      },
      { type: 'heading', text: 'Benchmarks Shattered' },
      {
        type: 'paragraph',
        text: 'On GPQA Diamond — a set of graduate-level science questions so difficult that even domain experts average only 65% — Gemini Ultra 2 scored 87.4%. Its coding performance on SWE-Bench, which tests real software engineering tasks, reached 62.3%, nearly double the previous state of the art.',
      },
      {
        type: 'quote',
        text: "This is the first time we've seen a model genuinely surprise our internal experts — not just on narrow tasks, but on open-ended reasoning chains they hadn't anticipated.",
        author: 'Demis Hassabis',
        role: 'CEO, Google DeepMind',
      },
      {
        type: 'paragraph',
        text: 'The model is available via the Vertex AI API starting today. Pricing is $0.0015 per 1K input tokens, roughly 40% cheaper than its predecessor.',
      },
      {
        type: 'stat',
        items: [
          { value: '87.4%', label: 'GPQA Diamond' },
          { value: '62.3%', label: 'SWE-Bench' },
          { value: '43/50', label: 'SOTA benchmarks' },
        ],
      },
    ],
  },
  {
    id: 'art-005',
    title: 'How cities are turning concrete into carbon sinks by 2030',
    category: 'Global',
    readTime: 6,
    timeAgo: '5 hr ago',
    date: 'Mar 19, 2026',
    image: 'https://images.unsplash.com/photo-1761662826910-3a2480223933?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'A new generation of bio-concrete, living walls, and AI-managed green corridors is transforming urban infrastructure from carbon sources into net-negative emitters.',
    source: 'Green World',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'Singapore\'s Tengah "Forest Town," Paris\'s ring-road retrofit, and Copenhagen\'s harbor biomes represent a seismic shift in urban design philosophy: cities are no longer simply managing their carbon footprint — they\'re engineering it negative.',
      },
      { type: 'heading', text: 'The Science of Bio-Concrete' },
      {
        type: 'paragraph',
        text: "Pioneered at Delft University, bio-concrete embeds bacteria that synthesize limestone when exposed to water, self-sealing cracks and capturing atmospheric CO₂ in the process. Singapore's HDB has begun mandating it for all new public housing above six stories.",
      },
      {
        type: 'quote',
        text: "Every square meter of bio-concrete absorbs roughly 2.8 kg of CO₂ per year over a 50-year lifespan. At city scale, that's not incremental — it's transformative.",
        author: 'Dr. Priya Nair',
        role: 'Urban Climate Lead, C40 Cities',
      },
      { type: 'heading', text: 'AI-Managed Green Corridors' },
      {
        type: 'paragraph',
        text: 'Barcelona\'s AI-driven "Superilla" project uses real-time sensor data to irrigate rooftop farms and living facades only when soil moisture, temperature, and wind conditions maximize carbon uptake. The system has reduced water use by 34% while increasing biomass by 18%.',
      },
      {
        type: 'stat',
        items: [
          { value: '2.8kg', label: 'CO₂/m²/year' },
          { value: '34%', label: 'Water saved' },
          { value: '67', label: 'Cities enrolled' },
        ],
      },
    ],
  },
  {
    id: 'art-006',
    title: 'SpaceX Starship successfully completes first fully-reusable orbital flight',
    category: 'Tech',
    readTime: 3,
    timeAgo: '7 hr ago',
    date: 'Mar 19, 2026',
    image: 'https://images.unsplash.com/photo-1597331139945-615efe8f4b04?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'Both the Super Heavy booster and Ship upper stage returned to their launch towers, completing the first fully reusable orbital round-trip in spaceflight history.',
    source: 'Space Watch',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'SpaceX achieved a historic milestone on Wednesday when Starship IFT-9 completed a full orbital mission and returned both stages intact to their launch towers at Starbase, Texas — the first demonstration of complete, unmodified vehicle reuse in orbital spaceflight history.',
      },
      {
        type: 'paragraph',
        text: "The mission carried a pathfinder payload for NASA's Artemis V crewed lunar lander, validating the critical propellant transfer technology required for deep-space missions. The booster was caught by its mechazilla arms 8 minutes after liftoff; Ship splashed down 90 minutes later and was recovered by drone ship.",
      },
      {
        type: 'quote',
        text: "Today we demonstrated that fully reusable orbital rockets are not a dream. They are operational hardware. This changes everything about what's economically possible in space.",
        author: 'Elon Musk',
        role: 'CEO, SpaceX',
      },
      {
        type: 'stat',
        items: [
          { value: '8 min', label: 'Booster return' },
          { value: '100%', label: 'Stage reuse' },
          { value: '$50/kg', label: 'Target LEO cost' },
        ],
      },
    ],
  },
  {
    id: 'art-007',
    title: 'CRISPR trial shows 94% remission in late-stage blood cancers',
    category: 'Health',
    readTime: 5,
    timeAgo: '1 day ago',
    date: 'Mar 19, 2026',
    image: 'https://images.unsplash.com/photo-1583912086005-ac9abca6c9db?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      'Phase III data from a joint Stanford–UCSF trial shows unprecedented response rates for CRISPR-edited CAR-T therapy in patients who had failed all prior treatments.',
    source: 'MedBreak',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'A Phase III clinical trial involving 312 patients with relapsed or refractory diffuse large B-cell lymphoma (DLBCL) found that CRISPR-edited CAR-T cells achieved complete remission in 94% of participants — a rate that far exceeds the 40–60% seen with conventional CAR-T products.',
      },
      { type: 'heading', text: 'How the Editing Works' },
      {
        type: 'paragraph',
        text: 'The therapy, developed by Editas Medicine and UCSF\'s immunology lab, uses base editing to knock out the T-cell exhaustion gene TET2 and simultaneously introduce a synthetic promoter that sustains CAR expression over time. This prevents the "burn-out" that limits current-generation therapies.',
      },
      {
        type: 'quote',
        text: 'We treated patients who had exhausted every available option. Ninety-four percent is not an incremental improvement — it is a redefinition of what late-stage cancer treatment can look like.',
        author: 'Dr. James Wright',
        role: 'Oncology Lead, UCSF',
      },
      {
        type: 'paragraph',
        text: 'The FDA has granted Breakthrough Therapy designation. Editas expects to file a Biologics License Application by Q4 2026, with a potential launch in early 2027.',
      },
      {
        type: 'stat',
        items: [
          { value: '94%', label: 'Complete remission' },
          { value: '312', label: 'Patients treated' },
          { value: 'Q1 27', label: 'Expected launch' },
        ],
      },
    ],
  },
  {
    id: 'art-008',
    title: 'Bitcoin breaks $120K as BlackRock ETF inflows hit weekly record',
    category: 'Finance',
    readTime: 3,
    timeAgo: '2 days ago',
    date: 'Mar 18, 2026',
    image: 'https://images.unsplash.com/photo-1694219782948-afcab5c095d3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080',
    excerpt:
      "Bitcoin crossed $120,000 for the first time as BlackRock's IBIT absorbed $2.1 billion in weekly inflows, its largest since the ETF's launch.",
    source: 'Crypto Daily',
    isFeatured: false,
    content: [
      {
        type: 'paragraph',
        text: 'Bitcoin surpassed $120,000 on Thursday morning in Asian trading, driven by a record-breaking week of institutional inflows into U.S. spot Bitcoin ETFs. BlackRock\'s IBIT alone absorbed $2.1 billion — its highest weekly total since the product launched in January 2024.',
      },
      {
        type: 'paragraph',
        text: 'The rally has been attributed to a confluence of factors: the recent Fed pivot signals, the upcoming Bitcoin halving in April, and growing corporate treasury adoption following MicroStrategy\'s latest $1.5 billion purchase announcement.',
      },
      {
        type: 'quote',
        text: 'Bitcoin at $120K is the market pricing in a world where every major sovereign wealth fund has a 1–3% allocation. That day is closer than most people realize.',
        author: 'Cathie Wood',
        role: 'CEO, ARK Invest',
      },
      {
        type: 'stat',
        items: [
          { value: '$120K', label: 'BTC price' },
          { value: '$2.1B', label: 'IBIT weekly inflows' },
          { value: '+34%', label: 'Month-to-date' },
        ],
      },
    ],
  },
];

/** From AddExpenseModal MOCK_POOL + categories (docs/figma_source) */
const SEED_EXPENSE_ROWS = [
  { shop: 'Swiggy Order', amount: 347, cat: 'Food', bank: 'HDFC', card: 'Debit Card' },
  { shop: 'Zomato Delivery', amount: 529, cat: 'Food', bank: 'ICICI', card: 'Credit Card' },
  { shop: 'BigBasket Grocery', amount: 1243, cat: 'Grocery', bank: 'HDFC', card: 'Debit Card' },
  { shop: 'DMart Supermarket', amount: 2156, cat: 'Grocery', bank: 'FEDERAL', card: 'Debit Card' },
  { shop: 'Uber Ride', amount: 145, cat: 'Transport', bank: 'HDFC', card: 'Debit Card' },
  { shop: 'Netflix Subscription', amount: 649, cat: 'Entertainment', bank: 'ICICI', card: 'Credit Card' },
  { shop: 'Amazon Order', amount: 1599, cat: 'Shopping', bank: 'HDFC', card: 'Credit Card' },
  { shop: 'BESCOM Electricity', amount: 1876, cat: 'Bills', bank: 'HDFC', card: 'Debit Card' },
  { shop: 'Apollo Pharmacy', amount: 287, cat: 'Health', bank: 'Other', card: 'Cash' },
  { shop: 'Blinkit Grocery', amount: 632, cat: 'Grocery', bank: 'ICICI', card: 'Debit Card' },
];

/** CloudPage.tsx INITIAL_FILES */
const SEED_CLOUD_FILES = [
  {
    id: '1',
    name: 'Linguistic_Patterns_2024.pdf',
    size: Math.round(45.2 * 1024 * 1024),
    ext: 'pdf',
    date: 'Today',
    starred: 1,
    featured: 1,
    description: 'Deep neural analysis of semantic structures across multi-cloud repositories.',
    tags: ['ANALYSIS', '45.2 MB'],
  },
  {
    id: '2',
    name: 'Core_V_Zero.zip',
    size: Math.round(128.5 * 1024 * 1024),
    ext: 'zip',
    date: 'Yesterday',
    starred: 0,
    featured: 0,
    description: 'Compiled core modules and runtime dependencies.',
    tags: null,
  },
  {
    id: '3',
    name: 'Consciousness_Stream_09.mp4',
    size: Math.round(890.3 * 1024 * 1024),
    ext: 'mp4',
    date: 'Yesterday',
    starred: 0,
    featured: 0,
    description: null,
    tags: null,
  },
  {
    id: '4',
    name: 'Budget_Analysis_Q1.xlsx',
    size: Math.round(2.8 * 1024 * 1024),
    ext: 'xlsx',
    date: '2 days ago',
    starred: 1,
    featured: 0,
    description: null,
    tags: null,
  },
  {
    id: '5',
    name: 'Project_Presentation.pdf',
    size: Math.round(14.7 * 1024 * 1024),
    ext: 'pdf',
    date: '3 days ago',
    starred: 0,
    featured: 0,
    description: null,
    tags: null,
  },
  {
    id: '6',
    name: 'API_Documentation.docx',
    size: Math.round(5.1 * 1024 * 1024),
    ext: 'docx',
    date: '5 days ago',
    starred: 1,
    featured: 0,
    description: null,
    tags: null,
  },
];

/** TutorPage DEFAULT_WORDS */
const SEED_WORDS = [
  {
    id: 'w1',
    word: 'Ephemeral',
    pronunciation: '/ɪˈfem(ə)r(ə)l/',
    definition:
      'Lasting for a very short time; fleeting or transitory. Often used to describe moments, trends, or experiences that are beautifully brief and impermanent.',
    example:
      '"The ephemeral beauty of cherry blossoms reminds us to cherish every moment."',
  },
  {
    id: 'w2',
    word: 'Serendipity',
    pronunciation: '/ˌserənˈdɪpɪti/',
    definition:
      "The occurrence of fortunate events by chance in a happy or beneficial way — a pleasant surprise that wasn't planned or expected.",
    example: '"Finding my dream job through a casual coffee chat was pure serendipity."',
  },
  {
    id: 'w3',
    word: 'Eloquent',
    pronunciation: '/ˈeləkwənt/',
    definition:
      'Fluent or persuasive in speaking or writing. Able to express ideas clearly and with strong, compelling impact on the audience.',
    example: '"Her eloquent speech moved the entire audience to tears."',
  },
  {
    id: 'w4',
    word: 'Mellifluous',
    pronunciation: '/məˈlɪfluəs/',
    definition:
      'Sweet or musical; pleasant to hear. Describes a voice or sound that flows smoothly and agreeably, like liquid honey.',
    example: '"His mellifluous voice made even routine announcements sound poetic."',
  },
];

function seedDatabase(database) {
  const seeded = database.prepare('SELECT COUNT(*) AS c FROM expenses').get();
  if (seeded.c > 0) return;

  const ts = nowIso();
  const insertNews = database.prepare(`
    INSERT INTO news_articles (
      id, title, category, tag, read_time, time_ago, date, image, excerpt, source,
      is_featured, content_json, saved, read, created_at, updated_at
    ) VALUES (
      @id, @title, @category, @tag, @read_time, @time_ago, @date, @image, @excerpt, @source,
      @is_featured, @content_json, 0, 0, @created_at, @updated_at
    )
  `);

  for (const a of SEED_ARTICLES) {
    insertNews.run({
      id: a.id,
      title: a.title,
      category: a.category,
      tag: a.tag ?? null,
      read_time: a.readTime,
      time_ago: a.timeAgo,
      date: a.date,
      image: a.image,
      excerpt: a.excerpt,
      source: a.source,
      is_featured: a.isFeatured ? 1 : 0,
      content_json: JSON.stringify(a.content),
      created_at: ts,
      updated_at: ts,
    });
  }

  const insertExp = database.prepare(`
    INSERT INTO expenses (
      id, amount, description, category, bank, card_type, date, is_manual_category, created_at, updated_at
    ) VALUES (@id, @amount, @description, @category, @bank, @card_type, @date, 0, @created_at, @updated_at)
  `);

  let dayOffset = 0;
  for (const row of SEED_EXPENSE_ROWS) {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    dayOffset += 1;
    insertExp.run({
      id: uuidv4(),
      amount: row.amount,
      description: row.shop,
      category: row.cat,
      bank: row.bank,
      card_type: row.card,
      date: d.toISOString(),
      created_at: ts,
      updated_at: ts,
    });
  }

  database.prepare(`
    INSERT OR REPLACE INTO budget (id, amount, updated_at) VALUES ('current', 45000, ?)
  `).run(ts);

  const bh = database.prepare(`
    INSERT INTO budget_history (id, amount, set_at) VALUES (?, ?, ?)
  `);
  bh.run(uuidv4(), 40000, new Date(Date.now() - 86400000 * 14).toISOString());
  bh.run(uuidv4(), 45000, new Date(Date.now() - 86400000 * 7).toISOString());

  const insertCloud = database.prepare(`
    INSERT INTO cloud_files (
      id, name, size, ext, date_label, starred, description, tags_json, featured, created_at, updated_at
    ) VALUES (
      @id, @name, @size, @ext, @date_label, @starred, @description, @tags_json, @featured, @created_at, @updated_at
    )
  `);

  for (const f of SEED_CLOUD_FILES) {
    insertCloud.run({
      id: f.id,
      name: f.name,
      size: f.size,
      ext: f.ext,
      date_label: f.date,
      starred: f.starred,
      description: f.description,
      tags_json: f.tags ? JSON.stringify(f.tags) : null,
      featured: f.featured,
      created_at: ts,
      updated_at: ts,
    });
  }

  const insertWord = database.prepare(`
    INSERT INTO saved_words (id, word, pronunciation, definition, example, created_at, updated_at)
    VALUES (@id, @word, @pronunciation, @definition, @example, @created_at, @updated_at)
  `);
  for (const w of SEED_WORDS) {
    insertWord.run({ ...w, created_at: ts, updated_at: ts });
  }

  database.prepare(`
    INSERT INTO category_learnings (keyword, category, updated_at) VALUES ('swiggy', 'Food', ?)
  `).run(ts);

  const syncIns = database.prepare(`
    INSERT INTO cloud_sync_history (id, file_id, mode, message, at) VALUES (?, ?, ?, ?, ?)
  `);
  syncIns.run(uuidv4(), '1', 'download', 'Linguistic_Patterns_2024.pdf — verified', ts);
  syncIns.run(uuidv4(), '2', 'upload', 'Core_V_Zero.zip — queued', ts);
}

export function initDatabase() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  runMigrations(dbInstance);
  seedDatabase(dbInstance);
  cleanupLegacyNewsSeeds(dbInstance);
  return dbInstance;
}

export { DB_PATH, nowIso };
