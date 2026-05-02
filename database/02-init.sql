-- ═══════════════════════════════════════════════════════════════
-- AI NEXUS — PostgreSQL Schema (complete)
--
-- This runs ONCE on first Postgres volume init.
-- The API's initTables() also creates these with IF NOT EXISTS,
-- so this is a safety net / fast-path for fresh deployments.
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation (for PG < 13 compat)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── updated_at trigger function ─────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  membership_tier VARCHAR(50) DEFAULT 'free',
  member_since TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

DROP TRIGGER IF EXISTS set_users_updated_at ON users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- CATEGORIES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(50),
  color VARCHAR(20),
  sort_order INT DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════
-- TRANSACTIONS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'INR',
  category_id UUID REFERENCES categories(id),
  description TEXT,
  type VARCHAR(10) CHECK (type IN ('income', 'expense')),
  transaction_date TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);

DROP TRIGGER IF EXISTS set_transactions_updated_at ON transactions;
CREATE TRIGGER set_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- AI CONVERSATIONS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  input_text TEXT,
  corrected_text TEXT,
  feature VARCHAR(50) DEFAULT 'text_correction',
  platform VARCHAR(50),
  tone VARCHAR(50),
  model_used VARCHAR(100),
  messages JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- SYNC LOG
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  table_name VARCHAR(100) NOT NULL,
  record_id VARCHAR(255) NOT NULL,
  operation VARCHAR(20) NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- NEWS ARTICLES (canonical schema — TEXT id, matches API code)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Technology',
  tag TEXT,
  read_time INTEGER NOT NULL DEFAULT 1,
  time_ago TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  content_json TEXT NOT NULL DEFAULT '{}',
  saved BOOLEAN NOT NULL DEFAULT FALSE,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  guid TEXT,
  original_url TEXT,
  summary_markdown TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_news_guid ON news_articles(guid);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at);
CREATE INDEX IF NOT EXISTS idx_news_updated ON news_articles(updated_at);

-- ═══════════════════════════════════════════════════════════════
-- DELETED GUIDS (tombstone for purged articles)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS deleted_guids (
  guid TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- ARTICLE CHAT MESSAGES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS article_chat_messages (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  model TEXT DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acm_article ON article_chat_messages(article_id);

-- ═══════════════════════════════════════════════════════════════
-- ARTICLE CHAT SUMMARIES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS article_chat_summaries (
  article_id TEXT PRIMARY KEY,
  summary_text TEXT NOT NULL,
  pairs_covered INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- SAVED WORDS (dictionary)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS saved_words (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '',
  pronunciation TEXT DEFAULT '',
  part_of_speech TEXT DEFAULT '',
  saved_at TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- EXPENSES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  amount DECIMAL(12,2) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  bank TEXT NOT NULL DEFAULT '',
  card_type TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  is_manual_category BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- BUDGET ENTRIES
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS budget_entries (
  id TEXT PRIMARY KEY,
  amount DECIMAL(12,2) NOT NULL,
  set_at TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- CATEGORY LEARNINGS (AI keyword → category cache)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS category_learnings (
  keyword TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- AI RESPONSE CACHE
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_response_cache (
  cache_key TEXT PRIMARY KEY,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_response_cache(created_at);

-- ═══════════════════════════════════════════════════════════════
-- APP SETTINGS (key-value store)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value)
VALUES ('news_summarize_provider', 'litellm')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- USER PREFERENCES (cross-device settings sync)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- X FEED SYNC STATE (daily X/Twitter digest tracking)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS x_feed_sync_state (
  handle TEXT PRIMARY KEY,
  last_window_end TEXT,
  last_sync_at TIMESTAMPTZ,
  total_articles INTEGER NOT NULL DEFAULT 0,
  total_posts_processed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
