import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { AIWorkerAdapter } from "../src/adapters.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import {
  VerificationEngine,
  computeCanonicalEvidenceHash,
} from "../src/verification.ts";
import { NearMainnetRpcAdapter } from "../src/near_rpc.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("35. Phase 16 AuditAnchor duplicate-anchor guard, AIWorkerAdapter.probeProviderHealth & outlayer-verify runner", async () => {
  const cfg = loadConfig({ SNOWMOON_AI_MODE: "mock" });
  const ver = new VerificationEngine();
  const jobId = "0x" + "61".repeat(32);
  const deliverable = { summary: "Done", result: "Evidence" };
  const hash = computeCanonicalEvidenceHash(deliverable);

  ver.submitDelivery({
    jobId,
    workerId: "w1",
    workerAccountId: "w1.near",
    expectedWorkerId: "w1",
    deliverable,
    evidenceHash: hash,
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
  });
  ver.verifyDelivery({ jobId, verifierAccountId: "alice.near", decision: "VERIFIED" });

  const mockRpc = {
    probeAuditContract: async () => ({ deploymentStatus: "NOT_DEPLOYED" }),
  } as unknown as NearMainnetRpcAdapter;

  const prep = await ver.prepareAuditAnchorTx(mockRpc, cfg, {
    jobId,
    payerAccountId: "cryptozax.near",
  });
  assert.equal(prep.transaction.actions[0].methodName, "anchor_job");

  ver.markAuditAnchored(jobId, "AuditTxHash123");
  await assert.rejects(
    () => ver.prepareAuditAnchorTx(mockRpc, cfg, { jobId, payerAccountId: "cryptozax.near" }),
    /ERR_DUPLICATE_AUDIT_ANCHOR/
  );

  // AIWorkerAdapter.probeProviderHealth redacts API key on failure & reports mock when unconfigured
  const aiMock = new AIWorkerAdapter(cfg);
  const aiMockHealth = await aiMock.probeProviderHealth();
  assert.equal(aiMockHealth.hasApiKey, false);
  assert.equal(aiMockHealth.authenticated, false);

  // OutLayer independent CLI runner rejects shell-injection characters and handles missing binary cleanly
  const ol = new OutLayerExecutionAdapter(cfg);
  await assert.rejects(
    () => ol.runIndependentOutlayerVerify("bad;rm -rf /"),
    /ERR_INVALID_VERIFY_ID/
  );
  const cliRes = await ol.runIndependentOutlayerVerify("call_test_16");
  assert.equal(typeof cliRes.available, "boolean");
  assert.ok(cliRes.command.includes("outlayer-verify tx call_test_16"));
});

test("36. Phase 16 Aggregate /api/health and /api/ai/status endpoints leak zero secrets", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snowmoon-p16-http-"));
  const app = createSnowMoonApp(
    loadConfig({
      SNOWMOON_AI_MODE: "mock",
      SNOWMOON_STATE_FILE: path.join(tmpDir, "state.json"),
      SNOWMOON_PERSISTENCE_FILE: path.join(tmpDir, "p9.json"),
      SUPABASE_SECRET_KEY: "sb_secret_never_leak_16",
      NEAR_AI_API_KEY: "near_ai_never_leak_16",
      OUTLAYER_PAYMENT_KEY: "ol_pay_never_leak_16",
    })
  );
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const hResp = await fetch(`${baseUrl}/api/health`);
    assert.equal(hResp.status, 200);
    const hText = await hResp.text();
    assert.ok(!hText.includes("sb_secret_never_leak_16"));
    assert.ok(!hText.includes("near_ai_never_leak_16"));
    assert.ok(!hText.includes("ol_pay_never_leak_16"));
    const hJson = JSON.parse(hText) as { ok: boolean; database: unknown; ai: unknown; outlayer: unknown };
    assert.equal(hJson.ok, true);
    assert.ok(hJson.database);
    assert.ok(hJson.ai);
    assert.ok(hJson.outlayer);

    const aiResp = await fetch(`${baseUrl}/api/ai/status`);
    assert.equal(aiResp.status, 200);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

