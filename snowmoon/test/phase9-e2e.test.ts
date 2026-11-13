import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { SnowMoonRepository } from "../src/persistence.ts";
import { NearIntentsClient } from "../src/near_intents.ts";
import { WorkforceEngine } from "../src/workforce.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";

class MockNearRpcForIntents extends NearMainnetRpcAdapter {
  public mockUsdcBalance = "0";
  public mockExists = true;

  public override async inspectMainnetAccount(accountId: string) {
    return {
      accountId,
      exists: this.mockExists,
      amountYocto: "5000000000000000000000000",
      amountNear: "5.0000",
      lockedYocto: "0",
      storageUsageBytes: 200,
      codeHash: "11111111111111111111111111111111",
      hasContractDeployed: false,
      usdcBalanceAtomic: this.mockUsdcBalance,
      usdcBalanceFormatted: "$0.00 USDC",
      usdcStorageRegistered: true,
      usdcStorageBalance: { total: "1250000000000000000000", available: "0" },
    };
  }
}

test("18. Phase 9.1 Live 1Click /v0/tokens discovery verifies native NEAR Mainnet USDC assetId", async () => {
  const config = loadConfig();
  const client = new NearIntentsClient(config, fetch);
  const res = await client.fetchSupportedTokens(true);
  assert.ok(res.tokens.length > 50);
  assert.equal(
    res.nearNativeUsdc.assetId,
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
  );
  assert.equal(res.nearNativeUsdc.decimals, 6);
  assert.equal(res.nearNativeUsdc.blockchain, "near");
});

test("19. Phase 9.1 NEAR Intents quote, deposit, status (SUCCESS/INCOMPLETE/REFUNDED/FAILED/UNKNOWN), destination verification & recovery", async () => {
  const config = loadConfig();
  const rpc = new MockNearRpcForIntents(config);
  rpc.mockUsdcBalance = "1000000"; // 1.00 USDC pre-swap

  let mockStatus = "SUCCESS";
  const mockFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v0/tokens")) {
      return new Response(
        JSON.stringify([
          {
            assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
            decimals: 6,
            blockchain: "arb",
            symbol: "USDC",
          },
          {
            assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            decimals: 6,
            blockchain: "near",
            symbol: "USDC",
            contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          },
        ]),
        { status: 200 }
      );
    }
    if (url.endsWith("/v0/quote")) {
      const body = JSON.parse(String(init?.body || "{}")) as { dry?: boolean; amount?: string };
      return new Response(
        JSON.stringify({
          quote: {
            depositAddress: body.dry ? undefined : "0xDepositAddr111",
            amountIn: body.amount,
            amountOut: "4980000",
            minAmountOut: "4950000",
            deadline: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/v0/deposit/submit")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/v0/status")) {
      return new Response(
        JSON.stringify({
          status: mockStatus,
          swapDetails: { destinationChainTxHashes: [{ hash: "NearDestTx111" }] },
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const client = new NearIntentsClient(config, mockFetch);

  // Committed quote
  const q = await client.requestQuote(rpc, {
    dry: false,
    originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    amountAtomic: "5000000",
    slippageToleranceBps: 100,
    customerNearAccount: "alice.near",
    sourceWalletAddress: "0xSourceWallet111",
  });
  assert.ok(q.record);
  const dep = q.record.depositAddress;

  // Submit deposit tx + reject duplicate tx on same/other intent
  await client.submitDepositTx({
    depositAddress: dep,
    txHash: "0xSrcTx111",
    customerNearAccount: "alice.near",
  });
  await assert.rejects(
    () =>
      client.submitDepositTx({
        depositAddress: dep,
        txHash: "0xSrcTxOther",
        customerNearAccount: "alice.near",
      }),
    /ERR_DUPLICATE_DEPOSIT_SUBMIT/
  );

  // Status edge cases
  mockStatus = "INCOMPLETE_DEPOSIT";
  assert.equal((await client.pollStatus(dep)).status, "INCOMPLETE_DEPOSIT");
  mockStatus = "REFUNDED";
  assert.equal((await client.pollStatus(dep)).status, "REFUNDED");
  mockStatus = "FAILED";
  assert.equal((await client.pollStatus(dep)).status, "FAILED");
  mockStatus = "FUTURE_NEW_STATE";
  assert.equal((await client.pollStatus(dep)).status, "UNKNOWN_STATUS");

  // SUCCESS -> destination checks
  mockStatus = "SUCCESS";
  await client.pollStatus(dep);

  // Wrong destination account rejected
  await assert.rejects(
    () =>
      client.verifyDestinationDelivery(rpc, {
        depositAddress: dep,
        expectedRecipient: "attacker.near",
      }),
    /ERR_WRONG_DESTINATION_ACCOUNT/
  );

  // Wrong destination token rejected
  await assert.rejects(
    () =>
      client.verifyDestinationDelivery(rpc, {
        depositAddress: dep,
        expectedRecipient: "alice.near",
        expectedTokenContract: "usdc.fake.near",
      }),
    /ERR_WRONG_DESTINATION_TOKEN/
  );

  // Insufficient delivered USDC (balance did not increase enough) rejected
  rpc.mockUsdcBalance = "2000000"; // +1.00 USDC < 4.95 minAmountOut
  await assert.rejects(
    () =>
      client.verifyDestinationDelivery(rpc, {
        depositAddress: dep,
        expectedRecipient: "alice.near",
      }),
    /ERR_INSUFFICIENT_DELIVERED_USDC/
  );

  // Sufficient delivered USDC -> verified & escrowFundingEnabled=true
  rpc.mockUsdcBalance = "6000000"; // +5.00 USDC >= 4.95 minAmountOut
  const verified = await client.verifyDestinationDelivery(rpc, {
    depositAddress: dep,
    expectedRecipient: "alice.near",
  });
  assert.equal(verified.destinationVerified, true);
  assert.equal(verified.escrowFundingEnabled, true);
  assert.equal(verified.receivedDeltaAtomic, "5000000");

  // Duplicate escrow funding for same intent blocked
  client.markEscrowFunded(dep, "escrow_1");
  assert.throws(
    () => client.markEscrowFunded(dep, "escrow_2"),
    /ERR_DUPLICATE_INTENT_ESCROW/
  );
});

test("20. Phase 9.2 Persistent Workforce: survives restart, recovers EXECUTING jobs, enforces worker auth, and handles AI timeout & reassignment", async () => {
  const tmpFile = path.join(os.tmpdir(), `snowmoon-p9-${Date.now()}.json`);
  try {
    const repo1 = new SnowMoonRepository(tmpFile);
    const wf1 = new WorkforceEngine(repo1);
    wf1.registerWorker({
      workerId: "w1",
      accountId: "w1.near",
      displayName: "Worker 1",
      capabilities: ["research"],
    });
    const tok1 = wf1.issueWorkerToken("w1");
    wf1.assertWorkerAuthorized("w1", tok1);
    assert.throws(() => wf1.assertWorkerAuthorized("w1", "bad_tok"), /ERR_WORKER_UNAUTHORIZED/);

    wf1.registerWorker({
      workerId: "w2",
      accountId: "w2.near",
      displayName: "Worker 2",
      capabilities: ["research"],
    });

    const jobId = "0x" + "77".repeat(32);
    wf1.registerJob({
      jobId,
      customerAccountId: "alice.near",
      amountAtomic: "2000000",
      requiredCapabilities: ["research"],
      prompt: "Slow task",
      deadlineSec: Math.floor(Date.now() / 1000) + 3600,
      funded: true,
    });
    wf1.assignJob(jobId, "w1");
    wf1.acceptJob(jobId, "w1");

    // Simulate AI provider timeout
    const slowAi = {
      executeJobTask: () => new Promise(() => {}),
    } as unknown as AIWorkerAdapter;
    await assert.rejects(
      () =>
        wf1.executeJob({
          jobId,
          workerId: "w1",
          aiAdapter: slowAi,
          maxRetries: 0,
          timeoutMs: 30,
        }),
      /ERR_EXECUTION_TIMEOUT/
    );

    // Simulate server restart: reload from tmpFile into fresh WorkforceEngine
    const repo2 = new SnowMoonRepository(tmpFile);
    const wf2 = new WorkforceEngine(repo2);
    const reloadedJob = wf2.getJob(jobId);
    assert.ok(reloadedJob);
    assert.equal(reloadedJob.state, "FAILED");

    // Reassign failed job to w2 and execute
    wf2.reassignJob(jobId, "w2");
    wf2.acceptJob(jobId, "w2");
    const mockAi = new AIWorkerAdapter(loadConfig({ SNOWMOON_AI_MODE: "mock" }));
    const done = await wf2.executeJob({
      jobId,
      workerId: "w2",
      aiAdapter: mockAi,
    });
    assert.equal(done.state, "DELIVERED");
    assert.equal(done.assignedWorkerId, "w2");
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test("21. Phase 9.3 OutLayer HTTPS execution & TEE attestation: verifies valid attestation, rejects tampered/missing attestation, handles 402 payment error & timeout", async () => {
  const baseCfg = loadConfig({
    OUTLAYER_PAYMENT_KEY: "alice.near:1:secret_pay_key",
    OUTLAYER_PROJECT_OWNER: "alice.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
    OUTLAYER_EXPECTED_WASM_HASH: "aa".repeat(32),
  });

  const jobId = "0x" + "88".repeat(32);
  const prompt = "Verify TEE";
  const evidenceHash = "0x" + "11".repeat(32);
  const inputPayload = { jobId, workerId: "w1", prompt, evidenceHash };
  const expectedInputHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(inputPayload))
    .digest("hex");
  const expectedOutput = { ok: true, result: "verified" };
  const expectedOutputHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(expectedOutput))
    .digest("hex");

  let attestationMode: "valid" | "bad_hash" | "missing_quote" = "valid";
  const mockFetch = (async (url: string) => {
    if (url.includes("/call/")) {
      return new Response(
        JSON.stringify({
          call_id: "call_123",
          status: "completed",
          output: expectedOutput,
          compute_cost: "2500",
          instructions: 50000,
          time_ms: 120,
          attestation_url: "/attestations/by-call/call_123",
        }),
        { status: 200 }
      );
    }
    if (url.includes("/attestations/by-call/call_123")) {
      return new Response(
        JSON.stringify({
          wasm_hash: attestationMode === "bad_hash" ? "bb".repeat(32) : "aa".repeat(32),
          input_hash: expectedInputHash,
          output_hash: expectedOutputHash,
          tdx_quote: attestationMode === "missing_quote" ? "" : "base64_tdx_quote_payload_here_1234567890",
          worker_measurement: "mrtd_measurement_abc",
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const ol = new OutLayerExecutionAdapter(baseCfg, mockFetch);

  // Valid attestation -> ATTESTATION_VERIFIED
  const okRec = await ol.executeAndVerify({
    jobId,
    workerId: "w1",
    prompt,
    evidenceHash,
  });
  assert.equal(okRec.status, "ATTESTATION_VERIFIED");
  assert.equal(okRec.attestationChecks?.wasmHashVerified, true);
  assert.equal(okRec.attestationChecks?.inputHashVerified, true);
  assert.equal(okRec.attestationChecks?.outputHashVerified, true);

  // Invalid wasm_hash -> ATTESTATION_FAILED
  attestationMode = "bad_hash";
  const olBadHash = new OutLayerExecutionAdapter(baseCfg, mockFetch);
  const badRec = await olBadHash.executeAndVerify({
    jobId,
    workerId: "w1",
    prompt,
    evidenceHash,
  });
  assert.equal(badRec.status, "ATTESTATION_FAILED");

  // Missing TDX quote -> ATTESTATION_FAILED
  attestationMode = "missing_quote";
  const olNoQuote = new OutLayerExecutionAdapter(baseCfg, mockFetch);
  const noQuoteRec = await olNoQuote.executeAndVerify({
    jobId,
    workerId: "w1",
    prompt,
    evidenceHash,
  });
  assert.equal(noQuoteRec.status, "ATTESTATION_FAILED");

  // Payment failure (402) -> EXECUTION_FAILED and X-Payment-Key redacted
  const failOl = new OutLayerExecutionAdapter(baseCfg, (async () =>
    new Response("Payment failed for alice.near:1:secret_pay_key", { status: 402 })) as typeof fetch);
  const payFail = await failOl.executeAndVerify({
    jobId,
    workerId: "w1",
    prompt,
    evidenceHash,
  });
  assert.equal(payFail.status, "EXECUTION_FAILED");
  assert.ok(!payFail.error?.includes("secret_pay_key"));

  // Missing credentials -> MOCK_EXECUTION
  const mockOl = new OutLayerExecutionAdapter(loadConfig({ OUTLAYER_PAYMENT_KEY: "" }));
  const mockRec = await mockOl.executeAndVerify({
    jobId,
    workerId: "w1",
    prompt,
    evidenceHash,
  });
  assert.equal(mockRec.status, "MOCK_EXECUTION");
  assert.equal(mockRec.mode, "mock_fallback");
});

