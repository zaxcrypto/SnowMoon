import crypto from "node:crypto";
import type { SnowMoonConfig } from "./config.ts";
import {
  assertValidNearAccountId,
  parseU128DecimalString,
  type NearMainnetRpcAdapter,
} from "./near_rpc.ts";
import type { SnowMoonRepository } from "./persistence.ts";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  priceUpdatedAt?: string;
  contractAddress?: string;
  coingeckoId?: string;
}

export type OneClickSwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED"
  | "UNKNOWN_STATUS";

export type IntentLifecycleStage =
  | "QUOTE_GENERATED"
  | "SOURCE_TX_SIGNED"
  | "SOURCE_TX_CONFIRMED"
  | "INTENT_PROCESSING"
  | "DESTINATION_USDC_RECEIVED"
  | "DESTINATION_USDC_VERIFIED"
  | "ESCROW_FUNDED"
  | "EXPIRED"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export interface NearIntentSwapRecord {
  intentId: string;
  customerNearAccount: string;
  sourceWalletAddress: string;
  sourceChain: string;
  originAsset: string;
  destinationAsset: string;
  amountInAtomic: string;
  expectedAmountOutAtomic: string;
  minAmountOutAtomic: string;
  estimatedFeesUsd: string | null;
  slippageToleranceBps: number;
  depositAddress: string;
  quoteExpiresAt: string;
  sourceTxHash: string | null;
  sourceTxConfirmed: boolean;
  lifecycleStage: IntentLifecycleStage;
  status: OneClickSwapStatus;
  rawStatus: string;
  preSwapNearUsdcAtomic: string;
  postSwapNearUsdcAtomic: string | null;
  receivedDeltaAtomic: string | null;
  destinationTxHash: string | null;
  destinationVerified: boolean;
  escrowFundingEnabled: boolean;
  escrowIntentId: string | null;
  actionableError: string | null;
  createdAt: string;
  updatedAt: string;
}

const KNOWN_1CLICK_STATUSES = new Set<string>([
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "SUCCESS",
  "INCOMPLETE_DEPOSIT",
  "REFUNDED",
  "FAILED",
]);

export class NearIntentsClient {
  private readonly config: SnowMoonConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly repo?: SnowMoonRepository;
  private cachedTokens: OneClickToken[] = [];
  private tokensFetchedAtMs = 0;
  private readonly tokenCacheTtlMs = 5 * 60 * 1000;
  private readonly records = new Map<string, NearIntentSwapRecord>();
  private readonly txToDeposit = new Map<string, string>();

  constructor(
    config: SnowMoonConfig,
    fetchImpl: typeof fetch = fetch,
    repo?: SnowMoonRepository
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.repo = repo;
    this.reloadFromRepo();
  }

  public reloadFromRepo(): void {
    if (!this.repo) return;
    this.records.clear();
    this.txToDeposit.clear();
    for (const r of this.repo.getCollection<NearIntentSwapRecord>("intents")) {
      this.records.set(r.depositAddress, r);
      if (r.sourceTxHash) {
        this.txToDeposit.set(r.sourceTxHash, r.depositAddress);
      }
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("intents", Array.from(this.records.values()));
    }
  }

  public listIntents(): NearIntentSwapRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  public getIntent(depositAddress: string): NearIntentSwapRecord | undefined {
    return this.records.get(depositAddress);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.secrets.oneClickApiKey) {
      headers["X-API-Key"] = this.config.secrets.oneClickApiKey;
    }
    return headers;
  }

  public async fetchSupportedTokens(forceRefresh = false): Promise<{
    tokens: OneClickToken[];
    nearNativeUsdc: OneClickToken;
    cached: boolean;
  }> {
    const now = Date.now();
    let cached = true;
    if (
      forceRefresh ||
      this.cachedTokens.length === 0 ||
      now - this.tokensFetchedAtMs > this.tokenCacheTtlMs
    ) {
      const url = `${this.config.oneClickApiBaseUrl}/v0/tokens`;
      const resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.buildHeaders(),
      });
      if (!resp.ok) {
        throw new Error(`ERR_1CLICK_TOKENS_HTTP_${resp.status}: Failed to fetch 1Click tokens.`);
      }
      const data = (await resp.json()) as unknown;
      if (!Array.isArray(data)) {
        throw new Error("ERR_1CLICK_TOKENS_SCHEMA: Expected array from /v0/tokens.");
      }
      this.cachedTokens = data as OneClickToken[];
      this.tokensFetchedAtMs = now;
      cached = false;
    }

    const nearNativeUsdc = this.cachedTokens.find(
      (t) =>
        t.blockchain?.toLowerCase() === "near" &&
        t.symbol?.toUpperCase() === "USDC" &&
        t.contractAddress?.toLowerCase() === this.config.mainnetUsdcContractId.toLowerCase() &&
        t.decimals === 6
    );
    if (!nearNativeUsdc) {
      throw new Error(
        `ERR_NEAR_USDC_NOT_FOUND: Native NEAR USDC (${this.config.mainnetUsdcContractId}) not found in 1Click /v0/tokens.`
      );
    }

    return {
      tokens: this.cachedTokens,
      nearNativeUsdc,
      cached,
    };
  }

  public async requestQuote(
    nearRpc: NearMainnetRpcAdapter,
    params: {
      dry: boolean;
      originAsset: string;
      amountAtomic: string;
      slippageToleranceBps: number;
      customerNearAccount: string;
      sourceWalletAddress: string;
      deadlineIso?: string;
    }
  ): Promise<{
    dry: boolean;
    quote: Record<string, unknown>;
    originToken: OneClickToken;
    destinationToken: OneClickToken;
    record: NearIntentSwapRecord | null;
  }> {
    const customerNear = assertValidNearAccountId(
      params.customerNearAccount,
      "customerNearAccount"
    );
    const sourceWallet = params.sourceWalletAddress.trim();
    if (!sourceWallet) {
      throw new Error("ERR_INVALID_SOURCE_WALLET: sourceWalletAddress is required.");
    }
    const amountVal = parseU128DecimalString(params.amountAtomic, "amountAtomic", false);
    if (
      !Number.isInteger(params.slippageToleranceBps) ||
      params.slippageToleranceBps < 1 ||
      params.slippageToleranceBps > 5000
    ) {
      throw new Error("ERR_INVALID_SLIPPAGE: slippageToleranceBps must be integer 1..5000.");
    }

    const { tokens, nearNativeUsdc } = await this.fetchSupportedTokens();
    const originToken = tokens.find((t) => t.assetId === params.originAsset);
    if (!originToken) {
      throw new Error(
        `ERR_UNSUPPORTED_ORIGIN_ASSET: "${params.originAsset}" is not in 1Click supported tokens.`
      );
    }

    const deadline =
      params.deadlineIso || new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const quoteBody = {
      dry: params.dry,
      swapType: "EXACT_INPUT",
      originAsset: originToken.assetId,
      destinationAsset: nearNativeUsdc.assetId,
      amount: amountVal.toString(),
      slippageTolerance: params.slippageToleranceBps,
      depositType: "ORIGIN_CHAIN",
      recipient: customerNear,
      recipientType: "DESTINATION_CHAIN",
      refundTo: sourceWallet,
      refundType: "ORIGIN_CHAIN",
      deadline,
    };

    const resp = await this.fetchImpl(`${this.config.oneClickApiBaseUrl}/v0/quote`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(quoteBody),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`ERR_1CLICK_QUOTE_HTTP_${resp.status}: ${errText.slice(0, 240)}`);
    }

    const quoteData = (await resp.json()) as {
      quote?: {
        depositAddress?: string;
        amountIn?: string;
        amountOut?: string;
        minAmountOut?: string;
        deadline?: string;
        estimatedFeesUsd?: string;
      };
      depositAddress?: string;
      amountIn?: string;
      amountOut?: string;
      minAmountOut?: string;
      deadline?: string;
    };

    const q = quoteData.quote ?? quoteData;
    if (params.dry) {
      return {
        dry: true,
        quote: quoteData as unknown as Record<string, unknown>,
        originToken,
        destinationToken: nearNativeUsdc,
        record: null,
      };
    }

    const depositAddress = q.depositAddress?.trim();
    if (!depositAddress) {
      throw new Error("ERR_MISSING_DEPOSIT_ADDRESS: Committed 1Click quote did not return depositAddress.");
    }
    if (this.records.has(depositAddress)) {
      throw new Error(`ERR_DUPLICATE_INTENT: Deposit address ${depositAddress} is already tracked.`);
    }

    // Snapshot pre-swap NEAR USDC balance for independent destination verification
    const preNear = await nearRpc.inspectMainnetAccount(customerNear);
    const now = new Date().toISOString();
    const record: NearIntentSwapRecord = {
      intentId:
        "ni_" +
        crypto
          .createHash("sha256")
          .update(`${depositAddress}|${customerNear}|${now}`)
          .digest("hex")
          .slice(0, 16),
      customerNearAccount: customerNear,
      sourceWalletAddress: sourceWallet,
      sourceChain: originToken.blockchain,
      originAsset: originToken.assetId,
      destinationAsset: nearNativeUsdc.assetId,
      amountInAtomic: String(q.amountIn || amountVal.toString()),
      expectedAmountOutAtomic: String(q.amountOut || "0"),
      minAmountOutAtomic: String(q.minAmountOut || q.amountOut || "0"),
      estimatedFeesUsd: (q as { estimatedFeesUsd?: string }).estimatedFeesUsd ?? null,
      slippageToleranceBps: params.slippageToleranceBps,
      depositAddress,
      quoteExpiresAt: q.deadline || deadline,
      sourceTxHash: null,
      sourceTxConfirmed: false,
      lifecycleStage: "QUOTE_GENERATED",
      status: "PENDING_DEPOSIT",
      rawStatus: "PENDING_DEPOSIT",
      preSwapNearUsdcAtomic: preNear.usdcBalanceAtomic,
      postSwapNearUsdcAtomic: null,
      receivedDeltaAtomic: null,
      destinationTxHash: null,
      destinationVerified: false,
      escrowFundingEnabled: false,
      escrowIntentId: null,
      actionableError: null,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(depositAddress, record);
    this.persist();

    return {
      dry: false,
      quote: quoteData as unknown as Record<string, unknown>,
      originToken,
      destinationToken: nearNativeUsdc,
      record,
    };
  }

  public async proxyWidgetQuote(
    nearRpc: NearMainnetRpcAdapter,
    quoteRequest: Record<string, unknown>
  ): Promise<{
    dry: boolean;
    quote: Record<string, unknown>;
    quoteResponse: Record<string, unknown>;
    record: NearIntentSwapRecord | null;
  }> {
    const originAsset = String(quoteRequest.originAsset || "").trim();
    const { tokens, nearNativeUsdc } = await this.fetchSupportedTokens();
    const originToken = tokens.find((t) => t.assetId === originAsset);
    if (!originToken) {
      throw new Error(
        `ERR_UNSUPPORTED_ORIGIN_ASSET: "${originAsset}" is not in 1Click supported tokens.`
      );
    }
    const requestedDest = String(quoteRequest.destinationAsset || "").trim();
    if (requestedDest && requestedDest !== nearNativeUsdc.assetId) {
      throw new Error(
        `ERR_INVALID_DESTINATION_ASSET: Destination must be NEAR Mainnet USDC (${nearNativeUsdc.assetId}).`
      );
    }
    const amountVal = parseU128DecimalString(
      String(quoteRequest.amount || ""),
      "amount",
      false
    );
    const dry = Boolean(quoteRequest.dry);
    const payload = {
      ...quoteRequest,
      originAsset: originToken.assetId,
      destinationAsset: nearNativeUsdc.assetId,
      amount: amountVal.toString(),
    };

    const resp = await this.fetchImpl(`${this.config.oneClickApiBaseUrl}/v0/quote`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`ERR_1CLICK_QUOTE_HTTP_${resp.status}: ${errText.slice(0, 240)}`);
    }

    const quoteData = (await resp.json()) as {
      quote?: Record<string, unknown> & {
        depositAddress?: string;
        amountIn?: string;
        amountOut?: string;
        minAmountOut?: string;
        deadline?: string;
        estimatedFeesUsd?: string;
      };
      depositAddress?: string;
      amountIn?: string;
      amountOut?: string;
      minAmountOut?: string;
      deadline?: string;
    };
    const q = (quoteData.quote ?? quoteData) as Record<string, unknown> & {
      depositAddress?: string;
      amountIn?: string;
      amountOut?: string;
      minAmountOut?: string;
      deadline?: string;
      estimatedFeesUsd?: string;
    };

    if (dry || !q.depositAddress) {
      return {
        dry,
        quote: q,
        quoteResponse: quoteData as unknown as Record<string, unknown>,
        record: null,
      };
    }

    const depositAddress = String(q.depositAddress).trim();
    if (this.records.has(depositAddress)) {
      return {
        dry: false,
        quote: q,
        quoteResponse: quoteData as unknown as Record<string, unknown>,
        record: this.records.get(depositAddress) || null,
      };
    }

    const recipient = String(quoteRequest.recipient || "").trim();
    let customerNear = recipient;
    let preSwapNearUsdcAtomic = "0";
    try {
      customerNear = assertValidNearAccountId(recipient, "recipient");
      const preNear = await nearRpc.inspectMainnetAccount(customerNear);
      preSwapNearUsdcAtomic = preNear.usdcBalanceAtomic;
    } catch {
      // Non-NEAR or intents internal recipient
    }

    const now = new Date().toISOString();
    const record: NearIntentSwapRecord = {
      intentId:
        "ni_" +
        crypto
          .createHash("sha256")
          .update(`${depositAddress}|${customerNear}|${now}`)
          .digest("hex")
          .slice(0, 16),
      customerNearAccount: customerNear,
      sourceWalletAddress: String(quoteRequest.refundTo || customerNear),
      sourceChain: originToken.blockchain,
      originAsset: originToken.assetId,
      destinationAsset: nearNativeUsdc.assetId,
      amountInAtomic: String(q.amountIn || amountVal.toString()),
      expectedAmountOutAtomic: String(q.amountOut || "0"),
      minAmountOutAtomic: String(q.minAmountOut || q.amountOut || "0"),
      estimatedFeesUsd: q.estimatedFeesUsd ?? null,
      slippageToleranceBps: Number(quoteRequest.slippageTolerance ?? 100),
      depositAddress,
      quoteExpiresAt: String(q.deadline || quoteRequest.deadline || new Date(Date.now() + 30 * 60 * 1000).toISOString()),
      sourceTxHash: null,
      sourceTxConfirmed: false,
      lifecycleStage: "QUOTE_GENERATED",
      status: "PENDING_DEPOSIT",
      rawStatus: "PENDING_DEPOSIT",
      preSwapNearUsdcAtomic,
      postSwapNearUsdcAtomic: null,
      receivedDeltaAtomic: null,
      destinationTxHash: null,
      destinationVerified: false,
      escrowFundingEnabled: false,
      escrowIntentId: null,
      actionableError: null,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(depositAddress, record);
    this.persist();

    return {
      dry: false,
      quote: q,
      quoteResponse: quoteData as unknown as Record<string, unknown>,
      record,
    };
  }

  public async submitDepositTx(params: {
    depositAddress: string;
    txHash: string;
    customerNearAccount: string;
  }): Promise<NearIntentSwapRecord> {
    const depositAddress = params.depositAddress.trim();
    const txHash = params.txHash.trim();
    if (!txHash) throw new Error("ERR_INVALID_TX_HASH: source txHash is required.");

    const existingOwner = this.txToDeposit.get(txHash);
    if (existingOwner && existingOwner !== depositAddress) {
      throw new Error(
        `ERR_DUPLICATE_SOURCE_TX: Source tx ${txHash} is already bound to deposit ${existingOwner}.`
      );
    }

    const record = this.records.get(depositAddress);
    if (!record) {
      throw new Error(`ERR_UNKNOWN_INTENT: No committed quote for depositAddress ${depositAddress}.`);
    }
    if (record.customerNearAccount !== params.customerNearAccount) {
      throw new Error("ERR_CUSTOMER_MISMATCH: Connected NEAR account does not match quote recipient.");
    }
    if (Date.now() > Date.parse(record.quoteExpiresAt)) {
      record.status = "FAILED";
      record.lifecycleStage = "EXPIRED";
      record.actionableError = `Quote expired at ${record.quoteExpiresAt}. Do not send funds; request a fresh quote.`;
      record.updatedAt = new Date().toISOString();
      this.persist();
      throw new Error("ERR_QUOTE_EXPIRED: Quote deadline has passed.");
    }
    if (record.sourceTxHash && record.sourceTxHash !== txHash) {
      throw new Error(`ERR_DUPLICATE_DEPOSIT_SUBMIT: Deposit already has tx ${record.sourceTxHash}.`);
    }

    const resp = await this.fetchImpl(`${this.config.oneClickApiBaseUrl}/v0/deposit/submit`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ txHash, depositAddress }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ERR_1CLICK_DEPOSIT_SUBMIT_HTTP_${resp.status}: ${txt.slice(0, 200)}`);
    }

    record.sourceTxHash = txHash;
    record.sourceTxConfirmed = false;
    record.lifecycleStage = "SOURCE_TX_SIGNED";
    record.status = "KNOWN_DEPOSIT_TX";
    record.rawStatus = "KNOWN_DEPOSIT_TX";
    record.actionableError = null;
    record.updatedAt = new Date().toISOString();
    this.txToDeposit.set(txHash, depositAddress);
    this.persist();
    return record;
  }

  public async pollStatus(depositAddress: string): Promise<NearIntentSwapRecord> {
    const record = this.records.get(depositAddress.trim());
    if (!record) {
      throw new Error(`ERR_UNKNOWN_INTENT: No quote for depositAddress ${depositAddress}`);
    }

    const url = `${this.config.oneClickApiBaseUrl}/v0/status?depositAddress=${encodeURIComponent(
      record.depositAddress
    )}`;
    const resp = await this.fetchImpl(url, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ERR_1CLICK_STATUS_HTTP_${resp.status}: ${txt.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      status?: string;
      swapDetails?: {
        destinationChainTxHashes?: Array<{ hash?: string }>;
        amountOut?: string;
      };
    };

    const rawStatus = String(data.status || "UNKNOWN");
    record.rawStatus = rawStatus;
    record.status = KNOWN_1CLICK_STATUSES.has(rawStatus)
      ? (rawStatus as OneClickSwapStatus)
      : "UNKNOWN_STATUS";
    if (data.swapDetails?.destinationChainTxHashes?.[0]?.hash) {
      record.destinationTxHash = data.swapDetails.destinationChainTxHashes[0].hash;
    }
    if (record.status === "KNOWN_DEPOSIT_TX") {
      record.sourceTxConfirmed = true;
      record.lifecycleStage = "SOURCE_TX_CONFIRMED";
      record.actionableError = null;
    } else if (record.status === "PROCESSING") {
      record.sourceTxConfirmed = true;
      record.lifecycleStage = "INTENT_PROCESSING";
      record.actionableError = null;
    } else if (record.status === "SUCCESS") {
      record.sourceTxConfirmed = true;
      if (!record.destinationVerified) {
        record.lifecycleStage = "DESTINATION_USDC_RECEIVED";
      }
      record.actionableError = null;
    } else if (record.status === "INCOMPLETE_DEPOSIT") {
      record.lifecycleStage = "INCOMPLETE_DEPOSIT";
      record.actionableError = "1Click reported INCOMPLETE_DEPOSIT. Top up remaining deposit or wait for refund.";
    } else if (record.status === "REFUNDED") {
      record.lifecycleStage = "REFUNDED";
      record.actionableError = `Swap refunded to source wallet (${record.sourceWalletAddress}).`;
    } else if (record.status === "FAILED") {
      record.lifecycleStage = "FAILED";
      record.actionableError = "Swap failed; verify refund on source chain before retrying.";
    } else if (record.status === "UNKNOWN_STATUS") {
      record.actionableError = `Unrecognized 1Click status "${rawStatus}". Re-poll before taking action.`;
    } else {
      record.actionableError = null;
    }
    record.updatedAt = new Date().toISOString();
    this.persist();
    return record;
  }

  public async verifyDestinationDelivery(
    nearRpc: NearMainnetRpcAdapter,
    params: {
      depositAddress: string;
      expectedRecipient: string;
      expectedTokenContract?: string;
    }
  ): Promise<NearIntentSwapRecord> {
    const record = this.records.get(params.depositAddress.trim());
    if (!record) {
      throw new Error(`ERR_UNKNOWN_INTENT: Unknown depositAddress ${params.depositAddress}`);
    }
    if (record.status !== "SUCCESS") {
      throw new Error(
        `ERR_SWAP_NOT_SUCCESS: Cannot verify destination while 1Click status is ${record.status}.`
      );
    }
    if (record.customerNearAccount !== params.expectedRecipient) {
      throw new Error(
        `ERR_WRONG_DESTINATION_ACCOUNT: Expected ${params.expectedRecipient}, quote recipient is ${record.customerNearAccount}.`
      );
    }
    const tokenContract = params.expectedTokenContract || this.config.mainnetUsdcContractId;
    if (tokenContract !== this.config.mainnetUsdcContractId) {
      throw new Error(
        `ERR_WRONG_DESTINATION_TOKEN: Token ${tokenContract} is not SnowMoon native USDC (${this.config.mainnetUsdcContractId}).`
      );
    }

    const acct = await nearRpc.inspectMainnetAccount(record.customerNearAccount);
    if (!acct.exists) {
      throw new Error(`ERR_DESTINATION_ACCOUNT_MISSING: ${record.customerNearAccount} does not exist on NEAR.`);
    }

    const pre = BigInt(record.preSwapNearUsdcAtomic);
    const post = BigInt(acct.usdcBalanceAtomic);
    const delta = post > pre ? post - pre : 0n;
    const minRequired = BigInt(record.minAmountOutAtomic);

    record.postSwapNearUsdcAtomic = post.toString();
    record.receivedDeltaAtomic = delta.toString();

    if (delta < minRequired) {
      record.destinationVerified = false;
      record.escrowFundingEnabled = false;
      record.actionableError = `ERR_INSUFFICIENT_DELIVERED_USDC: Observed balance increase ${delta.toString()} < quote minimum ${minRequired.toString()}.`;
      record.updatedAt = new Date().toISOString();
      this.persist();
      throw new Error(record.actionableError);
    }

    record.destinationVerified = true;
    record.lifecycleStage = record.escrowIntentId
      ? "ESCROW_FUNDED"
      : "DESTINATION_USDC_VERIFIED";
    record.escrowFundingEnabled = record.escrowIntentId === null;
    record.actionableError = null;
    record.updatedAt = new Date().toISOString();
    this.persist();
    return record;
  }

  public markEscrowFunded(depositAddress: string, escrowIntentId: string): NearIntentSwapRecord {
    const record = this.records.get(depositAddress);
    if (!record) throw new Error(`ERR_UNKNOWN_INTENT: ${depositAddress}`);
    if (!record.destinationVerified) {
      throw new Error("ERR_DESTINATION_NOT_VERIFIED: Destination USDC must be verified before funding Core escrow.");
    }
    if (record.escrowIntentId) {
      throw new Error(
        `ERR_DUPLICATE_INTENT_ESCROW: Intent ${depositAddress} already funded Core escrow ${record.escrowIntentId}.`
      );
    }
    record.escrowIntentId = escrowIntentId;
    record.escrowFundingEnabled = false;
    record.lifecycleStage = "ESCROW_FUNDED";
    record.updatedAt = new Date().toISOString();
    this.persist();
    return record;
  }

  /**
   * Builds an unsigned source-chain wallet transfer payload for customer-wallet signing only.
   * Rejects expired quotes and never accepts or touches private keys.
   */
  public prepareSourceWalletDeposit(depositAddress: string): {
    depositAddress: string;
    sourceChain: string;
    originAsset: string;
    amountInAtomic: string;
    quoteExpiresAt: string;
    walletAdapter: "evm_eip1193" | "solana_wallet_standard" | "near_wallet_selector" | "manual_deposit_address";
    unsignedTransferPayload: Record<string, unknown>;
  } {
    const record = this.records.get(depositAddress.trim());
    if (!record) {
      throw new Error(`ERR_UNKNOWN_INTENT: No committed quote for depositAddress ${depositAddress}`);
    }
    if (Date.now() > Date.parse(record.quoteExpiresAt)) {
      record.status = "FAILED";
      record.lifecycleStage = "EXPIRED";
      record.actionableError = `Quote expired at ${record.quoteExpiresAt}. Request a new quote before signing.`;
      record.updatedAt = new Date().toISOString();
      this.persist();
      throw new Error("ERR_QUOTE_EXPIRED: Cannot prepare source wallet deposit for expired quote.");
    }
    if (record.sourceTxHash) {
      throw new Error(`ERR_DUPLICATE_DEPOSIT_SUBMIT: Intent already has source tx ${record.sourceTxHash}.`);
    }

    const chain = record.sourceChain.toLowerCase();
    if (
      ["eth", "ethereum", "arb", "arbitrum", "base", "op", "optimism", "pol", "polygon", "bsc", "avax"].includes(
        chain
      )
    ) {
      const isNative = !record.originAsset.includes(":");
      return {
        depositAddress: record.depositAddress,
        sourceChain: record.sourceChain,
        originAsset: record.originAsset,
        amountInAtomic: record.amountInAtomic,
        quoteExpiresAt: record.quoteExpiresAt,
        walletAdapter: "evm_eip1193",
        unsignedTransferPayload: isNative
          ? {
              method: "eth_sendTransaction",
              params: [
                {
                  from: record.sourceWalletAddress,
                  to: record.depositAddress,
                  value: "0x" + BigInt(record.amountInAtomic).toString(16),
                },
              ],
            }
          : {
              method: "erc20_transfer",
              tokenAssetId: record.originAsset,
              to: record.depositAddress,
              amountAtomic: record.amountInAtomic,
              from: record.sourceWalletAddress,
            },
      };
    }

    if (chain === "sol" || chain === "solana") {
      return {
        depositAddress: record.depositAddress,
        sourceChain: record.sourceChain,
        originAsset: record.originAsset,
        amountInAtomic: record.amountInAtomic,
        quoteExpiresAt: record.quoteExpiresAt,
        walletAdapter: "solana_wallet_standard",
        unsignedTransferPayload: {
          method: "solana_transfer",
          fromPubkey: record.sourceWalletAddress,
          toPubkey: record.depositAddress,
          originAsset: record.originAsset,
          amountAtomic: record.amountInAtomic,
        },
      };
    }

    if (chain === "near") {
      return {
        depositAddress: record.depositAddress,
        sourceChain: record.sourceChain,
        originAsset: record.originAsset,
        amountInAtomic: record.amountInAtomic,
        quoteExpiresAt: record.quoteExpiresAt,
        walletAdapter: "near_wallet_selector",
        unsignedTransferPayload: {
          signerId: record.sourceWalletAddress,
          receiverId: record.depositAddress,
          originAsset: record.originAsset,
          amountAtomic: record.amountInAtomic,
        },
      };
    }

    return {
      depositAddress: record.depositAddress,
      sourceChain: record.sourceChain,
      originAsset: record.originAsset,
      amountInAtomic: record.amountInAtomic,
      quoteExpiresAt: record.quoteExpiresAt,
      walletAdapter: "manual_deposit_address",
      unsignedTransferPayload: {
        to: record.depositAddress,
        originAsset: record.originAsset,
        amountAtomic: record.amountInAtomic,
      },
    };
  }

  /**
   * Bridges a verified NEAR Intents destination USDC delivery into the Core escrow flow
   * without allowing duplicate escrow funding or unverified intents.
   */
  public prepareCoreEscrowFromIntent(
    nearRpc: NearMainnetRpcAdapter,
    params: {
      depositAddress: string;
      workerAccountId: string;
      deadlineSec: number;
      termsHash: string;
      expectedCustomerAccount?: string;
    }
  ) {
    const record = this.records.get(params.depositAddress.trim());
    if (!record) {
      throw new Error(`ERR_UNKNOWN_INTENT: ${params.depositAddress}`);
    }
    if (
      params.expectedCustomerAccount &&
      record.customerNearAccount !== params.expectedCustomerAccount
    ) {
      throw new Error(
        `ERR_CUSTOMER_MISMATCH: Intent ${params.depositAddress} belongs to ${record.customerNearAccount}, not ${params.expectedCustomerAccount}.`
      );
    }
    if (!record.destinationVerified) {
      throw new Error("ERR_DESTINATION_NOT_VERIFIED: Verify destination USDC on NEAR Mainnet first.");
    }
    if (record.escrowIntentId) {
      throw new Error(
        `ERR_DUPLICATE_INTENT_ESCROW: Intent ${record.depositAddress} already funded escrow ${record.escrowIntentId}.`
      );
    }
    const received = BigInt(record.receivedDeltaAtomic || record.minAmountOutAtomic);
    const minOut = BigInt(record.minAmountOutAtomic);
    const escrowAmount = received >= minOut ? minOut.toString() : received.toString();

    return {
      intentId: record.intentId,
      depositAddress: record.depositAddress,
      customerAccountId: record.customerNearAccount,
      escrowAmountAtomic: escrowAmount,
      preparedTransferCall: nearRpc.prepareUsdcEscrowAndJobPayloads({
        customerAccountId: record.customerNearAccount,
        operatorAccountId: params.workerAccountId,
        customerPaymentUsdcAtomic: escrowAmount,
        deadlineSec: params.deadlineSec,
        termsHash: params.termsHash,
      }),
    };
  }
}

