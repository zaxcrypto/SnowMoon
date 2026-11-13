import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { SnowMoonRepository } from "../src/persistence.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("31. Phase 14.1 Live read-only production verification: Supabase 001+002 RLS hardening & Mainnet Core paused state", async () => {
  const cfg = loadConfig();
  const repo = SnowMoonRepository.fromConfig(cfg);
  const health = await repo.healthCheck();
  if (cfg.persistenceBackend === "supabase") {
    assert.equal(health.backend, "supabase");
    assert.equal(health.connected, true);
    assert.equal(health.migrationsApplied, true);
    assert.equal(health.rlsHardened, true);
    assert.equal(health.migrationVersion, "002_rls_hardening");
    assert.equal(health.productionReady, true);
  } else {
    assert.equal(health.backend, "json");
    assert.equal(health.connected, true);
  }

  const rpc = new NearMainnetRpcAdapter(cfg);
  const core = await rpc.probeCoreContract();
  assert.equal(core.deploymentStatus, "DEPLOYED_AND_INITIALIZED");
  const view = core.viewQueryResult as { vault_paused?: boolean; pool_paused?: boolean } | undefined;
  assert.equal(view?.vault_paused, true);
  assert.equal(view?.pool_paused, true);
});

test("32. Phase 14.3 Worker bearer-token enforcement & empty prompt validation over HTTP", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p14-http-"));
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
    // Register worker with issueToken: true
    const regResp = await fetch(`${baseUrl}/api/workforce/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "w-auth-14",
        accountId: "worker14.near",
        displayName: "Auth Worker 14",
        capabilities: ["research"],
        issueToken: true,
      }),
    });
    assert.equal(regResp.status, 200);
    const regJson = (await regResp.json()) as { ok: boolean; workerToken?: string };
    assert.ok(regJson.workerToken && regJson.workerToken.length > 10);

    // Empty prompt rejected
    const jobId = "0x" + "14".repeat(32);
    const badJob = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        customerAccountId: "alice.near",
        amountAtomic: "1000000",
        requiredCapabilities: ["research"],
        prompt: "   ",
      }),
    });
    assert.equal(badJob.status, 400);

    // Valid job -> assign -> wrong worker token rejected -> valid worker token accepted & executed
    const okJob = await fetch(`${baseUrl}/api/workforce/jobs/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        customerAccountId: "alice.near",
        amountAtomic: "1000000",
        requiredCapabilities: ["research"],
        prompt: "Audit SnowMoon Phase 14 readiness",
      }),
    });
    assert.equal(okJob.status, 200);

    await fetch(`${baseUrl}/api/workforce/jobs/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, workerId: "w-auth-14" }),
    });

    const badTokenAccept = await fetch(`${baseUrl}/api/workforce/jobs/accept`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-token": "wrong_token",
      },
      body: JSON.stringify({ jobId, workerId: "w-auth-14" }),
    });
    assert.ok(badTokenAccept.status === 400 || badTokenAccept.status === 401 || badTokenAccept.status === 403);

    const okAccept = await fetch(`${baseUrl}/api/workforce/jobs/accept`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-token": regJson.workerToken,
      },
      body: JSON.stringify({ jobId, workerId: "w-auth-14" }),
    });
    assert.equal(okAccept.status, 200);

    const okExec = await fetch(`${baseUrl}/api/workforce/jobs/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-token": regJson.workerToken,
      },
      body: JSON.stringify({ jobId, workerId: "w-auth-14" }),
    });
    assert.equal(okExec.status, 200);
    const execJson = (await okExec.json()) as { job: { state: string } };
    assert.equal(execJson.job.state, "DELIVERED");
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
