import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { NearIntentsClient } from "../src/near_intents.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("29. Phase 13.1 & 13.3 Least-privilege RLS migration + NEAR Intents tenant isolation", async () => {
  const rlsSqlPath = path.resolve(process.cwd(), "migrations", "002_rls_hardening.sql");
  assert.ok(fs.existsSync(rlsSqlPath), "002_rls_hardening.sql must exist");
  const rlsSql = fs.readFileSync(rlsSqlPath, "utf8");
  assert.ok(rlsSql.includes("FORCE ROW LEVEL SECURITY"));
  assert.ok(rlsSql.includes("REVOKE ALL ON TABLE public.%I FROM anon"));
  assert.ok(rlsSql.includes("REVOKE ALL ON TABLE public.%I FROM authenticated"));
  assert.ok(rlsSql.includes("GRANT ALL ON TABLE public.%I TO service_role"));

  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const depositAddr = "0xintent_alice_only";
  let balance = "1000000";
  const mockRpc = {
    inspectMainnetAccount: async (accountId: string) => ({
      accountId,
      exists: true,
      amountNear: "5.0000",
      usdcBalanceAtomic: balance,
    }),
    prepareUsdcEscrowAndJobPayloads: () => ({
      broadcastingEnabled: false,
      executionStatus: "NOT_EXECUTED_UNSIGNED_DRAFT",
      walletSigned: false,
      onChainVerified: false,
      mode: "UNSIGNED_PREPARATION_ONLY",
      transactions: [],
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
    if (url.includes("/v0/status")) {
      return new Response(JSON.stringify({ status: "SUCCESS" }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const client = new NearIntentsClient(cfg, mockFetch);
  await client.requestQuote(mockRpc, {
    dry: false,
    originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    amountAtomic: "5000000",
    slippageToleranceBps: 100,
    customerNearAccount: "alice.near",
    sourceWalletAddress: "0x1111111111111111111111111111111111111111",
  });
  await client.pollStatus(depositAddr);
  balance = "6000000";
  await client.verifyDestinationDelivery(mockRpc, {
    depositAddress: depositAddr,
    expectedRecipient: "alice.near",
  });

  // Cross-tenant access blocked: bob.near cannot bridge alice.near's intent
  assert.throws(
    () =>
      client.prepareCoreEscrowFromIntent(mockRpc, {
        depositAddress: depositAddr,
        workerAccountId: "worker.near",
        deadlineSec: Math.floor(Date.now() / 1000) + 3600,
        termsHash: "0x" + "11".repeat(32),
        expectedCustomerAccount: "bob.near",
      }),
    /ERR_CUSTOMER_MISMATCH/
  );
});

test("30. Phase 13.2 HTTP security regression: job cancel ownership & zero frontend secret exposure", async () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "public", "index.html"), "utf8");
  for (const secretName of [
    "SUPABASE_SECRET_KEY",
    "OUTLAYER_PAYMENT_KEY",
    "NEAR_AI_API_KEY",
    "NEAR_PRIVATE_KEY",
  ]) {
    assert.ok(!html.includes(secretName), `Frontend must not reference ${secretName}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p13-http-"));
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
    const jobId = "0x" + "f3".repeat(32);
    app.workforceEngine.registerJob({
      jobId,
      customerAccountId: "alice.near",
      amountAtomic: "2000000",
      requiredCapabilities: ["research"],
      prompt: "Auth test",
      deadlineSec: Math.floor(Date.now() / 1000) + 3600,
      funded: true,
    });

    // Unauthenticated cancel -> 401
    const unauth = await fetch(`${baseUrl}/api/workforce/jobs/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    assert.equal(unauth.status, 401);

    // Wrong customer session -> 403/401
    const bobToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "bob.near",
      walletType: "meteor",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const wrongOwner = await fetch(`${baseUrl}/api/workforce/jobs/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": bobToken,
      },
      body: JSON.stringify({ jobId }),
    });
    assert.ok(wrongOwner.status === 401 || wrongOwner.status === 403);

    // Owning customer session -> 200
    const aliceToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "alice.near",
      walletType: "meteor",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const okCancel = await fetch(`${baseUrl}/api/workforce/jobs/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": aliceToken,
      },
      body: JSON.stringify({ jobId }),
    });
    assert.equal(okCancel.status, 200);
    const json = (await okCancel.json()) as { ok: boolean; job: { state: string } };
    assert.equal(json.ok, true);
    assert.equal(json.job.state, "CANCELLED");
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

