# SNOWMOON NEAR PORT — PHASE 1 IMPLEMENTATION REPORT (Revision 5)

- **Path:** `docs/reports/PHASE_1_IMPLEMENTATION_REPORT.md`
- **Baseline:** `docs/reports/PHASE_0_7_1_FINAL_ARCHITECTURE_SPECIFICATION.md`
- **Branch:** `feat/near-phase-1-contracts`
  - Local only. **Nothing committed, pushed or deployed.**
  - `origin` is unchanged. **No `zax` remote has been added.**
- **Date:** 2026-11-12
- **Status:** **PARTIALLY VERIFIED — Phase 1 is NOT complete.**
  - All 43 unit tests pass.
  - All production and test WASMs build, and all 10 Sandbox tests compile.
  - **0 of 10 Sandbox tests have executed.** They will run in the SnowMoon repository once you authorise the push.
- This is an engineering self-audit, **not** an independent security audit.

---

## 1. Results (Revision 5, Windows host)

| Check | Command | Exit | Result |
| :--- | :--- | :---: | :--- |
| Audit unit tests | `with-win-msvc-env.ps1 test -p snapfall-core -p snapfall-audit --lib -- --nocapture --test-threads=1` | `0` | **4 passed, 0 failed, 0 ignored** |
| Core unit tests | (same run) | `0` | **39 passed, 0 failed, 0 ignored** |
| **Total unit tests** | | | **43 passed** (42 from Revision 4 + 1 new: `test_registration_refund_failure_restores_funds`) |
| WASM workspace check | `with-win-msvc-env.ps1 check-wasm` | `0` | no errors, no warnings |
| Production WASMs + gate | `package-production-wasm.ps1`; `bash near/scripts/verify-production-artifacts.sh` | `0` / `0` | `snapfall_core.wasm` 715,433 B; `snapfall_audit.wasm` 339,468 B |
| Test WASMs | `build -p mock-ft -p withdraw-helper --release`; `build -p snapfall-core --features test-fail-callback --release` | `0` / `0` | `mock_ft.wasm` 253,449 B; `withdraw_helper.wasm` 198,670 B; `snapfall_core_fail_cb.wasm` 718,410 B |
| Sandbox suite compile | `NEAR_SANDBOX_BIN_PATH=unsupported-windows-host … test -p sandbox-tests --no-run` | `0` | 10 tests compiled |
| Domain in the production binary | byte scan of `snapfall_core.wasm` | — | contains `snowmoon-core/job-id/v1`; old domain absent; 0 references to the old domain in the source |
| **Sandbox execution** | `cargo test -p sandbox-tests -- --nocapture --test-threads=1` (Linux) | — | **0 of 10 executed** |

Production SHA-256:

```text
4fb30c8d077386bdcc4164312230f6304b715d24158642d3cfd91f661bb094f6  snapfall_core.wasm
553ce034e8d21122b65220f1dd9c3980ed0b2141dd97d3d7fbf87da67c62a950  snapfall_audit.wasm
```

Measured storage (unchanged unless noted):

| Measurement | Value |
| :--- | :--- |
| Worst-case per-job peak | 1,521 B → 0.023 NEAR |
| Worst persistent | 1,051 B |
| LP exit in flight | 395 B |
| LP claim slot | 454 B |
| Storage-credit record | 141 B |
| Registration total | **409 B** (+1 B for the refund flag) → 614 B at 1.5× ≤ 700 B (0.007 NEAR) |
| Anchor | 350 B transient / 186 B permanent |

---

## 2. Item 1 — Job Deposit and Storage-Credit Registration Are Separate

They are separate requirements. They are held in different fields, tracked by different totals, and never offset against each other.

| | **Job storage deposit** | **Storage-credit registration** |
| :--- | :--- | :--- |
| Amount | **0.023 NEAR** (`JOB_STORAGE_DEPOSIT_INITIAL`, admin-adjustable per §9.3) | **0.007 NEAR** (`STORAGE_REGISTRATION`, constant) |
| Funds | One job's records: Job, Advance, first-time OrgCredit, the job's two claim entries and their claim operations | One account's storage-credit record + one in-flight storage withdrawal |
| Charged when | `create_job`: attached, or debited from the caller's credit **balance**. `CreateAndFundJob`: debited from the sender's credit **balance**. | When an account's credit record is **created**: at its first `storage_deposit` (minimum 0.007 NEAR), or out of the first credit to an unregistered account (cancel refund or stake refund). The amount is disclosed in `StorageRegistered`. |
| Held in | `job.storage_locked`; total `total_storage_locked` | `record.registration`; total `total_storage_registration` |
| Can a job deposit come out of the registration? | **No.** Debits only touch `balance`. A registered account with balance 0 cannot create a job from credits. | — |
| Refunded when | `cancel` of an unfunded job: **exactly** `storage_locked`, to the sponsor's credit balance. After funding it stays locked, because the job records are permanent history. | Full storage exit: once a withdrawal leaves the balance at 0 (or the user calls `storage_withdraw(None)` at balance 0), a **tracked** refund returns the registration. The record is removed when that refund succeeds. |
| Refunded to | `job.storage_sponsor` (credit balance, then `storage_withdraw`) | The account itself (native transfer) |

Example — a brand-new customer using `CreateAndFundJob`:

1. They deposit ≥ 0.030 NEAR: 0.007 NEAR becomes the registration and 0.023 NEAR is credited as balance.
2. `CreateAndFundJob` locks that 0.023 NEAR.
3. Their record remains, funded by its 0.007 NEAR registration, which is refunded when they fully exit.

---

## 3. Item 2 — SnowMoon Job-ID Namespace

```text
job_id = sha256( "snowmoon-core/job-id/v1" || borsh(creator) || seq.to_le_bytes() )
```

| Property | How it holds |
| :--- | :--- |
| **Deterministic** | A pure function of `(creator, seq)` with no randomness or timestamps. `test_contract_derived_job_ids` recomputes the ID independently from the documented preimage and compares it. |
| **Collision-resistant** | SHA-256 over a domain-separated, length-prefixed (Borsh) creator, plus an 8-byte sequence number. `issue_job_id` also rejects any collision with an existing job (`ERR_JOB_EXISTS`). |
| **Monotonic** | A single global `next_job_seq`, increment-only with `checked_add`, never reset. Two issued IDs never share a sequence number. |
| **Versioned** | `/v1` suffix. The constant must stay frozen after deployment. |

The domain is fixed **before** any deployment, so no already-issued IDs are affected.

---

## 4. Item 3 — LP 0.020 NEAR Reservation: Re-Audit of Every Exit Path

The LP stake (`LP_SHARE_STAKE`) = base 0.006 NEAR (entry + one exit op) + self claim slot 0.007 NEAR + external claim slot 0.007 NEAR. It is charged once, when the share entry is created.

| # | Path | Storage needed | Funded by | Extra NEAR at exit? | Test |
| :- | :--- | :--- | :--- | :---: | :--- |
| 1 | Withdraw/redeem to self, transfer succeeds | entry with active exit (+8 B) + exit op 235 B, freed on callback | base | **No** | `test_lp_storage_…` |
| 2 | To self, transfer fails, LP has **no** claim entry | new LP claim entry 219 B (+ claim op later) | self slot (moved, `payer = LP`) | **No** | same |
| 3 | To self, transfer fails, LP **already** has a claim entry (from a job or an earlier epoch) | 0 new bytes (balance added) | — | **No** | additive path (T-21 / Decision 4 tests) |
| 4 | To an external receiver, transfer succeeds | as path 1 | base | **No** | same |
| 5 | External, transfer fails, receiver has no claim entry | new receiver claim entry | external slot (moved, `payer = LP`) | **No** | same |
| 6 | External, transfer fails, receiver already has an entry | 0 new bytes | — | **No** | additive path |
| 7 | External exit while the external slot is still busy | — | — | **No** — the exit is **refused** (`ERR_EXTERNAL_CLAIM_SLOT_BUSY`). **An exit to self is always allowed.** | same |
| 8 | Second exit while one is in flight | — | — | **No** — refused (`ERR_EXIT_IN_FLIGHT`) until the first resolves (1–2 blocks) | same |
| 9 | Full exit (shares → 0) with slots in use | entry released after its callback | remaining stake refunded to the LP; slot stakes return to the LP when those claim entries close | **No** | same |
| 10 | Exits while vault **and** pool are paused | — | — | **No** — exits are never gated by pause | same |
| 11 | Claim of an LP-funded claim entry (owner = LP or receiver) | claim entry with active op (+8 B) + claim op 227 B | that entry's slot stake | **No** | same |
| 12 | Pool epoch reset after a write-off | stale entry from the old epoch | `release_stale_share_entry(epoch)` returns the full stake | **No** | **T-08 (new assertion)** |
| 13 | Exit that itself triggers an epoch reset | the op carries its epoch; the callback finds the entry under that epoch and releases it | — | **No** | code path in `exit_pool_shares` / `maybe_release_share_entry` |

**Conclusion:** no withdrawal or failed-transfer path requires NEAR beyond the mandatory **1 yoctoNEAR** that `withdraw` and `redeem` already require (NEAR's standard security deposit, spec §6.1). This holds while paused.

**Residual exposure:** if `on_payout_complete` for an LP's exit fails to execute (FC-03), that LP's exit lock stays set. The LP cannot start another exit until the stuck-operation governance path exists. This is the FC-03 limitation already documented, applied to the per-LP lock (§9).

---

## 5. Item 4 — Storage-Credit Registration and the Deleted-Account Refund

### The problem in Revision 4

The registration refund was a plain transfer with no callback. If the account was deleted first, the 0.007 NEAR would have bounced back to the contract as **unattributed balance** — a loss of user funds.

### Revision 5 fix

The refund is now a **tracked** native transfer: a `PendingNearOp` with `registration_refund = true`, protected by the account's withdrawal lock.

| Step | Behaviour |
| :--- | :--- |
| Start | Triggered after a successful withdrawal that leaves the balance at 0, or by `storage_withdraw(None)` at balance 0. The registration moves to `total_inflight_registration`. **The record is kept.** |
| Success | The record is removed (`StorageUnregistered`). If a deposit arrived during the flight, the record is kept instead and its registration re-taken from that new balance (`StorageRegistered`). It stays refundable. |
| Failure (e.g. deleted account) | The registration is restored to the record (`StorageRegistrationRefundFailed`). **No loss and nothing unattributed.** Once the account name is re-created, `storage_withdraw(None)` retries. |
| Balance-withdrawal failure | Unchanged: the amount is restored additively, and the record and registration stay. |
| Concurrent operations | One storage operation in flight per account. Deposits during any flight are added to the balance. |

**Test:** `test_registration_refund_failure_restores_funds` covers:

- a failed refund restoring the registration;
- the lock clearing;
- the retry;
- a deposit during the retry flight;
- totals reconciling to the yoctoNEAR.

**Remaining edge cases (disclosed):**

- **Short unfunded window.** While a registration refund is in flight (≤ 2 blocks, at most one per account), its 409 B of records briefly sit on the contract balance, because the registration NEAR is in transit. The alternative design risked losing user funds, so this short window was chosen deliberately. If the transfer fails, the NEAR returns automatically.
- **Name never re-created.** If a deleted account's name is never re-created, its recorded funds remain **attributed** to that name but cannot be withdrawn, because no admin recovery path exists (by design: no admin attestation). That is not a loss of accounting, but the funds stay locked.

---

## 6. Item 5 — GitHub Actions

### Changes

1. **New `.github/workflows/near-contracts.yml`** — a standalone workflow containing only the NEAR job.
   - **Triggers:**
     - `workflow_dispatch` (manual: Actions → "NEAR contracts" → Run workflow, choosing the branch);
     - `push` to `main` or `feat/near-*` **only when `near/**` or the workflow file changes**;
     - `pull_request` touching the same paths.
   - **Steps on `ubuntu-latest` (60-minute timeout):**
     1. checkout
     2. Rust stable + `wasm32-unknown-unknown`
     3. `rust-cache`
     4. `cargo check --locked --workspace --exclude sandbox-tests --target wasm32-unknown-unknown`
     5. `cargo test --locked -p snapfall-core -p snapfall-audit --lib -- --nocapture`
     6. `bash ./scripts/package-production-wasm.sh`
     7. build `mock-ft`, `withdraw-helper` and the fail-callback core, then restore the production core
     8. **`cargo test -p sandbox-tests -- --nocapture --test-threads=1`**
   - It has `contents: read` permission only, no secrets, and no deployment.
2. **`.github/workflows/ci.yml` restored** to the committed original (`git restore`). The Revision 3/4 NEAR job and the extra `feat/near-*` / `workflow_dispatch` triggers were removed from it.
   - `ci.yml` (Foundry, daemon, sidecar, dashboard, secret audit) runs only on `push` to `main` and on `pull_request`.
   - **Pushing `feat/near-phase-1-contracts` therefore triggers only "NEAR contracts".**
   - Opening a pull request would also trigger `ci.yml`. Run the NEAR workflow manually instead of opening a PR if you want to avoid that.
3. **Reproducibility fixes:**
   - `near/Cargo.lock` is now **tracked** (it was git-ignored), and CI uses `--locked`, so CI builds the exact dependency versions verified here.
   - `package-production-wasm.sh` now runs the verifier via `bash`, so it works without an executable bit.

---

## 7. Item 6 — SnowMoon Migration (prepared, NOT executed)

### Verified current state

| Item | Value |
| :--- | :--- |
| Branch | `feat/near-phase-1-contracts` |
| `HEAD` | `1d5a188` |
| Remotes | `origin → https://github.com/gnanam1990/snapfall` (fetch and push) — **unchanged** |
| Modified (tracked) | `.gitignore` (+8) |
| Untracked | `.github/workflows/near-contracts.yml`, `docs/reports/PHASE_1_IMPLEMENTATION_REPORT.md`, `near/` (29 paths plus the now-tracked `near/Cargo.lock`) |
| Ignored (will not be committed) | `near/target/`, `near/artifacts/` |
| Commits / stashes | none / none |

> [!WARNING]
> **Decide on history before pushing.** The branch is based on the original Snapfall repository's history (`1d5a188` and everything before it: Solidity contracts, daemon, sidecar, dashboard). Pushing this branch to SnowMoon would copy that **entire history and codebase** into your repository. Confirm with your friend that this is acceptable (ownership and licence). If not, use Option B below.

### Option A — push the branch with its full history

Only after your approval:

```powershell
git branch --show-current          # expect: feat/near-phase-1-contracts
git status --short                 # review the exact file list
git add .gitignore .github/workflows/near-contracts.yml docs/reports/PHASE_1_IMPLEMENTATION_REPORT.md near/
git status --short                 # confirm: no near/target, no near/artifacts
git commit -m "feat(near): SnowMoon NEAR Phase 1 contracts, tests and NEAR-only CI"
git remote add zax https://github.com/zaxcrypto/SnowMoon.git
git remote -v                      # origin must still be gnanam1990/snapfall; zax = SnowMoon
git push -u zax feat/near-phase-1-contracts
```

### Option B — clean SnowMoon history with only the NEAR work

Only after your approval:

```powershell
git switch --orphan snowmoon/phase-1
git rm -r --cached . -q            # start the new history empty (working files stay on disk)
git add near/ .github/workflows/near-contracts.yml docs/reports/PHASE_1_IMPLEMENTATION_REPORT.md docs/reports/PHASE_0_7_1_FINAL_ARCHITECTURE_SPECIFICATION.md
git commit -m "feat(near): SnowMoon NEAR Phase 1 contracts, tests and NEAR-only CI"
git remote add zax https://github.com/zaxcrypto/SnowMoon.git
git push -u zax snowmoon/phase-1
```

For Option B the workflow's `push` filter covers `main` and `feat/near-*`. Either name the pushed branch to match one of those, or use the manual `workflow_dispatch` trigger.

Neither option touches `origin`. **Neither has been run.**

---

## 8. Files Changed in Revision 5

| File | Change |
| :--- | :--- |
| `near/contracts/snapfall-core/src/lib.rs` | SnowMoon domain separator; `total_inflight_registration` field and view |
| `near/contracts/snapfall-core/src/types.rs` | `PendingNearOp.registration_refund`; `AccountingView.total_inflight_registration` |
| `near/contracts/snapfall-core/src/storage_credits.rs` | Tracked registration refund (`start_registration_refund`, `resolve_registration_refund`); untracked refund removed |
| `near/contracts/snapfall-core/src/tests.rs` | New deleted-account test; full-exit test resolves the tracked refund; namespace and determinism vector; T-08 stale-epoch stake recovery |
| `.github/workflows/near-contracts.yml` | **New** standalone NEAR workflow (`--locked`) |
| `.github/workflows/ci.yml` | **Restored** to the committed original |
| `near/.gitignore` | `Cargo.lock` now tracked |
| `near/scripts/package-production-wasm.sh` | Runs the verifier via `bash` |
| `docs/reports/PHASE_1_IMPLEMENTATION_REPORT.md` | This report |

Cumulative Phase 1 files: all of `near/` (contracts `snapfall-core`, `snapfall-audit`, `mock-ft`, `withdraw-helper`; `sandbox-tests`; scripts; workspace), `.gitignore`, `.github/workflows/near-contracts.yml`, and this report.

---

## 9. Unresolved Risks

1. **0/10 Sandbox tests executed.** Phase 1 cannot be called complete until they run green on Linux.
2. **FC-03 stuck callbacks:** a failed `on_payout_complete` or `on_storage_withdraw_complete` keeps that operation's lock (job, LP exit, claim or storage withdrawal). There is no on-chain recovery in Phase 1, and a reviewed, timelocked path is required before Mainnet.
3. **Registration-refund flight window:** ≤ 409 B, ≤ 2 blocks, at most one per account. During it, those bytes sit briefly on the contract balance (§5).
4. **Deleted-account funds** remain attributed but unwithdrawable unless the name is re-created (§5).
5. **LP limits:**
   - one exit in flight per LP;
   - an external exit is refused while an earlier failed external payout is unclaimed (an exit to self is always available).
6. **Repository history and licence** if Option A is used (§7).
7. **Not yet reviewed against live services:** OutLayer and NEAR Intents (Phases 2 and 4). Phase 2 also needs the daemon changes for contract-generated job IDs.
8. **This is not an independent security audit.**

---

## 10. Next Action Requiring Owner Approval

**Approve one migration option from §7** (A: push with full history; B: clean NEAR-only history), plus the commit and push to `https://github.com/zaxcrypto/SnowMoon.git`. Then:

1. Run the **"NEAR contracts"** workflow (it starts automatically on push, or manually via `workflow_dispatch`).
2. Collect the log, the 10 Sandbox test names with pass or fail, and the step exit codes, and add them to this report.

Phase 1 is complete only when all 10 Sandbox tests pass.

No Testnet or Mainnet deployment, real USDC, wallet transactions, OutLayer, Intents or Supabase calls were made.
