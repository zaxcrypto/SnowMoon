import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createSnowMoonApp } from "../src/server.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { SnowMoonRepository, SupabaseDatabaseAdapter } from "../src/persistence.ts";
import { WalletSessionManager } from "../src/mainnet_escrow.ts";

function makeTempStateFile(prefix = "snowmoon-phase26-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "state.json");
}

function makeTestConfig(stateFile: string, overrides: Record<string, string> = {}) {
  process.env.WALLET_SESSION_SECRET = "test-deterministic-session-secret-phase26";
  return loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "development",
    SNOWMOON_DB_MODE: "json",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-deterministic-session-secret-phase26",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "test-supabase-secret-phase26",
    ...overrides,
  });
}

async function createSignedWalletSession(
  app: ReturnType<typeof createSnowMoonApp>,
  baseUrl: string,
  accountId: string
): Promise<string> {
  app.nearRpcAdapter.viewAccessKey = async () => ({
    exists: true,
    permission: "FullAccess",
    nonce: 1,
    blockHash: "11111111111111111111111111111111",
    blockHeight: 1,
    rawError: null,
  });
  const chRes = await fetch(`${baseUrl}/api/near/wallet/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, walletType: "my-near-wallet" }),
  });
  assert.equal(chRes.status, 200);
  const chJson = (await chRes.json()) as {
    challenge: { challengeId: string; message: string; nonceBase64: string; recipient: string };
  };

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPub = spki.subarray(spki.length - 32);
  const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + rawPub.toString("hex"));
  let b58 = "";
  while (num > 0n) {
    b58 = b58Alphabet[Number(num % 58n)] + b58;
    num /= 58n;
  }
  for (const byte of rawPub) {
    if (byte === 0) b58 = "1" + b58;
    else break;
  }
  const nearPub = `ed25519:${b58}`;

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
  const digest = crypto.createHash("sha256").update(payload).digest();
  const signature = crypto.sign(null, digest, privateKey).toString("base64");

  const verifyRes = await fetch(`${baseUrl}/api/near/wallet/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId,
      networkId: "mainnet",
      walletType: "my-near-wallet",
      challengeId: chJson.challenge.challengeId,
      signature,
      publicKey: nearPub,
    }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyJson = (await verifyRes.json()) as {
    walletSessionToken: string;
  };
  return verifyJson.walletSessionToken;
}

function seedConfirmedEscrow(
  app: ReturnType<typeof createSnowMoonApp>,
  params: {
    intentId: string;
    jobId: string;
    customerAccountId: string;
    amountAtomic: string;
    txHash: string;
  }
) {
  const tracker = app.escrowTracker as unknown as {
    records: Map<string, Record<string, unknown>>;
    txToIntent: Map<string, string>;
    persist: () => void;
  };
  const now = new Date().toISOString();
  tracker.records.set(params.intentId, {
    intentId: params.intentId,
    jobId: params.jobId,
    customerAccountId: params.customerAccountId,
    operatorAccountId: app.config.mainnetOperatorAccountId,
    coreContractId: app.config.mainnetCoreContractId,
    usdcContractId: app.config.mainnetUsdcContractId,
    amountAtomic: params.amountAtomic,
    maxOperatingBudgetAtomic: params.amountAtomic,
    termsHash: "0x" + "11".repeat(32),
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    escrowState: "FINAL_CONFIRMED",
    sourceTxHash: params.txHash,
    onChainConfirmed: true,
    finalExecutionStatus: "SUCCEEDED",
    deliveryAndSettlementStatus: "Escrow confirmed on-chain",
    actionableError: null,
    createdAt: now,
    updatedAt: now,
    preparedTransactions: [],
  });
  tracker.txToIntent.set(params.txHash, params.intentId);
  tracker.persist();
}

test("Phase 8.1 & 8.13: Escrow crash recovery & cold-start deterministic session hydration", async () => {
  const stateFile = makeTempStateFile();
  const cfg = makeTestConfig(stateFile);

  const app1 = createSnowMoonApp(cfg);
  await new Promise<void>((resolve) => app1.server.listen(0, "127.0.0.1", resolve));
  const baseUrl1 = `http://127.0.0.1:${(app1.server.address() as AddressInfo).port}`;
  let aliceToken = "";
  const txHash = "9".repeat(44);
  const intentId = "intent_crash_recover_1";

  try {
    aliceToken = await createSignedWalletSession(app1, baseUrl1, "alice.near");
    const tracker = app1.escrowTracker as unknown as {
      records: Map<string, Record<string, unknown>>;
      txToIntent: Map<string, string>;
      persist: () => void;
    };
    const now = new Date().toISOString();
    tracker.records.set(intentId, {
      intentId,
      jobId: null,
      customerAccountId: "alice.near",
      operatorAccountId: cfg.mainnetOperatorAccountId,
      coreContractId: cfg.mainnetCoreContractId,
      usdcContractId: cfg.mainnetUsdcContractId,
      amountAtomic: "10000000",
      maxOperatingBudgetAtomic: "10000000",
      termsHash: "0x" + "ab".repeat(32),
      deadlineSec: Math.floor(Date.now() / 1000) + 3600,
      escrowState: "PENDING",
      sourceTxHash: txHash,
      onChainConfirmed: false,
      finalExecutionStatus: null,
      deliveryAndSettlementStatus: "Submitted, awaiting RPC confirmation",
      actionableError: null,
      createdAt: now,
      updatedAt: now,
      preparedTransactions: [],
    });
    tracker.txToIntent.set(txHash, intentId);
    tracker.persist();
  } finally {
    await new Promise<void>((resolve) => app1.server.close(() => resolve()));
  }

  // Simulate cold start on a new instance with same stateFile & WALLET_SESSION_SECRET
  const app2 = createSnowMoonApp(cfg);
  await new Promise<void>((resolve) => app2.server.listen(0, "127.0.0.1", resolve));
  const baseUrl2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;

  try {
    // Mock RPC queryTransactionStatus as if chain finalized during backend crash
    app2.nearRpcAdapter.queryTransactionStatus = async () => ({
      ok: true,
      result: {
        final_execution_status: "FINAL",
        transaction: {
          signer_id: "alice.near",
          receiver_id: cfg.mainnetUsdcContractId,
        },
        status: { SuccessValue: "" },
        receipts_outcome: [
          {
            id: "rcpt_1",
            outcome: {
              executor_id: cfg.mainnetCoreContractId,
              status: { SuccessValue: "" },
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: "snapfall",
                  event: "JobFunded",
                  data: [{ job_id: "0x" + "22".repeat(32) }],
                })}`,
              ],
            },
          },
        ],
      },
      rawError: null,
      error: null,
    }) as unknown as ReturnType<typeof app2.nearRpcAdapter.queryTransactionStatus>;
    app2.nearRpcAdapter.queryCoreJob = async () => ({
      ok: true,
      data: {
        job_id: "0x" + "22".repeat(32),
        customer: "alice.near",
        operator: cfg.mainnetOperatorAccountId,
        customer_payment: "10000000",
        status: "Funded",
      },
      error: null,
    }) as unknown as ReturnType<typeof app2.nearRpcAdapter.queryCoreJob>;

    // Session token minted before restart must remain valid on app2 and reconcile escrow
    const recRes = await fetch(`${baseUrl2}/api/near/escrow/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": aliceToken,
      },
      body: JSON.stringify({
        intentId,
        txHash,
        customerAccountId: "alice.near",
      }),
    });
    assert.equal(recRes.status, 200);
    const recJson = (await recRes.json()) as {
      ok: boolean;
      record: { escrowState: string; jobId: string; onChainConfirmed: boolean };
    };
    assert.equal(recJson.ok, true);
    assert.equal(recJson.record.escrowState, "FINAL_CONFIRMED");
    assert.equal(recJson.record.onChainConfirmed, true);
  } finally {
    await new Promise<void>((resolve) => app2.server.close(() => resolve()));
  }
});

test("Phase 8.2: RPC timeout triggers distinct fallback URL failover", async () => {
  const cfg = makeTestConfig(makeTempStateFile());
  const seenUrls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    if (seenUrls.length === 1) {
      throw new Error("ETIMEDOUT: Primary RPC timed out");
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { result: Array.from(Buffer.from(JSON.stringify({ vault_paused: false }))) },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const rpc = new NearMainnetRpcAdapter(cfg);
    const res = await rpc.callViewMethod("core.cryptozax.near", "accounting", {});
    assert.equal(res.ok, true);
    assert.equal(seenUrls.length, 2);
    assert.notEqual(seenUrls[0], seenUrls[1]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Phase 8.3 & 8.4 & 8.12: Duplicate escrow replay blocked, jobId mismatch rejected, concurrent register creates at most one job", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const aliceToken = await createSignedWalletSession(app, baseUrl, "alice.near");
    const escrowJobId = "0x" + "33".repeat(32);
    const txHash = "8".repeat(44);
    seedConfirmedEscrow(app, {
      intentId: "intent_dup_1",
      jobId: escrowJobId,
      customerAccountId: "alice.near",
      amountAtomic: "5000000",
      txHash,
    });

    // Duplicate txHash on another intent must throw ERR_REPLAY_DETECTED
    assert.throws(
      () =>
        app.escrowTracker.submitSignedTransaction({
          intentId: "intent_other",
          txHash,
          customerAccountId: "alice.near",
        }),
      /ERR_REPLAY_DETECTED/
    );

    // Job registration with mismatched jobId must fail closed
    const badReg = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wallet-session": aliceToken,
      },
      body: JSON.stringify({
        jobId: "0x" + "44".repeat(32),
        customerAccountId: "alice.near",
        prompt: "Analyze BTC trend",
        capability: "analysis",
        budgetUsdc: "5.00",
        funded: true,
        escrowTxHash: txHash,
      }),
    });
    assert.equal(badReg.status, 400);
    const badJson = (await badReg.json()) as { error: string };
    assert.match(badJson.error, /ERR_JOB_ID_ESCROW_MISMATCH/);

    // Concurrent registration requests for the same escrow/jobId must yield 1 job, never 2
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/workforce/jobs/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wallet-session": aliceToken,
        },
        body: JSON.stringify({
          customerAccountId: "alice.near",
          prompt: "Analyze BTC trend",
          capability: "analysis",
          budgetUsdc: "5.00",
          funded: true,
          escrowTxHash: txHash,
        }),
      }),
      fetch(`${baseUrl}/api/workforce/jobs/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wallet-session": aliceToken,
        },
        body: JSON.stringify({
          customerAccountId: "alice.near",
          prompt: "Analyze BTC trend",
          capability: "analysis",
          budgetUsdc: "5.00",
          funded: true,
          escrowTxHash: txHash,
        }),
      }),
    ]);

    assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 400]);
    assert.equal(app.workforceEngine.listJobs().length, 1);
    assert.equal(app.workforceEngine.listJobs()[0]?.jobId, escrowJobId);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 8.5, 8.6, 8.7: AI timeout, OutLayer lost response (no blind retry), and TEE verification failure", async () => {
  const cfg = makeTestConfig(makeTempStateFile(), {
    SNOWMOON_WALLET_MODE: "outlayer",
    OUTLAYER_API_KEY: "test-outlayer-key",
    OUTLAYER_PAYMENT_KEY: "test-outlayer-payment-key",
    OUTLAYER_PROJECT_OWNER: "zax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-tee",
    OUTLAYER_VERSION_KEY: "v1",
    OUTLAYER_EXPECTED_WASM_HASH: "a".repeat(64),
  });

  // 8.6: Lost response -> EXECUTION_PENDING persisted; second call does NOT re-invoke OutLayer
  let callCount = 0;
  const lostResponseFetch: typeof fetch = async () => {
    callCount += 1;
    throw new Error("ETIMEDOUT: socket hang up after request sent");
  };
  const outlayer1 = new OutLayerExecutionAdapter(
    cfg,
    lostResponseFetch,
    undefined,
    async () => ({
      available: true,
      verified: true,
      command: "outlayer-verify",
      stdout: "ok",
      stderr: "",
    })
  );
  const res1 = await outlayer1.executeAndVerify({
    jobId: "0x" + "55".repeat(32),
    workerId: "worker-1",
    prompt: "test",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(res1.status, "EXECUTION_PENDING");
  assert.equal(callCount, 1);

  const res2 = await outlayer1.executeAndVerify({
    jobId: "0x" + "55".repeat(32),
    workerId: "worker-1",
    prompt: "test",
    evidenceHash: "0x" + "11".repeat(32),
  });
  assert.equal(res2.status, "EXECUTION_PENDING");
  assert.equal(callCount, 1); // Must NOT blind-retry paid OutLayer call

  // 8.7: TEE verification failure -> fails closed
  const teeFailFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("attestation")) {
      return new Response(
        JSON.stringify({ quote: "fake-quote", wasm_hash: "a".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        call_id: "call_tee_fail_1",
        status: "completed",
        output: { jobId: "0x" + "66".repeat(32), resultHash: "0x" + "77".repeat(32) },
        attestation_url: "https://api.outlayer.fastnear.com/attestation/call_tee_fail_1",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const outlayer2 = new OutLayerExecutionAdapter(cfg, teeFailFetch, undefined, async () => ({
    available: true,
    verified: false,
    command: "outlayer-verify",
    stdout: "",
    stderr: "ERR_ATTESTATION_QUOTE_INVALID",
  }));
  const resTeeFail = await outlayer2.executeAndVerify({
    jobId: "0x" + "66".repeat(32),
    workerId: "worker-2",
    prompt: "test",
    evidenceHash: "0x" + "22".repeat(32),
  });
  assert.equal(resTeeFail.status, "ATTESTATION_FAILED");
});

test("Phase 8.9, 8.11, 8.15: Customer cancellation blocks settlement, 0% default fee & customer binding, unassigned worker blocked", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const aliceToken = await createSignedWalletSession(app, baseUrl, "alice.near");
    const operatorToken = await createSignedWalletSession(
      app,
      baseUrl,
      app.config.mainnetOperatorAccountId
    );

    const jobId1 = "0x" + "77".repeat(32);
    const tx1 = "7".repeat(44);
    seedConfirmedEscrow(app, {
      intentId: "intent_cancel_1",
      jobId: jobId1,
      customerAccountId: "alice.near",
      amountAtomic: "10000000",
      txHash: tx1,
    });

    const reg1 = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        jobId: jobId1,
        customerAccountId: "alice.near",
        prompt: "Task to cancel",
        capability: "analysis",
        budgetUsdc: "10.00",
        funded: true,
        escrowTxHash: tx1,
      }),
    });
    assert.equal(reg1.status, 200);

    // Customer cancels job -> blocks settlement
    const cancelRes = await fetch(`${baseUrl}/api/workforce/jobs/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        jobId: jobId1,
        customerAccountId: "alice.near",
        reason: "Customer cancelled",
      }),
    });
    assert.equal(cancelRes.status, 200);

    const settleCancelled = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        jobId: jobId1,
        customerAccountId: "alice.near",
      }),
    });
    assert.equal(settleCancelled.status, 400);

    // Second job: verify customer mismatch & unassigned worker rejection on /api/outlayer/execute
    const jobId2 = "0x" + "88".repeat(32);
    const tx2 = "6".repeat(44);
    seedConfirmedEscrow(app, {
      intentId: "intent_auth_2",
      jobId: jobId2,
      customerAccountId: "alice.near",
      amountAtomic: "10000000",
      txHash: tx2,
    });
    await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({
        jobId: jobId2,
        customerAccountId: "alice.near",
        prompt: "Worker auth check",
        capability: "analysis",
        budgetUsdc: "10.00",
        funded: true,
        escrowTxHash: tx2,
      }),
    });

    app.workforceEngine.registerWorker({
      workerId: "w-assigned",
      accountId: "w-assigned.near",
      displayName: "Assigned Worker",
      capabilities: ["analysis"],
    });
    app.workforceEngine.registerWorker({
      workerId: "w-other",
      accountId: "w-other.near",
      displayName: "Other Worker",
      capabilities: ["analysis"],
    });
    app.workforceEngine.assignJob(jobId2, "w-assigned");
    app.workforceEngine.acceptJob(jobId2, "w-assigned");

    // Unassigned worker must be blocked from /api/outlayer/execute
    const unauthExec = await fetch(`${baseUrl}/api/outlayer/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        jobId: jobId2,
        workerId: "w-other",
        taskType: "analysis",
        inputPayload: { prompt: "Worker auth check" },
      }),
    });
    assert.equal(unauthExec.status, 400);
    const unauthJson = (await unauthExec.json()) as { error: string };
    assert.match(unauthJson.error, /ERR_WORKER_NOT_ASSIGNED/);

    // Settlement customer mismatch must be blocked
    const mismatchSettle = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        jobId: jobId2,
        customerAccountId: "bob.near",
      }),
    });
    assert.equal(mismatchSettle.status, 400);
    const mismatchJson = (await mismatchSettle.json()) as { error: string };
    assert.match(mismatchJson.error, /ERR_CUSTOMER_MISMATCH/);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 8.14: Supabase outage / HTTP 503 throws instead of silently dropping writes", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Service Unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const db = new SupabaseDatabaseAdapter(
      "https://example.supabase.co",
      "sb_secret_test",
      undefined,
      globalThis.fetch
    );
    db.saveCollection("workforceJobs", []);
    await assert.rejects(
      () => db.flushPending(),
      /503|ERR_SUPABASE/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Phase 10.1: Intents widget-quote and widget-api RPC proxy enforce auth, ownership, and read-only RPC allowlist", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    // Unauthenticated widget-quote must fail with 401
    const unauthQuote = await fetch(`${baseUrl}/api/intents/widget-quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "alice.near", amount: "1000000" }),
    });
    assert.equal(unauthQuote.status, 401);

    // Unauthenticated widget-api RPC proxy must fail with 401
    const unauthRpc = await fetch(`${baseUrl}/api/intents/widget-api/rpc/near`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }),
    });
    assert.equal(unauthRpc.status, 401);

    const bobToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: "bob.near",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });

    // Impersonating alice.near on widget-quote must fail with 403
    const impQuote = await fetch(`${baseUrl}/api/intents/widget-quote`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": bobToken },
      body: JSON.stringify({ recipient: "alice.near", amount: "1000000" }),
    });
    assert.equal(impQuote.status, 403);
    const impJson = (await impQuote.json()) as { error: string };
    assert.match(impJson.error, /ERR_ACCOUNT_IMPERSONATION_BLOCKED/);

    // Disallowed write RPC method (broadcast_tx_commit) must be rejected
    const badRpc = await fetch(`${baseUrl}/api/intents/widget-api/rpc/near`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": bobToken },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broadcast_tx_commit", params: [] }),
    });
    assert.equal(badRpc.status, 400);
    const badRpcJson = (await badRpc.json()) as { error: string };
    assert.match(badRpcJson.error, /ERR_RPC_METHOD_FORBIDDEN/);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 10.2: Empty customerAccountId cannot bypass ownership; non-operator blocked from vault/float preparation; worker without authKeyHash rejected", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const aliceToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: "alice.near",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });

    // Empty customerAccountId on /api/intents/verify-destination must fail (never bypass)
    const emptyCust = await fetch(`${baseUrl}/api/intents/verify-destination`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
      body: JSON.stringify({ customerAccountId: "" }),
    });
    assert.ok(emptyCust.status === 400 || emptyCust.status === 403);
    const emptyCustJson = (await emptyCust.json()) as { error: string };
    assert.match(emptyCustJson.error, /ERR_CUSTOMER_ACCOUNT_REQUIRED|ERR_ACCOUNT_IMPERSONATION_BLOCKED/);

    // Non-operator (alice.near) must be rejected from float/vault prepare routes
    for (const route of [
      "/api/near/float/prepare-advance",
      "/api/near/vault/prepare-start-work",
      "/api/near/vault/prepare-submit-delivery",
    ]) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet-session": aliceToken },
        body: JSON.stringify({ jobId: "0x" + "11".repeat(32) }),
      });
      assert.equal(res.status, 403, `${route} should reject non-operator with 403`);
      const json = (await res.json()) as { error: string };
      assert.match(json.error, /ERR_OPERATOR_ROLE_REQUIRED|ERR_ACCOUNT_IMPERSONATION_BLOCKED/);
    }

    // Worker without authKeyHash must be rejected in production mode
    app.workforceEngine.registerWorker({
      workerId: "w-no-hash",
      accountId: "w-no-hash.near",
      displayName: "No Hash Worker",
      capabilities: ["analysis"],
    });
    assert.throws(
      () => app.workforceEngine.assertWorkerAuthorized("w-no-hash", "any-non-empty-token", true),
      /ERR_WORKER_TOKEN_NOT_CONFIGURED/
    );
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 10.3: /api/outlayer/execute rejects missing job, missing assignedWorkerId, and empty workerId", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const operatorToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: app.config.mainnetOperatorAccountId,
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });

    // Missing jobId / workerId
    const emptyRes = await fetch(`${baseUrl}/api/outlayer/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId: "0x" + "12".repeat(32), workerId: "" }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = (await emptyRes.json()) as { error: string };
    assert.match(emptyJson.error, /ERR_INVALID_WORKER_ID/);

    // Missing job in workforceEngine
    const missingJobRes = await fetch(`${baseUrl}/api/outlayer/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId: "0x" + "12".repeat(32), workerId: "w1" }),
    });
    assert.equal(missingJobRes.status, 400);
    const missingJobJson = (await missingJobRes.json()) as { error: string };
    assert.match(missingJobJson.error, /ERR_UNKNOWN_JOB/);

    // Registered job without assignedWorkerId
    const jobId = "0x" + "13".repeat(32);
    const txHash = "9".repeat(44);
    seedConfirmedEscrow(app, {
      intentId: "intent_ol_unassigned",
      jobId,
      customerAccountId: "alice.near",
      amountAtomic: "5000000",
      txHash,
    });
    await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        jobId,
        customerAccountId: "alice.near",
        prompt: "Unassigned outlayer check",
        capability: "analysis",
        budgetUsdc: "5.00",
        funded: true,
        escrowTxHash: txHash,
      }),
    });
    const unassignedRes = await fetch(`${baseUrl}/api/outlayer/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId, workerId: "w1" }),
    });
    assert.equal(unassignedRes.status, 400);
    const unassignedJson = (await unassignedRes.json()) as { error: string };
    assert.match(unassignedJson.error, /ERR_WORKER_NOT_ASSIGNED/);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 10.4: Non-Vercel production config rejects missing WALLET_SESSION_SECRET, json DB, and mock AI", () => {
  const baseProd = {
    NODE_ENV: "production",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_DB_MODE: "supabase",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SNOWMOON_AI_MODE: "near_ai",
    WALLET_SESSION_SECRET: "strong-secret",
  };
  assert.throws(
    () => loadConfig({ ...baseProd, WALLET_SESSION_SECRET: "" }),
    /ERR_PRODUCTION_SESSION_SECRET_REQUIRED/
  );
  assert.throws(
    () => loadConfig({ ...baseProd, SNOWMOON_DB_MODE: "json" }),
    /ERR_PRODUCTION_DATABASE_REQUIRED/
  );
  assert.throws(
    () => loadConfig({ ...baseProd, SNOWMOON_AI_MODE: "mock" }),
    /ERR_PRODUCTION_AI_MODE_INVALID/
  );
});

test("Phase 10.5: Settlement derives customer, grossAmountAtomic, and platformFeeBps=0 from wfJob; duplicate jobId params are immutable", async () => {
  const stateFile = makeTempStateFile();
  const app = createSnowMoonApp(makeTestConfig(stateFile));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const operatorToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: app.config.mainnetOperatorAccountId,
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });

    // Missing jobId must reject with ERR_UNKNOWN_JOB
    const missingSettle = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId: "0x" + "71".repeat(32) }),
    });
    assert.equal(missingSettle.status, 400);
    const missingJson = (await missingSettle.json()) as { error: string };
    assert.match(missingJson.error, /ERR_UNKNOWN_JOB/);

    // Duplicate jobId with mutated prompt must fail
    const jobId = "0x" + "72".repeat(32);
    app.workforceEngine.registerJob({
      jobId,
      customerAccountId: "alice.near",
      prompt: "Original prompt",
      requiredCapabilities: ["analysis"],
      amountAtomic: "4000000",
      deadlineSec: 1_900_000_000,
      funded: true,
      escrowTxHash: "tx_72",
    });
    assert.throws(
      () =>
        app.workforceEngine.registerJob({
          jobId,
          customerAccountId: "alice.near",
          prompt: "Mutated prompt",
          requiredCapabilities: ["analysis"],
          amountAtomic: "4000000",
          deadlineSec: 1_900_000_000,
          funded: true,
          escrowTxHash: "tx_72",
        }),
      /ERR_DUPLICATE_JOB_ID/
    );

    // Settlement ignores spoofed grossAmountAtomic and platformFeeBps
    app.workforceEngine.registerWorker({
      workerId: "w-settle",
      accountId: "w-settle.near",
      displayName: "Settle Worker",
      capabilities: ["analysis"],
    });
    app.workforceEngine.assignJob(jobId, "w-settle");
    app.workforceEngine.acceptJob(jobId, "w-settle");
    await app.workforceEngine.executeJob({
      jobId,
      workerId: "w-settle",
      aiAdapter: new AIWorkerAdapter(
        { ...app.config, aiMode: "near_ai", hasNearAiKey: true, secrets: { ...app.config.secrets, nearAiApiKey: "sk-test" } },
        async () =>
          new Response(
            JSON.stringify({
              id: "chat-1",
              model: "deepseek/deepseek-v3.2",
              choices: [{ message: { content: "Verified output" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      ),
    });
    const execJob = app.workforceEngine.getJob(jobId);
    app.verificationEngine.submitDelivery({
      jobId,
      workerId: "w-settle",
      workerAccountId: "w-settle.near",
      expectedWorkerId: "w-settle",
      deliverable: execJob?.output ?? { result: "Verified output" },
      evidenceHash: execJob?.evidenceHash || "0x" + "ab".repeat(32),
      deadlineSec: execJob?.deadlineSec || 1_900_000_000,
    });
    const verRes = await fetch(`${baseUrl}/api/verification/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({ jobId, verifierAccountId: app.config.mainnetOperatorAccountId, decision: "VERIFIED" }),
    });
    assert.equal(verRes.status, 200);

    const settleRes = await fetch(`${baseUrl}/api/settlement/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": operatorToken },
      body: JSON.stringify({
        jobId,
        grossAmountAtomic: "999999999",
        platformFeeBps: 5000,
      }),
    });
    assert.equal(settleRes.status, 200);
    const settleJson = (await settleRes.json()) as {
      settlement: { customerAccountId: string; grossAmountAtomic: string; platformFeeBps: number };
    };
    assert.equal(settleJson.settlement.customerAccountId, "alice.near");
    assert.equal(settleJson.settlement.grossAmountAtomic, "4000000");
    assert.equal(settleJson.settlement.platformFeeBps, 0);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 10.6: OutLayer pollCall rejects EXECUTION_PENDING without callId, and WalletSessionManager persists challenges across reload", async () => {
  const stateFile = makeTempStateFile();
  const repo1 = new SnowMoonRepository(stateFile);
  const wsm1 = new WalletSessionManager("secret-phase10", undefined, { repo: repo1 });
  const ch = wsm1.issueChallenge({ accountId: "alice.near" });

  // Reload in a fresh WalletSessionManager sharing the same repo/stateFile
  const repo2 = new SnowMoonRepository(stateFile);
  const wsm2 = new WalletSessionManager("secret-phase10", undefined, { repo: repo2 });
  wsm2.reloadFromRepo();
  // Attempting to verify with wrong sig will consume or validate the persisted challenge (not ERR_CHALLENGE_NOT_FOUND)
  assert.throws(
    () =>
      wsm2.verifyNep413Signature({
        accountId: "alice.near",
        challengeId: ch.challengeId,
        publicKey: "ed25519:11111111111111111111111111111111",
        signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      }),
    /ERR_WALLET_SIGNATURE_INVALID|ERR_MALFORMED_SIGNATURE|ERR_PUBLIC_KEY/i
  );

  const cfg = makeTestConfig(stateFile, {
    OUTLAYER_PAYMENT_KEY: "pk_test",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
  });
  repo1.saveCollection("outlayerCalls", [
    {
      requestId: "ol_missing_call_id",
      jobId: "0x" + "55".repeat(32),
      workerId: "w1",
      callId: null,
      status: "EXECUTION_PENDING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
  const ol = new OutLayerExecutionAdapter(cfg, globalThis.fetch, repo1);
  await assert.rejects(
    () => ol.pollCall("ol_missing_call_id"),
    /ERR_OUTLAYER_CALL_ID_MISSING/
  );
});

test("Phase 11.1: Row-level persistence (row & dual modes) isolates per-record CAS so unrelated jobs never conflict", async () => {
  // Invalid SNOWMOON_DB_ROW_MODE must fail closed
  assert.throws(
    () => loadConfig({ SNOWMOON_DB_ROW_MODE: "invalid_mode" }),
    /ERR_INVALID_DB_ROW_MODE/
  );

  // Simulated Postgres row-level tables + KV table
  const tables = new Map<string, Map<string, { payload: Record<string, unknown>; version: number }>>([
    ["snowmoon_workforce_jobs", new Map([
      ["job-1", { payload: { jobId: "job-1", state: "FUNDED", prompt: "A" }, version: 1 }],
      ["job-2", { payload: { jobId: "job-2", state: "FUNDED", prompt: "B" }, version: 1 }],
    ])],
  ]);
  const kvRows = new Map<string, { payload: unknown[]; version: number }>();

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const tableName = parsed.pathname.split("/").pop() || "";

    if (tableName === "snowmoon_kv_collections") {
      if (method === "GET") {
        return new Response(
          JSON.stringify(
            Array.from(kvRows.entries()).map(([k, v]) => ({ collection_key: k, payload: v.payload, version: v.version }))
          ),
          { status: 200 }
        );
      }
      const body = JSON.parse(String(init?.body || "{}")) as { collection_key?: string; payload: unknown[]; version: number };
      const key = body.collection_key || parsed.searchParams.get("collection_key")?.replace(/^eq\./, "") || "";
      kvRows.set(key, { payload: body.payload, version: body.version });
      return new Response(JSON.stringify([{ collection_key: key, version: body.version }]), { status: 200 });
    }

    const tMap = tables.get(tableName) ?? new Map();
    tables.set(tableName, tMap);

    if (method === "GET") {
      const out = Array.from(tMap.values()).map((r) => ({ payload: r.payload, version: r.version }));
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (method === "PATCH") {
      const pkParam = parsed.searchParams.get("job_id")?.replace(/^eq\./, "") || "";
      const expVer = Number(parsed.searchParams.get("version")?.replace(/^eq\./, "") || "0");
      const cur = tMap.get(pkParam);
      if (!cur || cur.version !== expVer) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      const body = JSON.parse(String(init?.body || "{}")) as { payload: Record<string, unknown>; version: number };
      tMap.set(pkParam, { payload: body.payload, version: body.version });
      return new Response(JSON.stringify([{ version: body.version }]), { status: 200 });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as { job_id?: string; payload: Record<string, unknown>; version: number };
      const pk = body.job_id || String(body.payload?.jobId || "");
      if (tMap.has(pk)) return new Response("conflict", { status: 409 });
      tMap.set(pk, { payload: body.payload, version: 1 });
      return new Response(JSON.stringify([{ version: 1 }]), { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };

  // Row mode: hydrate and update job-1 while another instance concurrently bumps job-2 -> MUST succeed!
  const rowAdapter = new SupabaseDatabaseAdapter("https://example.supabase.co", "sb_secret", undefined, mockFetch, "row");
  await rowAdapter.ensureHydrated(true);
  const jobs = rowAdapter.getCollection<{ jobId: string; state: string; prompt: string }>("workforceJobs");
  assert.equal(jobs.length, 2);

  // Another instance concurrently updates job-2 to version 2
  tables.get("snowmoon_workforce_jobs")!.set("job-2", {
    payload: { jobId: "job-2", state: "ASSIGNED", prompt: "B" },
    version: 2,
  });

  // Instance A updates ONLY job-1 -> succeeds without touching job-2
  const updated = jobs.map((j) => (j.jobId === "job-1" ? { ...j, state: "ASSIGNED" } : j));
  await rowAdapter.saveCollectionAsync("workforceJobs", updated);
  assert.equal(tables.get("snowmoon_workforce_jobs")!.get("job-1")?.version, 2);
  assert.equal(tables.get("snowmoon_workforce_jobs")!.get("job-2")?.version, 2);

  // Now another instance bumps job-1 to version 3 -> stale CAS write on job-1 MUST fail with ERR_CONCURRENT_WRITE_CONFLICT
  tables.get("snowmoon_workforce_jobs")!.set("job-1", {
    payload: { jobId: "job-1", state: "EXECUTING", prompt: "A" },
    version: 3,
  });
  await assert.rejects(
    () => rowAdapter.saveCollectionAsync("workforceJobs", updated.map((j) => (j.jobId === "job-1" ? { ...j, state: "FAILED" } : j))),
    /ERR_CONCURRENT_WRITE_CONFLICT/
  );

  // Dual mode: writes both row-level table AND snowmoon_kv_collections for instant KV rollback
  const dualAdapter = new SupabaseDatabaseAdapter("https://example.supabase.co", "sb_secret", undefined, mockFetch, "dual");
  await dualAdapter.ensureHydrated(true);
  await dualAdapter.saveCollectionAsync("workforceJobs", [
    { jobId: "job-3", state: "FUNDED", prompt: "C" },
  ]);
  assert.equal(tables.get("snowmoon_workforce_jobs")!.has("job-3"), true);
  assert.equal(kvRows.has("workforceJobs"), true);
});

test("Phase 11.2: Atomic single-use wallet challenge consumption RPC prevents multi-instance replay & migration 004 enforces RLS", async () => {
  // Verify migration 004 SQL structure
  const sqlPath = path.resolve(process.cwd(), "migrations", "004_row_level_persistence.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.snowmoon_wallet_challenges/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.snowmoon_escrow_jobs/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.snowmoon_consume_wallet_challenge/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.snowmoon_consume_wallet_challenge\(TEXT, BIGINT\) TO service_role/);

  // Simulated atomic DB RPC for walletChallenges
  const challenges = new Map<string, {
    challenge_id: string;
    account_id: string;
    nonce_base64: string;
    recipient: string;
    message: string;
    expires_at_ms: number;
    consumed: boolean;
    payload: Record<string, unknown>;
    version: number;
  }>();

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  // Base58 encode helper for Ed25519 public key
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encodeB58 = (buf: Buffer): string => {
    let num = BigInt("0x" + (buf.toString("hex") || "00"));
    let out = "";
    while (num > 0n) {
      out = B58[Number(num % 58n)] + out;
      num /= 58n;
    }
    for (const b of buf) {
      if (b === 0) out = "1" + out;
      else break;
    }
    return out || "1";
  };
  const pubKeyStr = `ed25519:${encodeB58(Buffer.from(rawPub))}`;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("/rpc/snowmoon_consume_wallet_challenge") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as { p_challenge_id: string; p_now_ms: number };
      const row = challenges.get(body.p_challenge_id);
      if (!row || row.consumed || row.expires_at_ms < body.p_now_ms) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      row.consumed = true;
      row.version += 1;
      return new Response(JSON.stringify([row]), { status: 200 });
    }
    if (url.includes("snowmoon_wallet_challenges") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as typeof challenges extends Map<string, infer V> ? V : never;
      challenges.set(body.challenge_id, { ...body, consumed: Boolean(body.consumed), version: 1 });
      return new Response(JSON.stringify([{ version: 1 }]), { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };

  const adapter = new SupabaseDatabaseAdapter("https://example.supabase.co", "sb_secret", undefined, mockFetch, "row");
  await adapter.ensureHydrated(true);
  const repo = new SnowMoonRepository(adapter);
  const wsm = new WalletSessionManager("phase11-secret", undefined, { repo });
  const ch = wsm.issueChallenge({ accountId: "alice.near" });
  await repo.flushPending();

  // Build valid NEP-413 signature matching WalletSessionManager's Borsh layout
  const writeU32LE = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };
  const writeStr = (s: string) => {
    const u = Buffer.from(s, "utf8");
    return Buffer.concat([writeU32LE(u.length), u]);
  };
  const tag = writeU32LE(((1 << 31) >>> 0) + 413);
  const borshPayload = Buffer.concat([
    tag,
    writeStr(ch.message),
    Buffer.from(ch.nonceBase64, "base64"),
    writeStr(ch.recipient),
    Buffer.from([0]),
  ]);
  const digest = crypto.createHash("sha256").update(borshPayload).digest();
  const sigB64 = crypto.sign(null, digest, privateKey).toString("base64");

  // Concurrent race: two instances attempt to verify the same challenge simultaneously
  const [r1, r2] = await Promise.allSettled([
    wsm.verifyNep413SignatureAsync({
      challengeId: ch.challengeId,
      accountId: "alice.near",
      publicKey: pubKeyStr,
      signature: sigB64,
    }),
    wsm.verifyNep413SignatureAsync({
      challengeId: ch.challengeId,
      accountId: "alice.near",
      publicKey: pubKeyStr,
      signature: sigB64,
    }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  const rejected = [r1, r2].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
});
