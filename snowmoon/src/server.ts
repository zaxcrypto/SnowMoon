import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, type SnowMoonConfig } from "./config.ts";
import {
  ANCHOR_FINAL_STAKE,
  ANCHOR_STORAGE_DEPOSIT,
  JOB_STORAGE_DEPOSIT_INITIAL,
  LP_SHARE_STAKE,
  STORAGE_REGISTRATION,
  SnowMoonEngine,
} from "./engine.ts";
import { AIWorkerAdapter, OutLayerPolicyAdapter } from "./adapters.ts";
import { NearMainnetRpcAdapter } from "./near_rpc.ts";
import {
  getCustomerMainnetState,
  MainnetEscrowTracker,
  prepareCustomerStorageRegistration,
  verifyMainnetWalletSession,
  WalletSessionManager,
} from "./mainnet_escrow.ts";
import { OutLayerExecutionAdapter, type OutLayerVerifyRunner } from "./outlayer.ts";
import { WorkforceEngine } from "./workforce.ts";
import { VerificationEngine } from "./verification.ts";
import { SettlementEngine, type RefundReason } from "./settlement.ts";
import { SnowMoonRepository } from "./persistence.ts";
import { NearIntentsClient } from "./near_intents.ts";
import { FloatPoolAdvanceOrchestrator } from "./float_pool.ts";
import { DeliverableVault, LocalPrivateObjectStorage } from "./deliverables.ts";
import { MonitoringService } from "./monitoring.ts";
import { DeterministicSpendingPolicyEngine } from "./spending_policy.ts";
import { NearAiBrainOrchestrator } from "./brain_audit.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PRODUCTION_ROUTE_POLICY = {
  sandboxOnlyBlockedInProduction: [
    "/api/reset",
    "/api/audit/anchor",
    "/api/demo/*",
    "/api/jobs/*",
    "/api/float/*",
  ],
  productionAllowedRoutes: {
    publicReadOnly: [
      "/api/health",
      "/api/metrics",
      "/api/database/health",
      "/api/state",
      "/api/routes/policy",
      "/api/audit/status",
      "/api/audit/readiness",
      "/api/ai/status",
      "/api/near/mainnet-status",
      "/api/near/account",
      "/api/near/core-job",
      "/api/near/core-storage",
      "/api/near/tx-status",
      "/api/near/customer-state",
      "/api/near/escrow/jobs",
      "/api/intents/tokens",
      "/api/intents/list",
      "/api/intents/status",
      "/api/workforce/workers",
      "/api/workforce/jobs",
      "/api/workforce/jobs/discover",
      "/api/verification/submissions",
      "/api/settlement/list",
      "/api/settlement/history",
      "/api/outlayer/status",
      "/api/outlayer/requests",
      "/api/outlayer/config-status",
      "/api/outlayer/verify-public",
      "/api/monitoring/health",
    ],
    walletSessionAuthenticated: [
      "/api/near/wallet/verify",
      "/api/near/prepare-tx",
      "/api/near/prepare-registration",
      "/api/near/escrow/prepare-fund",
      "/api/near/escrow/submit-tx",
      "/api/near/escrow/reconcile",
      "/api/near/float/prepare-deposit",
      "/api/near/float/prepare-withdraw",
      "/api/near/float/prepare-advance",
      "/api/near/float/evaluate",
      "/api/near/vault/prepare-start-work",
      "/api/near/vault/prepare-submit-delivery",
      "/api/near/vault/prepare-accept-delivery",
      "/api/near/vault/prepare-refund",
      "/api/settlement/prepare-refund",
      "/api/deliverables/*",
      "/api/intents/quote",
      "/api/intents/widget-quote",
      "/api/intents/prepare-deposit",
      "/api/intents/deposit-submit",
      "/api/intents/verify-destination",
      "/api/intents/prepare-escrow",
      "/api/workforce/workers/register",
      "/api/workforce/jobs/register",
      "/api/workforce/jobs/assign",
      "/api/workforce/jobs/reassign",
      "/api/workforce/jobs/cancel",
      "/api/verification/submit",
      "/api/verification/verify",
      "/api/verification/prepare-audit-anchor",
      "/api/verification/submit-audit-anchor",
      "/api/verification/reconcile-audit-anchor",
      "/api/verification/recover-anchors",
      "/api/settlement/prepare",
      "/api/settlement/submit-tx",
      "/api/settlement/reconcile",
      "/api/settlement/prepare-claim",
      "/api/outlayer/execute",
      "/api/outlayer/poll",
      "/api/outlayer/verify-attestation",
      "/api/approvals/decide",
    ],
    workerBearerAuthenticated: [
      "/api/workforce/workers/availability",
      "/api/workforce/jobs/accept",
      "/api/workforce/jobs/execute",
    ],
  },
} as const;

export interface SnowMoonApp {
  config: SnowMoonConfig;
  engine: SnowMoonEngine;
  policyAdapter: OutLayerPolicyAdapter;
  aiAdapter: AIWorkerAdapter;
  nearRpcAdapter: NearMainnetRpcAdapter;
  escrowTracker: MainnetEscrowTracker;
  walletSessionManager: WalletSessionManager;
  repo: SnowMoonRepository;
  intentsClient: NearIntentsClient;
  outlayerExecAdapter: OutLayerExecutionAdapter;
  workforceEngine: WorkforceEngine;
  verificationEngine: VerificationEngine;
  settlementEngine: SettlementEngine;
  server: http.Server;
}

const MAX_JSON_BODY_BYTES = 65_536; // 64 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MUTATION_REQUESTS = 120;
const RATE_LIMIT_MAX_READ_REQUESTS = 1200;

function sanitizeCorrelationId(raw?: string | string[]): string {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val === "string" && /^[A-Za-z0-9_.\-]{8,64}$/.test(val.trim())) {
    return val.trim();
  }
  return "req_" + crypto.randomBytes(8).toString("hex");
}

function logStructuredEvent(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown>
): void {
  if (process.env.SNOWMOON_SILENT_LOGS === "true") return;
  const safePayload = redactSensitiveText(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...details,
    })
  );
  if (level === "error") {
    console.error(safePayload);
  } else if (level === "warn") {
    console.warn(safePayload);
  } else {
    console.log(safePayload);
  }
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/ed25519:[A-Za-z0-9]{20,}/g, "ed25519:[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_\-]{12,}/g, "sk-[REDACTED]");
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new Error(`ERR_PAYLOAD_TOO_LARGE: Request body exceeds ${MAX_JSON_BODY_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function resolveAllowedOrigin(reqOrigin?: string, configuredOrigin?: string): string {
  if (configuredOrigin && reqOrigin && reqOrigin === configuredOrigin) {
    return reqOrigin;
  }
  if (reqOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(reqOrigin)) {
    return reqOrigin;
  }
  return configuredOrigin || "http://127.0.0.1:8787";
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  reqOrigin?: string,
  configuredOrigin?: string,
  correlationId?: string
): void {
  const body = JSON.stringify(payload, null, 2);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": resolveAllowedOrigin(reqOrigin, configuredOrigin),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-wallet-session, x-worker-token, x-request-id, Authorization",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  if (correlationId) {
    headers["X-Request-Id"] = correlationId;
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function buildSystemSnapshot(
  config: SnowMoonConfig,
  engine: SnowMoonEngine,
  policyAdapter: OutLayerPolicyAdapter,
  aiAdapter: AIWorkerAdapter,
  nearRpcAdapter?: NearMainnetRpcAdapter,
  verificationEngine?: VerificationEngine
) {
  const jobs = Array.from(engine.jobs.values()).sort((a, b) => b.seq - a.seq);
  const advances = Array.from(engine.advances.values()).sort(
    (a, b) => b.advanceId - a.advanceId
  );
  const approvals = Array.from(engine.approvals.values()).reverse();
  const anchors = Array.from(engine.anchors.values()).sort(
    (a, b) => b.anchoredAtSec - a.anchoredAtSec
  );

  const balances: Record<string, string> = {};
  for (const [acct, bal] of engine.usdcBalances.entries()) {
    balances[acct] = bal.toString();
  }

  const shares: Record<string, string> = {};
  for (const [acct, sh] of engine.lpShares.entries()) {
    shares[acct] = sh.toString();
  }

  const totalEscrowed = jobs
    .filter((j) => j.state === "Funded" || j.state === "InProgress" || j.state === "Delivered")
    .reduce((acc, j) => acc + BigInt(j.customerPayment), 0n);

  const totalSettledVolume = jobs
    .filter((j) => j.state === "Accepted")
    .reduce((acc, j) => acc + BigInt(j.customerPayment), 0n);

  return {
    environment: {
      network: config.network,
      chainMode: config.chainMode,
      nearRpcUrl: config.nearRpcUrl,
      nearMainnetRpcUrl: config.nearMainnetRpcUrl,
      mainnetUsdcContractId: config.mainnetUsdcContractId,
      mainnetCoreContractId: config.mainnetCoreContractId,
      mainnetAuditContractId: config.mainnetAuditContractId,
      mainnetAdminAccountId: config.mainnetAdminAccountId,
      mainnetOperatorAccountId: config.mainnetOperatorAccountId,
      mainnetAuditOperatorAccountId: config.mainnetAuditOperatorAccountId,
      liveTxBroadcastingEnabled: config.liveTxBroadcastingEnabled,
      isProductionMode: config.isProductionMode,
      restrictedBetaMode: config.restrictedBetaMode,
      allowSandboxDemoEndpoints: config.allowSandboxDemoEndpoints,
      coreContractId: config.coreContractId,
      auditContractId: config.auditContractId,
      usdcContractId: config.usdcContractId,
      aiMode: config.aiMode,
      aiAdapterLabel: aiAdapter.getAdapterLabel(),
      nearAiBaseUrl: config.nearAiBaseUrl,
      nearAiModel: config.nearAiModel,
      hasNearAiKey: config.hasNearAiKey,
      walletMode: config.walletMode,
      walletAdapterLabel: policyAdapter.getAdapterLabel(),
      autoApproveLimitUsdc: config.autoApproveLimitUsdc.toString(),
      storageConstants: {
        jobStorageDepositInitialYocto: JOB_STORAGE_DEPOSIT_INITIAL,
        storageRegistrationYocto: STORAGE_REGISTRATION,
        lpShareStakeYocto: LP_SHARE_STAKE,
        anchorStorageDepositYocto: ANCHOR_STORAGE_DEPOSIT,
        anchorFinalStakeYocto: ANCHOR_FINAL_STAKE,
      },
      accounts: {
        customer: config.customerAccountId,
        operator: config.operatorAccountId,
        lp: config.lpAccountId,
        admin: config.adminAccountId,
      },
    },
    overview: {
      totalJobs: jobs.length,
      activeJobs: jobs.filter(
        (j) =>
          j.state === "Created" ||
          j.state === "Funded" ||
          j.state === "InProgress" ||
          j.state === "Delivered"
      ).length,
      settledJobs: jobs.filter((j) => j.state === "Accepted").length,
      anchoredJobs: anchors.length,
      pendingApprovals: approvals.filter((a) => a.status === "PENDING").length,
      totalEscrowedUsdc: totalEscrowed.toString(),
      totalSettledVolumeUsdc: totalSettledVolume.toString(),
    },
    floatPool: {
      epoch: engine.epoch,
      paused: engine.paused,
      poolIdleCashUsdc: engine.poolIdleCash.toString(),
      totalOutstandingUsdc: engine.totalOutstanding.toString(),
      totalAssetsUsdc: engine.totalAssets().toString(),
      totalShares: engine.totalShares.toString(),
      lossReserveUsdc: engine.lossReserve.toString(),
      advanceAprBps: engine.advanceAprBps.toString(),
      maxUtilizationBps: engine.maxUtilizationBps.toString(),
      creditLineMultiplierBps: engine.creditLineMultiplierBps.toString(),
      lpSharesByAccount: shares,
    },
    outlayerWallet: policyAdapter.getCachedWalletSnapshot(),
    nearMainnet: nearRpcAdapter ? nearRpcAdapter.getCachedStatus() : null,
    balancesUsdc: balances,
    jobs,
    advances,
    approvals,
    anchors,
    verifications: verificationEngine ? verificationEngine.listSubmissions() : [],
    events: engine.events.slice(0, 60),
  };
}

export function createSnowMoonApp(
  customConfig?: SnowMoonConfig,
  deps?: {
    outlayerFetch?: typeof fetch;
    outlayerVerifyRunner?: OutLayerVerifyRunner;
  }
): SnowMoonApp {
  const config = customConfig ?? loadConfig();
  const engine = new SnowMoonEngine(config);
  const policyAdapter = new OutLayerPolicyAdapter(config, engine);
  const aiAdapter = new AIWorkerAdapter(config);
  const nearRpcAdapter = new NearMainnetRpcAdapter(config);
  const walletSessionSecret = config.isProductionMode
    ? (config.secrets.walletSessionSecret || process.env.WALLET_SESSION_SECRET || "").trim()
    : (
        config.secrets.walletSessionSecret ||
        process.env.WALLET_SESSION_SECRET ||
        config.secrets.supabaseSecretKey ||
        config.secrets.operatorPrivateKey ||
        undefined
      );
  const repo = SnowMoonRepository.fromConfig(config);
  const walletSessionManager = new WalletSessionManager(walletSessionSecret, undefined, {
    requireSecret: config.isProductionMode,
    repo,
  });
  const escrowTracker = new MainnetEscrowTracker(repo);
  const intentsClient = new NearIntentsClient(config, fetch, repo);
  const outlayerExecAdapter = new OutLayerExecutionAdapter(
    config,
    deps?.outlayerFetch ?? fetch,
    repo,
    deps?.outlayerVerifyRunner
  );
  const workforceEngine = new WorkforceEngine(repo);
  const verificationEngine = new VerificationEngine(repo);
  const settlementEngine = new SettlementEngine(repo);
  const floatOrchestrator = new FloatPoolAdvanceOrchestrator();
  const deliverableVault =
    config.persistenceBackend === "json" &&
    (!config.supabaseUrl || !config.secrets.supabaseSecretKey) &&
    (process.env.SNOWMOON_ENV || "").toLowerCase() !== "production" &&
    (process.env.NODE_ENV || "").toLowerCase() !== "production" &&
    !process.env.VERCEL
      ? new DeliverableVault(
          new LocalPrivateObjectStorage(
            path.join(path.dirname(config.persistenceFile), "deliverables"),
            false
          ),
          walletSessionSecret || "snowmoon-dev-deliverable-secret"
        )
      : DeliverableVault.fromConfig(
          config,
          walletSessionSecret || "snowmoon-dev-deliverable-secret"
        );
  const monitoring = new MonitoringService();
  const spendingPolicy = new DeterministicSpendingPolicyEngine();
  const brainOrchestrator = new NearAiBrainOrchestrator();
  const nearRateBuckets = new Map<string, number[]>();
  const startedAtMs = Date.now();
  let enginesHydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  const ensureEnginesHydrated = async (): Promise<void> => {
    if (enginesHydrated) return;
    if (!hydrationPromise) {
      hydrationPromise = (async () => {
        await repo.ensureHydrated(config.isProductionMode && repo.backend === "supabase");
        if (repo.backend === "supabase") {
          walletSessionManager.reloadFromRepo();
          escrowTracker.reloadFromRepo();
          intentsClient.reloadFromRepo();
          outlayerExecAdapter.reloadFromRepo();
          workforceEngine.reloadFromRepo();
          verificationEngine.reloadFromRepo();
          settlementEngine.reloadFromRepo();
        }
        enginesHydrated = true;
      })().finally(() => {
        hydrationPromise = null;
      });
    }
    await hydrationPromise;
  };
  const metrics = {
    requestsTotal: 0,
    errors4xx: 0,
    errors5xx: 0,
    rateLimited: 0,
  };

  const publicDir = path.resolve(__dirname, "..", "public");

  const server = http.createServer(async (req, res) => {
    const reqOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const correlationId = sanitizeCorrelationId(req.headers["x-request-id"]);
    res.setHeader("X-Request-Id", correlationId);
    metrics.requestsTotal += 1;
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname;

      if (method === "OPTIONS") {
        sendJson(res, 200, { ok: true }, reqOrigin, undefined, correlationId);
        return;
      }

      const getWalletToken = (): string | undefined =>
        typeof req.headers["x-wallet-session"] === "string"
          ? req.headers["x-wallet-session"]
          : undefined;
      const getWorkerToken = (): string =>
        typeof req.headers["x-worker-token"] === "string" ? req.headers["x-worker-token"] : "";
      const isOperatorOrAdminAccount = (accountId: string): boolean =>
        [
          config.mainnetOperatorAccountId,
          config.mainnetAdminAccountId,
          config.mainnetAuditOperatorAccountId,
          config.operatorAccountId,
          config.adminAccountId,
        ]
          .filter(Boolean)
          .includes(accountId);
      const assertOperatorOrAdminSession = (): string => {
        const token = getWalletToken();
        if (!token || !token.trim()) {
          throw new Error(
            "ERR_WALLET_AUTH_REQUIRED: Missing x-wallet-session token for operator/admin action."
          );
        }
        const session = walletSessionManager.verifyToken(token);
        if (!isOperatorOrAdminAccount(session.accountId)) {
          throw new Error(
            `ERR_ACCOUNT_IMPERSONATION_BLOCKED: Wallet ${session.accountId} is not an authorized operator or admin.`
          );
        }
        return session.accountId;
      };
      const assertAuthenticatedSession = (): string => {
        const token = getWalletToken();
        if (!token || !token.trim()) {
          throw new Error(
            "ERR_WALLET_AUTH_REQUIRED: Missing x-wallet-session token. Connect and verify your Mainnet wallet first."
          );
        }
        return walletSessionManager.verifyToken(token).accountId;
      };
      const assertCustomerOrOperatorSession = (customerAccountId?: string): string => {
        const target = (customerAccountId || "").trim();
        if (!target) {
          throw new Error(
            "ERR_CUSTOMER_ACCOUNT_REQUIRED: Non-empty customerAccountId is required for ownership verification."
          );
        }
        const token = getWalletToken();
        if (!token || !token.trim()) {
          throw new Error(
            "ERR_WALLET_AUTH_REQUIRED: Missing x-wallet-session token. Connect and verify your Mainnet wallet first."
          );
        }
        const session = walletSessionManager.verifyToken(token);
        if (
          session.accountId !== target &&
          !isOperatorOrAdminAccount(session.accountId)
        ) {
          throw new Error(
            `ERR_ACCOUNT_IMPERSONATION_BLOCKED: Authenticated wallet ${session.accountId} cannot act for ${target}.`
          );
        }
        return session.accountId;
      };

      if (pathname.startsWith("/api/")) {
        // Hydrate authoritative remote state and reload all engines on cold start.
        await ensureEnginesHydrated();
        const ip = req.socket.remoteAddress || "unknown";
        const isReadMethod = method === "GET" || method === "HEAD";
        const bucketKey = `${ip}:${isReadMethod ? "read" : "write"}`;
        const maxRequests = isReadMethod
          ? RATE_LIMIT_MAX_READ_REQUESTS
          : RATE_LIMIT_MAX_MUTATION_REQUESTS;
        const now = Date.now();
        if (nearRateBuckets.size > 5000) {
          for (const [key, timestamps] of nearRateBuckets.entries()) {
            const active = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
            if (active.length === 0) nearRateBuckets.delete(key);
            else nearRateBuckets.set(key, active);
          }
        }
        const recent = (nearRateBuckets.get(bucketKey) || []).filter(
          (t) => now - t < RATE_LIMIT_WINDOW_MS
        );
        if (recent.length >= maxRequests) {
          metrics.rateLimited += 1;
          metrics.errors4xx += 1;
          logStructuredEvent("warn", "rate_limited", {
            correlationId,
            method,
            pathname,
            bucket: isReadMethod ? "read" : "write",
          });
          sendJson(
            res,
            429,
            { ok: false, error: "ERR_RATE_LIMITED: Too many API requests. Retry in 60s." },
            reqOrigin,
            undefined,
            correlationId
          );
          return;
        }
        recent.push(now);
        nearRateBuckets.set(bucketKey, recent);
      }

      if (
        config.restrictedBetaMode &&
        method === "POST" &&
        new Set([
          "/api/near/escrow/prepare-fund",
          "/api/near/escrow/submit-tx",
          "/api/intents/prepare-deposit",
          "/api/intents/prepare-escrow",
          "/api/intents/deposit-submit",
          "/api/near/float/prepare-deposit",
          "/api/near/float/prepare-withdraw",
          "/api/near/float/prepare-advance",
          "/api/near/vault/prepare-accept-delivery",
          "/api/near/vault/prepare-refund",
          "/api/settlement/prepare",
          "/api/settlement/prepare-refund",
          "/api/settlement/submit-tx",
          "/api/settlement/prepare-claim",
          "/api/outlayer/execute",
          "/api/jobs/fund",
          "/api/jobs/advance",
          "/api/jobs/accept",
          "/api/float/deposit",
          "/api/float/withdraw",
        ]).has(pathname)
      ) {
        metrics.errors4xx += 1;
        logStructuredEvent("warn", "restricted_beta_blocked", {
          correlationId,
          method,
          pathname,
        });
        sendJson(
          res,
          403,
          {
            ok: false,
            restrictedBetaMode: true,
            error:
              "ERR_RESTRICTED_BETA_FINANCIAL_DISABLED: Financial execution is disabled during SnowMoon Restricted Beta pending external smart-contract audit and operator verification.",
          },
          reqOrigin,
          undefined,
          correlationId
        );
        return;
      }

      // 1. Health & full state snapshot
      if (method === "GET" && pathname === "/api/state") {
        if (
          config.walletMode === "outlayer" &&
          config.hasOutlayerKey &&
          !policyAdapter.getCachedWalletSnapshot().authenticated
        ) {
          await policyAdapter.syncLiveWalletStatus();
        }
        sendJson(
          res,
          200,
          buildSystemSnapshot(config, engine, policyAdapter, aiAdapter, nearRpcAdapter, verificationEngine)
        );
        return;
      }

      // 1b. Read-only live OutLayer wallet & policy status check (GET or POST)
      if ((method === "GET" || method === "POST") && pathname === "/api/outlayer/status") {
        const snapshot = await policyAdapter.syncLiveWalletStatus();
        sendJson(res, 200, {
          ok: true,
          outlayerWallet: snapshot,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter, nearRpcAdapter),
        });
        return;
      }

      // 1c. Read-only live NEAR Mainnet RPC & contract deployment status check (GET or POST)
      if ((method === "GET" || method === "POST") && pathname === "/api/near/mainnet-status") {
        const extraAccount = parsedUrl.searchParams.get("accountId") || undefined;
        const nearMainnet = await nearRpcAdapter.syncMainnetStatus(extraAccount);
        sendJson(res, 200, {
          ok: true,
          nearMainnet,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter, nearRpcAdapter),
        });
        return;
      }

      // 1d. Read-only NEAR Mainnet account & USDC balance/registration inspector
      if (method === "GET" && pathname === "/api/near/account") {
        const accountId =
          parsedUrl.searchParams.get("accountId") || config.mainnetAdminAccountId;
        const accountState = await nearRpcAdapter.inspectMainnetAccount(accountId);
        sendJson(res, 200, {
          ok: true,
          accountState,
        });
        return;
      }

      // 1e. Unsigned transaction payload preparation for NEP-141 USDC escrow (ft_transfer_call) & SnowMoon Core
      if (method === "POST" && pathname === "/api/near/prepare-tx") {
        const body = await readJsonBody(req);
        assertCustomerOrOperatorSession(
          body.customerAccountId ? String(body.customerAccountId) : undefined
        );
        const prepared = nearRpcAdapter.prepareUsdcEscrowAndJobPayloads({
          customerAccountId: body.customerAccountId
            ? String(body.customerAccountId)
            : undefined,
          operatorAccountId: body.operatorAccountId
            ? String(body.operatorAccountId)
            : undefined,
          coreContractId: body.coreContractId
            ? String(body.coreContractId)
            : undefined,
          usdcContractId: body.usdcContractId
            ? String(body.usdcContractId)
            : undefined,
          customerPaymentUsdcAtomic: body.customerPaymentUsdcAtomic
            ? String(body.customerPaymentUsdcAtomic)
            : undefined,
          maxOperatingBudgetUsdcAtomic: body.maxOperatingBudgetUsdcAtomic
            ? String(body.maxOperatingBudgetUsdcAtomic)
            : undefined,
          termsHash: body.termsHash ? String(body.termsHash) : undefined,
          deadlineSec: body.deadlineSec ? Number(body.deadlineSec) : undefined,
          jobId: body.jobId ? String(body.jobId) : undefined,
          needsStorageRegistration:
            body.needsStorageRegistration !== undefined
              ? Boolean(body.needsStorageRegistration)
              : true,
        });
        sendJson(res, 200, {
          ok: true,
          prepared,
        });
        return;
      }

      // 1f. Read-only Core contract job lookup
      if (method === "GET" && pathname === "/api/near/core-job") {
        const jobId = parsedUrl.searchParams.get("jobId") || "";
        const coreContractId =
          parsedUrl.searchParams.get("coreContractId") || config.mainnetCoreContractId;
        const job = await nearRpcAdapter.queryCoreJob(jobId, coreContractId);
        sendJson(res, 200, {
          ok: true,
          mode: "MAINNET_READ_ONLY",
          coreContractId,
          jobId,
          result: job,
        });
        return;
      }

      // 1g. Read-only Core contract storage credit lookup
      if (method === "GET" && pathname === "/api/near/core-storage") {
        const accountId =
          parsedUrl.searchParams.get("accountId") || config.mainnetAdminAccountId;
        const coreContractId =
          parsedUrl.searchParams.get("coreContractId") || config.mainnetCoreContractId;
        const storage = await nearRpcAdapter.queryCoreStorageCredit(
          accountId,
          coreContractId
        );
        sendJson(res, 200, {
          ok: true,
          mode: "MAINNET_READ_ONLY",
          coreContractId,
          accountId,
          storage,
        });
        return;
      }

      // 1h. Read-only Mainnet transaction status lookup (EXPERIMENTAL_tx_status)
      if (method === "GET" && pathname === "/api/near/tx-status") {
        const txHash = parsedUrl.searchParams.get("txHash") || "";
        const senderId =
          parsedUrl.searchParams.get("senderId") || config.mainnetAdminAccountId;
        const txStatus = await nearRpcAdapter.queryTransactionStatus(txHash, senderId);
        sendJson(res, 200, {
          ok: true,
          mode: "MAINNET_READ_ONLY",
          txHash,
          senderId,
          txStatus,
        });
        return;
      }

      // 1h-2. Issue single-use NEP-413 authentication challenge for wallet signing
      if (method === "POST" && pathname === "/api/near/wallet/challenge") {
        const body = await readJsonBody(req);
        const accountId = String(body.accountId || "").trim();
        const challenge = walletSessionManager.issueChallenge({
          accountId,
          recipient: body.recipient ? String(body.recipient) : "snowmoon.near",
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, challenge }, reqOrigin);
        return;
      }

      // 1i. Customer Wallet Mainnet session verification & live USDC/Core state
      if (method === "POST" && pathname === "/api/near/wallet/verify") {
        const body = await readJsonBody(req);
        const session = verifyMainnetWalletSession({
          accountId: String(body.accountId || ""),
          networkId: String(body.networkId || ""),
          walletType: String(body.walletType || ""),
          privateKey: body.privateKey,
          isProductionMode: config.isProductionMode,
        });
        const challengeId = String(body.challengeId || "").trim();
        const signature = String(body.signature || "").trim();
        const publicKey = String(body.publicKey || "").trim();
        if (!challengeId || !signature || !publicKey) {
          throw new Error(
            "ERR_WALLET_SIGNATURE_REQUIRED: Signed NEP-413 challenge (challengeId, signature, publicKey) is required to authenticate."
          );
        }
        await walletSessionManager.verifyNep413SignatureAsync({
          challengeId,
          accountId: session.accountId,
          signature,
          publicKey,
          callbackUrl: body.callbackUrl ? String(body.callbackUrl) : undefined,
        });
        await repo.flushPending();
        if (config.chainMode === "rpc") {
          const accessKey = await nearRpcAdapter.viewAccessKey(session.accountId, publicKey);
          if (!accessKey.exists) {
            throw new Error(
              `ERR_WALLET_ACCESS_KEY_INVALID: Public key ${publicKey} is not an active access key on ${session.accountId}.`
            );
          }
        }
        const walletSessionToken = walletSessionManager.issueToken(session);
        const customerState = await getCustomerMainnetState(
          nearRpcAdapter,
          config,
          session.accountId
        );
        sendJson(res, 200, {
          ok: true,
          session,
          walletSessionToken,
          customerState,
        }, reqOrigin);
        return;
      }

      // 1j. Read-only customer USDC & Core storage state
      if (method === "GET" && pathname === "/api/near/customer-state") {
        const accountId = parsedUrl.searchParams.get("accountId") || "";
        const customerState = await getCustomerMainnetState(
          nearRpcAdapter,
          config,
          accountId
        );
        sendJson(res, 200, {
          ok: true,
          customerState,
        }, reqOrigin);
        return;
      }

      // 1k. Prepare only missing USDC & Core storage_deposit transactions
      if (method === "POST" && pathname === "/api/near/prepare-registration") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerAccountId);
        const plan = await prepareCustomerStorageRegistration(
          nearRpcAdapter,
          config,
          customerAccountId
        );
        sendJson(res, 200, {
          ok: true,
          plan,
        }, reqOrigin);
        return;
      }

      // 1l. Prepare real Mainnet NEP-141 CreateAndFundJob escrow intent
      if (method === "POST" && pathname === "/api/near/escrow/prepare-fund") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerAccountId);
        const result = await escrowTracker.prepareFundJob(nearRpcAdapter, config, {
          customerAccountId,
          operatorAccountId: body.operatorAccountId
            ? String(body.operatorAccountId)
            : undefined,
          customerPaymentUsdcAtomic: String(body.customerPaymentUsdcAtomic || ""),
          maxOperatingBudgetUsdcAtomic: String(
            body.maxOperatingBudgetUsdcAtomic || "0"
          ),
          termsHash: String(
            body.termsHash ||
              "0xd8a2a66c36307e760125edcea6a9867891c4d19ef472e5a52e3db1583b3e14de"
          ),
          deadlineSec:
            body.deadlineSec !== undefined
              ? Number(body.deadlineSec)
              : Math.floor(Date.now() / 1000) + 86400,
          clientNonce: body.clientNonce ? String(body.clientNonce) : undefined,
        });
        await repo.flushPending();
        sendJson(res, 200, {
          ok: true,
          ...result,
        }, reqOrigin);
        return;
      }

      // 1m. Record wallet-signed Mainnet transaction hash (prevents replay / blind retry)
      if (method === "POST" && pathname === "/api/near/escrow/submit-tx") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerAccountId);
        const record = escrowTracker.submitSignedTransaction({
          intentId: String(body.intentId || ""),
          txHash: String(body.txHash || ""),
          customerAccountId,
        });
        await repo.flushPending();
        sendJson(res, 200, {
          ok: true,
          record,
        }, reqOrigin);
        return;
      }

      // 1n. Reconcile Mainnet transaction hash & on-chain Core job state
      if (method === "POST" && pathname === "/api/near/escrow/reconcile") {
        const body = await readJsonBody(req);
        assertCustomerOrOperatorSession(
          body.customerAccountId ? String(body.customerAccountId) : undefined
        );
        const record = await escrowTracker.reconcileTransaction(nearRpcAdapter, {
          intentId: body.intentId ? String(body.intentId) : undefined,
          txHash: String(body.txHash || ""),
          customerAccountId: String(body.customerAccountId || ""),
        });
        let workforceJob = null;
        if (record.escrowState === "FINAL_CONFIRMED" && record.jobId) {
          workforceJob = workforceEngine.registerJob({
            jobId: record.jobId,
            customerAccountId: record.customerAccountId,
            tenantId: record.customerAccountId,
            escrowIntentId: record.intentId,
            escrowTxHash: record.sourceTxHash ?? undefined,
            amountAtomic: record.amountAtomic,
            requiredCapabilities: Array.isArray(body.requiredCapabilities)
              ? body.requiredCapabilities.map(String)
              : ["research"],
            prompt:
              typeof body.prompt === "string" && body.prompt.trim()
                ? body.prompt.trim()
                : `Mainnet escrow job ${record.jobId} (terms ${record.termsHash})`,
            deadlineSec: record.deadlineSec,
            funded: true,
          });
        }
        await repo.flushPending();
        sendJson(res, 200, {
          ok: true,
          record,
          workforceJob,
        }, reqOrigin);
        return;
      }

      // 1o. List tracked Mainnet escrow jobs
      if (method === "GET" && pathname === "/api/near/escrow/jobs") {
        sendJson(res, 200, {
          ok: true,
          jobs: escrowTracker.listRecords(),
        }, reqOrigin);
        return;
      }

      // 1p. Production Mainnet FloatPool & Vault unsigned transaction builders
      if (method === "POST" && pathname === "/api/near/float/prepare-deposit") {
        const body = await readJsonBody(req);
        const lpAccountId = String(body.lpAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, lpAccountId);
        const tx = nearRpcAdapter.prepareFloatPoolDepositPayload({
          lpAccountId,
          amountUsdcAtomic: String(body.amountUsdcAtomic || ""),
          receiverAccountId: body.receiverAccountId ? String(body.receiverAccountId) : undefined,
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/float/prepare-withdraw") {
        const body = await readJsonBody(req);
        const lpAccountId = String(body.lpAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, lpAccountId);
        const tx = nearRpcAdapter.prepareFloatPoolWithdrawPayload({
          lpAccountId,
          amountUsdcAtomic: String(body.amountUsdcAtomic || ""),
          receiverAccountId: body.receiverAccountId ? String(body.receiverAccountId) : undefined,
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/vault/prepare-accept-delivery") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerAccountId);
        const tx = nearRpcAdapter.prepareVaultAcceptDeliveryPayload({
          customerAccountId,
          jobId: String(body.jobId || ""),
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/vault/prepare-refund") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerAccountId);
        const tx = nearRpcAdapter.prepareVaultRefundPayload({
          customerAccountId,
          jobId: String(body.jobId || ""),
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/float/prepare-advance") {
        const body = await readJsonBody(req);
        const authed = assertOperatorOrAdminSession();
        const operatorAccountId = String(body.operatorAccountId || authed);
        if (authed !== operatorAccountId && !isOperatorOrAdminAccount(authed)) {
          throw new Error(`ERR_ACCOUNT_IMPERSONATION_BLOCKED: ${authed} cannot act for ${operatorAccountId}.`);
        }
        const tx = nearRpcAdapter.prepareFloatPoolRequestAdvancePayload({
          operatorAccountId,
          jobId: String(body.jobId || ""),
          expectedPrincipalAtomic: String(body.expectedPrincipalAtomic || ""),
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/vault/prepare-start-work") {
        const body = await readJsonBody(req);
        const authed = assertOperatorOrAdminSession();
        const operatorAccountId = String(body.operatorAccountId || authed);
        if (authed !== operatorAccountId && !isOperatorOrAdminAccount(authed)) {
          throw new Error(`ERR_ACCOUNT_IMPERSONATION_BLOCKED: ${authed} cannot act for ${operatorAccountId}.`);
        }
        const tx = nearRpcAdapter.prepareVaultStartWorkPayload({
          operatorAccountId,
          jobId: String(body.jobId || ""),
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/vault/prepare-submit-delivery") {
        const body = await readJsonBody(req);
        const authed = assertOperatorOrAdminSession();
        const operatorAccountId = String(body.operatorAccountId || authed);
        if (authed !== operatorAccountId && !isOperatorOrAdminAccount(authed)) {
          throw new Error(`ERR_ACCOUNT_IMPERSONATION_BLOCKED: ${authed} cannot act for ${operatorAccountId}.`);
        }
        const tx = nearRpcAdapter.prepareVaultSubmitDeliveryPayload({
          operatorAccountId,
          jobId: String(body.jobId || ""),
          deliveryHash: String(body.deliveryHash || ""),
        });
        sendJson(res, 200, { ok: true, transaction: tx }, reqOrigin, config.corsAllowedOrigin);
        return;
      }

      // ── PHASE 3: WORKFORCE EXECUTION ENGINE ───────────────────────────────
      if (method === "GET" && pathname === "/api/workforce/workers") {
        sendJson(res, 200, { ok: true, workers: workforceEngine.listWorkers() }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/workers/register") {
        const body = await readJsonBody(req);
        assertOperatorOrAdminSession();
        const worker = workforceEngine.registerWorker({
          workerId: String(body.workerId || ""),
          accountId: String(body.accountId || ""),
          displayName: String(body.displayName || ""),
          capabilities: Array.isArray(body.capabilities)
            ? body.capabilities.map(String)
            : String(body.capabilities || "").split(","),
          maxConcurrentJobs: body.maxConcurrentJobs ? Number(body.maxConcurrentJobs) : 3,
        });
        const workerToken =
          body.issueToken === true ? workforceEngine.issueWorkerToken(worker.workerId) : undefined;
        await repo.flushPending();
        sendJson(res, 200, { ok: true, worker, ...(workerToken ? { workerToken } : {}) }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/workers/availability") {
        const body = await readJsonBody(req);
        const workerId = String(body.workerId || "");
        const headerToken = getWorkerToken();
        if (!headerToken) {
          throw new Error("ERR_WORKER_AUTH_REQUIRED: Missing x-worker-token.");
        }
        workforceEngine.assertWorkerAuthorized(workerId, headerToken, config.isProductionMode);
        const worker = workforceEngine.setWorkerAvailability(
          workerId,
          Boolean(body.available)
        );
        await repo.flushPending();
        sendJson(res, 200, { ok: true, worker }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/workforce/jobs") {
        sendJson(res, 200, { ok: true, jobs: workforceEngine.listJobs() }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/workforce/jobs/discover") {
        const jobId = parsedUrl.searchParams.get("jobId") || "";
        const workers = workforceEngine.discoverWorkersForJob(jobId);
        sendJson(res, 200, { ok: true, jobId, workers }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/register") {
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        assertCustomerOrOperatorSession(customerAccountId);
        const prompt = String(body.prompt || "").trim();
        if (!prompt) {
          throw new Error("ERR_INVALID_PROMPT: Task prompt is required.");
        }
        const amountAtomic = String(body.amountAtomic || "1000000");
        const requestedFunded = Boolean(body.funded);
        const escrowTxHash = body.escrowTxHash
          ? String(body.escrowTxHash).trim()
          : body.txHash
          ? String(body.txHash).trim()
          : "";
        if (config.isProductionMode) {
          if (!requestedFunded || !escrowTxHash) {
            throw new Error(
              "ERR_ESCROW_PROOF_REQUIRED: Production job registration requires funded=true and a reconciled Mainnet escrowTxHash."
            );
          }
          const matchingEscrow = escrowTracker
            .listRecords()
            .find((e) => e.sourceTxHash === escrowTxHash);
          if (
            !matchingEscrow ||
            !matchingEscrow.onChainConfirmed ||
            matchingEscrow.escrowState !== "FINAL_CONFIRMED"
          ) {
            throw new Error(
              `ERR_ESCROW_NOT_CONFIRMED: Mainnet escrow transaction ${escrowTxHash} is not FINAL_CONFIRMED.`
            );
          }
          if (
            matchingEscrow.coreContractId !== config.mainnetCoreContractId ||
            matchingEscrow.usdcContractId !== config.mainnetUsdcContractId
          ) {
            throw new Error(
              "ERR_ESCROW_CONTRACT_MISMATCH: Escrow transaction does not match configured Mainnet Core/USDC contracts."
            );
          }
          if (matchingEscrow.customerAccountId !== customerAccountId) {
            throw new Error(
              `ERR_ESCROW_SENDER_MISMATCH: Escrow customer ${matchingEscrow.customerAccountId} does not match ${customerAccountId}.`
            );
          }
          if (BigInt(matchingEscrow.amountAtomic) < BigInt(amountAtomic)) {
            throw new Error(
              `ERR_ESCROW_AMOUNT_INSUFFICIENT: Escrow amount ${matchingEscrow.amountAtomic} is less than requested ${amountAtomic}.`
            );
          }
          const duplicateJob = workforceEngine
            .listJobs()
            .find((j) => (j as unknown as { escrowTxHash?: string }).escrowTxHash === escrowTxHash);
          if (duplicateJob) {
            throw new Error(
              `ERR_DUPLICATE_ESCROW_TX: Escrow transaction ${escrowTxHash} is already bound to job ${duplicateJob.jobId}.`
            );
          }
          if (!matchingEscrow.jobId) {
            throw new Error(
              `ERR_ESCROW_MISSING_JOB_ID: Reconciled escrow ${escrowTxHash} has no on-chain Core jobId.`
            );
          }
          const requestedJobId = String(body.jobId || "").trim();
          if (requestedJobId && requestedJobId !== matchingEscrow.jobId) {
            throw new Error(
              `ERR_JOB_ID_ESCROW_MISMATCH: Provided jobId ${requestedJobId} does not match on-chain escrow jobId ${matchingEscrow.jobId}.`
            );
          }
        }
        const resolvedJobId =
          String(body.jobId || "").trim() ||
          (config.isProductionMode
            ? escrowTracker.listRecords().find((e) => e.sourceTxHash === escrowTxHash)?.jobId || ""
            : "");
        const job = workforceEngine.registerJob({
          jobId: resolvedJobId,
          customerAccountId,
          escrowTxHash: escrowTxHash || undefined,
          amountAtomic,
          requiredCapabilities: Array.isArray(body.requiredCapabilities)
            ? body.requiredCapabilities.map(String)
            : String(body.requiredCapabilities || "research").split(","),
          prompt,
          deadlineSec: body.deadlineSec ? Number(body.deadlineSec) : Math.floor(Date.now() / 1000) + 86400,
          funded: requestedFunded,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, job }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/assign") {
        const body = await readJsonBody(req);
        assertOperatorOrAdminSession();
        const job = workforceEngine.assignJob(
          String(body.jobId || ""),
          body.workerId ? String(body.workerId) : undefined
        );
        await repo.flushPending();
        sendJson(res, 200, { ok: true, job }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/accept") {
        const body = await readJsonBody(req);
        const workerId = String(body.workerId || "");
        const headerToken = getWorkerToken();
        if (!headerToken) {
          throw new Error("ERR_WORKER_AUTH_REQUIRED: Missing x-worker-token.");
        }
        workforceEngine.assertWorkerAuthorized(workerId, headerToken, config.isProductionMode);
        const job = workforceEngine.acceptJob(
          String(body.jobId || ""),
          workerId
        );
        await repo.flushPending();
        sendJson(res, 200, { ok: true, job }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/execute") {
        const body = await readJsonBody(req);
        const workerId = String(body.workerId || "");
        const headerToken = getWorkerToken();
        if (!headerToken) {
          throw new Error("ERR_WORKER_AUTH_REQUIRED: Missing x-worker-token.");
        }
        workforceEngine.assertWorkerAuthorized(workerId, headerToken, config.isProductionMode);
        let job;
        let submission;
        try {
          job = await workforceEngine.executeJob({
            jobId: String(body.jobId || ""),
            workerId,
            aiAdapter,
            outlayerAdapter: outlayerExecAdapter,
            requireLiveOutlayer:
              config.isProductionMode && config.walletMode === "outlayer",
            maxRetries: body.maxRetries !== undefined ? Number(body.maxRetries) : 1,
            timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : 20_000,
          });
          if (job.outlayerMode === "live_outlayer" && !job.outlayerAttestationVerified) {
            throw new Error(
              "ERR_OUTLAYER_TEE_UNVERIFIED: Refusing to submit delivery before independent TEE attestation verification passes."
            );
          }
          submission =
            job.output && job.evidenceHash
              ? verificationEngine.submitDelivery({
                  jobId: job.jobId,
                  workerId: String(body.workerId || ""),
                  workerAccountId: job.assignedWorkerAccountId || "worker.near",
                  expectedWorkerId: job.assignedWorkerId || "",
                  deliverable: job.output,
                  evidenceHash: job.evidenceHash,
                  deadlineSec: job.deadlineSec,
                })
              : null;
        } finally {
          await repo.flushPending();
        }
        sendJson(res, 200, { ok: true, job, submission }, reqOrigin);
        return;
      }

      // ── PHASE 4: DELIVERY & EVIDENCE VERIFICATION ─────────────────────────
      if (method === "GET" && pathname === "/api/verification/submissions") {
        sendJson(res, 200, { ok: true, submissions: verificationEngine.listSubmissions() }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/submit") {
        const body = await readJsonBody(req);
        const workerId = String(body.workerId || "");
        const workerToken = getWorkerToken();
        if (workerToken) {
          workforceEngine.assertWorkerAuthorized(workerId, workerToken, config.isProductionMode);
        } else {
          assertOperatorOrAdminSession();
        }
        const wfJob = workforceEngine.getJob(String(body.jobId || ""));
        const submission = verificationEngine.submitDelivery({
          jobId: String(body.jobId || ""),
          workerId: String(body.workerId || ""),
          workerAccountId: String(body.workerAccountId || wfJob?.assignedWorkerAccountId || ""),
          expectedWorkerId: String(wfJob?.assignedWorkerId || body.workerId || ""),
          deliverable: (body.deliverable as Record<string, unknown>) || {},
          evidenceHash: String(body.evidenceHash || ""),
          deadlineSec: body.deadlineSec ? Number(body.deadlineSec) : (wfJob?.deadlineSec ?? Math.floor(Date.now() / 1000) + 86400),
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, submission }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/verify") {
        const body = await readJsonBody(req);
        const verifierAccountId = String(body.verifierAccountId || "");
        const wfJob = workforceEngine.getJob(String(body.jobId || ""));
        const authed = assertCustomerOrOperatorSession(wfJob?.customerAccountId || verifierAccountId);
        if (verifierAccountId && verifierAccountId !== authed) {
          throw new Error(
            `ERR_ACCOUNT_IMPERSONATION_BLOCKED: Authenticated wallet ${authed} cannot verify as ${verifierAccountId}.`
          );
        }
        const decision = String(body.decision || "") as "VERIFIED" | "REJECTED" | "DISPUTED";
        const submission = verificationEngine.verifyDelivery({
          jobId: String(body.jobId || ""),
          verifierAccountId: String(body.verifierAccountId || ""),
          decision,
          reason: body.reason ? String(body.reason) : undefined,
        });
        if (workforceEngine.getJob(submission.jobId)) {
          workforceEngine.updateJobState(
            submission.jobId,
            decision === "VERIFIED" ? "VERIFIED" : "FAILED"
          );
        }
        await repo.flushPending();
        sendJson(res, 200, { ok: true, submission }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/prepare-audit-anchor") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const wfJob = workforceEngine.getJob(jobId);
        const walletToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        const initiator = String(
          body.initiatorAccountId || body.payerAccountId || config.mainnetAuditOperatorAccountId
        );
        walletSessionManager.assertAuthorizedCustomer(walletToken, initiator);
        const anchorPlan = await verificationEngine.prepareAuditAnchorTx(nearRpcAdapter, config, {
          jobId,
          payerAccountId: String(body.payerAccountId || config.mainnetAuditOperatorAccountId),
          initiatorAccountId: initiator,
          authorizedCustomerAccountId: wfJob?.customerAccountId || config.customerAccountId,
          eventRoot: body.eventRoot ? String(body.eventRoot) : undefined,
          paymentReceiptRoot: body.paymentReceiptRoot ? String(body.paymentReceiptRoot) : undefined,
          completedAtSec: typeof body.completedAtSec === "number" ? body.completedAtSec : undefined,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, anchorPlan }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/submit-audit-anchor") {
        const body = await readJsonBody(req);
        const signerAccountId = String(
          body.signerAccountId || config.mainnetAuditOperatorAccountId
        );
        const walletToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(walletToken, signerAccountId);
        if (signerAccountId !== config.mainnetAuditOperatorAccountId) {
          throw new Error(
            `ERR_NOT_OPERATOR_AUTHORITY: Only operator ${config.mainnetAuditOperatorAccountId} can submit AuditAnchor transactions.`
          );
        }
        const submission = verificationEngine.recordAnchorSubmission({
          jobId: String(body.jobId || ""),
          txHash: String(body.txHash || ""),
          signerAccountId,
          contractId: config.mainnetAuditContractId,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, submission }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/reconcile-audit-anchor") {
        const body = await readJsonBody(req);
        const requesterAccountId = String(
          body.signerAccountId || config.mainnetAuditOperatorAccountId
        );
        const walletToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(walletToken, requesterAccountId);
        const reconciliation = await verificationEngine.reconcileAuditAnchorTx(
          nearRpcAdapter,
          config,
          {
            jobId: String(body.jobId || ""),
            txHash: body.txHash ? String(body.txHash) : undefined,
            signerAccountId: body.signerAccountId ? String(body.signerAccountId) : undefined,
          }
        );
        await repo.flushPending();
        sendJson(res, 200, { ok: true, ...reconciliation }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/verification/recover-anchors") {
        const walletToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(
          walletToken,
          config.mainnetAuditOperatorAccountId
        );
        const recovery = await verificationEngine.recoverInterruptedAnchors(
          nearRpcAdapter,
          config
        );
        await repo.flushPending();
        sendJson(
          res,
          200,
          { ok: true, recovery, submissions: verificationEngine.listSubmissions() },
          reqOrigin
        );
        return;
      }

      // ── PHASE 5: SETTLEMENT & PAYOUTS ─────────────────────────────────────
      if (method === "GET" && pathname === "/api/settlement/list") {
        sendJson(res, 200, { ok: true, settlements: settlementEngine.listSettlements() }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/settlement/history") {
        const all = settlementEngine.listPaymentHistory();
        const rawLimit = Number(parsedUrl.searchParams.get("limit") || 50);
        const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 50;
        const rawCursor = Number(parsedUrl.searchParams.get("cursor") || 0);
        const cursor = Number.isFinite(rawCursor) && rawCursor >= 0 ? Math.trunc(rawCursor) : 0;
        const page = all.slice(cursor, cursor + limit);
        const nextCursor = cursor + page.length < all.length ? String(cursor + page.length) : null;
        sendJson(res, 200, { ok: true, history: page, limit, cursor, nextCursor, total: all.length }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/settlement/prepare") {
        assertAuthenticatedSession();
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "").trim();
        if (!jobId) {
          throw new Error("ERR_INVALID_JOB_ID: jobId is required.");
        }
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) {
          throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        }
        if (
          body.customerAccountId &&
          String(body.customerAccountId) !== wfJob.customerAccountId
        ) {
          throw new Error(
            `ERR_CUSTOMER_MISMATCH: Customer ${String(body.customerAccountId)} does not match job owner ${wfJob.customerAccountId}.`
          );
        }
        const customerAccountId = wfJob.customerAccountId;
        const sessionAccountId = assertCustomerOrOperatorSession(customerAccountId);
        const kind = String(body.kind || "PAYOUT_ACCEPT_DELIVERY") as
          | "PAYOUT_ACCEPT_DELIVERY"
          | "CUSTOMER_REFUND";
        let settlement;
        if (kind === "CUSTOMER_REFUND") {
          const reason = String(body.refundReason || "CUSTOMER_REJECTED") as RefundReason;
          const adv = floatOrchestrator.getAdvanceByJob(jobId);
          settlement = settlementEngine.prepareRefund(config, {
            jobId,
            refundReason: reason,
            jobState: wfJob.state,
            customerAccountId,
            operatorAccountId: config.mainnetOperatorAccountId,
            grossAmountAtomic: wfJob.amountAtomic,
            deadlineSec: body.deadlineSec !== undefined ? Number(body.deadlineSec) : undefined,
            callerIsOperatorOrAdmin: isOperatorOrAdminAccount(sessionAccountId),
            floatPrincipalAtomic: adv?.status === "ISSUED" ? adv.principalAtomic : "0",
          });
        } else {
          const sub = verificationEngine.getSubmission(jobId);
          if (!sub) {
            throw new Error(`ERR_DELIVERY_NOT_FOUND: No delivery submission for ${jobId}`);
          }
          settlement = settlementEngine.prepareSettlement(config, {
            jobId,
            kind,
            verificationStatus: sub.verificationStatus,
            customerAccountId,
            workerAccountId: wfJob.assignedWorkerAccountId || sub.workerAccountId,
            grossAmountAtomic: wfJob.amountAtomic,
            platformFeeBps: 0,
          });
        }
        await repo.flushPending();
        sendJson(res, 200, { ok: true, settlement }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/settlement/prepare-refund") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "").trim();
        if (!jobId) throw new Error("ERR_INVALID_JOB_ID: jobId is required.");
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        const sessionAccountId = assertCustomerOrOperatorSession(wfJob.customerAccountId);
        const reason = String(body.refundReason || "NO_DELIVERY_EXPIRED") as RefundReason;
        const adv = floatOrchestrator.getAdvanceByJob(jobId);
        const settlement = settlementEngine.prepareRefund(config, {
          jobId,
          refundReason: reason,
          jobState: wfJob.state,
          customerAccountId: wfJob.customerAccountId,
          operatorAccountId: config.mainnetOperatorAccountId,
          grossAmountAtomic: wfJob.amountAtomic,
          deadlineSec: body.deadlineSec !== undefined ? Number(body.deadlineSec) : undefined,
          callerIsOperatorOrAdmin: isOperatorOrAdminAccount(sessionAccountId),
          floatPrincipalAtomic: adv?.status === "ISSUED" ? adv.principalAtomic : "0",
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, settlement }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/near/float/evaluate") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "").trim();
        if (!jobId) throw new Error("ERR_INVALID_JOB_ID: jobId is required.");
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        assertCustomerOrOperatorSession(wfJob.customerAccountId);
        const escrow = escrowTracker.listRecords().find((j) => j.jobId === jobId);
        const advance = await floatOrchestrator.evaluateAndPrepareFromChain(config, nearRpcAdapter, {
          jobId,
          customerAccountId: wfJob.customerAccountId,
          operatorAccountId: config.mainnetOperatorAccountId,
          escrowConfirmed: Boolean(escrow?.escrowState === "FINAL_CONFIRMED" || wfJob.state !== "CREATED"),
        });
        sendJson(res, 200, { ok: true, advance }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/deliverables/") && pathname.endsWith("/preview")) {
        const parts = pathname.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        const sessionAccountId = assertAuthenticatedSession();
        if (sessionAccountId !== wfJob.customerAccountId) {
          throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Only the job customer may preview deliverable.");
        }
        const preview = deliverableVault.getCustomerPreview(jobId, sessionAccountId);
        sendJson(res, 200, { ok: true, preview }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/deliverables/") && pathname.endsWith("/reject")) {
        const parts = pathname.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const body = await readJsonBody(req);
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        const sessionAccountId = assertAuthenticatedSession();
        if (sessionAccountId !== wfJob.customerAccountId) {
          throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Only the job customer may reject deliverable.");
        }
        const reason = String(body.reason || "Customer rejected preview").trim() || "Customer rejected preview";
        const deliverable = deliverableVault.markRejected(jobId, sessionAccountId, reason);
        workforceEngine.updateJobState(jobId, "REJECTED");
        const adv = floatOrchestrator.getAdvanceByJob(jobId);
        const refundSettlement = settlementEngine.prepareRefund(config, {
          jobId,
          refundReason: "CUSTOMER_REJECTED",
          jobState: "REJECTED",
          customerAccountId: wfJob.customerAccountId,
          operatorAccountId: config.mainnetOperatorAccountId,
          grossAmountAtomic: wfJob.amountAtomic,
          callerIsOperatorOrAdmin: false,
          floatPrincipalAtomic: adv?.status === "ISSUED" ? adv.principalAtomic : "0",
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, deliverable: { status: deliverable.status, rejectionReason: deliverable.rejectionReason }, refundSettlement }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/deliverables/") && pathname.endsWith("/download-token")) {
        const parts = pathname.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        const sessionAccountId = assertAuthenticatedSession();
        if (sessionAccountId !== wfJob.customerAccountId) {
          throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Only the job customer may request download.");
        }
        const settlement = settlementEngine.getSettlementByJob(jobId);
        const signed = deliverableVault.issueSignedDownloadToken({
          jobId,
          customerAccountId: sessionAccountId,
          jobState: wfJob.state,
          settlementConfirmed: Boolean(settlement?.status === "CONFIRMED" && settlement?.onChainConfirmed),
          settlementKind: settlement?.kind || "",
        });
        sendJson(res, 200, { ok: true, ...signed }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/deliverables/") && pathname.endsWith("/download")) {
        const parts = pathname.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const token = parsedUrl.searchParams.get("token") || "";
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        const sessionAccountId = assertAuthenticatedSession();
        const settlement = settlementEngine.getSettlementByJob(jobId);
        const { record, content } = await deliverableVault.verifyAndReadFullDeliverableAsync({
          token,
          callerCustomerAccountId: sessionAccountId,
          jobState: wfJob.state,
          settlementConfirmed: Boolean(settlement?.status === "CONFIRMED" && settlement?.onChainConfirmed),
          singleUse: true,
        });
        res.writeHead(200, {
          "Content-Type": record.mimeType,
          "Content-Disposition": `attachment; filename="${record.filename}"`,
          "X-Content-Hash": record.contentHash,
          "Cache-Control": "no-store",
        });
        res.end(content);
        return;
      }

      if (method === "GET" && pathname === "/api/monitoring/health") {
        const stuckJobs = workforceEngine.listJobs().filter((j) => j.state === "EXECUTING" || j.state === "ASSIGNED");
        const pendingAdvs = floatOrchestrator.listAdvances().filter((a) => a.status === "PENDING");
        sendJson(
          res,
          200,
          {
            ok: true,
            monitoring: monitoring.snapshot({
              stuckJobsCount: stuckJobs.length,
              pendingAdvancesCount: pendingAdvs.length,
            }),
          },
          reqOrigin
        );
        return;
      }

      if (method === "POST" && pathname === "/api/settlement/submit-tx") {
        const body = await readJsonBody(req);
        const signerAccountId = String(body.signerAccountId || "");
        assertCustomerOrOperatorSession(signerAccountId);
        const settlement = settlementEngine.submitSettlementTx({
          settlementId: String(body.settlementId || ""),
          txHash: String(body.txHash || ""),
          signerAccountId: String(body.signerAccountId || ""),
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, settlement }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/settlement/reconcile") {
        const body = await readJsonBody(req);
        const existing = settlementEngine.listSettlements().find(
          (s) => s.settlementId === String(body.settlementId || "")
        );
        assertCustomerOrOperatorSession(existing?.customerAccountId);
        const settlement = await settlementEngine.reconcileSettlementTx(nearRpcAdapter, {
          settlementId: String(body.settlementId || ""),
          txHash: String(body.txHash || ""),
        });
        if (settlement.status === "CONFIRMED" && settlement.onChainConfirmed) {
          const wfJob = workforceEngine.getJob(settlement.jobId);
          if (wfJob) {
            if (settlement.kind === "PAYOUT_ACCEPT_DELIVERY") {
              workforceEngine.updateJobState(settlement.jobId, "SETTLED");
              if (wfJob.assignedWorkerId) {
                workforceEngine.creditWorkerEarnings(
                  wfJob.assignedWorkerId,
                  settlement.workerPayoutAtomic
                );
              }
            } else if (settlement.kind === "CUSTOMER_REFUND") {
              workforceEngine.updateJobState(settlement.jobId, "REFUNDED");
            }
          }
        }
        await repo.flushPending();
        sendJson(res, 200, { ok: true, settlement }, reqOrigin);
        return;
      }

      // ── PHASE 6: OUTLAYER EXECUTION ADAPTER ───────────────────────────────
      if (method === "GET" && pathname === "/api/outlayer/requests") {
        sendJson(res, 200, { ok: true, requests: outlayerExecAdapter.listRequests() }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/outlayer/config-status") {
        sendJson(
          res,
          200,
          { ok: true, outlayer: outlayerExecAdapter.validateConfiguration() },
          reqOrigin
        );
        return;
      }

      if (method === "POST" && pathname === "/api/settlement/prepare-claim") {
        const authToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        const body = await readJsonBody(req);
        const claimantAccountId = String(body.claimantAccountId || "");
        walletSessionManager.assertAuthorizedCustomer(authToken, claimantAccountId);
        const preparedTransaction = settlementEngine.prepareClaimUsdcTransaction(config, {
          claimantAccountId,
          amountAtomic: body.amountAtomic ? String(body.amountAtomic) : undefined,
          recipientAccountId: body.recipientAccountId
            ? String(body.recipientAccountId)
            : undefined,
        });
        sendJson(res, 200, { ok: true, preparedTransaction }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/outlayer/execute") {
        const workerToken = getWorkerToken();
        if (!workerToken) {
          assertOperatorOrAdminSession();
        }
        const body = await readJsonBody(req);
        const workerId = String(body.workerId || "").trim();
        const jobId = String(body.jobId || "").trim();
        if (!jobId) {
          throw new Error("ERR_INVALID_JOB_ID: jobId is required.");
        }
        if (!workerId) {
          throw new Error("ERR_INVALID_WORKER_ID: workerId is required.");
        }
        const wfJob = workforceEngine.getJob(jobId);
        if (!wfJob) {
          throw new Error(`ERR_UNKNOWN_JOB: Workforce job ${jobId} does not exist.`);
        }
        if (!wfJob.assignedWorkerId || wfJob.assignedWorkerId !== workerId) {
          throw new Error(
            `ERR_WORKER_NOT_ASSIGNED: Worker ${workerId} is not assigned to job ${jobId}.`
          );
        }
        if (workerToken) {
          workforceEngine.assertWorkerAuthorized(workerId, workerToken, config.isProductionMode);
        }
        const record = await outlayerExecAdapter.executeAndVerify({
          jobId,
          workerId,
          prompt: String(body.prompt || ""),
          evidenceHash: String(body.evidenceHash || "0x" + "11".repeat(32)),
          asyncMode: Boolean(body.asyncMode),
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/outlayer/poll") {
        const body = await readJsonBody(req);
        assertAuthenticatedSession();
        const record = await outlayerExecAdapter.pollCall(String(body.requestId || ""));
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/outlayer/verify-attestation") {
        const body = await readJsonBody(req);
        assertAuthenticatedSession();
        const record = await outlayerExecAdapter.verifyAttestation(String(body.requestId || ""));
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/outlayer/verify-public") {
        const body = await readJsonBody(req);
        const result = await outlayerExecAdapter.verifyPublicAttestationByCallId(
          String(body.callId || ""),
          {
            expectedWasmHash: body.expectedWasmHash ? String(body.expectedWasmHash) : undefined,
            expectedInputHash: body.expectedInputHash ? String(body.expectedInputHash) : undefined,
            expectedOutputHash: body.expectedOutputHash ? String(body.expectedOutputHash) : undefined,
          }
        );
        sendJson(res, 200, { ok: true, ...result }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/reassign") {
        const body = await readJsonBody(req);
        assertOperatorOrAdminSession();
        const job = workforceEngine.reassignJob(
          String(body.jobId || ""),
          body.workerId ? String(body.workerId) : undefined
        );
        await repo.flushPending();
        sendJson(res, 200, { ok: true, job }, reqOrigin);
        return;
      }

      // ── PHASE 9.1: NEAR INTENTS 1CLICK CROSS-CHAIN USDC FUNDING ───────────
      if (method === "GET" && pathname === "/api/intents/tokens") {
        const forceRefresh = parsedUrl.searchParams.get("refresh") === "true";
        const discovered = await intentsClient.fetchSupportedTokens(forceRefresh);
        sendJson(res, 200, { ok: true, ...discovered }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/intents/list") {
        sendJson(res, 200, { ok: true, intents: intentsClient.listIntents() }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/quote") {
        const body = await readJsonBody(req);
        const dry = body.dry !== undefined ? Boolean(body.dry) : true;
        const customerNearAccount = String(body.customerNearAccount || "");
        if (!dry) {
          const token =
            typeof req.headers["x-wallet-session"] === "string"
              ? req.headers["x-wallet-session"]
              : undefined;
          walletSessionManager.assertAuthorizedCustomer(token, customerNearAccount);
        }
        const resQuote = await intentsClient.requestQuote(nearRpcAdapter, {
          dry,
          originAsset: String(body.originAsset || ""),
          amountAtomic: String(body.amountAtomic || ""),
          slippageToleranceBps: Number(body.slippageToleranceBps || 100),
          customerNearAccount,
          sourceWalletAddress: String(body.sourceWalletAddress || ""),
          deadlineIso: body.deadlineIso ? String(body.deadlineIso) : undefined,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, ...resQuote }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/deposit-submit") {
        const body = await readJsonBody(req);
        const customerNearAccount = String(body.customerNearAccount || "");
        const token =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(token, customerNearAccount);
        const record = await intentsClient.submitDepositTx({
          depositAddress: String(body.depositAddress || ""),
          txHash: String(body.txHash || ""),
          customerNearAccount,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/widget-quote") {
        const body = await readJsonBody(req);
        const recipient = String(body.recipient || body.refundTo || "").trim();
        if (recipient) {
          assertCustomerOrOperatorSession(recipient);
        } else {
          assertAuthenticatedSession();
        }
        const result = await intentsClient.proxyWidgetQuote(nearRpcAdapter, body);
        if (result.record) {
          await repo.flushPending();
        }
        sendJson(res, 200, { ok: true, ...result }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/intents/widget-api/api/tokens/")) {
        const discovered = await intentsClient.fetchSupportedTokens(false);
        sendJson(res, 200, { asset_stats: [], tokens: discovered.tokens || [] }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/intents/widget-api/api/incidents/")) {
        sendJson(res, 200, [], reqOrigin);
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/intents/widget-api/api/status/")) {
        const depositAddress = parsedUrl.searchParams.get("depositAddress") || "";
        const record = await intentsClient.pollStatus(depositAddress);
        await repo.flushPending();
        sendJson(res, 200, {
          status: record.status,
          swapDetails: (record as { swapDetails?: Record<string, unknown> }).swapDetails || {},
          updatedAt: record.updatedAt,
        }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/intents/widget-api/rpc/")) {
        assertAuthenticatedSession();
        const body = await readJsonBody(req);
        const rpcMethod = String(body.method || "").trim();
        const ALLOWED_WIDGET_RPC_METHODS = new Set([
          "query",
          "block",
          "gas_price",
          "tx",
          "EXPERIMENTAL_tx_status",
          "status",
          "network_info",
        ]);
        if (!ALLOWED_WIDGET_RPC_METHODS.has(rpcMethod)) {
          throw new Error(`ERR_RPC_METHOD_FORBIDDEN: RPC method "${rpcMethod}" is not allowed on widget proxy.`);
        }
        const rpcResp = await fetch(config.nearRpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const rpcJson = (await rpcResp.json().catch(() => ({}))) as Record<string, unknown>;
        sendJson(res, rpcResp.status, rpcJson, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/intents/status") {
        const depositAddress = parsedUrl.searchParams.get("depositAddress") || "";
        const record = await intentsClient.pollStatus(depositAddress);
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/verify-destination") {
        const body = await readJsonBody(req);
        const depositAddress = String(body.depositAddress || "");
        const existingIntent = intentsClient
          .listIntents()
          .find((i) => i.depositAddress === depositAddress);
        const expectedCustomer = String(
          body.customerNearAccount ||
            existingIntent?.customerNearAccount ||
            body.expectedRecipient ||
            ""
        );
        walletSessionManager.assertAuthorizedCustomer(getWalletToken(), expectedCustomer);
        const record = await intentsClient.verifyDestinationDelivery(nearRpcAdapter, {
          depositAddress,
          expectedRecipient: String(body.expectedRecipient || ""),
          expectedTokenContract: body.expectedTokenContract
            ? String(body.expectedTokenContract)
            : undefined,
        });
        await repo.flushPending();
        sendJson(res, 200, { ok: true, record }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/prepare-deposit") {
        const body = await readJsonBody(req);
        const depositAddress = String(body.depositAddress || "");
        const existingIntent = intentsClient
          .listIntents()
          .find((i) => i.depositAddress === depositAddress);
        const expectedCustomer = String(
          body.customerNearAccount || existingIntent?.customerNearAccount || ""
        );
        walletSessionManager.assertAuthorizedCustomer(getWalletToken(), expectedCustomer);
        const depositPlan = intentsClient.prepareSourceWalletDeposit(depositAddress);
        sendJson(res, 200, { ok: true, depositPlan }, reqOrigin);
        return;
      }

      if (method === "POST" && pathname === "/api/intents/prepare-escrow") {
        const authToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        const body = await readJsonBody(req);
        const customerAccountId = String(body.customerAccountId || "");
        walletSessionManager.assertAuthorizedCustomer(
          authToken,
          customerAccountId
        );
        const depositAddress = String(body.depositAddress || "");
        const prepared = intentsClient.prepareCoreEscrowFromIntent(nearRpcAdapter, {
          depositAddress,
          workerAccountId: String(body.workerAccountId || config.mainnetOperatorAccountId),
          deadlineSec: Number(body.deadlineSec || Math.floor(Date.now() / 1000) + 86_400),
          termsHash: String(body.termsHash || "0x" + "00".repeat(32)),
          expectedCustomerAccount: customerAccountId,
        });
        await repo.flushPending();
        sendJson(
          res,
          200,
          { ok: true, verifiedAccountId: customerAccountId, ...prepared },
          reqOrigin
        );
        return;
      }

      if (method === "POST" && pathname === "/api/workforce/jobs/cancel") {
        const authToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const existingJob = workforceEngine.getJob(jobId);
        if (!existingJob) {
          throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
        }
        walletSessionManager.assertAuthorizedCustomer(
          authToken,
          existingJob.customerAccountId
        );
        const job = workforceEngine.cancelJob(jobId);
        await repo.flushPending();
        sendJson(res, 200, { ok: true, job }, reqOrigin);
        return;
      }

      // ── PHASE 10.1, 10.5 & 16: DATABASE, AI & AGGREGATE HEALTH ──────────────
      if (method === "GET" && pathname === "/api/ai/status") {
        const ai = await aiAdapter.probeProviderHealth();
        sendJson(res, 200, { ok: true, ai }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        const [database, ai] = await Promise.all([
          repo.healthCheck(),
          aiAdapter.probeProviderHealth(),
        ]);
        const outlayer = outlayerExecAdapter.validateConfiguration();
        const escrows = escrowTracker.listRecords();
        const submissions = verificationEngine.listSubmissions();
        const settlements = settlementEngine.listSettlements();
        const outlayerRequests = outlayerExecAdapter.listRequests();
        const recovery = {
          pendingEscrows: escrows.filter(
            (e) => e.escrowState === "PENDING" || e.escrowState === "UNKNOWN_NEEDS_RECONCILIATION"
          ).length,
          pendingAnchors: submissions.filter(
            (s) => s.anchorStatus === "SUBMITTED" || s.anchorStatus === "PENDING"
          ).length,
          failedAnchors: submissions.filter((s) => s.anchorStatus === "FAILED").length,
          pendingSettlements: settlements.filter(
            (s) => s.status === "PENDING" || s.status === "FAILED_CALLBACK_RECOVERABLE"
          ).length,
          failedSettlements: settlements.filter((s) => s.status === "FAILED").length,
          failedOutlayerCalls: outlayerRequests.filter(
            (r) => r.status === "EXECUTION_FAILED" || r.status === "ATTESTATION_FAILED"
          ).length,
        };
        sendJson(
          res,
          200,
          {
            ok: true,
            restrictedBetaMode: config.restrictedBetaMode,
            uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
            network: config.network,
            isProductionMode: config.isProductionMode,
            allowSandboxDemoEndpoints: config.allowSandboxDemoEndpoints,
            liveTxBroadcastingEnabled: config.liveTxBroadcastingEnabled,
            database,
            ai,
            outlayer,
            metrics: { ...metrics },
            recovery,
          },
          reqOrigin,
          undefined,
          correlationId
        );
        return;
      }

      if (method === "GET" && pathname === "/api/metrics") {
        const escrows = escrowTracker.listRecords();
        const submissions = verificationEngine.listSubmissions();
        const settlements = settlementEngine.listSettlements();
        const outlayerRequests = outlayerExecAdapter.listRequests();
        const jobs = workforceEngine.listJobs();
        const workers = workforceEngine.listWorkers();
        sendJson(
          res,
          200,
          {
            ok: true,
            restrictedBetaMode: config.restrictedBetaMode,
            uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
            requests: { ...metrics },
            counts: {
              workers: workers.length,
              jobs: jobs.length,
              escrows: escrows.length,
              submissions: submissions.length,
              settlements: settlements.length,
              outlayerRequests: outlayerRequests.length,
              pendingEscrows: escrows.filter(
                (e) => e.escrowState === "PENDING" || e.escrowState === "UNKNOWN_NEEDS_RECONCILIATION"
              ).length,
              pendingAnchors: submissions.filter(
                (s) => s.anchorStatus === "SUBMITTED" || s.anchorStatus === "PENDING"
              ).length,
              failedAnchors: submissions.filter((s) => s.anchorStatus === "FAILED").length,
              pendingSettlements: settlements.filter(
                (s) => s.status === "PENDING" || s.status === "FAILED_CALLBACK_RECOVERABLE"
              ).length,
              failedSettlements: settlements.filter((s) => s.status === "FAILED").length,
              failedOutlayerCalls: outlayerRequests.filter(
                (r) => r.status === "EXECUTION_FAILED" || r.status === "ATTESTATION_FAILED"
              ).length,
            },
          },
          reqOrigin,
          undefined,
          correlationId
        );
        return;
      }

      if (method === "GET" && pathname === "/api/routes/policy") {
        sendJson(
          res,
          200,
          {
            ok: true,
            isProductionMode: config.isProductionMode,
            allowSandboxDemoEndpoints: config.allowSandboxDemoEndpoints,
            policy: PRODUCTION_ROUTE_POLICY,
          },
          reqOrigin,
          config.corsAllowedOrigin
        );
        return;
      }

      if (method === "GET" && pathname === "/api/database/health") {
        const health = await repo.healthCheck();
        sendJson(res, 200, { ok: true, health }, reqOrigin);
        return;
      }

      if (method === "GET" && pathname === "/api/audit/status") {
        const contractState = await nearRpcAdapter.inspectAuditContractState(
          config.mainnetAuditContractId
        );
        sendJson(
          res,
          200,
          {
            ok: true,
            contractState,
            submissions: verificationEngine.listSubmissions(),
          },
          reqOrigin
        );
        return;
      }

      if (method === "GET" && pathname === "/api/audit/readiness") {
        const wasmPath = path.resolve(
          __dirname,
          "..",
          "..",
          "near",
          "artifacts",
          "ci-mvp",
          "snapfall_audit.wasm"
        );
        let wasmExists = false;
        let wasmBytes = 0;
        let wasmSha256 = "";
        if (fs.existsSync(wasmPath)) {
          const buf = fs.readFileSync(wasmPath);
          wasmExists = true;
          wasmBytes = buf.length;
          wasmSha256 = crypto.createHash("sha256").update(buf).digest("hex");
        }
        const expectedSha256 =
          "88b1c550b639c31f9fede0cbc305bbb2fbb26389c942e28e2f79bbddfb9c13e1";
        const parentAccount = await nearRpcAdapter.inspectMainnetAccount(
          config.mainnetAdminAccountId
        );
        const auditAccount = await nearRpcAdapter.inspectMainnetAccount(
          config.mainnetAuditContractId
        );
        const auditContractState = auditAccount.exists
          ? await nearRpcAdapter.inspectAuditContractState(config.mainnetAuditContractId)
          : null;
        const requiredNear = 1.5;
        const parentNear = Number(parentAccount.amountNear || "0");
        const sufficientFunds = parentNear >= requiredNear;
        sendJson(
          res,
          200,
          {
            ok: true,
            wasmArtifact: {
              path: "near/artifacts/ci-mvp/snapfall_audit.wasm",
              exists: wasmExists,
              bytes: wasmBytes,
              sha256: wasmSha256,
              matchesCiExpected: wasmBytes === 131338 && wasmSha256 === expectedSha256,
            },
            mainnet: {
              parentAccountId: config.mainnetAdminAccountId,
              parentNearBalance: parentAccount.amountNear,
              auditAccountId: config.mainnetAuditContractId,
              auditAccountExists: auditAccount.exists,
              auditContractState,
              requiredNearForDeployment: requiredNear.toFixed(2),
              storageStakeNear: "1.32",
              gasReserveNear: "0.18",
              publicKeyPermissions: "FullAccess key generated for audit.cryptozax.near (stored locally in gitignored keystore; never committed).",
              sufficientFunds,
              shortfallNear: sufficientFunds
                ? "0.0000"
                : Math.max(0, requiredNear - parentNear).toFixed(4),
              postDeploymentChecks: [
                `view ${config.mainnetAuditContractId} get_anchor '{"job_id":"0x${"0".repeat(64)}"}'`,
                `view_state ${config.mainnetAuditContractId} STATE (core_contract=${config.mainnetCoreContractId}, operator_authority=${config.mainnetAuditOperatorAccountId}, admin=${config.mainnetAdminAccountId})`,
              ],
              rollbackAndRecovery: [
                "Do not call DeleteAccount until any anchored audit state is backed up.",
                "If init fails or wrong WASM was deployed, re-deploy snapfall_audit.wasm to audit.cryptozax.near using its FullAccess key.",
                "To recover remaining NEAR if aborting before use, DeleteAccount with beneficiary cryptozax.near.",
              ],
              proposedSequence: [
                {
                  step: 1,
                  signerId: config.mainnetAdminAccountId,
                  receiverId: config.mainnetAuditContractId,
                  actions: [
                    "CreateAccount",
                    "Transfer(2.00 NEAR)",
                    "AddKey(FullAccess)",
                    "DeployContract(snapfall_audit.wasm, 131,338 bytes)",
                    `FunctionCall(new({ admin: "${config.mainnetAdminAccountId}", core_contract: "${config.mainnetCoreContractId}" }))`,
                  ],
                },
              ],
            },
          },
          reqOrigin
        );
        return;
      }

      // Production gate: reject sandbox/demo/reset routes by default in production mode
      // Note: /api/approvals/decide remains enabled in production (with operator wallet-session auth).
      const isSandboxDemoRoute =
        pathname === "/api/reset" ||
        pathname.startsWith("/api/jobs/") ||
        pathname === "/api/audit/anchor" ||
        pathname.startsWith("/api/float/") ||
        pathname.startsWith("/api/demo/");
      if (isSandboxDemoRoute && !config.allowSandboxDemoEndpoints) {
        sendJson(
          res,
          403,
          {
            ok: false,
            error:
              "ERR_SANDBOX_ENDPOINT_DISABLED_IN_PRODUCTION: Sandbox and demo endpoints are disabled in production mode.",
          },
          reqOrigin,
          config.corsAllowedOrigin
        );
        return;
      }

      // 2. Reset sandbox state
      if (method === "POST" && pathname === "/api/reset") {
        engine.seedInitialState();
        sendJson(res, 200, {
          ok: true,
          message: "Sandbox state reset to clean initial balances and $5,000 FloatPool liquidity.",
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 3. Step 2 (& optionally Step 3): Create Job
      if (method === "POST" && pathname === "/api/jobs/create") {
        const body = await readJsonBody(req);
        const creator = String(body.creator || config.customerAccountId);
        const customer = String(body.customer || config.customerAccountId);
        const operator = String(body.operator || config.operatorAccountId);
        const title = String(
          body.title || "NEAR DeFi Float & Storage Security Verification"
        );
        const taskDescription = String(
          body.taskDescription ||
          "Execute autonomous verification of NEAR protocol liquidity metrics, query market depth feeds under OutLayer spending policy, and generate a cryptographic deliverable hash for AuditAnchor."
        );
        const customerPaymentUsdc = BigInt(String(body.customerPaymentUsdc || "100000000")); // default $100.00 USDC
        const maxOperatingBudgetUsdc = BigInt(
          String(body.maxOperatingBudgetUsdc || "25000000")
        ); // default $25.00 USDC
        const fundImmediately = Boolean(body.fundImmediately ?? false);

        const job = engine.createJob({
          creator,
          customer,
          operator,
          title,
          taskDescription,
          customerPaymentUsdc,
          maxOperatingBudgetUsdc,
          termsHash: body.termsHash ? String(body.termsHash) : undefined,
          fundImmediately,
        });

        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 4. Step 3: Fund Job
      if (method === "POST" && pathname === "/api/jobs/fund") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const job = engine.fundJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 5. Cancel unfunded Created job (verifies AUD-01 / Decision 2 Option A)
      if (method === "POST" && pathname === "/api/jobs/cancel") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const result = engine.cancelJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 6. FloatPool Working Capital Advance for a funded job
      if (method === "POST" && pathname === "/api/jobs/advance") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const amountUsdc = BigInt(String(body.amountUsdc || "20000000")); // default $20.00 USDC
        const advance = engine.requestAdvance(jobId, caller, amountUsdc);
        sendJson(res, 200, {
          ok: true,
          advance,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 7. Step 5: Operator / AI Daemon receives job & starts work
      if (method === "POST" && pathname === "/api/jobs/start") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const job = engine.startWork(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 8. Step 7: Worker requests controlled spending via OutLayer Policy Adapter
      if (method === "POST" && pathname === "/api/jobs/spend") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const vendor = String(body.vendor || "Pyth / NEAR Indexer Telemetry Feed");
        const description = String(
          body.description || "Real-time orderbook & storage trie snapshot query"
        );
        const amountUsdc = BigInt(String(body.amountUsdc || "40000")); // default $0.04 USDC
        const result = policyAdapter.requestSpend({
          jobId,
          caller,
          vendor,
          description,
          amountUsdc,
        });
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 9. Step 8: Human Operator decides an escalated approval request
      if (method === "POST" && pathname === "/api/approvals/decide") {
        const body = await readJsonBody(req);
        const approvalId = String(body.approvalId || "");
        const decidedBy = String(
          body.decidedBy ||
            (config.isProductionMode ? config.mainnetAdminAccountId : config.operatorAccountId)
        );
        const walletToken =
          typeof req.headers["x-wallet-session"] === "string"
            ? req.headers["x-wallet-session"]
            : undefined;
        walletSessionManager.assertAuthorizedCustomer(walletToken, decidedBy);
        if (config.isProductionMode) {
          if (
            decidedBy !== config.mainnetAdminAccountId &&
            decidedBy !== config.mainnetAuditOperatorAccountId
          ) {
            throw new Error(
              `ERR_NOT_OPERATOR_AUTHORITY: Only authorized operator (${config.mainnetAdminAccountId}) can decide approvals in production.`
            );
          }
        }
        const decision =
          String(body.decision || "APPROVE").toUpperCase() === "REJECT"
            ? "REJECT"
            : "APPROVE";
        const note = body.note ? String(body.note) : undefined;
        const result = policyAdapter.decideApproval({
          approvalId,
          decidedBy,
          decision,
          note,
        });
        sendJson(res, 200, {
          ok: true,
          result,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 10. Step 6 & Step 9: AI Worker executes the task & submits result + evidence hash
      if (method === "POST" && pathname === "/api/jobs/execute-and-deliver") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.operatorAccountId);
        const job = engine.jobs.get(jobId);
        if (!job) throw new Error("ERR_JOB_NOT_FOUND");
        if (job.state === "Funded") {
          engine.startWork(jobId, caller);
        }
        const aiExecution = await aiAdapter.executeJobTask(job);
        const updatedJob = engine.submitDelivery({
          jobId,
          caller,
          deliveryHash: aiExecution.deliveryHash,
          aiExecution,
        });
        sendJson(res, 200, {
          ok: true,
          aiExecution,
          job: updatedJob,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 11. Step 10 & Step 11: Customer accepts delivery -> Settlement accounting executes
      if (method === "POST" && pathname === "/api/jobs/accept") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const job = engine.acceptDelivery(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          job,
          settlement: job.settlement,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 12. Step 12: AuditAnchor verifies delivery state on Core & records immutable anchor
      if (method === "POST" && pathname === "/api/audit/anchor") {
        const body = await readJsonBody(req);
        const jobId = String(body.jobId || "");
        const caller = String(body.caller || config.customerAccountId);
        const anchor = engine.anchorJob(jobId, caller);
        sendJson(res, 200, {
          ok: true,
          anchor,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 13. FloatPool LP Deposit & Withdraw endpoints
      if (method === "POST" && pathname === "/api/float/deposit") {
        const body = await readJsonBody(req);
        const lpAccount = String(body.lpAccount || config.lpAccountId);
        const assetsUsdc = BigInt(String(body.assetsUsdc || "1000000000")); // $1,000 USDC
        const result = engine.depositPool(lpAccount, assetsUsdc);
        sendJson(res, 200, {
          ok: true,
          sharesMinted: result.shares.toString(),
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/float/withdraw") {
        const body = await readJsonBody(req);
        const lpAccount = String(body.lpAccount || config.lpAccountId);
        const assetsUsdc = BigInt(String(body.assetsUsdc || "500000000")); // $500 USDC
        const result = engine.withdrawPool(lpAccount, assetsUsdc);
        sendJson(res, 200, {
          ok: true,
          sharesBurned: result.sharesBurned.toString(),
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // 14. Execute Complete 12-Step Customer-to-Settlement-to-Audit Journey in One Click
      if (method === "POST" && pathname === "/api/demo/run-complete-journey") {
        const body = await readJsonBody(req);
        const stepsLog: Array<{ step: number; title: string; detail: string }> = [];

        if (config.walletMode === "outlayer" && config.hasOutlayerKey) {
          await policyAdapter.syncLiveWalletStatus().catch(() => undefined);
        }

        // Step 1: Customer connects wallet
        stepsLog.push({
          step: 1,
          title: "Customer connects wallet",
          detail: `Connected customer wallet ${config.customerAccountId} (Mode: ${config.chainMode.toUpperCase()}).`,
        });

        // Step 2: Customer creates an AI job ($100.00 USDC payment, $25.00 max operating budget)
        const job = engine.createJob({
          creator: config.customerAccountId,
          customer: config.customerAccountId,
          operator: config.operatorAccountId,
          title: String(
            body.title || "Autonomous NEAR Protocol Liquidity & Security Audit"
          ),
          taskDescription: String(
            body.taskDescription ||
            "Execute on-chain storage & FloatPool invariants analysis, pull institutional orderbook telemetry within budget, and anchor a cryptographic proof on AuditAnchor."
          ),
          customerPaymentUsdc: 100_000_000n, // $100.00 USDC
          maxOperatingBudgetUsdc: 25_000_000n, // $25.00 USDC
        });
        stepsLog.push({
          step: 2,
          title: "Customer creates an AI job",
          detail: `Contract-derived Job ID ${job.jobId} created (seq=${job.seq}, storage locked=0.023 NEAR).`,
        });

        // Step 3: Customer funds the job
        engine.fundJob(job.jobId, config.customerAccountId);
        stepsLog.push({
          step: 3,
          title: "Customer funds the job",
          detail: `$100.00 USDC escrowed in ${config.coreContractId} by ${config.customerAccountId}.`,
        });

        // Step 4: Job appears in the dashboard
        stepsLog.push({
          step: 4,
          title: "Job appears in the dashboard",
          detail: `Job ${job.jobId.slice(0, 14)}... indexed in state Funded with termsHash ${job.termsHash.slice(0, 14)}...`,
        });

        // Step 5: AI daemon receives the job (+ draws $20.00 USDC working capital advance from FloatPool)
        const adv = engine.requestAdvance(
          job.jobId,
          config.operatorAccountId,
          20_000_000n
        );
        engine.startWork(job.jobId, config.operatorAccountId);
        stepsLog.push({
          step: 5,
          title: "AI daemon receives the job & draws FloatPool advance",
          detail: `Operator ${config.operatorAccountId} started work and drew $20.00 USDC working-capital advance (#${adv.advanceId}, fee=$0.40 USDC).`,
        });

        // Step 7: Worker requests controlled spending ($0.04 auto-approved + $4.00 escalated)
        const microSpend = policyAdapter.requestSpend({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          vendor: "NEAR Lake Indexer Telemetry API",
          description: "Micro-query for historical block & storage delta headers",
          amountUsdc: 40_000n, // $0.04 USDC (auto-approved <= $0.10)
        });
        const escalatedSpend = policyAdapter.requestSpend({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          vendor: "Kaiko Institutional Liquidity Dataset",
          description: "Deep orderbook & USDC slippage dataset for risk verification",
          amountUsdc: 4_000_000n, // $4.00 USDC (escalated > $0.10)
        });
        stepsLog.push({
          step: 7,
          title: "Worker requests controlled spending",
          detail: `$0.04 micro-spend AUTO-APPROVED (${microSpend.expense?.receiptHash.slice(0, 14)}...); $4.00 dataset spend ESCALATED to operator queue (${escalatedSpend.approval?.approvalId}).`,
        });

        // Step 8: Approval is recorded
        const decisionRes = policyAdapter.decideApproval({
          approvalId: escalatedSpend.approval!.approvalId,
          decidedBy: config.operatorAccountId,
          decision: "APPROVE",
          note: "Verified Kaiko dataset vendor and approved $4.00 spend within $25.00 budget.",
        });
        stepsLog.push({
          step: 8,
          title: "Approval is recorded",
          detail: `Approval ${decisionRes.approval.approvalId} recorded by ${config.operatorAccountId}; total operating spend is now $4.04 USDC.`,
        });

        // Step 6 & Step 9: AI worker executes task & submits result and evidence hash
        const aiExec = await aiAdapter.executeJobTask(job);
        engine.submitDelivery({
          jobId: job.jobId,
          caller: config.operatorAccountId,
          deliveryHash: aiExec.deliveryHash,
          aiExecution: aiExec,
        });
        stepsLog.push({
          step: 6,
          title: "AI worker executes the task",
          detail: `Executed via ${aiExec.adapterLabel} in ${aiExec.durationMs}ms.`,
        });
        stepsLog.push({
          step: 9,
          title: "Worker submits the result and evidence hash",
          detail: `Submitted deliveryHash ${aiExec.deliveryHash} to ${config.coreContractId}.`,
        });

        // Step 10 & Step 11: Customer accepts delivery -> Settlement accounting executes
        const settledJob = engine.acceptDelivery(
          job.jobId,
          config.customerAccountId
        );
        stepsLog.push({
          step: 10,
          title: "Customer accepts delivery",
          detail: `Customer ${config.customerAccountId} accepted delivery for ${job.jobId.slice(0, 14)}...`,
        });
        stepsLog.push({
          step: 11,
          title: "Settlement accounting executes",
          detail: `FloatPool repaid $20.40 USDC ($20.00 principal + $0.40 yield to LPs); Operator net payout = $79.60 USDC.`,
        });

        // Step 12: AuditAnchor verifies the evidence
        const anchor = engine.anchorJob(job.jobId, config.customerAccountId);
        stepsLog.push({
          step: 12,
          title: "AuditAnchor verifies the evidence",
          detail: `Cross-contract verification succeeded on ${config.auditContractId}; immutable anchor recorded (tx=${anchor.txHash.slice(0, 16)}...).`,
        });

        stepsLog.sort((a, b) => a.step - b.step);

        sendJson(res, 200, {
          ok: true,
          jobId: settledJob.jobId,
          stepsLog,
          job: settledJob,
          anchor,
          state: buildSystemSnapshot(config, engine, policyAdapter, aiAdapter),
        });
        return;
      }

      // Serve static dashboard UI from public/
      const filePath =
        pathname === "/"
          ? path.join(publicDir, "index.html")
          : path.resolve(publicDir, pathname.replace(/^\/+/, ""));
      const relativeToPublic = path.relative(publicDir, filePath);
      const isInsidePublic =
        relativeToPublic !== "" &&
        !relativeToPublic.startsWith("..") &&
        !path.isAbsolute(relativeToPublic);

      if (isInsidePublic && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".js"
              ? "application/javascript; charset=utf-8"
              : ext === ".css"
                ? "text/css; charset=utf-8"
                : "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        });
        res.end(fs.readFileSync(filePath));
        return;
      }

      metrics.errors4xx += 1;
      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` }, reqOrigin, undefined, correlationId);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = redactSensitiveText(rawMessage);
      const status = message.startsWith("ERR_WALLET_AUTH_REQUIRED") ||
        message.startsWith("ERR_WALLET_SESSION_") ||
        message.startsWith("ERR_UNAUTHORIZED_WORKER") ||
        message.startsWith("ERR_WORKER_UNAUTHORIZED") ||
        message.startsWith("ERR_WORKER_AUTH")
        ? 401
        : message.startsWith("ERR_ACCOUNT_IMPERSONATION_BLOCKED") ||
            message.startsWith("ERR_PRIVATE_KEY_FORBIDDEN")
          ? 403
          : message.startsWith("ERR_PAYLOAD_TOO_LARGE")
            ? 413
            : 400;
      if (status >= 500) metrics.errors5xx += 1;
      else if (status >= 400) metrics.errors4xx += 1;
      logStructuredEvent(status >= 500 ? "error" : "warn", "request_error", {
        correlationId,
        method: req.method || "GET",
        pathname: req.url || "/",
        status,
        error: message,
      });
      sendJson(res, status, { ok: false, error: message }, reqOrigin, undefined, correlationId);
    }
  });

  server.keepAliveTimeout = 1000;

  return {
    config,
    engine,
    policyAdapter,
    aiAdapter,
    nearRpcAdapter,
    escrowTracker,
    walletSessionManager,
    repo,
    intentsClient,
    outlayerExecAdapter,
    workforceEngine,
    verificationEngine,
    settlementEngine,
    server,
  };
}

// Start HTTP server if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const app = createSnowMoonApp();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(
      `[SnowMoon MVP] Server running at http://${app.config.host}:${app.config.port}`
    );
    console.log(
      `[SnowMoon MVP] Chain Mode: ${app.config.chainMode.toUpperCase()} (${app.config.network}) | AI Adapter: ${app.aiAdapter.getAdapterLabel()} | Wallet Policy: ${app.policyAdapter.getAdapterLabel()}`
    );
  });
}

