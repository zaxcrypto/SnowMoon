import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { createSnowMoonApp, PRODUCTION_ROUTE_POLICY } from "../src/server.ts";

function makeTempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase21-"));
  return path.join(dir, "state.json");
}

function makeProdConfig(stateFile: string) {
  return loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "production",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
  });
}

test("Phase 21: PRODUCTION_ROUTE_POLICY allowlist/denylist, auth, and tenant isolation", async () => {
  const stateFile = makeTempStateFile();
  const config = makeProdConfig(stateFile);
  const app = createSnowMoonApp(config);

  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Verify PRODUCTION_ROUTE_POLICY includes the new Mainnet tx builders
    assert.ok(
      PRODUCTION_ROUTE_POLICY.productionAllowedRoutes.walletSessionAuthenticated.includes(
        "/api/near/float/prepare-advance"
      )
    );
    assert.ok(
      PRODUCTION_ROUTE_POLICY.productionAllowedRoutes.walletSessionAuthenticated.includes(
        "/api/near/vault/prepare-start-work"
      )
    );
    assert.ok(
      PRODUCTION_ROUTE_POLICY.productionAllowedRoutes.walletSessionAuthenticated.includes(
        "/api/near/vault/prepare-submit-delivery"
      )
    );

    // 2. Verify all sandbox-only routes are blocked with 403 in production
    for (const blockedPath of [
      "/api/reset",
      "/api/audit/anchor",
      "/api/demo/run-complete-journey",
      "/api/jobs/create",
      "/api/float/deposit",
    ]) {
      const resp = await fetch(`${baseUrl}${blockedPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(resp.status, 403, `${blockedPath} must be 403 in production`);
      const json = (await resp.json()) as { ok: boolean; error: string };
      assert.equal(json.ok, false);
      assert.match(json.error, /ERR_SANDBOX_ENDPOINT_DISABLED_IN_PRODUCTION/);
    }

    // 3. Verify unauthenticated mutation routes reject in production
    for (const [routePath, body] of [
      ["/api/workforce/workers/register", { workerId: "w1", accountId: "w1.near", displayName: "W1" }],
      ["/api/workforce/jobs/register", { jobId: "j1", customerAccountId: "alice.near", prompt: "test" }],
      ["/api/workforce/jobs/accept", { jobId: "j1", workerId: "w1" }],
      ["/api/workforce/jobs/execute", { jobId: "j1", workerId: "w1" }],
      ["/api/settlement/prepare", { jobId: "j1", customerAccountId: "alice.near" }],
      ["/api/near/escrow/reconcile", { txHash: "11111111111111111111111111111111", customerAccountId: "alice.near" }],
      ["/api/outlayer/execute", { jobId: "j1", workerId: "w1", prompt: "test" }],
    ] as const) {
      const resp = await fetch(`${baseUrl}${routePath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok(
        resp.status === 401 || resp.status === 403,
        `${routePath} must reject unauthenticated requests in production, got ${resp.status}`
      );
    }

    // 4. Issue wallet sessions for alice.near (customer) and cryptozax.near (operator)
    const aliceToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "alice.near",
      networkId: "mainnet",
      walletType: "mynearwallet",
      verifiedAt: new Date().toISOString(),
    });
    const operatorToken = app.walletSessionManager.issueToken({
      connected: true,
      accountId: "cryptozax.near",
      networkId: "mainnet",
      walletType: "meteor",
      verifiedAt: new Date().toISOString(),
    });

    // 5. Tenant isolation: alice.near cannot prepare operator advance for cryptozax.near
    const impResp = await fetch(`${baseUrl}/api/near/float/prepare-advance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": aliceToken,
      },
      body: JSON.stringify({
        operatorAccountId: "cryptozax.near",
        jobId: "0x" + "ab".repeat(32),
        expectedPrincipalAtomic: "500000",
      }),
    });
    assert.equal(impResp.status, 403);
    const impJson = (await impResp.json()) as { error: string };
    assert.match(impJson.error, /ERR_ACCOUNT_IMPERSONATION_BLOCKED/);

    // 6. Authorized operator can prepare advance, start_work, and submit_delivery
    const jobId = "0x" + "cd".repeat(32);
    const advResp = await fetch(`${baseUrl}/api/near/float/prepare-advance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": operatorToken,
      },
      body: JSON.stringify({
        operatorAccountId: "cryptozax.near",
        jobId,
        expectedPrincipalAtomic: "500000",
      }),
    });
    assert.equal(advResp.status, 200);
    const advJson = (await advResp.json()) as {
      ok: boolean;
      transaction: {
        signerId: string;
        receiverId: string;
        actions: Array<{ methodName: string; args: Record<string, unknown>; gas: string; depositYocto: string }>;
      };
    };
    assert.equal(advJson.ok, true);
    assert.equal(advJson.transaction.signerId, "cryptozax.near");
    assert.equal(advJson.transaction.receiverId, "core.cryptozax.near");
    assert.equal(advJson.transaction.actions[0].methodName, "request_advance");
    assert.deepEqual(advJson.transaction.actions[0].args, {
      job_id: jobId,
      expected_principal: "500000",
    });
    assert.ok(BigInt(advJson.transaction.actions[0].gas) >= 110_000_000_000_000n);
    assert.equal(advJson.transaction.actions[0].depositYocto, "0");

    const startResp = await fetch(`${baseUrl}/api/near/vault/prepare-start-work`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": operatorToken,
      },
      body: JSON.stringify({ operatorAccountId: "cryptozax.near", jobId }),
    });
    assert.equal(startResp.status, 200);
    const startJson = (await startResp.json()) as {
      transaction: { actions: Array<{ methodName: string; args: Record<string, unknown> }> };
    };
    assert.equal(startJson.transaction.actions[0].methodName, "start_work");
    assert.deepEqual(startJson.transaction.actions[0].args, { job_id: jobId });

    const delivHash = "0x" + "ef".repeat(32);
    const delivResp = await fetch(`${baseUrl}/api/near/vault/prepare-submit-delivery`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": operatorToken,
      },
      body: JSON.stringify({
        operatorAccountId: "cryptozax.near",
        jobId,
        deliveryHash: delivHash,
      }),
    });
    assert.equal(delivResp.status, 200);
    const delivJson = (await delivResp.json()) as {
      transaction: { actions: Array<{ methodName: string; args: Record<string, unknown> }> };
    };
    assert.equal(delivJson.transaction.actions[0].methodName, "submit_delivery");
    assert.deepEqual(delivJson.transaction.actions[0].args, {
      job_id: jobId,
      delivery_hash: delivHash,
    });
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 21: Mainnet ABI validation & no silent OutLayer mock fallback in production", async () => {
  const stateFile = makeTempStateFile();
  const prodConfig = makeProdConfig(stateFile);
  const rpc = new NearMainnetRpcAdapter(prodConfig);

  // Zero delivery hash must be rejected to match snapfall-core ERR_ZERO_HASH
  assert.throws(
    () =>
      rpc.prepareVaultSubmitDeliveryPayload({
        operatorAccountId: "cryptozax.near",
        jobId: "0x" + "12".repeat(32),
        deliveryHash: "0x" + "00".repeat(32),
      }),
    /ERR_ZERO_HEX32/
  );

  // OutLayer in production must fail explicitly rather than returning MOCK_EXECUTION
  const outlayer = new OutLayerExecutionAdapter(prodConfig);
  const rec = await outlayer.executeAndVerify({
    jobId: "job-prod-1",
    workerId: "worker-1",
    prompt: "verify prod gating",
    evidenceHash: "0x" + "aa".repeat(32),
  });
  assert.equal(rec.status, "EXECUTION_FAILED");
  assert.match(rec.error || "", /ERR_OUTLAYER_NOT_CONFIGURED_IN_PRODUCTION/);
});
