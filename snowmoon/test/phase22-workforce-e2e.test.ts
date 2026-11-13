import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { SnowMoonRepository } from "../src/persistence.ts";
import { createSnowMoonApp, PRODUCTION_ROUTE_POLICY } from "../src/server.ts";
import { WorkforceEngine } from "../src/workforce.ts";

function makeTempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase22-"));
  return path.join(dir, "state.json");
}

function makeProdConfig(stateFile: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "production",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    ...overrides,
  });
}

test("Phase 22.1: Complete E2E Workforce Lifecycle (Escrow -> Discovery -> Execute -> TEE Verify -> Accept -> Anchor Prep -> Settlement -> Restart Recovery)", async () => {
  const stateFile = makeTempStateFile();
  const pinnedHash = "1a5cf8146f09d9f8c2605e070fafaa16abd0634b787a47c61447b16a256afdfc";
  const config = makeProdConfig(stateFile, {
    OUTLAYER_PAYMENT_KEY: "pk_test_mock_phase22",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
    OUTLAYER_EXPECTED_WASM_HASH: pinnedHash,
  });

  let capturedInputHash = "";
  let capturedOutputHash = "";
  let capturedOutput: unknown = null;
  const app = createSnowMoonApp(config, {
    outlayerFetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/call/")) {
        const body = JSON.parse(String(init?.body || "{}")) as { input?: Record<string, unknown> };
        const inputJson = JSON.stringify(body.input || {});
        capturedInputHash = "0x" + crypto.createHash("sha256").update(inputJson).digest("hex");
        capturedOutput = body.input?.deliverable ?? { jobId: body.input?.jobId, ok: true };
        capturedOutputHash =
          "0x" + crypto.createHash("sha256").update(JSON.stringify(capturedOutput)).digest("hex");
        return new Response(
          JSON.stringify({
            call_id: "call_phase22_1",
            status: "completed",
            output: capturedOutput,
            compute_cost: "1000",
            instructions: 208467,
            time_ms: 199,
            attestation_url: "https://api.outlayer.ai/attestations/by-call/call_phase22_1",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          wasm_hash: pinnedHash,
          input_hash: capturedInputHash,
          output_hash: capturedOutputHash,
          tdx_quote: "a".repeat(64),
          worker_measurement: "b".repeat(96),
          mrtd: "b".repeat(96),
          rtmr0: "c".repeat(96),
          rtmr1: "d".repeat(96),
          rtmr2: "e".repeat(96),
          rtmr3: "f".repeat(96),
        }),
        { status: 200 }
      );
    },
    outlayerVerifyRunner: async (callId) => ({
      available: true,
      verified: true,
      command: `outlayer-verify call ${callId} --api https://api.outlayer.ai`,
      stdout: JSON.stringify({
        task_id: 1380831,
        tcb_status: "UpToDate",
        authenticity: { verdict: "pass" },
        identity: { verdict: "pass" },
        binding: { verdict: "pass" },
      }),
      stderr: "",
    }),
  });

  const jobId = "0x" + "aa".repeat(32);
  const fakeTxHash = "9vKqJ4y3L7mN2pQ8rS5tU6vW1xY2zA3bC4dE5fG6hJ7k";
  const fakeSettleTx = "8uJpH3x2K6mM1oP7qR4sT5uV9wX1yZ2aB3cD4eF5gH6j";

  // Mock NEAR RPC methods locally (zero real chain transactions)
  (app.nearRpcAdapter as unknown as Record<string, unknown>).inspectMainnetAccount = async (accountId: string) => ({
    accountId,
    exists: true,
    amountYocto: "5000000000000000000000000",
    amountNear: "5.0000",
    usdcBalanceAtomic: "10000000",
    usdcBalanceFormatted: "$10.00 USDC",
    usdcStorageRegistered: true,
    usdcStorageBalance: { total: "1250000000000000000000", available: "0" },
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).queryCoreStorageCredit = async () => ({
    balance: { ok: true, data: "50000000000000000000000" },
    registration: { ok: true, data: "1250000000000000000000" },
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).probeCoreContract = async () => ({
    jobStorageDepositYocto: "23000000000000000000000",
    viewQueryResult: { vault_paused: false, pool_paused: false },
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).callViewMethod = async () => ({
    ok: true,
    data: "10000000",
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).queryTransactionStatus = async (txHash: string) => {
    if (txHash === fakeTxHash) {
      return {
        ok: true,
        result: {
          final_execution_status: "FINAL",
          status: { SuccessValue: "" },
          transaction: { signer_id: "alice.near", receiver_id: config.mainnetUsdcContractId },
          receipts_outcome: [
            {
              outcome: {
                status: { SuccessValue: "" },
                logs: [`EVENT_JSON:${JSON.stringify({ standard: "snapfall", event: "JobCreated", data: [{ jobId }] })}`],
              },
            },
          ],
        },
      };
    }
    return {
      ok: true,
      result: {
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        transaction: { signer_id: "alice.near", receiver_id: config.mainnetCoreContractId },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs: [] } }],
      },
    };
  };
  (app.nearRpcAdapter as unknown as Record<string, unknown>).queryCoreJob = async (_jid: string) => ({
    ok: true,
    data: {
      status: app.settlementEngine.listSettlements().some((s) => s.status === "PENDING") ? "Accepted" : "Funded",
      customer: "alice.near",
      customer_payment: "1000000",
    },
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).probeAuditContract = async () => ({
    deploymentStatus: "DEPLOYED_AND_INITIALIZED",
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).inspectAuditContractState = async () => ({
    initialized: true,
    operatorAuthority: config.mainnetAuditOperatorAccountId,
    coreContract: config.mainnetCoreContractId,
  });
  (app.nearRpcAdapter as unknown as Record<string, unknown>).queryAuditAnchor = async () => ({
    ok: true,
    data: null,
  });

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    assert.ok(
      PRODUCTION_ROUTE_POLICY.productionAllowedRoutes.publicReadOnly.includes("/api/workforce/jobs/discover")
    );

    const aliceToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "alice.near",
      networkId: "mainnet",
      walletType: "meteor",
      verifiedAt: new Date().toISOString(),
    });
    const operatorToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: config.mainnetOperatorAccountId,
      networkId: "mainnet",
      walletType: "meteor",
      verifiedAt: new Date().toISOString(),
    });

    // 1. Customer prepares, submits, and reconciles escrow funding -> bridges to Workforce FUNDED job
    const prepFund = await fetch(`${baseUrl}/api/near/escrow/prepare-fund`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        customerAccountId: "alice.near",
        customerPaymentUsdcAtomic: "1000000",
        maxOperatingBudgetUsdcAtomic: "0",
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; record: { intentId: string } }>);
    assert.equal(prepFund.ok, true);

    const subFund = await fetch(`${baseUrl}/api/near/escrow/submit-tx`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        intentId: prepFund.record.intentId,
        txHash: fakeTxHash,
        customerAccountId: "alice.near",
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean }>);
    assert.equal(subFund.ok, true);

    const recFund = await fetch(`${baseUrl}/api/near/escrow/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        intentId: prepFund.record.intentId,
        txHash: fakeTxHash,
        customerAccountId: "alice.near",
        prompt: "Analyze NEAR Mainnet USDC liquidity depth",
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; record: { escrowState: string; jobId: string }; workforceJob: { jobId: string; state: string; escrowIntentId: string } }>);
    assert.equal(recFund.ok, true);
    assert.equal(recFund.record.escrowState, "FINAL_CONFIRMED");
    assert.equal(recFund.workforceJob.jobId, jobId);
    assert.equal(recFund.workforceJob.state, "FUNDED");
    assert.equal(recFund.workforceJob.escrowIntentId, prepFund.record.intentId);

    // 2. Register worker + discover + assign + accept
    const regWorker = await fetch(`${baseUrl}/api/workforce/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        workerId: "worker-alpha",
        accountId: "worker-alpha.near",
        displayName: "Alpha Researcher",
        capabilities: ["research", "analysis"],
        issueToken: true,
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; workerToken: string }>);
    assert.equal(regWorker.ok, true);
    assert.ok(regWorker.workerToken);

    const discRes = await fetch(`${baseUrl}/api/workforce/jobs/discover?jobId=${encodeURIComponent(jobId)}`).then(
      (r) => r.json() as Promise<{ ok: boolean; workers: Array<{ workerId: string }> }>
    );
    assert.equal(discRes.ok, true);
    assert.equal(discRes.workers[0].workerId, "worker-alpha");

    await fetch(`${baseUrl}/api/workforce/jobs/assign`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId, workerId: "worker-alpha" }),
    });

    const accRes = await fetch(`${baseUrl}/api/workforce/jobs/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-token": regWorker.workerToken },
      body: JSON.stringify({ jobId, workerId: "worker-alpha" }),
    }).then((r) => r.json() as Promise<{ ok: boolean; job: { state: string } }>);
    assert.equal(accRes.ok, true);
    assert.equal(accRes.job.state, "ACCEPTED");

    // 3. Execute task -> verify evidence & delivery -> verify AuditAnchor prep
    const execRes = await fetch(`${baseUrl}/api/workforce/jobs/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-token": regWorker.workerToken },
      body: JSON.stringify({ jobId, workerId: "worker-alpha" }),
    }).then((r) => r.json() as Promise<{
      ok: boolean;
      job: {
        state: string;
        evidenceHash: string;
        outlayerAttestationVerified: boolean;
        outlayerTaskId: number;
        outlayerWasmHash: string;
        executionBoundary: { aiInferenceOutsideTee: boolean; teeVerified: boolean };
      };
      submission: { verificationStatus: string; evidenceHash: string };
    }>);
    assert.equal(execRes.ok, true);
    assert.equal(execRes.job.state, "DELIVERED");
    assert.equal(execRes.job.executionBoundary.aiInferenceOutsideTee, true);
    assert.equal(execRes.job.executionBoundary.teeVerified, true);
    assert.equal(execRes.job.outlayerAttestationVerified, true);
    assert.equal(execRes.job.outlayerTaskId, 1380831);
    assert.equal(execRes.job.outlayerWasmHash, pinnedHash);
    assert.equal(execRes.submission.verificationStatus, "PENDING");
    assert.equal(execRes.submission.evidenceHash, execRes.job.evidenceHash);

    // 4. Customer accepts delivery -> prepares AuditAnchor -> prepares & reconciles settlement
    const verifyRes = await fetch(`${baseUrl}/api/verification/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({ jobId, verifierAccountId: "alice.near", decision: "VERIFIED" }),
    }).then((r) => r.json() as Promise<{ ok: boolean; submission: { verificationStatus: string } }>);
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.submission.verificationStatus, "VERIFIED");

    const anchorPrep = await fetch(`${baseUrl}/api/verification/prepare-audit-anchor`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({ jobId, initiatorAccountId: "alice.near", payerAccountId: config.mainnetAuditOperatorAccountId }),
    }).then((r) => r.json() as Promise<{ ok: boolean; anchorPlan: { anchorArgs: { delivery_hash: string } } }>);
    assert.equal(anchorPrep.ok, true);
    assert.equal(anchorPrep.anchorPlan.anchorArgs.delivery_hash, execRes.job.evidenceHash);

    const settlePrep1 = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({ jobId, kind: "PAYOUT_ACCEPT_DELIVERY" }),
    }).then((r) => r.json() as Promise<{ ok: boolean; settlement: { settlementId: string; idempotencyKey: string } }>);
    const settlePrep2 = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({ jobId, kind: "PAYOUT_ACCEPT_DELIVERY" }),
    }).then((r) => r.json() as Promise<{ ok: boolean; settlement: { settlementId: string } }>);
    assert.equal(settlePrep1.settlement.settlementId, settlePrep2.settlement.settlementId);

    await fetch(`${baseUrl}/api/settlement/submit-tx`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        settlementId: settlePrep1.settlement.settlementId,
        txHash: fakeSettleTx,
        signerAccountId: "alice.near",
      }),
    });

    const settleRec = await fetch(`${baseUrl}/api/settlement/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        settlementId: settlePrep1.settlement.settlementId,
        txHash: fakeSettleTx,
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; settlement: { status: string; onChainConfirmed: boolean } }>);
    assert.equal(settleRec.ok, true, JSON.stringify(settleRec));
    assert.equal(settleRec.settlement.status, "CONFIRMED", JSON.stringify(settleRec));
    assert.equal(settleRec.settlement.onChainConfirmed, true, JSON.stringify(settleRec));
  } finally {
    app.server.close();
    app.server.closeAllConnections?.();
  }

  // 5. Restart recovery: recreate app against same persistence file and verify state survived
  const recoveredApp = createSnowMoonApp(makeProdConfig(stateFile));
  try {
    assert.equal(recoveredApp.escrowTracker.listRecords()[0]?.escrowState, "FINAL_CONFIRMED");
    assert.equal(recoveredApp.workforceEngine.getJob(jobId)?.state, "SETTLED");
    assert.equal(recoveredApp.verificationEngine.getSubmission(jobId)?.anchorStatus, "PREPARED");
    assert.equal(recoveredApp.settlementEngine.getSettlementByJob(jobId)?.status, "CONFIRMED");
    assert.equal(recoveredApp.workforceEngine.getWorker("worker-alpha")?.completedJobs, 1);
  } finally {
    recoveredApp.server.close();
    recoveredApp.server.closeAllConnections?.();
  }
});

test("Phase 22.2: OutLayer pre-execution pinned WASM check, expired attestation rejection, and independent verify metadata persistence", async () => {
  const stateFile = makeTempStateFile();
  const repo = new SnowMoonRepository(stateFile);
  const pinnedHash = "1a5cf8146f09d9f8c2605e070fafaa16abd0634b787a47c61447b16a256afdfc";

  // 1. Missing pinned WASM hash in production fails before any HTTP request
  let fetchCalled = false;
  const noPinConfig = makeProdConfig(stateFile, {
    OUTLAYER_PAYMENT_KEY: "pk_test_123",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
  });
  const noPinAdapter = new OutLayerExecutionAdapter(
    noPinConfig,
    async () => {
      fetchCalled = true;
      throw new Error("Should not call fetch");
    },
    repo
  );
  const noPinRes = await noPinAdapter.executeAndVerify({
    jobId: "job-nopin",
    workerId: "w1",
    prompt: "test",
    evidenceHash: "0x" + "11".repeat(32),
    expectedWasmHash: pinnedHash,
  });
  assert.equal(fetchCalled, false);
  assert.equal(noPinRes.status, "EXECUTION_FAILED");
  assert.match(noPinRes.error || "", /ERR_OUTLAYER_PINNED_WASM_MISSING/);

  // 2. Expired attestation collateral is rejected
  const prodConfig = makeProdConfig(stateFile, {
    OUTLAYER_PAYMENT_KEY: "pk_test_123",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
    OUTLAYER_EXPECTED_WASM_HASH: pinnedHash,
  });

  const jobId = "job-expired-att";
  const workerId = "w-exp";
  const prompt = "test";
  const evidenceHash = "0x" + "22".repeat(32);
  const inputHash =
    "0x" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ jobId, workerId, prompt, evidenceHash }))
      .digest("hex");
  const outputObj = { jobId, ok: true };
  const outputHash =
    "0x" + crypto.createHash("sha256").update(JSON.stringify(outputObj)).digest("hex");

  const expiredAdapter = new OutLayerExecutionAdapter(
    prodConfig,
    async (url) => {
      const u = String(url);
      if (u.includes("/call/")) {
        return new Response(
          JSON.stringify({
            call_id: "call_exp_1",
            status: "completed",
            output: outputObj,
            compute_cost: "1000",
            attestation_url: "https://api.outlayer.ai/attestations/by-call/call_exp_1",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          wasm_hash: pinnedHash,
          input_hash: inputHash,
          output_hash: outputHash,
          tdx_quote: "a".repeat(64),
          worker_measurement: "b".repeat(96),
          collateral: {
            pck_cert_chain: "cert",
            tcb_info: "tcb",
            valid_until: "2020-01-01T00:00:00Z",
          },
        }),
        { status: 200 }
      );
    },
    repo,
    async () => ({ available: true, verified: true, command: "outlayer-verify", stdout: "{}", stderr: "" })
  );
  const expRes = await expiredAdapter.executeAndVerify({ jobId, workerId, prompt, evidenceHash });
  assert.equal(expRes.status, "ATTESTATION_FAILED");

  // 3. Valid attestation + outlayer-verify --json persists taskId, wasmHash, verificationResult, executedAt, verifiedAt
  const validJobId = "job-valid-direct";
  const validInputHash =
    "0x" +
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          jobId: validJobId,
          workerId,
          prompt,
          evidenceHash,
          tenantId: "alice.near",
        })
      )
      .digest("hex");
  const validOutputObj = { jobId: validJobId, ok: true };
  const validOutputHash =
    "0x" + crypto.createHash("sha256").update(JSON.stringify(validOutputObj)).digest("hex");

  const validAdapter = new OutLayerExecutionAdapter(
    prodConfig,
    async (url) => {
      const u = String(url);
      if (u.includes("/call/")) {
        return new Response(
          JSON.stringify({
            call_id: "call_ok_1",
            status: "completed",
            output: validOutputObj,
            compute_cost: "1000",
            attestation_url: "https://api.outlayer.ai/attestations/by-call/call_ok_1",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          wasm_hash: pinnedHash,
          input_hash: validInputHash,
          output_hash: validOutputHash,
          tdx_quote: "a".repeat(64),
          worker_measurement: "b".repeat(96),
        }),
        { status: 200 }
      );
    },
    repo,
    async () => ({
      available: true,
      verified: true,
      command: "outlayer-verify call call_ok_1 --api https://api.outlayer.ai",
      stdout: JSON.stringify({
        task_id: 1380831,
        tcb_status: "UpToDate",
        authenticity: { verdict: "pass" },
        identity: { verdict: "pass" },
        binding: { verdict: "pass" },
      }),
      stderr: "",
    })
  );

  // Use WorkforceEngine with validAdapter and verify persisted fields
  const wf = new WorkforceEngine(repo);
  wf.registerWorker({ workerId, accountId: "w.near", displayName: "W", capabilities: ["research"] });
  wf.registerJob({
    jobId: "job-valid-tee",
    customerAccountId: "alice.near",
    amountAtomic: "1000000",
    requiredCapabilities: ["research"],
    prompt,
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    funded: true,
  });
  wf.assignJob("job-valid-tee", workerId);
  wf.acceptJob("job-valid-tee", workerId);
  await assert.rejects(
    () =>
      wf.executeJob({
        jobId: "job-valid-tee",
        workerId,
        aiAdapter: new AIWorkerAdapter(prodConfig),
        outlayerAdapter: expiredAdapter,
        requireLiveOutlayer: true,
        maxRetries: 0,
      }),
    /ERR_OUTLAYER_TEE_FAILED/
  );
  assert.equal(wf.getJob("job-valid-tee")?.state, "FAILED");
  assert.notEqual(wf.getJob("job-valid-tee")?.outlayerAttestationVerified, true);

  // Test validAdapter directly for JSON verification metadata
  const okRes = await validAdapter.executeAndVerify({
    jobId: validJobId,
    workerId,
    tenantId: "alice.near",
    prompt,
    evidenceHash,
  });
  assert.equal(okRes.status, "ATTESTATION_VERIFIED");
  assert.equal(okRes.tenantId, "alice.near");
  assert.equal(okRes.taskId, 1380831);
  assert.equal(okRes.wasmHash, pinnedHash);
  assert.equal(okRes.verificationResult?.tcbStatus, "UpToDate");
  assert.equal(okRes.verificationResult?.authenticity, "pass");
  assert.ok(okRes.executedAt);
  assert.ok(okRes.verifiedAt);
});
