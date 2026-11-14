import crypto from "node:crypto";
import { assertValidNearAccountId, normalizeHex32Lowercase } from "./near_rpc.ts";
import {
  DeterministicSpendingPolicyEngine,
  type PaymentIntent,
  type PolicyEvaluationRecord,
} from "./spending_policy.ts";

/**
 * Compatibility note (Task 5):
 * Standard x402 `exact` on EVM relies on EIP-3009 (`transferWithAuthorization`).
 * NEAR NEP-141 USDC does NOT support EIP-3009.
 * SnowMoon therefore uses a clearly-labeled NEAR-native extension scheme
 * (`near-nep141-escrow-v1`) executed exclusively by an isolated funding executor
 * with independent on-chain finality verification.
 */
export const NEAR_X402_SCHEME = "near-nep141-escrow-v1" as const;

export interface X402PaymentRequirement {
  x402Version: 2;
  scheme: string;
  network: string;
  resource: string;
  payTo: string;
  asset: string;
  maxAmountRequiredAtomic: string;
  maxTimeoutSeconds: number;
  description?: string;
}

export interface X402ExecutionReceipt {
  paymentId: string;
  intentId: string;
  scheme: typeof NEAR_X402_SCHEME;
  network: "near-mainnet";
  txHash: string;
  payerAccountId: string;
  payeeAccountId: string;
  tokenContractId: string;
  amountAtomic: string;
  settledOnChain: boolean;
  settledAt: string;
  resourceUrl: string;
}

export interface IsolatedFundingExecutor {
  executeNep141Transfer(params: {
    intentId: string;
    jobId: string;
    payeeAccountId: string;
    tokenContractId: string;
    amountAtomic: string;
  }): Promise<{ txHash: string }>;
  verifyNep141TransferFinality(params: {
    txHash: string;
    expectedPayee: string;
    expectedToken: string;
    expectedAmountAtomic: string;
  }): Promise<{ confirmed: boolean; reason?: string }>;
}

export class NearX402PaymentAdapter {
  private readonly policyEngine: DeterministicSpendingPolicyEngine;
  private readonly fundingExecutor: IsolatedFundingExecutor;
  private readonly receiptsByIntent = new Map<string, X402ExecutionReceipt>();
  private readonly inFlightIntents = new Set<string>();

  constructor(
    policyEngine: DeterministicSpendingPolicyEngine,
    fundingExecutor: IsolatedFundingExecutor
  ) {
    this.policyEngine = policyEngine;
    this.fundingExecutor = fundingExecutor;
  }

  public validateRequirement(req: X402PaymentRequirement): void {
    if (req.x402Version !== 2) {
      throw new Error(`ERR_X402_UNSUPPORTED_VERSION: Expected v2, got ${req.x402Version}.`);
    }
    if (req.scheme !== NEAR_X402_SCHEME && req.scheme !== "exact") {
      throw new Error(`ERR_X402_UNSUPPORTED_SCHEME: Unsupported scheme ${req.scheme}.`);
    }
    if (req.scheme === "exact" && req.network.startsWith("eip155:")) {
      throw new Error(
        "ERR_EVM_EIP3009_NOT_SUPPORTED_ON_NEAR: EVM EIP-3009 exact scheme cannot be executed on NEAR NEP-141."
      );
    }
    if (req.network !== "near-mainnet") {
      throw new Error(`ERR_X402_NETWORK_UNSUPPORTED: Only near-mainnet is supported (got ${req.network}).`);
    }
    assertValidNearAccountId(req.payTo, "payTo");
    const amt = BigInt(req.maxAmountRequiredAtomic);
    if (amt <= 0n) {
      throw new Error("ERR_X402_ZERO_AMOUNT: maxAmountRequiredAtomic must be > 0.");
    }
  }

  public evaluate402Requirement(params: {
    jobId: string;
    taskId: string;
    workerId: string;
    merchant: string;
    category: string;
    requirement: X402PaymentRequirement;
    jobAvailableBudgetAtomic?: string;
    nowMs?: number;
  }): { intent: PaymentIntent; evaluation: PolicyEvaluationRecord } {
    this.validateRequirement(params.requirement);
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const nowMs = params.nowMs ?? Date.now();
    const nonce = crypto.randomBytes(12).toString("hex");
    const intentId =
      "x402_" +
      crypto
        .createHash("sha256")
        .update(`${jobId}|${params.taskId}|${params.requirement.resource}|${nonce}`)
        .digest("hex")
        .slice(0, 16);

    const intent: PaymentIntent = {
      intentId,
      jobId,
      taskId: params.taskId,
      workerId: params.workerId,
      merchant: params.merchant,
      destination: params.requirement.payTo,
      amountAtomic: params.requirement.maxAmountRequiredAtomic,
      token: params.requirement.asset,
      network: "near-mainnet",
      purpose: `x402:${params.requirement.resource}`,
      category: params.category,
      nonce,
      expiresAtMs: nowMs + Math.max(10, params.requirement.maxTimeoutSeconds) * 1000,
      evidenceRef: params.requirement.resource,
    };

    const evaluation = this.policyEngine.evaluateAndReserve(
      intent,
      nowMs,
      params.jobAvailableBudgetAtomic
    );
    return { intent, evaluation };
  }

  public async payAndVerify(params: {
    intent: PaymentIntent;
    payerAccountId: string;
    resourceUrl: string;
    nowMs?: number;
  }): Promise<X402ExecutionReceipt> {
    const existing = this.receiptsByIntent.get(params.intent.intentId);
    if (existing) return existing;

    if (this.inFlightIntents.has(params.intent.intentId)) {
      throw new Error(`ERR_X402_IN_FLIGHT: Payment for ${params.intent.intentId} is already in progress.`);
    }
    this.inFlightIntents.add(params.intent.intentId);

    try {
      this.policyEngine.assertAuthorizedForExecution(params.intent, params.nowMs ?? Date.now());
      const exec = await this.fundingExecutor.executeNep141Transfer({
        intentId: params.intent.intentId,
        jobId: params.intent.jobId,
        payeeAccountId: params.intent.destination,
        tokenContractId: params.intent.token,
        amountAtomic: params.intent.amountAtomic,
      });

      const verified = await this.fundingExecutor.verifyNep141TransferFinality({
        txHash: exec.txHash,
        expectedPayee: params.intent.destination,
        expectedToken: params.intent.token,
        expectedAmountAtomic: params.intent.amountAtomic,
      });

      if (!verified.confirmed) {
        this.policyEngine.releaseReservation(params.intent.intentId);
        throw new Error(
          `ERR_X402_SETTLEMENT_UNCONFIRMED: ${verified.reason || "On-chain finality check failed."}`
        );
      }

      this.policyEngine.settleReservation(params.intent.intentId, exec.txHash);
      const receipt: X402ExecutionReceipt = {
        paymentId: `pay_${crypto.randomBytes(8).toString("hex")}`,
        intentId: params.intent.intentId,
        scheme: NEAR_X402_SCHEME,
        network: "near-mainnet",
        txHash: exec.txHash,
        payerAccountId: assertValidNearAccountId(params.payerAccountId, "payerAccountId"),
        payeeAccountId: params.intent.destination,
        tokenContractId: params.intent.token,
        amountAtomic: params.intent.amountAtomic,
        settledOnChain: true,
        settledAt: new Date().toISOString(),
        resourceUrl: params.resourceUrl,
      };
      this.receiptsByIntent.set(params.intent.intentId, receipt);
      return receipt;
    } finally {
      this.inFlightIntents.delete(params.intent.intentId);
    }
  }
}
