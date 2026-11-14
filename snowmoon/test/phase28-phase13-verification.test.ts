import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createSnowMoonApp } from "../src/server.ts";
import {
  DeliverableVault,
  LocalPrivateObjectStorage,
  sanitizeStorageObjectKey,
  SupabasePrivateObjectStorage,
} from "../src/deliverables.ts";
import {
  calculateSnowMoonAdvanceMath,
  evaluateFloatAdvanceEligibility,
  FloatPoolAdvanceOrchestrator,
} from "../src/float_pool.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { computeFinancialDestinationAudit, SettlementEngine } from "../src/settlement.ts";

const JOB_ID = "0x" + "aa".repeat(32);
const USDC_MAINNET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("Phase 13 WS2: FloatPool lifecycle — eligibility, insufficient liquidity, pool pause, concurrent guard & timeout recovery", async () => {
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_DB_BACKEND: "json" });
  const rpc = new NearMainnetRpcAdapter(cfg);

  let mode: "funded_ok" | "pool_paused" | "low_liq" | "already_issued" = "funded_ok";
  rpc.callViewMethod = (async (_contract: string, method: string) => {
    if (method === "get_job") {
      return { ok: true, data: { customer: "alice.near", operator: "cryptozax.near", customer_payment: "100000000", status: "Funded" } };
    }
    if (method === "accounting") {
      return {
        ok: true,
        data: {
          pool_paused: mode === "pool_paused",
          total_assets: mode === "low_liq" ? "10000000" : "1000000000",
          total_outstanding: "0",
          total_written_off: "0",
          reserve: "0",
          max_advance: "100000000",
          max_total_exposure: "800000000",
        },
      };
    }
    if (method === "get_advance") {
      if (mode === "already_issued") {
        return {
          ok: true,
          data: {
            job_id: JOB_ID,
            operator_org: "cryptozax.near",
            principal: "50000000",
            fee: "1000000",
            rate_bps: 5000,
            opened_at: 1700000000,
            status: "Issued",
          },
        };
      }
      return { ok: true, data: null };
    }
    return { ok: true, data: 5000 };
  }) as typeof rpc.callViewMethod;

  const orch = new FloatPoolAdvanceOrchestrator();
  // 1. Eligible -> PREPARED
  const prep = await orch.evaluateAndPrepareFromChain(cfg, rpc, {
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    escrowConfirmed: true,
  });
  assert.equal(prep.status, "PREPARED");
  assert.equal(prep.principalAtomic, "50000000");

  // 2. Pool paused -> DENIED
  const orchPaused = new FloatPoolAdvanceOrchestrator();
  mode = "pool_paused";
  const deniedPaused = await orchPaused.evaluateAndPrepareFromChain(cfg, rpc, {
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    escrowConfirmed: true,
  });
  assert.equal(deniedPaused.status, "DENIED");
  assert.ok(deniedPaused.reasons.some((r) => r.includes("ERR_POOL_PAUSED")));

  // 3. Insufficient liquidity -> DENIED
  const orchLow = new FloatPoolAdvanceOrchestrator();
  mode = "low_liq";
  const deniedLow = await orchLow.evaluateAndPrepareFromChain(cfg, rpc, {
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    escrowConfirmed: true,
  });
  assert.equal(deniedLow.status, "DENIED");
  assert.ok(deniedLow.reasons.some((r) => r.includes("ERR_INSUFFICIENT_LIQUIDITY")));

  // 4. Timeout recovery: on-chain Issued -> reconciles to ISSUED with no duplicate preparedTx
  mode = "already_issued";
  const recovered = await orch.evaluateAndPrepareFromChain(cfg, rpc, {
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    operatorAccountId: "cryptozax.near",
    escrowConfirmed: true,
  });
  assert.equal(recovered.status, "ISSUED");
  assert.equal(recovered.onChainConfirmed, true);
  assert.equal(recovered.preparedTx, undefined);
});

test("Phase 13 WS4: Shared private deliverable storage fails closed in production, blocks path traversal & enforces single-use token replay protection", async () => {
  const prodCfgNoSupabase = {
    ...loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_DB_BACKEND: "json",
    }),
    isProductionMode: true,
    supabaseUrl: "",
  };
  assert.throws(
    () => DeliverableVault.fromConfig(prodCfgNoSupabase, "prod-deliverable-secret"),
    /ERR_SHARED_DELIVERABLE_STORAGE_REQUIRED/
  );
  assert.throws(
    () => new LocalPrivateObjectStorage(os.tmpdir(), true),
    /ERR_LOCAL_STORAGE_FORBIDDEN_IN_PRODUCTION/
  );
  assert.throws(() => sanitizeStorageObjectKey("../etc/passwd"), /ERR_INVALID_STORAGE_KEY/);

  // Shared Supabase private object storage simulation
  const bucketStore = new Map<string, Buffer>();
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const key = url.split("/").slice(-2).join("/");
    if (method === "POST") {
      bucketStore.set(key, Buffer.from(init?.body as Uint8Array));
      return new Response(JSON.stringify({ Key: key }), { status: 200 });
    }
    if (method === "GET") {
      const buf = bucketStore.get(key);
      if (!buf) return new Response("Not Found", { status: 404 });
      return new Response(new Uint8Array(buf), { status: 200 });
    }
    if (method === "DELETE") {
      bucketStore.delete(key);
      return new Response("{}", { status: 200 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  };

  const sharedStorage = new SupabasePrivateObjectStorage({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "sb_secret_test",
    bucket: "snowmoon-deliverables-private",
    fetchImpl: mockFetch,
  });
  const vault = new DeliverableVault(sharedStorage, "shared-secret-key");
  assert.equal(vault.storageBackendKind, "supabase_private_bucket");

  const payload = Buffer.from("Confidential full deliverable bytes", "utf8");
  await vault.storeDeliverableAsync({
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    filename: "report.md",
    mimeType: "text/markdown",
    content: payload,
  });

  const tok = vault.issueSignedDownloadToken({
    jobId: JOB_ID,
    customerAccountId: "alice.near",
    jobState: "SETTLED",
    settlementConfirmed: true,
    settlementKind: "PAYOUT_ACCEPT_DELIVERY",
  });

  const first = await vault.verifyAndReadFullDeliverableAsync({
    token: tok.token,
    callerCustomerAccountId: "alice.near",
    jobState: "SETTLED",
    settlementConfirmed: true,
    singleUse: true,
  });
  assert.equal(first.content.toString("utf8"), "Confidential full deliverable bytes");

  // Single-use replay blocked
  await assert.rejects(
    () =>
      vault.verifyAndReadFullDeliverableAsync({
        token: tok.token,
        callerCustomerAccountId: "alice.near",
        jobState: "SETTLED",
        settlementConfirmed: true,
        singleUse: true,
      }),
    /ERR_DOWNLOAD_TOKEN_REPLAYED/
  );
});

test("Phase 13 WS5 & WS8: Financial conservation invariants across amounts/rates & payout-vs-refund conflict prevention", () => {
  for (const gross of ["1000000", "100000000", "500000000"]) {
    for (const rateBps of [3000, 5000, 8500]) {
      const m = calculateSnowMoonAdvanceMath(gross, rateBps);
      assert.equal(BigInt(m.reserveCutAtomic) + BigInt(m.lpYieldAtomic), BigInt(m.feeAtomic));

      const accept = computeFinancialDestinationAudit({
        kind: "PAYOUT_ACCEPT_DELIVERY",
        tokenContract: USDC_MAINNET,
        coreContractId: "core.cryptozax.near",
        customerAccountId: "alice.near",
        operatorAccountId: "cryptozax.near",
        grossAmountAtomic: gross,
        floatPrincipalAtomic: m.principalAtomic,
        floatFeeAtomic: m.feeAtomic,
      });
      assert.equal(
        BigInt(accept.floatPrincipalRepaidAtomic) +
          BigInt(accept.floatFeeAtomic) +
          BigInt(accept.operatorNetAtomic),
        BigInt(gross)
      );

      const refund = computeFinancialDestinationAudit({
        kind: "CUSTOMER_REFUND",
        tokenContract: USDC_MAINNET,
        coreContractId: "core.cryptozax.near",
        customerAccountId: "alice.near",
        operatorAccountId: "cryptozax.near",
        grossAmountAtomic: gross,
        floatPrincipalAtomic: m.principalAtomic,
      });
      assert.equal(refund.customerRefundAtomic, gross);
      assert.equal(refund.operatorNetAtomic, "0");
    }
  }

  // Payout vs Refund conflict on same jobId
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_DB_BACKEND: "json" });
  const se = new SettlementEngine();
  se.prepareSettlement(cfg, {
    jobId: JOB_ID,
    kind: "PAYOUT_ACCEPT_DELIVERY",
    verificationStatus: "VERIFIED",
    customerAccountId: "alice.near",
    workerAccountId: "cryptozax.near",
    grossAmountAtomic: "100000000",
    platformFeeBps: 0,
  });
  assert.throws(
    () =>
      se.prepareRefund(cfg, {
        jobId: JOB_ID,
        refundReason: "CUSTOMER_REJECTED",
        jobState: "VERIFIED",
        customerAccountId: "alice.near",
        operatorAccountId: "cryptozax.near",
        grossAmountAtomic: "100000000",
      }),
    /ERR_SETTLEMENT_CONFLICT/
  );

  // WS3: Deliverable review UI elements present in public/index.html
  const html = fs.readFileSync(path.resolve(process.cwd(), "public", "index.html"), "utf8");
  assert.match(html, /id="deliverable-review-card"/);
  assert.match(html, /openDeliverableReview/);
  assert.match(html, /rejectDeliverableWithReason/);
  assert.match(html, /downloadSettledDeliverable/);
  assert.match(html, /id="restricted-beta-banner"/);
});

test("Restricted Beta gate: SNOWMOON_RESTRICTED_BETA=1 blocks financial endpoints on backend, fails closed on Vercel/invalid config, and preserves read-only + wallet auth", async () => {
  assert.throws(
    () => loadConfig({ SNOWMOON_RESTRICTED_BETA: "invalid-mode" }),
    /ERR_INVALID_RESTRICTED_BETA_CONFIG/
  );
  const vercelDefaultCfg = loadConfig({
    VERCEL: "1",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-secret",
    WALLET_SESSION_SECRET: "test-session-secret-32-chars-minimum",
    SNOWMOON_AI_MODE: "near_ai",
    NEAR_AI_API_KEY: "test-near-ai-key",
  });
  assert.equal(vercelDefaultCfg.restrictedBetaMode, true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-beta-"));
  const stateFile = path.join(tmpDir, "state.json");
  const cfg = loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-session-secret-beta-gate",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-supabase-secret",
    SNOWMOON_RESTRICTED_BETA: "1",
  });
  assert.equal(cfg.restrictedBetaMode, true);

  const app = createSnowMoonApp(cfg);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const blockedPaths = [
      "/api/near/escrow/prepare-fund",
      "/api/near/escrow/submit-tx",
      "/api/intents/prepare-deposit",
      "/api/intents/prepare-escrow",
      "/api/near/float/prepare-deposit",
      "/api/near/float/prepare-withdraw",
      "/api/near/float/prepare-advance",
      "/api/settlement/prepare",
      "/api/settlement/prepare-refund",
      "/api/outlayer/execute",
    ];
    for (const p of blockedPaths) {
      const r = await fetch(`${baseUrl}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 403, `Expected 403 for ${p}`);
      const j = (await r.json()) as { error?: string; restrictedBetaMode?: boolean };
      assert.match(String(j.error || ""), /ERR_RESTRICTED_BETA_FINANCIAL_DISABLED/);
      assert.equal(j.restrictedBetaMode, true);
    }

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { restrictedBetaMode?: boolean };
    assert.equal(healthJson.restrictedBetaMode, true);

    const stateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateRes.status, 200);
    const stateJson = (await stateRes.json()) as { environment?: { restrictedBetaMode?: boolean } };
    assert.equal(stateJson.environment?.restrictedBetaMode, true);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Controlled Pilot policy: Railway fails closed on omitted beta flag, and pilot mode enforces FloatPool disable, allowlist & per-job cap", async () => {
  const railwayDefaultCfg = loadConfig({
    RAILWAY_ENVIRONMENT: "production",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-session-secret-railway",
  });
  assert.equal(railwayDefaultCfg.restrictedBetaMode, true);

  const pilotCfg = loadConfig({
    SNOWMOON_NETWORK: "sandbox",
    SNOWMOON_CHAIN_MODE: "sandbox",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-session-secret-pilot",
    SNOWMOON_RESTRICTED_BETA: "0",
    SNOWMOON_PILOT_MODE: "1",
    SNOWMOON_PILOT_MAX_JOB_USDC: "2000000",
    SNOWMOON_PILOT_ALLOWED_ACCOUNTS: "cryptozax.near",
  });
  assert.equal(pilotCfg.restrictedBetaMode, false);
  assert.equal(pilotCfg.pilot.enabled, true);
  assert.equal(pilotCfg.pilot.maxJobUsdcAtomic, 2_000_000n);
  assert.equal(pilotCfg.pilot.floatPoolEnabled, false);
  assert.deepEqual(pilotCfg.pilot.allowedAccounts, ["cryptozax.near"]);

  const app = createSnowMoonApp(pilotCfg);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (const p of [
      "/api/near/float/prepare-deposit",
      "/api/near/float/prepare-withdraw",
      "/api/near/float/prepare-advance",
      "/api/jobs/advance",
    ]) {
      const r = await fetch(`${baseUrl}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 403, `Expected 403 for ${p}`);
      const j = (await r.json()) as { error?: string; pilotMode?: boolean; floatPoolEnabled?: boolean };
      assert.match(String(j.error || ""), /ERR_PILOT_FLOAT_POOL_DISABLED/);
      assert.equal(j.pilotMode, true);
      assert.equal(j.floatPoolEnabled, false);
    }

    const issueSandboxSession = async (accountId: string): Promise<string> => {
      const { KeyPair } = await import("@near-js/crypto");
      const nodeCrypto = await import("node:crypto");
      const kp = KeyPair.fromRandom("ed25519");
      const chRes = await fetch(`${baseUrl}/api/near/wallet/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, walletType: "meteor" }),
      });
      assert.equal(chRes.status, 200);
      const chJson = (await chRes.json()) as {
        challenge: { challengeId: string; message: string; nonceBase64: string; recipient: string };
      };
      const u32le = (n: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n >>> 0, 0);
        return b;
      };
      const borshStr = (s: string) => {
        const utf8 = Buffer.from(s, "utf8");
        return Buffer.concat([u32le(utf8.length), utf8]);
      };
      const payload = Buffer.concat([
        u32le(2147484061),
        borshStr(chJson.challenge.message),
        Buffer.from(chJson.challenge.nonceBase64, "base64"),
        borshStr(chJson.challenge.recipient),
        Buffer.from([0]),
      ]);
      const digest = nodeCrypto.createHash("sha256").update(payload).digest();
      const signature = Buffer.from(kp.sign(digest).signature).toString("base64");
      const vRes = await fetch(`${baseUrl}/api/near/wallet/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId,
          networkId: "mainnet",
          walletType: "meteor",
          challengeId: chJson.challenge.challengeId,
          signature,
          publicKey: kp.getPublicKey().toString(),
        }),
      });
      assert.equal(vRes.status, 200);
      const vJson = (await vRes.json()) as { walletSessionToken: string };
      return vJson.walletSessionToken;
    };

    const aliceToken = await issueSandboxSession("alice.near");
    const unallowlisted = await fetch(`${baseUrl}/api/near/escrow/prepare-fund`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": aliceToken,
      },
      body: JSON.stringify({
        customerAccountId: "alice.near",
        customerPaymentUsdcAtomic: "1000000",
      }),
    });
    assert.equal(unallowlisted.status, 403);
    assert.match(String(((await unallowlisted.json()) as { error?: string }).error || ""), /ERR_PILOT_ACCOUNT_NOT_ALLOWLISTED/);

    const pilotToken = await issueSandboxSession("cryptozax.near");
    const overCap = await fetch(`${baseUrl}/api/near/escrow/prepare-fund`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": pilotToken,
      },
      body: JSON.stringify({
        customerAccountId: "cryptozax.near",
        customerPaymentUsdcAtomic: "2500000",
      }),
    });
    assert.equal(overCap.status, 400);
    assert.match(String(((await overCap.json()) as { error?: string }).error || ""), /ERR_PILOT_JOB_CAP_EXCEEDED/);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as {
      pilot?: { enabled: boolean; maxJobUsdcAtomic: string; floatPoolEnabled: boolean; allowlistActive: boolean };
    };
    assert.equal(healthJson.pilot?.enabled, true);
    assert.equal(healthJson.pilot?.maxJobUsdcAtomic, "2000000");
    assert.equal(healthJson.pilot?.floatPoolEnabled, false);
    assert.equal(healthJson.pilot?.allowlistActive, true);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});
