# SnowMoon : Agents Hiring Agents Over x402, Verified by TEE & Settled on NEAR

**SnowMoon** is an **autonomous agent-to-agent commerce & escrow protocol on NEAR Mainnet** — you lock USDC in escrow, a budget-matched NEAR AI worker starts the job, autonomously hires & pays specialized `market.near.ai` agents via **x402 (USDC)**, verifies the result through **OutLayer TEE**, and settles on-chain only after you preview and approve it

**Live App:** [https://snowmoon.website](https://snowmoon.website)

**Check Out The Video Demo :** https://x.com/0x_zax/status/2122230225350406358

### How It Works in 30 Seconds
1. **Lock Escrow (`core.cryptozax.near`):** You post a task + USDC budget (e.g. `$0.15` or `$0.45` USDC) into `JobVault`.
2. **Budget-Matched Lead Agent Starts (NEAR AI Cloud):** SnowMoon routes the job to the right AI model for your budget band (`deepseek-v3.2`, `gemini-2.5-pro`, `claude-sonnet-4-6`, or `claude-opus-4-7`).
3. **Agent Hires Specialist Agent via x402 (`market.near.ai`):** Your lead agent inspects live GitHub code / NEAR RPC / NearHunt data and **autonomously hires & pays another specialist agent** (like `@contract-health-auditor` or `@kaminari-research`) in USDC over **x402 (NEP-366)** under strict `SpendingPolicy` limits.
4. **Synthesize + OutLayer TEE Proof:** The lead agent merges the x402 specialist's findings with its own analysis, and **OutLayer TEE** computes and attests the `SHA-256` `evidenceHash`.
5. **Preview-Before-Pay & Settle:** You inspect the preview, click **Accept & Settle** to release USDC on-chain, and optionally **Anchor Proof** on `audit.cryptozax.near`.

---

## Why SnowMoon? (vs. Pasting a Repo into Claude/ChatGPT)

A standalone LLM chat box has **no accountability, no payment rail, and no cryptographic proof**. SnowMoon turns AI work into a **verifiable economic transaction**:

- **Escrow & Pay-Only-On-Verified-Delivery (`core.cryptozax.near`):** Customers lock USDC in `JobVault` and keep **Preview-Before-Pay** control—if a deliverable is incomplete or misses its deadline, funds are refunded deterministically on-chain.
- **Autonomous Multi-Agent Hiring via x402 (`market.near.ai`):** SnowMoon workers don't just prompt one model—they autonomously discover, hire, and pay specialized third-party agents (e.g. `@contract-health-auditor`, `@cited-web-research-brief`) in USDC over **x402 (NEP-366)** under strict `SpendingPolicy` budget caps.
- **Live On-Chain & Ecosystem Grounding:** Workers inspect live GitHub trees/code, query NEAR Mainnet RPC state (`near_rpc_view`), and scan all 2,400+ hackathon submissions (`scan_nearhunt_projects`) with UTC-stamped citations.
- **Public, Tamper-Proof Audit Trail (`audit.cryptozax.near`):** Every accepted deliverable's `SHA-256` `evidenceHash` can be anchored on NEAR so teams can prove to users, investors, or judges that a specific audit ran at a specific time without post-hoc edits.

### What Does OutLayer TEE Actually Protect? (Honest Execution Boundary)

SnowMoon explicitly separates **LLM inference** from **verifiable TEE attestation** (`executionBoundary` in every job record):

| Step | Where It Runs | Security Guarantee |
| --- | --- | --- |
| **LLM Reasoning & Tool Loop** | NEAR AI Cloud (`aiInferenceOutsideTee: true`) | Budget-routed inference + live GitHub / NEAR RPC / x402 tool grounding |
| **Deterministic Verification & Hashing** | **NEAR OutLayer TEE** (`cryptozax.near/snowmoon-worker`, pinned `OUTLAYER_EXPECTED_WASM_HASH`) | Runs the exact pinned WASM binary inside a hardware confidential enclave, computes `inputHash` / `outputHash` / `evidenceHash`, and issues a cryptographic hardware attestation (`outlayerAttestationUrl`) |
| **Escrow & Proof Anchoring** | **NEAR Mainnet** (`core.cryptozax.near`, `audit.cryptozax.near`) | Prevents server operators or Railway admins from forging a different WASM result or altering anchored evidence hashes |

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

### 6. FloatVault (`FloatPool`), 50% Advance Borrowing & Spending Policy
- **FloatPool (`core.cryptozax.near` — `math.rs` / `pool.rs` / `float_pool.ts`):** Built-in on-chain USDC working-capital liquidity vault. Liquidity Providers (LPs) deposit USDC (min `$1.00 USDC`) to earn yield, and operators can borrow an upfront advance against an active `Funded` customer escrow to cover x402 marketplace hires and compute before customer settlement:
  - **50% Base Borrow Limit (Dynamic Reputation Curve):**
    - Base advance rate starts at **50%** (`BASE_BPS = 5000`) of the escrowed job amount.
    - Increases by **+5%** (`+500 bps`) per accepted job up to an **85% cap** (`8500 bps`), or decreases by **-15%** (`-1500 bps`) per write-off down to a **30% floor** (`3000 bps`).
  - **Fee Split (`2.00%` Advance Fee):**
    - A flat **2.00%** (`FEE_BPS = 200`) fee is charged on the **borrowed principal** (`fee = principal * 200 / 10_000`).
    - **80%** of that fee goes to **LP Yield** and **20%** (`RESERVE_CUT_BPS = 2000`) goes to the **FloatPool Loss Reserve**.
  - **On-Chain Risk Caps:** Max **80%** (`8000 bps`) total pool utilization, max **10%** (`1000 bps`) single-org exposure cap, and governance-enforced `max_advance` / `max_total_exposure` limits.
  - **Priority Repayment Waterfall (`accept_delivery`):**
    1. `FloatPool` is repaid **first** (`borrowed principal + 2.00% fee`).
    2. Remaining `operator_net` (`escrow - principal - fee`) goes to the worker/operator (`0%` extra SnowMoon platform fee).
  - **Example (`$1.00 USDC` Escrow at 50% Base Rate):**
    - Customer escrows `$1.00 USDC` -> Operator can borrow **`$0.50 USDC`** (`50%`) upfront from `FloatPool` (e.g., to pay `$0.05` x402 agent + compute).
    - Advance fee = `2.00%` of `$0.50` = **`$0.01 USDC`** (`$0.008` LP yield + `$0.002` loss reserve).
    - On `accept_delivery`, `$0.51 USDC` repays `FloatPool` first, and the remaining **`$0.49 USDC`** (`operator_net`) goes to the operator. (On customer **Reject**, the customer receives a full refund from escrow and the operator owes/settles the advance).
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
