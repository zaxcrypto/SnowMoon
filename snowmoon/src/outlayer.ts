import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SnowMoonConfig } from "./config.ts";
import { sanitizeErrorMessage } from "./adapters.ts";
import type { SnowMoonRepository } from "./persistence.ts";

export type OutLayerExecutionState =
  | "EXECUTION_PENDING"
  | "EXECUTION_COMPLETED"
  | "ATTESTATION_PENDING"
  | "ATTESTATION_VERIFIED"
  | "ATTESTATION_FAILED"
  | "EXECUTION_FAILED"
  | "MOCK_EXECUTION";

export interface OutLayerAttestationChecks {
  wasmHashVerified: boolean;
  inputHashVerified: boolean;
  outputHashVerified: boolean;
  tdxQuotePresent: boolean;
  tdxQuoteBytes: number;
  workerMeasurementPresent: boolean;
  fiveMeasurementsPresent: boolean;
  collateralVerified: boolean;
  cryptographicRootOfTrustVerified: boolean;
  jobBindingVerified: boolean;
  outlayerVerifyCommand: string | null;
  details: string;
}

export interface OutLayerExecutionRecord {
  requestId: string;
  callId: string | null;
  jobId: string;
  workerId: string;
  inputHash: string;
  outputHash: string | null;
  evidenceHash: string;
  status: OutLayerExecutionState;
  mode: "live_outlayer" | "mock_fallback";
  output: unknown;
  computeCostMicroUsd: string | null;
  instructions: number | null;
  timeMs: number | null;
  attestationUrl: string | null;
  attestationChecks: OutLayerAttestationChecks | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Isolated OutLayer HTTPS Verifiable Execution & TEE Attestation Adapter.
 * Uses documented OutLayer HTTPS API:
 * - POST /call/{project_owner}/{project_name} (X-Payment-Key, X-Compute-Limit, X-Attached-Deposit)
 * - GET  /calls/{call_id}
 * - GET  /attestations/by-call/{call_id}
 * Never exposes X-Payment-Key, never blindly retries ambiguous charged calls, and never marks
 * ATTESTATION_VERIFIED merely because attestation_url exists.
 */
export class OutLayerExecutionAdapter {
  private readonly config: SnowMoonConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly repo?: SnowMoonRepository;
  private readonly requests = new Map<string, OutLayerExecutionRecord>();

  constructor(
    config: SnowMoonConfig,
    fetchImpl: typeof fetch = fetch,
    repo?: SnowMoonRepository
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.repo = repo;
    if (repo) {
      for (const r of repo.getCollection<OutLayerExecutionRecord>("outlayerCalls")) {
        this.requests.set(r.requestId, r);
      }
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("outlayerCalls", Array.from(this.requests.values()));
    }
  }

  public listRequests(): OutLayerExecutionRecord[] {
    return Array.from(this.requests.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  public getRequestStatus(requestId: string): OutLayerExecutionRecord | undefined {
    return this.requests.get(requestId);
  }

  public getMissingCredentials(): string[] {
    const missing: string[] = [];
    if (!this.config.hasOutlayerPaymentKey || !this.config.secrets.outlayerPaymentKey) {
      missing.push("OUTLAYER_PAYMENT_KEY");
    }
    if (!this.config.outlayerProjectOwner) missing.push("OUTLAYER_PROJECT_OWNER");
    if (!this.config.outlayerProjectName) missing.push("OUTLAYER_PROJECT_NAME");
    return missing;
  }

  public validateConfiguration() {
    const missingEnvVars = this.getMissingCredentials();
    const computeLimitNum = Number(this.config.outlayerComputeLimit || "0");
    const validComputeLimit = Number.isFinite(computeLimitNum) && computeLimitNum > 0;
    const readyForLiveExecution = missingEnvVars.length === 0 && validComputeLimit;
    return {
      readyForLiveExecution,
      mode: readyForLiveExecution ? ("live_outlayer" as const) : ("mock_fallback" as const),
      missingEnvVars,
      configuredOwner: this.config.outlayerProjectOwner || null,
      configuredProject: this.config.outlayerProjectName || null,
      versionKeyConfigured: Boolean(this.config.outlayerVersionKey),
      expectedWasmHashConfigured: Boolean(this.config.outlayerExpectedWasmHash),
      computeLimit: this.config.outlayerComputeLimit,
      attachedDeposit: this.config.outlayerAttachedDeposit,
      hasPaymentKey: this.config.hasOutlayerPaymentKey,
    };
  }

  public async executeAndVerify(params: {
    jobId: string;
    workerId: string;
    prompt: string;
    evidenceHash: string;
    asyncMode?: boolean;
    timeoutMs?: number;
  }): Promise<OutLayerExecutionRecord> {
    const inputPayload = {
      jobId: params.jobId,
      workerId: params.workerId,
      prompt: params.prompt,
      evidenceHash: params.evidenceHash,
    };
    const inputJson = JSON.stringify(inputPayload);
    const inputHash = "0x" + crypto.createHash("sha256").update(inputJson).digest("hex");

    const requestId =
      "ol_" +
      crypto
        .createHash("sha256")
        .update(`${params.jobId}|${params.workerId}|${inputHash}|${Date.now()}`)
        .digest("hex")
        .slice(0, 16);

    const now = new Date().toISOString();
    const record: OutLayerExecutionRecord = {
      requestId,
      callId: null,
      jobId: params.jobId,
      workerId: params.workerId,
      inputHash,
      outputHash: null,
      evidenceHash: params.evidenceHash,
      status: "EXECUTION_PENDING",
      mode: "mock_fallback",
      output: null,
      computeCostMicroUsd: null,
      instructions: null,
      timeMs: null,
      attestationUrl: null,
      attestationChecks: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(requestId, record);

    const missing = this.getMissingCredentials();
    if (missing.length > 0) {
      if (this.config.isProductionMode) {
        record.status = "EXECUTION_FAILED";
        record.mode = "live_outlayer";
        record.error = `ERR_OUTLAYER_NOT_CONFIGURED_IN_PRODUCTION: Missing ${missing.join(", ")}. Silent mock fallback is disabled in production.`;
        record.updatedAt = new Date().toISOString();
        this.persist();
        return record;
      }
      record.status = "MOCK_EXECUTION";
      record.mode = "mock_fallback";
      record.error = `OutLayer HTTPS execution mocked: missing ${missing.join(", ")}.`;
      record.updatedAt = new Date().toISOString();
      this.persist();
      return record;
    }

    const base = this.config.outlayerBaseUrl.replace(/\/+$/, "");
    const owner = encodeURIComponent(this.config.outlayerProjectOwner);
    const project = encodeURIComponent(this.config.outlayerProjectName);
    const paymentKey = this.config.secrets.outlayerPaymentKey;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Payment-Key": paymentKey,
      "X-Compute-Limit": this.config.outlayerComputeLimit || "10000",
    };
    if (
      this.config.outlayerAttachedDeposit &&
      this.config.outlayerAttachedDeposit !== "0"
    ) {
      headers["X-Attached-Deposit"] = this.config.outlayerAttachedDeposit;
    }

    const bodyPayload: Record<string, unknown> = {
      input: inputPayload,
      async: Boolean(params.asyncMode),
    };
    if (this.config.outlayerVersionKey) {
      bodyPayload.version_key = this.config.outlayerVersionKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 20_000);
    try {
      const resp = await this.fetchImpl(`${base}/call/${owner}/${project}`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        record.status = "EXECUTION_FAILED";
        record.mode = "live_outlayer";
        record.error = sanitizeErrorMessage(
          `OutLayer HTTP ${resp.status}: ${text}`,
          paymentKey
        );
        record.updatedAt = new Date().toISOString();
        this.persist();
        return record;
      }

      const data = (await resp.json()) as {
        call_id?: string;
        status?: string;
        output?: unknown;
        compute_cost?: string;
        instructions?: number;
        time_ms?: number;
        attestation_url?: string;
        error?: string;
      };

      record.mode = "live_outlayer";
      record.callId = data.call_id ?? null;
      record.computeCostMicroUsd = data.compute_cost ?? null;
      record.instructions = data.instructions ?? null;
      record.timeMs = data.time_ms ?? null;
      record.attestationUrl = data.attestation_url
        ? data.attestation_url.startsWith("http")
          ? data.attestation_url
          : `${base}${data.attestation_url.startsWith("/") ? "" : "/"}${data.attestation_url}`
        : null;

      if (data.status === "failed" || data.error) {
        record.status = "EXECUTION_FAILED";
        record.error = sanitizeErrorMessage(data.error || "OutLayer execution failed", paymentKey);
        record.updatedAt = new Date().toISOString();
        this.persist();
        return record;
      }

      if (params.asyncMode || data.status === "pending" || data.status === "running") {
        record.status = "EXECUTION_PENDING";
        record.updatedAt = new Date().toISOString();
        this.persist();
        return record;
      }

      record.output = data.output ?? null;
      const outSerialized =
        typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? null);
      record.outputHash =
        "0x" + crypto.createHash("sha256").update(outSerialized).digest("hex");
      record.status = record.attestationUrl ? "ATTESTATION_PENDING" : "EXECUTION_COMPLETED";
      record.updatedAt = new Date().toISOString();
      this.persist();

      if (record.attestationUrl) {
        await this.verifyAttestation(requestId);
      }
      return record;
    } catch (err) {
      clearTimeout(timer);
      // Do NOT blindly retry an ambiguous charged OutLayer request: keep as EXECUTION_PENDING
      record.mode = "live_outlayer";
      record.status = "EXECUTION_PENDING";
      record.error = sanitizeErrorMessage(
        `Ambiguous/timed-out OutLayer call (do not blindly retry; poll call_id if available): ${
          err instanceof Error ? err.message : String(err)
        }`,
        paymentKey
      );
      record.updatedAt = new Date().toISOString();
      this.persist();
      return record;
    }
  }

  public async pollCall(requestId: string): Promise<OutLayerExecutionRecord> {
    const record = this.requests.get(requestId);
    if (!record) throw new Error(`ERR_UNKNOWN_OUTLAYER_REQUEST: ${requestId}`);
    if (!record.callId) {
      throw new Error(`ERR_NO_CALL_ID: Request ${requestId} has no call_id to poll.`);
    }
    const paymentKey = this.config.secrets.outlayerPaymentKey;
    if (!paymentKey) {
      throw new Error("ERR_MISSING_PAYMENT_KEY: OUTLAYER_PAYMENT_KEY is required to poll /calls/{call_id}.");
    }

    const base = this.config.outlayerBaseUrl.replace(/\/+$/, "");
    const resp = await this.fetchImpl(`${base}/calls/${encodeURIComponent(record.callId)}`, {
      method: "GET",
      headers: {
        "X-Payment-Key": paymentKey,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(
        sanitizeErrorMessage(`OutLayer poll HTTP ${resp.status}: ${txt}`, paymentKey)
      );
    }

    const data = (await resp.json()) as {
      status?: string;
      output?: unknown;
      compute_cost?: string;
      instructions?: number;
      time_ms?: number;
      attestation_url?: string;
      error?: string;
    };

    if (data.status === "failed" || data.error) {
      record.status = "EXECUTION_FAILED";
      record.error = sanitizeErrorMessage(data.error || "OutLayer execution failed", paymentKey);
    } else if (data.status === "completed") {
      record.output = data.output ?? null;
      const outSerialized =
        typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? null);
      record.outputHash =
        "0x" + crypto.createHash("sha256").update(outSerialized).digest("hex");
      record.computeCostMicroUsd = data.compute_cost ?? record.computeCostMicroUsd;
      record.instructions = data.instructions ?? record.instructions;
      record.timeMs = data.time_ms ?? record.timeMs;
      record.attestationUrl = data.attestation_url
        ? data.attestation_url.startsWith("http")
          ? data.attestation_url
          : `${base}${data.attestation_url.startsWith("/") ? "" : "/"}${data.attestation_url}`
        : record.attestationUrl;
      record.status = record.attestationUrl ? "ATTESTATION_PENDING" : "EXECUTION_COMPLETED";
      record.error = null;
    } else {
      record.status = "EXECUTION_PENDING";
    }
    record.updatedAt = new Date().toISOString();
    this.persist();

    if (record.status === "ATTESTATION_PENDING" && record.attestationUrl) {
      await this.verifyAttestation(requestId);
    }
    return record;
  }

  public async verifyAttestation(requestId: string): Promise<OutLayerExecutionRecord> {
    const record = this.requests.get(requestId);
    if (!record) throw new Error(`ERR_UNKNOWN_OUTLAYER_REQUEST: ${requestId}`);
    if (!record.attestationUrl) {
      record.status = "ATTESTATION_FAILED";
      record.attestationChecks = {
        wasmHashVerified: false,
        inputHashVerified: false,
        outputHashVerified: false,
        tdxQuotePresent: false,
        tdxQuoteBytes: 0,
        workerMeasurementPresent: false,
        fiveMeasurementsPresent: false,
        collateralVerified: false,
        cryptographicRootOfTrustVerified: false,
        jobBindingVerified: false,
        outlayerVerifyCommand: null,
        details: "Missing attestation_url on OutLayer response.",
      };
      record.updatedAt = new Date().toISOString();
      this.persist();
      return record;
    }

    try {
      const resp = await this.fetchImpl(record.attestationUrl, { method: "GET" });
      if (!resp.ok) {
        record.status = "ATTESTATION_FAILED";
        record.error = `Attestation fetch failed (HTTP ${resp.status}).`;
        record.updatedAt = new Date().toISOString();
        this.persist();
        return record;
      }

      const att = (await resp.json()) as {
        wasm_hash?: string;
        input_hash?: string;
        output_hash?: string;
        tdx_quote?: string;
        worker_measurement?: string;
        mrtd?: string;
        rtmr0?: string;
        rtmr1?: string;
        rtmr2?: string;
        rtmr3?: string;
        job_id?: string;
        collateral?: {
          pck_cert_chain?: string;
          tcb_info?: string;
          qe_identity?: string;
          next_update?: string;
        };
      };

      const norm = (s?: string) => (s || "").trim().toLowerCase().replace(/^0x/, "");
      const wasmOk = this.config.outlayerExpectedWasmHash
        ? norm(att.wasm_hash) === norm(this.config.outlayerExpectedWasmHash)
        : Boolean(att.wasm_hash && norm(att.wasm_hash).length === 64);
      const inputOk = Boolean(att.input_hash && norm(att.input_hash) === norm(record.inputHash));
      const outputOk = Boolean(
        att.output_hash && record.outputHash && norm(att.output_hash) === norm(record.outputHash)
      );
      const rawQuote = (att.tdx_quote || "").trim();
      const tdxOk = Boolean(rawQuote && rawQuote.length >= 32);
      const tdxQuoteBytes = rawQuote
        ? /^[0-9a-fA-F]+$/.test(rawQuote)
          ? Math.floor(rawQuote.length / 2)
          : Buffer.from(rawQuote, "base64").length
        : 0;
      const measOk = Boolean(att.worker_measurement || att.mrtd);
      const fiveMeasurementsPresent = Boolean(
        att.mrtd && att.rtmr0 && att.rtmr1 && att.rtmr2 && att.rtmr3
      );

      let collateralVerified = false;
      let collateralInvalid = false;
      if (att.collateral) {
        const hasChain = Boolean(att.collateral.pck_cert_chain && att.collateral.tcb_info);
        const notExpired = att.collateral.next_update
          ? Date.parse(att.collateral.next_update) > Date.now()
          : true;
        collateralVerified = hasChain && notExpired;
        collateralInvalid = !collateralVerified;
      }

      const jobBindingVerified = att.job_id ? att.job_id === record.jobId : true;
      const allVerified =
        wasmOk && inputOk && outputOk && tdxOk && measOk && !collateralInvalid && jobBindingVerified;
      const verifyCmd = this.getIndependentVerifyCommand(record.callId || record.requestId);

      record.attestationChecks = {
        wasmHashVerified: wasmOk,
        inputHashVerified: inputOk,
        outputHashVerified: outputOk,
        tdxQuotePresent: tdxOk,
        tdxQuoteBytes,
        workerMeasurementPresent: measOk,
        fiveMeasurementsPresent,
        collateralVerified,
        cryptographicRootOfTrustVerified: false,
        jobBindingVerified,
        outlayerVerifyCommand: verifyCmd,
        details: allVerified
          ? collateralVerified
            ? "WASM hash, input/output hashes, TDX quote, worker measurement, and Intel collateral verified (run outlayer-verify CLI for independent Intel DCAP signature verification)."
            : "WASM hash, input/output hashes, TDX quote, and worker measurement verified (full Intel TDX collateral not included in response; run outlayer-verify CLI for independent root-of-trust check)."
          : "Attestation check incomplete, expired, or mismatched.",
      };
      record.status = allVerified ? "ATTESTATION_VERIFIED" : "ATTESTATION_FAILED";
      if (!allVerified) {
        record.error = "ERR_ATTESTATION_VERIFICATION_FAILED: One or more TEE attestation checks failed.";
      }
      record.updatedAt = new Date().toISOString();
      this.persist();
      return record;
    } catch (err) {
      record.status = "ATTESTATION_FAILED";
      record.error = err instanceof Error ? err.message : String(err);
      record.updatedAt = new Date().toISOString();
      this.persist();
      return record;
    }
  }

  public getIndependentVerifyCommand(txOrCallId: string): string {
    const base = this.config.outlayerBaseUrl.replace(/\/+$/, "");
    return `outlayer-verify tx ${txOrCallId.trim()} --api ${base}`;
  }

  /**
   * Attempts to run the official independent `outlayer-verify` CLI if installed on PATH.
   * Safe via execFile (no shell interpolation). Reports available: false when not installed.
   */
  public async runIndependentOutlayerVerify(txOrCallId: string): Promise<{
    available: boolean;
    verified: boolean;
    command: string;
    stdout: string;
    stderr: string;
  }> {
    const cleanId = txOrCallId.trim();
    if (!/^[A-Za-z0-9_.\-:]+$/.test(cleanId)) {
      throw new Error("ERR_INVALID_VERIFY_ID: Invalid characters in transaction or call ID.");
    }
    const base = this.config.outlayerBaseUrl.replace(/\/+$/, "");
    const command = `outlayer-verify tx ${cleanId} --api ${base}`;
    const execFileAsync = promisify(execFile);
    try {
      const { stdout, stderr } = await execFileAsync(
        "outlayer-verify",
        ["tx", cleanId, "--api", base],
        { timeout: 15_000 }
      );
      return { available: true, verified: true, command, stdout, stderr };
    } catch (err) {
      const e = err as { code?: string; stdout?: string; stderr?: string; message?: string };
      if (e.code === "ENOENT") {
        return {
          available: false,
          verified: false,
          command,
          stdout: "",
          stderr: "outlayer-verify CLI not installed on host (cargo install --git https://github.com/out-layer/outlayer-verify outlayer-verify).",
        };
      }
      return {
        available: true,
        verified: false,
        command,
        stdout: String(e.stdout || ""),
        stderr: String(e.stderr || e.message || "outlayer-verify failed"),
      };
    }
  }

  /**
   * Independent public OutLayer attestation check by call_id.
   * Does NOT require OUTLAYER_PAYMENT_KEY (payment authorization and TEE verification are separate).
   */
  public async verifyPublicAttestationByCallId(
    callId: string,
    expected?: { expectedWasmHash?: string; expectedInputHash?: string; expectedOutputHash?: string }
  ): Promise<{
    callId: string;
    checks: OutLayerAttestationChecks;
    passedBasicChecks: boolean;
  }> {
    const cleanId = callId.trim();
    if (!cleanId) throw new Error("ERR_INVALID_CALL_ID: callId is required.");
    const base = this.config.outlayerBaseUrl.replace(/\/+$/, "");
    const resp = await this.fetchImpl(
      `${base}/attestations/by-call/${encodeURIComponent(cleanId)}`,
      { method: "GET" }
    );
    if (!resp.ok) {
      throw new Error(`ERR_ATTESTATION_HTTP_${resp.status}: Failed to fetch attestation for ${cleanId}`);
    }
    const att = (await resp.json()) as {
      wasm_hash?: string;
      input_hash?: string;
      output_hash?: string;
      tdx_quote?: string;
      worker_measurement?: string;
      mrtd?: string;
      rtmr0?: string;
      rtmr1?: string;
      rtmr2?: string;
      rtmr3?: string;
      collateral?: {
        pck_cert_chain?: string;
        tcb_info?: string;
        qe_identity?: string;
        next_update?: string;
      };
    };

    const norm = (s?: string) => (s || "").trim().toLowerCase().replace(/^0x/, "");
    const targetWasm = expected?.expectedWasmHash || this.config.outlayerExpectedWasmHash;
    const wasmOk = targetWasm
      ? norm(att.wasm_hash) === norm(targetWasm)
      : Boolean(att.wasm_hash && norm(att.wasm_hash).length === 64);
    const inputOk = expected?.expectedInputHash
      ? norm(att.input_hash) === norm(expected.expectedInputHash)
      : Boolean(att.input_hash && norm(att.input_hash).length === 64);
    const outputOk = expected?.expectedOutputHash
      ? norm(att.output_hash) === norm(expected.expectedOutputHash)
      : Boolean(att.output_hash && norm(att.output_hash).length === 64);
    const rawQuote = (att.tdx_quote || "").trim();
    const tdxOk = Boolean(rawQuote && rawQuote.length >= 32);
    const tdxQuoteBytes = rawQuote
      ? /^[0-9a-fA-F]+$/.test(rawQuote)
        ? Math.floor(rawQuote.length / 2)
        : Buffer.from(rawQuote, "base64").length
      : 0;
    const measOk = Boolean(att.worker_measurement || att.mrtd);
    const fiveMeasurementsPresent = Boolean(
      att.mrtd && att.rtmr0 && att.rtmr1 && att.rtmr2 && att.rtmr3
    );
    const hasCollateral = Boolean(att.collateral?.pck_cert_chain && att.collateral?.tcb_info);
    const notExpired = att.collateral?.next_update
      ? Date.parse(att.collateral.next_update) > Date.now()
      : true;
    const collateralVerified = hasCollateral && notExpired;
    const passedBasicChecks =
      wasmOk && inputOk && outputOk && tdxOk && measOk && fiveMeasurementsPresent && collateralVerified;

    return {
      callId: cleanId,
      passedBasicChecks,
      checks: {
        wasmHashVerified: wasmOk,
        inputHashVerified: inputOk,
        outputHashVerified: outputOk,
        tdxQuotePresent: tdxOk,
        tdxQuoteBytes,
        workerMeasurementPresent: measOk,
        fiveMeasurementsPresent,
        collateralVerified,
        cryptographicRootOfTrustVerified: false,
        jobBindingVerified: true,
        outlayerVerifyCommand: this.getIndependentVerifyCommand(cleanId),
        details: passedBasicChecks
          ? "All 5 TDX measurements, hashes, quote, and collateral fields valid; execute outlayer-verify CLI for independent Intel DCAP signature verification."
          : "Incomplete 5-measurement TDX attestation, expired collateral, or hash mismatch.",
      },
    };
  }
}
