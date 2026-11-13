import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { OutLayerExecutionAdapter } from "../src/outlayer.ts";
import { createSnowMoonApp } from "../src/server.ts";

test("33. Phase 15.3 Independent OutLayer public attestation verification (no OUTLAYER_PAYMENT_KEY required) & 5-measurement check", async () => {
  const cfgNoPayKey = loadConfig({
    OUTLAYER_EXPECTED_WASM_HASH: "dd".repeat(32),
  });
  assert.equal(cfgNoPayKey.hasOutlayerPaymentKey, false);

  let omitRtmr3 = false;
  const mockFetch = (async (url: string) => {
    if (url.includes("/attestations/by-call/call_pub_1")) {
      return new Response(
        JSON.stringify({
          wasm_hash: "dd".repeat(32),
          input_hash: "11".repeat(32),
          output_hash: "22".repeat(32),
          tdx_quote: "dGVzdF90ZHhfcXVvdGVfYnl0ZXNfMTIzNDU2Nzg5MDEyMzQ1Njc4OTA=",
          worker_measurement: "mrtd_pub",
          mrtd: "a1".repeat(48),
          rtmr0: "b1".repeat(48),
          rtmr1: "c1".repeat(48),
          rtmr2: "d1".repeat(48),
          rtmr3: omitRtmr3 ? "" : "e1".repeat(48),
          collateral: {
            pck_cert_chain: "-----BEGIN CERTIFICATE-----MOCK-----END CERTIFICATE-----",
            tcb_info: "{\"version\":3}",
            next_update: new Date(Date.now() + 86_400_000).toISOString(),
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const ol = new OutLayerExecutionAdapter(cfgNoPayKey, mockFetch);
  const ok = await ol.verifyPublicAttestationByCallId("call_pub_1", {
    expectedWasmHash: "dd".repeat(32),
    expectedInputHash: "11".repeat(32),
    expectedOutputHash: "22".repeat(32),
  });
  assert.equal(ok.passedBasicChecks, true);
  assert.equal(ok.checks.fiveMeasurementsPresent, true);
  assert.equal(ok.checks.collateralVerified, true);
  assert.equal(ok.checks.cryptographicRootOfTrustVerified, false);
  assert.ok(ok.checks.outlayerVerifyCommand?.includes("outlayer-verify call call_pub_1"));

  omitRtmr3 = true;
  const bad = await ol.verifyPublicAttestationByCallId("call_pub_1");
  assert.equal(bad.passedBasicChecks, false);
  assert.equal(bad.checks.fiveMeasurementsPresent, false);
});

test("34. Phase 15.2 & 15.7 Live read-only NEAR AI /v1/models check + CI workflow & RELEASE_RUNBOOK existence", async () => {
  const wfPath = path.resolve(process.cwd(), "..", ".github", "workflows", "snowmoon-ts.yml");
  assert.ok(fs.existsSync(wfPath), "snowmoon-ts.yml workflow must exist");
  const runbookPath = path.resolve(process.cwd(), "RELEASE_RUNBOOK.md");
  assert.ok(fs.existsSync(runbookPath), "RELEASE_RUNBOOK.md must exist");

  const cfg = loadConfig();
  if (cfg.hasNearAiKey) {
    const resp = await fetch(`${cfg.nearAiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.secrets.nearAiApiKey}` },
    });
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { data?: Array<{ id: string }> };
    assert.ok(
      (json.data || []).some((m) => m.id === cfg.nearAiModel),
      `Configured model ${cfg.nearAiModel} must be listed in NEAR AI Cloud`
    );
  }

  // Verify HTTP endpoint /api/outlayer/verify-public route exists
  const app = createSnowMoonApp(loadConfig({ SNOWMOON_AI_MODE: "mock" }));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${addr.port}/api/outlayer/verify-public`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: "" }),
    });
    assert.equal(r.status, 400);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

