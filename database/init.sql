-- ═══════════════════════════════════════════════════════════════
-- AI NEXUS — PostgreSQL Schema
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation
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
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  membership_tier VARCHAR(50) DEFAULT 'free',
  member_since TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

DROP TRIGGER IF EXISTS set_users_updated_at ON users;
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- REFRESH TOKENS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ═══════════════════════════════════════════════════════════════
-- CATEGORIES (pre-seeded)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(50) NOT NULL,
  color VARCHAR(20) NOT NULL,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO categories (id, name, icon, color, sort_order) VALUES
  ('food',          'Food & Drinks',  'restaurant',     '#4725F4', 1),
  ('transport',     'Transport',      'directions_car',  '#0EA5E9', 2),
  ('shopping',      'Shopping',       'shopping_bag',    '#F43F5E', 3),
  ('rent',          'Rent & Bills',   'home',            '#F59E0B', 4),
  ('entertainment', 'Entertainment',  'movie',           '#EC4899', 5),
  ('health',        'Health',         'healing',         '#10B981', 6),
  ('education',     'Education',      'school',          '#8B5CF6', 7),
  ('others',        'Others',         'more_horiz',      '#64748B', 8)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- TRANSACTIONS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  category_id VARCHAR(50) REFERENCES categories(id),
  description TEXT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense')),
  transaction_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at);

DROP TRIGGER IF EXISTS set_transactions_updated_at ON transactions;
CREATE TRIGGER set_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- NEWS ARTICLES (cached from RSS / AI summarized)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS news_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  image_url TEXT,
  source_url TEXT,
  source_name VARCHAR(255),
  category VARCHAR(50),
  is_ai_summarized BOOLEAN DEFAULT false,
  published_at TIMESTAMP,
  cached_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_category ON news_articles(category);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_cached ON news_articles(cached_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- AI CONVERSATIONS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255),
  feature VARCHAR(50) DEFAULT 'text_correction',
  input_text TEXT NOT NULL,
  corrected_text TEXT,
  messages JSONB,
  platform VARCHAR(50),
  platform_variation TEXT,
  tone VARCHAR(50),
  model_used VARCHAR(100),
  is_synced BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_feature ON ai_conversations(feature);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_created ON ai_conversations(created_at DESC);

DROP TRIGGER IF EXISTS set_ai_conversations_updated_at ON ai_conversations;
CREATE TRIGGER set_ai_conversations_updated_at
  BEFORE UPDATE ON ai_conversations
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- SYNC LOG
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sync_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  table_name VARCHAR(100) NOT NULL,
  record_id UUID NOT NULL,
  operation VARCHAR(10) NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  payload JSONB,
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_table ON sync_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_synced ON sync_log(synced_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- SEED DATA — demo news articles
-- ═══════════════════════════════════════════════════════════════
INSERT INTO news_articles (title, summary, content, source_name, category, is_ai_summarized, published_at) VALUES
  (
    'GPT-5 Launches With Multimodal Reasoning Across All Domains',
    'OpenAI''s latest model demonstrates unprecedented reasoning capabilities, scoring above human benchmarks in complex scientific and mathematical tasks.',
    'OpenAI is preparing to launch GPT-5, its most advanced language model yet, with significant improvements in reasoning, multimodal capabilities, and real-time knowledge access.',
    'TechCrunch',
    'AI Labs',
    true,
    NOW() - INTERVAL '2 hours'
  ),
  (
    'Federal Reserve Signals Rate Cuts Amid Cooling Inflation Data',
    'Markets rally as the Fed hints at potential rate reductions in Q2, citing consistent downward trends in core inflation metrics.',
    'The Federal Reserve has signaled potential interest rate cuts following consistent cooling in inflation data over the past three months.',
    'Bloomberg',
    'Finance',
    true,
    NOW() - INTERVAL '4 hours'
  ),
  (
    'Apple Vision Pro 2 Redefines Spatial Computing With Neural Interface',
    'Second-generation headset ships with brain-computer interface support, enabling hands-free control and direct thought-to-action workflows.',
    'Apple has unveiled the Vision Pro 2, featuring a revolutionary neural interface that allows users to control the device through thought alone.',
    'The Verge',
    'Tech',
    false,
    NOW() - INTERVAL '6 hours'
  ),
  (
    'DeepMind''s AlphaFold 4 Predicts Protein Interactions in Real-Time',
    'The latest iteration enables live protein folding simulation, accelerating drug discovery pipelines from months to days.',
    'DeepMind has released AlphaFold 4, capable of real-time protein interaction prediction that could revolutionize pharmaceutical research.',
    'Nature',
    'AI Labs',
    true,
    NOW() - INTERVAL '8 hours'
  ),
  (
    'Bitcoin ETF Inflows Surpass $100B Milestone as Institutions Double Down',
    'Spot Bitcoin ETFs see record institutional inflows, with BlackRock''s fund alone attracting $40B in assets under management.',
    'Institutional investment in Bitcoin ETFs has reached unprecedented levels, with total inflows crossing the $100 billion mark.',
    'CoinDesk',
    'Finance',
    false,
    NOW() - INTERVAL '10 hours'
  )
ON CONFLICT DO NOTHING;
