import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-phase19-"));
}

test("40. Phase 19.1 Production mode disables all sandbox/demo endpoints and enforces security headers", async () => {
  const dir = makeTempDir();
  const prodConfig = loadConfig({
    SNOWMOON_PORT: "0",
    SNOWMOON_NETWORK: "mainnet",
    SNOWMOON_CHAIN_MODE: "rpc",
    WALLET_SESSION_SECRET: "test-phase19-secret",
    SNOWMOON_STATE_FILE: path.join(dir, "state.json"),
    SNOWMOON_PERSISTENCE_FILE: path.join(dir, "db.json"),
  });
  assert.equal(prodConfig.isProductionMode, true);
  assert.equal(prodConfig.allowSandboxDemoEndpoints, false);

  const app = createSnowMoonApp(prodConfig);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = app.server.address();
    assert(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(healthRes.headers.get("x-frame-options"), "DENY");
    assert.equal(healthRes.headers.get("referrer-policy"), "no-referrer");
    assert.equal(healthRes.headers.get("cache-control"), "no-store");
    const healthJson = (await healthRes.json()) as {
      isProductionMode: boolean;
      allowSandboxDemoEndpoints: boolean;
    };
    assert.equal(healthJson.isProductionMode, true);
    assert.equal(healthJson.allowSandboxDemoEndpoints, false);

    for (const route of [
      "/api/reset",
      "/api/audit/anchor",
      "/api/jobs/create",
      "/api/float/deposit",
      "/api/demo/run-complete-journey",
    ]) {
      const resp = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(resp.status, 403, `${route} must return 403 in production mode`);
      const body = (await resp.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /ERR_SANDBOX_ENDPOINT_DISABLED_IN_PRODUCTION/);
    }
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("41. Phase 19.2 Live Mainnet Core limits & ARTIFACT_MANIFEST integrity check", async () => {
  const config = loadConfig();
  const rpc = new NearMainnetRpcAdapter(config);
  const limits = await rpc.inspectCoreContractLimits("core.cryptozax.near");
  assert.equal(limits.usdcToken, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.equal(limits.admin, "cryptozax.near");
  assert.equal(limits.maxJobPaymentUsdc, 10);
  assert.equal(limits.maxTotalExposureUsdc, 1000);
  assert.equal(limits.maxAdvanceUsdc, 250);
  assert.equal(typeof limits.vaultPaused, "boolean");
  assert.equal(typeof limits.poolPaused, "boolean");

  const repoRoot = path.resolve(process.cwd(), "..");
  const manifestPath = path.join(repoRoot, "near", "artifacts", "ARTIFACT_MANIFEST.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts: Record<
        string,
        Record<string, { path?: string; sizeBytes?: number; sha256?: string } | string>
      >;
    };

    for (const profile of ["ci-mvp", "production"]) {
      for (const fileKey of ["snapfall_core.wasm", "snapfall_audit.wasm"]) {
        const entry = manifest.artifacts[profile][fileKey] as {
          path: string;
          sizeBytes: number;
          sha256: string;
        };
        const abs = path.join(repoRoot, entry.path);
        const buf = fs.readFileSync(abs);
        const actualSha = crypto.createHash("sha256").update(buf).digest("hex");
        assert.equal(buf.length, entry.sizeBytes, `${entry.path} size mismatch`);
        assert.equal(actualSha, entry.sha256, `${entry.path} sha256 mismatch`);
      }
    }
  }
});

