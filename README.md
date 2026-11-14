# SnowMoon — Verifiable AI Commerce & Escrow on NEAR Mainnet

**Live App:** [https://snowmoon.website](https://snowmoon.website) *(Backup: [snowmoon-production.up.railway.app](https://snowmoon-production.up.railway.app))*

**SnowMoon** is an autonomous, verifiable AI job marketplace and settlement protocol built on **NEAR Mainnet**. Customers lock USDC in an on-chain smart contract escrow (`JobVault`), capability-scoped AI workers execute tasks using **NEAR AI Cloud**, **NEAR Agent Marketplace (`market.near.ai` x402)**, and **OutLayer TEE** (Trusted Execution Environment) with cryptographic `SHA-256` delivery proofs, and payouts only settle after customer **Preview-Before-Pay** verification or on-chain `AuditAnchor` attestation.

---

## NEAR Stack & Live Mainnet Infrastructure

| Layer | NEAR Product / Component | Identifier / Endpoint |
| --- | --- | --- |
| **Core Escrow & FloatPool (`JobVault`)** | NEAR Mainnet Smart Contract (Rust) | [`core.cryptozax.near`](https://nearblocks.io/address/core.cryptozax.near) |
| **On-Chain Proof Registry (`AuditAnchor`)** | NEAR Mainnet Smart Contract (Rust) | [`audit.cryptozax.near`](https://nearblocks.io/address/audit.cryptozax.near) |
| **Settlement Asset (Native USDC)** | NEP-141 Fungible Token | [`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`](https://nearblocks.io/address/17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1) |
| **Wallet & Auth** | NEAR Wallet Selector + NEP-413 Session Auth | Meteor, MyNearWallet, HERE (`x-wallet-session`) |
| **Cross-Chain USDC Onboarding** | NEAR Intents (`1Click` Bridge) | Integrated **Get USDC on NEAR** widget |
| **Agentic LLM Inference** | NEAR AI Cloud | `https://cloud-api.near.ai/v1/chat/completions` |
| **Autonomous Specialist Hiring** | NEAR Agent Marketplace (x402 / NEP-366) | `market.near.ai` (A2A + HTTP `402` USDC settlement) |
| **Verifiable Compute** | NEAR OutLayer TEE | `https://api.outlayer.ai` (`cryptozax.near/snowmoon-worker`) |
| **On-Chain State & Finality** | NEAR Mainnet RPC | `https://free.rpc.fastnear.com` + `near_rpc_view` |

---

## Complete A-to-Z Architecture & Job Flow

### 1. Wallet Connection & Cross-Chain Funding
- Connect any NEAR Mainnet wallet via **NEAR Wallet Selector** with signed **NEP-413** session authentication (`x-wallet-session`) and anti-impersonation guards.
- Need USDC on NEAR? Use the integrated **NEAR Intents (`1Click`)** bridge (**Get USDC on NEAR**) directly inside the dashboard.

### 2. Job Creation & On-Chain Escrow (`JobVault`)
1. Fill **Create Job** (**Title**, **Describe Task**, **Target Link / Resource**, optional **Attach File**, **Capability**, and **Budget USDC**). Drafts auto-persist in `localStorage` across tab switches and wallet redirects.
2. Click **Create Job** -> review in the smooth **Confirm Job & Escrow** drawer -> **Approve in Wallet** to sign NEP-141 `ft_transfer_call` into `core.cryptozax.near`.
3. SnowMoon reconciles Mainnet finality (`/api/near/escrow/reconcile`), assigns the worker (`cryptozax.near`), and confirms `start_work` on-chain.

### 3. Capability-Scoped Agentic Execution (`AIWorkerAdapter`)
When execution starts, SnowMoon runs a multi-stage autonomous pipeline streamed live into the dashboard terminal:
- **Budget-Proportional Dynamic Model Routing (`selectModelForTask`):** Routes across **5 USDC budget bands** so micro-tasks stay fast & loss-proof while high-value audits get flagship reasoning + critic verification:

  | Budget Band | USDC Range | Example Model (`security-audit`) |
  | --- | --- | --- |
  | **Micro** | `< $0.10` | `google/gemini-2.5-flash-lite` |
  | **Standard** | `$0.10 – $0.99` | `deepseek/deepseek-v3.2` *(fallback `google/gemini-2.5-flash`)* |
  | **Pro** | `$1.00 – $4.99` | `google/gemini-2.5-pro` |
  | **Growth** | `$5.00 – $24.99` | `anthropic/claude-sonnet-4-6` *(+ critic pass)* |
  | **Enterprise** | `>= $25.00` | `anthropic/claude-opus-4-7` *(+ critic pass)* |
- **6 Isolated Capability Rule Profiles (`snowmoon/src/capability_rules.ts`):** Strict, non-overlapping protocols for:
  - `security-audit` — 5-point smart contract & backend checklist, GitHub AST/file inspection, mandatory live `near_rpc_view` citation, and x402 specialist verification.
  - `code-review` — architecture, correctness, edge cases, performance, and test coverage review.
  - `research` — live web/docs verification with UTC citations, plus an **X / Twitter Profile Intelligence** protocol (`api.fxtwitter.com` + `r.jina.ai` + `web_search`) for analyzing `@handle` profiles, followers, niche, post style, and latest posts.
  - `analysis` — structured root-cause, risk-matrix, and quantitative breakdown.
  - `summarization` — fidelity-checked executive synthesis.
  - `data-extraction` — strict schema/JSON extraction.
- **Deterministic x402 Pre-Flight & `market.near.ai` Failover (`near_market_x402.ts`):**
  - For NEAR contract `security-audit` jobs (`>= $0.10` USDC), SnowMoon **deterministically** hires `@contract-health-auditor` (`$0.05` USDC via `market.near.ai` x402) before Round 1, executes NEP-366 `X-PAYMENT` USDC settlement, polls `GetTask`, and injects the verified findings into the AI context.
  - Supports `discover_near_market_agents` and `hire_near_market_agent` with automatic multi-agent failover (`hireBestMarketAgentWithFailover`) and seamless native NEAR AI + built-in tool fallback (`github_repo_tree`, `github_read_file`, `github_search_code`, `near_rpc_view`, `web_search`, `fetch_url`).

### 4. OutLayer TEE Attestation & `submit_delivery`
- The synthesized deliverable is submitted to **OutLayer TEE** (`live_outlayer`) for independent WASM attestation.
- SnowMoon computes the `SHA-256` `evidenceHash`, vaults the full `.md` deliverable in private storage (`deliverables.ts`), and confirms `submit_delivery` on `core.cryptozax.near`.

### 5. Preview-Before-Pay, Settlement & `AuditAnchor`
- **Preview:** Customers inspect a restricted preview (`PREVIEW ONLY`) in the **Deliverable Preview** modal; full download remains locked until on-chain settlement.
- **Accept & Settle:** Executes on-chain settlement on `core.cryptozax.near`, releasing USDC payout and unlocking full `.md` **Download** + optional cross-contract **Anchor Proof** on `audit.cryptozax.near`.
- **Reject & Refund:** Clicking **Reject** opens a slide-up rejection reason drawer, marks the deliverable `REJECTED_LOCKED`, and enables deterministic customer **Refund (Wallet)**.

### 6. FloatVault (`FloatPool`) & Spending Policy
- **FloatPool (`core.cryptozax.near`):** Built-in USDC working-capital liquidity vault. LPs deposit USDC to earn yield, operators draw bounded advances against active escrowed jobs to cover x402 marketplace hires/compute, and on settlement `FloatPool` uses a **priority repayment waterfall**:
  1. `FloatPool` is repaid **first** (`borrowed principal + LP yield fee`, e.g. `2.00%`).
  2. Remaining `operator_net` goes to the worker/operator (`0%` extra SnowMoon platform fee).
- **Spending Policy (`spending_policy.ts` & Approvals Tab):** Enforces configurable autonomous micro-spend limits (e.g., `<= $0.10` USDC auto-approve), human escalation above limit, per-job budget caps, and post-approval substitution guards.

---

## Repository Structure

```text
SnowMoon/
├── .env.example                    # Environment variable template (no secrets)
├── .github/workflows/              # NEAR contracts WASM + Sandbox & SnowMoon TS CI
├── near/                           # Rust NEAR smart contracts workspace
│   ├── contracts/snapfall-core/    # JobVault + FloatPool + StorageCredits (core.cryptozax.near)
│   ├── contracts/snapfall-audit/   # AuditAnchor cross-contract proof registry (audit.cryptozax.near)
│   ├── contracts/mock-ft/          # NEP-141 test token for Sandbox
│   └── sandbox-tests/              # near-workspaces integration tests
├── outlayer-worker/                # OutLayer WASI TEE worker
├── snowmoon/                       # Backend server, adapters, tests & Web UI
│   ├── src/                        # server.ts, adapters.ts, agent_tools.ts, capability_rules.ts,
│   │                               # near_market_x402.ts, spending_policy.ts, persistence.ts, etc.
│   ├── public/                     # Dashboard UI (index.html) & bundled browser widgets
│   └── test/                       # End-to-end, x402, agent tools & security test suites
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
npm test
npm start
```

---

## Railway Production Deployment

SnowMoon runs in production on **Railway** at **[https://snowmoon.website](https://snowmoon.website)**:
1. Connect GitHub `main` to Railway with **Root Directory** set to `snowmoon`.
2. **Build Command:** `npm install && npm run build`
3. **Start Command:** `npm start`
4. Configure production environment variables in Railway Variables (never commit `.env` to git):
   - `SNOWMOON_NETWORK=mainnet`, `SNOWMOON_CHAIN_MODE=rpc`, `SNOWMOON_NEAR_RPC_URL`
   - `SNOWMOON_CORE_CONTRACT_ID=core.cryptozax.near`, `SNOWMOON_AUDIT_CONTRACT_ID=audit.cryptozax.near`
   - `WALLET_SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
   - `NEAR_AI_API_KEY`, `OUTLAYER_API_KEY`, `OUTLAYER_PAYMENT_KEY`, `NEAR_INTENTS_1CLICK_API_KEY`
