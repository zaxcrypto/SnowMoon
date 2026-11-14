import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { SnowMoonEngine } from "../src/engine.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { createSnowMoonApp, PRODUCTION_ROUTE_POLICY } from "../src/server.ts";
import { WorkforceEngine } from "../src/workforce.ts";

function makeTempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase21-"));
  return path.join(dir, "state.json");
}

function makeProdConfig(stateFile: string) {
  return loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "development",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-phase21-secret",
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

test("OutLayer TEE Audit: idempotency prevents duplicate paid calls, rejects output.jobId mismatch, and Workforce fails closed", async () => {
  const stateFile = makeTempStateFile();
  const cfg = loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "development",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-phase21-secret",
    OUTLAYER_BASE_URL: "https://api.outlayer.ai",
    OUTLAYER_PAYMENT_KEY: "cryptozax.near:1:dummy_test_secret",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-tee-worker",
    OUTLAYER_COMPUTE_LIMIT: "10000",
    OUTLAYER_EXPECTED_WASM_HASH: "a".repeat(64),
  });

  let postCount = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/call/")) {
      postCount += 1;
      return new Response(
        JSON.stringify({
          call_id: "call_tee_1",
          status: "completed",
          output: { jobId: "wrong-job-id", teeVerdict: "VERIFIED_IN_TEE" },
          compute_cost: "1000",
          attestation_url: "/attestations/by-call/call_tee_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/attestations/by-call/call_tee_1")) {
      return new Response(
        JSON.stringify({
          wasm_hash: "a".repeat(64),
          input_hash: "b".repeat(64), // won't match + output.jobId won't match
          output_hash: "c".repeat(64),
          tdx_quote: "00".repeat(64),
          worker_measurement: "m".repeat(64),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };

  const ol = new OutLayerExecutionAdapter(cfg, mockFetch);
  const res1 = await ol.executeAndVerify({
    jobId: "job-tee-1",
    workerId: "w-tee-1",
    prompt: "audit",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(res1.status, "ATTESTATION_FAILED");
  assert.equal(res1.attestationChecks?.jobBindingVerified, false);

  // WorkforceEngine must fail closed when live OutLayer returns ATTESTATION_FAILED
  const wf = new WorkforceEngine();
  wf.registerWorker({
    workerId: "w-tee-1",
    accountId: "worker.near",
    displayName: "TEE Worker",
    capabilities: ["audit"],
    maxConcurrentJobs: 2,
  });
  wf.registerJob({
    jobId: "job-tee-1",
    customerAccountId: "alice.near",
    amountAtomic: "1000000",
    requiredCapabilities: ["audit"],
    prompt: "audit",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    funded: true,
  });
  wf.assignJob("job-tee-1", "w-tee-1");
  wf.acceptJob("job-tee-1", "w-tee-1");

  const ai = new AIWorkerAdapter(
    { ...cfg, aiMode: "near_ai", hasNearAiKey: true, secrets: { ...cfg.secrets, nearAiApiKey: "sk-test" } },
    async () =>
      new Response(
        JSON.stringify({ id: "chat-1", model: "deepseek/deepseek-v3.2", choices: [{ message: { content: "TEE audit ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  await assert.rejects(
    () =>
      wf.executeJob({
        jobId: "job-tee-1",
        workerId: "w-tee-1",
        aiAdapter: ai,
        outlayerAdapter: ol,
        maxRetries: 0,
      }),
    /ERR_OUTLAYER_TEE_FAILED/
  );
  assert.equal(wf.getJob("job-tee-1")?.state, "FAILED");

  // Idempotency: if a call is EXECUTION_PENDING or ATTESTATION_VERIFIED, a duplicate call does NOT re-POST
  postCount = 0;
  let pendingPostCount = 0;
  const pendingFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/call/")) {
      pendingPostCount += 1;
      return new Response(
        JSON.stringify({ call_id: "call_pending_1", status: "pending" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
  const olPending = new OutLayerExecutionAdapter(cfg, pendingFetch);
  const p1 = await olPending.executeAndVerify({
    jobId: "job-idem-1",
    workerId: "w-tee-1",
    prompt: "same prompt",
    evidenceHash: "0x" + "22".repeat(32),
  });
  const p2 = await olPending.executeAndVerify({
    jobId: "job-idem-1",
    workerId: "w-tee-1",
    prompt: "same prompt",
    evidenceHash: "0x" + "22".repeat(32),
  });
  assert.equal(pendingPostCount, 1);
  assert.equal(p1.requestId, p2.requestId);
  assert.equal(postCount, 0);

  // WorkforceEngine must ALSO fail closed if live OutLayer returns EXECUTION_PENDING (not ATTESTATION_VERIFIED)
  wf.registerJob({
    jobId: "job-tee-pending",
    customerAccountId: "alice.near",
    amountAtomic: "1000000",
    requiredCapabilities: ["audit"],
    prompt: "audit pending",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    funded: true,
  });
  wf.assignJob("job-tee-pending", "w-tee-1");
  wf.acceptJob("job-tee-pending", "w-tee-1");
  await assert.rejects(
    () =>
      wf.executeJob({
        jobId: "job-tee-pending",
        workerId: "w-tee-1",
        aiAdapter: ai,
        outlayerAdapter: olPending,
        maxRetries: 0,
      }),
    /ERR_OUTLAYER_TEE_FAILED \(EXECUTION_PENDING\)/
  );
  assert.equal(wf.getJob("job-tee-pending")?.state, "FAILED");

  // Production verifyAttestation must fail closed if OUTLAYER_EXPECTED_WASM_HASH is not set
  const prodNoHashCfg = loadConfig({
    NODE_ENV: "production",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    WALLET_SESSION_SECRET: "test-phase21-secret",
    OUTLAYER_PAYMENT_KEY: "alice.near:1:secret",
    OUTLAYER_PROJECT_OWNER: "alice.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
  });
  const prodOl = new OutLayerExecutionAdapter(prodNoHashCfg, async (input) => {
    const url = String(input);
    if (url.includes("/call/")) {
      return new Response(
        JSON.stringify({
          call_id: "call_prod_1",
          status: "completed",
          output: { jobId: "job-prod-1" },
          attestation_url: "/attestations/by-call/call_prod_1",
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        wasm_hash: "aa".repeat(32),
        input_hash: crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              jobId: "job-prod-1",
              workerId: "w-1",
              prompt: "p",
              evidenceHash: "0x" + "11".repeat(32),
            })
          )
          .digest("hex"),
        output_hash: crypto
          .createHash("sha256")
          .update(JSON.stringify({ jobId: "job-prod-1" }))
          .digest("hex"),
        tdx_quote: "quote_bytes_placeholder_at_least_32_characters_long",
        worker_measurement: "mrtd_123",
      }),
      { status: 200 }
    );
  });
  const prodRes = await prodOl.executeAndVerify({
    jobId: "job-prod-1",
    workerId: "w-1",
    prompt: "p",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(prodRes.status, "ATTESTATION_FAILED");
  assert.equal(prodRes.attestationChecks?.wasmHashVerified, false);

  // Per-call spending cap enforcement: computeLimit + attachedDeposit > OUTLAYER_MAX_PER_CALL must fail before POST
  let capPostCount = 0;
  const overCapCfg = loadConfig({
    OUTLAYER_PAYMENT_KEY: "alice.near:1:secret",
    OUTLAYER_PROJECT_OWNER: "alice.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
    OUTLAYER_COMPUTE_LIMIT: "80000",
    OUTLAYER_ATTACHED_DEPOSIT: "50000",
    OUTLAYER_MAX_PER_CALL: "100000",
  });
  const capOl = new OutLayerExecutionAdapter(overCapCfg, async () => {
    capPostCount += 1;
    return new Response("{}", { status: 200 });
  });
  const capRes = await capOl.executeAndVerify({
    jobId: "job-over-cap",
    workerId: "w-1",
    prompt: "over cap",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(capRes.status, "EXECUTION_FAILED");
  assert.match(capRes.error || "", /ERR_OUTLAYER_SPENDING_CAP_EXCEEDED/);
  assert.equal(capPostCount, 0);

  // Production attestation verification requires independent outlayer-verify root-of-trust
  const expectedHash = "aa".repeat(32);
  const prodHashCfg = loadConfig({
    NODE_ENV: "production",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    WALLET_SESSION_SECRET: "test-phase21-secret",
    OUTLAYER_PAYMENT_KEY: "alice.near:1:secret",
    OUTLAYER_PROJECT_OWNER: "alice.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
    OUTLAYER_EXPECTED_WASM_HASH: expectedHash,
  });
  const prodAttFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/call/")) {
      return new Response(
        JSON.stringify({
          call_id: "call_prod_verify_1",
          status: "completed",
          output: { jobId: "job-prod-verify" },
          attestation_url: "/attestations/by-call/call_prod_verify_1",
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        wasm_hash: expectedHash,
        input_hash: crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              jobId: "job-prod-verify",
              workerId: "w-1",
              prompt: "p",
              evidenceHash: "0x" + "11".repeat(32),
            })
          )
          .digest("hex"),
        output_hash: crypto
          .createHash("sha256")
          .update(JSON.stringify({ jobId: "job-prod-verify" }))
          .digest("hex"),
        tdx_quote: "quote_bytes_placeholder_at_least_32_characters_long",
        worker_measurement: "mrtd_123",
      }),
      { status: 200 }
    );
  };

  // Fails closed when outlayer-verify is unavailable
  const prodOlUnavailable = new OutLayerExecutionAdapter(prodHashCfg, prodAttFetch, undefined, async () => ({
    available: false,
    verified: false,
    command: "outlayer-verify tx call_prod_verify_1",
    stdout: "",
    stderr: "not installed",
  }));
  const unavailRes = await prodOlUnavailable.executeAndVerify({
    jobId: "job-prod-verify",
    workerId: "w-1",
    prompt: "p",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(unavailRes.status, "ATTESTATION_FAILED");
  assert.equal(unavailRes.attestationChecks?.cryptographicRootOfTrustVerified, false);

  // Succeeds when outlayer-verify verifies Intel DCAP root of trust
  const prodOlVerified = new OutLayerExecutionAdapter(prodHashCfg, prodAttFetch, undefined, async () => ({
    available: true,
    verified: true,
    command: "outlayer-verify tx call_prod_verify_1",
    stdout: "Verified",
    stderr: "",
  }));
  const verifiedRes = await prodOlVerified.executeAndVerify({
    jobId: "job-prod-verify",
    workerId: "w-1",
    prompt: "p",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(verifiedRes.status, "ATTESTATION_VERIFIED");
  assert.equal(verifiedRes.attestationChecks?.cryptographicRootOfTrustVerified, true);
});
