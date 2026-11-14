import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env` from the repository root if present without overriding existing process.env variables.
 */
export function loadEnvFile(envPath?: string): void {
  const resolved = envPath ?? path.resolve(process.cwd(), "..", ".env");
  const candidates = envPath
    ? [path.resolve(envPath)]
    : [path.resolve(process.cwd(), ".env"), resolved];
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
  nearMainnetRpcUrl: string;
  mainnetUsdcContractId: string;
  mainnetCoreContractId: string;
  mainnetAuditContractId: string;
  mainnetAdminAccountId: string;
  mainnetOperatorAccountId: string;
  mainnetAuditOperatorAccountId: string;
  coreContractId: string;
  auditContractId: string;
  usdcContractId: string;
  adminAccountId: string;
  customerAccountId: string;
  operatorAccountId: string;
  lpAccountId: string;
  liveTxBroadcastingEnabled: boolean;
  aiMode: "near_ai" | "mock";
  nearAiBaseUrl: string;
  nearAiModel: string;
  nearAiTimeoutMs: number;
  hasNearAiKey: boolean;
  walletMode: "outlayer" | "mock";
  outlayerBaseUrl: string;
  hasOutlayerKey: boolean;
  outlayerProjectOwner: string;
  outlayerProjectName: string;
  outlayerVersionKey: string;
  outlayerComputeLimit: string;
  outlayerAttachedDeposit: string;
  outlayerMaxPerCallMicroUsd: string;
  outlayerExpectedWasmHash: string;
  hasOutlayerPaymentKey: boolean;
  oneClickApiBaseUrl: string;
  persistenceFile: string;
  persistenceBackend: "supabase" | "json";
  persistenceRowMode: "kv" | "dual" | "row";
  supabaseUrl: string;
  hasSupabaseSecretKey: boolean;
  autoApproveLimitUsdc: bigint;
  isProductionMode: boolean;
  restrictedBetaMode: boolean;
  pilot: {
    enabled: boolean;
    maxJobUsdcAtomic: bigint;
    floatPoolEnabled: boolean;
    allowedAccounts: string[];
  };
  allowSandboxDemoEndpoints: boolean;
  corsAllowedOrigin: string;
  // Strictly server-side secrets (never serialized to client responses)
  secrets: {
    nearAiApiKey: string;
    outlayerApiKey: string;
    outlayerPaymentKey: string;
    oneClickApiKey: string;
    supabaseSecretKey: string;
    walletSessionSecret: string;
    operatorPrivateKey: string;
    adminPrivateKey: string;
  };
}

export function loadConfig(envOverrides?: Record<string, string | undefined>): SnowMoonConfig {
  if (!envOverrides) {
    loadEnvFile();
  }
  const env = envOverrides ?? process.env;

  const port = Number(env.SNOWMOON_PORT || env.PORT || "8090");
  const host =
    env.SNOWMOON_HOST ||
    (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID ? "0.0.0.0" : "127.0.0.1");
  const stateFile =
    env.SNOWMOON_STATE_FILE ||
    path.resolve(process.cwd(), ".snowmoon-state.json");

  const rawNet = (env.SNOWMOON_NETWORK || "sandbox").toLowerCase();
  const network: "sandbox" | "testnet" | "mainnet" =
    rawNet === "testnet"
      ? "testnet"
      : rawNet === "mainnet"
      ? "mainnet"
      : "sandbox";

  const rawChain = (env.SNOWMOON_CHAIN_MODE || "sandbox").toLowerCase();
  const chainMode: "sandbox" | "rpc" = rawChain === "rpc" ? "rpc" : "sandbox";

  const explicitProduction =
    (env.NODE_ENV || "").toLowerCase() === "production" ||
    (env.SNOWMOON_ENV || "").toLowerCase() === "production" ||
    (env.VERCEL_ENV || "").toLowerCase() === "production" ||
    env.VERCEL === "1";

  if (explicitProduction && (network !== "mainnet" || chainMode !== "rpc")) {
    throw new Error(
      `ERR_PRODUCTION_CONFIG_INVALID: Production startup requires SNOWMOON_NETWORK=mainnet and SNOWMOON_CHAIN_MODE=rpc (got network=${rawNet}, chainMode=${rawChain}).`
    );
  }

  if (
    explicitProduction &&
    ((env.SNOWMOON_DB_MODE || "").toLowerCase() === "json" ||
      !(env.SUPABASE_URL || "").trim() ||
      !(env.SUPABASE_SECRET_KEY || "").trim())
  ) {
    throw new Error(
      "ERR_PRODUCTION_DATABASE_REQUIRED: Production deployment requires SUPABASE_URL, SUPABASE_SECRET_KEY, and non-JSON persistence."
    );
  }
  if (explicitProduction && (env.SNOWMOON_AI_MODE || "").toLowerCase() === "mock") {
    throw new Error(
      "ERR_PRODUCTION_AI_MODE_INVALID: SNOWMOON_AI_MODE=mock is forbidden in production deployments."
    );
  }
  if (explicitProduction && !(env.WALLET_SESSION_SECRET || "").trim()) {
    throw new Error(
      "ERR_PRODUCTION_SESSION_SECRET_REQUIRED: WALLET_SESSION_SECRET is required in every production environment."
    );
  }

  const defaultRpc =
    network === "testnet"
      ? env.NEAR_TESTNET_RPC_URL || "https://rpc.testnet.near.org"
      : network === "mainnet"
      ? env.NEAR_MAINNET_RPC_URL || "https://free.rpc.fastnear.com"
      : env.NEAR_SANDBOX_RPC_URL || "http://127.0.0.1:3030";

  const nearRpcUrl = env.SNOWMOON_NEAR_RPC_URL || defaultRpc;

  const nearAiApiKey = (env.NEAR_AI_API_KEY || "").trim();
  const rawAiMode = (env.SNOWMOON_AI_MODE || "auto").toLowerCase();
  const isProdRuntime = explicitProduction || (network === "mainnet" && chainMode === "rpc");
  const aiMode: "near_ai" | "mock" =
    rawAiMode === "mock"
      ? "mock"
      : rawAiMode === "near_ai" || isProdRuntime || nearAiApiKey.length > 0
      ? "near_ai"
      : "mock";

  const nearAiTimeoutMs = Math.max(
    1000,
    Number(env.NEAR_AI_TIMEOUT_MS || "60000")
  );

  const outlayerApiKey = (env.OUTLAYER_API_KEY || "").trim();
  const rawWalletMode = (env.SNOWMOON_WALLET_MODE || "auto").toLowerCase();
  const walletMode: "outlayer" | "mock" =
    rawWalletMode === "outlayer" ||
    (rawWalletMode === "auto" && outlayerApiKey.length > 0)
      ? "outlayer"
      : "mock";

  const rawRowMode = (env.SNOWMOON_DB_ROW_MODE || "kv").trim().toLowerCase();
  if (rawRowMode !== "kv" && rawRowMode !== "dual" && rawRowMode !== "row") {
    throw new Error(
      `ERR_INVALID_DB_ROW_MODE: SNOWMOON_DB_ROW_MODE must be "kv", "dual", or "row" (got "${rawRowMode}").`
    );
  }
  const persistenceRowMode: "kv" | "dual" | "row" = rawRowMode;

  const autoApproveLimitUsdc = BigInt(
    env.SNOWMOON_AUTO_APPROVE_LIMIT_USDC || "100000"
  );

  const isProductionMode =
    explicitProduction || (network === "mainnet" && chainMode === "rpc");
  // Force allowSandboxDemoEndpoints=false in production regardless of env overrides.
  const allowSandboxDemoEndpoints = isProductionMode
    ? false
    : env.SNOWMOON_ALLOW_SANDBOX_DEMO_ENDPOINTS === "true"
    ? true
    : env.SNOWMOON_ALLOW_SANDBOX_DEMO_ENDPOINTS === "false"
    ? false
    : true;
  const rawRestrictedBeta = (env.SNOWMOON_RESTRICTED_BETA || "").trim().toLowerCase();
  let restrictedBetaMode: boolean;
  if (rawRestrictedBeta === "1" || rawRestrictedBeta === "true") {
    restrictedBetaMode = true;
  } else if (rawRestrictedBeta === "0" || rawRestrictedBeta === "false") {
    restrictedBetaMode = false;
  } else if (rawRestrictedBeta === "") {
    // Fail closed in hosted production environments (Vercel, Railway, NODE_ENV=production) if omitted.
    restrictedBetaMode =
      explicitProduction || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  } else {
    throw new Error(
      `ERR_INVALID_RESTRICTED_BETA_CONFIG: SNOWMOON_RESTRICTED_BETA must be 1/true or 0/false, got "${rawRestrictedBeta}".`
    );
  }

  const rawPilotMode = (env.SNOWMOON_PILOT_MODE || "").trim().toLowerCase();
  const pilotEnabled = rawPilotMode === "1" || rawPilotMode === "true";
  const rawPilotMax = (env.SNOWMOON_PILOT_MAX_JOB_USDC || "").trim();
  let pilotMaxJobUsdcAtomic = 0n;
  if (rawPilotMax) {
    if (!/^\d+$/.test(rawPilotMax)) {
      throw new Error(
        `ERR_INVALID_PILOT_CAP: SNOWMOON_PILOT_MAX_JOB_USDC must be an integer atomic USDC amount, got "${rawPilotMax}".`
      );
    }
    pilotMaxJobUsdcAtomic = BigInt(rawPilotMax);
  } else if (pilotEnabled) {
    pilotMaxJobUsdcAtomic = 2_000_000n; // Default controlled pilot cap: 2.00 USDC per job
  }
  const rawPilotFloat = (env.SNOWMOON_PILOT_FLOAT_POOL_ENABLED || "").trim().toLowerCase();
  const pilotFloatPoolEnabled =
    rawPilotFloat === "1" || rawPilotFloat === "true"
      ? true
      : rawPilotFloat === "0" || rawPilotFloat === "false"
      ? false
      : !pilotEnabled;
  const pilotAllowedAccounts = (env.SNOWMOON_PILOT_ALLOWED_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const corsAllowedOrigin = (env.SNOWMOON_CORS_ORIGIN || "").trim();

  return {
    port,
    host,
    stateFile,
    network,
    chainMode,
    nearRpcUrl,
    nearMainnetRpcUrl:
      env.NEAR_MAINNET_RPC_URL || "https://free.rpc.fastnear.com",
    mainnetUsdcContractId:
      env.SNOWMOON_MAINNET_USDC_CONTRACT_ID ||
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    mainnetCoreContractId:
      env.SNOWMOON_MAINNET_CORE_CONTRACT_ID || "core.cryptozax.near",
    mainnetAuditContractId:
      env.SNOWMOON_MAINNET_AUDIT_CONTRACT_ID || "audit.cryptozax.near",
    mainnetAdminAccountId:
      env.SNOWMOON_MAINNET_ADMIN_ACCOUNT_ID || "cryptozax.near",
    mainnetOperatorAccountId:
      env.SNOWMOON_MAINNET_OPERATOR_ACCOUNT_ID ||
      "88b6a5aa5a966aec6f9b56229f78458beca261b1f8fa5553109072f810222169",
    mainnetAuditOperatorAccountId:
      env.SNOWMOON_MAINNET_AUDIT_OPERATOR_ACCOUNT_ID || "cryptozax.near",
    coreContractId:
      env.SNOWMOON_CORE_CONTRACT_ID || "snowmoon-core.test.near",
    auditContractId:
      env.SNOWMOON_AUDIT_CONTRACT_ID || "snowmoon-audit.test.near",
    usdcContractId:
      env.SNOWMOON_USDC_CONTRACT_ID || "usdc.test.near",
    adminAccountId:
      env.SNOWMOON_ADMIN_ACCOUNT_ID || "admin.snowmoon.test.near",
    customerAccountId:
      env.SNOWMOON_CUSTOMER_ACCOUNT_ID || "customer.snowmoon.test.near",
    operatorAccountId:
      env.SNOWMOON_OPERATOR_ACCOUNT_ID || "operator.snowmoon.test.near",
    lpAccountId:
      env.SNOWMOON_LP_ACCOUNT_ID || "lp.snowmoon.test.near",
    liveTxBroadcastingEnabled: false, // Hard-locked disabled until deployment, wallet auth, and tx simulation are verified
    aiMode,
    nearAiBaseUrl:
      (env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/+$/, ""),
    nearAiModel:
      env.NEAR_AI_MODEL ||
      "deepseek/deepseek-v3.2",
    nearAiTimeoutMs,
    hasNearAiKey: nearAiApiKey.length > 0,
    walletMode,
    outlayerBaseUrl:
      (env.OUTLAYER_BASE_URL || "https://api.outlayer.ai")
        .replace(/\/wallet\/v1\/?$/, "")
        .replace(/\/v1\/?$/, "")
        .replace(/\/+$/, ""),
    hasOutlayerKey: outlayerApiKey.length > 0,
    outlayerProjectOwner: (env.OUTLAYER_PROJECT_OWNER || "").trim(),
    outlayerProjectName: (env.OUTLAYER_PROJECT_NAME || "").trim(),
    outlayerVersionKey: (env.OUTLAYER_VERSION_KEY || "").trim(),
    outlayerComputeLimit: (() => {
      const parsed = Number.parseInt((env.OUTLAYER_COMPUTE_LIMIT || "10000").trim(), 10);
      return String(Number.isFinite(parsed) ? Math.max(5000, parsed) : 10000);
    })(),
    outlayerAttachedDeposit: (env.OUTLAYER_ATTACHED_DEPOSIT || "0").trim(),
    outlayerMaxPerCallMicroUsd: (env.OUTLAYER_MAX_PER_CALL || "100000").trim(),
    outlayerExpectedWasmHash: (env.OUTLAYER_EXPECTED_WASM_HASH || "").trim().toLowerCase(),
    hasOutlayerPaymentKey: (env.OUTLAYER_PAYMENT_KEY || "").trim().length > 0,
    oneClickApiBaseUrl: (env.NEAR_INTENTS_1CLICK_URL || "https://1click.chaindefuser.com").replace(/\/+$/, ""),
    persistenceFile:
      env.SNOWMOON_PERSISTENCE_FILE ||
      path.resolve(process.cwd(), "data", "snowmoon-phase9-state.json"),
    persistenceBackend:
      env.SNOWMOON_DB_MODE === "supabase"
        ? "supabase"
        : env.SNOWMOON_DB_MODE === "json" || env.SNOWMOON_PERSISTENCE_FILE
        ? "json"
        : (env.SUPABASE_URL || "").trim() && (env.SUPABASE_SECRET_KEY || "").trim()
        ? "supabase"
        : "json",
    persistenceRowMode,
    supabaseUrl: (env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    hasSupabaseSecretKey: (env.SUPABASE_SECRET_KEY || "").trim().length > 0,
    autoApproveLimitUsdc,
    isProductionMode,
    restrictedBetaMode,
    pilot: {
      enabled: pilotEnabled,
      maxJobUsdcAtomic: pilotMaxJobUsdcAtomic,
      floatPoolEnabled: pilotFloatPoolEnabled,
      allowedAccounts: pilotAllowedAccounts,
    },
    allowSandboxDemoEndpoints,
    corsAllowedOrigin,
    secrets: {
      nearAiApiKey,
      outlayerApiKey,
      outlayerPaymentKey: (env.OUTLAYER_PAYMENT_KEY || "").trim(),
      oneClickApiKey: (env.NEAR_INTENTS_1CLICK_API_KEY || "").trim(),
      supabaseSecretKey: (env.SUPABASE_SECRET_KEY || "").trim(),
      walletSessionSecret: (env.WALLET_SESSION_SECRET || "").trim(),
      operatorPrivateKey: (env.SNOWMOON_OPERATOR_PRIVATE_KEY || "").trim(),
      adminPrivateKey: (env.SNOWMOON_ADMIN_PRIVATE_KEY || "").trim(),
    },
  };
}

