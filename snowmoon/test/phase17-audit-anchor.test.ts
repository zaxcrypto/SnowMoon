import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { ANCHOR_STORAGE_DEPOSIT } from "../src/engine.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { SnowMoonRepository } from "../src/persistence.ts";
import { createSnowMoonApp } from "../src/server.ts";
import {
  VerificationEngine,
  computeCanonicalEvidenceHash,
} from "../src/verification.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase17-"));
}

test("37. Phase 17.1 Read-only Mainnet RPC verifies deployed audit.cryptozax.near contract state", async () => {
  const config = loadConfig();
  assert.equal(config.mainnetAuditContractId, "audit.cryptozax.near");
  assert.equal(config.mainnetCoreContractId, "core.cryptozax.near");
  assert.equal(config.mainnetAdminAccountId, "cryptozax.near");
  assert.equal(config.mainnetAuditOperatorAccountId, "cryptozax.near");

  const rpc = new NearMainnetRpcAdapter(config);
  const state = await rpc.inspectAuditContractState("audit.cryptozax.near");
  assert.equal(state.exists, true);
  assert.equal(state.hasContractCode, true);
  assert.equal(state.codeHash, "ACbfm2RGWE9oDHNvt8wKDRzdxAwtEAL6KtmWUZqmPoWg");
  assert.equal(state.initialized, true);
  assert.equal(state.coreContract, "core.cryptozax.near");
  assert.equal(state.operatorAuthority, "cryptozax.near");
  assert.equal(state.admin, "cryptozax.near");
  assert.equal(state.coreAuthorizedMatch, true);
  assert.equal(state.operatorMatchesConfig, true);
  assert.equal(state.adminMatchesConfig, true);

  const zeroAnchor = await rpc.queryAuditAnchor("0x" + "0".repeat(64), "audit.cryptozax.near");
  assert.equal(zeroAnchor.ok, true);
  assert.equal(zeroAnchor.data, null);
});

test("38. Phase 17.2 AuditAnchor tx prep enforces operator auth, 5-arg Rust ABI, duplicate guard, reconciliation & recovery", async () => {
  const dir = makeTempDir();
  const stateFile = path.join(dir, "db.json");
  const config = {
    ...loadConfig(),
    persistenceBackend: "json" as const,
    persistenceFile: stateFile,
  };
  const repo = new SnowMoonRepository(stateFile);
  const engine = new VerificationEngine(repo);

  const jobId = "0x" + "11".repeat(32);
  const deliverable = { report: "liquidity-audit-v1", ok: true };
  const evidenceHash = computeCanonicalEvidenceHash(deliverable);
  const futureDeadline = Math.floor(Date.now() / 1000) + 3600;

  engine.submitDelivery({
    jobId,
    workerId: "worker-1",
    workerAccountId: "worker1.near",
    expectedWorkerId: "worker-1",
    deliverable,
    evidenceHash,
    deadlineSec: futureDeadline,
  });
  engine.verifyDelivery({
    jobId,
    verifierAccountId: "customer.snowmoon.test.near",
    decision: "VERIFIED",
  });

  let onChainAnchorData: unknown = null;
  let mockTxResult: {
    ok: boolean;
    result?: {
      final_execution_status?: string;
      status: Record<string, unknown>;
      transaction: { hash: string; signer_id: string; receiver_id: string };
    };
    error?: string;
  } = { ok: false, error: "not indexed" };

  const fakeRpc = {
    probeAuditContract: async () => ({
      contractId: "audit.cryptozax.near",
      accountExists: true,
      hasContractCode: true,
      codeHash: "ACbfm2RGWE9oDHNvt8wKDRzdxAwtEAL6KtmWUZqmPoWg",
      deploymentStatus: "DEPLOYED_AND_INITIALIZED" as const,
    }),
    inspectAuditContractState: async () => ({
      contractId: "audit.cryptozax.near",
      exists: true,
      hasContractCode: true,
      codeHash: "ACbfm2RGWE9oDHNvt8wKDRzdxAwtEAL6KtmWUZqmPoWg",
      amountNear: "1.5000",
      storageUsageBytes: 131672,
      initialized: true,
      coreContract: "core.cryptozax.near",
      operatorAuthority: "cryptozax.near",
      admin: "cryptozax.near",
      pendingAdmin: null,
      adminTransferAcceptableAt: 0,
      nextAuditOpId: 1,
      totalAnchorStorageLockedYocto: "0",
      coreAuthorizedMatch: true,
      operatorMatchesConfig: true,
      adminMatchesConfig: true,
    }),
    queryAuditAnchor: async () => ({ ok: true, data: onChainAnchorData }),
    queryTransactionStatus: async () => mockTxResult,
  } as unknown as NearMainnetRpcAdapter;

  // Reject unauthorized operator signer
  await assert.rejects(
    () =>
      engine.prepareAuditAnchorTx(fakeRpc, config, {
        jobId,
        payerAccountId: "stranger.near",
      }),
    /ERR_NOT_OPERATOR_AUTHORITY/
  );

  // Reject unauthorized initiator
  await assert.rejects(
    () =>
      engine.prepareAuditAnchorTx(fakeRpc, config, {
        jobId,
        payerAccountId: "cryptozax.near",
        initiatorAccountId: "stranger.near",
        authorizedCustomerAccountId: "customer.near",
      }),
    /ERR_UNAUTHORIZED_ANCHOR_INITIATOR/
  );

  // Valid preparation produces exact 5-arg anchor_job matching snapfall-audit/src/lib.rs
  const plan = await engine.prepareAuditAnchorTx(fakeRpc, config, {
    jobId,
    payerAccountId: "cryptozax.near",
    initiatorAccountId: "customer.near",
    authorizedCustomerAccountId: "customer.near",
    completedAtSec: 1763010000,
  });
  assert.equal(plan.auditContractId, "audit.cryptozax.near");
  assert.equal(plan.auditContractDeployed, true);
  assert.equal(plan.transaction.receiverId, "audit.cryptozax.near");
  assert.equal(plan.transaction.signerId, "cryptozax.near");
  assert.equal(plan.transaction.actions[0].methodName, "anchor_job");
  assert.equal(plan.transaction.actions[0].gas, "60000000000000");
  assert.equal(plan.transaction.actions[0].depositYocto, ANCHOR_STORAGE_DEPOSIT);
  assert.deepEqual(Object.keys(plan.transaction.actions[0].args).sort(), [
    "completed_at",
    "delivery_hash",
    "event_root",
    "job_id",
    "payment_receipt_root",
  ]);
  assert.equal(plan.anchorArgs.job_id, jobId);
  assert.equal(plan.anchorArgs.delivery_hash, evidenceHash);
  assert.equal(plan.anchorArgs.completed_at, 1763010000);

  // Submit tx hash -> SUBMITTED, blocks duplicate prepare while in-flight
  const txHash = "H8ZGFaTvADq2bkRCsDCUxnuZu5UrNYNxHcUPgV6JtbBG";
  const submitted = engine.recordAnchorSubmission({
    jobId,
    txHash,
    signerAccountId: "cryptozax.near",
    contractId: "audit.cryptozax.near",
  });
  assert.equal(submitted.anchorStatus, "SUBMITTED");

  await assert.rejects(
    () =>
      engine.prepareAuditAnchorTx(fakeRpc, config, {
        jobId,
        payerAccountId: "cryptozax.near",
      }),
    /ERR_ANCHOR_IN_FLIGHT/
  );

  // Reconcile while RPC has not indexed yet -> PENDING
  const pendingRes = await engine.reconcileAuditAnchorTx(fakeRpc, config, { jobId });
  assert.equal(pendingRes.submission.anchorStatus, "PENDING");

  // Reconcile when RPC returns FINAL SuccessValue -> ANCHORED + persisted across restart
  mockTxResult = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction: {
        hash: txHash,
        signer_id: "cryptozax.near",
        receiver_id: "audit.cryptozax.near",
      },
    },
  };
  onChainAnchorData = { finalized: true, delivery_hash: evidenceHash };
  const finalRes = await engine.reconcileAuditAnchorTx(fakeRpc, config, { jobId });
  assert.equal(finalRes.submission.anchorStatus, "ANCHORED");
  assert.equal(finalRes.submission.auditTxHash, txHash);

  // Restart recovery: reload from SnowMoonRepository and confirm state persists & duplicate is blocked
  const reloadedEngine = new VerificationEngine(new SnowMoonRepository(stateFile));
  const reloadedSub = reloadedEngine.getSubmission(jobId);
  assert.equal(reloadedSub?.anchorStatus, "ANCHORED");
  assert.equal(reloadedSub?.auditTxHash, txHash);
  await assert.rejects(
    () =>
      reloadedEngine.prepareAuditAnchorTx(fakeRpc, config, {
        jobId,
        payerAccountId: "cryptozax.near",
      }),
    /ERR_DUPLICATE_AUDIT_ANCHOR/
  );

  // Failed tx reconciliation allows safe retry, and recoverInterruptedAnchors reconciles interrupted ones
  onChainAnchorData = null;
  const jobId2 = "0x" + "22".repeat(32);
  reloadedEngine.submitDelivery({
    jobId: jobId2,
    workerId: "worker-1",
    workerAccountId: "worker1.near",
    expectedWorkerId: "worker-1",
    deliverable,
    evidenceHash,
    deadlineSec: futureDeadline,
  });
  reloadedEngine.verifyDelivery({
    jobId: jobId2,
    verifierAccountId: "customer.snowmoon.test.near",
    decision: "VERIFIED",
  });
  await reloadedEngine.prepareAuditAnchorTx(fakeRpc, config, {
    jobId: jobId2,
    payerAccountId: "cryptozax.near",
  });
  reloadedEngine.recordAnchorSubmission({
    jobId: jobId2,
    txHash: "2qS6ghwTmoxJyPVEBBXQLsWfH9mhXYX1Exbrt5xtKKrk",
    signerAccountId: "cryptozax.near",
  });
  const recovery = await reloadedEngine.recoverInterruptedAnchors(fakeRpc, config);
  assert.equal(recovery.checked, 1);
  assert.equal(recovery.anchored, 1);
  assert.equal(reloadedEngine.getSubmission(jobId2)?.anchorStatus, "ANCHORED");

  // Phase 18: Cross-contract AnchorVerificationFailed callback log marks FAILED (even with SuccessValue)
  const jobId3 = "0x" + "33".repeat(32);
  reloadedEngine.submitDelivery({
    jobId: jobId3,
    workerId: "worker-1",
    workerAccountId: "worker1.near",
    expectedWorkerId: "worker-1",
    deliverable,
    evidenceHash,
    deadlineSec: futureDeadline,
  });
  reloadedEngine.verifyDelivery({
    jobId: jobId3,
    verifierAccountId: "customer.snowmoon.test.near",
    decision: "VERIFIED",
  });
  await reloadedEngine.prepareAuditAnchorTx(fakeRpc, config, {
    jobId: jobId3,
    payerAccountId: "cryptozax.near",
  });
  reloadedEngine.recordAnchorSubmission({
    jobId: jobId3,
    txHash: "4n2o9v5qX7vY2rK9sJ3wM8pL1qR6tZ5uW7xY9zA1bC2dE",
    signerAccountId: "cryptozax.near",
  });
  mockTxResult = {
    ok: true,
    result: {
      final_execution_status: "FINAL",
      status: { SuccessValue: "ZmFsc2U=" },
      transaction: {
        hash: "4n2o9v5qX7vY2rK9sJ3wM8pL1qR6tZ5uW7xY9zA1bC2dE",
        signer_id: "cryptozax.near",
        receiver_id: "audit.cryptozax.near",
      },
      receipts_outcome: [
        {
          id: "rcpt-1",
          outcome: {
            logs: [
              'EVENT_JSON:{"standard":"snapfall","version":"1.0.0","event":"AnchorVerificationFailed","data":[{"jobId":"' +
                jobId3 +
                '","reason":"JOB_NOT_ACCEPTED"}]}',
            ],
            status: { SuccessValue: "ZmFsc2U=" },
          },
        },
      ],
    } as typeof mockTxResult.result,
  };
  const failedCallbackRes = await reloadedEngine.reconcileAuditAnchorTx(fakeRpc, config, {
    jobId: jobId3,
  });
  assert.equal(failedCallbackRes.submission.anchorStatus, "FAILED");
  assert.match(failedCallbackRes.submission.auditError || "", /JOB_NOT_ACCEPTED/);
});

test("39. Phase 17.3 HTTP /api/audit/status returns live deployed AuditAnchor state", async () => {
  const dir = makeTempDir();
  const app = createSnowMoonApp({
    ...loadConfig(),
    port: 0,
    stateFile: path.join(dir, "state.json"),
    persistenceFile: path.join(dir, "db.json"),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = app.server.address();
    assert(addr && typeof addr === "object");
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/audit/status`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean;
      contractState: {
        contractId: string;
        initialized: boolean;
        coreContract: string;
        operatorAuthority: string;
        admin: string;
      };
    };
    assert.equal(json.ok, true);
    assert.equal(json.contractState.contractId, "audit.cryptozax.near");
    assert.equal(json.contractState.initialized, true);
    assert.equal(json.contractState.coreContract, "core.cryptozax.near");
    assert.equal(json.contractState.operatorAuthority, "cryptozax.near");
    assert.equal(json.contractState.admin, "cryptozax.near");

    // Phase 18: Unauthenticated write/recovery routes must reject without x-wallet-session
    for (const route of [
      "/api/verification/prepare-audit-anchor",
      "/api/verification/submit-audit-anchor",
      "/api/verification/reconcile-audit-anchor",
      "/api/verification/recover-anchors",
    ]) {
      const unauth: Response = await fetch(`http://127.0.0.1:${addr.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "0x" + "11".repeat(32) }),
      });
      assert.equal(unauth.ok, false, `${route} should reject unauthenticated request`);
      const errJson = (await unauth.json()) as { error?: string };
      assert.match(errJson.error || "", /ERR_WALLET_AUTH_REQUIRED/);
    }
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

