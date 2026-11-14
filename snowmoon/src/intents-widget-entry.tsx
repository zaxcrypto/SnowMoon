import React, { useEffect, useMemo, useState, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { encodeFunctionData, parseAbi } from "viem";
import { ChainLogo, TokenWithChainIcon } from "./intents-icons";

const NEAR_USDC_ASSET_ID =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const ERC20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const EVM_CHAIN_IDS: Record<string, number> = {
  eth: 1,
  ethereum: 1,
  arb: 42161,
  arbitrum: 42161,
  base: 8453,
  op: 10,
  optimism: 10,
  pol: 137,
  polygon: 137,
  bsc: 56,
  avax: 43114,
  avalanche: 43114,
  gnosis: 100,
  bera: 80094,
  monad: 143,
  aurora: 1313161554,
  scroll: 534352,
  xlayer: 196,
};

const EVM_RPC_URLS: Record<string, string> = {
  eth: "https://ethereum-rpc.publicnode.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
  arb: "https://arb1.arbitrum.io/rpc",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  op: "https://mainnet.optimism.io",
  optimism: "https://mainnet.optimism.io",
  pol: "https://polygon-rpc.com",
  polygon: "https://polygon-rpc.com",
  bsc: "https://bsc-dataseed.binance.org",
  avax: "https://api.avax.network/ext/bc/C/rpc",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  gnosis: "https://rpc.gnosischain.com",
  bera: "https://rpc.berachain.com",
  monad: "https://rpc.monad.xyz",
  aurora: "https://mainnet.aurora.dev",
  scroll: "https://rpc.scroll.io",
  xlayer: "https://rpc.xlayer.tech",
};

const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

const EXPLORER_TX_URLS: Record<string, string> = {
  eth: "https://etherscan.io/tx/",
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  op: "https://optimistic.etherscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  pol: "https://polygonscan.com/tx/",
  polygon: "https://polygonscan.com/tx/",
  bsc: "https://bscscan.com/tx/",
  avax: "https://snowtrace.io/tx/",
  avalanche: "https://snowtrace.io/tx/",
  gnosis: "https://gnosisscan.io/tx/",
  scroll: "https://scrollscan.com/tx/",
  sol: "https://solscan.io/tx/",
  solana: "https://solscan.io/tx/",
  near: "https://nearblocks.io/txns/",
};

const CHAIN_LABELS: Record<string, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  sol: "Solana",
  near: "NEAR",
  gnosis: "Gnosis",
  bera: "Berachain",
  monad: "Monad",
  sui: "Sui",
  ton: "TON",
  tron: "Tron",
  btc: "Bitcoin",
  doge: "Dogecoin",
  xrp: "XRP",
  ltc: "Litecoin",
  stellar: "Stellar",
  aptos: "Aptos",
  cardano: "Cardano",
};

interface IntentToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  contractAddress?: string;
  price: number;
}

interface QuotePreview {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut?: string;
  timeEstimate?: number;
  deadline?: string;
  depositAddress?: string;
  depositMemo?: string;
}

export interface SnowMoonIntentsWidgetOptions {
  nearAccountId?: string;
  colorScheme?: "light" | "dark";
  onQuoteCreated?: (res: {
    dry: boolean;
    quote: Record<string, unknown>;
    record: Record<string, unknown> | null;
  }) => void;
  onTransferSuccess?: (msg: {
    hash?: string;
    depositAddress?: string;
    transactionLink?: string;
    [key: string]: unknown;
  }) => void;
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

interface SolanaProvider {
  publicKey?: { toBase58(): string };
  isConnected?: boolean;
  connect: () => Promise<{ publicKey: { toBase58(): string } }>;
  signAndSendTransaction?: (tx: unknown) => Promise<{ signature: string }>;
}

function getChainKind(blockchain: string): "evm" | "near" | "solana" | "other" {
  const c = blockchain.toLowerCase();
  if (c === "near") return "near";
  if (c === "sol" || c === "solana") return "solana";
  if (EVM_CHAIN_IDS[c] !== undefined) return "evm";
  return "other";
}

function formatChainName(blockchain: string): string {
  const c = blockchain.toLowerCase();
  return CHAIN_LABELS[c] || blockchain.toUpperCase();
}

function shortAddr(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function toAtomicString(humanAmount: string, decimals: number): string | null {
  const trimmed = humanAmount.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (Number(trimmed) <= 0) return null;
  const paddedFrac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFrac}`.replace(/^0+/, "") || "0";
  return combined === "0" ? null : combined;
}

function formatAtomic(atomic: string | undefined, decimals: number, maxFrac = 6): string {
  if (!atomic || !/^\d+$/.test(atomic)) return "0";
  const s = atomic.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function isValidNearRecipient(addr: string): boolean {
  const s = addr.trim();
  if (!s || s.length < 2 || s.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(s)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  try {
    const token =
      window.localStorage.getItem("snowmoon_wallet_token") ||
      window.sessionStorage.getItem("snowmoon_wallet_token") ||
      "";
    if (token) headers["x-wallet-session"] = token;
  } catch {
    // ignore storage errors
  }
  return headers;
}

function formatFriendlyQuoteError(raw: string, token: IntentToken | null): string {
  let msg = raw.replace(/^ERR_1CLICK_QUOTE_HTTP_\d+:\s*/i, "").trim();
  if (msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg) as { message?: string };
      if (parsed.message) msg = parsed.message;
    } catch {
      // keep raw
    }
  }
  const lowMatch = msg.match(/try at least\s+(\d+)/i);
  if (lowMatch && token) {
    const minHuman = formatAtomic(lowMatch[1], token.decimals, 6);
    return `Amount is too low for bridge. Minimum is ${minHuman} ${token.symbol}.`;
  }
  return msg || "Unable to fetch quote. Please try a different amount.";
}

let activeRoot: Root | null = null;
let activeContainer: HTMLElement | null = null;

function SnowMoonBridgeWidget(props: SnowMoonIntentsWidgetOptions) {
  const { nearAccountId, colorScheme = "dark", onQuoteCreated, onTransferSuccess } = props;
  const isDark = colorScheme !== "light";

  const [tokens, setTokens] = useState<IntentToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState<string | null>(null);

  const [selectedToken, setSelectedToken] = useState<IntentToken | null>(null);
  const [amountInput, setAmountInput] = useState<string>("");
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [modalChainFilter, setModalChainFilter] = useState<string>("all");
  const [modalSearch, setModalSearch] = useState<string>("");

  // Connected wallets per ecosystem
  const [evmAddress, setEvmAddress] = useState<string>("");
  const [solanaAddress, setSolanaAddress] = useState<string>("");
  const [sourceBalance, setSourceBalance] = useState<string | null>(null);
  const [nearUsdcBalance, setNearUsdcBalance] = useState<string | null>(null);

  // Optional custom NEAR destination address (Rhea-style checkbox)
  const [useCustomDest, setUseCustomDest] = useState(false);
  const [customDestAddress, setCustomDestAddress] = useState("");

  // Quote & execution state
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [txStatusMsg, setTxStatusMsg] = useState<string | null>(null);
  const [txErrorMsg, setTxErrorMsg] = useState<string | null>(null);
  const [txModal, setTxModal] = useState<{
    open: boolean;
    phase: "pending" | "success" | "error";
    sourceChain: string;
    srcTxHash?: string;
    destTxHash?: string;
    destAccount?: string;
    estSeconds?: number;
    statusText?: string;
  } | null>(null);

  // Load live 1Click supported tokens
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setTokensLoading(true);
        const resp = await fetch("/api/intents/tokens");
        const json = (await resp.json()) as { tokens?: IntentToken[]; error?: string };
        if (!resp.ok) throw new Error(json.error || "Failed to load supported tokens");
        const list = Array.isArray(json.tokens) ? json.tokens : [];
        // Exclude destination NEAR USDC itself from source list to avoid no-op
        const sourceList = list.filter((t) => t.assetId !== NEAR_USDC_ASSET_ID);
        if (!cancelled) {
          setTokens(sourceList);
          const defaultTok =
            sourceList.find((t) => t.symbol === "USDC" && t.blockchain === "base") ||
            sourceList.find((t) => t.symbol === "USDC" && t.blockchain === "eth") ||
            sourceList.find((t) => t.symbol === "ETH" && t.blockchain === "base") ||
            sourceList[0] ||
            null;
          setSelectedToken(defaultTok);
          setTokensError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setTokensError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setTokensLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync already-authorized EVM / Solana accounts passively
  useEffect(() => {
    const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (eth?.request) {
      eth
        .request({ method: "eth_accounts" })
        .then((accs) => {
          if (Array.isArray(accs) && accs[0]) setEvmAddress(String(accs[0]));
        })
        .catch(() => {});
    }
    const sol = (window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider })
      .phantom?.solana || (window as unknown as { solana?: SolanaProvider }).solana;
    if (sol?.isConnected && sol.publicKey) {
      setSolanaAddress(sol.publicKey.toBase58());
    }
  }, []);

  // Load NEAR USDC balance for To card when nearAccountId is connected
  useEffect(() => {
    if (!nearAccountId) {
      setNearUsdcBalance(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/near/account?accountId=${encodeURIComponent(nearAccountId)}`)
      .then((r) => r.json())
      .then((j: { accountState?: { usdcBalanceAtomic?: string } }) => {
        if (!cancelled && j.accountState?.usdcBalanceAtomic !== undefined) {
          setNearUsdcBalance(formatAtomic(j.accountState.usdcBalanceAtomic, 6, 4));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nearAccountId]);

  const sourceKind = selectedToken ? getChainKind(selectedToken.blockchain) : "evm";

  const activeSourceWallet = useMemo(() => {
    if (sourceKind === "near") return nearAccountId || "";
    if (sourceKind === "solana") return solanaAddress;
    if (sourceKind === "evm") return evmAddress;
    return "";
  }, [sourceKind, nearAccountId, solanaAddress, evmAddress]);

  const effectiveDestNear = useMemo(() => {
    if (useCustomDest) return customDestAddress.trim();
    return nearAccountId || "";
  }, [useCustomDest, customDestAddress, nearAccountId]);

  // Fetch source balance via official chain RPCs (works regardless of active wallet network)
  useEffect(() => {
    setSourceBalance(null);
    if (!selectedToken || !activeSourceWallet) return;
    let cancelled = false;
    const chainKey = selectedToken.blockchain.toLowerCase();

    if (sourceKind === "evm") {
      const rpcUrl = EVM_RPC_URLS[chainKey];
      if (!rpcUrl) return;
      (async () => {
        try {
          const callRpc = async (method: string, params: unknown[]) => {
            const resp = await fetch(rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            const json = (await resp.json()) as { result?: string };
            return json.result;
          };
          if (!selectedToken.contractAddress) {
            const hexBal = await callRpc("eth_getBalance", [activeSourceWallet, "latest"]);
            if (!cancelled && hexBal) {
              setSourceBalance(formatAtomic(BigInt(hexBal).toString(), selectedToken.decimals, 5));
            }
          } else {
            const data = encodeFunctionData({
              abi: ERC20_TRANSFER_ABI,
              functionName: "balanceOf",
              args: [activeSourceWallet as `0x${string}`],
            });
            const hexRes = await callRpc("eth_call", [
              { to: selectedToken.contractAddress, data },
              "latest",
            ]);
            if (!cancelled && hexRes && hexRes !== "0x") {
              setSourceBalance(formatAtomic(BigInt(hexRes).toString(), selectedToken.decimals, 4));
            }
          }
        } catch {
          // Non-fatal
        }
      })();
    } else if (sourceKind === "solana") {
      (async () => {
        try {
          if (!selectedToken.contractAddress) {
            const resp = await fetch(SOLANA_RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getBalance",
                params: [activeSourceWallet],
              }),
            });
            const json = (await resp.json()) as { result?: { value?: number } };
            if (!cancelled && json.result?.value !== undefined) {
              setSourceBalance(formatAtomic(String(json.result.value), selectedToken.decimals, 4));
            }
          } else {
            const resp = await fetch(SOLANA_RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenAccountsByOwner",
                params: [
                  activeSourceWallet,
                  { mint: selectedToken.contractAddress },
                  { encoding: "jsonParsed" },
                ],
              }),
            });
            const json = (await resp.json()) as {
              result?: {
                value?: Array<{
                  account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmountString?: string } } } } };
                }>;
              };
            };
            const uiAmt =
              json.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? "0";
            if (!cancelled) setSourceBalance(uiAmt);
          }
        } catch {
          // Non-fatal
        }
      })();
    } else if (sourceKind === "near") {
      (async () => {
        try {
          if (!selectedToken.contractAddress || selectedToken.symbol.toUpperCase() === "NEAR") {
            const resp = await fetch(`/api/near/account?accountId=${encodeURIComponent(activeSourceWallet)}`);
            const json = (await resp.json()) as { accountState?: { amountNear?: string } };
            if (!cancelled && json.accountState?.amountNear !== undefined) {
              setSourceBalance(json.accountState.amountNear);
            }
          } else {
            const resp = await fetch("/api/intents/widget-api/rpc/snowmoon", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "1",
                method: "query",
                params: {
                  request_type: "call_function",
                  finality: "final",
                  account_id: selectedToken.contractAddress,
                  method_name: "ft_balance_of",
                  args_base64: btoa(JSON.stringify({ account_id: activeSourceWallet })),
                },
              }),
            });
            const json = (await resp.json()) as { result?: { result?: number[] } };
            if (!cancelled && Array.isArray(json.result?.result)) {
              const rawStr = String.fromCharCode(...json.result.result);
              const atomic = JSON.parse(rawStr) as string;
              setSourceBalance(formatAtomic(atomic, selectedToken.decimals, 4));
            }
          }
        } catch {
          // Non-fatal
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [selectedToken, activeSourceWallet, sourceKind]);

  const connectSourceWallet = useCallback(async (kindOverride?: "evm" | "near" | "solana" | "other") => {
    const kind = kindOverride || sourceKind;
    setTxErrorMsg(null);
    if (kind === "near") {
      const openModal = (window as unknown as { openWalletModal?: () => void }).openWalletModal;
      if (openModal) openModal();
      return;
    }
    if (kind === "solana") {
      const sol =
        (window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider }).phantom
          ?.solana || (window as unknown as { solana?: SolanaProvider }).solana;
      if (!sol) {
        setTxErrorMsg("No Solana wallet extension (e.g. Phantom) detected in this browser.");
        return;
      }
      try {
        const res = await sol.connect();
        setSolanaAddress(res.publicKey.toBase58());
      } catch (err) {
        setTxErrorMsg(err instanceof Error ? err.message : "Solana wallet connection cancelled.");
      }
      return;
    }
    if (kind === "evm") {
      const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth?.request) {
        setTxErrorMsg("No EVM wallet extension (e.g. MetaMask / Rabby) detected in this browser.");
        return;
      }
      try {
        const accs = await eth.request({ method: "eth_requestAccounts" });
        if (Array.isArray(accs) && accs[0]) {
          setEvmAddress(String(accs[0]));
        }
      } catch (err) {
        setTxErrorMsg(err instanceof Error ? err.message : "EVM wallet connection cancelled.");
      }
    }
  }, [sourceKind]);

  const connectNearWallet = useCallback(() => {
    const openModal = (window as unknown as { openWalletModal?: () => void }).openWalletModal;
    if (openModal) openModal();
  }, []);

  const disconnectSourceWallet = useCallback(() => {
    if (sourceKind === "evm") {
      setEvmAddress(null);
      setSourceBalance(null);
    } else if (sourceKind === "solana") {
      const sol = (window as unknown as { solana?: { disconnect?: () => Promise<void> } }).solana;
      sol?.disconnect?.().catch(() => {});
      setSolAddress(null);
      setSourceBalance(null);
    } else if (sourceKind === "near") {
      const disc = (window as unknown as { disconnectWalletSession?: () => void }).disconnectWalletSession;
      if (disc) disc();
    }
  }, [sourceKind]);

  const disconnectNearWallet = useCallback(() => {
    const disc = (window as unknown as { disconnectWalletSession?: () => void }).disconnectWalletSession;
    if (disc) disc();
  }, []);

  // Safe non-financial dry quote preview whenever token/amount/recipient changes
  const fetchDryQuote = useCallback(async () => {
    if (!selectedToken) return;
    const atomic = toAtomicString(amountInput, selectedToken.decimals);
    if (!atomic) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const recipient = isValidNearRecipient(effectiveDestNear)
      ? effectiveDestNear
      : "core.cryptozax.near";
    const refundTo =
      activeSourceWallet ||
      (sourceKind === "near"
        ? "core.cryptozax.near"
        : sourceKind === "solana"
          ? "11111111111111111111111111111111"
          : "0x0000000000000000000000000000000000000001");

    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const resp = await fetch("/api/intents/widget-quote", {
        method: "POST",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          dry: true,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: selectedToken.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: NEAR_USDC_ASSET_ID,
          amount: atomic,
          refundTo,
          refundType: "ORIGIN_CHAIN",
          recipient,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
      });
      const json = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        quote?: QuotePreview;
      };
      if (!resp.ok || !json.ok || !json.quote) {
        throw new Error(json.error || "Could not fetch quote");
      }
      setQuote(json.quote);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      setQuote(null);
      setQuoteError(formatFriendlyQuoteError(rawMsg, selectedToken));
    } finally {
      setQuoteLoading(false);
    }
  }, [selectedToken, amountInput, effectiveDestNear, activeSourceWallet, sourceKind]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchDryQuote();
    }, 350);
    return () => clearTimeout(timer);
  }, [fetchDryQuote]);

  // Execute live swap via native wallet popup (EVM / Solana / NEAR)
  const handleBridgeExecute = async () => {
    if (!selectedToken) return;
    setTxErrorMsg(null);
    setTxStatusMsg(null);

    if (!activeSourceWallet && sourceKind !== "other") {
      await connectSourceWallet();
      return;
    }
    if (!effectiveDestNear || !isValidNearRecipient(effectiveDestNear)) {
      if (!useCustomDest) {
        connectNearWallet();
      } else {
        setTxErrorMsg("Enter a valid NEAR destination account (e.g. alice.near).");
      }
      return;
    }
    const atomic = toAtomicString(amountInput, selectedToken.decimals);
    if (!atomic) {
      setTxErrorMsg("Enter a valid amount greater than 0.");
      return;
    }

    setSubmitting(true);
    try {
      // Step 1: Request committed 1Click quote (dry: false)
      setTxStatusMsg("Requesting 1Click deposit quote...");
      const qResp = await fetch("/api/intents/widget-quote", {
        method: "POST",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          dry: false,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: selectedToken.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: NEAR_USDC_ASSET_ID,
          amount: atomic,
          refundTo: activeSourceWallet || effectiveDestNear,
          refundType: "ORIGIN_CHAIN",
          recipient: effectiveDestNear,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
      });
      const qJson = (await qResp.json()) as {
        ok?: boolean;
        error?: string;
        quote?: QuotePreview;
        record?: Record<string, unknown> | null;
      };
      if (!qResp.ok || !qJson.ok || !qJson.quote?.depositAddress) {
        throw new Error(qJson.error || "Failed to obtain 1Click deposit address.");
      }

      const liveQuote = qJson.quote;
      const depositAddress = liveQuote.depositAddress!;
      setQuote(liveQuote);
      onQuoteCreated?.({
        dry: false,
        quote: liveQuote as unknown as Record<string, unknown>,
        record: qJson.record || null,
      });

      // Step 2: Sign deposit tx in the native source-chain wallet ONLY
      let txHash = "";
      if (sourceKind === "evm") {
        const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
        if (!eth?.request) throw new Error("EVM wallet not connected.");
        const targetChainId = EVM_CHAIN_IDS[selectedToken.blockchain.toLowerCase()];
        const currentChainHex = String(await eth.request({ method: "eth_chainId" }));
        if (targetChainId && parseInt(currentChainHex, 16) !== targetChainId) {
          setTxStatusMsg(`Switching EVM wallet to ${formatChainName(selectedToken.blockchain)}...`);
          await eth.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${targetChainId.toString(16)}` }],
          });
        }
        setTxStatusMsg("Approve deposit transaction in your EVM wallet...");
        if (!selectedToken.contractAddress) {
          txHash = String(
            await eth.request({
              method: "eth_sendTransaction",
              params: [
                {
                  from: activeSourceWallet,
                  to: depositAddress,
                  value: `0x${BigInt(liveQuote.amountIn || atomic).toString(16)}`,
                },
              ],
            })
          );
        } else {
          const data = encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: "transfer",
            args: [depositAddress as `0x${string}`, BigInt(liveQuote.amountIn || atomic)],
          });
          txHash = String(
            await eth.request({
              method: "eth_sendTransaction",
              params: [
                {
                  from: activeSourceWallet,
                  to: selectedToken.contractAddress,
                  data,
                },
              ],
            })
          );
        }
      } else if (sourceKind === "near") {
        const selector = (
          window as unknown as {
            SnowMoonWalletSelector?: {
              signAndSendTransactions: (args: unknown) => Promise<Array<{ transaction?: { hash?: string } }>>;
            };
          }
        ).SnowMoonWalletSelector;
        if (!selector) throw new Error("NEAR Wallet Selector not ready.");
        setTxStatusMsg("Approve deposit transaction in your NEAR wallet...");
        const actions = selectedToken.contractAddress
          ? [
              {
                type: "FunctionCall",
                params: {
                  methodName: "ft_transfer",
                  args: {
                    receiver_id: depositAddress,
                    amount: liveQuote.amountIn || atomic,
                  },
                  gas: "30000000000000",
                  deposit: "1",
                },
              },
            ]
          : [
              {
                type: "Transfer",
                params: { deposit: liveQuote.amountIn || atomic },
              },
            ];
        const res = await selector.signAndSendTransactions({
          transactions: [
            {
              signerId: activeSourceWallet,
              receiverId: selectedToken.contractAddress || depositAddress,
              actions,
            },
          ],
        });
        txHash = res?.[0]?.transaction?.hash || "";
      } else {
        throw new Error(
          `Direct one-click signing for ${formatChainName(selectedToken.blockchain)} is not supported in browser. Use Activity & Manual Recovery below.`
        );
      }

      if (!txHash) throw new Error("Wallet did not return a transaction hash.");

      // Step 3: Notify 1Click + SnowMoon backend of source deposit txHash
      setTxStatusMsg(null);
      setTxModal({
        open: true,
        phase: "pending",
        sourceChain: selectedToken.blockchain,
        srcTxHash: txHash,
        destAccount: effectiveDestNear,
        estSeconds: liveQuote.timeEstimate || 35,
        statusText: `Est. Bridging Time: ~${liveQuote.timeEstimate || 35}s`,
      });

      await fetch("/api/intents/deposit-submit", {
        method: "POST",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          depositAddress,
          txHash,
          customerNearAccount: effectiveDestNear,
        }),
      }).catch(() => {});

      onTransferSuccess?.({ hash: txHash, depositAddress });

      // Poll 1Click status for the Transaction Detail modal
      let attempts = 0;
      const pollTimer = setInterval(async () => {
        attempts += 1;
        try {
          const stResp = await fetch(`/api/intents/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
            headers: buildAuthHeaders(),
          });
          const stJson = (await stResp.json()) as {
            record?: {
              status?: string;
              destinationTxHash?: string;
              swapDetails?: { destinationChainTxHashes?: Array<{ hash?: string }> };
            };
          };
          const status = stJson.record?.status || "";
          if (status === "SUCCESS") {
            clearInterval(pollTimer);
            const destHash =
              stJson.record?.destinationTxHash ||
              stJson.record?.swapDetails?.destinationChainTxHashes?.[0]?.hash;
            setTxModal((prev) =>
              prev
                ? {
                    ...prev,
                    phase: "success",
                    destTxHash: destHash,
                    statusText: "Bridge Completed",
                  }
                : null
            );
          } else if (status === "FAILED" || status === "REFUNDED" || status === "INCOMPLETE_DEPOSIT") {
            clearInterval(pollTimer);
            setTxModal((prev) =>
              prev
                ? {
                    ...prev,
                    phase: "error",
                    statusText:
                      status === "REFUNDED"
                        ? "Transfer refunded to your source wallet."
                        : "Transfer could not be completed. 1Click will refund your source wallet.",
                  }
                : null
            );
          }
        } catch {
          // Keep polling
        }
        if (attempts >= 45) clearInterval(pollTimer);
      }, 3000);
    } catch (err) {
      setTxErrorMsg(err instanceof Error ? err.message : String(err));
      setTxStatusMsg(null);
    } finally {
      setSubmitting(false);
    }
  };

  // Chains list for Rhea-style Two-Pane Asset Modal
  const availableChains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tokens) {
      const k = t.blockchain.toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [tokens]);

  const filteredModalTokens = useMemo(() => {
    const q = modalSearch.trim().toLowerCase();
    return tokens.filter((t) => {
      if (modalChainFilter !== "all" && t.blockchain.toLowerCase() !== modalChainFilter) {
        return false;
      }
      if (!q) return true;
      return (
        t.symbol.toLowerCase().includes(q) ||
        t.blockchain.toLowerCase().includes(q) ||
        formatChainName(t.blockchain).toLowerCase().includes(q)
      );
    });
  }, [tokens, modalChainFilter, modalSearch]);

  const bgCard = "var(--panel, #13131b)";
  const bgInner = "var(--panel-2, #1b1b26)";
  const borderCol = "var(--border, rgba(16, 185, 129, 0.18))";
  const textMain = "var(--text, #f4f4fa)";
  const textMuted = "var(--muted, #9c9cb4)";
  const accent = "var(--text, #09090b)";

  const expectedOutFormatted = quote?.amountOutFormatted || "0";
  const rateDisplay = useMemo(() => {
    if (!selectedToken || !quote) return null;
    const inNum = Number(quote.amountInFormatted || amountInput);
    const outNum = Number(quote.amountOutFormatted || 0);
    if (!inNum || !outNum) return null;
    return `1 ${selectedToken.symbol} ≈ ${(outNum / inNum).toFixed(4)} USDC`;
  }, [selectedToken, quote, amountInput]);

  const primaryBtnLabel = useMemo(() => {
    if (submitting) return "Confirming in Wallet...";
    if (!activeSourceWallet && sourceKind !== "other") {
      const label = sourceKind === "evm" ? "EVM" : sourceKind === "solana" ? "Solana" : "NEAR";
      return `Connect ${label} Wallet`;
    }
    if (!effectiveDestNear) return "Connect NEAR Wallet";
    if (!amountInput || Number(amountInput) <= 0) return "Enter Amount";
    if (quoteLoading) return "Fetching Quote...";
    if (quoteError) return "Retry Quote";
    return "Bridge to NEAR USDC";
  }, [submitting, activeSourceWallet, sourceKind, effectiveDestNear, amountInput, quoteLoading, quoteError]);

  return (
    <div
      style={{
        background: bgCard,
        border: `1px solid ${borderCol}`,
        borderRadius: "18px",
        padding: "18px",
        color: textMain,
        fontFamily: "inherit",
        position: "relative",
      }}
    >
      {/* Top-right Refresh Icon */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          marginBottom: "10px",
        }}
      >
        <button
          type="button"
          title="Refresh quote"
          aria-label="Refresh quote"
          onClick={() => void fetchDryQuote()}
          disabled={quoteLoading}
          style={{
            background: "transparent",
            border: "none",
            color: textMuted,
            padding: "4px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: quoteLoading ? "wait" : "pointer",
            opacity: quoteLoading ? 0.5 : 0.85,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>

      {tokensError && (
        <div
          style={{
            color: "var(--neg, #dc2626)",
            fontSize: "12.5px",
            fontWeight: 500,
            lineHeight: 1.45,
            marginBottom: "10px",
          }}
        >
          {tokensError}
        </div>
      )}

      {/* FROM CARD */}
      <div
        style={{
          background: bgInner,
          border: `1px solid ${borderCol}`,
          borderRadius: "14px",
          padding: "14px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <span style={{ fontSize: "12px", fontWeight: 600, color: textMuted }}>From</span>
          {sourceKind !== "other" && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <button
                type="button"
                onClick={() => void connectSourceWallet()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "transparent",
                  border: "none",
                  color: activeSourceWallet ? textMain : accent,
                  padding: "2px 4px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <ChainLogo blockchain={selectedToken?.blockchain || sourceKind} size={15} />
                <span>
                  {activeSourceWallet ? shortAddr(activeSourceWallet) : "Connect"}
                </span>
              </button>
              {activeSourceWallet && (
                <button
                  type="button"
                  title="Disconnect source wallet"
                  aria-label="Disconnect source wallet"
                  onClick={disconnectSourceWallet}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "20px",
                    height: "20px",
                    padding: 0,
                    background: "transparent",
                    border: "none",
                    borderRadius: "9999px",
                    color: textMuted,
                    cursor: "pointer",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <button
            type="button"
            onClick={() => setAssetModalOpen(true)}
            disabled={tokensLoading}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              background: "transparent",
              border: "none",
              padding: "4px 6px 4px 0",
              color: textMain,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {selectedToken ? (
              <TokenWithChainIcon
                symbol={selectedToken.symbol}
                blockchain={selectedToken.blockchain}
                size={32}
                ringColor={bgInner}
              />
            ) : null}
            <span style={{ fontWeight: 700, fontSize: "16px" }}>
              {tokensLoading ? "Loading..." : selectedToken?.symbol || "Select"}
            </span>
            {selectedToken && (
              <span style={{ fontSize: "13px", fontWeight: 500, color: textMuted }}>
                {formatChainName(selectedToken.blockchain)}
              </span>
            )}
            <span style={{ fontSize: "12px", color: textMuted }}>▾</span>
          </button>

          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              color: textMain,
              fontSize: "24px",
              fontWeight: 700,
              textAlign: "right",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "8px",
            fontSize: "11px",
            color: textMuted,
          }}
        >
          <span>
            Balance: {sourceBalance !== null ? `${sourceBalance} ${selectedToken?.symbol || ""}` : "—"}
          </span>
          <span>
            {quote?.amountInUsd
              ? `~$${Number(quote.amountInUsd).toFixed(2)}`
              : selectedToken?.price && Number(amountInput) > 0
                ? `~$${(Number(amountInput) * selectedToken.price).toFixed(2)}`
                : "$0.00"}
          </span>
        </div>
      </div>

      {/* CENTER DIRECTION DIVIDER */}
      <div style={{ display: "flex", justifyContent: "center", margin: "-10px 0", position: "relative", zIndex: 2 }}>
        <div
          style={{
            width: "30px",
            height: "30px",
            borderRadius: "10px",
            background: bgCard,
            border: `1px solid ${borderCol}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            color: accent,
            fontWeight: 700,
          }}
        >
          ↓
        </div>
      </div>

      {/* TO CARD (Locked to NEAR Mainnet USDC) */}
      <div
        style={{
          background: bgInner,
          border: `1px solid ${borderCol}`,
          borderRadius: "14px",
          padding: "14px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <span style={{ fontSize: "12px", fontWeight: 600, color: textMuted }}>To</span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <button
              type="button"
              onClick={connectNearWallet}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "transparent",
                border: "none",
                color: nearAccountId ? textMain : accent,
                padding: "2px 4px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <ChainLogo blockchain="near" size={15} />
              <span>{nearAccountId ? shortAddr(nearAccountId) : "Connect"}</span>
            </button>
            {nearAccountId && (
              <button
                type="button"
                title="Disconnect NEAR wallet"
                aria-label="Disconnect NEAR wallet"
                onClick={disconnectNearWallet}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "20px",
                  height: "20px",
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  borderRadius: "9999px",
                  color: textMuted,
                  cursor: "pointer",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "4px 6px 4px 0",
              flexShrink: 0,
            }}
          >
            <TokenWithChainIcon
              symbol="USDC"
              blockchain="near"
              size={32}
              ringColor={bgInner}
            />
            <span style={{ fontWeight: 700, fontSize: "16px" }}>USDC</span>
            <span style={{ fontSize: "13px", fontWeight: 500, color: textMuted }}>NEAR</span>
          </div>

          <div
            style={{
              fontSize: "24px",
              fontWeight: 700,
              textAlign: "right",
              color: quoteLoading ? textMuted : textMain,
            }}
          >
            {quoteLoading ? (
              <span
                className="skeleton"
                style={{ width: "84px", height: "24px", borderRadius: "8px", display: "inline-block" }}
              />
            ) : (
              expectedOutFormatted
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "8px",
            fontSize: "11px",
            color: textMuted,
          }}
        >
          <span>Balance: {nearUsdcBalance !== null ? `${nearUsdcBalance} USDC` : "—"}</span>
          <span>{quote?.amountOutUsd ? `~$${Number(quote.amountOutUsd).toFixed(2)}` : "$0.00"}</span>
        </div>
      </div>

      {/* RHEA-STYLE OPTIONAL DESTINATION CHECKBOX */}
      <div style={{ marginTop: "12px" }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "12px",
            color: textMuted,
            cursor: "pointer",
            userSelect: "none",
            width: "auto",
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          <input
            type="checkbox"
            checked={useCustomDest}
            onChange={(e) => setUseCustomDest(e.target.checked)}
            style={{
              accentColor: accent,
              cursor: "pointer",
              width: "14px",
              height: "14px",
              flexShrink: 0,
              margin: 0,
            }}
          />
          <span>I&apos;m transferring to a different NEAR address</span>
        </label>

        {useCustomDest && (
          <div
            style={{
              marginTop: "8px",
              display: "flex",
              gap: "6px",
              alignItems: "center",
              background: bgInner,
              border: `1px solid ${borderCol}`,
              borderRadius: "10px",
              padding: "6px 10px",
            }}
          >
            <input
              type="text"
              placeholder="Enter destination NEAR account (e.g. alice.near)"
              value={customDestAddress}
              onChange={(e) => setCustomDestAddress(e.target.value)}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: textMain,
                fontSize: "12px",
              }}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const txt = await navigator.clipboard.readText();
                  if (txt) setCustomDestAddress(txt.trim());
                } catch {
                  // Clipboard permission denied
                }
              }}
              style={{
                background: "rgba(155,152,232,0.16)",
                border: "none",
                borderRadius: "6px",
                color: accent,
                padding: "4px 8px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Paste
            </button>
          </div>
        )}
      </div>

      {/* LIVE QUOTE DETAILS */}
      {(rateDisplay || quote) && (
        <div
          style={{
            marginTop: "12px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: bgInner,
            border: `1px solid ${borderCol}`,
            fontSize: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: textMuted }}>Rate</span>
            <span>{rateDisplay || "—"}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: textMuted }}>Min. Received (1% slippage)</span>
            <span>{quote?.minAmountOut ? `${formatAtomic(quote.minAmountOut, 6, 4)} USDC` : "—"}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: textMuted }}>Est. Arrival</span>
            <span>{quote?.timeEstimate ? `~${quote.timeEstimate}s` : "~20s"}</span>
          </div>
        </div>
      )}

      {quoteError && (
        <div
          style={{
            marginTop: "10px",
            color: "var(--neg, #dc2626)",
            fontSize: "12.5px",
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          {quoteError}
        </div>
      )}

      {txErrorMsg && (
        <div
          style={{
            marginTop: "10px",
            color: "var(--neg, #dc2626)",
            fontSize: "12.5px",
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          {txErrorMsg}
        </div>
      )}

      {txStatusMsg && (
        <div
          style={{
            marginTop: "10px",
            color: isDark ? "#60a5fa" : "#2563eb",
            fontSize: "12.5px",
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          {txStatusMsg}
        </div>
      )}

      {/* PRIMARY CTA */}
      <button
        type="button"
        disabled={submitting || quoteLoading}
        onClick={() => {
          if (quoteError) {
            void fetchDryQuote();
          } else {
            void handleBridgeExecute();
          }
        }}
        style={{
          marginTop: "14px",
          width: "100%",
          padding: "13px 18px",
          borderRadius: "9999px",
          border: "1px solid var(--accent-btn-border, rgba(9, 9, 11, 0.10))",
          background: "var(--accent-grad, linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(244, 244, 247, 0.92) 100%))",
          color: "var(--on-accent, #09090b)",
          boxShadow: "var(--accent-btn-shadow, 0 2px 8px rgba(9, 9, 11, 0.08))",
          backdropFilter: "blur(12px)",
          fontWeight: 700,
          fontSize: "14px",
          cursor: submitting ? "wait" : "pointer",
          opacity: submitting ? 0.75 : 1,
        }}
      >
        {primaryBtnLabel}
      </button>

      {/* RHEA-STYLE TWO-PANE CROSS-CHAIN ASSETS MODAL */}
      {assetModalOpen && (
        <div
          onClick={() => setAssetModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.22)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "660px",
              maxHeight: "520px",
              background: bgCard,
              border: `1px solid ${borderCol}`,
              borderRadius: "18px",
              boxShadow: "0 20px 50px rgba(0,0,0,0.16)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: `1px solid ${borderCol}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong style={{ fontSize: "15px" }}>Cross-chain Assets</strong>
              <button
                type="button"
                onClick={() => setAssetModalOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: textMuted,
                  fontSize: "18px",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", flex: 1, minHeight: 0 }}>
              {/* Left Pane: Networks */}
              <div
                style={{
                  borderRight: `1px solid ${borderCol}`,
                  padding: "12px",
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div style={{ fontSize: "11px", color: textMuted, fontWeight: 600, marginBottom: "4px" }}>
                  Select Network
                </div>
                <button
                  type="button"
                  onClick={() => setModalChainFilter("all")}
                  style={{
                    textAlign: "left",
                    padding: "7px 10px",
                    borderRadius: "8px",
                    border: "none",
                    background: modalChainFilter === "all" ? "rgba(155,152,232,0.22)" : "transparent",
                    color: modalChainFilter === "all" ? accent : textMain,
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  All Networks ({tokens.length})
                </button>
                {availableChains.map(([chain, count]) => (
                  <button
                    key={chain}
                    type="button"
                    onClick={() => setModalChainFilter(chain)}
                    style={{
                      textAlign: "left",
                      padding: "7px 10px",
                      borderRadius: "8px",
                      border: "none",
                      background: modalChainFilter === chain ? "rgba(155,152,232,0.22)" : "transparent",
                      color: modalChainFilter === chain ? accent : textMain,
                      fontSize: "12px",
                      fontWeight: 500,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      <ChainLogo blockchain={chain} size={16} />
                      <span>{formatChainName(chain)}</span>
                    </span>
                    <span style={{ color: textMuted, fontSize: "11px" }}>{count}</span>
                  </button>
                ))}
              </div>

              {/* Right Pane: Search + Tokens */}
              <div style={{ padding: "12px", display: "flex", flexDirection: "column", minHeight: 0 }}>
                <input
                  type="text"
                  placeholder="Search tokens by symbol or chain..."
                  value={modalSearch}
                  onChange={(e) => setModalSearch(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: "10px",
                    border: `1px solid ${borderCol}`,
                    background: bgInner,
                    color: textMain,
                    fontSize: "12px",
                    outline: "none",
                    marginBottom: "10px",
                    boxSizing: "border-box",
                  }}
                />

                <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                  {filteredModalTokens.slice(0, 80).map((t) => {
                    const active = selectedToken?.assetId === t.assetId;
                    return (
                      <button
                        key={t.assetId}
                        type="button"
                        onClick={() => {
                          setSelectedToken(t);
                          setQuote(null);
                          setQuoteError(null);
                          setAssetModalOpen(false);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "9px 10px",
                          borderRadius: "10px",
                          border: active ? `1px solid ${accent}` : "1px solid transparent",
                          background: active ? "rgba(155,152,232,0.14)" : "transparent",
                          color: textMain,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <TokenWithChainIcon
                            symbol={t.symbol}
                            blockchain={t.blockchain}
                            size={28}
                            ringColor={bgCard}
                          />
                          <div>
                            <div style={{ fontWeight: 700, fontSize: "13px" }}>{t.symbol}</div>
                            <div style={{ fontSize: "11px", color: textMuted }}>
                              {formatChainName(t.blockchain)}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: "12px" }}>
                            {t.price ? `$${Number(t.price).toFixed(2)}` : "—"}
                          </div>
                          {active && <div style={{ fontSize: "10px", color: accent }}>Selected</div>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RHEA-STYLE TRANSACTION DETAIL PROGRESS MODAL */}
      {txModal?.open && (
        <div
          onClick={() => setTxModal((prev) => (prev ? { ...prev, open: false } : null))}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.68)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "420px",
              background: bgCard,
              border: `1px solid ${borderCol}`,
              borderRadius: "18px",
              padding: "20px",
              color: textMain,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "22px",
              }}
            >
              <strong style={{ fontSize: "15px" }}>Transaction Detail</strong>
              <button
                type="button"
                onClick={() => setTxModal((prev) => (prev ? { ...prev, open: false } : null))}
                style={{
                  background: "transparent",
                  border: "none",
                  color: textMuted,
                  fontSize: "18px",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            {/* Chain -> Status -> NEAR Visual */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                marginBottom: "18px",
              }}
            >
              <ChainLogo blockchain={txModal.sourceChain} size={30} />
              <span style={{ color: textMuted, letterSpacing: "4px", fontSize: "14px" }}>····</span>
              {txModal.phase === "success" ? (
                <span
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "50%",
                    border: "2px solid #34d399",
                    color: "#34d399",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "20px",
                    fontWeight: 700,
                  }}
                >
                  ✓
                </span>
              ) : txModal.phase === "error" ? (
                <span
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "50%",
                    border: "2px solid #f87171",
                    color: "#f87171",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "20px",
                    fontWeight: 700,
                  }}
                >
                  !
                </span>
              ) : (
                <>
                  <style>{`@keyframes smSpin { to { transform: rotate(360deg); } }`}</style>
                  <span
                    style={{
                      width: "44px",
                      height: "44px",
                      borderRadius: "50%",
                      border: "2.5px solid rgba(155, 152, 232, 0.2)",
                      borderTopColor: accent,
                      display: "inline-block",
                      boxSizing: "border-box",
                      animation: "smSpin 0.85s linear infinite",
                    }}
                  />
                </>
              )}
              <span style={{ color: textMuted, letterSpacing: "4px", fontSize: "14px" }}>····</span>
              <ChainLogo blockchain="near" size={30} />
            </div>

            <div style={{ textAlign: "center", fontSize: "14px", fontWeight: 600, marginBottom: "16px" }}>
              {txModal.statusText || "Processing bridge transfer..."}
            </div>

            <div style={{ display: "flex", justifyContent: "center", gap: "10px", marginBottom: "14px" }}>
              {txModal.srcTxHash && EXPLORER_TX_URLS[txModal.sourceChain.toLowerCase()] && (
                <a
                  href={`${EXPLORER_TX_URLS[txModal.sourceChain.toLowerCase()]}${txModal.srcTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: "6px 12px",
                    borderRadius: "8px",
                    border: `1px solid ${borderCol}`,
                    background: bgInner,
                    color: textMain,
                    fontSize: "12px",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  SRC TX ↗
                </a>
              )}
              {txModal.phase === "success" && (
                <a
                  href={
                    txModal.destTxHash
                      ? `https://nearblocks.io/txns/${txModal.destTxHash}`
                      : `https://nearblocks.io/address/${txModal.destAccount || ""}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: "6px 12px",
                    borderRadius: "8px",
                    border: `1px solid ${borderCol}`,
                    background: bgInner,
                    color: textMain,
                    fontSize: "12px",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  DEST TX ↗
                </a>
              )}
            </div>

            {txModal.phase !== "pending" && (
              <button
                type="button"
                onClick={() => {
                  setTxModal(null);
                  setAmountInput("");
                  setQuote(null);
                }}
                style={{
                  width: "100%",
                  padding: "11px 14px",
                  borderRadius: "10px",
                  border: `1px solid ${borderCol}`,
                  background: bgInner,
                  color: textMain,
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                + New Transfer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function mountIntentsWidget(containerId: string, options: SnowMoonIntentsWidgetOptions) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!activeRoot || activeContainer !== el) {
    if (activeRoot) {
      activeRoot.unmount();
    }
    activeRoot = createRoot(el);
    activeContainer = el;
  }
  activeRoot.render(<SnowMoonBridgeWidget {...options} />);
}

export function unmountIntentsWidget() {
  if (activeRoot) {
    activeRoot.unmount();
    activeRoot = null;
    activeContainer = null;
  }
}

(window as unknown as Record<string, unknown>).SnowMoonIntentsWidget = {
  mount: mountIntentsWidget,
  unmount: unmountIntentsWidget,
};
