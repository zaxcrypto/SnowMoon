import crypto from "node:crypto";
import type { SnowMoonConfig } from "./config.ts";
import {
  assertValidNearAccountId,
  normalizeHex32Lowercase,
  parseU128DecimalString,
  type NearMainnetRpcAdapter,
  type PreparedNearTransaction,
} from "./near_rpc.ts";
import { assertValidTxHash } from "./mainnet_escrow.ts";
import type { SnowMoonRepository } from "./persistence.ts";
import type { VerificationStatus } from "./verification.ts";

export type SettlementKind = "PAYOUT_ACCEPT_DELIVERY" | "CUSTOMER_REFUND";

export type SettlementStatus =
  | "PREPARED"
  | "PENDING"
  | "CONFIRMED"
  | "FAILED_CALLBACK_RECOVERABLE"
  | "FAILED";

export interface SettlementRecord {
  settlementId: string;
  idempotencyKey?: string;
  jobId: string;
  kind: SettlementKind;
  customerAccountId: string;
  workerAccountId: string;
  coreContractId: string;
  grossAmountAtomic: string;
  platformFeeBps: number;
  platformFeeAtomic: string;
  workerPayoutAtomic: string;
  status: SettlementStatus;
  txHash: string | null;
  onChainConfirmed: boolean;
  actionableError: string | null;
  preparedTransaction: PreparedNearTransaction;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentHistoryEntry {
  settlementId: string;
  jobId: string;
  kind: SettlementKind;
  recipientAccountId: string;
  amountAtomic: string;
  platformFeeAtomic: string;
  status: SettlementStatus;
  txHash: string | null;
  onChainConfirmed: boolean;
  timestamp: string;
}

export function calculateAtomicPayoutSplit(
  grossAtomicStr: string,
  platformFeeBps: number
): {
  grossAtomic: string;
  platformFeeAtomic: string;
  workerPayoutAtomic: string;
} {
  const gross = parseU128DecimalString(grossAtomicStr, "grossAmountAtomic", false);
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 5000) {
    throw new Error(`ERR_INVALID_FEE_BPS: platformFeeBps must be integer 0..5000, got ${platformFeeBps}`);
  }
  const fee = (gross * BigInt(platformFeeBps)) / 10_000n;
  const workerNet = gross - fee;
  if (workerNet <= 0n) {
    throw new Error("ERR_ZERO_WORKER_NET: Worker payout must be > 0");
  }
  return {
    grossAtomic: gross.toString(),
    platformFeeAtomic: fee.toString(),
    workerPayoutAtomic: workerNet.toString(),
  };
}

export class SettlementEngine {
  private readonly records = new Map<string, SettlementRecord>();
  private readonly jobToSettlement = new Map<string, string>();
  private readonly txToSettlement = new Map<string, string>();
  private readonly history: PaymentHistoryEntry[] = [];
  private readonly repo?: SnowMoonRepository;

  constructor(repo?: SnowMoonRepository) {
    this.repo = repo;
    if (repo) {
      for (const rec of repo.getCollection<SettlementRecord>("settlements")) {
        this.records.set(rec.settlementId, rec);
        this.jobToSettlement.set(rec.jobId, rec.settlementId);
        if (rec.txHash) {
          this.txToSettlement.set(rec.txHash, rec.settlementId);
        }
        if (rec.status === "CONFIRMED" || rec.status === "FAILED" || rec.status === "FAILED_CALLBACK_RECOVERABLE") {
          this.appendHistory(rec);
        }
      }
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("settlements", Array.from(this.records.values()));
    }
  }

  public listSettlements(): SettlementRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public getSettlementByJob(jobId: string): SettlementRecord | undefined {
    const id = this.jobToSettlement.get(jobId);
    return id ? this.records.get(id) : undefined;
  }

  public listPaymentHistory(): PaymentHistoryEntry[] {
    return [...this.history];
  }

  public prepareSettlement(
    config: SnowMoonConfig,
    params: {
      jobId: string;
      kind: SettlementKind;
      verificationStatus: VerificationStatus;
      customerAccountId: string;
      workerAccountId: string;
      grossAmountAtomic: string;
      platformFeeBps?: number;
    }
  ): SettlementRecord {
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    const worker = assertValidNearAccountId(params.workerAccountId, "workerAccountId");

    if (params.kind === "PAYOUT_ACCEPT_DELIVERY" && params.verificationStatus !== "VERIFIED") {
      throw new Error(
        `ERR_DELIVERY_NOT_VERIFIED: Cannot settle payout while verificationStatus is ${params.verificationStatus}.`
      );
    }
    if (
      params.kind === "CUSTOMER_REFUND" &&
      !["REJECTED", "DISPUTED", "EXPIRED"].includes(params.verificationStatus)
    ) {
      throw new Error(
        `ERR_REFUND_NOT_ELIGIBLE: Refund requires REJECTED, DISPUTED, or EXPIRED status (got ${params.verificationStatus}).`
      );
    }

    const existingId = this.jobToSettlement.get(jobId);
    const idempotencyKey = crypto
      .createHash("sha256")
      .update(`${jobId}|${params.kind}|${customer}|${worker}|${params.grossAmountAtomic}|${params.platformFeeBps ?? 0}`)
      .digest("hex")
      .slice(0, 24);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && (existing.status === "CONFIRMED" || existing.status === "PENDING")) {
        throw new Error(
          `ERR_DUPLICATE_PAYOUT: Job ${jobId} already has settlement ${existing.settlementId} in status ${existing.status}.`
        );
      }
      if (
        existing &&
        existing.status === "PREPARED" &&
        existing.kind === params.kind &&
        existing.idempotencyKey === idempotencyKey
      ) {
        return existing;
      }
    }

    const feeBps = params.platformFeeBps ?? 0;
    const split = calculateAtomicPayoutSplit(params.grossAmountAtomic, feeBps);
    const coreId = config.mainnetCoreContractId;
    const settlementId =
      "stl_" +
      crypto
        .createHash("sha256")
        .update(`${jobId}|${params.kind}|${Date.now()}`)
        .digest("hex")
        .slice(0, 16);

    const methodName =
      params.kind === "PAYOUT_ACCEPT_DELIVERY" ? "accept_delivery" : "refund";
    const preparedTransaction: PreparedNearTransaction = {
      stepNumber: 1,
      description:
        params.kind === "PAYOUT_ACCEPT_DELIVERY"
          ? `Customer accepts delivery on ${coreId}::accept_delivery (triggers NEP-141 payout)`
          : `Customer/Admin triggers refund on ${coreId}::refund`,
      signerId: customer,
      receiverId: coreId,
      actions: [
        {
          type: "FunctionCall",
          methodName,
          args: { job_id: jobId },
          gas: "120000000000000", // 120 TGas (>= MIN_PREPAID_GAS_PAYOUT + NEP-141 callback)
          depositYocto: "1", // 1 yoctoNEAR
        },
      ],
    };

    const now = new Date().toISOString();
    const record: SettlementRecord = {
      settlementId,
      idempotencyKey,
      jobId,
      kind: params.kind,
      customerAccountId: customer,
      workerAccountId: worker,
      coreContractId: coreId,
      grossAmountAtomic: split.grossAtomic,
      platformFeeBps: feeBps,
      platformFeeAtomic: split.platformFeeAtomic,
      workerPayoutAtomic:
        params.kind === "PAYOUT_ACCEPT_DELIVERY" ? split.workerPayoutAtomic : "0",
      status: "PREPARED",
      txHash: null,
      onChainConfirmed: false,
      actionableError: null,
      preparedTransaction,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(settlementId, record);
    this.jobToSettlement.set(jobId, settlementId);
    this.persist();
    return record;
  }

  public submitSettlementTx(params: {
    settlementId: string;
    txHash: string;
    signerAccountId: string;
  }): SettlementRecord {
    const txHash = assertValidTxHash(params.txHash);
    const signer = assertValidNearAccountId(params.signerAccountId, "signerAccountId");

    const owner = this.txToSettlement.get(txHash);
    if (owner && owner !== params.settlementId) {
      throw new Error(
        `ERR_REPLAY_DETECTED: Transaction ${txHash} is already bound to settlement ${owner}.`
      );
    }

    const record = this.records.get(params.settlementId);
    if (!record) {
      throw new Error(`ERR_SETTLEMENT_NOT_FOUND: ${params.settlementId}`);
    }
    if (record.customerAccountId !== signer) {
      throw new Error(
        `ERR_SIGNER_MISMATCH: Expected ${record.customerAccountId}, got ${signer}.`
      );
    }
    if (record.status === "CONFIRMED") {
      throw new Error(`ERR_DUPLICATE_PAYOUT: Settlement ${record.settlementId} is already CONFIRMED.`);
    }
    if (record.status === "PENDING" && record.txHash && record.txHash !== txHash) {
      throw new Error(`ERR_PENDING_TX_EXISTS: Settlement already has pending tx ${record.txHash}.`);
    }

    record.txHash = txHash;
    record.status = "PENDING";
    record.onChainConfirmed = false;
    record.actionableError = null;
    record.updatedAt = new Date().toISOString();
    this.txToSettlement.set(txHash, record.settlementId);
    this.persist();
    return record;
  }

  public async reconcileSettlementTx(
    nearRpc: NearMainnetRpcAdapter,
    params: {
      settlementId: string;
      txHash: string;
    }
  ): Promise<SettlementRecord> {
    const txHash = assertValidTxHash(params.txHash);
    const record = this.records.get(params.settlementId);
    if (!record) {
      throw new Error(`ERR_SETTLEMENT_NOT_FOUND: ${params.settlementId}`);
    }

    try {
      const rpcRes = await nearRpc.queryTransactionStatus(txHash, record.customerAccountId);
    record.txHash = txHash;
    record.updatedAt = new Date().toISOString();
    this.txToSettlement.set(txHash, record.settlementId);

    if (!rpcRes.ok || !rpcRes.result) {
      record.status = "PENDING";
      record.onChainConfirmed = false;
      record.actionableError = `Awaiting finality / RPC sync for ${txHash}: ${rpcRes.error || "unknown"}`;
      return record;
    }

    const finalExec = rpcRes.result.final_execution_status || "UNKNOWN";
    const topFailure =
      rpcRes.result.status && "Failure" in rpcRes.result.status
        ? JSON.stringify(rpcRes.result.status.Failure)
        : null;
    const receiptFailure = (rpcRes.result.receipts_outcome || []).find(
      (r) => r.outcome?.status && "Failure" in r.outcome.status
    );

    if (topFailure || receiptFailure) {
      const detail = topFailure || JSON.stringify(receiptFailure?.outcome?.status);
      // NEP-141 async callback failure leaves payout recoverable via Core retry_payout / claim
      const isCallbackFailure = !topFailure && Boolean(receiptFailure);
      record.status = isCallbackFailure ? "FAILED_CALLBACK_RECOVERABLE" : "FAILED";
      record.onChainConfirmed = false;
      record.actionableError = isCallbackFailure
        ? `NEP-141 payout callback failed (${detail}). Register recipient on USDC and invoke retry_payout/claim.`
        : `Settlement transaction failed: ${detail}`;
      this.appendHistory(record);
      return record;
    }

    if (finalExec !== "FINAL" && finalExec !== "EXECUTED") {
      record.status = "PENDING";
      record.onChainConfirmed = false;
      return record;
    }

    // Verify on-chain Core job status matches expected terminal state
    const jobRes = await nearRpc.queryCoreJob(record.jobId, record.coreContractId);
    const jobData = jobRes.data as { status?: string } | null | undefined;
    const expectedStatus =
      record.kind === "PAYOUT_ACCEPT_DELIVERY" ? "Accepted" : "Refunded";
    if (!jobRes.ok || !jobData || jobData.status !== expectedStatus) {
      record.status = "FAILED_CALLBACK_RECOVERABLE";
      record.onChainConfirmed = false;
      record.actionableError = `Transaction finalized, but Core get_job status is "${jobData?.status || "unknown"}" (expected "${expectedStatus}").`;
      return record;
    }

    record.status = "CONFIRMED";
    record.onChainConfirmed = true;
    record.actionableError = null;
    this.appendHistory(record);
    return record;
    } finally {
      this.persist();
    }
  }

  /**
   * Prepares an unsigned Core `claim_usdc` transaction for pull-claim recovery
   * when an earlier NEP-141 `ft_transfer` callback failed and credited `claimable_usdc`.
   */
  public prepareClaimUsdcTransaction(
    config: SnowMoonConfig,
    params: {
      claimantAccountId: string;
      amountAtomic?: string;
      recipientAccountId?: string;
    }
  ): PreparedNearTransaction {
    const claimant = assertValidNearAccountId(params.claimantAccountId, "claimantAccountId");
    const recipient = params.recipientAccountId
      ? assertValidNearAccountId(params.recipientAccountId, "recipientAccountId")
      : undefined;
    const amount = params.amountAtomic
      ? parseU128DecimalString(params.amountAtomic, "amountAtomic", false).toString()
      : undefined;

    return {
      stepNumber: 1,
      description: `Pull-claim fallback recovery on ${config.mainnetCoreContractId}::claim_usdc (sign with claimant wallet only after confirming claimable_of(account) > 0)`,
      signerId: claimant,
      receiverId: config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "claim_usdc",
          args: {
            amount: amount ?? null,
            recipient: recipient ?? null,
          },
          gas: "120000000000000",
          depositYocto: "1",
        },
      ],
    };
  }

  private appendHistory(record: SettlementRecord): void {
    const recipient =
      record.kind === "PAYOUT_ACCEPT_DELIVERY"
        ? record.workerAccountId
        : record.customerAccountId;
    const amountAtomic =
      record.kind === "PAYOUT_ACCEPT_DELIVERY"
        ? record.workerPayoutAtomic
        : record.grossAmountAtomic;

    this.history.unshift({
      settlementId: record.settlementId,
      jobId: record.jobId,
      kind: record.kind,
      recipientAccountId: recipient,
      amountAtomic,
      platformFeeAtomic: record.platformFeeAtomic,
      status: record.status,
      txHash: record.txHash,
      onChainConfirmed: record.onChainConfirmed,
      timestamp: new Date().toISOString(),
    });
  }
}

