-- ════════════════════════════════════════════════════════════════
-- RISCC Database Schema — Postgres version
-- 7 core tables + api_settings + 2 materialized helper tables.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE bds (
  bd_id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  team_leader_id VARCHAR(50),
  team_id VARCHAR(50),
  join_date DATE,
  status VARCHAR(20) DEFAULT 'Active',         -- ENUM Active/Inactive
  monthly_target_revenue DECIMAL(12,2),
  monthly_target_sales INT
);

CREATE TABLE team_leaders (
  tl_id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE campaigns (
  campaign_id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100),
  source VARCHAR(50) NOT NULL,                 -- Facebook/Google/Organic/WhatsApp/YouTube/Referral
  spend DECIMAL(12,2) DEFAULT 0,
  start_date DATE,
  end_date DATE,
  leads_generated INT DEFAULT 0
);

CREATE TABLE leads (
  lead_id VARCHAR(50) PRIMARY KEY,
  phone_normalized VARCHAR(15),
  crm_id VARCHAR(50),
  email VARCHAR(100),
  name VARCHAR(100),
  source VARCHAR(50),
  campaign_id VARCHAR(50) REFERENCES campaigns(campaign_id),
  state VARCHAR(50),
  category VARCHAR(50),                        -- Fresh/Repeat/Referral
  assigned_bd_id VARCHAR(50) REFERENCES bds(bd_id),
  assigned_date TIMESTAMP,
  status VARCHAR(20) DEFAULT 'Open',           -- Open/Interested/Proposal/Converted/Lost
  temperature VARCHAR(10) DEFAULT 'Cold',      -- Hot/Warm/Cold
  last_call_date TIMESTAMP,
  last_crm_update TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_leads_phone ON leads(phone_normalized);
CREATE INDEX idx_leads_created ON leads(created_at);

CREATE TABLE calls (
  call_id VARCHAR(50) PRIMARY KEY,
  lead_id VARCHAR(50) REFERENCES leads(lead_id),
  bd_id VARCHAR(50) REFERENCES bds(bd_id),
  call_timestamp TIMESTAMP NOT NULL,
  duration_seconds INT DEFAULT 0,              -- 0 = not connected; >30 = connected
  outcome VARCHAR(50),                         -- Connected/Not Connected/Busy/No Answer
  recording_url TEXT,
  crm_logged INTEGER DEFAULT 0,                -- 0/1 (kept as integer for JS compatibility)
  crm_log_time TIMESTAMP
);
CREATE INDEX idx_calls_lead ON calls(lead_id);
CREATE INDEX idx_calls_bd ON calls(bd_id);
CREATE INDEX idx_calls_ts ON calls(call_timestamp);
CREATE INDEX idx_calls_crmlog ON calls(crm_log_time);

CREATE TABLE sales (
  order_id VARCHAR(50) PRIMARY KEY,
  lead_id VARCHAR(50) REFERENCES leads(lead_id),
  bd_id VARCHAR(50) REFERENCES bds(bd_id),
  course_id VARCHAR(50),
  gross_amount DECIMAL(12,2) NOT NULL,
  waiver_amount DECIMAL(12,2) DEFAULT 0,
  net_amount DECIMAL(12,2) NOT NULL,           -- gross - waiver
  sale_date TIMESTAMP NOT NULL,
  payment_type VARCHAR(20),                    -- Full/EMI/Partial
  status VARCHAR(20) DEFAULT 'Confirmed'       -- Confirmed/Refunded/On Hold
);
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_status ON sales(status);

CREATE TABLE followups (
  followup_id VARCHAR(50) PRIMARY KEY,
  lead_id VARCHAR(50) REFERENCES leads(lead_id),
  bd_id VARCHAR(50) REFERENCES bds(bd_id),
  scheduled_date TIMESTAMP NOT NULL,
  actual_followup_date TIMESTAMP,
  gap_hours DECIMAL(6,1),
  status VARCHAR(20) DEFAULT 'Pending'          -- Pending/Done/Missed
);
CREATE INDEX idx_fu_scheduled ON followups(scheduled_date);

CREATE TABLE collections (
  collection_id VARCHAR(50) PRIMARY KEY,
  order_id VARCHAR(50) REFERENCES sales(order_id),
  amount_due DECIMAL(12,2) NOT NULL,
  amount_collected DECIMAL(12,2) DEFAULT 0,
  due_date DATE NOT NULL,
  payment_date DATE,
  status VARCHAR(20) DEFAULT 'Overdue'          -- Paid/Overdue/Partial/Defaulted
);
CREATE INDEX idx_coll_due ON collections(due_date);
CREATE INDEX idx_coll_status ON collections(status);

-- ════════════════════════════════════════════════════════════════
-- CONFIG TABLE — for things like revenue target, dates etc.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE config (
  key VARCHAR(50) PRIMARY KEY,
  value VARCHAR(200)
);

INSERT INTO config (key, value) VALUES
  ('revenue_target_mtd', '28000000'),
  ('current_date', '2026-06-11'),
  ('month_days', '30'),
  ('historical_collection_rate', '0.84');

-- ════════════════════════════════════════════════════════════════
-- API KEYS / CONNECTOR SETTINGS TABLE
-- ════════════════════════════════════════════════════════════════
CREATE TABLE api_settings (
  connector_key VARCHAR(50) PRIMARY KEY,   -- e.g. 'ocrm', 'sales_api', 'claude', 'gsheets'
  label VARCHAR(100),                       -- display name
  base_url VARCHAR(300),
  api_key VARCHAR(500),                     -- stored as-is server-side (encrypt at rest in prod)
  extra_config TEXT,                        -- JSON blob for connector-specific fields
  enabled INTEGER DEFAULT 0,                -- 0/1 (kept as integer for JS compatibility)
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO api_settings (connector_key, label, base_url, api_key, extra_config, enabled) VALUES
  ('ocrm', 'OCRM API', '', '', '{}', 0),
  ('sales_api', 'Sales Report API', '', '', '{}', 0),
  ('gsheets', 'Google Sheets', '', '', '{"sheet_id":""}', 0),
  ('claude', 'Claude API (Copilot + Insights)', 'https://api.anthropic.com/v1/messages', '', '{"model":"claude-sonnet-4-6"}', 0);

-- ════════════════════════════════════════════════════════════════
-- v_bd_daily_calls (materialized as real table, refreshed by cron)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE bd_daily_calls (
  bd_id VARCHAR(50),
  call_date DATE,
  total_calls INT DEFAULT 0,
  connected_calls INT DEFAULT 0,           -- duration_seconds > 30
  zero_sec_calls INT DEFAULT 0,            -- duration_seconds = 0
  talktime_seconds INT DEFAULT 0,
  unique_leads_called INT DEFAULT 0,
  PRIMARY KEY (bd_id, call_date)
);
CREATE INDEX idx_bdc_date ON bd_daily_calls(call_date);

-- ════════════════════════════════════════════════════════════════
-- v_uncalled_leads (materialized as real table, refreshed by cron)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE uncalled_leads (
  lead_id VARCHAR(50) PRIMARY KEY,
  assigned_bd_id VARCHAR(50),
  last_call_date TIMESTAMP,                  -- NULL = never called
  days_since_last_call INT,                  -- NULL if never called -> treated as assigned-age
  age_bucket VARCHAR(10),                     -- '0-1d','2-3d','4-7d','8-15d','15+d'
  daywise_flags VARCHAR(20)                   -- 15-char string of 0/1, 1 = uncalled that day (day0=today)
);
CREATE INDEX idx_uncalled_bucket ON uncalled_leads(age_bucket);
CREATE INDEX idx_uncalled_bd ON uncalled_leads(assigned_bd_id);

-- ════════════════════════════════════════════════════════════════
-- team_leaders / bds: no seed rows here — populated live by OCRM sync.
-- This schema starts EMPTY (no demo BDs/leads/sales). Real data comes
-- in via /api/sync/ocrm and /api/sync/sales_api after you add your
-- API keys in Settings.
-- ════════════════════════════════════════════════════════════════
