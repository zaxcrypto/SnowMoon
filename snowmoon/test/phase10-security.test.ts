import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import {
  assertNoSecretsInRecords,
  SnowMoonRepository,
  SupabaseDatabaseAdapter,
} from "../src/persistence.ts";
import { NearIntentsClient } from "../src/near_intents.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { WorkforceEngine } from "../src/workforce.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("22. Phase 10.1 Production DB schema, secret-persistence guard, and Supabase adapter health check", async () => {
  const migrationPath = path.resolve(
    process.cwd(),
    "migrations",
    "001_initial_schema.sql"
  );
  assert.ok(fs.existsSync(migrationPath), "001_initial_schema.sql must exist");
  const sql = fs.readFileSync(migrationPath, "utf8");
  for (const tbl of [
    "snowmoon_migrations",
    "snowmoon_customers",
    "snowmoon_workers",
    "snowmoon_workforce_jobs",
    "snowmoon_intents",
    "snowmoon_outlayer_calls",
    "snowmoon_verifications",
    "snowmoon_settlements",
  ]) {
    assert.ok(sql.includes(tbl), `Migration must define ${tbl}`);
  }

  // Secret persistence guard blocks private keys and API secrets
  assert.throws(
    () => assertNoSecretsInRecords([{ accountId: "alice.near", privateKey: "ed25519:abc123" }]),
    /ERR_FORBIDDEN_SECRET_PERSISTENCE/
  );
  assert.throws(
    () => assertNoSecretsInRecords([{ note: "ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4FGZvq6exampleKey" }]),
    /ERR_FORBIDDEN_SECRET_PERSISTENCE/
  );

  // Supabase adapter health check never leaks secret key
  const tmpFile = path.join(os.tmpdir(), `snowmoon-p10-sb-${Date.now()}.json`);
  try {
    const mockFetch = (async (url: string) => {
      if (url.includes("snowmoon_migrations")) {
        return new Response(JSON.stringify([{ id: "001_initial_schema" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const sb = new SupabaseDatabaseAdapter(
      "https://example.supabase.co",
      "sb_secret_super_sensitive_999",
      tmpFile,
      mockFetch
    );
    const repo = new SnowMoonRepository(sb);
    const health = await repo.healthCheck();
    assert.equal(health.backend, "supabase");
    assert.equal(health.connected, true);
    assert.equal(health.migrationsApplied, true);
    assert.equal(health.productionReady, true);
    assert.ok(!JSON.stringify(health).includes("sb_secret_super_sensitive_999"));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("23. Phase 10.2 Complete 7-stage NEAR Intents lifecycle, source-wallet deposit prep, expiry & Core escrow bridge", async () => {
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const depositAddr = "0xintentdeposit1234567890";
  let currentBalance = "1000000";
  let mockStatus = "KNOWN_DEPOSIT_TX";

  const mockRpc = {
    inspectMainnetAccount: async (accountId: string) => ({
      accountId,
      exists: true,
      nearBalanceAtomic: "5000000000000000000000000",
      nearBalanceFormatted: "5.0000",
      usdcBalanceAtomic: currentBalance,
      usdcBalanceFormatted: (Number(currentBalance) / 1e6).toFixed(6),
      usdcRegistered: true,
      storagePaidYocto: "1250000000000000000000",
    }),
    prepareUsdcEscrowAndJobPayloads: (params: Record<string, unknown>) => ({
      broadcastingEnabled: false,
      executionStatus: "NOT_EXECUTED_UNSIGNED_DRAFT",
      walletSigned: false,
      onChainVerified: false,
      mode: "UNSIGNED_PREPARATION_ONLY",
      transactions: [{ receiverId: cfg.mainnetUsdcContractId, actions: [{ methodName: "ft_transfer_call", args: params }] }],
    }),
  } as unknown as NearMainnetRpcAdapter;

  const mockFetch = (async (url: string) => {
    if (url.endsWith("/v0/tokens")) {
      return new Response(
        JSON.stringify([
          {
            assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
            decimals: 6,
            blockchain: "eth",
            symbol: "USDC",
          },
          {
            assetId: `nep141:${cfg.mainnetUsdcContractId}`,
            decimals: 6,
            blockchain: "near",
            symbol: "USDC",
            contractAddress: cfg.mainnetUsdcContractId,
          },
        ]),
        { status: 200 }
      );
    }
    if (url.endsWith("/v0/quote")) {
      return new Response(
        JSON.stringify({
          quote: {
            depositAddress: depositAddr,
            amountIn: "5000000",
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
          swapDetails:
            mockStatus === "SUCCESS"
              ? { destinationChainTxHashes: [{ hash: "near_dest_tx_abc" }], amountOut: "4980000" }
              : {},
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const client = new NearIntentsClient(cfg, mockFetch);

  // 1. QUOTE_GENERATED
  const q = await client.requestQuote(mockRpc, {
    dry: false,
    originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    amountAtomic: "5000000",
    slippageToleranceBps: 100,
    customerNearAccount: "alice.near",
    sourceWalletAddress: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(q.record?.lifecycleStage, "QUOTE_GENERATED");

  // 2. Source wallet deposit preparation (customer wallet only)
  const plan = client.prepareSourceWalletDeposit(depositAddr);
  assert.equal(plan.walletAdapter, "evm_eip1193");

  // Cannot bridge to Core escrow before destination verification
  assert.throws(
    () =>
      client.prepareCoreEscrowFromIntent(mockRpc, {
        depositAddress: depositAddr,
        workerAccountId: "worker.near",
        deadlineSec: Math.floor(Date.now() / 1000) + 3600,
        termsHash: "0x" + "11".repeat(32),
      }),
    /ERR_DESTINATION_NOT_VERIFIED/
  );

  // 3. SOURCE_TX_SIGNED
  const signed = await client.submitDepositTx({
    depositAddress: depositAddr,
    txHash: "0xsourcetx_999",
    customerNearAccount: "alice.near",
  });
  assert.equal(signed.lifecycleStage, "SOURCE_TX_SIGNED");

  // 4. SOURCE_TX_CONFIRMED -> INTENT_PROCESSING -> DESTINATION_USDC_RECEIVED
  mockStatus = "KNOWN_DEPOSIT_TX";
  assert.equal((await client.pollStatus(depositAddr)).lifecycleStage, "SOURCE_TX_CONFIRMED");

  mockStatus = "PROCESSING";
  assert.equal((await client.pollStatus(depositAddr)).lifecycleStage, "INTENT_PROCESSING");

  mockStatus = "SUCCESS";
  currentBalance = "5980000"; // +4.98 USDC received on NEAR
  assert.equal((await client.pollStatus(depositAddr)).lifecycleStage, "DESTINATION_USDC_RECEIVED");

  // 5. DESTINATION_USDC_VERIFIED
  const verified = await client.verifyDestinationDelivery(mockRpc, {
    depositAddress: depositAddr,
    expectedRecipient: "alice.near",
  });
  assert.equal(verified.lifecycleStage, "DESTINATION_USDC_VERIFIED");

  // 6. Bridge to Core escrow & mark ESCROW_FUNDED
  const bridged = client.prepareCoreEscrowFromIntent(mockRpc, {
    depositAddress: depositAddr,
    workerAccountId: "worker.near",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    termsHash: "0x" + "11".repeat(32),
  });
  assert.equal(bridged.escrowAmountAtomic, "4950000");

  const funded = client.markEscrowFunded(depositAddr, "escrow_10");
  assert.equal(funded.lifecycleStage, "ESCROW_FUNDED");
});

test("24. Phase 10.3 & 10.4 Workforce cancellation persistence + OutLayer collateral expiry & job-binding enforcement", async () => {
  const tmpFile = path.join(os.tmpdir(), `snowmoon-p10-wf-${Date.now()}.json`);
  try {
    const repo = new SnowMoonRepository(tmpFile);
    const wf = new WorkforceEngine(repo);
    const jobId = "0x" + "aa".repeat(32);
    wf.registerJob({
      jobId,
      customerAccountId: "alice.near",
      amountAtomic: "1000000",
      requiredCapabilities: ["research"],
      prompt: "Cancelable task",
      deadlineSec: Math.floor(Date.now() / 1000) + 3600,
      funded: true,
    });
    const cancelled = wf.cancelJob(jobId);
    assert.equal(cancelled.state, "CANCELLED");

    // Survives reload
    const wf2 = new WorkforceEngine(new SnowMoonRepository(tmpFile));
    assert.equal(wf2.getJob(jobId)?.state, "CANCELLED");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  // OutLayer collateral expiry & job_id binding check
  const cfg = loadConfig({
    OUTLAYER_PAYMENT_KEY: "ol_pay_test_10",
    OUTLAYER_PROJECT_OWNER: "owner.near",
    OUTLAYER_PROJECT_NAME: "worker",
    OUTLAYER_EXPECTED_WASM_HASH: "cc".repeat(32),
  });
  const jobId = "0x" + "55".repeat(32);
  const prompt = "Check collateral";
  const evidenceHash = "0x" + "22".repeat(32);
  const expectedInputHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ jobId, workerId: "w1", prompt, evidenceHash }))
    .digest("hex");
  const expectedOutput = { answer: 42 };
  const expectedOutputHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(expectedOutput))
    .digest("hex");

  let nextUpdate = new Date(Date.now() + 86_400_000).toISOString();
  let attJobId = jobId;

  const mockFetch = (async (url: string) => {
    if (url.includes("/call/")) {
      return new Response(
        JSON.stringify({
          call_id: "call_p10",
          status: "completed",
          output: expectedOutput,
          attestation_url: "/attestations/by-call/call_p10",
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        wasm_hash: "cc".repeat(32),
        input_hash: expectedInputHash,
        output_hash: expectedOutputHash,
        tdx_quote: "dGVzdF90ZHhfcXVvdGVfYnl0ZXNfMTIzNDU2Nzg5MDEyMzQ1Njc4OTA=",
        worker_measurement: "mrtd_p10",
        job_id: attJobId,
        collateral: {
          pck_cert_chain: "-----BEGIN CERTIFICATE-----MOCK-----END CERTIFICATE-----",
          tcb_info: "{\"version\":3}",
          next_update: nextUpdate,
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const ol = new OutLayerExecutionAdapter(cfg, mockFetch);
  const valid = await ol.executeAndVerify({ jobId, workerId: "w1", prompt, evidenceHash });
  assert.equal(valid.status, "ATTESTATION_VERIFIED");
  assert.equal(valid.attestationChecks?.collateralVerified, true);
  assert.equal(valid.attestationChecks?.jobBindingVerified, true);

  // Expired collateral -> ATTESTATION_FAILED
  nextUpdate = new Date(Date.now() - 60_000).toISOString();
  const expired = await ol.verifyAttestation(valid.requestId);
  assert.equal(expired.status, "ATTESTATION_FAILED");
  assert.equal(expired.attestationChecks?.collateralVerified, false);

  // Mismatched job_id -> ATTESTATION_FAILED
  nextUpdate = new Date(Date.now() + 86_400_000).toISOString();
  attJobId = "0x" + "99".repeat(32);
  const wrongJob = await ol.verifyAttestation(valid.requestId);
  assert.equal(wrongJob.status, "ATTESTATION_FAILED");
  assert.equal(wrongJob.attestationChecks?.jobBindingVerified, false);
});

test("25. Phase 10.5 & 10.8 HTTP security: database health, AuditAnchor WASM readiness & session auth enforcement", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p10-http-"));
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_STATE_FILE: path.join(tmpDir, "state.json"),
      SNOWMOON_PERSISTENCE_FILE: path.join(tmpDir, "p9.json"),
    })
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const dbResp = await fetch(`${baseUrl}/api/database/health`);
    assert.equal(dbResp.status, 200);
    const dbJson = (await dbResp.json()) as { ok: boolean; health: { backend: string } };
    assert.equal(dbJson.ok, true);
    assert.equal(dbJson.health.backend, "json");

    const auditResp = await fetch(`${baseUrl}/api/audit/readiness`);
    assert.equal(auditResp.status, 200);
    const auditJson = (await auditResp.json()) as {
      ok: boolean;
      wasmArtifact: { exists: boolean; bytes: number; matchesCiExpected: boolean };
      mainnet: { auditAccountId: string; requiredNearForDeployment: string };
    };
    assert.equal(auditJson.ok, true);
    if (auditJson.wasmArtifact.exists) {
      assert.equal(auditJson.wasmArtifact.bytes, 131338);
      assert.equal(auditJson.wasmArtifact.matchesCiExpected, true);
    }
    assert.equal(auditJson.mainnet.auditAccountId, "audit.cryptozax.near");

    // Auth enforcement on /api/intents/prepare-escrow
    const unauth = await fetch(`${baseUrl}/api/intents/prepare-escrow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depositAddress: "0xmissing", customerAccountId: "alice.near" }),
    });
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
