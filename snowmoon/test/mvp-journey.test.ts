import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import {
  deriveJobId,
  JOB_STORAGE_DEPOSIT_INITIAL,
  SnowMoonEngine,
} from "../src/engine.ts";
import { AIWorkerAdapter, OutLayerPolicyAdapter } from "../src/adapters.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("1. Contract-derived Job ID matches snowmoon-core/job-id/v1 deterministic scheme", () => {
  const id0 = deriveJobId("customer.snowmoon.test.near", 0);
  const id1 = deriveJobId("customer.snowmoon.test.near", 1);
  assert.match(id0, /^0x[0-9a-f]{64}$/);
  assert.match(id1, /^0x[0-9a-f]{64}$/);
  assert.notEqual(id0, id1);
});

test("2. Unfunded Created job cancellation deletes record and refunds 100% of 0.023 NEAR deposit", () => {
  const config = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_WALLET_MODE: "mock" });
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
  const config = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_WALLET_MODE: "mock" });
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
  const config = loadConfig({ SNOWMOON_AI_MODE: "mock", SNOWMOON_WALLET_MODE: "mock" });
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

test("5. Live NEAR AI Cloud adapter configuration, token usage, timeout/error fallback, and secret redaction (zero live credits spent)", async () => {
  const testSecretKey = "sk-near-ai-secret-do-not-expose-999";
  const config = loadConfig({
    SNOWMOON_AI_MODE: "auto",
    NEAR_AI_BASE_URL: "https://cloud-api.near.ai/v1/",
    NEAR_AI_MODEL: "fireworks::accounts/fireworks/models/llama-v3p3-70b-instruct",
    NEAR_AI_TIMEOUT_MS: "5000",
    NEAR_AI_API_KEY: testSecretKey,
  });

  // Verify config parsing & endpoint resolution
  assert.equal(config.aiMode, "near_ai");
  assert.equal(config.nearAiBaseUrl, "https://cloud-api.near.ai/v1");
  assert.equal(config.nearAiModel, "fireworks::accounts/fireworks/models/llama-v3p3-70b-instruct");
  assert.equal(config.hasNearAiKey, true);

  const engine = new SnowMoonEngine(config);
  const policy = new OutLayerPolicyAdapter(config, engine);
  const job = engine.createJob({
    creator: config.customerAccountId,
    customer: config.customerAccountId,
    operator: config.operatorAccountId,
    title: "Live Adapter Config Verification Job",
    taskDescription: "Verify NEAR AI Cloud request construction and token telemetry.",
    customerPaymentUsdc: 50_000_000n,
    maxOperatingBudgetUsdc: 10_000_000n,
    fundImmediately: true,
  });

  // 5a: Verify public snapshot NEVER exposes `secrets` or `nearAiApiKey`
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: { model?: string } = {};

  const stubSuccessFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    capturedAuth = headers?.Authorization || "";
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-near-ai-test-001",
        model: config.nearAiModel,
        choices: [
          {
            message: {
              content: "# Live NEAR AI Deliverable\nVerified liquidity and storage safety invariants.",
            },
          },
        ],
        usage: {
          prompt_tokens: 94,
          completion_tokens: 42,
          total_tokens: 136,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const liveAdapter = new AIWorkerAdapter(config, stubSuccessFetch);
  assert.equal(liveAdapter.getChatCompletionsUrl(), "https://cloud-api.near.ai/v1/chat/completions");

  const execRes = await liveAdapter.executeJobTask(job);
  assert.equal(capturedUrl, "https://cloud-api.near.ai/v1/chat/completions");
  assert.equal(capturedAuth, `Bearer ${testSecretKey}`);
  assert.equal(capturedBody.model, "fireworks::accounts/fireworks/models/llama-v3p3-70b-instruct");
  assert.equal(execRes.adapterMode, "near_ai");
  assert.equal(execRes.endpoint, "https://cloud-api.near.ai/v1/chat/completions");
  assert.equal(execRes.requestId, "chatcmpl-near-ai-test-001");
  assert.deepEqual(execRes.tokenUsage, {
    promptTokens: 94,
    completionTokens: 42,
    totalTokens: 136,
  });
  assert.match(execRes.deliverableMarkdown, /LIVE NEAR AI CLOUD — REAL INFERENCE RESPONSE/);

  // 5b: Verify error & secret redaction on upstream failure -> falls back to clearly labelled mock adapter
  const stubErrorFetch: typeof fetch = async () => {
    return new Response(
      `Unauthorized key ${testSecretKey} with Bearer ${testSecretKey}`,
      { status: 401, statusText: "Unauthorized" }
    );
  };
  const fallbackAdapter = new AIWorkerAdapter(config, stubErrorFetch);
  const fallbackRes = await fallbackAdapter.executeJobTask(job);
  assert.equal(fallbackRes.adapterMode, "mock");
  assert.equal(
    fallbackRes.adapterLabel,
    "MOCK AI WORKER ADAPTER (FALLBACK AFTER LIVE API ERROR)"
  );
  assert.ok(fallbackRes.fallbackReason);
  assert.equal(fallbackRes.fallbackReason.includes(testSecretKey), false);
  assert.equal(fallbackRes.deliverableMarkdown.includes(testSecretKey), false);

  // Verify `/api/state` serialization never leaks the secret key
  const app = createSnowMoonApp(config);
  const stateJson = JSON.stringify(
    app.engine.jobs.get(job.jobId) ?? {}
  ) + JSON.stringify(policy.getAdapterLabel());
  assert.equal(stateJson.includes(testSecretKey), false);
});

test("6. Live OutLayer read-only wallet & policy adapter parses Mainnet wallet identity, balances, policy rules, and redacts API key on error", async () => {
  const testOutlayerKey = "wk_secret_outlayer_key_do_not_expose_777";
  const config = loadConfig({
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "auto",
    OUTLAYER_BASE_URL: "https://api.outlayer.ai/wallet/v1/",
    OUTLAYER_API_KEY: testOutlayerKey,
  });

  assert.equal(config.walletMode, "outlayer");
  assert.equal(config.outlayerBaseUrl, "https://api.outlayer.ai");
  assert.equal(config.hasOutlayerKey, true);

  const engine = new SnowMoonEngine(config);
  const calledPaths: string[] = [];

  const stubOutlayerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calledPaths.push(url.pathname + url.search);
    assert.equal(init?.method, "GET");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, `Bearer ${testOutlayerKey}`);

    if (url.pathname === "/wallet/v1/address") {
      return new Response(
        JSON.stringify({
          wallet_id: "12fb4cac-a0fd-4a55-a947-e5873aea3002",
          chain: "near",
          address: "88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
          account_type: "executor",
          executor_account_id: "88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
          controller_account_id: "ed25519:88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
          public_key: "ed25519:88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
          authorized_key_hash: "11532baf2d0e25a36d39e682c7027a773e76acb0c5f2c6efdf503f6c69071563",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname === "/wallet/v1/balance" && !url.searchParams.get("token")) {
      return new Response(
        JSON.stringify({ balance: "0", token: "near", source: "rpc" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname === "/wallet/v1/balance" && url.searchParams.get("token")) {
      return new Response(
        JSON.stringify({ balance: "0", token: url.searchParams.get("token"), source: "intents" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname === "/wallet/v1/policy") {
      return new Response(
        JSON.stringify({
          version: 1,
          policy: "stored",
          frozen: false,
          locked: false,
          rules: {
            limits: {
              per_transaction: { native: "100000000000000000000000" },
              hourly: { native: "500000000000000000000000" },
              daily: { native: "1000000000000000000000000" },
              monthly: { native: "5000000000000000000000000" },
            },
            rate_limit: { max_per_hour: 5 },
            transaction_types: ["transfer", "call", "delete", "intents_withdraw", "intents_swap"],
          },
          approval: {
            approvers: [{ id: "cryptozax.near", role: "admin" }],
            threshold: { required: 1 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname === "/wallet/v1/requests") {
      return new Response(
        JSON.stringify({ requests: [], total: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  const policyAdapter = new OutLayerPolicyAdapter(config, engine, stubOutlayerFetch);
  const status = await policyAdapter.syncLiveWalletStatus();

  assert.equal(status.authenticated, true);
  assert.equal(status.mode, "live_read_only");
  assert.equal(status.network, "mainnet");
  assert.equal(status.walletId, "12fb4cac-a0fd-4a55-a947-e5873aea3002");
  assert.equal(status.agentAccountRole, "executor");
  assert.equal(
    status.nearAddress,
    "88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169"
  );
  assert.ok(status.policy);
  assert.deepEqual(status.policy!.approvers, [{ id: "cryptozax.near", role: "admin" }]);
  assert.equal(status.policy!.approvalThresholdRequired, 1);
  assert.equal(status.remotePendingRequestsCount, 0);
  assert.equal(calledPaths.length, 5);
  assert.equal(JSON.stringify(status).includes(testOutlayerKey), false);
});

test("7. Deterministic NEAR Mainnet RPC adapter verifies WASM artifacts, USDC metadata/balances, contract status, tx-status & unsigned ft_transfer_call preparation", async () => {
  const config = loadConfig({
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    NEAR_MAINNET_RPC_URL: "https://rpc.mainnet.mock.local",
  });

  const mockRpcFetch: typeof fetch = async (_input, init) => {
    const req = JSON.parse(String(init?.body || "{}")) as {
      method?: string;
      params?: { request_type?: string; account_id?: string; method_name?: string; tx_hash?: string };
    };
    const encodeJson = (val: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(val), "utf8")) });

    if (req.method === "status") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chain_id: "mainnet", sync_info: { latest_block_height: 210_000_000 } } }), { status: 200 });
    }
    if (req.method === "tx" || req.method === "EXPERIMENTAL_tx_status") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          final_execution_status: "FINAL",
          status: { SuccessValue: "" },
          transaction: { signer_id: "cryptozax.near", receiver_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
          receipts_outcome: [],
        },
      }), { status: 200 });
    }
    if (req.method === "query" && req.params?.request_type === "view_account") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          amount: "1000000000000000000000000",
          locked: "0",
          storage_usage: 5000,
          code_hash: req.params.account_id === "core.cryptozax.near"
            ? "4yiQZbyTyJcwsGQcNfcNyAjeZ6EvBtmM2hgyrCKsg2gt"
            : req.params.account_id === "audit.cryptozax.near"
            ? "ACbfm2RGWE9oDHNvt8wKDRzdxAwtEAL6KtmWUZqmPoWg"
            : "11111111111111111111111111111111",
        },
      }), { status: 200 });
    }
    if (req.method === "query" && req.params?.request_type === "view_state") {
      const writeStr = (s: string) => {
        const b = Buffer.from(s, "utf8");
        const len = Buffer.alloc(4);
        len.writeUInt32LE(b.length, 0);
        return Buffer.concat([len, b]);
      };
      const zeroU32 = Buffer.alloc(4);
      const zeroU64 = Buffer.alloc(8);
      const borshState = Buffer.concat([
        writeStr("core.cryptozax.near"),
        writeStr("cryptozax.near"),
        writeStr("cryptozax.near"),
        Buffer.from([0]),
        zeroU64,
        zeroU32,
        zeroU32,
        zeroU32,
        zeroU64,
      ]);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            values: [
              {
                key: Buffer.from("STATE", "utf8").toString("base64"),
                value: borshState.toString("base64"),
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (req.method === "query" && req.params?.request_type === "call_function") {
      const m = req.params.method_name;
      if (m === "get_anchor") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson(null) }), { status: 200 });
      }
      if (m === "ft_metadata") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson({ spec: "ft-1.0.0", name: "USD Coin", symbol: "USDC", decimals: 6 }) }), { status: 200 });
      }
      if (m === "storage_balance_bounds") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson({ min: "1250000000000000000000", max: "1250000000000000000000" }) }), { status: 200 });
      }
      if (m === "storage_balance_of") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson({ total: "1250000000000000000000", available: "0" }) }), { status: 200 });
      }
      if (m === "ft_balance_of" || m === "storage_credit_of" || m === "storage_registration_of") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson("0") }), { status: 200 });
      }
      if (m === "accounting") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson({ escrowed_usdc: "0", total_assets: "0", total_outstanding: "0", total_written_off: "0", reserve: "0", total_shares: "0", share_epoch: 0, total_claimable_usdc: "0", total_in_flight_usdc: "0", flagged_stuck_count: 0, total_storage_credits: "0", total_storage_locked: "0", total_inflight_storage_near: "0", total_inflight_registration: "0", total_storage_registration: "0", next_job_seq: 1, vault_paused: false, pool_paused: false }) }), { status: 200 });
      }
      if (m === "admin") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson("cryptozax.near") }), { status: 200 });
      }
      if (m === "job_storage_deposit") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson("23000000000000000000000") }), { status: 200 });
      }
      if (m === "core_contract") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson("core.cryptozax.near") }), { status: 200 });
      }
      if (m === "operator_authority") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson("cryptozax.near") }), { status: 200 });
      }
      if (m === "get_anchor") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeJson(null) }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Unhandled mock RPC" } }), { status: 500 });
  };

  const nearAdapter = new NearMainnetRpcAdapter(config, mockRpcFetch);
  const status = await nearAdapter.syncMainnetStatus();

  // 7a: Verify live NEAR Mainnet RPC status
  assert.equal(status.rpcReachable, true);
  assert.equal(status.chainId, "mainnet");
  assert.ok(status.latestBlockHeight && status.latestBlockHeight > 200_000_000);
  assert.equal(status.liveTxBroadcastingEnabled, false);

  // 7b: Verify production WASM artifacts & storage stake calculations (when built locally)
  if (status.wasmArtifacts.core.exists) {
    assert.equal(status.wasmArtifacts.core.sizeBytes, 380364);
    assert.equal(
      status.wasmArtifacts.core.sha256Hex,
      "f468bdd0d60b894c963031a0a52f5030433d94ecb42cbc56d741cbf6e498a7b0"
    );
  }
  if (status.wasmArtifacts.audit.exists) {
    assert.equal(status.wasmArtifacts.audit.sizeBytes, 201048);
    assert.equal(
      status.wasmArtifacts.audit.sha256Hex,
      "4eaeadcc41e0a4c11d005d11f39fd148e38f21963c7e5e964c1b85a735cab6a2"
    );
  }

  // 7c: Verify live Mainnet native USDC NEP-141 ft_metadata & storage_balance_bounds
  assert.equal(
    status.usdcMainnet.contractId,
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
  );
  assert.ok(status.usdcMainnet.metadata);
  assert.equal(status.usdcMainnet.metadata!.symbol, "USDC");
  assert.equal(status.usdcMainnet.metadata!.decimals, 6);
  assert.equal(status.usdcMainnet.metadata!.spec, "ft-1.0.0");
  assert.equal(
    status.usdcMainnet.storageBalanceBounds?.min,
    "1250000000000000000000"
  );

  // 7d: Verify Mainnet accounts & deployed Core / undeployed Audit status
  assert.equal(status.accounts["cryptozax.near"]?.exists, true);
  assert.equal(status.accounts["core.cryptozax.near"]?.exists, true);
  assert.equal(status.accounts["core.cryptozax.near"]?.usdcStorageRegistered, true);
  assert.equal(
    status.contracts.core.deploymentStatus,
    "DEPLOYED_AND_INITIALIZED"
  );
  assert.equal(
    status.contracts.core.codeHash,
    "4yiQZbyTyJcwsGQcNfcNyAjeZ6EvBtmM2hgyrCKsg2gt"
  );
  assert.equal(status.contracts.core.admin, "cryptozax.near");
  const coreAcctView = status.contracts.core.viewQueryResult as {
    vault_paused: boolean;
    pool_paused: boolean;
    next_job_seq: number;
  };
  assert.equal(typeof coreAcctView.vault_paused, "boolean");
  assert.equal(typeof coreAcctView.pool_paused, "boolean");
  assert.equal(coreAcctView.next_job_seq, 1);
  assert.equal(
    status.contracts.audit.deploymentStatus,
    "DEPLOYED_AND_INITIALIZED"
  );
  assert.equal(
    status.contracts.audit.codeHash,
    "ACbfm2RGWE9oDHNvt8wKDRzdxAwtEAL6KtmWUZqmPoWg"
  );
  assert.equal(status.contracts.audit.coreContract, "core.cryptozax.near");
  assert.equal(status.contracts.audit.operatorAuthority, "cryptozax.near");
  assert.equal(status.contracts.audit.admin, "cryptozax.near");

  // 7d-2: Verify read-only Core storage credit & real Mainnet tx-status lookup
  const coreStorage = await nearAdapter.queryCoreStorageCredit("cryptozax.near");
  assert.equal(coreStorage.balance.ok, true);
  assert.equal(coreStorage.balance.data, "0");
  const txLookup = await nearAdapter.queryTransactionStatus(
    "2qS6ghwTmoxJyPVEBBXQLsWfH9mhXYX1Exbrt5xtKKrk",
    "cryptozax.near"
  );
  assert.equal(txLookup.ok, true);
  assert.equal(txLookup.result?.final_execution_status, "FINAL");

  // 7e: Verify unsigned NEP-141 ft_transfer_call escrow payload preparation (broadcasting disabled)
  const prepared = nearAdapter.prepareUsdcEscrowAndJobPayloads({
    customerAccountId: "cryptozax.near",
    operatorAccountId:
      "88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
    coreContractId: "core.cryptozax.near",
    customerPaymentUsdcAtomic: "100000000",
    maxOperatingBudgetUsdcAtomic: "25000000",
    termsHash: "0xD8A2A66C36307E760125EDCEA6A9867891C4D19EF472E5A52E3DB1583B3E14DE", // uppercase input normalized to lowercase
    needsStorageRegistration: true,
    jobId: "0x" + "A".repeat(64),
  });
  assert.equal(prepared.broadcastingEnabled, false);
  assert.equal(prepared.executionStatus, "NOT_EXECUTED_UNSIGNED_DRAFT");
  assert.equal(prepared.walletSigned, false);
  assert.equal(prepared.onChainVerified, false);
  assert.equal(prepared.mode, "UNSIGNED_PREPARATION_ONLY");
  assert.equal(prepared.transactions.length, 3);
  assert.equal(prepared.transactions[0].actions[0].methodName, "storage_deposit");
  assert.equal(
    prepared.transactions[0].actions[0].depositYocto,
    "30000000000000000000000" // 0.007 NEAR registration + 0.023 NEAR job storage = 0.030 NEAR
  );
  assert.equal(
    prepared.transactions[1].actions[0].methodName,
    "ft_transfer_call"
  );
  assert.equal(prepared.transactions[1].actions[0].depositYocto, "1");

  // Verify normalized lowercase Hex32 inside serialized CreateAndFundJob and FundJob msg
  const msg1 = JSON.parse(String(prepared.transactions[1].actions[0].args.msg));
  assert.equal(
    msg1.CreateAndFundJob.terms_hash,
    "0xd8a2a66c36307e760125edcea6a9867891c4d19ef472e5a52e3db1583b3e14de"
  );
  assert.equal(msg1.CreateAndFundJob.job_id, undefined);
  const msg2 = JSON.parse(String(prepared.transactions[2].actions[0].args.msg));
  assert.equal(msg2.FundJob.job_id, "0x" + "a".repeat(64));

  // Verify validation guards reject zero Hex32, invalid AccountId, and zero payment
  assert.throws(() => {
    nearAdapter.prepareUsdcEscrowAndJobPayloads({
      termsHash: "0x" + "0".repeat(64),
    });
  }, /ERR_ZERO_HEX32/);
  assert.throws(() => {
    nearAdapter.prepareUsdcEscrowAndJobPayloads({
      customerAccountId: "INVALID ACCOUNT!",
    });
  }, /ERR_INVALID_NEAR_ACCOUNT_ID/);
  assert.throws(() => {
    nearAdapter.prepareUsdcEscrowAndJobPayloads({
      customerPaymentUsdcAtomic: "0",
    });
  }, /ERR_ZERO_AMOUNT/);
});

test(
  "7b. Optional Live NEAR Mainnet read-only RPC smoke test",
  {
    skip:
      process.env.SNOWMOON_LIVE_RPC_SMOKE !== "1"
        ? "Optional live Mainnet RPC smoke test skipped (set SNOWMOON_LIVE_RPC_SMOKE=1 to run)"
        : false,
  },
  async () => {
    const config = loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_WALLET_MODE: "mock",
      NEAR_MAINNET_RPC_URL: "https://free.rpc.fastnear.com",
    });
    const nearAdapter = new NearMainnetRpcAdapter(config);
    const status = await nearAdapter.syncMainnetStatus();
    assert.equal(status.rpcReachable, true);
    assert.equal(status.chainId, "mainnet");
    assert.equal(status.contracts.core.deploymentStatus, "DEPLOYED_AND_INITIALIZED");
  }
);



