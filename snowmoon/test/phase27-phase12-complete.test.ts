import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { SupabaseDatabaseAdapter } from "../src/persistence.ts";
import {
  calculateSnowMoonAdvanceMath,
  evaluateFloatAdvanceEligibility,
  FloatPoolAdvanceOrchestrator,
} from "../src/float_pool.ts";
import {
  computeFinancialDestinationAudit,
  SettlementEngine,
  validateJobDeadlineSeconds,
} from "../src/settlement.ts";
import { DeterministicSpendingPolicyEngine } from "../src/spending_policy.ts";
import { NEAR_X402_SCHEME, NearX402PaymentAdapter } from "../src/x402_near.ts";
import { DeliverableVault } from "../src/deliverables.ts";
import { NearAiBrainOrchestrator } from "../src/brain_audit.ts";
import { MonitoringService } from "../src/monitoring.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

const JOB_ID_1 = "0x" + "11".repeat(32);
const JOB_ID_2 = "0x" + "22".repeat(32);
const USDC_MAINNET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("Phase 12.1 (Task 1): Migration 004 search_path hardening & Supabase row-vs-kv parity verification", async () => {
  const sqlPath = path.resolve(process.cwd(), "migrations", "004_row_level_persistence.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  assert.match(sql, /SET search_path = public, pg_temp/);

  const kvData: Record<string, unknown[]> = {
    customers: [{ accountId: "alice.near" }],
    workers: [],
    workforceJobs: [{ jobId: JOB_ID_1 }],
    escrowJobs: [],
    intents: [],
    outlayerCalls: [],
    verifications: [],
    settlements: [],
    walletChallenges: [],
  };

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("snowmoon_kv_collections")) {
      const m = url.match(/collection_key=eq\.([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : "";
      return new Response(JSON.stringify([{ payload: kvData[key] || [] }]), { status: 200 });
    }
    if (url.includes("snowmoon_customers")) {
      return new Response(JSON.stringify([{ account_id: "alice.near", payload: { accountId: "alice.near" } }]), { status: 200 });
    }
    if (url.includes("snowmoon_workforce_jobs")) {
      return new Response(JSON.stringify([{ job_id: JOB_ID_1, payload: { jobId: JOB_ID_1 } }]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const adapter = new SupabaseDatabaseAdapter("https://example.supabase.co", "sb_secret", undefined, mockFetch, "dual");
  const parity = await adapter.verifyRowVsKvParity();
  assert.equal(parity.parityOk, true);
  assert.equal(parity.mismatches.length, 0);
});

test("Phase 12.2 (Task 3): FloatPool advance math (100 USDC -> 50 USDC), eligibility caps & RPC-timeout reconciliation", async () => {
  const math = calculateSnowMoonAdvanceMath("100000000", 5000);
  assert.equal(math.principalAtomic, "50000000"); // 50 USDC
  assert.equal(math.feeAtomic, "1000000"); // 2% = 1 USDC
  assert.equal(math.reserveCutAtomic, "200000"); // 20% of fee = 0.2 USDC
  assert.equal(math.lpYieldAtomic, "800000"); // 80% of fee = 0.8 USDC

  // Self-funded operator job rejected
  const selfFunded = evaluateFloatAdvanceEligibility({
    jobId: JOB_ID_1,
    customerAccountId: "op.near",
    operatorAccountId: "op.near",
    customerPaymentAtomic: "100000000",
    onChainJobStatus: "Funded",
    escrowConfirmed: true,
    rateBps: 5000,
    pool: {
      poolPaused: false,
      totalAssetsAtomic: "1000000000",
      totalOutstandingAtomic: "0",
      totalWrittenOffAtomic: "0",
      reserveAtomic: "0",
      maxAdvanceAtomic: "100000000",
      maxTotalExposureAtomic: "800000000",
    },
  });
  assert.equal(selfFunded.eligible, false);
  assert.ok(selfFunded.reasons.some((r) => r.includes("ERR_SELF_FUNDED_OPERATOR_JOB")));

  // 10% org exposure cap enforced
  const orgCapExceeded = evaluateFloatAdvanceEligibility({
    jobId: JOB_ID_1,
    customerAccountId: "alice.near",
    operatorAccountId: "op.near",
    customerPaymentAtomic: "100000000",
    onChainJobStatus: "Funded",
    escrowConfirmed: true,
    rateBps: 5000,
    orgOutstandingAtomic: "60000000", // 60 + 50 = 110 > 10% of 1000 USDC
    pool: {
      poolPaused: false,
      totalAssetsAtomic: "1000000000",
      totalOutstandingAtomic: "60000000",
      totalWrittenOffAtomic: "0",
      reserveAtomic: "0",
      maxAdvanceAtomic: "100000000",
      maxTotalExposureAtomic: "800000000",
    },
  });
  assert.equal(orgCapExceeded.eligible, false);
  assert.ok(orgCapExceeded.reasons.some((r) => r.includes("ERR_ORG_CAP_EXCEEDED")));

  // RPC-timeout recovery: if on-chain get_advance already shows Issued, reconcile without preparing duplicate
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_DB_BACKEND: "json" });
  const rpc = new NearMainnetRpcAdapter(cfg);
  rpc.callViewMethod = (async (_contract: string, method: string) => {
    if (method === "get_job") {
      return { ok: true, data: { customer: "alice.near", operator: "cryptozax.near", customer_payment: "100000000", status: "Funded" } };
    }
    if (method === "accounting") {
      return {
        ok: true,
        data: {
          pool_paused: false,
          total_assets: "1000000000",
          total_outstanding: "50000000",
          total_written_off: "0",
          reserve: "0",
          max_advance: "100000000",
          max_total_exposure: "800000000",
        },
      };
    }
    if (method === "get_advance") {
      return {
        ok: true,
        data: {
          job_id: JOB_ID_1,
          operator_org: "cryptozax.near",
          principal: "50000000",
          fee: "1000000",
          rate_bps: 5000,
          opened_at: 1700000000,
          status: "Issued",
        },
      };
    }
    return { ok: true, data: 5000 };
  }) as typeof rpc.callViewMethod;

  const orch = new FloatPoolAdvanceOrchestrator();
  const rec = await orch.evaluateAndPrepareFromChain(cfg, rpc, {
    jobId: JOB_ID_1,
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    escrowConfirmed: true,
  });
  assert.equal(rec.status, "ISSUED");
  assert.equal(rec.onChainConfirmed, true);
  assert.equal(rec.preparedTx, undefined);
});

test("Phase 12.3 (Task 4 & Task 5): Deterministic SpendingPolicy + NEAR x402 adapter rejects EIP-3009 and verifies finality", async () => {
  const policy = new DeterministicSpendingPolicyEngine();
  let settledCalled = 0;
  let finalityOk = true;
  const x402 = new NearX402PaymentAdapter(policy, {
    async executeNep141Transfer() {
      settledCalled += 1;
      return { txHash: "5".repeat(44) };
    },
    async verifyNep141TransferFinality() {
      return finalityOk ? { confirmed: true } : { confirmed: false, reason: "tx failed on-chain" };
    },
  });

  // Reject EVM EIP-3009 requirement
  assert.throws(
    () =>
      x402.validateRequirement({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        resource: "https://example.com/data",
        payTo: "merchant.near",
        asset: USDC_MAINNET,
        maxAmountRequiredAtomic: "50000",
        maxTimeoutSeconds: 60,
      }),
    /ERR_EVM_EIP3009_NOT_SUPPORTED_ON_NEAR/
  );

  // Journey D: <= $0.10 auto-approved, settled & deduplicated on retry
  const evalSmall = x402.evaluate402Requirement({
    jobId: JOB_ID_1,
    taskId: "task-1",
    workerId: "w-1",
    merchant: "x402.snowmoon.near",
    category: "data-feed",
    requirement: {
      x402Version: 2,
      scheme: NEAR_X402_SCHEME,
      network: "near-mainnet",
      resource: "https://x402.snowmoon.near/price",
      payTo: "x402.snowmoon.near",
      asset: USDC_MAINNET,
      maxAmountRequiredAtomic: "50000",
      maxTimeoutSeconds: 60,
    },
  });
  assert.equal(evalSmall.evaluation.decision, "AUTO_APPROVE");
  const r1 = await x402.payAndVerify({
    intent: evalSmall.intent,
    payerAccountId: "cryptozax.near",
    resourceUrl: "https://x402.snowmoon.near/price",
  });
  const r2 = await x402.payAndVerify({
    intent: evalSmall.intent,
    payerAccountId: "cryptozax.near",
    resourceUrl: "https://x402.snowmoon.near/price",
  });
  assert.equal(r1.txHash, r2.txHash);
  assert.equal(settledCalled, 1);

  // > $0.10 requires human approval; mutating amount after approval invalidates it
  const evalLarge = x402.evaluate402Requirement({
    jobId: JOB_ID_1,
    taskId: "task-2",
    workerId: "w-1",
    merchant: "x402.snowmoon.near",
    category: "data-feed",
    requirement: {
      x402Version: 2,
      scheme: NEAR_X402_SCHEME,
      network: "near-mainnet",
      resource: "https://x402.snowmoon.near/premium",
      payTo: "x402.snowmoon.near",
      asset: USDC_MAINNET,
      maxAmountRequiredAtomic: "250000",
      maxTimeoutSeconds: 60,
    },
  });
  assert.equal(evalLarge.evaluation.decision, "HUMAN_APPROVAL_REQUIRED");
  await assert.rejects(
    () =>
      x402.payAndVerify({
        intent: evalLarge.intent,
        payerAccountId: "cryptozax.near",
        resourceUrl: "https://x402.snowmoon.near/premium",
      }),
    /ERR_HUMAN_APPROVAL_REQUIRED/
  );
  policy.approveByHuman(evalLarge.intent.intentId, "alice.near");
  // Mutating amount invalidates approval
  await assert.rejects(
    () =>
      x402.payAndVerify({
        intent: { ...evalLarge.intent, amountAtomic: "300000" },
        payerAccountId: "cryptozax.near",
        resourceUrl: "https://x402.snowmoon.near/premium",
      }),
    /ERR_INTENT_MUTATION_INVALIDATES_APPROVAL/
  );
  // Failed finality releases reservation
  finalityOk = false;
  await assert.rejects(
    () =>
      x402.payAndVerify({
        intent: evalLarge.intent,
        payerAccountId: "cryptozax.near",
        resourceUrl: "https://x402.snowmoon.near/premium",
      }),
    /ERR_X402_SETTLEMENT_UNCONFIRMED/
  );
  assert.equal(policy.getJobReservedAtomic(JOB_ID_1), "50000");
});

test("Phase 12.4 (Task 6): DeliverableVault restricts preview and gates full download strictly behind SETTLED + ownership", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-deliv-"));
  const vault = new DeliverableVault(dir, "test-deliverable-secret");
  const fullContent = Buffer.from(
    [
      "# Full Security Audit Report",
      "Line 2: Summary",
      "Line 3: Scope",
      "Line 4: Methodology",
      "Line 5: Finding 1",
      "Line 6: Finding 2",
      "Line 7: SECRET_FULL_REMEDIATION_PAYLOAD_ONLY_AFTER_SETTLEMENT",
      "Line 8: Appendix",
    ].join("\n"),
    "utf8"
  );

  const rec = vault.storeDeliverable({
    jobId: JOB_ID_1,
    customerAccountId: "alice.near",
    filename: "audit-report.md",
    mimeType: "text/markdown",
    content: fullContent,
  });

  const preview = vault.getCustomerPreview(JOB_ID_1, "alice.near");
  assert.equal(preview.fullDownloadUnlocked, false);
  assert.equal(preview.previewText.includes("SECRET_FULL_REMEDIATION_PAYLOAD_ONLY_AFTER_SETTLEMENT"), false);

  // Wrong customer cannot preview
  assert.throws(() => vault.getCustomerPreview(JOB_ID_1, "bob.near"), /ERR_CUSTOMER_OWNERSHIP_REQUIRED/);

  // Cannot issue download token before SETTLED
  assert.throws(
    () =>
      vault.issueSignedDownloadToken({
        jobId: JOB_ID_1,
        customerAccountId: "alice.near",
        jobState: "DELIVERED",
        settlementConfirmed: false,
        settlementKind: "PAYOUT_ACCEPT_DELIVERY",
      }),
    /ERR_SETTLEMENT_REQUIRED_FOR_UNLOCK/
  );

  // Once SETTLED + confirmed, token works for alice.near, fails for bob.near, fails when expired
  const now = 1_700_000_000_000;
  const issued = vault.issueSignedDownloadToken({
    jobId: JOB_ID_1,
    customerAccountId: "alice.near",
    jobState: "SETTLED",
    settlementConfirmed: true,
    settlementKind: "PAYOUT_ACCEPT_DELIVERY",
    ttlSeconds: 60,
    nowMs: now,
  });

  const dl = vault.verifyAndReadFullDeliverable({
    token: issued.token,
    callerCustomerAccountId: "alice.near",
    jobState: "SETTLED",
    settlementConfirmed: true,
    nowMs: now + 5_000,
  });
  assert.equal(dl.content.toString("utf8").includes("SECRET_FULL_REMEDIATION_PAYLOAD_ONLY_AFTER_SETTLEMENT"), true);
  assert.equal(dl.record.deliverableId, rec.deliverableId);

  assert.throws(
    () =>
      vault.verifyAndReadFullDeliverable({
        token: issued.token,
        callerCustomerAccountId: "bob.near",
        jobState: "SETTLED",
        settlementConfirmed: true,
        nowMs: now + 5_000,
      }),
    /ERR_CUSTOMER_OWNERSHIP_REQUIRED/
  );
  assert.throws(
    () =>
      vault.verifyAndReadFullDeliverable({
        token: issued.token,
        callerCustomerAccountId: "alice.near",
        jobState: "SETTLED",
        settlementConfirmed: true,
        nowMs: now + 120_000,
      }),
    /ERR_DOWNLOAD_TOKEN_EXPIRED/
  );
});

test("Phase 12.5 (Task 7 & Task 8): No-delivery refund, deadline bounds & FinancialDestinationAudit waterfall", () => {
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_DB_BACKEND: "json" });
  const se = new SettlementEngine();

  // Deadline rejects milliseconds
  assert.throws(() => validateJobDeadlineSeconds(Date.now() + 3_600_000, 1_700_000_000), /ERR_DEADLINE_MILLISECONDS_REJECTED/);
  assert.throws(() => validateJobDeadlineSeconds(1_700_000_000 + 91 * 86400, 1_700_000_000), /ERR_DEADLINE_TOO_FAR/);

  // 100 USDC + 50 USDC advance acceptance waterfall
  const payoutAudit = computeFinancialDestinationAudit({
    kind: "PAYOUT_ACCEPT_DELIVERY",
    tokenContract: USDC_MAINNET,
    coreContractId: "core.cryptozax.near",
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    grossAmountAtomic: "100000000",
    floatPrincipalAtomic: "50000000",
    floatFeeAtomic: "1000000",
  });
  assert.equal(payoutAudit.floatPrincipalRepaidAtomic, "50000000");
  assert.equal(payoutAudit.reserveCutAtomic, "200000");
  assert.equal(payoutAudit.lpYieldAtomic, "800000");
  assert.equal(payoutAudit.operatorNetAtomic, "49000000"); // 100 - 51 = 49 USDC

  // No-delivery refund without VerificationEngine submission
  assert.throws(
    () =>
      se.prepareRefund(cfg, {
        jobId: JOB_ID_2,
        refundReason: "NO_DELIVERY_EXPIRED",
        jobState: "FUNDED",
        customerAccountId: "alice.near",
        operatorAccountId: "cryptozax.near",
        grossAmountAtomic: "100000000",
        deadlineSec: 2000,
        nowSec: 1500,
        callerIsOperatorOrAdmin: false,
      }),
    /ERR_DEADLINE_NOT_REACHED/
  );

  const refund = se.prepareRefund(cfg, {
    jobId: JOB_ID_2,
    refundReason: "NO_DELIVERY_EXPIRED",
    jobState: "FUNDED",
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    grossAmountAtomic: "100000000",
    deadlineSec: 2000,
    nowSec: 2001,
    callerIsOperatorOrAdmin: false,
    floatPrincipalAtomic: "50000000",
  });
  assert.equal(refund.kind, "CUSTOMER_REFUND");
  assert.equal(refund.financialAudit?.customerRefundAtomic, "100000000");
  assert.equal(refund.financialAudit?.writeOffLossAtomic, "50000000");
  assert.equal(refund.financialAudit?.operatorNetAtomic, "0");
});

test("Phase 12.6 (Task 9 & Task 12): NEAR AI Brain Rust audit tooling, Monitoring redaction & bounded history pagination", async () => {
  const brain = new NearAiBrainOrchestrator();
  const contractSrcDir = path.resolve(process.cwd(), "..", "near", "contracts", "snapfall-core", "src");
  const audit = brain.executeRustContractAudit({
    jobId: JOB_ID_1,
    contractSrcDir,
    aiCandidateFindings: [
      {
        filePath: "vault.rs",
        line: 12,
        symbol: "MAX_JOB_DURATION_SEC",
        severity: "INFO",
        description: "Verified max duration constant exists",
      },
      {
        filePath: "vault.rs",
        line: 12,
        symbol: "NON_EXISTENT_SYMBOL",
        severity: "HIGH",
        description: "Hallucinated finding",
      },
    ],
    teeAttested: false,
  });
  assert.equal(audit.plan.classification, "smart-contract-audit");
  assert.equal(audit.teeAttested, false);
  assert.equal(audit.independentlyAudited, false);
  assert.ok(audit.toolChecksExecuted.every((t) => t.passed));
  assert.ok(audit.findings.some((f) => f.symbol === "MAX_JOB_DURATION_SEC" && f.verificationStatus === "CONFIRMED"));
  assert.ok(audit.findings.some((f) => f.symbol === "NON_EXISTENT_SYMBOL" && f.verificationStatus === "LIKELY"));

  const mon = new MonitoringService();
  const alert = mon.record("RPC_ERROR", "WARN", "Failed with sk-secret-token-1234567890", JOB_ID_1);
  assert.equal(alert.message.includes("1234567890"), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p12-http-"));
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_DB_BACKEND: "json",
      SNOWMOON_DATA_DIR: tmpDir,
      WALLET_SESSION_SECRET: "phase12-test-secret",
    })
  );
  const server = app.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  try {
    const histRes = await fetch(`${baseUrl}/api/settlement/history?limit=999&cursor=0`);
    assert.equal(histRes.status, 200);
    const histJson = (await histRes.json()) as { ok: boolean; limit: number; history: unknown[] };
    assert.equal(histJson.ok, true);
    assert.equal(histJson.limit, 100); // Clamped to max 100

    const monRes = await fetch(`${baseUrl}/api/monitoring/health`);
    assert.equal(monRes.status, 200);
    const monJson = (await monRes.json()) as { ok: boolean; monitoring: { counters: Record<string, number> } };
    assert.equal(monJson.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
