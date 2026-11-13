import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { SnowMoonRepository } from "../src/persistence.ts";
import { createSnowMoonApp, PRODUCTION_ROUTE_POLICY } from "../src/server.ts";

const execFileAsync = promisify(execFile);

function makeTempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase23-"));
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
    SNOWMOON_SILENT_LOGS: "true",
    ...overrides,
  });
}

function loadDotEnvIfPresent(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    out[key] = val;
  }
  return out;
}

test("Phase 23.1: Observability (/api/metrics, /api/health, X-Request-Id), static security headers, traversal blocking, and secret redaction", async () => {
  const stateFile = makeTempStateFile();
  const sentinelOutlayerKey = "pk_live_phase23_super_secret_key_999";
  const sentinelServiceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.phase23secret";
  const config = makeProdConfig(stateFile, {
    OUTLAYER_PAYMENT_KEY: sentinelOutlayerKey,
    SUPABASE_SERVICE_ROLE_KEY: sentinelServiceKey,
  });

  const app = createSnowMoonApp(config);
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", 2048, () => resolve());
  });

  try {
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    assert.ok(
      PRODUCTION_ROUTE_POLICY.productionAllowedRoutes.publicReadOnly.includes("/api/metrics"),
      "/api/metrics must be listed in publicReadOnly policy"
    );

    // 1. Custom X-Request-Id propagation & unsafe header sanitization
    const customId = "req-phase23-trace-001";
    const healthRes = await fetch(`${baseUrl}/api/health`, {
      headers: { "X-Request-Id": customId },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("x-request-id"), customId);
    const healthBody = (await healthRes.json()) as {
      ok: boolean;
      uptimeSec: number;
      metrics: { requestsTotal: number; errors4xx: number; errors5xx: number; rateLimited: number };
      recovery: {
        pendingEscrows: number;
        pendingAnchors: number;
        failedAnchors: number;
        pendingSettlements: number;
        failedSettlements: number;
        failedOutlayerCalls: number;
      };
    };
    assert.equal(healthBody.ok, true);
    assert.equal(typeof healthBody.uptimeSec, "number");
    assert.ok(healthBody.metrics.requestsTotal >= 1);
    assert.equal(typeof healthBody.recovery.pendingEscrows, "number");
    assert.equal(typeof healthBody.recovery.failedOutlayerCalls, "number");

    const unsafeRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { "X-Request-Id": "bad id with spaces & <script>" },
    });
    assert.equal(unsafeRes.status, 200);
    const sanitizedId = unsafeRes.headers.get("x-request-id") || "";
    assert.ok(sanitizedId.length >= 8 && !sanitizedId.includes("<script>"));
    const metricsBody = (await unsafeRes.json()) as {
      ok: boolean;
      requests: { requestsTotal: number };
      counts: { workers: number; jobs: number; escrows: number };
    };
    assert.equal(metricsBody.ok, true);
    assert.ok(metricsBody.requests.requestsTotal >= 2);
    assert.equal(typeof metricsBody.counts.workers, "number");

    // 2. Static UI security headers & path traversal protection
    const uiRes = await fetch(`${baseUrl}/`);
    assert.equal(uiRes.status, 200);
    assert.equal(uiRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(uiRes.headers.get("x-frame-options"), "DENY");
    assert.equal(uiRes.headers.get("referrer-policy"), "no-referrer");

    for (const badPath of ["/../.env", "/%2e%2e/.env", "/..%2fpackage.json", "/../package.json"]) {
      const travRes = await fetch(`${baseUrl}${badPath}`);
      assert.equal(travRes.status, 404, `Traversal path ${badPath} must return 404`);
    }

    // 3. Zero secret leakage across public endpoints
    const stateRes = await fetch(`${baseUrl}/api/state`);
    const allTexts = [
      JSON.stringify(healthBody),
      JSON.stringify(metricsBody),
      await stateRes.text(),
    ].join("\n");
    assert.equal(allTexts.includes(sentinelOutlayerKey), false);
    assert.equal(allTexts.includes(sentinelServiceKey), false);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

function concurrentGets(
  baseUrl: string,
  pathname: string,
  count: number,
  prefix: string
): Promise<Array<{ status: number; requestId: string | undefined }>> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 150 });
  const target = new URL(pathname, baseUrl);
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      new Promise<{ status: number; requestId: string | undefined }>((resolve, reject) => {
        const req = http.request(
          target,
          {
            method: "GET",
            agent,
            headers: { "X-Request-Id": `${prefix}-${i}` },
          },
          (res) => {
            res.resume();
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                requestId:
                  typeof res.headers["x-request-id"] === "string"
                    ? res.headers["x-request-id"]
                    : undefined,
              });
            });
          }
        );
        req.on("error", reject);
        req.end();
      })
    )
  ).finally(() => {
    agent.destroy();
  });
}

test("Phase 23.2: Scale & Concurrency (100, 500, 1,000 concurrent reads + separate write rate-limit bucket)", async () => {
  const stateFile = makeTempStateFile();
  const config = makeProdConfig(stateFile);
  const app = createSnowMoonApp(config);

  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", 2048, () => resolve());
  });

  try {
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Run 100 and 500 concurrent GET /api/workforce/jobs requests (600 total, well inside 1,200/min read cap)
    for (const batchSize of [100, 500]) {
      const responses = await concurrentGets(baseUrl, "/api/workforce/jobs", batchSize, `load-${batchSize}`);
      const non200 = responses.filter((r) => r.status !== 200);
      assert.equal(non200.length, 0, `Batch ${batchSize} had unexpected non-200 statuses: ${JSON.stringify(non200.slice(0, 5))}`);
    }

    // Now fire 1,000 concurrent GET /api/health requests on a fresh server instance so read limit (1,200/min) is not exhausted
    const app1000 = createSnowMoonApp(makeProdConfig(makeTempStateFile()));
    await new Promise<void>((resolve) => {
      app1000.server.listen(0, "127.0.0.1", 2048, () => resolve());
    });
    try {
      const addr1000 = app1000.server.address();
      assert.ok(addr1000 && typeof addr1000 === "object");
      const base1000 = `http://127.0.0.1:${addr1000.port}`;
      const res1000 = await concurrentGets(base1000, "/api/health", 1000, "burst1k");
      const serverErrors = res1000.filter((r) => r.status >= 500).length;
      const rateLimited = res1000.filter((r) => r.status === 429).length;
      assert.equal(serverErrors, 0, "1,000 concurrent reads must produce zero 5xx errors");
      assert.equal(rateLimited, 0, "1,000 concurrent reads must fit within 1,200/min read bucket");

      // Verify write bucket (>120 POSTs) triggers 429 cleanly WITHOUT blocking subsequent GET reads
      const writeBurst = await Promise.all(
        Array.from({ length: 125 }, () =>
          fetch(`${base1000}/api/auth/challenge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: "alice.near" }),
          })
        )
      );
      const write429s = writeBurst.filter((r) => r.status === 429).length;
      assert.ok(write429s >= 5, `Expected >= 5 write 429s after 125 POSTs, got ${write429s}`);

      const readAfterWriteLimit = await fetch(`${base1000}/api/metrics`);
      assert.equal(readAfterWriteLimit.status, 200);
      const m = (await readAfterWriteLimit.json()) as {
        requests: { rateLimited: number };
      };
      assert.ok(m.requests.rateLimited >= 5);
    } finally {
      await new Promise<void>((resolve) => app1000.server.close(() => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("Phase 23.3: Race condition & idempotency guarantees (double assignment, duplicate settlement)", () => {
  const stateFile = makeTempStateFile();
  const config = makeProdConfig(stateFile);
  const app = createSnowMoonApp(config);

  app.workforceEngine.registerWorker({
    workerId: "w-race-1",
    accountId: "worker1.near",
    displayName: "Worker 1",
    capabilities: ["code-review"],
    maxConcurrentJobs: 2,
  });
  app.workforceEngine.registerWorker({
    workerId: "w-race-2",
    accountId: "worker2.near",
    displayName: "Worker 2",
    capabilities: ["code-review"],
    maxConcurrentJobs: 2,
  });

  const jobId = "0x" + "1".repeat(64);
  app.workforceEngine.registerJob({
    jobId,
    customerAccountId: "customer.near",
    requiredCapabilities: ["code-review"],
    prompt: "Audit contract",
    amountAtomic: "1000000",
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    funded: true,
  });

  // First assignment succeeds
  const assigned = app.workforceEngine.assignJob(jobId, "w-race-1");
  assert.equal(assigned.assignedWorkerId, "w-race-1");

  // Re-assigning to a different worker while already assigned must fail
  assert.throws(
    () => app.workforceEngine.assignJob(jobId, "w-race-2"),
    /ERR_INVALID_STATE|Cannot assign job in state ASSIGNED/i
  );

  // Settlement idempotency: identical jobId + kind returns the existing PREPARED record instead of duplicating
  const s1 = app.settlementEngine.prepareSettlement(config, {
    jobId,
    kind: "PAYOUT_ACCEPT_DELIVERY",
    verificationStatus: "VERIFIED",
    customerAccountId: "customer.near",
    workerAccountId: "worker1.near",
    grossAmountAtomic: "1000000",
  });
  const s2 = app.settlementEngine.prepareSettlement(config, {
    jobId,
    kind: "PAYOUT_ACCEPT_DELIVERY",
    verificationStatus: "VERIFIED",
    customerAccountId: "customer.near",
    workerAccountId: "worker1.near",
    grossAmountAtomic: "1000000",
  });
  assert.equal(s1.settlementId, s2.settlementId);
  assert.equal(app.settlementEngine.listSettlements().length, 1);
});

test("Phase 23.4: Live read-only production verification (outlayer-verify CLI, Mainnet RPC contracts, Supabase connectivity)", async () => {
  // 1. Verify outlayer-verify binary is installed and responsive (zero paid calls)
  try {
    const { stdout: helpOut } = await execFileAsync("outlayer-verify", ["--help"], {
      windowsHide: true,
    });
    assert.ok(helpOut.includes("call") || helpOut.includes("outlayer-verify"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" || process.env.SNOWMOON_REQUIRE_OUTLAYER_VERIFY === "true") {
      throw err;
    }
  }

  const dotEnv = loadDotEnvIfPresent();
  const liveCfg = loadConfig({
    ...dotEnv,
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    SNOWMOON_ENV: "production",
  });

  // 2. Verify OutLayer configuration & pinned WASM hash if .env is present
  if (dotEnv.OUTLAYER_PAYMENT_KEY) {
    const outlayer = new OutLayerExecutionAdapter(liveCfg);
    const validation = outlayer.validateConfiguration();
    assert.equal(validation.readyForLiveExecution, true);
    assert.equal(validation.configuredOwner, "cryptozax.near");
    assert.equal(validation.configuredProject, "snowmoon-worker");
    assert.equal(validation.hasPaymentKey, true);
  }

  // 3. Read-only Mainnet RPC contract state check (core.cryptozax.near & audit.cryptozax.near)
  if (process.env.SNOWMOON_SKIP_LIVE_NETWORK !== "true") {
    const rpc = new NearMainnetRpcAdapter(liveCfg);
    try {
      const [coreProbe, auditState] = await Promise.all([
        rpc.probeCoreContract(liveCfg.mainnetCoreContractId),
        rpc.inspectAuditContractState(liveCfg.mainnetAuditContractId),
      ]);
      assert.equal(coreProbe.contractId, "core.cryptozax.near");
      assert.equal(coreProbe.accountExists, true);
      assert.equal(auditState.contractId, "audit.cryptozax.near");
      assert.equal(auditState.exists, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Do not fail offline unit runs if RPC host is unreachable in an isolated sandbox
      if (!/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
        throw err;
      }
    }
  }

  // 4. Read-only Supabase connectivity check when configured in .env
  if (dotEnv.SUPABASE_URL && dotEnv.SUPABASE_SERVICE_ROLE_KEY && process.env.SNOWMOON_SKIP_LIVE_NETWORK !== "true") {
    const repo = SnowMoonRepository.fromConfig(liveCfg);
    const dbHealth = await repo.healthCheck();
    assert.equal(dbHealth.backend, "supabase");
    if (!dbHealth.connected) {
      // Surface diagnostic message if unreachable
      assert.fail(`Supabase healthCheck failed: ${dbHealth.details}`);
    }
  }
});

