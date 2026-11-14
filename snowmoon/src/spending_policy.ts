import crypto from "node:crypto";
import { assertValidNearAccountId, normalizeHex32Lowercase } from "./near_rpc.ts";

export type SpendingDecision = "AUTO_APPROVE" | "HUMAN_APPROVAL_REQUIRED" | "DENY";

export interface PaymentIntent {
  intentId: string;
  jobId: string;
  taskId: string;
  workerId: string;
  merchant: string;
  destination: string;
  amountAtomic: string;
  token: string;
  network: string;
  purpose: string;
  category: string;
  nonce: string;
  expiresAtMs: number;
  evidenceRef?: string;
}

export interface SpendingPolicyConfig {
  perTaskBudgetAtomic: string;
  perTxLimitAtomic: string;
  dailyLimitAtomic: string;
  jobTotalLimitAtomic: string;
  humanApprovalThresholdAtomic: string;
  allowedMerchants: string[];
  blockedCategories: string[];
  allowedTokens: string[];
  allowedNetworks: string[];
}

export interface PolicyEvaluationRecord {
  intentId: string;
  intentDigest: string;
  jobId: string;
  taskId: string;
  workerId: string;
  decision: SpendingDecision;
  reasons: string[];
  reservedAmountAtomic: string;
  humanApproved: boolean;
  humanApprover?: string;
  settled: boolean;
  released: boolean;
  settlementTxHash?: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export const DEFAULT_SPENDING_POLICY: SpendingPolicyConfig = {
  perTaskBudgetAtomic: "5000000", // $5.00 USDC
  perTxLimitAtomic: "2000000", // $2.00 USDC
  dailyLimitAtomic: "20000000", // $20.00 USDC
  jobTotalLimitAtomic: "10000000", // $10.00 USDC
  humanApprovalThresholdAtomic: "100000", // $0.10 USDC
  allowedMerchants: ["api.near.ai", "outlayer.near", "x402.snowmoon.near"],
  blockedCategories: ["gambling", "mixer", "unverified-bridge", "arbitrary-transfer"],
  allowedTokens: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"], // Mainnet native USDC
  allowedNetworks: ["near-mainnet"],
};

function digestPaymentIntent(intent: PaymentIntent): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        intentId: intent.intentId,
        jobId: intent.jobId,
        taskId: intent.taskId,
        workerId: intent.workerId,
        merchant: intent.merchant,
        destination: intent.destination,
        amountAtomic: intent.amountAtomic,
        token: intent.token,
        network: intent.network,
        purpose: intent.purpose,
        category: intent.category,
        nonce: intent.nonce,
      })
    )
    .digest("hex");
}

export class DeterministicSpendingPolicyEngine {
  private readonly policy: SpendingPolicyConfig;
  private readonly records = new Map<string, PolicyEvaluationRecord>();
  private readonly usedNonces = new Set<string>();
  private readonly jobReserved = new Map<string, bigint>();
  private readonly taskReserved = new Map<string, bigint>();
  private readonly dailyReserved = new Map<string, bigint>(); // YYYY-MM-DD -> atomic

  constructor(policy: Partial<SpendingPolicyConfig> = {}) {
    this.policy = {
      ...DEFAULT_SPENDING_POLICY,
      ...policy,
      allowedMerchants: policy.allowedMerchants ?? DEFAULT_SPENDING_POLICY.allowedMerchants,
      blockedCategories: policy.blockedCategories ?? DEFAULT_SPENDING_POLICY.blockedCategories,
      allowedTokens: policy.allowedTokens ?? DEFAULT_SPENDING_POLICY.allowedTokens,
      allowedNetworks: policy.allowedNetworks ?? DEFAULT_SPENDING_POLICY.allowedNetworks,
    };
  }

  public evaluateAndReserve(
    intent: PaymentIntent,
    nowMs = Date.now(),
    jobAvailableBudgetAtomic?: string
  ): PolicyEvaluationRecord {
    const reasons: string[] = [];
    const jobId = normalizeHex32Lowercase(intent.jobId, "jobId");
    const intentId = String(intent.intentId || "").trim();
    if (!intentId) throw new Error("ERR_INVALID_INTENT_ID: intentId is required.");
    if (!intent.taskId?.trim()) throw new Error("ERR_INVALID_TASK_ID: taskId is required.");
    if (!intent.workerId?.trim()) throw new Error("ERR_INVALID_WORKER_ID: workerId is required.");
    if (!intent.nonce?.trim()) throw new Error("ERR_INVALID_NONCE: nonce is required.");

    const digest = digestPaymentIntent(intent);
    const existing = this.records.get(intentId);
    if (existing) {
      if (existing.intentDigest !== digest) {
        throw new Error(
          `ERR_INTENT_MUTATION_INVALIDATES_APPROVAL: PaymentIntent ${intentId} changed after evaluation.`
        );
      }
      return existing;
    }

    // 1. Replay & expiry
    const nonceKey = `${jobId}:${intent.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      reasons.push(`ERR_NONCE_REPLAY: Nonce ${intent.nonce} already used for job ${jobId}.`);
    }
    if (!Number.isFinite(intent.expiresAtMs) || intent.expiresAtMs <= nowMs) {
      reasons.push(`ERR_INTENT_EXPIRED: Intent expired at ${intent.expiresAtMs} (now=${nowMs}).`);
    }

    // 2. Destination, merchant, token, network, category allowlists (deny by default)
    try {
      assertValidNearAccountId(intent.destination, "destination");
    } catch {
      reasons.push(`ERR_INVALID_DESTINATION: ${intent.destination} is not a valid NEAR account.`);
    }
    if (!this.policy.allowedMerchants.includes(intent.merchant)) {
      reasons.push(`ERR_MERCHANT_NOT_ALLOWED: Merchant ${intent.merchant} is not allowlisted.`);
    }
    if (this.policy.blockedCategories.includes(intent.category.toLowerCase())) {
      reasons.push(`ERR_CATEGORY_BLOCKED: Category ${intent.category} is blocked.`);
    }
    if (!this.policy.allowedTokens.includes(intent.token)) {
      reasons.push(`ERR_TOKEN_NOT_ALLOWED: Token ${intent.token} is not allowlisted.`);
    }
    if (!this.policy.allowedNetworks.includes(intent.network)) {
      reasons.push(`ERR_NETWORK_NOT_ALLOWED: Network ${intent.network} is not allowlisted.`);
    }

    // 3. Atomic amount & budget limits
    let amount = 0n;
    try {
      amount = BigInt(intent.amountAtomic);
      if (amount <= 0n) reasons.push("ERR_ZERO_AMOUNT: amountAtomic must be > 0.");
    } catch {
      reasons.push(`ERR_INVALID_AMOUNT: ${intent.amountAtomic} is not a valid integer.`);
    }

    const perTxLimit = BigInt(this.policy.perTxLimitAtomic);
    const perTaskBudget = BigInt(this.policy.perTaskBudgetAtomic);
    const jobTotalLimit = BigInt(this.policy.jobTotalLimitAtomic);
    const dailyLimit = BigInt(this.policy.dailyLimitAtomic);
    const approvalThreshold = BigInt(this.policy.humanApprovalThresholdAtomic);

    const taskKey = `${jobId}:${intent.taskId}`;
    const dayKey = new Date(nowMs).toISOString().slice(0, 10);
    const curTask = this.taskReserved.get(taskKey) ?? 0n;
    const curJob = this.jobReserved.get(jobId) ?? 0n;
    const curDay = this.dailyReserved.get(dayKey) ?? 0n;

    if (amount > perTxLimit) {
      reasons.push(`ERR_PER_TX_LIMIT_EXCEEDED: ${amount} > ${perTxLimit}.`);
    }
    if (curTask + amount > perTaskBudget) {
      reasons.push(`ERR_TASK_BUDGET_EXCEEDED: ${curTask + amount} > ${perTaskBudget}.`);
    }
    if (curJob + amount > jobTotalLimit) {
      reasons.push(`ERR_JOB_BUDGET_EXCEEDED: ${curJob + amount} > ${jobTotalLimit}.`);
    }
    if (curDay + amount > dailyLimit) {
      reasons.push(`ERR_DAILY_LIMIT_EXCEEDED: ${curDay + amount} > ${dailyLimit}.`);
    }
    if (jobAvailableBudgetAtomic !== undefined) {
      const avail = BigInt(jobAvailableBudgetAtomic);
      if (curJob + amount > avail) {
        reasons.push(`ERR_INSUFFICIENT_JOB_BUDGET: ${curJob + amount} > available ${avail}.`);
      }
    }

    let decision: SpendingDecision;
    if (reasons.length > 0) {
      decision = "DENY";
    } else if (amount > approvalThreshold) {
      decision = "HUMAN_APPROVAL_REQUIRED";
      reasons.push(
        `Amount ${amount} exceeds auto-approval threshold ${approvalThreshold}; human approval required.`
      );
    } else {
      decision = "AUTO_APPROVE";
    }

    const reservedAmount = decision === "DENY" ? 0n : amount;
    if (decision !== "DENY") {
      this.usedNonces.add(nonceKey);
      this.taskReserved.set(taskKey, curTask + reservedAmount);
      this.jobReserved.set(jobId, curJob + reservedAmount);
      this.dailyReserved.set(dayKey, curDay + reservedAmount);
    }

    const rec: PolicyEvaluationRecord = {
      intentId,
      intentDigest: digest,
      jobId,
      taskId: intent.taskId,
      workerId: intent.workerId,
      decision,
      reasons,
      reservedAmountAtomic: reservedAmount.toString(),
      humanApproved: false,
      settled: false,
      released: false,
      createdAtMs: nowMs,
      expiresAtMs: intent.expiresAtMs,
    };
    this.records.set(intentId, rec);
    return rec;
  }

  public approveByHuman(intentId: string, approverAccountId: string, nowMs = Date.now()): PolicyEvaluationRecord {
    const rec = this.records.get(intentId);
    if (!rec) throw new Error(`ERR_UNKNOWN_PAYMENT_INTENT: ${intentId}`);
    if (rec.decision === "DENY") throw new Error("ERR_CANNOT_APPROVE_DENIED_INTENT");
    if (rec.expiresAtMs <= nowMs) throw new Error("ERR_INTENT_EXPIRED");
    const approver = assertValidNearAccountId(approverAccountId, "approverAccountId");
    rec.humanApproved = true;
    rec.humanApprover = approver;
    return rec;
  }

  public assertAuthorizedForExecution(intent: PaymentIntent, nowMs = Date.now()): PolicyEvaluationRecord {
    const rec = this.records.get(intent.intentId);
    if (!rec) throw new Error(`ERR_POLICY_EVALUATION_REQUIRED: ${intent.intentId}`);
    const digest = digestPaymentIntent(intent);
    if (rec.intentDigest !== digest) {
      throw new Error(
        `ERR_INTENT_MUTATION_INVALIDATES_APPROVAL: PaymentIntent ${intent.intentId} was modified after policy evaluation.`
      );
    }
    if (rec.decision === "DENY") {
      throw new Error(`ERR_POLICY_DENIED: ${rec.reasons.join("; ")}`);
    }
    if (rec.decision === "HUMAN_APPROVAL_REQUIRED" && !rec.humanApproved) {
      throw new Error("ERR_HUMAN_APPROVAL_REQUIRED: Intent has not been approved by human operator/customer.");
    }
    if (rec.expiresAtMs <= nowMs) {
      throw new Error("ERR_INTENT_EXPIRED: Cannot execute expired PaymentIntent.");
    }
    if (rec.settled) {
      throw new Error(`ERR_DUPLICATE_PAYMENT: PaymentIntent ${intent.intentId} is already settled.`);
    }
    if (rec.released) {
      throw new Error(`ERR_RESERVATION_RELEASED: Reservation for ${intent.intentId} was released.`);
    }
    return rec;
  }

  public settleReservation(intentId: string, txHash: string): PolicyEvaluationRecord {
    const rec = this.records.get(intentId);
    if (!rec) throw new Error(`ERR_UNKNOWN_PAYMENT_INTENT: ${intentId}`);
    if (rec.settled) throw new Error(`ERR_DUPLICATE_PAYMENT: ${intentId} already settled.`);
    rec.settled = true;
    rec.settlementTxHash = txHash;
    return rec;
  }

  public releaseReservation(intentId: string): PolicyEvaluationRecord {
    const rec = this.records.get(intentId);
    if (!rec) throw new Error(`ERR_UNKNOWN_PAYMENT_INTENT: ${intentId}`);
    if (rec.settled) throw new Error("ERR_CANNOT_RELEASE_SETTLED_INTENT");
    if (!rec.released) {
      const amount = BigInt(rec.reservedAmountAtomic);
      const taskKey = `${rec.jobId}:${rec.taskId}`;
      const dayKey = new Date(rec.createdAtMs).toISOString().slice(0, 10);
      this.taskReserved.set(taskKey, (this.taskReserved.get(taskKey) ?? amount) - amount);
      this.jobReserved.set(rec.jobId, (this.jobReserved.get(rec.jobId) ?? amount) - amount);
      this.dailyReserved.set(dayKey, (this.dailyReserved.get(dayKey) ?? amount) - amount);
      rec.released = true;
    }
    return rec;
  }

  public getJobReservedAtomic(jobId: string): string {
    return (this.jobReserved.get(normalizeHex32Lowercase(jobId, "jobId")) ?? 0n).toString();
  }
}
