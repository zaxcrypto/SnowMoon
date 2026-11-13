import crypto from "node:crypto";
import type { SnowMoonConfig } from "./config.ts";
import {
  JOB_STORAGE_DEPOSIT_INITIAL,
  STORAGE_REGISTRATION,
} from "./engine.ts";
import type { SnowMoonRepository } from "./persistence.ts";
import {
  assertValidNearAccountId,
  normalizeHex32Lowercase,
  parseU128DecimalString,
  type CoreAccountingRpcView,
  type NearMainnetRpcAdapter,
  type PreparedNearTransaction,
} from "./near_rpc.ts";

export type SupportedWalletType =
  | "meteor"
  | "mynearwallet"
  | "injected-selector"
  | "mock-wallet";

export interface VerifiedWalletSession {
  connected: boolean;
  walletType: SupportedWalletType;
  accountId: string;
  networkId: "mainnet";
  verifiedAt: string;
}

export interface CustomerMainnetState {
  accountId: string;
  networkId: "mainnet";
  nearBalanceYocto: string;
  nearBalanceFormatted: string;
  usdcBalanceAtomic: string;
  usdcBalanceFormatted: string;
  usdcStorageRegistered: boolean;
  usdcStorageBalance: { total: string; available: string } | null;
  coreStorageCreditYocto: string;
  coreStorageRegisteredYocto: string;
  coreJobStorageDepositYocto: string;
  needsUsdcRegistration: boolean;
  needsCoreStorageDeposit: boolean;
  coreStorageShortfallYocto: string;
  vaultPaused: boolean;
  poolPaused: boolean;
  maxJobPaymentAtomic: string;
}

export interface PreparedRegistrationPlan {
  customerAccountId: string;
  coreContractId: string;
  usdcContractId: string;
  needsUsdcRegistration: boolean;
  needsCoreStorageDeposit: boolean;
  alreadySatisfied: boolean;
  usdcDepositYocto: string;
  coreDepositYocto: string;
  totalDepositYocto: string;
  transactions: PreparedNearTransaction[];
}

export type EscrowConfirmationStatus =
  | "PREPARED"
  | "PENDING"
  | "UNKNOWN_NEEDS_RECONCILIATION"
  | "FINAL_CONFIRMED"
  | "FAILED";

export interface MainnetEscrowJobRecord {
  intentId: string;
  jobId: string | null;
  customerAccountId: string;
  operatorAccountId: string;
  coreContractId: string;
  usdcContractId: string;
  amountAtomic: string;
  maxOperatingBudgetAtomic: string;
  termsHash: string;
  deadlineSec: number;
  escrowState: EscrowConfirmationStatus;
  sourceTxHash: string | null;
  onChainConfirmed: boolean;
  finalExecutionStatus: string | null;
  deliveryAndSettlementStatus: string;
  actionableError: string | null;
  createdAt: string;
  updatedAt: string;
  preparedTransactions: PreparedNearTransaction[];
}

const SUPPORTED_WALLETS = new Set<SupportedWalletType>([
  "meteor",
  "mynearwallet",
  "injected-selector",
  "mock-wallet",
]);

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export function assertValidTxHash(rawHash: string): string {
  const hash = rawHash.trim();
  if (!TX_HASH_RE.test(hash)) {
    throw new Error(
      `ERR_INVALID_TX_HASH: Expected base58 NEAR transaction hash (32-64 chars), got "${rawHash}"`
    );
  }
  return hash;
}

export class WalletSessionManager {
  private readonly secret: Buffer;
  private readonly ttlMs: number;

  constructor(secretSeed?: string, ttlMs = 2 * 60 * 60 * 1000) {
    this.secret = secretSeed
      ? crypto.createHash("sha256").update(secretSeed).digest()
      : crypto.randomBytes(32);
    this.ttlMs = ttlMs;
  }

  public issueToken(session: VerifiedWalletSession): string {
    const payload = {
      accountId: session.accountId,
      networkId: session.networkId,
      walletType: session.walletType,
      exp: Date.now() + this.ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = crypto
      .createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${sig}`;
  }

  public verifyToken(token: string): {
    accountId: string;
    networkId: "mainnet";
    walletType: SupportedWalletType;
    exp: number;
  } {
    const parts = token.trim().split(".");
    if (parts.length !== 2) {
      throw new Error("ERR_WALLET_SESSION_INVALID: Malformed wallet session token.");
    }
    const [encoded, sig] = parts;
    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("ERR_WALLET_SESSION_INVALID: Invalid wallet session signature.");
    }
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      accountId: string;
      networkId: "mainnet";
      walletType: SupportedWalletType;
      exp: number;
    };
    if (!parsed.exp || Date.now() > parsed.exp) {
      throw new Error("ERR_WALLET_SESSION_EXPIRED: Wallet session expired. Reconnect your wallet.");
    }
    if (parsed.networkId !== "mainnet") {
      throw new Error("ERR_WRONG_NETWORK: Session is not bound to NEAR mainnet.");
    }
    return parsed;
  }

  public assertAuthorizedCustomer(token: string | undefined, expectedAccountId: string): void {
    if (!token || !token.trim()) {
      throw new Error(
        "ERR_WALLET_AUTH_REQUIRED: Missing x-wallet-session token. Connect and verify your Mainnet wallet first."
      );
    }
    const session = this.verifyToken(token);
    if (session.accountId !== expectedAccountId) {
      throw new Error(
        `ERR_ACCOUNT_IMPERSONATION_BLOCKED: Authenticated wallet ${session.accountId} cannot act for ${expectedAccountId}.`
      );
    }
  }
}

export function verifyMainnetWalletSession(params: {
  accountId: string;
  networkId: string;
  walletType: string;
  privateKey?: unknown;
}): VerifiedWalletSession {
  if (params.privateKey !== undefined && params.privateKey !== null && params.privateKey !== "") {
    throw new Error(
      "ERR_PRIVATE_KEY_FORBIDDEN: Customer private keys must never be sent to or stored by SnowMoon."
    );
  }
  if (params.networkId !== "mainnet") {
    throw new Error(
      `ERR_WRONG_NETWORK: Expected NEAR "mainnet", got "${params.networkId}". Switch your wallet to Mainnet.`
    );
  }
  const walletType = params.walletType as SupportedWalletType;
  if (!SUPPORTED_WALLETS.has(walletType)) {
    throw new Error(
      `ERR_UNSUPPORTED_WALLET: "${params.walletType}" is not supported. Use Meteor Wallet, MyNearWallet, or a NEAR Wallet Selector provider.`
    );
  }
  const accountId = assertValidNearAccountId(params.accountId, "accountId");
  return {
    connected: true,
    walletType,
    accountId,
    networkId: "mainnet",
    verifiedAt: new Date().toISOString(),
  };
}

export async function getCustomerMainnetState(
  nearRpc: NearMainnetRpcAdapter,
  config: SnowMoonConfig,
  rawAccountId: string
): Promise<CustomerMainnetState> {
  const accountId = assertValidNearAccountId(rawAccountId, "accountId");
  const coreId = config.mainnetCoreContractId;

  const [acctState, coreStorage, coreProbe, maxJobRes] = await Promise.all([
    nearRpc.inspectMainnetAccount(accountId),
    nearRpc.queryCoreStorageCredit(accountId, coreId),
    nearRpc.probeCoreContract(coreId),
    nearRpc.callViewMethod<string>(coreId, "max_job_payment", {}),
  ]);

  const coreCredit = BigInt(
    coreStorage.balance.ok && coreStorage.balance.data ? coreStorage.balance.data : "0"
  );
  const coreReg = BigInt(
    coreStorage.registration.ok && coreStorage.registration.data
      ? coreStorage.registration.data
      : "0"
  );
  const jobStorageDeposit = BigInt(
    coreProbe.jobStorageDepositYocto || JOB_STORAGE_DEPOSIT_INITIAL
  );

  const needsUsdcRegistration = !acctState.usdcStorageRegistered;
  const needsCoreStorageDeposit = coreCredit < jobStorageDeposit;

  let coreShortfall = 0n;
  if (needsCoreStorageDeposit) {
    const missingCredit = jobStorageDeposit - coreCredit;
    const missingReg = coreReg === 0n ? BigInt(STORAGE_REGISTRATION) : 0n;
    coreShortfall = missingCredit + missingReg;
  }

  const accounting = coreProbe.viewQueryResult as CoreAccountingRpcView | undefined;
  const vaultPaused = accounting ? Boolean(accounting.vault_paused) : true;
  const poolPaused = accounting ? Boolean(accounting.pool_paused) : true;
  const maxJobPaymentAtomic =
    maxJobRes.ok && maxJobRes.data ? String(maxJobRes.data) : "10000000";

  return {
    accountId,
    networkId: "mainnet",
    nearBalanceYocto: acctState.amountYocto,
    nearBalanceFormatted: acctState.amountNear,
    usdcBalanceAtomic: acctState.usdcBalanceAtomic,
    usdcBalanceFormatted: acctState.usdcBalanceFormatted,
    usdcStorageRegistered: acctState.usdcStorageRegistered,
    usdcStorageBalance: acctState.usdcStorageBalance,
    coreStorageCreditYocto: coreCredit.toString(),
    coreStorageRegisteredYocto: coreReg.toString(),
    coreJobStorageDepositYocto: jobStorageDeposit.toString(),
    needsUsdcRegistration,
    needsCoreStorageDeposit,
    coreStorageShortfallYocto: coreShortfall.toString(),
    vaultPaused,
    poolPaused,
    maxJobPaymentAtomic,
  };
}

export async function prepareCustomerStorageRegistration(
  nearRpc: NearMainnetRpcAdapter,
  config: SnowMoonConfig,
  rawCustomerAccountId: string
): Promise<PreparedRegistrationPlan> {
  const state = await getCustomerMainnetState(nearRpc, config, rawCustomerAccountId);
  const coreId = config.mainnetCoreContractId;
  const usdcId = config.mainnetUsdcContractId;

  const transactions: PreparedNearTransaction[] = [];
  let usdcDepositYocto = 0n;
  let coreDepositYocto = 0n;

  if (state.needsUsdcRegistration) {
    usdcDepositYocto = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
    transactions.push({
      stepNumber: transactions.length + 1,
      description: `Register ${state.accountId} on native USDC (${usdcId.slice(0, 12)}…) with 0.00125 NEAR (registration_only: true)`,
      signerId: state.accountId,
      receiverId: usdcId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "storage_deposit",
          args: { account_id: state.accountId, registration_only: true },
          gas: "30000000000000",
          depositYocto: usdcDepositYocto.toString(),
        },
      ],
    });
  }

  if (state.needsCoreStorageDeposit) {
    coreDepositYocto = BigInt(state.coreStorageShortfallYocto);
    transactions.push({
      stepNumber: transactions.length + 1,
      description: `Deposit required Core storage (${coreDepositYocto.toString()} yoctoNEAR) on ${coreId} for ${state.accountId}`,
      signerId: state.accountId,
      receiverId: coreId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "storage_deposit",
          args: { account_id: state.accountId },
          gas: "30000000000000",
          depositYocto: coreDepositYocto.toString(),
        },
      ],
    });
  }

  return {
    customerAccountId: state.accountId,
    coreContractId: coreId,
    usdcContractId: usdcId,
    needsUsdcRegistration: state.needsUsdcRegistration,
    needsCoreStorageDeposit: state.needsCoreStorageDeposit,
    alreadySatisfied: transactions.length === 0,
    usdcDepositYocto: usdcDepositYocto.toString(),
    coreDepositYocto: coreDepositYocto.toString(),
    totalDepositYocto: (usdcDepositYocto + coreDepositYocto).toString(),
    transactions,
  };
}

export class MainnetEscrowTracker {
  private readonly records = new Map<string, MainnetEscrowJobRecord>();
  private readonly txToIntent = new Map<string, string>();
  private readonly repo?: SnowMoonRepository;

  constructor(repo?: SnowMoonRepository) {
    this.repo = repo;
    if (repo) {
      for (const rec of repo.getCollection<MainnetEscrowJobRecord>("escrowJobs")) {
        this.records.set(rec.intentId, rec);
        if (rec.sourceTxHash) {
          this.txToIntent.set(rec.sourceTxHash, rec.intentId);
        }
      }
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("escrowJobs", Array.from(this.records.values()));
    }
  }

  public listRecords(): MainnetEscrowJobRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  public getRecord(intentId: string): MainnetEscrowJobRecord | undefined {
    return this.records.get(intentId);
  }

  public async prepareFundJob(
    nearRpc: NearMainnetRpcAdapter,
    config: SnowMoonConfig,
    params: {
      customerAccountId: string;
      operatorAccountId?: string;
      customerPaymentUsdcAtomic: string;
      maxOperatingBudgetUsdcAtomic: string;
      termsHash: string;
      deadlineSec: number;
      clientNonce?: string;
    }
  ): Promise<{
    canBroadcastNow: boolean;
    blockedReason: string | null;
    customerState: CustomerMainnetState;
    record: MainnetEscrowJobRecord;
  }> {
    const customer = assertValidNearAccountId(
      params.customerAccountId,
      "customerAccountId"
    );
    const operator = assertValidNearAccountId(
      params.operatorAccountId || config.mainnetOperatorAccountId,
      "operatorAccountId"
    );
    const paymentAtomic = parseU128DecimalString(
      params.customerPaymentUsdcAtomic,
      "customerPaymentUsdcAtomic",
      false
    );
    const budgetAtomic = parseU128DecimalString(
      params.maxOperatingBudgetUsdcAtomic,
      "maxOperatingBudgetUsdcAtomic",
      true
    );
    const termsHash = normalizeHex32Lowercase(params.termsHash, "termsHash");
    if (!Number.isSafeInteger(params.deadlineSec) || params.deadlineSec <= 0) {
      throw new Error("ERR_INVALID_DEADLINE: deadlineSec must be a positive integer");
    }

    const customerState = await getCustomerMainnetState(nearRpc, config, customer);
    const maxAllowed = BigInt(customerState.maxJobPaymentAtomic);
    if (paymentAtomic > maxAllowed) {
      throw new Error(
        `ERR_EXCEEDS_MAX_JOB_PAYMENT: Requested ${paymentAtomic.toString()} atomic USDC exceeds Core max_job_payment (${maxAllowed.toString()}).`
      );
    }
    if (BigInt(customerState.usdcBalanceAtomic) < paymentAtomic) {
      throw new Error(
        `ERR_INSUFFICIENT_USDC_BALANCE: Account ${customer} holds ${customerState.usdcBalanceAtomic} atomic USDC, which is less than required ${paymentAtomic.toString()}.`
      );
    }
    const usdcRegNeed = customerState.needsUsdcRegistration
      ? 1_250_000_000_000_000_000_000n
      : 0n;
    const coreStorageNeed = customerState.needsCoreStorageDeposit
      ? BigInt(customerState.coreStorageShortfallYocto)
      : 0n;
    const gasBufferYocto = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
    const totalNearNeeded = usdcRegNeed + coreStorageNeed + gasBufferYocto;
    if (BigInt(customerState.nearBalanceYocto) < totalNearNeeded) {
      throw new Error(
        `ERR_INSUFFICIENT_NEAR_BALANCE: Account ${customer} holds ${customerState.nearBalanceYocto} yoctoNEAR, less than required ${totalNearNeeded.toString()} yoctoNEAR (storage + 0.05 NEAR gas reserve).`
      );
    }

    const noncePart = params.clientNonce ? `:${params.clientNonce}` : "";
    const intentId = crypto
      .createHash("sha256")
      .update(
        `${customer}|${operator}|${paymentAtomic.toString()}|${budgetAtomic.toString()}|${termsHash}|${params.deadlineSec}${noncePart}`
      )
      .digest("hex")
      .slice(0, 24);

    const existing = this.records.get(intentId);
    if (existing) {
      if (existing.escrowState === "FINAL_CONFIRMED") {
        throw new Error(
          `ERR_DUPLICATE_ESCROW_INTENT: Intent ${intentId} is already confirmed on-chain (tx=${existing.sourceTxHash}, jobId=${existing.jobId}).`
        );
      }
      if (
        existing.escrowState === "PENDING" ||
        existing.escrowState === "UNKNOWN_NEEDS_RECONCILIATION"
      ) {
        throw new Error(
          `ERR_INFLIGHT_TX_EXISTS: Intent ${intentId} has an unresolved transaction (${existing.sourceTxHash}, state=${existing.escrowState}). Reconcile it before retrying.`
        );
      }
    }

    const coreId = config.mainnetCoreContractId;
    const usdcId = config.mainnetUsdcContractId;
    const transactions: PreparedNearTransaction[] = [];

    if (customerState.needsUsdcRegistration) {
      transactions.push({
        stepNumber: transactions.length + 1,
        description: `Register ${customer} on native USDC (0.00125 NEAR)`,
        signerId: customer,
        receiverId: usdcId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "storage_deposit",
            args: { account_id: customer, registration_only: true },
            gas: "30000000000000",
            depositYocto: "1250000000000000000000",
          },
        ],
      });
    }

    if (customerState.needsCoreStorageDeposit) {
      transactions.push({
        stepNumber: transactions.length + 1,
        description: `Deposit required Core storage shortfall (${customerState.coreStorageShortfallYocto} yoctoNEAR) on ${coreId}`,
        signerId: customer,
        receiverId: coreId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "storage_deposit",
            args: { account_id: customer },
            gas: "30000000000000",
            depositYocto: customerState.coreStorageShortfallYocto,
          },
        ],
      });
    }

    const createAndFundMsg = JSON.stringify({
      CreateAndFundJob: {
        operator,
        max_operating_budget: budgetAtomic.toString(),
        terms_hash: termsHash,
        deadline: params.deadlineSec,
      },
    });

    transactions.push({
      stepNumber: transactions.length + 1,
      description: `Fund ${customerState.usdcBalanceFormatted ? "" : ""}${paymentAtomic.toString()} atomic USDC escrow via NEP-141 ft_transfer_call -> ${coreId}::ft_on_transfer`,
      signerId: customer,
      receiverId: usdcId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "ft_transfer_call",
          args: {
            receiver_id: coreId,
            amount: paymentAtomic.toString(),
            memo: "SnowMoon CreateAndFundJob Escrow",
            msg: createAndFundMsg,
          },
          gas: "100000000000000",
          depositYocto: "1",
        },
      ],
      callbackFlowSummary:
        "USDC transfers amount to core.cryptozax.near -> ft_on_transfer(CreateAndFundJob) locks 0.023 NEAR storage credit and creates Funded Job -> ft_resolve_transfer finalizes (or refunds 100% on panic).",
    });

    const now = new Date().toISOString();
    const record: MainnetEscrowJobRecord = {
      intentId,
      jobId: null,
      customerAccountId: customer,
      operatorAccountId: operator,
      coreContractId: coreId,
      usdcContractId: usdcId,
      amountAtomic: paymentAtomic.toString(),
      maxOperatingBudgetAtomic: budgetAtomic.toString(),
      termsHash,
      deadlineSec: params.deadlineSec,
      escrowState: "PREPARED",
      sourceTxHash: null,
      onChainConfirmed: false,
      finalExecutionStatus: null,
      deliveryAndSettlementStatus: "Awaiting customer signature & on-chain confirmation",
      actionableError: customerState.vaultPaused
        ? "Core vault_paused is true on Mainnet; live job submission is blocked until admin unpauses."
        : null,
      createdAt: now,
      updatedAt: now,
      preparedTransactions: transactions,
    };

    this.records.set(intentId, record);
    this.persist();

    return {
      canBroadcastNow: !customerState.vaultPaused,
      blockedReason: customerState.vaultPaused
        ? "ERR_VAULT_PAUSED: core.cryptozax.near has vault_paused=true. Keep vault paused during read-only/mocked verification."
        : null,
      customerState,
      record,
    };
  }

  public submitSignedTransaction(params: {
    intentId: string;
    txHash: string;
    customerAccountId: string;
  }): MainnetEscrowJobRecord {
    const txHash = assertValidTxHash(params.txHash);
    const customer = assertValidNearAccountId(
      params.customerAccountId,
      "customerAccountId"
    );

    const existingOwner = this.txToIntent.get(txHash);
    if (existingOwner && existingOwner !== params.intentId) {
      throw new Error(
        `ERR_REPLAY_DETECTED: Transaction ${txHash} is already bound to escrow intent ${existingOwner}.`
      );
    }

    const record = this.records.get(params.intentId);
    if (!record) {
      throw new Error(`ERR_INTENT_NOT_FOUND: Unknown escrow intent ${params.intentId}`);
    }
    if (record.customerAccountId !== customer) {
      throw new Error(
        `ERR_CUSTOMER_MISMATCH: Intent ${params.intentId} belongs to ${record.customerAccountId}, not ${customer}.`
      );
    }
    if (record.escrowState === "FINAL_CONFIRMED") {
      throw new Error(
        `ERR_ALREADY_CONFIRMED: Intent ${params.intentId} is already FINAL_CONFIRMED (tx=${record.sourceTxHash}).`
      );
    }
    if (record.escrowState === "UNKNOWN_NEEDS_RECONCILIATION") {
      throw new Error(
        `ERR_BLIND_RETRY_BLOCKED: Intent ${params.intentId} has an UNKNOWN transaction (${record.sourceTxHash}). Reconcile it via RPC before taking further action.`
      );
    }
    if (record.escrowState === "PENDING" && record.sourceTxHash && record.sourceTxHash !== txHash) {
      throw new Error(
        `ERR_PENDING_TX_EXISTS: Intent ${params.intentId} already has pending tx ${record.sourceTxHash}.`
      );
    }

    record.sourceTxHash = txHash;
    record.escrowState = "PENDING";
    record.finalExecutionStatus = "PENDING_ON_CHAIN";
    record.onChainConfirmed = false;
    record.actionableError = null;
    record.deliveryAndSettlementStatus = "Submitted to NEAR Mainnet; awaiting finality";
    record.updatedAt = new Date().toISOString();
    this.txToIntent.set(txHash, record.intentId);
    this.persist();
    return record;
  }

  public async reconcileTransaction(
    nearRpc: NearMainnetRpcAdapter,
    params: {
      intentId?: string;
      txHash: string;
      customerAccountId: string;
    }
  ): Promise<MainnetEscrowJobRecord> {
    const txHash = assertValidTxHash(params.txHash);
    const customer = assertValidNearAccountId(
      params.customerAccountId,
      "customerAccountId"
    );
    const resolvedIntentId =
      params.intentId || this.txToIntent.get(txHash);
    if (!resolvedIntentId) {
      throw new Error(
        `ERR_INTENT_NOT_FOUND: No escrow intent found for txHash ${txHash}`
      );
    }
    const record = this.records.get(resolvedIntentId);
    if (!record) {
      throw new Error(`ERR_INTENT_NOT_FOUND: Unknown escrow intent ${resolvedIntentId}`);
    }

    try {
      const rpcRes = await nearRpc.queryTransactionStatus(txHash, customer);
    const now = new Date().toISOString();
    record.sourceTxHash = txHash;
    record.updatedAt = now;
    this.txToIntent.set(txHash, record.intentId);

    if (!rpcRes.ok || !rpcRes.result) {
      const errMsg =
        typeof rpcRes.error === "string"
          ? rpcRes.error
          : rpcRes.error
            ? JSON.stringify(rpcRes.error)
            : "Unknown RPC error";
      const isUnknown =
        /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|NOT_OBSERVED|DoesNotExist/i.test(errMsg);
      record.escrowState = isUnknown ? "UNKNOWN_NEEDS_RECONCILIATION" : "PENDING";
      record.finalExecutionStatus = isUnknown ? "UNKNOWN" : "PENDING";
      record.onChainConfirmed = false;
      record.actionableError = isUnknown
        ? `Transaction ${txHash} not yet observed on Mainnet (${errMsg}). Do NOT blindly retry; re-check status or verify account USDC balance.`
        : `Temporary RPC error while checking ${txHash}: ${errMsg}. Reconcile again.`;
      return record;
    }

    const finalExec = rpcRes.result.final_execution_status || "UNKNOWN";
    record.finalExecutionStatus = finalExec;

    // Verify tx signer and receiver if returned by RPC (prevents txHash substitution)
    const txMeta = rpcRes.result.transaction;
    if (txMeta) {
      if (txMeta.signer_id && txMeta.signer_id !== record.customerAccountId) {
        record.escrowState = "FAILED";
        record.onChainConfirmed = false;
        record.actionableError = `ERR_TX_SIGNER_MISMATCH: Transaction signer (${txMeta.signer_id}) does not match customer (${record.customerAccountId}).`;
        record.deliveryAndSettlementStatus = "Rejected (signer mismatch)";
        return record;
      }
      if (txMeta.receiver_id && txMeta.receiver_id !== record.usdcContractId) {
        record.escrowState = "FAILED";
        record.onChainConfirmed = false;
        record.actionableError = `ERR_TX_RECEIVER_MISMATCH: Transaction receiver (${txMeta.receiver_id}) is not the Mainnet USDC contract (${record.usdcContractId}).`;
        record.deliveryAndSettlementStatus = "Rejected (receiver mismatch)";
        return record;
      }
    }

    const topFailure =
      rpcRes.result.status && "Failure" in rpcRes.result.status
        ? JSON.stringify(rpcRes.result.status.Failure)
        : null;
    const receiptFailure = (rpcRes.result.receipts_outcome || []).find(
      (r) => r.outcome?.status && "Failure" in r.outcome.status
    );
    if (topFailure || receiptFailure) {
      const failDetail =
        topFailure || JSON.stringify(receiptFailure?.outcome?.status);
      record.escrowState = "FAILED";
      record.onChainConfirmed = false;
      record.actionableError = `On-chain execution failed (NEP-141 ft_resolve_transfer refunds USDC on panic): ${failDetail}`;
      record.deliveryAndSettlementStatus = "Failed on-chain (no active escrow)";
      return record;
    }

    if (finalExec !== "FINAL" && finalExec !== "EXECUTED") {
      record.escrowState = "PENDING";
      record.onChainConfirmed = false;
      record.actionableError = null;
      record.deliveryAndSettlementStatus = `Transaction status is ${finalExec}; waiting for FINAL`;
      return record;
    }

    // Extract job_id from EVENT_JSON logs in receipts_outcome
    let extractedJobId: string | null = null;
    for (const r of rpcRes.result.receipts_outcome || []) {
      for (const log of r.outcome?.logs || []) {
        if (!log.startsWith("EVENT_JSON:")) continue;
        try {
          const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as {
            standard?: string;
            event?: string;
            data?: Array<Record<string, unknown>>;
          };
          if (
            ev.standard === "snapfall" &&
            (ev.event === "JobCreated" || ev.event === "JobFunded") &&
            Array.isArray(ev.data) &&
            ev.data[0]
          ) {
            const jid = ev.data[0].jobId || ev.data[0].job_id;
            if (typeof jid === "string" && jid.startsWith("0x")) {
              extractedJobId = jid.toLowerCase();
            }
          }
        } catch {
          // ignore malformed log lines
        }
      }
    }

    if (!extractedJobId) {
      record.escrowState = "FAILED";
      record.onChainConfirmed = false;
      record.actionableError =
        "Transaction finalized, but no snapfall JobCreated/JobFunded event was emitted (USDC transfer may have been refunded by ft_resolve_transfer).";
      record.deliveryAndSettlementStatus = "No on-chain job created";
      return record;
    }

    // Verify the job actually exists on-chain via core.get_job
    const jobRes = await nearRpc.queryCoreJob(extractedJobId, record.coreContractId);
    if (!jobRes.ok || !jobRes.data) {
      record.jobId = extractedJobId;
      record.escrowState = "UNKNOWN_NEEDS_RECONCILIATION";
      record.onChainConfirmed = false;
      record.actionableError = `Found Job ID ${extractedJobId} in logs, but core.get_job verification failed: ${jobRes.error || "null response"}`;
      return record;
    }

    const onChainJob = jobRes.data as {
      status?: string;
      customer?: string;
      customer_payment?: string;
    };
    if (onChainJob.customer && onChainJob.customer !== record.customerAccountId) {
      record.escrowState = "FAILED";
      record.onChainConfirmed = false;
      record.actionableError = `ERR_JOB_CUSTOMER_MISMATCH: On-chain job customer (${onChainJob.customer}) does not match ${record.customerAccountId}.`;
      return record;
    }
    if (
      onChainJob.customer_payment &&
      onChainJob.customer_payment !== record.amountAtomic
    ) {
      record.escrowState = "FAILED";
      record.onChainConfirmed = false;
      record.actionableError = `ERR_JOB_AMOUNT_MISMATCH: On-chain payment (${onChainJob.customer_payment}) does not match intent amount (${record.amountAtomic}).`;
      return record;
    }
    record.jobId = extractedJobId;
    record.escrowState = "FINAL_CONFIRMED";
    record.onChainConfirmed = true;
    record.actionableError = null;
    record.deliveryAndSettlementStatus = `On-chain Job ${onChainJob.status || "Funded"} (payment=${onChainJob.customer_payment || record.amountAtomic})`;
    return record;
    } finally {
      this.persist();
    }
  }
}

