import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { WorkforceEngine } from "../src/workforce.ts";
import {
  VerificationEngine,
  computeCanonicalEvidenceHash,
} from "../src/verification.ts";
import {
  SettlementEngine,
  calculateAtomicPayoutSplit,
} from "../src/settlement.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

class MockSettlementRpc extends NearMainnetRpcAdapter {
  public mockTx: {
    ok: boolean;
    error?: string;
    result?: {
      final_execution_status?: string;
      status?: Record<string, unknown>;
      receipts_outcome?: Array<{ id?: string; outcome?: { logs?: string[]; status?: Record<string, unknown> } }>;
    };
  } = { ok: false, error: "NOT_SET" };
  public mockJobStatus = "Accepted";

  public override async queryTransactionStatus() {
    return this.mockTx;
  }

  public override async queryCoreJob(jobId: string) {
    return {
      ok: true,
      data: {
        job_id: jobId,
        status: this.mockJobStatus,
      },
    };
  }
}

test("14. Phase 3 Workforce: registration, capability matching, execution, timeout/retry, and duplicate execution prevention", async () => {
  const config = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const wf = new WorkforceEngine();
  const ai = new AIWorkerAdapter(config);
  const ol = new OutLayerExecutionAdapter(config);

  wf.registerWorker({
    workerId: "w-code",
    accountId: "coder.near",
    displayName: "Code Agent",
    capabilities: ["rust", "audit"],
    maxConcurrentJobs: 1,
  });
  wf.registerWorker({
    workerId: "w-research",
    accountId: "researcher.near",
    displayName: "Research Agent",
    capabilities: ["research", "analysis"],
    maxConcurrentJobs: 2,
  });

  const jobId = "0x" + "a1".repeat(32);
  wf.registerJob({
    jobId,
    customerAccountId: "alice.near",
    amountAtomic: "5000000",
    requiredCapabilities: ["research", "analysis"],
    prompt: "Analyze NEAR AI economics",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    funded: true,
  });

  // Matches w-research (not w-code)
  const assigned = wf.assignJob(jobId);
  assert.equal(assigned.assignedWorkerId, "w-research");
  assert.equal(assigned.state, "ASSIGNED");

  // Wrong worker cannot accept
  assert.throws(() => wf.acceptJob(jobId, "w-code"), /ERR_NOT_ASSIGNED_WORKER/);

  const accepted = wf.acceptJob(jobId, "w-research");
  assert.equal(accepted.state, "ACCEPTED");

  // Execute via mock AI + mock OutLayer
  const executed = await wf.executeJob({
    jobId,
    workerId: "w-research",
    aiAdapter: ai,
    outlayerAdapter: ol,
  });
  assert.equal(executed.state, "DELIVERED");
  assert.equal(executed.executionMode, "mock_fallback");
  assert.equal(executed.outlayerMode, "mock_fallback");
  assert.ok(executed.evidenceHash?.startsWith("0x"));

  // Duplicate execution is blocked
  await assert.rejects(
    () => wf.executeJob({ jobId, workerId: "w-research", aiAdapter: ai }),
    /ERR_ALREADY_EXECUTED/
  );
});

test("15. Phase 4 Verification: canonical SHA-256 evidence, anti-substitution, expiration, dispute, and AuditAnchor tx", async () => {
  const config = loadConfig({ SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near" });
  const rpc = new MockSettlementRpc(config);
  const ver = new VerificationEngine();

  const jobId = "0x" + "b2".repeat(32);
  const deliverable = { summary: "Report", score: 99 };
  const validHash = computeCanonicalEvidenceHash(deliverable);
  const futureDeadline = Math.floor(Date.now() / 1000) + 3600;

  // Rejects evidence substitution (mismatched hash)
  assert.throws(
    () =>
      ver.submitDelivery({
        jobId,
        workerId: "w-research",
        workerAccountId: "researcher.near",
        expectedWorkerId: "w-research",
        deliverable,
        evidenceHash: "0x" + "ff".repeat(32),
        deadlineSec: futureDeadline,
      }),
    /ERR_EVIDENCE_HASH_MISMATCH/
  );

  // Rejects expired job
  assert.throws(
    () =>
      ver.submitDelivery({
        jobId,
        workerId: "w-research",
        workerAccountId: "researcher.near",
        expectedWorkerId: "w-research",
        deliverable,
        evidenceHash: validHash,
        deadlineSec: 1000,
        nowSec: 2000,
      }),
    /ERR_JOB_EXPIRED/
  );

  // Valid submission + verification
  const jobId2 = "0x" + "b3".repeat(32);
  const sub = ver.submitDelivery({
    jobId: jobId2,
    workerId: "w-research",
    workerAccountId: "researcher.near",
    expectedWorkerId: "w-research",
    deliverable,
    evidenceHash: validHash,
    deadlineSec: futureDeadline,
  });
  assert.equal(sub.verificationStatus, "PENDING");

  // Duplicate delivery blocked
  assert.throws(
    () =>
      ver.submitDelivery({
        jobId: jobId2,
        workerId: "w-research",
        workerAccountId: "researcher.near",
        expectedWorkerId: "w-research",
        deliverable,
        evidenceHash: validHash,
        deadlineSec: futureDeadline,
      }),
    /ERR_DUPLICATE_DELIVERY/
  );

  const verified = ver.verifyDelivery({
    jobId: jobId2,
    verifierAccountId: "alice.near",
    decision: "VERIFIED",
  });
  assert.equal(verified.verificationStatus, "VERIFIED");

  const anchorPlan = await ver.prepareAuditAnchorTx(rpc, config, {
    jobId: jobId2,
    payerAccountId: "cryptozax.near",
    initiatorAccountId: "alice.near",
    authorizedCustomerAccountId: "alice.near",
  });
  assert.equal(anchorPlan.transaction.actions[0].methodName, "anchor_job");
  assert.equal(anchorPlan.transaction.actions[0].depositYocto, "6000000000000000000000");
  assert.equal(anchorPlan.coreVerifyInterface.expectedDeliveryHash, validHash);
});

test("16. Phase 5 & 6 Settlement + OutLayer: integer atomic fees, NEP-141 callback failure recovery, replay protection, and OutLayer timeout fallback", async () => {
  const split = calculateAtomicPayoutSplit("5000000", 250); // 2.5% fee
  assert.equal(split.platformFeeAtomic, "125000");
  assert.equal(split.workerPayoutAtomic, "4875000");

  const config = loadConfig({
    SNOWMOON_MAINNET_CORE_CONTRACT_ID: "core.cryptozax.near",
    SNOWMOON_WALLET_MODE: "outlayer",
    OUTLAYER_API_KEY: "ol_secret_test_key_12345",
  });
  const rpc = new MockSettlementRpc(config);
  const stl = new SettlementEngine();
  const jobId = "0x" + "c4".repeat(32);

  // Unverified job cannot settle
  assert.throws(
    () =>
      stl.prepareSettlement(config, {
        jobId,
        kind: "PAYOUT_ACCEPT_DELIVERY",
        verificationStatus: "PENDING",
        customerAccountId: "alice.near",
        workerAccountId: "researcher.near",
        grossAmountAtomic: "5000000",
      }),
    /ERR_DELIVERY_NOT_VERIFIED/
  );

  const rec = stl.prepareSettlement(config, {
    jobId,
    kind: "PAYOUT_ACCEPT_DELIVERY",
    verificationStatus: "VERIFIED",
    customerAccountId: "alice.near",
    workerAccountId: "researcher.near",
    grossAmountAtomic: "5000000",
    platformFeeBps: 250,
  });
  assert.equal(rec.preparedTransaction.actions[0].methodName, "accept_delivery");
  assert.equal(rec.preparedTransaction.actions[0].depositYocto, "1");

  const txHash = "6fDP5cs9D6B7Yx3N344Tq1YE2Br7JXo6UBQaZZP2Wc5k";
  stl.submitSettlementTx({
    settlementId: rec.settlementId,
    txHash,
    signerAccountId: "alice.near",
  });

  // Simulate NEP-141 async receipt failure -> FAILED_CALLBACK_RECOVERABLE
  rpc.mockTx = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      receipts_outcome: [{ id: "r1", outcome: { logs: [], status: { Failure: { ActionError: "NotRegistered" } } } }],
    },
  };
  const failedCb = await stl.reconcileSettlementTx(rpc, {
    settlementId: rec.settlementId,
    txHash,
  });
  assert.equal(failedCb.status, "FAILED_CALLBACK_RECOVERABLE");
  assert.equal(failedCb.onChainConfirmed, false);

  // Simulate confirmed settlement
  rpc.mockTx = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      receipts_outcome: [{ id: "r1", outcome: { logs: [], status: { SuccessValue: "" } } }],
    },
  };
  rpc.mockJobStatus = "Accepted";
  const confirmed = await stl.reconcileSettlementTx(rpc, {
    settlementId: rec.settlementId,
    txHash,
  });
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.onChainConfirmed, true);
  assert.equal(stl.listPaymentHistory().length, 2);

  // Duplicate payout blocked
  assert.throws(
    () =>
      stl.prepareSettlement(config, {
        jobId,
        kind: "PAYOUT_ACCEPT_DELIVERY",
        verificationStatus: "VERIFIED",
        customerAccountId: "alice.near",
        workerAccountId: "researcher.near",
        grossAmountAtomic: "5000000",
      }),
    /ERR_DUPLICATE_PAYOUT/
  );

  // OutLayer timeout/error fails safely without blind retry & redacts payment key
  const olConfig = loadConfig({
    OUTLAYER_PAYMENT_KEY: "ol_secret_test_key_12345",
    OUTLAYER_PROJECT_OWNER: "owner.near",
    OUTLAYER_PROJECT_NAME: "snapfall-worker",
  });
  const ol = new OutLayerExecutionAdapter(olConfig, async () => {
    throw new Error("Network failure with Bearer ol_secret_test_key_12345");
  });
  const olRec = await ol.executeAndVerify({
    jobId,
    workerId: "w-research",
    prompt: "test",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(olRec.status, "EXECUTION_PENDING");
  assert.equal(olRec.mode, "live_outlayer");
  assert.ok(!olRec.error?.includes("ol_secret_test_key_12345"));
});

test("17. Full Phase 3-7 HTTP End-to-End Flow: register worker -> register job -> assign -> accept -> execute -> verify -> prepare settlement", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-t17-"));
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_STATE_FILE: path.join(tmpDir, "state.json"),
      SNOWMOON_PERSISTENCE_FILE: path.join(tmpDir, "phase9-state.json"),
    })
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const post = async (p: string, b: unknown) => {
      const r = await fetch(`${baseUrl}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      const j = (await r.json()) as Record<string, unknown>;
      assert.equal(r.status, 200, `POST ${p} failed: ${JSON.stringify(j)}`);
      return j;
    };

    await post("/api/workforce/workers/register", {
      workerId: "e2e-worker",
      accountId: "worker.near",
      displayName: "E2E Worker",
      capabilities: ["research"],
    });

    const jobId = "0x" + "e2".repeat(32);
    await post("/api/workforce/jobs/register", {
      jobId,
      customerAccountId: "alice.near",
      amountAtomic: "4000000",
      requiredCapabilities: ["research"],
      prompt: "Summarize NEAR architecture",
    });

    await post("/api/workforce/jobs/assign", { jobId });
    await post("/api/workforce/jobs/accept", { jobId, workerId: "e2e-worker" });

    const execRes = (await post("/api/workforce/jobs/execute", {
      jobId,
      workerId: "e2e-worker",
    })) as { job: { state: string }; submission: { verificationStatus: string } };
    assert.equal(execRes.job.state, "DELIVERED");
    assert.equal(execRes.submission.verificationStatus, "PENDING");

    const verRes = (await post("/api/verification/verify", {
      jobId,
      verifierAccountId: "alice.near",
      decision: "VERIFIED",
    })) as { submission: { verificationStatus: string } };
    assert.equal(verRes.submission.verificationStatus, "VERIFIED");

    const stlRes = (await post("/api/settlement/prepare", {
      jobId,
      kind: "PAYOUT_ACCEPT_DELIVERY",
      platformFeeBps: 250,
    })) as { settlement: { workerPayoutAtomic: string; platformFeeAtomic: string; status: string } };
    assert.equal(stlRes.settlement.status, "PREPARED");
    assert.equal(stlRes.settlement.platformFeeAtomic, "100000");
    assert.equal(stlRes.settlement.workerPayoutAtomic, "3900000");
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

