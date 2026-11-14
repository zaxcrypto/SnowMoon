import crypto from "node:crypto";
import type { SnowMoonConfig } from "./config.ts";

// ============================================================================
// PROTOCOL CONSTANTS (Exact parity with snapfall-core & snapfall-audit)
// ============================================================================
export const JOB_ID_DOMAIN = "snowmoon-core/job-id/v1";
export const VIRTUAL_OFFSET = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const MIN_INITIAL_LP_DEPOSIT = 1_000_000n; // 1.00 USDC
export const JOB_STORAGE_DEPOSIT_INITIAL = "23000000000000000000000"; // 0.023 NEAR
export const STORAGE_REGISTRATION = "7000000000000000000000"; // 0.007 NEAR
export const LP_SHARE_STAKE = "20000000000000000000000"; // 0.020 NEAR
export const ANCHOR_STORAGE_DEPOSIT = "6000000000000000000000"; // 0.006 NEAR
export const ANCHOR_FINAL_STAKE = "3000000000000000000000"; // 0.003 NEAR

export type JobState =
  | "Created"
  | "Funded"
  | "InProgress"
  | "Delivered"
  | "Accepted"
  | "Refunded"
  | "Cancelled";

export interface ExpenseReceipt {
  id: string;
  jobId: string;
  amountUsdc: string;
  vendor: string;
  description: string;
  category: string;
  receiptHash: string;
  policyVerdict: "AUTO_APPROVED" | "HUMAN_APPROVED" | "DENIED_FALLBACK";
  approvalId?: string;
  adapterLabel: string;
  recordedAt: string;
}

export interface AITokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AIExecutionRecord {
  jobId: string;
  workerId: string;
  adapterMode: "near_ai" | "mock";
  adapterLabel: string;
  model: string;
  endpoint?: string;
  requestId?: string;
  tokenUsage?: AITokenUsage;
  fallbackReason?: string;
  taskPrompt: string;
  summary: string;
  deliverableMarkdown: string;
  deliveryHash: string;
  executedAt: string;
  durationMs: number;
}

export interface SettlementBreakdown {
  jobId: string;
  customerPaymentUsdc: string;
  advancePrincipalUsdc: string;
  advanceFeeUsdc: string;
  poolRepaymentTotalUsdc: string;
  principalRepaidUsdc: string;
  feePaidUsdc: string;
  shortfallUsdc: string;
  reserveAbsorbedUsdc: string;
  operatorNetUsdc: string;
  operatingSpentUsdc: string;
  settledAt: string;
}

export interface JobRecord {
  jobId: string;
  seq: number;
  title: string;
  taskDescription: string;
  customer: string;
  operator: string;
  sponsor: string;
  customerPayment: string; // atomic USDC (6 decimals)
  maxOperatingBudget: string; // atomic USDC
  operatingSpent: string; // atomic USDC
  advanceId: number; // 0 = None
  termsHash: string; // 0x + 64 hex
  deliveryHash: string; // 0x + 64 hex
  deadlineSec: number;
  state: JobState;
  storageLockedYocto: string;
  createdAt: string;
  updatedAt: string;
  expenses: ExpenseReceipt[];
  aiExecution?: AIExecutionRecord;
  settlement?: SettlementBreakdown;
  anchored: boolean;
}

export interface AdvanceRecord {
  advanceId: number;
  jobId: string;
  operator: string;
  principal: string;
  fee: string;
  repaid: boolean;
  defaulted: boolean;
  disbursed: boolean;
  createdAt: string;
}

export interface ApprovalRequest {
  approvalId: string;
  jobId: string;
  workerId: string;
  operator: string;
  vendor: string;
  description: string;
  requestedAmountUsdc: string;
  autoApproveThresholdUsdc: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  adapterMode: "outlayer" | "mock";
  adapterLabel: string;
  receiptHash: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  postApprovalPayloadHash: string;
}

export interface AnchorRecord {
  jobId: string;
  termsHash: string;
  deliveryHash: string;
  anchoredAtSec: number;
  anchoredBy: string;
  verifiedFromCore: boolean;
  storageChargedYocto: string;
  storageRefundedYocto: string;
  txHash: string;
}

export interface Nep297Event {
  id: string;
  timestamp: string;
  contractId: string;
  standard: "snapfall-core" | "snapfall-audit";
  version: "1.0.0";
  event: string;
  data: Record<string, unknown>;
}

export function sha256Hex(input: Buffer | string): string {
  return "0x" + crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Exact contract-derived Job ID matching `snapfall-core::derive_job_id`:
 * `sha256("snowmoon-core/job-id/v1" || borsh(creator) || u64::to_le_bytes(seq))`
 */
export function deriveJobId(creator: string, seq: number): string {
  const domainBuf = Buffer.from(JOB_ID_DOMAIN, "utf8");
  const creatorBytes = Buffer.from(creator, "utf8");
  const borshLen = Buffer.alloc(4);
  borshLen.writeUInt32LE(creatorBytes.length, 0);
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(BigInt(seq), 0);

  const hash = crypto
    .createHash("sha256")
    .update(domainBuf)
    .update(borshLen)
    .update(creatorBytes)
    .update(seqBuf)
    .digest("hex");
  return "0x" + hash;
}

export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b) / denom;
}

export function mulDivCeil(a: bigint, b: bigint, denom: bigint): bigint {
  const prod = a * b;
  if (prod === 0n) return 0n;
  return (prod + denom - 1n) / denom;
}

export class SnowMoonEngine {
  public config: SnowMoonConfig;

  // Monotonic sequence counters
  public nextJobSeq = 0;
  public nextAdvanceId = 0;
  public epoch = 1;
  public paused = false;

  // FloatPool parameters & accounting
  public advanceAprBps = 200n; // 2.00% flat fee per advance
  public maxUtilizationBps = 8000n; // 80% max utilization
  public creditLineMultiplierBps = 5000n; // 50% of customer_payment
  public defaultCreditCap = 500_000_000n; // $500 USDC

  public poolIdleCash = 0n;
  public totalOutstanding = 0n;
  public totalShares = 0n;
  public lossReserve = 0n;

  // Balances & registries
  public usdcBalances = new Map<string, bigint>();
  public claimableUsdc = new Map<string, bigint>();
  public lpShares = new Map<string, bigint>();
  public storageCreditsYocto = new Map<string, { available: bigint; locked: bigint; registration: bigint }>();

  public jobs = new Map<string, JobRecord>();
  public advances = new Map<number, AdvanceRecord>();
  public approvals = new Map<string, ApprovalRequest>();
  public anchors = new Map<string, AnchorRecord>();
  public events: Nep297Event[] = [];

  constructor(config: SnowMoonConfig) {
    this.config = config;
    if (!config.isProductionMode && config.network === "sandbox" && config.chainMode === "sandbox") {
      this.seedInitialState();
    }
  }

  public seedInitialState(): void {
    this.nextJobSeq = 0;
    this.nextAdvanceId = 0;
    this.epoch = 1;
    this.paused = false;

    this.poolIdleCash = 0n;
    this.totalOutstanding = 0n;
    this.totalShares = 0n;
    this.lossReserve = 0n;

    this.usdcBalances.clear();
    this.claimableUsdc.clear();
    this.lpShares.clear();
    this.storageCreditsYocto.clear();
    this.jobs.clear();
    this.advances.clear();
    this.approvals.clear();
    this.anchors.clear();
    this.events = [];

    // Seed demo accounts with test USDC (clearly labelled sandbox balances)
    this.usdcBalances.set(this.config.customerAccountId, 2_500_000_000n); // $2,500.00 USDC
    this.usdcBalances.set(this.config.operatorAccountId, 250_000_000n);   // $250.00 USDC
    this.usdcBalances.set(this.config.lpAccountId, 10_000_000_000n);      // $10,000.00 USDC
    this.usdcBalances.set(this.config.adminAccountId, 1_000_000_000n);    // $1,000.00 USDC

    // Pre-register storage credits for customer & operator (0.007 NEAR registration + 0.100 NEAR available)
    this.storageCreditsYocto.set(this.config.customerAccountId, {
      available: 100_000_000_000_000_000_000_000n,
      locked: 0n,
      registration: BigInt(STORAGE_REGISTRATION),
    });
    this.storageCreditsYocto.set(this.config.operatorAccountId, {
      available: 100_000_000_000_000_000_000_000n,
      locked: 0n,
      registration: BigInt(STORAGE_REGISTRATION),
    });

    // Seed initial LP deposit into FloatPool ($5,000.00 USDC) so Working Capital Float is ready
    this.depositPool(this.config.lpAccountId, 5_000_000_000n);
  }

  private emitEvent(
    standard: "snapfall-core" | "snapfall-audit",
    event: string,
    data: Record<string, unknown>
  ): void {
    const contractId =
      standard === "snapfall-core"
        ? this.config.coreContractId
        : this.config.auditContractId;
    this.events.unshift({
      id: `evt-${this.events.length + 1}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      contractId,
      standard,
      version: "1.0.0",
      event,
      data,
    });
  }

  // ==========================================================================
  // FLOAT POOL ACCOUNTING (Exact NEP-141 / Virtual-Offset Share Math)
  // ==========================================================================
  public totalAssets(): bigint {
    return this.poolIdleCash + this.totalOutstanding;
  }

  public convertToSharesFloor(assets: bigint): bigint {
    return mulDivFloor(
      assets,
      this.totalShares + VIRTUAL_OFFSET,
      this.totalAssets() + VIRTUAL_OFFSET
    );
  }

  public convertToSharesCeil(assets: bigint): bigint {
    return mulDivCeil(
      assets,
      this.totalShares + VIRTUAL_OFFSET,
      this.totalAssets() + VIRTUAL_OFFSET
    );
  }

  public convertToAssetsFloor(shares: bigint): bigint {
    return mulDivFloor(
      shares,
      this.totalAssets() + VIRTUAL_OFFSET,
      this.totalShares + VIRTUAL_OFFSET
    );
  }

  public depositPool(lpAccount: string, assets: bigint): { shares: bigint } {
    if (this.paused) throw new Error("ERR_PAUSED");
    if (assets <= 0n) throw new Error("ERR_ZERO_DEPOSIT");
    if (this.totalShares === 0n && assets < MIN_INITIAL_LP_DEPOSIT) {
      throw new Error("ERR_INITIAL_LP_DEPOSIT_TOO_SMALL");
    }

    const bal = this.usdcBalances.get(lpAccount) ?? 0n;
    if (bal < assets) throw new Error("ERR_INSUFFICIENT_USDC_BALANCE");

    const shares = this.convertToSharesFloor(assets);
    if (shares <= 0n) throw new Error("ERR_ZERO_SHARES");

    this.usdcBalances.set(lpAccount, bal - assets);
    this.poolIdleCash += assets;
    this.totalShares += shares;
    this.lpShares.set(lpAccount, (this.lpShares.get(lpAccount) ?? 0n) + shares);

    this.emitEvent("snapfall-core", "Deposited", {
      caller: lpAccount,
      owner: lpAccount,
      assets: assets.toString(),
      shares: shares.toString(),
      epoch: this.epoch,
      storageStakePayer: lpAccount,
      storageStakeOwner: lpAccount,
      storageStakeChargedYocto: LP_SHARE_STAKE,
    });

    return { shares };
  }

  public withdrawPool(lpAccount: string, assets: bigint): { sharesBurned: bigint } {
    if (assets <= 0n) throw new Error("ERR_ZERO_WITHDRAW");
    if (assets > this.poolIdleCash) throw new Error("ERR_INSUFFICIENT_LIQUIDITY");

    const shares = this.convertToSharesCeil(assets);
    const currentShares = this.lpShares.get(lpAccount) ?? 0n;
    if (shares > currentShares) throw new Error("ERR_INSUFFICIENT_SHARES");

    this.lpShares.set(lpAccount, currentShares - shares);
    this.totalShares -= shares;
    this.poolIdleCash -= assets;
    this.usdcBalances.set(lpAccount, (this.usdcBalances.get(lpAccount) ?? 0n) + assets);

    this.emitEvent("snapfall-core", "Withdrawn", {
      caller: lpAccount,
      receiver: lpAccount,
      owner: lpAccount,
      assets: assets.toString(),
      shares: shares.toString(),
      epoch: this.epoch,
    });

    return { sharesBurned: shares };
  }

  // ==========================================================================
  // JOB VAULT LIFECYCLE (Steps 2, 3, 5, 6, 7, 8, 9, 10, 11)
  // ==========================================================================
  public createJob(params: {
    creator: string;
    customer: string;
    operator: string;
    title: string;
    taskDescription: string;
    customerPaymentUsdc: bigint;
    maxOperatingBudgetUsdc: bigint;
    termsHash?: string;
    deadlineSec?: number;
    fundImmediately?: boolean;
  }): JobRecord {
    if (this.paused) throw new Error("ERR_PAUSED");
    const {
      creator,
      customer,
      operator,
      title,
      taskDescription,
      customerPaymentUsdc,
      maxOperatingBudgetUsdc,
    } = params;

    if (creator !== customer && creator !== operator) {
      throw new Error("ERR_NOT_AUTHORIZED: creator must be customer or operator");
    }
    if (customerPaymentUsdc <= 0n) {
      throw new Error("ERR_ZERO_PAYMENT");
    }
    if (maxOperatingBudgetUsdc > customerPaymentUsdc) {
      throw new Error("ERR_BUDGET_EXCEEDS_PAYMENT");
    }

    const seq = this.nextJobSeq;
    this.nextJobSeq += 1;
    const jobId = deriveJobId(creator, seq);

    const termsHash =
      params.termsHash && /^0x[0-9a-fA-F]{64}$/.test(params.termsHash)
        ? params.termsHash.toLowerCase()
        : sha256Hex(`${title}|${taskDescription}|${customer}|${operator}|${customerPaymentUsdc}`);

    const deadlineSec =
      params.deadlineSec ?? Math.floor(Date.now() / 1000) + 86_400;

    // Lock 0.023 NEAR storage deposit
    const credit = this.storageCreditsYocto.get(creator) ?? {
      available: 100_000_000_000_000_000_000_000n,
      locked: 0n,
      registration: BigInt(STORAGE_REGISTRATION),
    };
    const lockAmt = BigInt(JOB_STORAGE_DEPOSIT_INITIAL);
    if (credit.available >= lockAmt) {
      credit.available -= lockAmt;
    }
    credit.locked += lockAmt;
    this.storageCreditsYocto.set(creator, credit);

    const now = new Date().toISOString();
    const job: JobRecord = {
      jobId,
      seq,
      title: title || "Autonomous AI Research & Financial Verification Task",
      taskDescription:
        taskDescription ||
        "Analyze NEAR protocol liquidity metrics, execute verified data queries within operating budget, and produce a signed cryptographic audit report.",
      customer,
      operator,
      sponsor: creator,
      customerPayment: customerPaymentUsdc.toString(),
      maxOperatingBudget: maxOperatingBudgetUsdc.toString(),
      operatingSpent: "0",
      advanceId: 0,
      termsHash,
      deliveryHash: "0x" + "0".repeat(64),
      deadlineSec,
      state: "Created",
      storageLockedYocto: JOB_STORAGE_DEPOSIT_INITIAL,
      createdAt: now,
      updatedAt: now,
      expenses: [],
      anchored: false,
    };

    this.jobs.set(jobId, job);

    this.emitEvent("snapfall-core", "JobCreated", {
      jobId,
      customer,
      operator,
      sponsor: creator,
      customerPayment: customerPaymentUsdc.toString(),
      maxOperatingBudget: maxOperatingBudgetUsdc.toString(),
      termsHash,
      deadline: deadlineSec,
    });

    if (params.fundImmediately) {
      this.fundJob(jobId, customer);
    }

    return this.jobs.get(jobId)!;
  }

  public fundJob(jobId: string, caller: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (job.state !== "Created") throw new Error("ERR_INVALID_STATE");
    if (caller !== job.customer) {
      throw new Error("ERR_UNAUTHORIZED_FUNDER: only job.customer may fund escrow");
    }

    const payment = BigInt(job.customerPayment);
    const bal = this.usdcBalances.get(caller) ?? 0n;
    if (bal < payment) throw new Error("ERR_INSUFFICIENT_USDC_BALANCE");

    this.usdcBalances.set(caller, bal - payment);
    job.state = "Funded";
    job.updatedAt = new Date().toISOString();

    this.emitEvent("snapfall-core", "JobFunded", {
      jobId,
      customer: job.customer,
      amount: job.customerPayment,
    });

    return job;
  }

  public requestAdvance(jobId: string, caller: string, amountUsdc: bigint): AdvanceRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (job.state !== "Funded" && job.state !== "InProgress") {
      throw new Error("ERR_INVALID_STATE");
    }
    if (caller !== job.operator) {
      throw new Error("ERR_NOT_OPERATOR");
    }
    if (job.advanceId !== 0) {
      throw new Error("ERR_ADVANCE_ALREADY_EXISTS");
    }
    if (amountUsdc <= 0n) throw new Error("ERR_ZERO_ADVANCE");

    const maxByJob = mulDivFloor(
      BigInt(job.customerPayment),
      this.creditLineMultiplierBps,
      BPS_DENOMINATOR
    );
    const limit = maxByJob < BigInt(job.maxOperatingBudget) ? maxByJob : BigInt(job.maxOperatingBudget);
    if (amountUsdc > limit) {
      throw new Error(`ERR_ADVANCE_EXCEEDS_LIMIT: max allowed is ${limit.toString()}`);
    }
    if (amountUsdc > this.poolIdleCash) {
      throw new Error("ERR_INSUFFICIENT_POOL_LIQUIDITY");
    }

    const newOutstanding = this.totalOutstanding + amountUsdc;
    const maxAllowedOutstanding = mulDivFloor(
      this.totalAssets(),
      this.maxUtilizationBps,
      BPS_DENOMINATOR
    );
    if (newOutstanding > maxAllowedOutstanding) {
      throw new Error("ERR_MAX_UTILIZATION_EXCEEDED");
    }

    const fee = mulDivCeil(amountUsdc, this.advanceAprBps, BPS_DENOMINATOR);
    this.nextAdvanceId += 1;
    const advanceId = this.nextAdvanceId;

    this.poolIdleCash -= amountUsdc;
    this.totalOutstanding += amountUsdc;
    this.usdcBalances.set(
      job.operator,
      (this.usdcBalances.get(job.operator) ?? 0n) + amountUsdc
    );

    const adv: AdvanceRecord = {
      advanceId,
      jobId,
      operator: job.operator,
      principal: amountUsdc.toString(),
      fee: fee.toString(),
      repaid: false,
      defaulted: false,
      disbursed: true,
      createdAt: new Date().toISOString(),
    };

    this.advances.set(advanceId, adv);
    job.advanceId = advanceId;
    job.updatedAt = new Date().toISOString();

    this.emitEvent("snapfall-core", "AdvanceIssued", {
      advanceId,
      jobId,
      operator: job.operator,
      principal: amountUsdc.toString(),
      fee: fee.toString(),
    });
    this.emitEvent("snapfall-core", "AdvanceDisbursed", {
      advanceId,
      jobId,
      operator: job.operator,
      principal: amountUsdc.toString(),
    });

    return adv;
  }

  public startWork(jobId: string, caller: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (caller !== job.operator) throw new Error("ERR_NOT_OPERATOR");
    if (job.state !== "Funded") throw new Error("ERR_INVALID_STATE");

    job.state = "InProgress";
    job.updatedAt = new Date().toISOString();

    this.emitEvent("snapfall-core", "WorkStarted", {
      jobId,
      operator: job.operator,
    });

    return job;
  }

  public recordExpense(params: {
    jobId: string;
    caller: string;
    amountUsdc: bigint;
    vendor: string;
    description: string;
    category?: string;
    policyVerdict: "AUTO_APPROVED" | "HUMAN_APPROVED" | "DENIED_FALLBACK";
    approvalId?: string;
    adapterLabel: string;
  }): ExpenseReceipt {
    const job = this.jobs.get(params.jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (params.caller !== job.operator) throw new Error("ERR_NOT_OPERATOR");
    if (job.state === "Funded") {
      this.startWork(params.jobId, params.caller);
    }
    if (job.state !== "InProgress") {
      throw new Error("ERR_INVALID_STATE: job must be Funded or InProgress");
    }
    if (params.amountUsdc <= 0n) throw new Error("ERR_ZERO_EXPENSE");

    const newSpent = BigInt(job.operatingSpent) + params.amountUsdc;
    if (newSpent > BigInt(job.maxOperatingBudget)) {
      throw new Error("ERR_BUDGET_EXCEEDED: expense exceeds job max_operating_budget");
    }

    job.operatingSpent = newSpent.toString();
    job.updatedAt = new Date().toISOString();

    const receiptHash = sha256Hex(
      `${job.jobId}|${params.vendor}|${params.amountUsdc.toString()}|${params.description}|${job.expenses.length + 1}`
    );

    const receipt: ExpenseReceipt = {
      id: `exp-${job.seq}-${job.expenses.length + 1}`,
      jobId: job.jobId,
      amountUsdc: params.amountUsdc.toString(),
      vendor: params.vendor,
      description: params.description,
      category: params.category || "data_api",
      receiptHash,
      policyVerdict: params.policyVerdict,
      approvalId: params.approvalId,
      adapterLabel: params.adapterLabel,
      recordedAt: new Date().toISOString(),
    };

    job.expenses.push(receipt);

    this.emitEvent("snapfall-core", "ExpenseRecorded", {
      jobId: job.jobId,
      amount: params.amountUsdc.toString(),
      totalOperatingSpent: job.operatingSpent,
      receiptHash,
      policyVerdict: params.policyVerdict,
    });

    return receipt;
  }

  public submitDelivery(params: {
    jobId: string;
    caller: string;
    deliveryHash: string;
    aiExecution?: AIExecutionRecord;
  }): JobRecord {
    const job = this.jobs.get(params.jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (params.caller !== job.operator) throw new Error("ERR_NOT_OPERATOR");
    if (job.state === "Funded") {
      this.startWork(params.jobId, params.caller);
    }
    if (job.state !== "InProgress") {
      throw new Error("ERR_INVALID_STATE");
    }
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(params.deliveryHash) ||
      params.deliveryHash === "0x" + "0".repeat(64)
    ) {
      throw new Error("ERR_INVALID_DELIVERY_HASH");
    }

    job.deliveryHash = params.deliveryHash.toLowerCase();
    if (params.aiExecution) {
      job.aiExecution = params.aiExecution;
    }
    job.state = "Delivered";
    job.updatedAt = new Date().toISOString();

    this.emitEvent("snapfall-core", "DeliverySubmitted", {
      jobId: job.jobId,
      operator: job.operator,
      deliveryHash: job.deliveryHash,
    });

    return job;
  }

  /**
   * Step 10 & Step 11: Customer accepts delivery -> Settlement accounting executes.
   * Repays FloatPool advance principal + fee first; credits `operator_net` to operator.
   */
  public acceptDelivery(jobId: string, caller: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (caller !== job.customer) {
      throw new Error("ERR_NOT_CUSTOMER: only customer can accept delivery");
    }
    if (job.state !== "Delivered") {
      throw new Error("ERR_INVALID_STATE: job must be in Delivered state");
    }

    const payment = BigInt(job.customerPayment);
    let advancePrincipal = 0n;
    let advanceFee = 0n;
    let principalRepaid = 0n;
    let feePaid = 0n;
    let shortfall = 0n;
    let reserveAbsorbed = 0n;
    let operatorNet = payment;

    if (job.advanceId !== 0) {
      const adv = this.advances.get(job.advanceId);
      if (adv && !adv.repaid && !adv.defaulted) {
        advancePrincipal = BigInt(adv.principal);
        advanceFee = BigInt(adv.fee);
        const totalOwed = advancePrincipal + advanceFee;

        // Always decrement totalOutstanding by full principal (Phase 0.7.1 invariant)
        this.totalOutstanding -= advancePrincipal;

        if (payment >= totalOwed) {
          principalRepaid = advancePrincipal;
          feePaid = advanceFee;
          this.poolIdleCash += totalOwed;
          operatorNet = payment - totalOwed;
          adv.repaid = true;
        } else if (payment >= advancePrincipal) {
          principalRepaid = advancePrincipal;
          feePaid = payment - advancePrincipal;
          this.poolIdleCash += payment;
          operatorNet = 0n;
          adv.repaid = true;
        } else {
          principalRepaid = payment;
          this.poolIdleCash += payment;
          shortfall = advancePrincipal - payment;
          reserveAbsorbed =
            this.lossReserve >= shortfall ? shortfall : this.lossReserve;
          this.lossReserve -= reserveAbsorbed;
          operatorNet = 0n;
          adv.defaulted = true;
        }

        this.emitEvent("snapfall-core", "AdvanceRepaid", {
          advanceId: adv.advanceId,
          jobId: job.jobId,
          principalRepaid: principalRepaid.toString(),
          feePaid: feePaid.toString(),
          shortfall: shortfall.toString(),
        });
      }
    }

    // Pay operator_net in USDC (and track in settlement record)
    if (operatorNet > 0n) {
      this.usdcBalances.set(
        job.operator,
        (this.usdcBalances.get(job.operator) ?? 0n) + operatorNet
      );
    }

    // Unlock unused storage credit back to sponsor
    const sponsorCredit = this.storageCreditsYocto.get(job.sponsor);
    if (sponsorCredit) {
      const locked = BigInt(job.storageLockedYocto);
      if (sponsorCredit.locked >= locked) {
        sponsorCredit.locked -= locked;
      }
      // Keep 415B (0.00415 NEAR) for persistent settled Job record, refund remainder to available
      const settledBytesCost = 4_150_000_000_000_000_000_000n;
      const refund = locked > settledBytesCost ? locked - settledBytesCost : 0n;
      sponsorCredit.available += refund;
      sponsorCredit.locked += settledBytesCost;
    }

    const now = new Date().toISOString();
    job.state = "Accepted";
    job.updatedAt = now;
    job.settlement = {
      jobId: job.jobId,
      customerPaymentUsdc: payment.toString(),
      advancePrincipalUsdc: advancePrincipal.toString(),
      advanceFeeUsdc: advanceFee.toString(),
      poolRepaymentTotalUsdc: (principalRepaid + feePaid).toString(),
      principalRepaidUsdc: principalRepaid.toString(),
      feePaidUsdc: feePaid.toString(),
      shortfallUsdc: shortfall.toString(),
      reserveAbsorbedUsdc: reserveAbsorbed.toString(),
      operatorNetUsdc: operatorNet.toString(),
      operatingSpentUsdc: job.operatingSpent,
      settledAt: now,
    };

    this.emitEvent("snapfall-core", "DeliveryAccepted", {
      jobId: job.jobId,
      customer: job.customer,
      operator: job.operator,
      customerPayment: payment.toString(),
      poolRepayment: (principalRepaid + feePaid).toString(),
      operatorNet: operatorNet.toString(),
    });

    return job;
  }

  public cancelJob(jobId: string, caller: string): { deletedJobId: string; refundedStorageYocto: string } {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (job.state !== "Created") {
      throw new Error("ERR_INVALID_STATE: only unfunded Created jobs can be cancelled");
    }
    if (caller !== job.customer && caller !== job.operator) {
      throw new Error("ERR_UNAUTHORIZED");
    }

    // AUD-01 + Decision 2 Option A: Delete Job record and refund 100% of job.storage_locked
    const sponsorCredit = this.storageCreditsYocto.get(job.sponsor);
    if (sponsorCredit) {
      const locked = BigInt(job.storageLockedYocto);
      if (sponsorCredit.locked >= locked) {
        sponsorCredit.locked -= locked;
      }
      sponsorCredit.available += locked;
    }

    this.jobs.delete(jobId);

    this.emitEvent("snapfall-core", "JobCancelled", {
      jobId,
      cancelledBy: caller,
      storageRefundedYocto: JOB_STORAGE_DEPOSIT_INITIAL,
    });

    return {
      deletedJobId: jobId,
      refundedStorageYocto: JOB_STORAGE_DEPOSIT_INITIAL,
    };
  }

  // ==========================================================================
  // STEP 12: AUDIT ANCHOR (Cross-Contract Verification & Immutable Anchor)
  // ==========================================================================
  public anchorJob(jobId: string, caller: string): AnchorRecord {
    const existing = this.anchors.get(jobId);
    if (existing) {
      throw new Error("ERR_ALREADY_ANCHORED");
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("ERR_JOB_NOT_FOUND_ON_CORE");
    }

    // Mirrors `snapfall-core::verify_job_for_audit` -> `snapfall-audit::on_verify_job_complete`
    if (job.state !== "Delivered" && job.state !== "Accepted") {
      throw new Error(
        `ERR_JOB_NOT_DELIVERED_OR_ACCEPTED: current state is ${job.state}`
      );
    }
    if (job.deliveryHash === "0x" + "0".repeat(64)) {
      throw new Error("ERR_EMPTY_DELIVERY_HASH");
    }

    const anchoredAtSec = Math.floor(Date.now() / 1000);
    const txHash = sha256Hex(
      `anchor|${this.config.auditContractId}|${jobId}|${job.termsHash}|${job.deliveryHash}|${anchoredAtSec}`
    );

    const record: AnchorRecord = {
      jobId,
      termsHash: job.termsHash,
      deliveryHash: job.deliveryHash,
      anchoredAtSec,
      anchoredBy: caller,
      verifiedFromCore: true,
      storageChargedYocto: ANCHOR_FINAL_STAKE,
      storageRefundedYocto: (
        BigInt(ANCHOR_STORAGE_DEPOSIT) - BigInt(ANCHOR_FINAL_STAKE)
      ).toString(),
      txHash,
    };

    this.anchors.set(jobId, record);
    job.anchored = true;
    job.updatedAt = new Date().toISOString();

    this.emitEvent("snapfall-audit", "JobAnchored", {
      jobId,
      termsHash: job.termsHash,
      deliveryHash: job.deliveryHash,
      anchoredAt: anchoredAtSec,
      anchoredBy: caller,
      storageChargedYocto: ANCHOR_FINAL_STAKE,
      storageRefundedYocto: record.storageRefundedYocto,
    });

    return record;
  }
}

