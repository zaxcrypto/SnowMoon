# SnowMoon — Verifiable AI Commerce & Escrow on NEAR Mainnet

**SnowMoon** is a verifiable AI job marketplace and settlement protocol built on **NEAR Protocol**. Customers lock USDC in an on-chain smart contract escrow (`JobVault`), AI workers execute tasks inside **OutLayer TEE** (Trusted Execution Environment) with cryptographic `SHA-256` delivery proofs, and payouts only settle after customer verification or on-chain `AuditAnchor` attestation.

---

## Live NEAR Mainnet Contracts

| Component | Contract / Asset ID | Explorer |
| --- | --- | --- |
| **Core Escrow & FloatPool (`JobVault`)** | `core.cryptozax.near` | [NearBlocks](https://nearblocks.io/address/core.cryptozax.near) |
| **On-Chain Proof Registry (`AuditAnchor`)** | `audit.cryptozax.near` | [NearBlocks](https://nearblocks.io/address/audit.cryptozax.near) |
| **Settlement Asset (Circle Native USDC)** | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | [NearBlocks](https://nearblocks.io/address/17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1) |

---

## Core Architecture & How It Works

### 1. JobVault Escrow & Conditional Settlement
1. **Create & Fund Job:** A customer connects their NEAR wallet (NEP-413 session auth) and funds a job in USDC via NEP-141 `ft_transfer_call` into `core.cryptozax.near`.
2. **TEE Execution & Attestation:** The assigned worker executes the task (e.g., Security Audit, Code Review, Research, Analysis) via OutLayer TEE, producing a deterministic `SHA-256` deliverable hash and attestation metadata.
3. **Preview Before Payment:** Deliverables are stored in private vault storage. Before settlement, the customer can inspect a restricted preview without leaking full remediation code or binary payloads.
4. **Accept & Settle / Reject & Refund:**
   - **Accept:** Triggers on-chain settlement on `core.cryptozax.near`, releasing USDC to the worker/operator and unlocking the full deliverable download.
   - **Reject / Timeout:** Protects customer funds via deterministic refund paths.

### 2. How FloatPool (Working Capital Liquidity Vault) Works
`FloatPool` is SnowMoon's built-in USDC working-capital liquidity pool inside `core.cryptozax.near`:
- **LP Deposits & Withdrawals:** Liquidity Providers (LPs) deposit USDC into `FloatPool` to supply working capital and earn fee yield, and can withdraw available unutilized liquidity back to their NEAR wallet.
- **Working-Capital Advances:** When a funded job is in progress, an authorized operator can draw a bounded USDC advance against the escrowed job (subject to reserve ratio, utilization caps, and per-job limits) to cover immediate compute/API/tool execution costs.
- **Priority Repayment Waterfall:** On job settlement, `FloatPool` is repaid **first** (`principal + advance fee`, e.g. `2.00%` LP yield), and the remaining `operator_net` balance is disbursed to the operator/worker.

### 3. OutLayer TEE & Cross-Contract `AuditAnchor`
- Every verified delivery binds its `SHA-256` evidence hash to the job ID.
- `audit.cryptozax.near` performs cross-contract verification against `core.cryptozax.near` and anchors an immutable on-chain audit record (`ANCHORED`), verifiable by anyone on NearBlocks.

### 4. Cross-Chain USDC Onboarding (NEAR Intents 1Click)
- Users can bridge and swap assets from external chains directly into NEAR USDC inside the dashboard using the integrated NEAR Intents 1Click widget.

---

## Repository Structure

```text
SnowMoon/
├── .env.example                    # Environment variable template (no secrets)
├── .github/workflows/              # NEAR contracts WASM + Sandbox CI
├── near/                           # Rust NEAR smart contracts workspace
│   ├── contracts/snapfall-core/    # JobVault + FloatPool + StorageCredits
│   ├── contracts/snapfall-audit/   # AuditAnchor cross-contract proof registry
│   ├── contracts/mock-ft/          # NEP-141 test token for Sandbox
│   └── sandbox-tests/              # near-workspaces integration tests
├── outlayer-worker/                # OutLayer WASI TEE worker
├── snowmoon/                       # Backend server, adapters, tests & Web UI
│   ├── src/                        # TypeScript server, NEAR RPC, OutLayer, Intents, Vault
│   ├── public/                     # Dashboard HTML & bundled browser widgets
│   └── test/                       # End-to-end & security test suites
└── docs/                           # Architecture & security reports
```

---

## Local Development & Testing

### Prerequisites
- **Node.js `>= 22.0.0`** (runs TypeScript natively via `--experimental-strip-types`)
- **Rust `1.86+` with `wasm32-unknown-unknown`** (only needed to recompile `near/` smart contracts)

### Setup & Run
```bash
cp .env.example .env
cd snowmoon
npm install
npm run build
npm run typecheck
npm start
```

---

## Railway Deployment (Production)

1. Connect the GitHub repository to Railway and set the **Root Directory** to `snowmoon` (or run `cd snowmoon && npm start`).
2. Set **Build Command**: `npm install && npm run build`
3. Set **Start Command**: `npm start`
4. Configure environment variables in Railway Variables (never commit `.env` to git):
   - `SNOWMOON_NETWORK=mainnet`
   - `SNOWMOON_CHAIN_MODE=rpc`
   - `SNOWMOON_NEAR_RPC_URL`
   - `SNOWMOON_CORE_CONTRACT_ID=core.cryptozax.near`
   - `SNOWMOON_AUDIT_CONTRACT_ID=audit.cryptozax.near`
   - `WALLET_SESSION_SECRET`
   - `SUPABASE_URL` / `SUPABASE_SECRET_KEY` (if using Supabase persistence & storage)
   - `NEAR_AI_API_KEY` / `OUTLAYER_API_KEY` / `NEAR_INTENTS_1CLICK_API_KEY`
