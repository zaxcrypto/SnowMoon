import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createSnowMoonApp } from "../src/server.ts";
import { SupabaseDatabaseAdapter } from "../src/persistence.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import type { JobRecord } from "../src/engine.ts";

function makeTempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase25-"));
  return path.join(dir, "state.json");
}

function withMockSupabaseFetch(fn: () => Promise<void>): Promise<void> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://mock-phase25.supabase.co")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = origFetch;
  });
}

function makeProdConfig(stateFile: string, overrides: Record<string, string> = {}) {
  process.env.WALLET_SESSION_SECRET = "test-phase25-session-secret";
  return loadConfig({
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "production",
    SNOWMOON_DB_MODE: "supabase",
    SUPABASE_URL: "https://mock-phase25.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_phase25_test",
    SNOWMOON_PERSISTENCE_FILE: stateFile,
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_AI_MODE: "near_ai",
    NEAR_AI_API_KEY: "test-near-ai-key",
    SNOWMOON_WALLET_MODE: "mock",
    WALLET_SESSION_SECRET: "test-phase25-session-secret",
    ...overrides,
  });
}

test("Phase 25.1: Production startup fails closed on missing/sandbox network config and forces allowSandboxDemoEndpoints=false", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /ERR_PRODUCTION_CONFIG_INVALID/
  );
  assert.throws(
    () =>
      loadConfig({
        SNOWMOON_ENV: "production",
        SNOWMOON_NETWORK: "sandbox",
        SNOWMOON_CHAIN_MODE: "sandbox",
      }),
    /ERR_PRODUCTION_CONFIG_INVALID/
  );
  assert.throws(
    () =>
      loadConfig({
        VERCEL: "1",
        SNOWMOON_NETWORK: "mainnet",
        SNOWMOON_CHAIN_MODE: "rpc",
        SNOWMOON_DB_MODE: "json",
      }),
    /ERR_PRODUCTION_DATABASE_REQUIRED/
  );

  const cfg = makeProdConfig(makeTempStateFile());
  assert.equal(cfg.isProductionMode, true);
  assert.equal(cfg.allowSandboxDemoEndpoints, false);
});

test("Phase 25.2: Production /api/state has zero seeded test accounts/balances, blocks demo/reset, and rejects mock-wallet", async () => {
  await withMockSupabaseFetch(async () => {
    const stateFile = makeTempStateFile();
    const app = createSnowMoonApp(makeProdConfig(stateFile));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    try {
      const stateRes = (await fetch(`${baseUrl}/api/state`).then((r) => r.json())) as {
        balancesUsdc: Record<string, string>;
        events: unknown[];
      };
      assert.equal(Object.keys(stateRes.balancesUsdc).length, 0);
      assert.equal(stateRes.events.length, 0);

      const resetRes = await fetch(`${baseUrl}/api/reset`, { method: "POST" });
      assert.equal(resetRes.status, 403);

      const demoRes = await fetch(`${baseUrl}/api/demo/run-complete-journey`, { method: "POST" });
      assert.equal(demoRes.status, 403);

      const mockWalletRes = await fetch(`${baseUrl}/api/near/wallet/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "alice.near",
          networkId: "mainnet",
          walletType: "mock-wallet",
        }),
      });
      assert.equal(mockWalletRes.status, 400);
      const mockWalletJson = (await mockWalletRes.json()) as { error: string };
      assert.match(mockWalletJson.error, /ERR_MOCK_WALLET_FORBIDDEN_IN_PRODUCTION/);
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });
});

test("Phase 25.3: Protected routes enforce auth regardless of network, and Intents verify/prepare-deposit reject unauthorized callers", async () => {
  const stateFile = makeTempStateFile();
  // Sandbox config (non-mainnet) must still enforce auth on protected routes
  const sandboxCfg = loadConfig({
    SNOWMOON_NETWORK: "sandbox",
    SNOWMOON_CHAIN_MODE: "sandbox",
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_PERSISTENCE_FILE: stateFile,
  });
  const app = createSnowMoonApp(sandboxCfg);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const protectedEndpoints: Array<[string, Record<string, unknown>]> = [
      ["/api/workforce/workers/register", { workerId: "w1", accountId: "w1.near", displayName: "W1" }],
      ["/api/workforce/jobs/register", { jobId: "0x" + "aa".repeat(32), customerAccountId: "alice.near", prompt: "hi" }],
      ["/api/workforce/jobs/assign", { jobId: "0x" + "aa".repeat(32) }],
      ["/api/settlement/prepare", { jobId: "0x" + "aa".repeat(32) }],
      ["/api/approvals/decide", { approvalId: "apr-1", decision: "APPROVED" }],
      ["/api/intents/verify-destination", { depositAddress: "dep-1", expectedRecipient: "alice.near" }],
      ["/api/intents/prepare-deposit", { depositAddress: "dep-1", customerNearAccount: "alice.near" }],
    ];

    for (const [ep, body] of protectedEndpoints) {
      const r = await fetch(`${baseUrl}${ep}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 401, `Expected 401 for unauthenticated POST ${ep}, got ${r.status}`);
    }

    // Wrong customer token on intents/verify-destination returns 403
    const bobToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: "bob.near",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const wrongCustRes = await fetch(`${baseUrl}/api/intents/verify-destination`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": bobToken },
      body: JSON.stringify({
        depositAddress: "dep-1",
        expectedRecipient: "alice.near",
        customerNearAccount: "alice.near",
      }),
    });
    assert.equal(wrongCustRes.status, 403);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 25.4: Production job registration rejects missing or unconfirmed escrow proof", async () => {
  await withMockSupabaseFetch(async () => {
    const stateFile = makeTempStateFile();
    const app = createSnowMoonApp(makeProdConfig(stateFile));
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    try {
      const custToken = app.walletSessionManager.issueToken({
        connected: true,
        walletType: "meteor",
        accountId: "alice.near",
        networkId: "mainnet",
        verifiedAt: new Date().toISOString(),
      });

      const noProof = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet-session": custToken },
        body: JSON.stringify({
          jobId: "0x" + "11".repeat(32),
          customerAccountId: "alice.near",
          amountAtomic: "1000000",
          prompt: "Analyze protocol",
        }),
      });
      assert.equal(noProof.status, 400);
      const noProofJson = (await noProof.json()) as { error: string };
      assert.match(noProofJson.error, /ERR_ESCROW_PROOF_REQUIRED/);

      const fakeTx = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet-session": custToken },
        body: JSON.stringify({
          jobId: "0x" + "22".repeat(32),
          customerAccountId: "alice.near",
          amountAtomic: "1000000",
          prompt: "Analyze protocol",
          funded: true,
          escrowTxHash: "5abc12345678901234567890123456789012345678",
        }),
      });
      assert.equal(fakeTx.status, 400);
      const fakeTxJson = (await fakeTx.json()) as { error: string };
      assert.match(fakeTxJson.error, /ERR_ESCROW_NOT_CONFIRMED/);
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });
});

test("Phase 25.5: Supabase cold-start hydration, awaited writes, CAS conflict detection, and OutLayer pre-call persistence", async () => {
  const remoteRows = new Map<string, { payload: unknown[]; version: number }>([
    ["workforceJobs", { payload: [{ jobId: "job-remote-1", state: "FUNDED" }], version: 3 }],
  ]);

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("snowmoon_kv_collections") && method === "GET") {
      const rows = Array.from(remoteRows.entries()).map(([collection_key, v]) => ({
        collection_key,
        payload: v.payload,
        version: v.version,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (url.includes("snowmoon_kv_collections") && method === "PATCH") {
      const parsed = new URL(url);
      const key = parsed.searchParams.get("collection_key")?.replace(/^eq\./, "") || "";
      const expectedVer = Number(parsed.searchParams.get("version")?.replace(/^eq\./, "") || "0");
      const current = remoteRows.get(key);
      if (!current || current.version !== expectedVer) {
        return new Response(JSON.stringify([]), { status: 200 }); // 0 rows updated -> CAS conflict
      }
      const body = JSON.parse(String(init?.body || "{}")) as { payload: unknown[]; version: number };
      remoteRows.set(key, { payload: body.payload, version: body.version });
      return new Response(JSON.stringify([{ collection_key: key, version: body.version }]), { status: 200 });
    }
    if (url.includes("snowmoon_kv_collections") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as { collection_key: string; payload: unknown[] };
      const nextVer = (remoteRows.get(body.collection_key)?.version || 0) + 1;
      remoteRows.set(body.collection_key, { payload: body.payload, version: nextVer });
      return new Response(JSON.stringify([{ collection_key: body.collection_key, version: nextVer }]), { status: 200 });
    }
    if (url.includes("snowmoon_outlayer_calls") && method === "POST") {
      return new Response(JSON.stringify([{}]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };

  // Cold start hydration
  const adapter = new SupabaseDatabaseAdapter("https://example.supabase.co", "secret", undefined, mockFetch);
  await adapter.ensureHydrated(true);
  const hydratedJobs = adapter.getCollection<{ jobId: string }>("workforceJobs");
  assert.equal(hydratedJobs.length, 1);
  assert.equal(hydratedJobs[0].jobId, "job-remote-1");

  // Awaited write increments version
  await adapter.saveCollectionAsync("workforceJobs", [{ jobId: "job-remote-1", state: "ASSIGNED" }]);
  assert.equal(remoteRows.get("workforceJobs")?.version, 4);

  // Concurrent write from another instance bumps version to 5 -> our next CAS write must fail with ERR_CONCURRENT_WRITE_CONFLICT
  remoteRows.set("workforceJobs", { payload: [{ jobId: "job-remote-1", state: "OTHER" }], version: 5 });
  await assert.rejects(
    () => adapter.saveCollectionAsync("workforceJobs", [{ jobId: "job-remote-1", state: "STALE" }]),
    /ERR_CONCURRENT_WRITE_CONFLICT/
  );

  // OutLayer idempotency durability before paid call
  let persistedBeforeCall = false;
  let callMade = false;
  const olCfg = makeProdConfig(makeTempStateFile(), {
    OUTLAYER_PAYMENT_KEY: "pk_test",
    OUTLAYER_PROJECT_OWNER: "cryptozax.near",
    OUTLAYER_PROJECT_NAME: "snowmoon-worker",
  });
  const ol = new OutLayerExecutionAdapter(olCfg, async (input) => {
    const u = String(input);
    if (u.includes("/call/")) {
      callMade = true;
      assert.equal(persistedBeforeCall, true);
      return new Response(JSON.stringify({ call_id: "c1", status: "completed", output: { jobId: "j1" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }, {
    backend: "supabase",
    saveCollection: () => {},
    getCollection: () => [],
    saveCollectionAsync: async () => { persistedBeforeCall = true; },
    upsertOutlayerCallRow: async () => { persistedBeforeCall = true; },
  } as never);
  await ol.executeAndVerify({ jobId: "j1", workerId: "w1", prompt: "test", evidenceHash: "0x" + "11".repeat(32) });
  assert.equal(callMade, true);
});

test("Phase 25.6: AI mock fallback is rejected in production when key is missing or NEAR AI fails", async () => {
  const dummyJob: JobRecord = {
    jobId: "0x" + "99".repeat(32),
    seq: 1,
    customer: "alice.near",
    sponsor: "alice.near",
    operator: "op.near",
    customerPayment: "1000000",
    maxOperatingBudget: "100000",
    operatingSpent: "0",
    termsHash: "0x" + "00".repeat(32),
    deliveryHash: "0x" + "00".repeat(32),
    storageLockedYocto: "0",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    title: "Prod AI Test",
    taskDescription: "Verify fail closed",
    state: "InProgress",
    advanceId: 0,
    expenses: [],
    anchored: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Production with auto AI mode & no key -> fails closed
  const noKeyProd = makeProdConfig(makeTempStateFile(), { NEAR_AI_API_KEY: "" });
  const aiNoKey = new AIWorkerAdapter(noKeyProd);
  await assert.rejects(() => aiNoKey.executeJobTask(dummyJob), /ERR_AI_NOT_CONFIGURED_IN_PRODUCTION/);

  // Production with key, but NEAR AI HTTP 500 -> fails closed (no mock fallback)
  const failProd = makeProdConfig(makeTempStateFile(), {
    NEAR_AI_API_KEY: "sk-test-key-123456",
  });
  const aiFail = new AIWorkerAdapter(failProd, async () => new Response("upstream error", { status: 500 }));
  await assert.rejects(() => aiFail.executeJobTask(dummyJob), /ERR_NEAR_AI_INFERENCE_FAILED/);
});

test("Phase 25.7: Cold-start HTTP request hydrates engines from Supabase and rejects duplicate escrowTxHash", async () => {
  const cfg = makeProdConfig(makeTempStateFile(), {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service_role_test",
    NEAR_AI_API_KEY: "sk-test-key-123456",
  });
  const txHash = "9abc12345678901234567890123456789012345678";
  const remoteRows = new Map<string, { payload: unknown[]; version: number }>([
    [
      "workforceJobs",
      {
        payload: [
          {
            jobId: "0x" + "aa".repeat(32),
            customerAccountId: "alice.near",
            amountAtomic: "1000000",
            prompt: "Hydrated job",
            funded: true,
            escrowTxHash: txHash,
            state: "FUNDED",
            deadlineSec: Math.floor(Date.now() / 1000) + 3600,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        version: 2,
      },
    ],
    [
      "escrowJobs",
      {
        payload: [
          {
            escrowId: "esc-1",
            jobId: "0x" + "aa".repeat(32),
            customerAccountId: "alice.near",
            workerAccountId: "worker.near",
            coreContractId: cfg.mainnetCoreContractId,
            usdcContractId: cfg.mainnetUsdcContractId,
            amountAtomic: "1000000",
            sourceTxHash: txHash,
            escrowState: "FINAL_CONFIRMED",
            onChainConfirmed: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        version: 1,
      },
    ],
  ]);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://example.supabase.co")) {
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("snowmoon_kv_collections") && method === "GET") {
        const rows = Array.from(remoteRows.entries()).map(([collection_key, v]) => ({
          collection_key,
          payload: v.payload,
          version: v.version,
        }));
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (url.includes("snowmoon_kv_collections") && method === "PATCH") {
        const parsed = new URL(url);
        const key = parsed.searchParams.get("collection_key")?.replace(/^eq\./, "") || "";
        const expectedVer = Number(parsed.searchParams.get("version")?.replace(/^eq\./, "") || "0");
        const current = remoteRows.get(key);
        if (!current || current.version !== expectedVer) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        const body = JSON.parse(String(init?.body || "{}")) as { payload: unknown[]; version: number };
        remoteRows.set(key, { payload: body.payload, version: body.version });
        return new Response(JSON.stringify([{ collection_key: key, version: body.version }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const app = createSnowMoonApp(cfg);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    // First cold-start HTTP request must hydrate WorkforceEngine & MainnetEscrowTracker
    const jobsRes = await origFetch(`${baseUrl}/api/workforce/jobs`);
    assert.equal(jobsRes.status, 200);
    const jobsJson = (await jobsRes.json()) as { jobs: Array<{ jobId: string; escrowTxHash?: string }> };
    assert.equal(jobsJson.jobs.length, 1);
    assert.equal(jobsJson.jobs[0].jobId, "0x" + "aa".repeat(32));
    assert.equal(jobsJson.jobs[0].escrowTxHash, txHash);

    // Reusing the same escrowTxHash for a second job must be rejected
    const custToken = app.walletSessionManager.issueToken({
      connected: true,
      walletType: "meteor",
      accountId: "alice.near",
      networkId: "mainnet",
      verifiedAt: new Date().toISOString(),
    });
    const dupRes = await origFetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wallet-session": custToken },
      body: JSON.stringify({
        jobId: "0x" + "bb".repeat(32),
        customerAccountId: "alice.near",
        amountAtomic: "1000000",
        prompt: "Duplicate escrow attempt",
        funded: true,
        escrowTxHash: txHash,
      }),
    });
    assert.equal(dupRes.status, 400);
    const dupJson = (await dupRes.json()) as { error: string };
    assert.match(dupJson.error, /ERR_DUPLICATE_ESCROW_TX/);
  } finally {
    globalThis.fetch = origFetch;
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 4: Wallet authentication rejects invalid NEP-413 signatures and single-use challenge replays", async () => {
  const stateFile = makeTempStateFile();
  const cfg = loadConfig({
    SNOWMOON_NETWORK: "sandbox",
    SNOWMOON_CHAIN_MODE: "sandbox",
    SNOWMOON_AI_MODE: "mock",
    SNOWMOON_STATE_FILE: stateFile,
    SNOWMOON_PERSISTENCE_FILE: stateFile,
  });
  const app = createSnowMoonApp(cfg);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const chRes = await fetch(`${baseUrl}/api/near/wallet/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "alice.near", walletType: "my-near-wallet" }),
    });
    assert.equal(chRes.status, 200);
    const chJson = (await chRes.json()) as {
      ok: boolean;
      challenge: { challengeId: string; message: string; nonceBase64: string; recipient: string };
    };
    assert.equal(chJson.ok, true);

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

    // 1. Invalid signature must be rejected
    const badVerify = await fetch(`${baseUrl}/api/near/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "alice.near",
        networkId: "mainnet",
        walletType: "my-near-wallet",
        challengeId: chJson.challenge.challengeId,
        signature: Buffer.alloc(64, 7).toString("base64"),
        publicKey: nearPub,
      }),
    });
    assert.equal(badVerify.status, 400);
    const badJson = (await badVerify.json()) as { error: string };
    assert.match(badJson.error, /ERR_WALLET_SIGNATURE_INVALID/);

    // 2. Fresh challenge + valid NEP-413 signature succeeds
    const chRes2 = await fetch(`${baseUrl}/api/near/wallet/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "alice.near", walletType: "my-near-wallet" }),
    });
    assert.equal(chRes2.status, 200);
    const chJson2 = (await chRes2.json()) as {
      ok: boolean;
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
      borshStr(chJson2.challenge.message),
      Buffer.from(chJson2.challenge.nonceBase64, "base64"),
      borshStr(chJson2.challenge.recipient),
      Buffer.from([0]),
    ]);
    const digest = crypto.createHash("sha256").update(payload).digest();
    const signature = crypto.sign(null, digest, privateKey).toString("base64");

    const okVerify = await fetch(`${baseUrl}/api/near/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "alice.near",
        networkId: "mainnet",
        walletType: "my-near-wallet",
        challengeId: chJson2.challenge.challengeId,
        signature,
        publicKey: nearPub,
      }),
    });
    assert.equal(okVerify.status, 200);

    // 3. Replaying the same challengeId must be rejected
    const replayVerify = await fetch(`${baseUrl}/api/near/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "alice.near",
        networkId: "mainnet",
        walletType: "my-near-wallet",
        challengeId: chJson2.challenge.challengeId,
        signature,
        publicKey: nearPub,
      }),
    });
    assert.equal(replayVerify.status, 400);
    const replayJson = (await replayVerify.json()) as { error: string };
    assert.match(replayJson.error, /ERR_CHALLENGE_REPLAYED/);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});
