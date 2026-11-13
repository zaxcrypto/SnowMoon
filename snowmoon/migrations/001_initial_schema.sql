-- SnowMoon Phase 10 Production Database Schema (PostgreSQL / Supabase)
-- Strict security: NO private keys, seed phrases, or raw API secrets may ever be stored here.

CREATE TABLE IF NOT EXISTS snowmoon_migrations (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snowmoon_customers (
  account_id TEXT PRIMARY KEY,
  wallet_provider TEXT NOT NULL,
  network TEXT NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snowmoon_workers (
  worker_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  -- Store only SHA-256 hash of bearer token, never raw secret
  token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workers_account_id ON snowmoon_workers(account_id);
CREATE INDEX IF NOT EXISTS idx_workers_available ON snowmoon_workers(available);

CREATE TABLE IF NOT EXISTS snowmoon_workforce_jobs (
  job_id TEXT PRIMARY KEY,
  customer_account_id TEXT NOT NULL,
  amount_atomic NUMERIC(39, 0) NOT NULL,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  assigned_worker_id TEXT REFERENCES snowmoon_workers(worker_id),
  assignment_lock_version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  input_hash TEXT,
  output_hash TEXT,
  execution_time_ms INTEGER,
  execution_mode TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON snowmoon_workforce_jobs(customer_account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON snowmoon_workforce_jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_worker ON snowmoon_workforce_jobs(assigned_worker_id);

CREATE TABLE IF NOT EXISTS snowmoon_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  customer_near_account TEXT NOT NULL,
  source_wallet_address TEXT NOT NULL,
  source_chain TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  amount_in_atomic NUMERIC(39, 0) NOT NULL,
  expected_amount_out_atomic NUMERIC(39, 0) NOT NULL,
  min_amount_out_atomic NUMERIC(39, 0) NOT NULL,
  slippage_tolerance_bps INTEGER NOT NULL,
  deposit_address TEXT UNIQUE NOT NULL,
  quote_expires_at TIMESTAMPTZ NOT NULL,
  source_tx_hash TEXT UNIQUE,
  destination_tx_hash TEXT UNIQUE,
  lifecycle_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  destination_verified BOOLEAN NOT NULL DEFAULT FALSE,
  escrow_funding_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  escrow_intent_id TEXT UNIQUE,
  actionable_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intents_customer ON snowmoon_intents(customer_near_account);
CREATE INDEX IF NOT EXISTS idx_intents_status ON snowmoon_intents(status);

CREATE TABLE IF NOT EXISTS snowmoon_outlayer_calls (
  request_id TEXT PRIMARY KEY,
  call_id TEXT UNIQUE,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  attestation_url TEXT,
  attestation_checks JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outlayer_job ON snowmoon_outlayer_calls(job_id);
CREATE INDEX IF NOT EXISTS idx_outlayer_status ON snowmoon_outlayer_calls(status);

CREATE TABLE IF NOT EXISTS snowmoon_verifications (
  job_id TEXT PRIMARY KEY,
  evidence_hash TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  verifier_account_id TEXT,
  audit_tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snowmoon_settlements (
  settlement_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  job_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  worker_account_id TEXT NOT NULL,
  gross_amount_atomic NUMERIC(39, 0) NOT NULL,
  platform_fee_bps INTEGER NOT NULL,
  platform_fee_atomic NUMERIC(39, 0) NOT NULL,
  worker_payout_atomic NUMERIC(39, 0) NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  on_chain_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON snowmoon_settlements(status);

-- Generic collection mirror table for atomic repository sync when PostgREST RPC is used
CREATE TABLE IF NOT EXISTS snowmoon_kv_collections (
  collection_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO snowmoon_migrations (id, description)
VALUES ('001_initial_schema', 'Initial SnowMoon Phase 10 production schema with unique constraints, indexes, and idempotency keys')
ON CONFLICT (id) DO NOTHING;

