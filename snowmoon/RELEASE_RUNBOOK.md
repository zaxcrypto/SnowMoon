# SnowMoon Release & Production Operations Runbook

## 1. Production Environment Variable Checklist
Never commit `.env` or expose server-side secrets to frontend bundles.

| Variable | Required for Live | Classification | Purpose |
| --- | --- | --- | --- |
| `SNOWMOON_HOST` / `SNOWMOON_PORT` | Yes | Public config | HTTP server bind (`127.0.0.1` behind TLS reverse proxy) |
| `SNOWMOON_NETWORK` | Yes (`mainnet`) | Public config | Target NEAR network |
| `SNOWMOON_CORE_CONTRACT_ID` | Yes (`core.cryptozax.near`) | Public config | Core escrow contract |
| `SNOWMOON_AUDIT_CONTRACT_ID` | Yes (`audit.cryptozax.near`) | Public config | AuditAnchor contract |
| `SNOWMOON_USDC_CONTRACT_ID` | Yes | Public config | Native NEAR Mainnet USDC (`17208628...`) |
| `SUPABASE_URL` | Yes | Public URL | Production Supabase project endpoint |
| `SUPABASE_SECRET_KEY` | Yes | **SECRET** | Server-side PostgREST service key (RLS bypassed only server-side) |
| `NEAR_AI_API_KEY` | Yes (Live AI) | **SECRET** | NEAR AI Cloud bearer token (`cloud-api.near.ai/v1`) |
| `OUTLAYER_PAYMENT_KEY` | Yes (Live OutLayer) | **SECRET** | OutLayer `X-Payment-Key` for paid calls |
| `OUTLAYER_PROJECT_OWNER` / `OUTLAYER_PROJECT_NAME` | Yes (Live OutLayer) | Public config | OutLayer `/call/{owner}/{project}` target |
| `OUTLAYER_EXPECTED_WASM_HASH` | Recommended | Public config | Pinned 64-hex SHA-256 WASM hash for attestation check |
| `NEAR_INTENTS_1CLICK_API_KEY` | Optional | **SECRET** | Optional 1Click `X-API-Key` for higher rate limits |

---

## 2. Staging vs Production Deployment

### Staging
1. Set `SNOWMOON_AI_MODE=mock`, `SNOWMOON_DB_MODE=json` (or staging Supabase project), and keep `core.cryptozax.near` `vault_paused: true`.
2. Run `npm ci && npm run typecheck && npm run build && npm test`.
3. Start server with `npm start` behind HTTPS reverse proxy.

### Production
1. Verify Supabase migrations `001_initial_schema` and `002_rls_hardening` are applied.
2. Deploy `audit.cryptozax.near` with `>= 2.00 NEAR` from `cryptozax.near` (see `LAUNCH_GUIDE.md`).
3. Run `npm ci && npm run typecheck && npm run build && npm test`.
4. Start `npm start` under process supervisor (`systemd` / Docker / PM2) with TLS termination.
5. Verify all 4 health endpoints before unpausing Core.

---

## 3. Health Checks & Monitoring
- `GET /api/database/health` → expect `backend: "supabase"`, `connected: true`, `migrationsApplied: true`, `rlsHardened: true`, `pendingSyncCount: 0`.
- `GET /api/outlayer/config-status` → expect `readyForLiveExecution: true` when OutLayer credentials are configured.
- `GET /api/audit/readiness` → expect `matchesCiExpected: true` and `auditAccountExists: true` after deployment.
- `GET /api/near/mainnet-status` → verifies Mainnet RPC connectivity, Core accounting, and pause flags.

---

## 4. Database Backup & Recovery
- Enable **Supabase Point-in-Time Recovery (PITR)** / daily automated snapshots in the Supabase dashboard.
- Periodic logical backup: `pg_dump --schema=public --no-owner --no-acl "$DATABASE_URL" > snowmoon_backup.sql`.
- Transient network recovery: `SupabaseDatabaseAdapter` queues dirty collections in local write-ahead storage and flushes via `resyncPending()` when Supabase recovers.

---

## 5. Incident Response & Rollback
1. **Pause Core Immediately (On-Chain Circuit Breaker):** Call `pause_vault` and `pause_pool` on `core.cryptozax.near` from `cryptozax.near`.
2. **Disable Paid OutLayer / AI:** Set `SNOWMOON_AI_MODE=mock` or remove `OUTLAYER_PAYMENT_KEY` and restart the Node service.
3. **Pull-Claim Fallback:** Any failed NEP-141 `ft_transfer` remains safely withdrawable via `Core::claim_usdc` (`POST /api/settlement/prepare-claim` + claimant wallet signature).
4. **AuditAnchor Rollback:** See `LAUNCH_GUIDE.md` (never `DeleteAccount` after live anchors exist).

---

## 6. Controlled Launch Checklist & Phase 23 Observability
- [x] `001_initial_schema` & `002_rls_hardening` verified in Supabase (`rlsHardened: true`).
- [x] `OUTLAYER_PAYMENT_KEY`, `OUTLAYER_PROJECT_OWNER`, `OUTLAYER_PROJECT_NAME`, `OUTLAYER_EXPECTED_WASM_HASH` configured (`outlayer-verify` CLI installed and verified).
- [x] `core.cryptozax.near` and `audit.cryptozax.near` verified via read-only Mainnet RPC (`vault_paused: true`, `pool_paused: true` safe default).
- [x] Observability & hardening active: `GET /api/health`, `GET /api/metrics`, `X-Request-Id` correlation IDs, separate read (`1200/min`) vs mutation (`120/min`) rate buckets, static security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), and `path.relative` traversal guard.
- [x] `npm audit --registry=https://registry.npmjs.org` (0 vulnerabilities), `npm run typecheck`, `npm run build`, and `npm test` (51/51 tests including 1,000-concurrency & race-condition tests) passed.
- [ ] Complete live Chrome DevTools browser pass once remote debugging (`chrome://inspect/#remote-debugging`) is enabled.
- [ ] Owner explicitly unpauses `core.cryptozax.near` (`vault_paused: false`) for canary job when ready for Mainnet launch.

