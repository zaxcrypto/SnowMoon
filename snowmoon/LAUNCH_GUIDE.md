# SnowMoon Production Launch & Operations Guide

## 1. Supabase Production Database Migration (Non-Destructive)

1. Open your Supabase project dashboard → **SQL Editor**.
2. Paste and run `snowmoon/migrations/001_initial_schema.sql` (uses `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING`, safe to re-run).
3. Ensure `.env` sets:
   - `SUPABASE_URL=https://<project-ref>.supabase.co`
   - `SUPABASE_SECRET_KEY=<service-role-or-secret-key>`
   - Ensure `SNOWMOON_DB_MODE` is unset or `supabase`.
4. Verify via `GET /api/database/health`:
   - Expected: `"backend": "supabase"`, `"connected": true`, `"migrationsApplied": true`, `"migrationVersion": "001_initial_schema"`, `"productionReady": true`.

---

## 2. OutLayer Production Configuration

1. Configure in `.env` (server-side only; never expose to frontend):
   - `OUTLAYER_PAYMENT_KEY=<your-outlayer-payment-key>`
   - `OUTLAYER_PROJECT_OWNER=<near-owner-account>`
   - `OUTLAYER_PROJECT_NAME=<outlayer-project-name>`
   - `OUTLAYER_VERSION_KEY=<optional-pinned-version>`
   - `OUTLAYER_EXPECTED_WASM_HASH=<64-hex-sha256-of-approved-wasm>`
   - `OUTLAYER_COMPUTE_LIMIT=10000`
   - `OUTLAYER_ATTACHED_DEPOSIT=0`
2. Verify via `GET /api/outlayer/config-status`:
   - Expected: `"readyForLiveExecution": true`, `"mode": "live_outlayer"`, `"missingEnvVars": []`.
3. Without `OUTLAYER_PAYMENT_KEY`, `OUTLAYER_PROJECT_OWNER`, and `OUTLAYER_PROJECT_NAME`, SnowMoon stays in clearly labeled `MOCK_EXECUTION` (`mock_fallback`) mode.

---

## 3. AuditAnchor (`audit.cryptozax.near`) Mainnet Deployment & Rollback

- **Artifact:** `near/artifacts/ci-mvp/snapfall_audit.wasm`
- **Verified Size:** `131,338` bytes
- **Verified SHA-256:** `88b1c550b639c31f9fede0cbc305bbb2fbb26389c942e28e2f79bbddfb9c13e1`
- **Minimum Parent Funding (`cryptozax.near`):** `>= 2.00 NEAR` (`~1.32 NEAR` contract storage stake + `~0.68 NEAR` operational gas reserve).

### Deployment Sequence (Manual / Signer-Approved Only)
1. Query `GET /api/audit/readiness` to confirm `sufficientFunds: true` and `matchesCiExpected: true`.
2. Generate or load the dedicated FullAccess keypair for `audit.cryptozax.near` (gitignored keystore).
3. Broadcast a batched transaction from `cryptozax.near` to `audit.cryptozax.near`:
   - `CreateAccount`
   - `Transfer(2.00 NEAR)`
   - `AddKey(FullAccess)`
   - `DeployContract(snapfall_audit.wasm)`
   - `FunctionCall(new({ "admin": "cryptozax.near", "core_contract": "core.cryptozax.near" }))`
4. Post-deployment read-only verification:
   - `near view audit.cryptozax.near get_info '{}'`
   - `near view audit.cryptozax.near is_authorized_core '{"core":"core.cryptozax.near"}'`

### Rollback & Recovery
- If initialization fails before live anchors exist, re-deploy `snapfall_audit.wasm` with the `audit.cryptozax.near` FullAccess key or call `DeleteAccount` with beneficiary `cryptozax.near` to recover remaining NEAR.
- Never call `DeleteAccount` after production audit records have been anchored.

