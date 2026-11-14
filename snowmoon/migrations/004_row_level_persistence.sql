-- SnowMoon Phase 11 Row-Level Persistence, Per-Record Optimistic Locking & Atomic Challenge Consumption
-- IMPORTANT: Review and execute manually in Supabase SQL Editor. Do NOT run automatically against live production.

-- 1. Extend existing Phase 10 relational tables with lossless payload JSONB and optimistic CAS version
ALTER TABLE public.snowmoon_customers
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.snowmoon_workers
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.snowmoon_workforce_jobs
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.snowmoon_intents
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.snowmoon_outlayer_calls
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.snowmoon_verifications
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.snowmoon_settlements
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

-- 2. Add durable wallet challenge table (replaces process-local / whole-collection challenge state)
CREATE TABLE IF NOT EXISTS public.snowmoon_wallet_challenges (
  challenge_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  nonce_base64 TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_account ON public.snowmoon_wallet_challenges(account_id);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_expires ON public.snowmoon_wallet_challenges(expires_at_ms);

-- 3. Add durable escrow job table (1:1 escrow tx <-> job binding)
CREATE TABLE IF NOT EXISTS public.snowmoon_escrow_jobs (
  intent_id TEXT PRIMARY KEY,
  job_id TEXT UNIQUE,
  escrow_tx_hash TEXT UNIQUE,
  customer_account_id TEXT NOT NULL,
  amount_atomic NUMERIC(39, 0) NOT NULL DEFAULT 0,
  escrow_state TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_escrow_jobs_customer ON public.snowmoon_escrow_jobs(customer_account_id);
CREATE INDEX IF NOT EXISTS idx_escrow_jobs_state ON public.snowmoon_escrow_jobs(escrow_state);

-- 4. Atomic single-use wallet challenge consumption RPC (eliminates multi-instance TOCTOU replay)
CREATE OR REPLACE FUNCTION public.snowmoon_consume_wallet_challenge(
  p_challenge_id TEXT,
  p_now_ms BIGINT
)
RETURNS TABLE (
  challenge_id TEXT,
  account_id TEXT,
  nonce_base64 TEXT,
  recipient TEXT,
  message TEXT,
  expires_at_ms BIGINT,
  consumed BOOLEAN,
  payload JSONB,
  version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.snowmoon_wallet_challenges AS wc
     SET consumed = TRUE,
         version = wc.version + 1,
         updated_at = NOW(),
         payload = jsonb_set(wc.payload, '{consumed}', 'true'::jsonb, TRUE)
   WHERE wc.challenge_id = p_challenge_id
     AND wc.consumed = FALSE
     AND wc.expires_at_ms >= p_now_ms
  RETURNING
    wc.challenge_id,
    wc.account_id,
    wc.nonce_base64,
    wc.recipient,
    wc.message,
    wc.expires_at_ms,
    wc.consumed,
    wc.payload,
    wc.version;
END;
$$;

-- 5. Idempotent backfill from snowmoon_kv_collections into row-level tables
-- Safe to re-run: ON CONFLICT DO NOTHING preserves any newer row-level writes.
DO $$
DECLARE
  rec JSONB;
BEGIN
  -- customers
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'customers'
  LOOP
    INSERT INTO public.snowmoon_customers (account_id, wallet_provider, network, last_verified_at, created_at, payload)
    VALUES (
      rec->>'accountId',
      COALESCE(rec->>'walletProvider', 'unknown'),
      COALESCE(rec->>'network', 'mainnet'),
      COALESCE((rec->>'lastVerifiedAt')::timestamptz, NOW()),
      COALESCE((rec->>'createdAt')::timestamptz, NOW()),
      rec
    )
    ON CONFLICT (account_id) DO NOTHING;
  END LOOP;

  -- workers
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'workers'
  LOOP
    INSERT INTO public.snowmoon_workers (worker_id, account_id, display_name, capabilities, available, token_hash, payload)
    VALUES (
      rec->>'workerId',
      COALESCE(rec->>'accountId', ''),
      COALESCE(rec->>'displayName', ''),
      COALESCE(rec->'capabilities', '[]'::jsonb),
      COALESCE((rec->>'available')::boolean, TRUE),
      rec->>'authKeyHash',
      rec
    )
    ON CONFLICT (worker_id) DO NOTHING;
  END LOOP;

  -- workforceJobs
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'workforceJobs'
  LOOP
    INSERT INTO public.snowmoon_workforce_jobs (
      job_id, customer_account_id, amount_atomic, required_capabilities, prompt, state,
      assigned_worker_id, attempts, last_error, input_hash, output_hash, execution_time_ms, execution_mode, payload
    )
    VALUES (
      rec->>'jobId',
      COALESCE(rec->>'customerAccountId', ''),
      COALESCE((rec->>'amountAtomic')::numeric(39,0), 0),
      COALESCE(rec->'requiredCapabilities', '[]'::jsonb),
      COALESCE(rec->>'prompt', ''),
      COALESCE(rec->>'state', 'FUNDED'),
      rec->>'assignedWorkerId',
      COALESCE((rec->>'attempts')::integer, 0),
      rec->>'lastError',
      rec->>'inputHash',
      rec->>'outputHash',
      (rec->>'executionTimeMs')::integer,
      rec->>'executionMode',
      rec
    )
    ON CONFLICT (job_id) DO NOTHING;
  END LOOP;

  -- escrowJobs
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'escrowJobs'
  LOOP
    INSERT INTO public.snowmoon_escrow_jobs (intent_id, job_id, escrow_tx_hash, customer_account_id, amount_atomic, escrow_state, payload)
    VALUES (
      rec->>'intentId',
      rec->>'jobId',
      rec->>'txHash',
      COALESCE(rec->>'customerAccountId', ''),
      COALESCE((rec->>'amountAtomic')::numeric(39,0), 0),
      COALESCE(rec->>'escrowState', 'UNKNOWN'),
      rec
    )
    ON CONFLICT (intent_id) DO NOTHING;
  END LOOP;

  -- intents
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'intents'
  LOOP
    INSERT INTO public.snowmoon_intents (
      intent_id, idempotency_key, customer_near_account, source_wallet_address, source_chain,
      origin_asset, destination_asset, amount_in_atomic, expected_amount_out_atomic, min_amount_out_atomic,
      slippage_tolerance_bps, deposit_address, quote_expires_at, source_tx_hash, destination_tx_hash,
      lifecycle_stage, status, destination_verified, escrow_funding_enabled, escrow_intent_id, actionable_error, payload
    )
    VALUES (
      rec->>'intentId',
      COALESCE(rec->>'idempotencyKey', rec->>'intentId'),
      COALESCE(rec->>'customerNearAccount', ''),
      COALESCE(rec->>'sourceWalletAddress', ''),
      COALESCE(rec->>'sourceChain', ''),
      COALESCE(rec->>'originAsset', ''),
      COALESCE(rec->>'destinationAsset', ''),
      COALESCE((rec->>'amountInAtomic')::numeric(39,0), 0),
      COALESCE((rec->>'expectedAmountOutAtomic')::numeric(39,0), 0),
      COALESCE((rec->>'minAmountOutAtomic')::numeric(39,0), 0),
      COALESCE((rec->>'slippageToleranceBps')::integer, 50),
      COALESCE(rec->>'depositAddress', rec->>'intentId'),
      COALESCE((rec->>'quoteExpiresAt')::timestamptz, NOW()),
      rec->>'sourceTxHash',
      rec->>'destinationTxHash',
      COALESCE(rec->>'lifecycleStage', 'QUOTED'),
      COALESCE(rec->>'status', 'PENDING_DEPOSIT'),
      COALESCE((rec->>'destinationVerified')::boolean, FALSE),
      COALESCE((rec->>'escrowFundingEnabled')::boolean, FALSE),
      rec->>'escrowIntentId',
      rec->>'actionableError',
      rec
    )
    ON CONFLICT (intent_id) DO NOTHING;
  END LOOP;

  -- outlayerCalls
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'outlayerCalls'
  LOOP
    INSERT INTO public.snowmoon_outlayer_calls (
      request_id, call_id, job_id, worker_id, input_hash, output_hash, evidence_hash,
      status, mode, attestation_url, attestation_checks, error, payload
    )
    VALUES (
      rec->>'requestId',
      rec->>'callId',
      COALESCE(rec->>'jobId', ''),
      COALESCE(rec->>'workerId', ''),
      COALESCE(rec->>'inputHash', ''),
      rec->>'outputHash',
      COALESCE(rec->>'evidenceHash', ''),
      COALESCE(rec->>'status', 'EXECUTION_PENDING'),
      COALESCE(rec->>'mode', 'outlayer'),
      rec->>'attestationUrl',
      rec->'attestationChecks',
      rec->>'error',
      rec
    )
    ON CONFLICT (request_id) DO NOTHING;
  END LOOP;

  -- verifications
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'verifications'
  LOOP
    INSERT INTO public.snowmoon_verifications (job_id, evidence_hash, verification_status, verifier_account_id, audit_tx_hash, payload)
    VALUES (
      rec->>'jobId',
      COALESCE(rec->>'evidenceHash', ''),
      COALESCE(rec->>'verificationStatus', 'PENDING'),
      rec->>'verifierAccountId',
      rec->>'auditTxHash',
      rec
    )
    ON CONFLICT (job_id) DO NOTHING;
  END LOOP;

  -- settlements
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'settlements'
  LOOP
    INSERT INTO public.snowmoon_settlements (
      settlement_id, idempotency_key, job_id, kind, customer_account_id, worker_account_id,
      gross_amount_atomic, platform_fee_bps, platform_fee_atomic, worker_payout_atomic,
      status, tx_hash, on_chain_confirmed, payload
    )
    VALUES (
      rec->>'settlementId',
      COALESCE(rec->>'idempotencyKey', rec->>'settlementId'),
      COALESCE(rec->>'jobId', ''),
      COALESCE(rec->>'kind', 'PAYOUT_ACCEPT_DELIVERY'),
      COALESCE(rec->>'customerAccountId', ''),
      COALESCE(rec->>'workerAccountId', ''),
      COALESCE((rec->>'grossAmountAtomic')::numeric(39,0), 0),
      COALESCE((rec->>'platformFeeBps')::integer, 0),
      COALESCE((rec->>'platformFeeAtomic')::numeric(39,0), 0),
      COALESCE((rec->>'workerPayoutAtomic')::numeric(39,0), 0),
      COALESCE(rec->>'status', 'PREPARED'),
      rec->>'txHash',
      COALESCE((rec->>'onChainConfirmed')::boolean, FALSE),
      rec
    )
    ON CONFLICT (settlement_id) DO NOTHING;
  END LOOP;

  -- walletChallenges
  FOR rec IN
    SELECT elem FROM public.snowmoon_kv_collections kv, jsonb_array_elements(kv.payload) AS elem
     WHERE kv.collection_key = 'walletChallenges'
  LOOP
    INSERT INTO public.snowmoon_wallet_challenges (
      challenge_id, account_id, nonce_base64, recipient, message, expires_at_ms, consumed, payload
    )
    VALUES (
      rec->>'challengeId',
      COALESCE(rec->>'accountId', ''),
      COALESCE(rec->>'nonceBase64', ''),
      COALESCE(rec->>'recipient', 'snowmoon.near'),
      COALESCE(rec->>'message', ''),
      COALESCE((rec->>'expiresAtMs')::bigint, 0),
      COALESCE((rec->>'consumed')::boolean, FALSE),
      rec
    )
    ON CONFLICT (challenge_id) DO NOTHING;
  END LOOP;
END $$;

-- 6. Service-role-only RLS & privileges on new tables & RPC
DO $$
DECLARE
  tbl TEXT;
  new_tables TEXT[] := ARRAY['snowmoon_wallet_challenges', 'snowmoon_escrow_jobs'];
BEGIN
  FOREACH tbl IN ARRAY new_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated;', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role;', tbl);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.snowmoon_consume_wallet_challenge(TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snowmoon_consume_wallet_challenge(TEXT, BIGINT) FROM anon;
REVOKE ALL ON FUNCTION public.snowmoon_consume_wallet_challenge(TEXT, BIGINT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.snowmoon_consume_wallet_challenge(TEXT, BIGINT) TO service_role;

INSERT INTO public.snowmoon_migrations (id, description)
VALUES (
  '004_row_level_persistence',
  'Row-level persistence tables, per-record optimistic CAS versioning, atomic wallet challenge consumption RPC, and idempotent KV backfill'
)
ON CONFLICT (id) DO NOTHING;

