import crypto from "node:crypto";
import {
  DeterministicSpendingPolicyEngine,
  type PaymentIntent,
} from "./spending_policy.ts";

export const NEAR_MARKET_BASE_URL = "https://market.near.ai";
export const MAINNET_USDC_CONTRACT_ID =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const MARKET_HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface NearMarketAgentSummary {
  agentId: string;
  handle: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  deliveredJobs: number;
  successRate: number;
  slaSeconds: number;
  availableNow: boolean;
  priceUsdc?: string;
  priceAtomic?: string;
  a2aEndpoint: string;
}

export interface NearMarketX402AcceptRow {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface NearMarketHireResult {
  ok: boolean;
  handle: string;
  a2aEndpoint: string;
  taskId: string;
  state: string;
  paidAmountAtomic: string;
  paidAmountUsdc: string;
  payTo: string;
  network: string;
  asset: string;
  xPaymentHeaderUsed: boolean;
  outputText: string;
  artifactUrls: string[];
  error?: string;
}

export type Nep366X402Signer = (params: {
  acceptRow: NearMarketX402AcceptRow;
  payerAccountId: string;
  payerPrivateKey: string;
  rpcUrl: string;
}) => Promise<string>;

export function assertValidMarketHandle(handle: string): string {
  const clean = String(handle || "").trim().toLowerCase();
  if (!MARKET_HANDLE_REGEX.test(clean)) {
    throw new Error(
      `ERR_INVALID_MARKET_HANDLE: "${handle}" is not a valid market.near.ai agent handle.`
    );
  }
  return clean;
}

export async function discoverNearMarketAgents(params: {
  query?: string;
  category?: string;
  maxPriceUsdc?: number;
  maxSlaSeconds?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<NearMarketAgentSummary[]> {
  const fetchFn = params.fetchImpl ?? fetch;
  const searchQuery = params.query?.trim() || "";
  const limit = Math.min(20, Math.max(1, params.limit ?? 8));
  const qs = new URLSearchParams();
  if (searchQuery) qs.set("q", searchQuery);
  if (params.category?.trim()) qs.set("category", params.category.trim());
  qs.set("sort", "delivered");
  qs.set("limit", String(limit));

  const resp = await fetchFn(`${NEAR_MARKET_BASE_URL}/v1/agents?${qs.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": "SnowMoon-Agent/1.0" },
  });
  if (!resp.ok) {
    throw new Error(`ERR_NEAR_MARKET_CATALOG_HTTP_${resp.status}`);
  }
  const data = (await resp.json()) as {
    agents?: Array<Record<string, unknown>>;
  };
  let rawAgents = Array.isArray(data.agents) ? data.agents : [];
  if (searchQuery && rawAgents.length < limit) {
    const terms = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const broadQuery = new URLSearchParams();
    broadQuery.set("limit", "50");
    if (params.category) broadQuery.set("category", params.category.trim());
    const broadResp = await fetchFn(`${NEAR_MARKET_BASE_URL}/v1/agents?${broadQuery.toString()}`, {
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (broadResp?.ok) {
      const broadData = (await broadResp.json()) as { agents?: Array<Record<string, unknown>> };
      const broadList = Array.isArray(broadData.agents) ? broadData.agents : [];
      const seenHandles = new Set(rawAgents.map((a) => String(a.handle || "").toLowerCase()));
      for (const candidate of broadList) {
        const handle = String(candidate.handle || "").toLowerCase();
        if (!handle || seenHandles.has(handle)) continue;
        const haystack = [
          handle,
          String(candidate.name || ""),
          String(candidate.description || ""),
          String(candidate.category || ""),
          Array.isArray(candidate.tags) ? candidate.tags.join(" ") : "",
        ]
          .join(" ")
          .toLowerCase();
        if (terms.some((t) => haystack.includes(t))) {
          rawAgents = [...rawAgents, candidate];
          seenHandles.add(handle);
        }
      }
    }
  }
  const maxSla = params.maxSlaSeconds ?? 3600;

  const eligible = rawAgents.filter((a) => {
    const handle = String(a.handle || "").trim().toLowerCase();
    const available = a.available_now === true;
    const paused = a.funding_paused === true;
    const payable = Array.isArray(a.payable_with)
      ? a.payable_with.map((x) => String(x).toUpperCase())
      : [];
    const sla = Number(a.sla_seconds || 0);
    return (
      MARKET_HANDLE_REGEX.test(handle) &&
      available &&
      !paused &&
      (payable.length === 0 || payable.includes("USDC")) &&
      (sla === 0 || sla <= maxSla)
    );
  });

  const top = eligible.slice(0, Math.min(20, Math.max(limit, 12)));
  const enriched = await Promise.all(
    top.map(async (a): Promise<NearMarketAgentSummary> => {
      const agentId = String(a.agent_id || "");
      const handle = String(a.handle || "").toLowerCase();
      let priceUsdc: string | undefined;
      let priceAtomic: string | undefined;
      let planSla = Number(a.sla_seconds || 0);

      if (agentId) {
        try {
          const pResp = await fetchFn(
            `${NEAR_MARKET_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/pricing-plans`,
            { headers: { Accept: "application/json" } }
          );
          if (pResp.ok) {
            const pJson = (await pResp.json()) as
              | Array<Record<string, unknown>>
              | { pricing_plans?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>> };
            const plans = Array.isArray(pJson)
              ? pJson
              : Array.isArray(pJson?.pricing_plans)
                ? pJson.pricing_plans
                : Array.isArray(pJson?.plans)
                  ? pJson.plans
                  : [];
            const def =
              plans.find((p) => p.is_default === true) || plans[0];
            if (def && def.price_amount != null) {
              const usd = Number(def.price_amount);
              if (Number.isFinite(usd) && usd >= 0) {
                priceUsdc = usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
                priceAtomic = String(Math.round(usd * 1_000_000));
              }
              if (def.sla_seconds != null && Number(def.sla_seconds) > 0) {
                planSla = Number(def.sla_seconds);
              }
            }
          }
        } catch {
          // Non-fatal: pricing plan optional during discovery
        }
      }

      return {
        agentId,
        handle,
        name: String(a.name || handle),
        description: String(a.description || ""),
        category: String(a.category || "other"),
        tags: Array.isArray(a.tags) ? a.tags.map((t) => String(t)) : [],
        deliveredJobs: Number(a.delivered_jobs || 0),
        successRate: Number(a.success_rate || 0),
        slaSeconds: planSla,
        availableNow: Boolean(a.available_now),
        priceUsdc,
        priceAtomic,
        a2aEndpoint: `https://${handle}.market.near.ai/a2a/v1`,
      };
    })
  );

  const filtered =
    typeof params.maxPriceUsdc === "number" && Number.isFinite(params.maxPriceUsdc)
      ? enriched.filter((a) => {
          if (!a.priceUsdc) return true;
          return Number(a.priceUsdc) <= params.maxPriceUsdc!;
        })
      : enriched;

  // Least-cost & reliability ranking: reliable agents (>=70% success) first, then lowest USDC price, then highest success/deliveries
  filtered.sort((a, b) => {
    const aReliable = a.successRate >= 70 || a.deliveredJobs === 0 ? 0 : 1;
    const bReliable = b.successRate >= 70 || b.deliveredJobs === 0 ? 0 : 1;
    if (aReliable !== bReliable) return aReliable - bReliable;
    const aPrice = a.priceUsdc ? Number(a.priceUsdc) : Number.POSITIVE_INFINITY;
    const bPrice = b.priceUsdc ? Number(b.priceUsdc) : Number.POSITIVE_INFINITY;
    if (aPrice !== bPrice) return aPrice - bPrice;
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    return b.deliveredJobs - a.deliveredJobs;
  });

  return filtered.slice(0, limit);
}

/**
 * Signs a NEAR NEP-366 off-chain SignedDelegateAction for x402 v2 `exact` scheme.
 * Zero gas required on the caller; the market.near.ai relayer submits it upon delivery.
 */
export async function signNep366X402Payment(params: {
  acceptRow: NearMarketX402AcceptRow;
  payerAccountId: string;
  payerPrivateKey: string;
  rpcUrl: string;
}): Promise<string> {
  const networkParts = params.acceptRow.network.split(":");
  const networkId = networkParts[1] || "mainnet";
  if (networkParts[0] !== "near" || networkId !== "mainnet") {
    throw new Error(
      `ERR_X402_NETWORK_UNSUPPORTED: Expected near:mainnet, got ${params.acceptRow.network}`
    );
  }
  if (!params.payerAccountId.trim() || !params.payerPrivateKey.trim()) {
    throw new Error(
      "ERR_X402_SIGNER_UNCONFIGURED: NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required for autonomous x402 delegate signing."
    );
  }

  const naj = (await import("near-api-js")) as unknown as {
    connect: (cfg: Record<string, unknown>) => Promise<{
      account: (id: string) => Promise<{
        signedDelegate: (opts: {
          actions: unknown[];
          blockHeightTtl: number;
          receiverId: string;
        }) => Promise<unknown>;
      }>;
    }>;
    KeyPair: { fromString: (k: string) => unknown };
    keyStores: { InMemoryKeyStore: new () => { setKey: (net: string, id: string, kp: unknown) => Promise<void> } };
    transactions: {
      functionCall: (method: string, args: Record<string, unknown>, gas: bigint, deposit: bigint) => unknown;
      encodeSignedDelegate: (signed: unknown) => Uint8Array;
    };
  };

  const keyStore = new naj.keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    networkId,
    params.payerAccountId,
    naj.KeyPair.fromString(params.payerPrivateKey)
  );
  const near = await naj.connect({
    networkId,
    nodeUrl: params.rpcUrl || "https://rpc.mainnet.fastnear.com",
    keyStore,
  });
  const account = await near.account(params.payerAccountId);
  const action = naj.transactions.functionCall(
    "ft_transfer",
    {
      receiver_id: params.acceptRow.payTo,
      amount: params.acceptRow.amount,
    },
    30_000_000_000_000n,
    1n
  );
  const ttlBlocks = Math.max(120, Number(params.acceptRow.maxTimeoutSeconds || 600));
  const signed = await account.signedDelegate({
    actions: [action],
    blockHeightTtl: ttlBlocks,
    receiverId: params.acceptRow.asset,
  });
  const encoded = Buffer.from(naj.transactions.encodeSignedDelegate(signed)).toString("base64");
  const envelope = {
    x402Version: 2,
    accepted: params.acceptRow,
    payload: {
      signedDelegateAction: encoded,
    },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function extractA2AOutput(task: Record<string, unknown>): {
  outputText: string;
  artifactUrls: string[];
} {
  const artifacts = Array.isArray(task.artifacts)
    ? (task.artifacts as Array<Record<string, unknown>>)
    : [];
  const texts: string[] = [];
  const urls: string[] = [];
  for (const art of artifacts) {
    const parts = Array.isArray(art.parts) ? (art.parts as Array<Record<string, unknown>>) : [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
      if (typeof part.url === "string" && part.url.trim()) {
        urls.push(part.url.trim());
      }
    }
  }
  const statusMsg = (task.status as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;
  if (texts.length === 0 && Array.isArray(statusMsg?.parts)) {
    for (const part of statusMsg.parts as Array<Record<string, unknown>>) {
      if (typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }
  return {
    outputText: texts.join("\n\n"),
    artifactUrls: urls,
  };
}

export async function hireNearMarketAgent(params: {
  handle: string;
  prompt: string;
  jobId: string;
  maxBudgetAtomic: string;
  payerAccountId: string;
  payerPrivateKey: string;
  nearRpcUrl?: string;
  fetchImpl?: typeof fetch;
  policyEngine?: DeterministicSpendingPolicyEngine;
  delegateSigner?: Nep366X402Signer;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onTrace?: (evt: { stage: string; status: string; title: string; detail?: string }) => void;
}): Promise<NearMarketHireResult> {
  const handle = assertValidMarketHandle(params.handle);
  const fetchFn = params.fetchImpl ?? fetch;
  const a2aEndpoint = `https://${handle}.market.near.ai/a2a/v1`;
  const merchantHost = `${handle}.market.near.ai`;

  params.onTrace?.({
    stage: "tool",
    status: "running",
    title: `Verifying market.near.ai x402 directory`,
    detail: merchantHost,
  });

  // 1. Verify official .well-known/x402 payee & asset
  const wkResp = await fetchFn(`${NEAR_MARKET_BASE_URL}/.well-known/x402`, {
    headers: { Accept: "application/json" },
  });
  if (!wkResp.ok) {
    throw new Error(`ERR_NEAR_MARKET_X402_CONFIG_HTTP_${wkResp.status}`);
  }
  const wkJson = (await wkResp.json()) as {
    x402Version?: number;
    recipients?: Array<{ network?: string; asset?: string; payTo?: string }>;
  };
  const validRecipients = Array.isArray(wkJson.recipients) ? wkJson.recipients : [];
  const mainnetRecipient = validRecipients.find(
    (r) =>
      r.network === "near:mainnet" &&
      r.asset === MAINNET_USDC_CONTRACT_ID &&
      typeof r.payTo === "string" &&
      r.payTo.length > 0
  );
  if (!mainnetRecipient) {
    throw new Error("ERR_NEAR_MARKET_NO_MAINNET_USDC_RECIPIENT");
  }

  // 2. Request 402 price challenge via A2A SendMessage
  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: params.prompt }],
      },
      configuration: { historyLength: 0 },
    },
  };

  const quoteResp = await fetchFn(a2aEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rpcBody),
  });

  if (quoteResp.status !== 402) {
    const rawTxt = await quoteResp.text();
    throw new Error(
      `ERR_NEAR_MARKET_EXPECTED_402: Got HTTP ${quoteResp.status} from ${a2aEndpoint}: ${rawTxt.slice(0, 240)}`
    );
  }

  const challenge = (await quoteResp.json()) as {
    x402Version?: number;
    accepts?: NearMarketX402AcceptRow[];
  };
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  const row = accepts.find(
    (a) =>
      a.scheme === "exact" &&
      a.network === "near:mainnet" &&
      a.asset === MAINNET_USDC_CONTRACT_ID
  );
  if (!row) {
    throw new Error("ERR_NEAR_MARKET_NO_SUPPORTED_ACCEPT_ROW");
  }
  if (row.payTo !== mainnetRecipient.payTo) {
    throw new Error(
      `ERR_NEAR_MARKET_PAYTO_MISMATCH: Challenge payTo ${row.payTo} does not match .well-known/x402 ${mainnetRecipient.payTo}`
    );
  }

  const quoteAtomic = BigInt(row.amount || "0");
  const maxAtomic = BigInt(params.maxBudgetAtomic || "0");
  if (quoteAtomic <= 0n) {
    throw new Error("ERR_NEAR_MARKET_ZERO_QUOTE");
  }
  if (quoteAtomic > maxAtomic) {
    throw new Error(
      `ERR_NEAR_MARKET_BUDGET_EXCEEDED: Agent ${handle} quoted ${row.amount} atomic USDC, exceeding remaining budget ${params.maxBudgetAtomic}.`
    );
  }

  const intentId = `x402_mkt_${crypto.randomUUID()}`;
  if (params.policyEngine) {
    const intent: PaymentIntent = {
      intentId,
      jobId: params.jobId,
      taskId: `mkt_${handle}`,
      workerId: params.payerAccountId,
      merchant: merchantHost,
      destination: row.payTo,
      amountAtomic: row.amount,
      token: row.asset,
      network: "near-mainnet",
      purpose: `market.near.ai:${handle}`,
      category: "ai-marketplace",
      nonce: crypto.randomUUID(),
      expiresAtMs: Date.now() + 120_000,
    };
    const evalRec = params.policyEngine.evaluateAndReserve(
      intent,
      Date.now(),
      params.maxBudgetAtomic
    );
    if (evalRec.decision === "DENY") {
      throw new Error(`ERR_SPENDING_POLICY_DENIED: ${evalRec.reasons.join("; ")}`);
    }
    if (evalRec.decision === "HUMAN_APPROVAL_REQUIRED") {
      params.policyEngine.releaseReservation(intentId);
      throw new Error(
        `ERR_SPENDING_POLICY_APPROVAL_REQUIRED: Hire cost ${row.amount} atomic USDC requires human approval (${intentId}).`
      );
    }
  }

  const usdDisplay = (Number(row.amount) / 1_000_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  params.onTrace?.({
    stage: "tool",
    status: "running",
    title: `Signing x402 payment ($${usdDisplay} USDC) for @${handle}`,
    detail: `payTo=${row.payTo.slice(0, 12)}...`,
  });

  const signer = params.delegateSigner ?? signNep366X402Payment;
  const xPayment = await signer({
    acceptRow: row,
    payerAccountId: params.payerAccountId,
    payerPrivateKey: params.payerPrivateKey,
    rpcUrl: params.nearRpcUrl || "https://rpc.mainnet.fastnear.com",
  });

  // 3. Submit paid A2A SendMessage with X-PAYMENT
  const paidResp = await fetchFn(a2aEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": xPayment,
    },
    body: JSON.stringify(rpcBody),
  });

  const paidJson = (await paidResp.json()) as {
    result?: { task?: Record<string, unknown> };
    error?: { code?: number; message?: string };
  };
  if (!paidResp.ok || paidJson.error) {
    params.policyEngine?.releaseReservation(intentId);
    throw new Error(
      `ERR_NEAR_MARKET_PAID_CALL_FAILED: HTTP ${paidResp.status} ${paidJson.error?.message || ""}`.trim()
    );
  }

  let task = paidJson.result?.task || {};
  const taskId = String(task.id || "");
  let state = String((task.status as Record<string, unknown> | undefined)?.state || "");

  // 4. Poll GetTask if agent is still working
  const pollInterval = params.pollIntervalMs ?? 5000;
  const maxPolls = params.maxPollAttempts ?? 12;
  let pollCount = 0;
  while (
    taskId &&
    (state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING") &&
    pollCount < maxPolls
  ) {
    pollCount += 1;
    if (pollInterval > 0) {
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    const pollResp = await fetchFn(a2aEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: pollCount + 10,
        method: "GetTask",
        params: { id: taskId, historyLength: 0 },
      }),
    });
    if (pollResp.ok) {
      const pollJson = (await pollResp.json()) as { result?: Record<string, unknown> };
      if (pollJson.result) {
        task = pollJson.result;
        state = String((task.status as Record<string, unknown> | undefined)?.state || state);
      }
    }
  }

  const { outputText, artifactUrls } = extractA2AOutput(task);
  const completed = state === "TASK_STATE_COMPLETED";
  if (completed) {
    params.policyEngine?.settleReservation(intentId, `x402:${taskId}`);
    params.onTrace?.({
      stage: "tool",
      status: "ok",
      title: `Completed x402 hire @${handle} ($${usdDisplay} USDC)`,
      detail: `task=${taskId}`,
    });
  } else {
    params.policyEngine?.releaseReservation(intentId);
    params.onTrace?.({
      stage: "tool",
      status: "error",
      title: `x402 hire @${handle} ended in ${state || "UNKNOWN"}`,
      detail: taskId ? `task=${taskId}` : undefined,
    });
  }

  return {
    ok: completed,
    handle,
    a2aEndpoint,
    taskId,
    state: state || "UNKNOWN",
    paidAmountAtomic: row.amount,
    paidAmountUsdc: usdDisplay,
    payTo: row.payTo,
    network: row.network,
    asset: row.asset,
    xPaymentHeaderUsed: true,
    outputText,
    artifactUrls,
    error: completed ? undefined : `Marketplace task ended with state ${state || "UNKNOWN"}`,
  };
}

export interface MarketFailoverAttempt {
  handle: string;
  ok: boolean;
  paidAmountUsdc?: string;
  taskId?: string;
  state?: string;
  error?: string;
}

export interface MarketFailoverHireResult {
  ok: boolean;
  fallbackToNativeAi: boolean;
  usedHandle?: string;
  attempts: MarketFailoverAttempt[];
  result?: NearMarketHireResult;
  error?: string;
}

/**
 * Least-cost, resilient marketplace hire with automatic failover across up to 2 agents.
 * Never throws on marketplace agent failure: returns `fallbackToNativeAi: true` so the
 * SnowMoon AI Worker immediately completes the task natively on NEAR AI Cloud.
 */
export async function hireBestMarketAgentWithFailover(params: {
  primaryHandle?: string;
  fallbackHandles?: string[];
  query?: string;
  prompt: string;
  jobId: string;
  maxBudgetAtomic: string;
  payerAccountId: string;
  payerPrivateKey: string;
  nearRpcUrl?: string;
  fetchImpl?: typeof fetch;
  policyEngine?: DeterministicSpendingPolicyEngine;
  delegateSigner?: Nep366X402Signer;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onTrace?: (evt: { stage: string; status: string; title: string; detail?: string }) => void;
}): Promise<MarketFailoverHireResult> {
  const candidates: string[] = [];
  const pushHandle = (raw?: string) => {
    if (!raw?.trim()) return;
    try {
      const norm = assertValidMarketHandle(raw);
      if (!candidates.includes(norm)) candidates.push(norm);
    } catch {
      // ignore invalid fallback handle
    }
  };

  pushHandle(params.primaryHandle);
  for (const fb of params.fallbackHandles || []) {
    pushHandle(fb);
  }

  if (candidates.length < 2 && params.query?.trim()) {
    try {
      const maxPriceUsdc = Number(BigInt(params.maxBudgetAtomic)) / 1_000_000;
      const discovered = await discoverNearMarketAgents({
        query: params.query.trim(),
        maxPriceUsdc: Number.isFinite(maxPriceUsdc) && maxPriceUsdc > 0 ? maxPriceUsdc : undefined,
        limit: 4,
        fetchImpl: params.fetchImpl,
      });
      for (const agent of discovered) {
        pushHandle(agent.handle);
        if (candidates.length >= 2) break;
      }
    } catch {
      // catalog discovery failure should not block primary handle or native fallback
    }
  }

  const maxCandidates = candidates.slice(0, 2);
  if (maxCandidates.length === 0) {
    return {
      ok: false,
      fallbackToNativeAi: true,
      attempts: [],
      error: "No eligible market.near.ai agents found within budget; falling back to native NEAR AI Cloud.",
    };
  }

  const attempts: MarketFailoverAttempt[] = [];
  for (let i = 0; i < maxCandidates.length; i++) {
    const handle = maxCandidates[i];
    if (i > 0) {
      params.onTrace?.({
        stage: "tool",
        status: "running",
        title: `Marketplace failover: trying @${handle}`,
        detail: `Previous agent @${maxCandidates[i - 1]} failed`,
      });
    }
    try {
      const res = await hireNearMarketAgent({
        handle,
        prompt: params.prompt,
        jobId: params.jobId,
        maxBudgetAtomic: params.maxBudgetAtomic,
        payerAccountId: params.payerAccountId,
        payerPrivateKey: params.payerPrivateKey,
        nearRpcUrl: params.nearRpcUrl,
        fetchImpl: params.fetchImpl,
        policyEngine: params.policyEngine,
        delegateSigner: params.delegateSigner,
        pollIntervalMs: params.pollIntervalMs,
        maxPollAttempts: params.maxPollAttempts,
        onTrace: params.onTrace,
      });
      if (res.ok && res.outputText.trim().length > 0) {
        attempts.push({
          handle,
          ok: true,
          paidAmountUsdc: res.paidAmountUsdc,
          taskId: res.taskId,
          state: res.state,
        });
        return {
          ok: true,
          fallbackToNativeAi: false,
          usedHandle: handle,
          attempts,
          result: res,
        };
      }
      attempts.push({
        handle,
        ok: false,
        taskId: res.taskId,
        state: res.state,
        error: res.error || "Marketplace agent returned empty output",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({
        handle,
        ok: false,
        error: msg,
      });
      params.onTrace?.({
        stage: "tool",
        status: "error",
        title: `Marketplace @${handle} failed`,
        detail: msg.slice(0, 140),
      });
    }
  }

  return {
    ok: false,
    fallbackToNativeAi: true,
    attempts,
    error: `All ${attempts.length} marketplace attempt(s) failed (${attempts
      .map((a) => `@${a.handle}: ${a.error || a.state || "failed"}`)
      .join(" | ")}); falling back to native NEAR AI Cloud.`,
  };
}
