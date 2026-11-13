import crypto from "node:crypto";
import { loadConfig } from "./config.ts";
import { OutLayerExecutionAdapter } from "./outlayer.ts";

function parseArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirm-paid-execution");
  if (!confirmed) {
    console.error(
      "REFUSED: Smoke test executes a real paid OutLayer call. Re-run with --confirm-paid-execution to proceed."
    );
    process.exit(2);
  }

  const config = loadConfig();
  const adapter = new OutLayerExecutionAdapter(config);
  const validation = adapter.validateConfiguration();
  if (!validation.readyForLiveExecution) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "ERR_OUTLAYER_NOT_READY",
          missingEnvVars: validation.missingEnvVars,
          withinSpendingCap: validation.withinSpendingCap,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  if (!config.outlayerExpectedWasmHash) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "ERR_MISSING_EXPECTED_WASM_HASH",
          details: "Set OUTLAYER_EXPECTED_WASM_HASH in .env before running smoke test.",
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const jobId =
    parseArgValue(args, "--job-id") || `snowmoon-smoke-${Date.now()}`;
  const workerId = "snowmoon-smoke-worker";
  const prompt = "SnowMoon OutLayer TEE smoke test";
  const evidenceHash =
    "0x" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ jobId, workerId, prompt }))
      .digest("hex");

  let record = await adapter.executeAndVerify({
    jobId,
    workerId,
    prompt,
    evidenceHash,
    asyncMode: false,
  });

  const maxPolls = Number(parseArgValue(args, "--poll-attempts") || "5");
  for (let i = 0; i < maxPolls && record.status === "EXECUTION_PENDING" && record.callId; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    record = await adapter.pollCall(record.requestId);
  }

  const cliResult = record.callId
    ? await adapter.runIndependentOutlayerVerify(record.callId)
    : {
        available: false,
        verified: false,
        command: null,
        stdout: "",
        stderr: "No callId returned by OutLayer.",
      };

  const summary = {
    ok: record.status === "ATTESTATION_VERIFIED" && cliResult.verified,
    requestId: record.requestId,
    callId: record.callId,
    status: record.status,
    computeCostMicroUsd: record.computeCostMicroUsd,
    instructions: record.instructions,
    timeMs: record.timeMs,
    attestationUrl: record.attestationUrl,
    attestationChecks: record.attestationChecks,
    independentVerify: {
      available: cliResult.available,
      verified: cliResult.verified,
      command: cliResult.command,
      stderr: cliResult.stderr || undefined,
    },
    error: record.error,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
