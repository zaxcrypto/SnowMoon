import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import {
  deriveJobId,
  JOB_STORAGE_DEPOSIT_INITIAL,
  SnowMoonEngine,
} from "../src/engine.ts";
import { AIWorkerAdapter, OutLayerPolicyAdapter } from "../src/adapters.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("1. Contract-derived Job ID matches snowmoon-core/job-id/v1 deterministic scheme", () => {
  const id0 = deriveJobId("customer.snowmoon.test.near", 0);
  const id1 = deriveJobId("customer.snowmoon.test.near", 1);
  assert.match(id0, /^0x[0-9a-f]{64}$/);
  assert.match(id1, /^0x[0-9a-f]{64}$/);
  assert.notEqual(id0, id1);
});

test("2. Unfunded Created job cancellation deletes record and refunds 100% of 0.023 NEAR deposit", () => {
  const config = loadConfig();
  const engine = new SnowMoonEngine(config);

  const beforeCredit = engine.storageCreditsYocto.get(config.customerAccountId)!;
  const availBefore = beforeCredit.available;

  const job = engine.createJob({
    creator: config.customerAccountId,
    customer: config.customerAccountId,
    operator: config.operatorAccountId,
    title: "Cancelable Unfunded Job",
    taskDescription: "Verify AUD-01 & Decision 2 Option A cancel storage refund",
    customerPaymentUsdc: 50_000_000n,
    maxOperatingBudgetUsdc: 10_000_000n,
  });

  const midCredit = engine.storageCreditsYocto.get(config.customerAccountId)!;
  assert.equal(
    availBefore - midCredit.available,
    BigInt(JOB_STORAGE_DEPOSIT_INITIAL)
  );

  const cancelRes = engine.cancelJob(job.jobId, config.customerAccountId);
  assert.equal(cancelRes.refundedStorageYocto, JOB_STORAGE_DEPOSIT_INITIAL);
  assert.equal(engine.jobs.has(job.jobId), false);

  const afterCredit = engine.storageCreditsYocto.get(config.customerAccountId)!;
  assert.equal(afterCredit.available, availBefore);
  assert.equal(afterCredit.locked, 0n);
});

test("3. OutLayer Policy Adapter enforces auto-approval (<= $0.10), escalation (> $0.10), budget cap, and post-approval substitution guard", () => {
  const config = loadConfig();
  const engine = new SnowMoonEngine(config);
  const policy = new OutLayerPolicyAdapter(config, engine);

  const job = engine.createJob({
    creator: config.customerAccountId,
    customer: config.customerAccountId,
    operator: config.operatorAccountId,
    title: "Policy Guard Test Job",
    taskDescription: "Verify micro-spend, escalated spend, and substitution guard",
    customerPaymentUsdc: 100_000_000n, // $100.00
    maxOperatingBudgetUsdc: 10_000_000n, // $10.00
    fundImmediately: true,
  });

  // 3a: $0.04 micro-spend -> AUTO_APPROVED
  const r1 = policy.requestSpend({
    jobId: job.jobId,
    caller: config.operatorAccountId,
    vendor: "NEAR Lake Indexer API",
    description: "Micro telemetry query",
    amountUsdc: 40_000n,
  });
  assert.equal(r1.action, "AUTO_APPROVED");
  assert.equal(job.operatingSpent, "40000");

  // 3b: $4.00 dataset spend -> ESCALATED_TO_HUMAN
  const r2 = policy.requestSpend({
    jobId: job.jobId,
    caller: config.operatorAccountId,
    vendor: "Kaiko Institutional Feed",
    description: "Orderbook dataset",
    amountUsdc: 4_000_000n,
  });
  assert.equal(r2.action, "ESCALATED_TO_HUMAN");
  assert.ok(r2.approval);

  // 3c: Post-approval substitution attempt must fail
  assert.throws(() => {
    policy.decideApproval({
      approvalId: r2.approval!.approvalId,
      decidedBy: config.operatorAccountId,
      decision: "APPROVE",
      verifyVendor: "MaliciousUnapprovedVendor",
      verifyAmountUsdc: 4_000_000n,
    });
  }, /ERR_POST_APPROVAL_SUBSTITUTION_DETECTED/);

  // 3d: Genuine approval succeeds and records expense
  const approved = policy.decideApproval({
    approvalId: r2.approval!.approvalId,
    decidedBy: config.operatorAccountId,
    decision: "APPROVE",
  });
  assert.equal(approved.approval.status, "APPROVED");
  assert.equal(job.operatingSpent, "4040000");

  // 3e: Over-budget spend ($20.00 > remaining $5.96) -> DENIED_FALLBACK
  const r3 = policy.requestSpend({
    jobId: job.jobId,
    caller: config.operatorAccountId,
    vendor: "Expensive Vendor",
    description: "Exceeds max_operating_budget",
    amountUsdc: 20_000_000n,
  });
  assert.equal(r3.action, "DENIED_FALLBACK");
});

test("4. Complete 12-Step Customer-to-Settlement-to-Audit Journey via HTTP API", async () => {
  const config = loadConfig();
  const app = createSnowMoonApp(config);

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const resp = await fetch(`${baseUrl}/api/demo/run-complete-journey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(resp.status, 200);
    const data = (await resp.json()) as {
      ok: boolean;
      jobId: string;
      stepsLog: Array<{ step: number; title: string; detail: string }>;
      job: {
        state: string;
        anchored: boolean;
        operatingSpent: string;
        deliveryHash: string;
        settlement: {
          customerPaymentUsdc: string;
          poolRepaymentTotalUsdc: string;
          principalRepaidUsdc: string;
          feePaidUsdc: string;
          operatorNetUsdc: string;
        };
      };
      anchor: {
        verifiedFromCore: boolean;
        deliveryHash: string;
      };
      state: {
        floatPool: {
          totalAssetsUsdc: string;
          totalOutstandingUsdc: string;
        };
      };
    };

    assert.equal(data.ok, true);
    assert.equal(data.stepsLog.length, 12);
    assert.equal(data.job.state, "Accepted");
    assert.equal(data.job.anchored, true);
    assert.equal(data.job.operatingSpent, "4040000"); // $4.04 USDC ($0.04 auto + $4.00 approved)
    assert.equal(data.job.settlement.customerPaymentUsdc, "100000000"); // $100.00
    assert.equal(data.job.settlement.principalRepaidUsdc, "20000000"); // $20.00 advance principal
    assert.equal(data.job.settlement.feePaidUsdc, "400000"); // $0.40 advance fee (2%)
    assert.equal(data.job.settlement.poolRepaymentTotalUsdc, "20400000"); // $20.40 total to FloatPool
    assert.equal(data.job.settlement.operatorNetUsdc, "79600000"); // $79.60 net to operator
    assert.equal(data.anchor.verifiedFromCore, true);
    assert.equal(data.anchor.deliveryHash, data.job.deliveryHash);
    // FloatPool assets increased from $5,000.00 to $5,000.40 from advance fee yield, with $0 outstanding
    assert.equal(data.state.floatPool.totalAssetsUsdc, "5000400000");
    assert.equal(data.state.floatPool.totalOutstandingUsdc, "0");
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

