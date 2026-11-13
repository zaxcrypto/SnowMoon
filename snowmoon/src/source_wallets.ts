import type { NearIntentSwapRecord, NearIntentsClient } from "./near_intents.ts";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface SolanaWalletProvider {
  publicKey?: { toBase58(): string } | string;
  signAndSendTransaction(tx: Record<string, unknown>): Promise<{ signature: string } | string>;
}

export interface NearWalletSelectorProvider {
  accountId?: string;
  signAndSendTransaction(params: {
    receiverId: string;
    actions: Array<{ type: "FunctionCall"; params: Record<string, unknown> }>;
  }): Promise<{ transaction?: { hash?: string }; transaction_outcome?: { id?: string } }>;
}

export interface SourceWalletExecutionResult {
  walletAdapter: "evm_eip1193" | "solana_wallet_standard" | "near_wallet_selector";
  sourceChain: string;
  depositAddress: string;
  amountInAtomic: string;
  txHash: string;
  signedByCustomerWallet: true;
}

const EVM_CHAIN_IDS: Record<string, string> = {
  eth: "0x1",
  ethereum: "0x1",
  arb: "0xa4b1",
  arbitrum: "0xa4b1",
  base: "0x2105",
  op: "0xa",
  optimism: "0xa",
  pol: "0x89",
  polygon: "0x89",
  bsc: "0x38",
  avax: "0xa86a",
};

/**
 * Encodes standard ERC-20 `transfer(address,uint256)` calldata (0xa9059cbb).
 */
export function encodeErc20TransferCalldata(toAddress: string, amountAtomic: string): string {
  const cleanAddr = toAddress.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(cleanAddr)) {
    throw new Error(`ERR_INVALID_EVM_ADDRESS: Invalid recipient address ${toAddress}`);
  }
  const amount = BigInt(amountAtomic);
  if (amount <= 0n) {
    throw new Error("ERR_INVALID_AMOUNT: Transfer amount must be > 0");
  }
  const addrWord = cleanAddr.padStart(64, "0");
  const amtWord = amount.toString(16).padStart(64, "0");
  return `0xa9059cbb${addrWord}${amtWord}`;
}

export function extractErc20AddressFromAssetId(originAsset: string): string | null {
  const m = originAsset.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : null;
}

function mapWalletProviderError(err: unknown): Error {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const msg = err instanceof Error ? err.message : String(err);

  if (code === 4001 || /user rejected|rejected the request|cancelled|declined/i.test(msg)) {
    return new Error(`ERR_WALLET_REJECTED: Customer rejected source wallet signature (${msg}).`);
  }
  if (/insufficient funds|insufficient balance|not enough/i.test(msg)) {
    return new Error(`ERR_INSUFFICIENT_FUNDS: Source wallet has insufficient balance (${msg}).`);
  }
  if (/wrong network|chain mismatch|unsupported chain/i.test(msg)) {
    return new Error(`ERR_WRONG_NETWORK: ${msg}`);
  }
  return new Error(`ERR_SOURCE_WALLET_TX_FAILED: ${msg}`);
}

export class EvmEip1193WalletAdapter {
  private readonly provider: Eip1193Provider;

  constructor(provider: Eip1193Provider) {
    this.provider = provider;
  }

  public async signAndSendDeposit(record: NearIntentSwapRecord): Promise<SourceWalletExecutionResult> {
    const expectedChainId = EVM_CHAIN_IDS[record.sourceChain.toLowerCase()];
    if (!expectedChainId) {
      throw new Error(`ERR_UNSUPPORTED_EVM_CHAIN: ${record.sourceChain}`);
    }

    try {
      const currentChain = String(
        await this.provider.request({ method: "eth_chainId" })
      ).toLowerCase();
      if (currentChain !== expectedChainId.toLowerCase()) {
        throw new Error(
          `ERR_WRONG_NETWORK: Expected EVM chainId ${expectedChainId} for ${record.sourceChain}, connected to ${currentChain}.`
        );
      }

      const accounts = (await this.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const from = (accounts?.[0] || "").trim().toLowerCase();
      if (!from || from !== record.sourceWalletAddress.trim().toLowerCase()) {
        throw new Error(
          `ERR_CUSTOMER_MISMATCH: Connected EVM account ${from || "none"} does not match quote sourceWalletAddress ${record.sourceWalletAddress}.`
        );
      }

      const tokenContract = extractErc20AddressFromAssetId(record.originAsset);
      const txParams = tokenContract
        ? {
            from,
            to: tokenContract,
            value: "0x0",
            data: encodeErc20TransferCalldata(record.depositAddress, record.amountInAtomic),
          }
        : {
            from,
            to: record.depositAddress,
            value: "0x" + BigInt(record.amountInAtomic).toString(16),
          };

      const txHash = String(
        await this.provider.request({
          method: "eth_sendTransaction",
          params: [txParams],
        })
      ).trim();

      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error(`ERR_AMBIGUOUS_TX_HASH: Invalid EVM txHash returned: ${txHash}`);
      }

      return {
        walletAdapter: "evm_eip1193",
        sourceChain: record.sourceChain,
        depositAddress: record.depositAddress,
        amountInAtomic: record.amountInAtomic,
        txHash,
        signedByCustomerWallet: true,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ERR_")) throw err;
      throw mapWalletProviderError(err);
    }
  }
}

export class SolanaWalletStandardAdapter {
  private readonly wallet: SolanaWalletProvider;

  constructor(wallet: SolanaWalletProvider) {
    this.wallet = wallet;
  }

  public async signAndSendDeposit(record: NearIntentSwapRecord): Promise<SourceWalletExecutionResult> {
    const chain = record.sourceChain.toLowerCase();
    if (chain !== "sol" && chain !== "solana") {
      throw new Error(`ERR_WRONG_NETWORK: Expected Solana chain, got ${record.sourceChain}`);
    }
    const pubkey =
      typeof this.wallet.publicKey === "string"
        ? this.wallet.publicKey
        : this.wallet.publicKey?.toBase58() || "";
    if (!pubkey || pubkey !== record.sourceWalletAddress) {
      throw new Error(
        `ERR_CUSTOMER_MISMATCH: Connected Solana pubkey ${pubkey || "none"} does not match ${record.sourceWalletAddress}.`
      );
    }

    try {
      const res = await this.wallet.signAndSendTransaction({
        cluster: "mainnet-beta",
        fromPubkey: pubkey,
        toPubkey: record.depositAddress,
        originAsset: record.originAsset,
        amountAtomic: record.amountInAtomic,
      });
      const sig = typeof res === "string" ? res : res.signature;
      if (!sig || sig.trim().length < 32) {
        throw new Error(`ERR_AMBIGUOUS_TX_HASH: Invalid Solana signature returned.`);
      }
      return {
        walletAdapter: "solana_wallet_standard",
        sourceChain: record.sourceChain,
        depositAddress: record.depositAddress,
        amountInAtomic: record.amountInAtomic,
        txHash: sig.trim(),
        signedByCustomerWallet: true,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ERR_")) throw err;
      throw mapWalletProviderError(err);
    }
  }
}

export class NearSourceWalletAdapter {
  private readonly wallet: NearWalletSelectorProvider;
  private readonly usdcContractId: string;

  constructor(wallet: NearWalletSelectorProvider, usdcContractId: string) {
    this.wallet = wallet;
    this.usdcContractId = usdcContractId;
  }

  public async signAndSendDeposit(record: NearIntentSwapRecord): Promise<SourceWalletExecutionResult> {
    if (record.sourceChain.toLowerCase() !== "near") {
      throw new Error(`ERR_WRONG_NETWORK: Expected NEAR source chain, got ${record.sourceChain}`);
    }
    if (this.wallet.accountId && this.wallet.accountId !== record.sourceWalletAddress) {
      throw new Error(
        `ERR_CUSTOMER_MISMATCH: Connected NEAR account ${this.wallet.accountId} does not match ${record.sourceWalletAddress}.`
      );
    }
    try {
      const tokenContract = record.originAsset.replace(/^nep141:/, "") || this.usdcContractId;
      const res = await this.wallet.signAndSendTransaction({
        receiverId: tokenContract,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "ft_transfer",
              args: {
                receiver_id: record.depositAddress,
                amount: record.amountInAtomic,
                memo: `1click:${record.intentId}`,
              },
              gas: "30000000000000",
              deposit: "1",
            },
          },
        ],
      });
      const txHash = res.transaction?.hash || res.transaction_outcome?.id || "";
      if (!txHash) {
        throw new Error("ERR_AMBIGUOUS_TX_HASH: NEAR wallet did not return transaction hash.");
      }
      return {
        walletAdapter: "near_wallet_selector",
        sourceChain: record.sourceChain,
        depositAddress: record.depositAddress,
        amountInAtomic: record.amountInAtomic,
        txHash,
        signedByCustomerWallet: true,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ERR_")) throw err;
      throw mapWalletProviderError(err);
    }
  }
}

/**
 * Executes customer-wallet deposit signing and submits the resulting txHash to 1Click.
 */
export async function executeCustomerSourceWalletDeposit(params: {
  intentsClient: NearIntentsClient;
  depositAddress: string;
  evmProvider?: Eip1193Provider;
  solanaWallet?: SolanaWalletProvider;
  nearWallet?: NearWalletSelectorProvider;
  usdcContractId?: string;
}): Promise<{
  walletResult: SourceWalletExecutionResult;
  updatedIntent: NearIntentSwapRecord;
}> {
  const plan = params.intentsClient.prepareSourceWalletDeposit(params.depositAddress);
  const record = params.intentsClient.getIntent(params.depositAddress);
  if (!record) {
    throw new Error(`ERR_UNKNOWN_INTENT: ${params.depositAddress}`);
  }

  let walletResult: SourceWalletExecutionResult;
  if (plan.walletAdapter === "evm_eip1193") {
    if (!params.evmProvider) {
      throw new Error("ERR_WALLET_NOT_CONNECTED: Connect an EVM EIP-1193 wallet.");
    }
    walletResult = await new EvmEip1193WalletAdapter(params.evmProvider).signAndSendDeposit(record);
  } else if (plan.walletAdapter === "solana_wallet_standard") {
    if (!params.solanaWallet) {
      throw new Error("ERR_WALLET_NOT_CONNECTED: Connect a Solana Wallet Standard provider.");
    }
    walletResult = await new SolanaWalletStandardAdapter(params.solanaWallet).signAndSendDeposit(record);
  } else if (plan.walletAdapter === "near_wallet_selector") {
    if (!params.nearWallet) {
      throw new Error("ERR_WALLET_NOT_CONNECTED: Connect a NEAR Wallet Selector account.");
    }
    walletResult = await new NearSourceWalletAdapter(
      params.nearWallet,
      params.usdcContractId || "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    ).signAndSendDeposit(record);
  } else {
    throw new Error(
      `ERR_UNSUPPORTED_AUTOMATIC_WALLET: Source chain ${record.sourceChain} requires manual deposit to ${record.depositAddress}.`
    );
  }

  const updatedIntent = await params.intentsClient.submitDepositTx({
    depositAddress: record.depositAddress,
    txHash: walletResult.txHash,
    customerNearAccount: record.customerNearAccount,
  });

  return { walletResult, updatedIntent };
}

