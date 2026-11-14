import crypto from "node:crypto";
import type { SnowMoonConfig } from "./config.ts";
import { ANCHOR_STORAGE_DEPOSIT } from "./engine.ts";
import type { SnowMoonRepository } from "./persistence.ts";
import {
  assertValidNearAccountId,
  normalizeHex32Lowercase,
  type NearMainnetRpcAdapter,
  type PreparedNearTransaction,
} from "./near_rpc.ts";

export type VerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "REJECTED"
  | "DISPUTED"
  | "EXPIRED";

export type AnchorStatus =
  | "NONE"
  | "PREPARED"
  | "SUBMITTED"
  | "PENDING"
  | "ANCHORED"
  | "FAILED";

export interface DeliverySubmissionRecord {
  jobId: string;
  workerId: string;
  workerAccountId: string;
  deliverable: Record<string, unknown>;
  evidenceHash: string;
  deadlineSec: number;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  reason: string | null;
  anchorStatus?: AnchorStatus;
  auditTxHash?: string | null;
  auditSignerAccountId?: string | null;
  auditContractId?: string | null;
  auditError?: string | null;
  eventRoot?: string | null;
  paymentReceiptRoot?: string | null;
  completedAtSec?: number | null;
  anchorPreparedAt?: string | null;
  anchorSubmittedAt?: string | null;
  anchoredAt?: string | null;
  submittedAt: string;
  updatedAt: string;
}

function sha256Hex32(input: string): string {
  return "0x" + crypto.createHash("sha256").update(input).digest("hex");
}

function isValidNearTxHash(txHash: string): boolean {
  const trimmed = txHash.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(trimmed);
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => (item === undefined ? "null" : canonicalJsonStringify(item))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`).join(",") +
    "}"
  );
}

export function computeCanonicalEvidenceHash(deliverable: Record<string, unknown>): string {
  const canonical = canonicalJsonStringify(deliverable);
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

export class VerificationEngine {
  private readonly submissions = new Map<string, DeliverySubmissionRecord>();
  private readonly repo?: SnowMoonRepository;

  constructor(repo?: SnowMoonRepository) {
    this.repo = repo;
    this.reloadFromRepo();
  }

  public reloadFromRepo(): void {
    if (!this.repo) return;
    this.submissions.clear();
    const saved = this.repo.getCollection<DeliverySubmissionRecord>("verifications");
    if (saved.length > 0) {
      this.restoreSubmissions(saved);
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("verifications", this.exportSubmissions());
    }
  }

  public listSubmissions(): DeliverySubmissionRecord[] {
    return Array.from(this.submissions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public getSubmission(jobId: string): DeliverySubmissionRecord | undefined {
    return this.submissions.get(jobId);
  }

  public exportSubmissions(): DeliverySubmissionRecord[] {
    return Array.from(this.submissions.values());
  }

  public restoreSubmissions(records: DeliverySubmissionRecord[]): void {
    this.submissions.clear();
    for (const rec of records) {
      if (!rec || typeof rec.jobId !== "string") continue;
      const anchorStatus: AnchorStatus =
        rec.anchorStatus ?? (rec.auditTxHash ? "ANCHORED" : "NONE");
      this.submissions.set(rec.jobId, {
        ...rec,
        anchorStatus,
      });
    }
  }

  public submitDelivery(params: {
    jobId: string;
    workerId: string;
    workerAccountId: string;
    expectedWorkerId: string;
    deliverable: Record<string, unknown>;
    evidenceHash: string;
    deadlineSec: number;
    nowSec?: number;
  }): DeliverySubmissionRecord {
    const existing = this.submissions.get(params.jobId);
    if (
      existing &&
      (existing.verificationStatus === "PENDING" || existing.verificationStatus === "VERIFIED")
    ) {
      throw new Error(
        `ERR_DUPLICATE_DELIVERY: Job ${params.jobId} already has delivery in status ${existing.verificationStatus}.`
      );
    }
    if (params.workerId !== params.expectedWorkerId) {
      throw new Error(
        `ERR_WORKER_MISMATCH: Worker ${params.workerId} is not authorized for job ${params.jobId} (assigned: ${params.expectedWorkerId}).`
      );
    }

    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
    if (nowSec > params.deadlineSec) {
      const expired: DeliverySubmissionRecord = {
        jobId: params.jobId,
        workerId: params.workerId,
        workerAccountId: params.workerAccountId,
        deliverable: params.deliverable,
        evidenceHash: params.evidenceHash,
        deadlineSec: params.deadlineSec,
        verificationStatus: "EXPIRED",
        verifiedBy: null,
        reason: "Job deadline expired prior to delivery submission.",
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.submissions.set(params.jobId, expired);
      throw new Error(`ERR_JOB_EXPIRED: Job ${params.jobId} deadline (${params.deadlineSec}) has passed.`);
    }

    const normalizedHash = normalizeHex32Lowercase(params.evidenceHash, "evidenceHash");
    const computedHash = computeCanonicalEvidenceHash(params.deliverable);
    if (computedHash !== normalizedHash) {
      throw new Error(
        `ERR_EVIDENCE_HASH_MISMATCH: Provided evidenceHash (${normalizedHash}) does not match SHA-256 of deliverable (${computedHash}).`
      );
    }

    const now = new Date().toISOString();
    const record: DeliverySubmissionRecord = {
      jobId: params.jobId,
      workerId: params.workerId,
      workerAccountId: params.workerAccountId,
      deliverable: params.deliverable,
      evidenceHash: computedHash,
      deadlineSec: params.deadlineSec,
      verificationStatus: "PENDING",
      verifiedBy: null,
      reason: null,
      submittedAt: now,
      updatedAt: now,
      anchorStatus: "NONE",
      auditTxHash: null,
      auditSignerAccountId: null,
      auditContractId: null,
      auditError: null,
    };
    this.submissions.set(params.jobId, record);
    this.persist();
    return record;
  }

  public verifyDelivery(params: {
    jobId: string;
    verifierAccountId: string;
    decision: "VERIFIED" | "REJECTED" | "DISPUTED";
    reason?: string;
    nowSec?: number;
  }): DeliverySubmissionRecord {
    const rec = this.submissions.get(params.jobId);
    if (!rec) {
      throw new Error(`ERR_DELIVERY_NOT_FOUND: No delivery submitted for job ${params.jobId}`);
    }
    if (rec.verificationStatus === "VERIFIED") {
      throw new Error(`ERR_ALREADY_VERIFIED: Job ${params.jobId} is already VERIFIED.`);
    }
    if (rec.verificationStatus === "EXPIRED") {
      throw new Error(`ERR_JOB_EXPIRED: Job ${params.jobId} is EXPIRED.`);
    }

    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
    if (nowSec > rec.deadlineSec && params.decision === "VERIFIED") {
      rec.verificationStatus = "EXPIRED";
      rec.reason = "Deadline expired before verification.";
      rec.updatedAt = new Date().toISOString();
      throw new Error(`ERR_JOB_EXPIRED: Job ${params.jobId} expired before verification.`);
    }

    // Re-verify canonical hash integrity at verification time (anti-substitution)
    const recomputed = computeCanonicalEvidenceHash(rec.deliverable);
    if (recomputed !== rec.evidenceHash) {
      throw new Error("ERR_EVIDENCE_TAMPERED: Deliverable hash no longer matches stored evidenceHash.");
    }

    rec.verificationStatus = params.decision;
    rec.verifiedBy = assertValidNearAccountId(params.verifierAccountId, "verifierAccountId");
    rec.reason = params.reason?.trim() || null;
    rec.updatedAt = new Date().toISOString();
    this.persist();
    return rec;
  }

  public async prepareAuditAnchorTx(
    nearRpc: NearMainnetRpcAdapter,
    config: SnowMoonConfig,
    params: {
      jobId: string;
      payerAccountId: string;
      initiatorAccountId?: string;
      authorizedCustomerAccountId?: string;
      eventRoot?: string;
      paymentReceiptRoot?: string;
      completedAtSec?: number;
    }
  ): Promise<{
    auditContractId: string;
    auditContractDeployed: boolean;
    operatorAuthority: string;
    coreContractId: string;
    coreVerifyInterface: {
      method: "verify_job_for_audit";
      expectedStatus: "Accepted";
      expectedDeliveryHash: string;
    };
    anchorArgs: {
      job_id: string;
      event_root: string;
      payment_receipt_root: string;
      delivery_hash: string;
      completed_at: number;
    };
    transaction: PreparedNearTransaction;
  }> {
    const rec = this.submissions.get(params.jobId);
    if (!rec || rec.verificationStatus !== "VERIFIED") {
      throw new Error(
        `ERR_NOT_VERIFIED: Job ${params.jobId} must be VERIFIED before preparing AuditAnchor transaction.`
      );
    }
    if (rec.anchorStatus === "ANCHORED" || (rec.auditTxHash && rec.anchorStatus !== "FAILED")) {
      if (rec.anchorStatus === "SUBMITTED" || rec.anchorStatus === "PENDING") {
        throw new Error(
          `ERR_ANCHOR_IN_FLIGHT: Job ${params.jobId} has an active anchor submission (${rec.auditTxHash}). Reconcile it before retrying.`
        );
      }
      throw new Error(
        `ERR_DUPLICATE_AUDIT_ANCHOR: Job ${params.jobId} already anchored in tx ${rec.auditTxHash}.`
      );
    }

    const payer = assertValidNearAccountId(params.payerAccountId, "payerAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    const deliveryHashHex = normalizeHex32Lowercase(rec.evidenceHash, "evidenceHash");
    if (/^0x0{64}$/.test(deliveryHashHex)) {
      throw new Error("ERR_ZERO_HASH: delivery_hash must be non-zero.");
    }

    const [auditProbe, auditState] = await Promise.all([
      nearRpc.probeAuditContract(config.mainnetAuditContractId),
      typeof nearRpc.inspectAuditContractState === "function"
        ? nearRpc.inspectAuditContractState(config.mainnetAuditContractId)
        : Promise.resolve(null),
    ]);

    const expectedOperator =
      auditState && auditState.initialized && auditState.operatorAuthority
        ? auditState.operatorAuthority
        : config.mainnetAuditOperatorAccountId;
    if (payer !== expectedOperator) {
      throw new Error(
        `ERR_NOT_OPERATOR_AUTHORITY: Payer/signer ${payer} is not the authorized AuditAnchor operator_authority (${expectedOperator}).`
      );
    }

    if (params.initiatorAccountId) {
      const initiator = assertValidNearAccountId(params.initiatorAccountId, "initiatorAccountId");
      const allowedCustomer = params.authorizedCustomerAccountId
        ? assertValidNearAccountId(params.authorizedCustomerAccountId, "authorizedCustomerAccountId")
        : null;
      if (initiator !== expectedOperator && initiator !== allowedCustomer) {
        throw new Error(
          `ERR_UNAUTHORIZED_ANCHOR_INITIATOR: Account ${initiator} is neither the operator (${expectedOperator}) nor the job customer.`
        );
      }
    }

    if (
      auditProbe.deploymentStatus === "DEPLOYED_AND_INITIALIZED" &&
      typeof nearRpc.queryAuditAnchor === "function"
    ) {
      const existingOnChain = await nearRpc.queryAuditAnchor(
        jobIdHex,
        config.mainnetAuditContractId
      );
      if (existingOnChain.ok && existingOnChain.data != null) {
        rec.anchorStatus = "ANCHORED";
        rec.auditError = null;
        rec.updatedAt = new Date().toISOString();
        throw new Error(
          `ERR_ALREADY_FINALIZED_ON_CHAIN: Job ${jobIdHex} already has a finalized anchor on ${config.mainnetAuditContractId}.`
        );
      }
    }

    const eventRootHex = params.eventRoot
      ? normalizeHex32Lowercase(params.eventRoot, "eventRoot")
      : sha256Hex32(`snapfall-audit/event-root/v1|${jobIdHex}|${deliveryHashHex}`);
    if (/^0x0{64}$/.test(eventRootHex)) {
      throw new Error("ERR_ZERO_HASH: event_root must be non-zero.");
    }
    const paymentReceiptRootHex = params.paymentReceiptRoot
      ? normalizeHex32Lowercase(params.paymentReceiptRoot, "paymentReceiptRoot")
      : sha256Hex32(`snapfall-audit/payment-receipt-root/v1|${jobIdHex}|${deliveryHashHex}`);
    const completedAtSec =
      typeof params.completedAtSec === "number" && Number.isInteger(params.completedAtSec) && params.completedAtSec > 0
        ? params.completedAtSec
        : Math.floor(Date.now() / 1000);

    const anchorArgs = {
      job_id: jobIdHex,
      event_root: eventRootHex,
      payment_receipt_root: paymentReceiptRootHex,
      delivery_hash: deliveryHashHex,
      completed_at: completedAtSec,
    };

    const now = new Date().toISOString();
    rec.anchorStatus = "PREPARED";
    rec.auditContractId = config.mainnetAuditContractId;
    rec.auditSignerAccountId = payer;
    rec.auditError = null;
    rec.eventRoot = eventRootHex;
    rec.paymentReceiptRoot = paymentReceiptRootHex;
    rec.completedAtSec = completedAtSec;
    rec.anchorPreparedAt = now;
    rec.updatedAt = now;
    this.persist();

    return {
      auditContractId: config.mainnetAuditContractId,
      auditContractDeployed: auditProbe.deploymentStatus === "DEPLOYED_AND_INITIALIZED",
      operatorAuthority: expectedOperator,
      coreContractId: auditState?.coreContract || config.mainnetCoreContractId,
      coreVerifyInterface: {
        method: "verify_job_for_audit",
        expectedStatus: "Accepted",
        expectedDeliveryHash: deliveryHashHex,
      },
      anchorArgs,
      transaction: {
        stepNumber: 1,
        description: `Anchor verified delivery hash on ${config.mainnetAuditContractId}::anchor_job (0.006 NEAR deposit, 0.003 NEAR retained)`,
        signerId: payer,
        receiverId: config.mainnetAuditContractId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "anchor_job",
            args: anchorArgs,
            gas: "60000000000000", // 60 TGas (MIN_PREPAID_GAS_AUDIT)
            depositYocto: ANCHOR_STORAGE_DEPOSIT, // 0.006 NEAR
          },
        ],
      },
    };
  }

  public recordAnchorSubmission(params: {
    jobId: string;
    txHash: string;
    signerAccountId: string;
    contractId?: string;
  }): DeliverySubmissionRecord {
    const rec = this.submissions.get(params.jobId);
    if (!rec) throw new Error(`ERR_UNKNOWN_SUBMISSION: ${params.jobId}`);
    if (!isValidNearTxHash(params.txHash)) {
      throw new Error("ERR_INVALID_TX_HASH: Expected a valid base58 NEAR transaction hash.");
    }
    const txHash = params.txHash.trim();
    const signer = assertValidNearAccountId(params.signerAccountId, "signerAccountId");

    if (rec.anchorStatus === "ANCHORED") {
      if (rec.auditTxHash === txHash) return rec;
      throw new Error(
        `ERR_DUPLICATE_AUDIT_ANCHOR: Job ${params.jobId} already anchored in ${rec.auditTxHash}.`
      );
    }
    if (
      (rec.anchorStatus === "SUBMITTED" || rec.anchorStatus === "PENDING") &&
      rec.auditTxHash &&
      rec.auditTxHash !== txHash
    ) {
      throw new Error(
        `ERR_ANCHOR_IN_FLIGHT: Job ${params.jobId} already has active tx ${rec.auditTxHash}.`
      );
    }

    const now = new Date().toISOString();
    rec.anchorStatus = "SUBMITTED";
    rec.auditTxHash = txHash;
    rec.auditSignerAccountId = signer;
    if (params.contractId) rec.auditContractId = params.contractId;
    rec.auditError = null;
    rec.anchorSubmittedAt = now;
    rec.updatedAt = now;
    this.persist();
    return rec;
  }

  public async reconcileAuditAnchorTx(
    nearRpc: NearMainnetRpcAdapter,
    config: SnowMoonConfig,
    params: {
      jobId: string;
      txHash?: string;
      signerAccountId?: string;
    }
  ): Promise<{
    submission: DeliverySubmissionRecord;
    finalExecutionStatus: string | null;
    onChainAnchor: unknown;
  }> {
    const rec = this.submissions.get(params.jobId);
    if (!rec) throw new Error(`ERR_UNKNOWN_SUBMISSION: ${params.jobId}`);
    const txHash = (params.txHash || rec.auditTxHash || "").trim();
    if (!txHash || !isValidNearTxHash(txHash)) {
      throw new Error(`ERR_MISSING_TX_HASH: No valid auditTxHash to reconcile for job ${params.jobId}.`);
    }
    const signer = assertValidNearAccountId(
      params.signerAccountId || rec.auditSignerAccountId || config.mainnetAuditOperatorAccountId,
      "signerAccountId"
    );

    if (rec.anchorStatus === "ANCHORED" && rec.auditTxHash && rec.auditTxHash !== txHash) {
      throw new Error(
        `ERR_DUPLICATE_AUDIT_ANCHOR: Job ${params.jobId} is already anchored in ${rec.auditTxHash}.`
      );
    }

    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    const [txLookup, onChainRes] = await Promise.all([
      nearRpc.queryTransactionStatus(txHash, signer),
      nearRpc.queryAuditAnchor(jobIdHex, config.mainnetAuditContractId),
    ]);

    const now = new Date().toISOString();
    if (!txLookup.ok || !txLookup.result) {
      if (onChainRes.ok && onChainRes.data != null) {
        rec.anchorStatus = "ANCHORED";
        rec.auditTxHash = txHash;
        rec.auditSignerAccountId = signer;
        rec.auditContractId = config.mainnetAuditContractId;
        rec.auditError = null;
        rec.anchoredAt = rec.anchoredAt || now;
        rec.updatedAt = now;
        this.persist();
        return { submission: rec, finalExecutionStatus: "FINAL_ON_CHAIN", onChainAnchor: onChainRes.data };
      }
      rec.anchorStatus = "PENDING";
      rec.auditTxHash = txHash;
      rec.auditSignerAccountId = signer;
      rec.auditError =
        typeof txLookup.error === "string"
          ? txLookup.error
          : txLookup.error
          ? JSON.stringify(txLookup.error)
          : "Transaction not yet indexed on RPC";
      rec.updatedAt = now;
      this.persist();
      return { submission: rec, finalExecutionStatus: null, onChainAnchor: null };
    }

    const txResult = txLookup.result;
    const actualSigner = txResult.transaction?.signer_id;
    const actualReceiver = txResult.transaction?.receiver_id;
    if (actualSigner && actualSigner !== signer) {
      throw new Error(
        `ERR_TX_SIGNER_MISMATCH: Expected signer ${signer}, got ${actualSigner}.`
      );
    }
    if (actualReceiver && actualReceiver !== config.mainnetAuditContractId) {
      throw new Error(
        `ERR_TX_RECEIVER_MISMATCH: Expected receiver ${config.mainnetAuditContractId}, got ${actualReceiver}.`
      );
    }
    const txActions = txResult.transaction?.actions;
    if (Array.isArray(txActions) && txActions.length > 0) {
      const hasAnchorCall = txActions.some((act) => {
        const fc = (act as { FunctionCall?: { method_name?: string } }).FunctionCall;
        return fc?.method_name === "anchor_job";
      });
      if (!hasAnchorCall) {
        throw new Error("ERR_TX_METHOD_MISMATCH: Transaction does not invoke anchor_job.");
      }
    }

    const statusObj = txResult.status || {};
    const hasFailure = "Failure" in statusObj;
    const isFinal = txResult.final_execution_status === "FINAL";
    const receipts = Array.isArray(txResult.receipts_outcome) ? txResult.receipts_outcome : [];
    const failedReceipt = receipts.find((r) => r.outcome?.status && "Failure" in r.outcome.status);
    let anchorFailedReason: string | null = null;
    for (const r of receipts) {
      for (const log of r.outcome?.logs || []) {
        if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
          try {
            const parsed = JSON.parse(log.slice("EVENT_JSON:".length)) as {
              event?: string;
              data?: Array<{ reason?: string }>;
            };
            if (parsed.event === "AnchorVerificationFailed") {
              anchorFailedReason = parsed.data?.[0]?.reason || "ANCHOR_VERIFICATION_FAILED";
            }
          } catch {
            // ignore non-JSON event logs
          }
        }
      }
    }
    const callbackReturnedFalse = statusObj.SuccessValue === "ZmFsc2U=";

    if (hasFailure || failedReceipt || anchorFailedReason || callbackReturnedFalse) {
      rec.anchorStatus = "FAILED";
      rec.auditTxHash = txHash;
      rec.auditSignerAccountId = signer;
      rec.auditError = anchorFailedReason
        ? `AuditAnchor verification failed: ${anchorFailedReason}`
        : failedReceipt
        ? `Receipt failed on-chain: ${JSON.stringify(failedReceipt.outcome?.status)}`
        : hasFailure
        ? `Transaction failed on-chain: ${JSON.stringify(statusObj.Failure)}`
        : "AuditAnchor callback returned false";
      rec.updatedAt = now;
      this.persist();
      return {
        submission: rec,
        finalExecutionStatus: txResult.final_execution_status ?? null,
        onChainAnchor: onChainRes.ok ? onChainRes.data : null,
      };
    }

    const anchorAlreadyOnChain = Boolean(onChainRes.ok && onChainRes.data != null);
    const callbackReturnedTrue = statusObj.SuccessValue === "dHJ1ZQ==";
    if (anchorAlreadyOnChain || callbackReturnedTrue || (isFinal && "SuccessValue" in statusObj)) {
      rec.anchorStatus = "ANCHORED";
      rec.auditTxHash = txHash;
      rec.auditSignerAccountId = signer;
      rec.auditContractId = config.mainnetAuditContractId;
      rec.auditError = null;
      rec.anchoredAt = rec.anchoredAt || now;
      rec.updatedAt = now;
      this.persist();
      return {
        submission: rec,
        finalExecutionStatus: txResult.final_execution_status ?? "FINAL",
        onChainAnchor: onChainRes.ok ? onChainRes.data : null,
      };
    }

    rec.anchorStatus = "PENDING";
    rec.auditTxHash = txHash;
    rec.auditSignerAccountId = signer;
    rec.updatedAt = now;
    this.persist();
    return {
      submission: rec,
      finalExecutionStatus: txResult.final_execution_status ?? null,
      onChainAnchor: onChainRes.ok ? onChainRes.data : null,
    };
  }

  public async recoverInterruptedAnchors(
    nearRpc: NearMainnetRpcAdapter,
    config: SnowMoonConfig
  ): Promise<{
    checked: number;
    anchored: number;
    pending: number;
    failed: number;
    preparedOnly: number;
  }> {
    let checked = 0;
    let anchored = 0;
    let pending = 0;
    let failed = 0;
    let preparedOnly = 0;

    for (const rec of this.submissions.values()) {
      if (
        rec.anchorStatus !== "PREPARED" &&
        rec.anchorStatus !== "SUBMITTED" &&
        rec.anchorStatus !== "PENDING"
      ) {
        continue;
      }
      checked += 1;
      if (rec.auditTxHash && isValidNearTxHash(rec.auditTxHash)) {
        const res = await this.reconcileAuditAnchorTx(nearRpc, config, {
          jobId: rec.jobId,
          txHash: rec.auditTxHash,
          signerAccountId: rec.auditSignerAccountId || config.mainnetAuditOperatorAccountId,
        });
        if (res.submission.anchorStatus === "ANCHORED") anchored += 1;
        else if (res.submission.anchorStatus === "FAILED") failed += 1;
        else pending += 1;
      } else {
        const jobIdHex = normalizeHex32Lowercase(rec.jobId, "jobId");
        const onChain = await nearRpc.queryAuditAnchor(jobIdHex, config.mainnetAuditContractId);
        if (onChain.ok && onChain.data != null) {
          rec.anchorStatus = "ANCHORED";
          rec.auditContractId = config.mainnetAuditContractId;
          rec.anchoredAt = rec.anchoredAt || new Date().toISOString();
          rec.updatedAt = new Date().toISOString();
          anchored += 1;
        } else {
          preparedOnly += 1;
        }
      }
    }

    if (anchored > 0) {
      this.persist();
    }
    return { checked, anchored, pending, failed, preparedOnly };
  }

  public markAuditAnchored(jobId: string, txHash: string): DeliverySubmissionRecord {
    const rec = this.submissions.get(jobId);
    if (!rec) throw new Error(`ERR_UNKNOWN_SUBMISSION: ${jobId}`);
    if (rec.auditTxHash && rec.auditTxHash !== txHash && rec.anchorStatus === "ANCHORED") {
      throw new Error(`ERR_DUPLICATE_AUDIT_ANCHOR: Job ${jobId} already anchored in ${rec.auditTxHash}.`);
    }
    const now = new Date().toISOString();
    rec.auditTxHash = txHash.trim();
    rec.anchorStatus = "ANCHORED";
    rec.auditError = null;
    rec.anchoredAt = rec.anchoredAt || now;
    rec.updatedAt = now;
    this.persist();
    return rec;
  }
}

