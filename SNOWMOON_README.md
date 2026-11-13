# SnowMoon NEAR Protocol

Autonomous AI Job Escrow (`JobVault`), Working Capital Liquidity (`FloatPool`), OutLayer Spending Policy Guard, and Cross-Contract Cryptographic Verification (`AuditAnchor`) on NEAR Protocol.

---

## Repository Structure

```text
SnowMoon/
├── .env.example                                     # Complete environment template (zero secrets)
├── .github/workflows/near-contracts.yml             # Standalone NEAR contracts WASM + Sandbox CI
├── near/                                            # Rust NEAR smart contracts workspace
│   ├── contracts/snapfall-core/                     # Core contract: JobVault + FloatPool + StorageCredits
│   ├── contracts/snapfall-audit/                    # AuditAnchor cross-contract verification registry
│   ├── contracts/mock-ft/                           # NEP-141 USDC test token for Sandbox
│   ├── contracts/withdraw-helper/                   # Test helper for storage callback verification
│   ├── sandbox-tests/                               # 10 near-workspaces Sandbox integration tests
│   └── scripts/                                     # Production WASM packaging & verification scripts
├── snowmoon/                                        # End-to-End SnowMoon MVP Daemon, Adapters & Web UI
│   ├── src/config.ts                                # Environment & server-side credential loader
│   ├── src/engine.ts                                # Deterministic contract state engine (exact parity)
│   ├── src/adapters.ts                              # NEAR AI Cloud / Mock Worker & OutLayer Policy Adapter
│   ├── src/server.ts                                # HTTP REST API & static dashboard server
│   ├── public/index.html                            # 7-View SnowMoon Web Dashboard
│   └── test/mvp-journey.test.ts                     # End-to-end 12-step journey & policy guard test suite
└── docs/reports/
    ├── PHASE_0_7_1_FINAL_ARCHITECTURE_SPECIFICATION.md
    └── PHASE_1_IMPLEMENTATION_REPORT.md
```

---

## Quick Start — Run the SnowMoon 12-Step MVP Locally

### Prerequisites
- **Node.js `>= 22.0.0`** (uses built-in TypeScript execution via `--experimental-strip-types` — zero external `npm install` required)
- **Rust `1.86+` with `wasm32-unknown-unknown`** (for compiling NEAR contracts in `near/`)

### 1. Configure Environment (Optional)
```bash
cp .env.example .env
```
By default, `.env.example` runs in **local deterministic Sandbox mode** (`SNOWMOON_CHAIN_MODE=sandbox`, `SNOWMOON_AI_MODE=auto`, `SNOWMOON_WALLET_MODE=auto`), clearly labelling simulated/mock adapters in the UI when live API keys (`NEAR_AI_API_KEY`, `OUTLAYER_API_KEY`) are not set.

### 2. Run the Automated End-to-End Journey Tests
```bash
cd snowmoon
npm test
```

### 3. Launch the SnowMoon Daemon & 7-View Dashboard
```bash
cd snowmoon
npm start
```
Open **`http://127.0.0.1:8090`** in your browser.

---

## Complete 12-Step Customer-to-Settlement-to-Audit Journey

Click **`▶ Run Complete 12-Step Journey`** in the top bar of the dashboard (or `POST /api/demo/run-complete-journey`) to execute and verify every stage:

1. **Customer connects wallet** (`customer.snowmoon.test.near`).
2. **Customer creates an AI job** — deterministic contract-derived Job ID under namespace `snowmoon-core/job-id/v1`, locking `0.023 NEAR` initial storage deposit.
3. **Customer funds the job** — `$100.00 USDC` escrowed in `JobVault`.
4. **Job appears in the dashboard** — indexed in `Funded` state with its SHA-256 `termsHash`.
5. **AI daemon receives the job** — operator `operator.snowmoon.test.near` transitions the job to `InProgress` and draws a `$20.00 USDC` working-capital advance (`#1`, `2.00%` fee = `$0.40 USDC`) from `FloatPool`.
6. **AI worker executes the task** — executes via `NEAR AI Cloud` (when `NEAR_AI_API_KEY` is provided) or the clearly labelled `[MOCK AI WORKER ADAPTER — DETERMINISTIC LOCAL EXECUTION]`.
7. **Worker requests controlled spending** — `$0.04 USDC` micro-query is **auto-approved** (`<= $0.10` threshold) with a cryptographic receipt hash; `$4.00 USDC` dataset purchase is **escalated** to the human Operator Approval Queue.
8. **Approval is recorded** — Operator approves the `$4.00 USDC` request (protected by a SHA-256 post-approval substitution hash check); total operating spend becomes `$4.04 USDC` within the `$25.00 USDC` budget.
9. **Worker submits the result and evidence hash** — `submit_delivery` records the non-zero SHA-256 `delivery_hash` on `JobVault`.
10. **Customer accepts delivery** — `accept_delivery` transitions the job to `Accepted`.
11. **Settlement accounting executes** — `FloatPool` is repaid `$20.40 USDC` first (`$20.00` principal + `$0.40` fee yield to LPs), and the remaining `$79.60 USDC` (`operator_net`) is paid to the operator.
12. **`AuditAnchor` verifies the evidence** — `anchor_job` performs cross-contract verification against `snapfall-core::verify_job_for_audit` and records an immutable on-chain proof (`0.006 NEAR` deposit -> `0.003 NEAR` retained, `0.003 NEAR` refunded).

