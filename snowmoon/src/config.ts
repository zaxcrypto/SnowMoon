import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env` from the repository root if present without overriding existing process.env variables.
 */
export function loadEnvFile(envPath?: string): void {
  const resolved = envPath ?? path.resolve(process.cwd(), "..", ".env");
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    resolved,
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    break;
  }
}

export interface SnowMoonConfig {
  port: number;
  host: string;
  stateFile: string;
  network: "sandbox" | "testnet" | "mainnet";
  chainMode: "sandbox" | "rpc";
  nearRpcUrl: string;
  coreContractId: string;
  auditContractId: string;
  usdcContractId: string;
  adminAccountId: string;
  customerAccountId: string;
  operatorAccountId: string;
  lpAccountId: string;
  aiMode: "near_ai" | "mock";
  nearAiBaseUrl: string;
  nearAiModel: string;
  hasNearAiKey: boolean;
  walletMode: "outlayer" | "mock";
  outlayerBaseUrl: string;
  hasOutlayerKey: boolean;
  autoApproveLimitUsdc: bigint;
  // Strictly server-side secrets (never serialized to client responses)
  secrets: {
    nearAiApiKey: string;
    outlayerApiKey: string;
    operatorPrivateKey: string;
    adminPrivateKey: string;
  };
}

export function loadConfig(): SnowMoonConfig {
  loadEnvFile();

  const port = Number(process.env.SNOWMOON_PORT || "8090");
  const host = process.env.SNOWMOON_HOST || "127.0.0.1";
  const stateFile =
    process.env.SNOWMOON_STATE_FILE ||
    path.resolve(process.cwd(), ".snowmoon-state.json");

  const rawNet = (process.env.SNOWMOON_NETWORK || "sandbox").toLowerCase();
  const network: "sandbox" | "testnet" | "mainnet" =
    rawNet === "testnet"
      ? "testnet"
      : rawNet === "mainnet"
      ? "mainnet"
      : "sandbox";

  const rawChain = (process.env.SNOWMOON_CHAIN_MODE || "sandbox").toLowerCase();
  const chainMode: "sandbox" | "rpc" = rawChain === "rpc" ? "rpc" : "sandbox";

  const defaultRpc =
    network === "testnet"
      ? process.env.NEAR_TESTNET_RPC_URL || "https://rpc.testnet.near.org"
      : network === "mainnet"
      ? process.env.NEAR_MAINNET_RPC_URL || "https://rpc.mainnet.near.org"
      : process.env.NEAR_SANDBOX_RPC_URL || "http://127.0.0.1:3030";

  const nearRpcUrl = process.env.SNOWMOON_NEAR_RPC_URL || defaultRpc;

  const nearAiApiKey = (process.env.NEAR_AI_API_KEY || "").trim();
  const rawAiMode = (process.env.SNOWMOON_AI_MODE || "auto").toLowerCase();
  const aiMode: "near_ai" | "mock" =
    rawAiMode === "near_ai" || (rawAiMode === "auto" && nearAiApiKey.length > 0)
      ? "near_ai"
      : "mock";

  const outlayerApiKey = (process.env.OUTLAYER_API_KEY || "").trim();
  const rawWalletMode = (process.env.SNOWMOON_WALLET_MODE || "auto").toLowerCase();
  const walletMode: "outlayer" | "mock" =
    rawWalletMode === "outlayer" ||
    (rawWalletMode === "auto" && outlayerApiKey.length > 0)
      ? "outlayer"
      : "mock";

  const autoApproveLimitUsdc = BigInt(
    process.env.SNOWMOON_AUTO_APPROVE_LIMIT_USDC || "100000"
  );

  return {
    port,
    host,
    stateFile,
    network,
    chainMode,
    nearRpcUrl,
    coreContractId:
      process.env.SNOWMOON_CORE_CONTRACT_ID || "snowmoon-core.test.near",
    auditContractId:
      process.env.SNOWMOON_AUDIT_CONTRACT_ID || "snowmoon-audit.test.near",
    usdcContractId:
      process.env.SNOWMOON_USDC_CONTRACT_ID || "usdc.test.near",
    adminAccountId:
      process.env.SNOWMOON_ADMIN_ACCOUNT_ID || "admin.snowmoon.test.near",
    customerAccountId:
      process.env.SNOWMOON_CUSTOMER_ACCOUNT_ID || "customer.snowmoon.test.near",
    operatorAccountId:
      process.env.SNOWMOON_OPERATOR_ACCOUNT_ID || "operator.snowmoon.test.near",
    lpAccountId:
      process.env.SNOWMOON_LP_ACCOUNT_ID || "lp.snowmoon.test.near",
    aiMode,
    nearAiBaseUrl:
      process.env.NEAR_AI_BASE_URL || "https://api.near.ai/v1",
    nearAiModel:
      process.env.NEAR_AI_MODEL ||
      "fireworks::accounts/fireworks/models/llama-v3p3-70b-instruct",
    hasNearAiKey: nearAiApiKey.length > 0,
    walletMode,
    outlayerBaseUrl:
      process.env.OUTLAYER_BASE_URL || "https://api.outlayer.ai/v1",
    hasOutlayerKey: outlayerApiKey.length > 0,
    autoApproveLimitUsdc,
    secrets: {
      nearAiApiKey,
      outlayerApiKey,
      operatorPrivateKey: (process.env.SNOWMOON_OPERATOR_PRIVATE_KEY || "").trim(),
      adminPrivateKey: (process.env.SNOWMOON_ADMIN_PRIVATE_KEY || "").trim(),
    },
  };
}

