import crypto from "node:crypto";
import { type SnowMoonConfig } from "./config.ts";
import {
  assertValidNearAccountId,
  normalizeHex32Lowercase,
  type CoreAccountingRpcView,
  type NearMainnetRpcAdapter,
  type PreparedNearTransaction,
} from "./near_rpc.ts";

export const FLOAT_BPS = 10_000n;
export const FLOAT_FEE_BPS = 200n; // 2%
export const FLOAT_RESERVE_CUT_BPS = 2_000n; // 20% of advance fee
export const FLOAT_ORG_EXPOSURE_CAP_BPS = 1_000n; // 10% of total_assets
export const FLOAT_UTILIZATION_CAP_BPS = 8_000n; // 80% of total_assets

export type AdvanceDecisionStatus =
  | "ELIGIBLE"
  | "DENIED"
  | "PREPARED"
  | "PENDING"
  | "ISSUED"
  | "REPAID"
  | "WRITTEN_OFF";

export interface FloatAdvanceRecord {
  advanceId: string;
  idempotencyKey: string;
  jobId: string;
  customerAccountId: string;
  operatorAccountId: string;
  customerPaymentAtomic: string;
  rateBps: number;
  principalAtomic: string;
  feeAtomic: string;
  reserveCutAtomic: string;
  lpYieldAtomic: string;
  status: AdvanceDecisionStatus;
  reasons: string[];
  preparedTx?: PreparedNearTransaction;
  txHash?: string;
  onChainConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OnChainPoolSnapshot {
  poolPaused: boolean;
  totalAssetsAtomic: string;
  totalOutstandingAtomic: string;
  totalWrittenOffAtomic: string;
  reserveAtomic: string;
  maxAdvanceAtomic: string;
  maxTotalExposureAtomic: string;
}

export interface AdvanceEvaluationInput {
  jobId: string;
  customerAccountId: string;
  operatorAccountId: string;
  customerPaymentAtomic: string;
  onChainJobStatus: string;
  escrowConfirmed: boolean;
  pool: OnChainPoolSnapshot;
  rateBps: number;
  orgOutstandingAtomic?: string;
  hasActiveAdvanceOnChain?: boolean;
  hasActiveWriteOffForOrg?: boolean;
}

export interface AdvanceEvaluationResult {
  eligible: boolean;
  reasons: string[];
  rateBps: number;
  principalAtomic: string;
  feeAtomic: string;
  reserveCutAtomic: string;
  lpYieldAtomic: string;
  idleLiquidityAtomic: string;
}

export function mulDivCeil(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom <= 0n) throw new Error("ERR_DIV_BY_ZERO");
  if (a === 0n || b === 0n) return 0n;
  return (a * b + denom - 1n) / denom;
}

export function calculateSnowMoonAdvanceMath(
  customerPaymentAtomic: string,
  rateBps: number
): {
  principalAtomic: string;
  feeAtomic: string;
  reserveCutAtomic: string;
  lpYieldAtomic: string;
} {
  const payment = BigInt(customerPaymentAtomic);
  if (payment <= 0n) {
    throw new Error("ERR_ZERO_AMOUNT: customerPaymentAtomic must be > 0.");
  }
  const bps = BigInt(rateBps);
  const principal = (payment * bps) / FLOAT_BPS;
  const fee = (principal * FLOAT_FEE_BPS) / FLOAT_BPS;
  const reserveCut = (fee * FLOAT_RESERVE_CUT_BPS) / FLOAT_BPS;
  const lpYield = fee - reserveCut;
  return {
    principalAtomic: principal.toString(),
    feeAtomic: fee.toString(),
    reserveCutAtomic: reserveCut.toString(),
    lpYieldAtomic: lpYield.toString(),
  };
}

export function evaluateFloatAdvanceEligibility(
  input: AdvanceEvaluationInput
): AdvanceEvaluationResult {
  const reasons: string[] = [];
  const payment = BigInt(input.customerPaymentAtomic || "0");
  const totalAssets = BigInt(input.pool.totalAssetsAtomic || "0");
  const totalOutstanding = BigInt(input.pool.totalOutstandingAtomic || "0");
  const totalWrittenOff = BigInt(input.pool.totalWrittenOffAtomic || "0");
  const maxAdvance = BigInt(input.pool.maxAdvanceAtomic || "0");
  const maxTotalExposure = BigInt(input.pool.maxTotalExposureAtomic || "0");
  const orgOutstanding = BigInt(input.orgOutstandingAtomic || "0");
  const idle = totalAssets > totalOutstanding ? totalAssets - totalOutstanding : 0n;

  if (input.customerAccountId === input.operatorAccountId) {
    reasons.push("ERR_SELF_FUNDED_OPERATOR_JOB: Customer cannot be the job operator.");
  }
  if (!input.escrowConfirmed) {
    reasons.push("ERR_ESCROW_UNCONFIRMED: Customer escrow is not confirmed on-chain.");
  }
  if (input.onChainJobStatus !== "Funded") {
    reasons.push(`ERR_JOB_NOT_FUNDED: On-chain job status is ${input.onChainJobStatus} (expected Funded).`);
  }
  if (input.hasActiveAdvanceOnChain) {
    reasons.push("ERR_DUPLICATE_ADVANCE: Job already has an on-chain FloatPool advance.");
  }
  if (input.hasActiveWriteOffForOrg) {
    reasons.push("ERR_ORG_ACTIVE_WRITEOFF: Operator organization has a prohibited write-off state.");
  }
  if (input.pool.poolPaused) {
    reasons.push("ERR_POOL_PAUSED: FloatPool is paused.");
  }
  if (maxTotalExposure <= 0n || maxAdvance <= 0n) {
    reasons.push("ERR_CAP_NOT_SET: FloatPool max_total_exposure or max_advance is zero.");
  }
  if (payment <= 0n) {
    reasons.push("ERR_ZERO_AMOUNT: customerPaymentAtomic must be > 0.");
  }

  const math = payment > 0n
    ? calculateSnowMoonAdvanceMath(payment.toString(), input.rateBps)
    : { principalAtomic: "0", feeAtomic: "0", reserveCutAtomic: "0", lpYieldAtomic: "0" };
  const principal = BigInt(math.principalAtomic);

  if (principal <= 0n) {
    reasons.push("ERR_ZERO_PRINCIPAL: Calculated advance principal is 0.");
  }
  if (maxAdvance > 0n && principal > maxAdvance) {
    reasons.push(`ERR_ADVANCE_TOO_LARGE: Principal ${principal} exceeds max_advance ${maxAdvance}.`);
  }
  if (principal > idle) {
    reasons.push(`ERR_INSUFFICIENT_LIQUIDITY: Principal ${principal} exceeds idle liquidity ${idle}.`);
  }
  const newTotalOutstanding = totalOutstanding + principal;
  if (maxTotalExposure > 0n && newTotalOutstanding + totalWrittenOff > maxTotalExposure) {
    reasons.push("ERR_EXPOSURE_CAP_EXCEEDED: Exceeds max_total_exposure.");
  }
  if (totalAssets <= 0n) {
    reasons.push("ERR_EMPTY_POOL: FloatPool total_assets is 0.");
  } else {
    if (mulDivCeil(newTotalOutstanding, FLOAT_BPS, totalAssets) > FLOAT_UTILIZATION_CAP_BPS) {
      reasons.push("ERR_UTILIZATION_CAP_EXCEEDED: Exceeds 80% global utilization cap.");
    }
    if (mulDivCeil(orgOutstanding + principal, FLOAT_BPS, totalAssets) > FLOAT_ORG_EXPOSURE_CAP_BPS) {
      reasons.push("ERR_ORG_CAP_EXCEEDED: Exceeds 10% organization exposure cap.");
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    rateBps: input.rateBps,
    principalAtomic: math.principalAtomic,
    feeAtomic: math.feeAtomic,
    reserveCutAtomic: math.reserveCutAtomic,
    lpYieldAtomic: math.lpYieldAtomic,
    idleLiquidityAtomic: idle.toString(),
  };
}

export class FloatPoolAdvanceOrchestrator {
  private readonly records = new Map<string, FloatAdvanceRecord>(); // jobId -> record
  private readonly inFlightJobs = new Set<string>();

  public getAdvanceByJob(jobId: string): FloatAdvanceRecord | undefined {
    return this.records.get(normalizeHex32Lowercase(jobId, "jobId"));
  }

  public listAdvances(): FloatAdvanceRecord[] {
    return Array.from(this.records.values());
  }

  public async evaluateAndPrepareFromChain(
    config: SnowMoonConfig,
    rpc: NearMainnetRpcAdapter,
    params: {
      jobId: string;
      customerAccountId: string;
      operatorAccountId: string;
      escrowConfirmed: boolean;
      orgOutstandingAtomic?: string;
      hasActiveWriteOffForOrg?: boolean;
    }
  ): Promise<FloatAdvanceRecord> {
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    const operator = assertValidNearAccountId(params.operatorAccountId, "operatorAccountId");

    if (this.inFlightJobs.has(jobId)) {
      throw new Error(`ERR_ADVANCE_IN_FLIGHT: Concurrent advance evaluation/request for ${jobId}.`);
    }
    this.inFlightJobs.add(jobId);

    try {
      const existing = this.records.get(jobId);
      if (existing && (existing.status === "ISSUED" || existing.status === "REPAID" || existing.status === "WRITTEN_OFF")) {
        return existing;
      }

      const [jobRes, acctRes, advRes, rateRes] = await Promise.all([
        rpc.queryCoreJob(jobId),
        rpc.queryCoreAccounting(),
        rpc.queryCoreAdvance(jobId),
        rpc.queryCoreAdvanceRate(operator),
      ]);

      if (!jobRes.ok || !jobRes.data) {
        throw new Error(`ERR_ONCHAIN_JOB_NOT_FOUND: ${jobRes.error || "Core get_job returned null"}`);
      }
      if (!acctRes.ok || !acctRes.data) {
        throw new Error(`ERR_ONCHAIN_POOL_UNAVAILABLE: ${acctRes.error || "Core accounting() failed"}`);
      }

      const jobData = jobRes.data as {
        customer?: string;
        operator?: string;
        customer_payment?: string;
        status?: string;
      };
      if (jobData.customer && jobData.customer !== customer) {
        throw new Error(`ERR_CUSTOMER_MISMATCH: On-chain customer ${jobData.customer} != ${customer}.`);
      }
      if (jobData.operator && jobData.operator !== operator) {
        throw new Error(`ERR_OPERATOR_MISMATCH: On-chain operator ${jobData.operator} != ${operator}.`);
      }

      // If on-chain advance already exists (e.g. after RPC timeout or restart), reconcile instead of duplicating!
      const onChainAdv = advRes.ok ? advRes.data : null;
      if (onChainAdv && onChainAdv.status && onChainAdv.status !== "None") {
        const fee = BigInt(onChainAdv.fee || "0");
        const reserveCut = (fee * FLOAT_RESERVE_CUT_BPS) / FLOAT_BPS;
        const lpYield = fee - reserveCut;
        const mappedStatus: AdvanceDecisionStatus =
          onChainAdv.status === "Issued"
            ? "ISSUED"
            : onChainAdv.status === "Repaid"
            ? "REPAID"
            : onChainAdv.status === "WrittenOff"
            ? "WRITTEN_OFF"
            : "PENDING";
        const now = new Date().toISOString();
        const reconciled: FloatAdvanceRecord = {
          advanceId: existing?.advanceId || `adv_${crypto.randomBytes(8).toString("hex")}`,
          idempotencyKey: existing?.idempotencyKey || crypto.createHash("sha256").update(`adv|${jobId}`).digest("hex").slice(0, 24),
          jobId,
          customerAccountId: customer,
          operatorAccountId: operator,
          customerPaymentAtomic: String(jobData.customer_payment || "0"),
          rateBps: Number(onChainAdv.rate_bps ?? 5000),
          principalAtomic: String(onChainAdv.principal || "0"),
          feeAtomic: fee.toString(),
          reserveCutAtomic: reserveCut.toString(),
          lpYieldAtomic: lpYield.toString(),
          status: mappedStatus,
          reasons: [],
          onChainConfirmed: mappedStatus === "ISSUED" || mappedStatus === "REPAID" || mappedStatus === "WRITTEN_OFF",
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        this.records.set(jobId, reconciled);
        return reconciled;
      }

      const acct = acctRes.data as CoreAccountingRpcView & {
        max_advance?: string;
        max_total_exposure?: string;
      };
      const pool: OnChainPoolSnapshot = {
        poolPaused: Boolean(acct.pool_paused),
        totalAssetsAtomic: String(acct.total_assets || "0"),
        totalOutstandingAtomic: String(acct.total_outstanding || "0"),
        totalWrittenOffAtomic: String(acct.total_written_off || "0"),
        reserveAtomic: String(acct.reserve || "0"),
        maxAdvanceAtomic: String(acct.max_advance || "100000000"),
        maxTotalExposureAtomic: String(acct.max_total_exposure || "800000000"),
      };
      const rateBps = rateRes.ok && typeof rateRes.data === "number" ? rateRes.data : 5000;

      const evalResult = evaluateFloatAdvanceEligibility({
        jobId,
        customerAccountId: customer,
        operatorAccountId: operator,
        customerPaymentAtomic: String(jobData.customer_payment || "0"),
        onChainJobStatus: String(jobData.status || "UNKNOWN"),
        escrowConfirmed: params.escrowConfirmed,
        pool,
        rateBps,
        orgOutstandingAtomic: params.orgOutstandingAtomic,
        hasActiveAdvanceOnChain: Boolean(onChainAdv && onChainAdv.status !== "None"),
        hasActiveWriteOffForOrg: params.hasActiveWriteOffForOrg,
      });

      const now = new Date().toISOString();
      const idempotencyKey = crypto
        .createHash("sha256")
        .update(`adv|${jobId}|${operator}|${evalResult.principalAtomic}`)
        .digest("hex")
        .slice(0, 24);

      if (!evalResult.eligible) {
        const denied: FloatAdvanceRecord = {
          advanceId: existing?.advanceId || `adv_${crypto.randomBytes(8).toString("hex")}`,
          idempotencyKey,
          jobId,
          customerAccountId: customer,
          operatorAccountId: operator,
          customerPaymentAtomic: String(jobData.customer_payment || "0"),
          rateBps: evalResult.rateBps,
          principalAtomic: evalResult.principalAtomic,
          feeAtomic: evalResult.feeAtomic,
          reserveCutAtomic: evalResult.reserveCutAtomic,
          lpYieldAtomic: evalResult.lpYieldAtomic,
          status: "DENIED",
          reasons: evalResult.reasons,
          onChainConfirmed: false,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        this.records.set(jobId, denied);
        return denied;
      }

      if (existing && (existing.status === "PREPARED" || existing.status === "PENDING") && existing.idempotencyKey === idempotencyKey) {
        return existing;
      }

      const preparedTx = rpc.prepareFloatPoolRequestAdvancePayload({
        operatorAccountId: operator,
        jobId,
        expectedPrincipalAtomic: evalResult.principalAtomic,
      });

      const prepared: FloatAdvanceRecord = {
        advanceId: existing?.advanceId || `adv_${crypto.randomBytes(8).toString("hex")}`,
        idempotencyKey,
        jobId,
        customerAccountId: customer,
        operatorAccountId: operator,
        customerPaymentAtomic: String(jobData.customer_payment || "0"),
        rateBps: evalResult.rateBps,
        principalAtomic: evalResult.principalAtomic,
        feeAtomic: evalResult.feeAtomic,
        reserveCutAtomic: evalResult.reserveCutAtomic,
        lpYieldAtomic: evalResult.lpYieldAtomic,
        status: "PREPARED",
        reasons: [],
        preparedTx,
        onChainConfirmed: false,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      this.records.set(jobId, prepared);
      return prepared;
    } finally {
      this.inFlightJobs.delete(jobId);
    }
  }
}
