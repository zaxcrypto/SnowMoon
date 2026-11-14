import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  selectModelForTask,
  type ToolCallTraceEntry,
} from "./agent_tools.ts";
import { getCapabilitySystemRules, normalizeCapability } from "./capability_rules.ts";
import type { SnowMoonConfig } from "./config.ts";
import { emitLiveTrace } from "./live_trace.ts";
import {
  type AIExecutionRecord,
  type AITokenUsage,
  type ApprovalRequest,
  type ExpenseReceipt,
  type JobRecord,
  SnowMoonEngine,
  sha256Hex,
} from "./engine.ts";

/**
 * Redacts any sensitive bearer token or API key from log/error strings so secrets never leak.
 */
export function sanitizeErrorMessage(raw: string, secretKey?: string): string {
  let msg = raw;
  if (secretKey && secretKey.length > 0) {
    msg = msg.split(secretKey).join("[REDACTED_API_KEY]");
  }
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-:]+/gi, "Bearer [REDACTED]");
  return msg.slice(0, 280);
}

export interface SpendEvaluationResult {
  action: "AUTO_APPROVED" | "ESCALATED_TO_HUMAN" | "DENIED_FALLBACK";
  expense?: ExpenseReceipt;
  approval?: ApprovalRequest;
  message: string;
}

export interface OutLayerLiveWalletSnapshot {
  mode: "live_read_only" | "mock_fallback";
  authenticated: boolean;
  network: "mainnet" | "testnet" | "unknown";
  baseUrl: string;
  walletId: string | null;
  agentAccountRole: string | null;
  nearAddress: string | null;
  executorAccountId: string | null;
  publicKey: string | null;
  authorizedKeyHashes: string[];
  nativeNearBalanceYocto: string;
  usdcBalanceAtomic: string;
  policy: {
    version: number;
    frozen: boolean;
    locked: boolean;
    policyType: string;
    limits: {
      perTransactionNativeYocto?: string;
      hourlyNativeYocto?: string;
      dailyNativeYocto?: string;
      monthlyNativeYocto?: string;
    };
    approvers: Array<{ id: string; role: string }>;
    approvalThresholdRequired: number;
    transactionTypes: string[];
  } | null;
  remotePendingRequestsCount: number;
  remoteRequests: Array<Record<string, unknown>>;
  lastSyncedAt: string;
  error?: string;
}

/**
 * OutLayer Spending Policy & Approval Adapter.
 * - Performs read-only live authentication, balance, policy, and request-status sync against OutLayer `/wallet/v1/*`
 *   when `OUTLAYER_API_KEY` is configured (NEVER signs, broadcasts, or executes any real transaction).
 * - Enforces autonomous micro-spending policy (`<= autoApproveLimitUsdc` e.g. $0.10 USDC) in the local SnowMoon sandbox ledger
 * - Escalates larger expenses (e.g. $4.00 premium dataset purchase) to the Operator Approval Queue
 * - Verifies post-approval payload hash so a worker cannot substitute vendor/amount after human approval
 * - Explicitly distinguishes live read-only OutLayer wallet/policy telemetry from local simulated spending approvals
 */
export class OutLayerPolicyAdapter {
  private config: SnowMoonConfig;
  private engine: SnowMoonEngine;
  private fetchImpl: typeof fetch;
  private nextApprovalSeq = 1;
  private cachedSnapshot: OutLayerLiveWalletSnapshot | null = null;

  constructor(
    config: SnowMoonConfig,
    engine: SnowMoonEngine,
    fetchImpl: typeof fetch = fetch
  ) {
    this.config = config;
    this.engine = engine;
    this.fetchImpl = fetchImpl;
  }

  public getAdapterLabel(): string {
    return this.config.walletMode === "outlayer" && this.config.hasOutlayerKey
      ? "LIVE OUTLAYER WALLET (READ-ONLY SYNC) + LOCAL APPROVAL SIMULATION"
      : "MOCK OUTLAYER POLICY ENGINE (SIMULATED LOCAL GUARD)";
  }

  public getCachedWalletSnapshot(): OutLayerLiveWalletSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    return {
      mode:
        this.config.walletMode === "outlayer" && this.config.hasOutlayerKey
          ? "live_read_only"
          : "mock_fallback",
      authenticated: false,
      network: "unknown",
      baseUrl: this.config.outlayerBaseUrl,
      walletId: null,
      agentAccountRole: null,
      nearAddress: null,
      executorAccountId: null,
      publicKey: null,
      authorizedKeyHashes: [],
      nativeNearBalanceYocto: "0",
      usdcBalanceAtomic: "0",
      policy: null,
      remotePendingRequestsCount: 0,
      remoteRequests: [],
      lastSyncedAt: new Date().toISOString(),
    };
  }

  /**
   * Read-only OutLayer API sync (`/wallet/v1/address?chain=near`, `/wallet/v1/balance`, `/wallet/v1/policy`, `/wallet/v1/requests`).
   * Strictly GET-only: never signs, broadcasts, or mutates remote wallet state.
   */
  public async syncLiveWalletStatus(): Promise<OutLayerLiveWalletSnapshot> {
    const base = this.config.outlayerBaseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    const key = this.config.secrets.outlayerApiKey;

    if (this.config.walletMode !== "outlayer" || !key) {
      this.cachedSnapshot = {
        mode: "mock_fallback",
        authenticated: false,
        network: "unknown",
        baseUrl: base,
        walletId: null,
        agentAccountRole: null,
        nearAddress: null,
        executorAccountId: null,
        publicKey: null,
        authorizedKeyHashes: [],
        nativeNearBalanceYocto: "0",
        usdcBalanceAtomic: "0",
        policy: null,
        remotePendingRequestsCount: 0,
        remoteRequests: [],
        lastSyncedAt: new Date().toISOString(),
      };
      return this.cachedSnapshot;
    }

    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };

    try {
      const [addrResp, nearBalResp, usdcBalResp, policyResp, reqsResp] =
        await Promise.all([
          this.fetchImpl(`${base}/wallet/v1/address?chain=near`, { method: "GET", headers }),
          this.fetchImpl(`${base}/wallet/v1/balance`, { method: "GET", headers }),
          this.fetchImpl(
            `${base}/wallet/v1/balance?token=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`,
            { method: "GET", headers }
          ),
          this.fetchImpl(`${base}/wallet/v1/policy`, { method: "GET", headers }),
          this.fetchImpl(`${base}/wallet/v1/requests`, { method: "GET", headers }),
        ]);

      if (!addrResp.ok) {
        const errTxt = await addrResp.text().catch(() => "");
        throw new Error(
          sanitizeErrorMessage(
            `OutLayer /wallet/v1/address HTTP ${addrResp.status}: ${errTxt}`,
            key
          )
        );
      }

      const addrData = (await addrResp.json()) as {
        wallet_id?: string;
        chain?: string;
        address?: string;
        public_key?: string;
        executor_account_id?: string;
      };
      const nearBalData = nearBalResp.ok
        ? ((await nearBalResp.json()) as {
            balance?: string;
            account_id?: string;
            account?: string;
          })
        : {};
      const usdcBalData = usdcBalResp.ok
        ? ((await usdcBalResp.json()) as { balance?: string })
        : {};
      const policyData = policyResp.ok
        ? ((await policyResp.json()) as {
            wallet_id?: string;
            controller?: string;
            frozen?: boolean;
            version?: number;
            locked?: boolean;
            policy?: string;
            rules?: {
              limits?: {
                daily?: { native?: string };
                hourly?: { native?: string };
                monthly?: { native?: string };
                per_transaction?: { native?: string };
              };
              transaction_types?: string[];
            };
            approval?: {
              approvers?: Array<{ id: string; role: string }>;
              threshold?: { required?: number };
            };
            authorized_key_hashes?: string[];
          })
        : null;
      const reqsData = reqsResp.ok
        ? ((await reqsResp.json()) as {
            requests?: Array<Record<string, unknown>>;
            total?: number;
          })
        : { requests: [], total: 0 };

      const isTestnetHost = base.includes("testnet-api.outlayer.ai");
      const approvers = policyData?.approval?.approvers ?? [];
      const detectedNetwork: "mainnet" | "testnet" = isTestnetHost
        ? "testnet"
        : "mainnet";

      this.cachedSnapshot = {
        mode: "live_read_only",
        authenticated: true,
        network: detectedNetwork,
        baseUrl: base,
        walletId: addrData.wallet_id ?? policyData?.wallet_id ?? null,
        agentAccountRole: nearBalData.account ?? "executor",
        nearAddress: addrData.address ?? nearBalData.account_id ?? null,
        executorAccountId:
          addrData.executor_account_id ?? nearBalData.account_id ?? null,
        publicKey: addrData.public_key ?? policyData?.controller ?? null,
        authorizedKeyHashes: policyData?.authorized_key_hashes ?? [],
        nativeNearBalanceYocto: nearBalData.balance ?? "0",
        usdcBalanceAtomic: usdcBalData.balance ?? "0",
        policy: policyData
          ? {
              version: Number(policyData.version ?? 1),
              frozen: Boolean(policyData.frozen),
              locked: Boolean(policyData.locked),
              policyType: String(policyData.policy ?? "stored"),
              limits: {
                perTransactionNativeYocto:
                  policyData.rules?.limits?.per_transaction?.native,
                hourlyNativeYocto: policyData.rules?.limits?.hourly?.native,
                dailyNativeYocto: policyData.rules?.limits?.daily?.native,
                monthlyNativeYocto: policyData.rules?.limits?.monthly?.native,
              },
              approvers,
              approvalThresholdRequired: Number(
                policyData.approval?.threshold?.required ?? 1
              ),
              transactionTypes: policyData.rules?.transaction_types ?? [],
            }
          : null,
        remotePendingRequestsCount: Number(reqsData.total ?? 0),
        remoteRequests: reqsData.requests ?? [],
        lastSyncedAt: new Date().toISOString(),
      };
      return this.cachedSnapshot;
    } catch (err) {
      const cleanErr = sanitizeErrorMessage(
        err instanceof Error ? err.message : String(err),
        key
      );
      this.cachedSnapshot = {
        mode: "mock_fallback",
        authenticated: false,
        network: "unknown",
        baseUrl: base,
        walletId: null,
        agentAccountRole: null,
        nearAddress: null,
        executorAccountId: null,
        publicKey: null,
        authorizedKeyHashes: [],
        nativeNearBalanceYocto: "0",
        usdcBalanceAtomic: "0",
        policy: null,
        remotePendingRequestsCount: 0,
        remoteRequests: [],
        lastSyncedAt: new Date().toISOString(),
        error: cleanErr,
      };
      return this.cachedSnapshot;
    }
  }

  public computePayloadHash(jobId: string, vendor: string, amountUsdc: bigint): string {
    return sha256Hex(`outlayer-spend|${jobId}|${vendor}|${amountUsdc.toString()}`);
  }

  public requestSpend(params: {
    jobId: string;
    workerId?: string;
    caller: string;
    vendor: string;
    description: string;
    category?: string;
    amountUsdc: bigint;
  }): SpendEvaluationResult {
    const job = this.engine.jobs.get(params.jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (params.caller !== job.operator) {
      throw new Error("ERR_NOT_OPERATOR: only job.operator can request worker spending");
    }

    const remainingBudget =
      BigInt(job.maxOperatingBudget) - BigInt(job.operatingSpent);

    // Case 1: Exceeds job's total remaining operating budget -> Denied / Adapted Fallback
    if (params.amountUsdc > remainingBudget) {
      return {
        action: "DENIED_FALLBACK",
        message: `[${this.getAdapterLabel()}] DENIED: Requested ${params.amountUsdc.toString()} atomic USDC exceeds remaining job operating budget (${remainingBudget.toString()}). Worker must adapt to cached/open-access data.`,
      };
    }

    // Case 2: Within autonomous micro-spend threshold (e.g. $0.04 <= $0.10) -> Auto-approved
    if (params.amountUsdc <= this.config.autoApproveLimitUsdc) {
      const expense = this.engine.recordExpense({
        jobId: params.jobId,
        caller: params.caller,
        amountUsdc: params.amountUsdc,
        vendor: params.vendor,
        description: params.description,
        category: params.category || "micro_data_query",
        policyVerdict: "AUTO_APPROVED",
        adapterLabel: this.getAdapterLabel(),
      });
      return {
        action: "AUTO_APPROVED",
        expense,
        message: `[${this.getAdapterLabel()}] AUTO-APPROVED: ${params.amountUsdc.toString()} atomic USDC <= policy limit (${this.config.autoApproveLimitUsdc.toString()}). Recorded on JobVault.`,
      };
    }

    // Case 3: Above auto-approve threshold but within job max budget -> Escalate to Human Approval Queue
    const approvalId = `appr-${this.nextApprovalSeq++}`;
    const payloadHash = this.computePayloadHash(
      params.jobId,
      params.vendor,
      params.amountUsdc
    );
    const receiptHash = sha256Hex(
      `pending-approval|${approvalId}|${params.jobId}|${params.vendor}|${params.amountUsdc.toString()}`
    );

    const approval: ApprovalRequest = {
      approvalId,
      jobId: params.jobId,
      workerId: params.workerId || "snowmoon-worker-01",
      operator: job.operator,
      vendor: params.vendor,
      description: params.description,
      requestedAmountUsdc: params.amountUsdc.toString(),
      autoApproveThresholdUsdc: this.config.autoApproveLimitUsdc.toString(),
      reason: `Requested spend (${params.amountUsdc.toString()}) exceeds autonomous policy limit (${this.config.autoApproveLimitUsdc.toString()})`,
      status: "PENDING",
      adapterMode: this.config.walletMode,
      adapterLabel: this.getAdapterLabel(),
      receiptHash,
      createdAt: new Date().toISOString(),
      postApprovalPayloadHash: payloadHash,
    };

    this.engine.approvals.set(approvalId, approval);

    return {
      action: "ESCALATED_TO_HUMAN",
      approval,
      message: `[${this.getAdapterLabel()}] ESCALATED TO OPERATOR QUEUE (${approvalId}): ${params.amountUsdc.toString()} atomic USDC exceeds auto-approve limit (${this.config.autoApproveLimitUsdc.toString()}).`,
    };
  }

  public decideApproval(params: {
    approvalId: string;
    decidedBy: string;
    decision: "APPROVE" | "REJECT";
    note?: string;
    // Optional post-approval substitution verification parameters
    verifyVendor?: string;
    verifyAmountUsdc?: bigint;
  }): { approval: ApprovalRequest; expense?: ExpenseReceipt } {
    const approval = this.engine.approvals.get(params.approvalId);
    if (!approval) throw new Error("ERR_APPROVAL_NOT_FOUND");
    if (approval.status !== "PENDING") {
      throw new Error(`ERR_APPROVAL_ALREADY_DECIDED: status is ${approval.status}`);
    }

    const job = this.engine.jobs.get(approval.jobId);
    if (!job) throw new Error("ERR_JOB_NOT_FOUND");
    if (params.decidedBy !== job.operator && params.decidedBy !== this.config.adminAccountId) {
      throw new Error("ERR_UNAUTHORIZED_APPROVER: only operator or admin may decide approval");
    }

    // Verify post-approval substitution guard if verification parameters are provided
    const targetVendor = params.verifyVendor ?? approval.vendor;
    const targetAmount =
      params.verifyAmountUsdc ?? BigInt(approval.requestedAmountUsdc);
    const checkHash = this.computePayloadHash(
      approval.jobId,
      targetVendor,
      targetAmount
    );
    if (checkHash !== approval.postApprovalPayloadHash) {
      throw new Error(
        "ERR_POST_APPROVAL_SUBSTITUTION_DETECTED: payload hash mismatch against approved vendor/amount"
      );
    }

    approval.decidedAt = new Date().toISOString();
    approval.decidedBy = params.decidedBy;
    approval.decisionNote =
      params.note ||
      (params.decision === "APPROVE"
        ? "Approved by operator after verifying data vendor and budget bounds."
        : "Rejected by operator; worker instructed to use fallback source.");

    if (params.decision === "REJECT") {
      approval.status = "REJECTED";
      return { approval };
    }

    approval.status = "APPROVED";
    const expense = this.engine.recordExpense({
      jobId: approval.jobId,
      caller: job.operator,
      amountUsdc: BigInt(approval.requestedAmountUsdc),
      vendor: approval.vendor,
      description: approval.description,
      category: "escalated_approved_spend",
      policyVerdict: "HUMAN_APPROVED",
      approvalId: approval.approvalId,
      adapterLabel: this.getAdapterLabel(),
    });

    return { approval, expense };
  }
}

/**
 * AI Worker Execution Adapter.
 * - Supports live NEAR AI Cloud (`NEAR_AI_API_KEY`) via OpenAI-compatible `https://cloud-api.near.ai/v1/chat/completions`
 * - Enforces request timeout (`NEAR_AI_TIMEOUT_MS`), parses token usage (`prompt_tokens`, `completion_tokens`, `total_tokens`),
 *   and sanitizes error messages so `NEAR_AI_API_KEY` is never exposed to browser code or logs
 * - Automatically falls back to a clearly labelled deterministic task-executing AI worker when no key is configured or when
 *   `SNOWMOON_AI_MODE=auto` encounters an upstream error.
 */
export class AIWorkerAdapter {
  private config: SnowMoonConfig;
  private fetchImpl: typeof fetch;

  constructor(config: SnowMoonConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  public getAdapterLabel(): string {
    return this.config.aiMode === "near_ai" && this.config.hasNearAiKey
      ? `LIVE NEAR AI CLOUD (${this.config.nearAiModel})`
      : "MOCK AI WORKER ADAPTER (DETERMINISTIC LOCAL EXECUTION)";
  }

  public getChatCompletionsUrl(): string {
    return `${this.config.nearAiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  /**
   * Read-only provider health & model availability check (GET /v1/models).
   * Spends zero inference credits and never exposes NEAR_AI_API_KEY.
   */
  public async probeProviderHealth(): Promise<{
    mode: "near_ai" | "mock";
    hasApiKey: boolean;
    endpoint: string;
    configuredModel: string;
    authenticated: boolean;
    modelAvailable: boolean;
    error?: string;
  }> {
    const base = this.config.nearAiBaseUrl.replace(/\/+$/, "");
    if (!this.config.hasNearAiKey || !this.config.secrets.nearAiApiKey) {
      return {
        mode: "mock",
        hasApiKey: false,
        endpoint: `${base}/models`,
        configuredModel: this.config.nearAiModel,
        authenticated: false,
        modelAvailable: false,
        error: "NEAR_AI_API_KEY is not configured; running in mock mode.",
      };
    }
    try {
      const resp = await this.fetchImpl(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.secrets.nearAiApiKey}` },
      });
      if (!resp.ok) {
        return {
          mode: this.config.aiMode,
          hasApiKey: true,
          endpoint: `${base}/models`,
          configuredModel: this.config.nearAiModel,
          authenticated: false,
          modelAvailable: false,
          error: sanitizeErrorMessage(`HTTP ${resp.status}`, this.config.secrets.nearAiApiKey),
        };
      }
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      const modelAvailable = (data.data || []).some((m) => m.id === this.config.nearAiModel);
      return {
        mode: this.config.aiMode,
        hasApiKey: true,
        endpoint: `${base}/models`,
        configuredModel: this.config.nearAiModel,
        authenticated: true,
        modelAvailable,
      };
    } catch (err) {
      return {
        mode: this.config.aiMode,
        hasApiKey: true,
        endpoint: `${base}/models`,
        configuredModel: this.config.nearAiModel,
        authenticated: false,
        modelAvailable: false,
        error: sanitizeErrorMessage(
          err instanceof Error ? err.message : String(err),
          this.config.secrets.nearAiApiKey
        ),
      };
    }
  }

  public buildInferencePayload(job: JobRecord): {
    model: string;
    messages: Array<{ role: "system" | "user"; content: string }>;
    temperature: number;
    max_tokens: number;
  } {
    return {
      model: this.config.nearAiModel,
      messages: [
        {
          role: "system",
          content:
            "You are SnowMoon Autonomous AI Worker on NEAR Protocol. Produce a concise 3-bullet technical deliverable in Markdown with verifiable findings.",
        },
        {
          role: "user",
          content: `Job ID: ${job.jobId}\nTitle: ${job.title}\nTask: ${job.taskDescription}\nOperating Budget Spent: ${job.operatingSpent} atomic USDC across ${job.expenses.length} verified receipts.`,
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
    };
  }

  public async executeJobTask(job: JobRecord): Promise<AIExecutionRecord> {
    const startMs = Date.now();
    const workerId = "snowmoon-ai-worker-01";
    let fallbackReason: string | undefined;

    if (this.config.aiMode === "near_ai") {
      if (!this.config.secrets.nearAiApiKey) {
        if (this.config.isProductionMode) {
          throw new Error(
            "ERR_AI_NOT_CONFIGURED_IN_PRODUCTION: NEAR_AI_API_KEY is required in production; mock AI fallback is disabled."
          );
        }
        fallbackReason = "NEAR_AI_API_KEY is not set in .env";
      } else {
        const endpoint = this.getChatCompletionsUrl();
        const capabilityMatch = job.title.match(/\[capability:([a-z0-9_-]+)\]/i);
        const normalizedCap = normalizeCapability(capabilityMatch?.[1]);
        const timeoutMs =
          normalizedCap === "security-audit"
            ? Math.max(90000, this.config.nearAiTimeoutMs || 90000)
            : Math.max(60000, this.config.nearAiTimeoutMs || 60000);

        try {
          const routePlan = selectModelForTask({
            capability: capabilityMatch?.[1],
            prompt: job.taskDescription,
            amountAtomic: job.customerPayment,
            defaultModel: this.config.nearAiModel,
          });

          const candidateModels = [routePlan.primaryModel, ...routePlan.fallbackModels].filter(
            (m, i, arr) => Boolean(m) && arr.indexOf(m) === i
          );

          const capabilityRules = getCapabilitySystemRules(capabilityMatch?.[1]);
          if (capabilityRules) {
            emitLiveTrace({
              jobId: job.jobId,
              stage: "rules",
              status: "ok",
              title: `Loaded ${normalizedCap} protocol rules`,
              detail: "Anti-burn tool dedup + 5-point security checklist + mandatory RPC citation active",
            });
          }
          const systemPrompt = [
            "You are SnowMoon Autonomous AI Worker running on NEAR Protocol & NEAR AI Cloud.",
            `Current UTC Date/Time: ${new Date().toISOString()}`,
            "You have real-time tools: `web_search`, `fetch_url`, `github_repo_tree`, `github_read_file`, `github_search_code`, `near_rpc_view`, and `near_docs_search`.",
            "CRITICAL RULES:",
            "1. NEVER guess or fabricate current prices, market caps, news, file contents, or vulnerability findings from memory. Always call your tools first to verify live data or actual repository source code.",
            "2. For GitHub repository audits, ALWAYS start with `github_repo_tree`, then read the key source files with `github_read_file` / `github_search_code`, and cite exact file paths, line numbers, and concrete remediation steps.",
            "3. For live market/research queries, ALWAYS use `web_search` or `fetch_url` and include the exact UTC timestamp and source URLs.",
            "4. Produce a clear, structured, actionable Markdown deliverable.",
            "5. Keep tool calls focused (inspect 2-4 key files max) and ALWAYS output the complete final Markdown deliverable directly in message content—never leave content empty or output scratchpad notes.",
            ...(capabilityRules ? ["", capabilityRules] : []),
          ].join("\n");

          type ChatMessage = {
            role: "system" | "user" | "assistant" | "tool";
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
              [key: string]: unknown;
            }>;
            tool_call_id?: string;
            [key: string]: unknown;
          };

          type ChatCompletionResponse = {
            id?: string;
            model?: string;
            choices?: Array<{
              message?: {
                content?: string | null;
                tool_calls?: Array<{
                  id: string;
                  type: "function";
                  function: { name: string; arguments: string };
                  [key: string]: unknown;
                }>;
                [key: string]: unknown;
              };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };

          const baseMessages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Job ID: ${job.jobId}\nTitle: ${job.title}\nTask: ${job.taskDescription}\nEscrow Payment: ${job.customerPayment} atomic USDC\nOperating Budget Spent: ${job.operatingSpent} atomic USDC across ${job.expenses.length} verified receipts.`,
            },
          ];

          const callModelTurn = async (
            modelId: string,
            messages: ChatMessage[],
            includeTools: boolean
          ): Promise<ChatCompletionResponse> => {
            const payload: Record<string, unknown> = {
              model: modelId,
              messages,
              temperature: 0.2,
              max_tokens: routePlan.maxTokens,
            };
            if (includeTools) {
              payload.tools = AGENT_TOOL_DEFINITIONS;
              payload.tool_choice = "auto";
            }
            const turnController = new AbortController();
            const turnTimer = setTimeout(() => turnController.abort(), timeoutMs);
            try {
              const resp = await this.fetchImpl(endpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${this.config.secrets.nearAiApiKey}`,
                },
                body: JSON.stringify(payload),
                signal: turnController.signal,
              });
              if (!resp.ok) {
                const errBody = await resp.text().catch(() => "");
                const cleanErr = sanitizeErrorMessage(
                  `HTTP ${resp.status} ${resp.statusText}: ${errBody}`,
                  this.config.secrets.nearAiApiKey
                );
                throw new Error(`NEAR_AI_HTTP_ERROR (${modelId}): ${cleanErr}`);
              }
              return (await resp.json()) as ChatCompletionResponse;
            } finally {
              clearTimeout(turnTimer);
            }
          };

          let activeModel = candidateModels[0];
          let messages: ChatMessage[] = [...baseMessages];
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;
          let totalTokensSum = 0;
          let lastRequestId: string | undefined;
          let resolvedModel = activeModel;
          let rawContent = "";
          const toolTrace: ToolCallTraceEntry[] = [];
          const toolCache = new Map<string, { ok: boolean; output: string; summary: string }>();

          for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
            activeModel = candidateModels[modelIdx];
            messages = [...baseMessages];
            emitLiveTrace({
              jobId: job.jobId,
              stage: "ai",
              status: "info",
              title: `Routing to ${activeModel} (${routePlan.tier})`,
              detail: routePlan.reason,
            });
            try {
              for (let round = 0; round <= routePlan.maxToolRounds; round++) {
                const isLastRound = round === routePlan.maxToolRounds;
                emitLiveTrace({
                  jobId: job.jobId,
                  stage: "ai",
                  status: "running",
                  title: `Thinking (${activeModel} · Round ${round + 1}/${routePlan.maxToolRounds + 1})`,
                });
                const roundT0 = Date.now();
                const data = await callModelTurn(activeModel, messages, !isLastRound);
                lastRequestId = data.id || lastRequestId;
                resolvedModel = data.model || activeModel;
                const pt = Number(data.usage?.prompt_tokens ?? 0);
                const ct = Number(data.usage?.completion_tokens ?? 0);
                const tt = Number(data.usage?.total_tokens ?? pt + ct);
                totalPromptTokens += pt;
                totalCompletionTokens += ct;
                totalTokensSum += tt;

                const msg = data.choices?.[0]?.message;
                const toolCalls = msg?.tool_calls;
                if (Array.isArray(toolCalls) && toolCalls.length > 0 && !isLastRound) {
                  emitLiveTrace({
                    jobId: job.jobId,
                    stage: "ai",
                    status: "ok",
                    title: `${resolvedModel} requested ${toolCalls.length} tool call(s)`,
                    durationMs: Math.max(1, Date.now() - roundT0),
                  });
                  messages.push({
                    ...msg,
                    role: "assistant",
                    content: msg?.content ?? null,
                    tool_calls: toolCalls,
                  });
                  for (const tc of toolCalls.slice(0, 6)) {
                    const t0 = Date.now();
                    let parsedArgs: Record<string, unknown> = {};
                    try {
                      parsedArgs = JSON.parse(tc.function?.arguments || "{}") as Record<
                        string,
                        unknown
                      >;
                    } catch {
                      parsedArgs = {};
                    }
                    const toolName = tc.function?.name || "";
                    const argPreview = Object.entries(parsedArgs)
                      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)}`)
                      .join(", ");
                    emitLiveTrace({
                      jobId: job.jobId,
                      stage: "tool",
                      status: "running",
                      title: `Running ${toolName}`,
                      detail: argPreview || undefined,
                    });
                    const cacheKey = `${toolName}:${JSON.stringify(parsedArgs)}`;
                    const isCachedHit = toolCache.has(cacheKey);
                    const toolRes = isCachedHit
                      ? toolCache.get(cacheKey)!
                      : await executeAgentTool(toolName, parsedArgs, {
                          fetchImpl: this.fetchImpl,
                          nearRpcUrl: this.config.nearMainnetRpcUrl,
                          githubToken: process.env.GITHUB_TOKEN,
                        });
                    if (!isCachedHit) toolCache.set(cacheKey, toolRes);
                    const durationMs = Math.max(1, Date.now() - t0);
                    emitLiveTrace({
                      jobId: job.jobId,
                      stage: "tool",
                      status: toolRes.ok ? "ok" : "error",
                      title: `${toolRes.ok ? "Ran" : "Failed"} ${toolName}${isCachedHit ? " (cached)" : ""}`,
                      detail: toolRes.summary,
                      durationMs,
                    });
                    toolTrace.push({
                      round: round + 1,
                      toolName: tc.function?.name || "unknown",
                      args: parsedArgs,
                      ok: toolRes.ok,
                      summary: toolRes.summary,
                      durationMs,
                    });
                    messages.push({
                      role: "tool",
                      tool_call_id: tc.id,
                      content: isCachedHit
                        ? `[CACHED DUPLICATE CALL] You already ran ${toolName} with these exact arguments earlier in this session. Do NOT repeat this call; use the earlier output above and either inspect a different file or write your final Markdown report now.`
                        : toolRes.output,
                    });
                  }
                  continue;
                }

                rawContent = (msg?.content || "").trim();
                if (rawContent.includes("<function_calls>") || rawContent.includes("<invoke ")) {
                  const stripped = rawContent.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "").trim();
                  messages.push({ role: "assistant", content: stripped || "I have inspected the repository files." });
                  messages.push({
                    role: "user",
                    content:
                      "Tool calling is now closed. Do NOT output <function_calls> or XML. Write the complete final Markdown deliverable/audit report now based strictly on the files you already read.",
                  });
                  const finalData = await callModelTurn(activeModel, messages, false);
                  rawContent = (finalData.choices?.[0]?.message?.content || stripped || "").replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "").trim();
                }
                emitLiveTrace({
                  jobId: job.jobId,
                  stage: "ai",
                  status: "ok",
                  title: `Generated deliverable (${rawContent.length.toLocaleString()} chars)`,
                  detail: `Model: ${resolvedModel} · Prompt ${totalPromptTokens} + Completion ${totalCompletionTokens} tokens`,
                  durationMs: Math.max(1, Date.now() - roundT0),
                });
                break;
              }
              if (rawContent) break;
            } catch (modelErr) {
              const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
              emitLiveTrace({
                jobId: job.jobId,
                stage: "ai",
                status: "error",
                title: `${activeModel} failed`,
                detail: msg,
              });
              if (msg.includes("HTTP 401") || msg.includes("HTTP 402") || modelIdx === candidateModels.length - 1) {
                throw modelErr;
              }
              // Fall back to next model in routePlan
            }
          }

          if (!rawContent) {
            throw new Error("NEAR_AI_EMPTY_RESPONSE: choices[0].message.content was empty");
          }

          // Optional Cross-Model Peer Review for Tier-3 Audit jobs when tools were executed
          let peerReviewSection = "";
          if (
            routePlan.criticModel &&
            routePlan.criticModel !== resolvedModel &&
            toolTrace.length > 0
          ) {
            try {
              const criticResp = await callModelTurn(
                routePlan.criticModel,
                [
                  {
                    role: "system",
                    content:
                      "You are an independent Security & Accuracy Peer Reviewer. Review the worker's deliverable against the task and tool evidence. Flag any gaps, unverified claims, or missed edge cases concisely in 3-5 bullets, or confirm verification.",
                  },
                  {
                    role: "user",
                    content: `Task: ${job.taskDescription}\n\nTools Executed: ${toolTrace.map((t) => `${t.toolName}(${t.summary})`).join(", ")}\n\nWorker Deliverable (${resolvedModel}):\n${rawContent.slice(0, 8000)}`,
                  },
                ],
                false
              );
              const criticText = criticResp.choices?.[0]?.message?.content?.trim();
              if (criticText) {
                totalPromptTokens += Number(criticResp.usage?.prompt_tokens ?? 0);
                totalCompletionTokens += Number(criticResp.usage?.completion_tokens ?? 0);
                totalTokensSum += Number(criticResp.usage?.total_tokens ?? 0);
                peerReviewSection = `\n\n---\n### Independent Cross-Model Peer Review (\`${criticResp.model || routePlan.criticModel}\`)\n${criticText}`;
              }
            } catch {
              // Non-fatal: keep primary deliverable if critic fails
            }
          }

          const tokenUsage: AITokenUsage = {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalTokensSum || totalPromptTokens + totalCompletionTokens,
          };

          const toolSummaryLine =
            toolTrace.length > 0
              ? `> **Agentic Tools Executed (${toolTrace.length}):** ${toolTrace.map((t) => `\`${t.toolName}\` (${t.summary})`).join(" · ")}`
              : `> **Agentic Tools Executed:** \`0\` (direct reasoning)`;

          const liveHeader = [
            `> **Execution Mode:** \`[LIVE NEAR AI CLOUD — AGENTIC WORKER]\``,
            `> **Endpoint:** \`${endpoint}\``,
            `> **Model:** \`${resolvedModel}\` (\`${routePlan.tier}\`)${lastRequestId ? ` | **Request ID:** \`${lastRequestId}\`` : ""}`,
            `> **Routing:** ${routePlan.reason}`,
            toolSummaryLine,
            `> **Token Usage:** Prompt \`${tokenUsage.promptTokens}\` + Completion \`${tokenUsage.completionTokens}\` = Total \`${tokenUsage.totalTokens}\` tokens`,
            ``,
          ].join("\n");

          const deliverableMarkdown = `${liveHeader}\n${rawContent}${peerReviewSection}`;
          const deliveryHash = sha256Hex(
            `snowmoon-delivery|${job.jobId}|${job.termsHash}|${deliverableMarkdown}`
          );

          return {
            jobId: job.jobId,
            workerId,
            adapterMode: "near_ai",
            adapterLabel: `LIVE NEAR AI CLOUD (${resolvedModel})`,
            model: resolvedModel,
            endpoint,
            requestId: lastRequestId,
            tokenUsage,
            taskPrompt: job.taskDescription,
            summary: rawContent.split("\n").find((l) => l.trim().length > 0)?.replace(/^#+\s*/, "").slice(0, 160) || "NEAR AI Cloud live inference completed.",
            deliverableMarkdown,
            deliveryHash,
            executedAt: new Date().toISOString(),
            durationMs: Math.max(1, Date.now() - startMs),
          };
        } catch (err) {
          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || /aborted|timeout/i.test(err.message));
          const rawMsg = isAbort
            ? `NEAR_AI_TIMEOUT: request exceeded ${timeoutMs}ms`
            : err instanceof Error
            ? err.message
            : String(err);
          fallbackReason = sanitizeErrorMessage(
            rawMsg,
            this.config.secrets.nearAiApiKey
          );
          if (this.config.isProductionMode) {
            throw new Error(`ERR_NEAR_AI_INFERENCE_FAILED: ${fallbackReason}`);
          }
        }
      }
    }

    if (this.config.isProductionMode) {
      throw new Error(
        `ERR_AI_MOCK_FALLBACK_FORBIDDEN_IN_PRODUCTION: ${fallbackReason || "NEAR AI Cloud execution failed."}`
      );
    }

    // Genuine deterministic local fallback execution of the task prompt + expense receipts
    const expensesTable =
      job.expenses.length > 0
        ? job.expenses
            .map(
              (e, idx) =>
                `| ${idx + 1} | ${e.vendor} | $${(Number(e.amountUsdc) / 1e6).toFixed(2)} USDC | \`${e.policyVerdict}\` | \`${e.receiptHash.slice(0, 18)}...\` |`
            )
            .join("\n")
        : "| - | No external paid API calls required | $0.00 USDC | `NONE` | `-` |";

    const fallbackLine = fallbackReason
      ? `> **Fallback Reason:** \`${fallbackReason}\`\n`
      : "";

    const deliverableMarkdown = [
      `# SnowMoon Verifiable Deliverable — ${job.title}`,
      ``,
      `> **Execution Mode:** \`[MOCK AI WORKER ADAPTER — DETERMINISTIC LOCAL EXECUTION]\``,
      fallbackLine ? fallbackLine.trimEnd() : null,
      `> **Job ID:** \`${job.jobId}\``,
      `> **Terms Hash:** \`${job.termsHash}\``,
      `> **Customer:** \`${job.customer}\` | **Operator:** \`${job.operator}\``,
      ``,
      `## 1. Task Execution Summary`,
      `Executed autonomous analysis for task: *"${job.taskDescription}"*`,
      ``,
      `- **Contract Escrow Verified:** $${(Number(job.customerPayment) / 1e6).toFixed(2)} USDC locked in \`${this.config.coreContractId}\`.`,
      `- **Working Capital Advance:** ${
        job.advanceId !== 0
          ? `Advance #${job.advanceId} active from FloatPool.`
          : `Self-funded by operator.`
      }`,
      `- **Operating Spend:** $${(Number(job.operatingSpent) / 1e6).toFixed(2)} USDC of $${(
        Number(job.maxOperatingBudget) / 1e6
      ).toFixed(2)} USDC maximum operating budget.`,
      ``,
      `## 2. Controlled Spending & Policy Receipts`,
      `| # | Vendor / Feed | Amount | Policy Verdict | Receipt Hash |`,
      `|---|---|---|---|---|`,
      expensesTable,
      ``,
      `## 3. Protocol & Risk Findings`,
      `1. **Storage Safety Invariant:** Per-job storage reservation of \`0.023 NEAR\` covers the \`1,521 B\` worst-case dual in-flight claim peak with a \`1.5x\` safety margin (\`2,282 B\`).`,
      `2. **FloatPool Share Integrity:** Virtual offset (\`1,000,000\`) prevents ERC-4626/NEP-141 share inflation attacks and bounds rounding loss to \`<= 1\` atomic USDC unit.`,
      `3. **Settlement Priority:** On \`accept_delivery\`, \`FloatPool\` advance principal and 2.00% fee are repaid first before \`operator_net\` is released.`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const deliveryHash = sha256Hex(
      `snowmoon-delivery|${job.jobId}|${job.termsHash}|${deliverableMarkdown}`
    );

    return {
      jobId: job.jobId,
      workerId,
      adapterMode: "mock",
      adapterLabel: fallbackReason
        ? "MOCK AI WORKER ADAPTER (FALLBACK AFTER LIVE API ERROR)"
        : "MOCK AI WORKER ADAPTER (DETERMINISTIC LOCAL EXECUTION)",
      model: "snowmoon-deterministic-worker-v1",
      fallbackReason,
      taskPrompt: job.taskDescription,
      summary: `Completed verifiable analysis for "${job.title}" with ${job.expenses.length} policy-checked expense receipt(s).`,
      deliverableMarkdown,
      deliveryHash,
      executedAt: new Date().toISOString(),
      durationMs: Math.max(2, Date.now() - startMs),
    };
  }
}

