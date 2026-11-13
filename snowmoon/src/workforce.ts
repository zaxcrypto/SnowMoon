import crypto from "node:crypto";
import type { AIWorkerAdapter } from "./adapters.ts";
import type { AITokenUsage, JobRecord } from "./engine.ts";
import type { OutLayerExecutionAdapter } from "./outlayer.ts";
import type { SnowMoonRepository } from "./persistence.ts";

export type WorkforceLifecycleState =
  | "CREATED"
  | "FUNDED"
  | "ASSIGNED"
  | "ACCEPTED"
  | "EXECUTING"
  | "DELIVERED"
  | "VERIFIED"
  | "SETTLED"
  | "FAILED"
  | "CANCELLED";

export interface WorkerProfile {
  workerId: string;
  accountId: string;
  displayName: string;
  capabilities: string[];
  available: boolean;
  maxConcurrentJobs: number;
  activeJobs: number;
  completedJobs: number;
  earningsAtomic: string;
  authKeyHash?: string;
  registeredAt: string;
}

export interface WorkforceJobExecution {
  jobId: string;
  customerAccountId: string;
  amountAtomic: string;
  requiredCapabilities: string[];
  prompt: string;
  inputHash: string;
  outputHash: string | null;
  executionTimeMs: number | null;
  deadlineSec: number;
  state: WorkforceLifecycleState;
  assignedWorkerId: string | null;
  assignedWorkerAccountId: string | null;
  attempts: number;
  executionMode: "live_near_ai" | "mock_fallback" | null;
  aiModel: string | null;
  aiTokenUsage: AITokenUsage | null;
  outlayerRequestId: string | null;
  outlayerMode: "live_outlayer" | "mock_fallback" | null;
  output: Record<string, unknown> | null;
  evidenceHash: string | null;
  lastError: string | null;
  updatedAt: string;
}

export class WorkforceEngine {
  private readonly workers = new Map<string, WorkerProfile>();
  private readonly jobs = new Map<string, WorkforceJobExecution>();
  private readonly executingLocks = new Set<string>();
  private readonly assignmentLocks = new Set<string>();
  private readonly repo?: SnowMoonRepository;

  constructor(repo?: SnowMoonRepository) {
    this.repo = repo;
    if (repo) {
      for (const w of repo.getCollection<WorkerProfile>("workers")) {
        this.workers.set(w.workerId, w);
      }
      for (const j of repo.getCollection<WorkforceJobExecution>("workforceJobs")) {
        // Recover interrupted EXECUTING jobs after server restart
        if (j.state === "EXECUTING") {
          j.state = "FAILED";
          j.lastError = "Recovered from server restart while EXECUTING.";
          j.updatedAt = new Date().toISOString();
          if (j.assignedWorkerId) {
            const w = this.workers.get(j.assignedWorkerId);
            if (w && w.activeJobs > 0) w.activeJobs -= 1;
          }
        }
        this.jobs.set(j.jobId, j);
      }
    }
  }

  private persist(): void {
    if (this.repo) {
      this.repo.saveCollection("workers", Array.from(this.workers.values()));
      this.repo.saveCollection("workforceJobs", Array.from(this.jobs.values()));
    }
  }

  public registerWorker(params: {
    workerId: string;
    accountId: string;
    displayName: string;
    capabilities: string[];
    maxConcurrentJobs?: number;
  }): WorkerProfile {
    const workerId = params.workerId.trim();
    const accountId = params.accountId.trim();
    if (!workerId) throw new Error("ERR_INVALID_WORKER_ID: workerId is required");
    if (!accountId) throw new Error("ERR_INVALID_ACCOUNT_ID: accountId is required");
    const capabilities = Array.from(
      new Set(params.capabilities.map((c) => c.trim().toLowerCase()).filter(Boolean))
    );
    if (capabilities.length === 0) {
      throw new Error("ERR_NO_CAPABILITIES: At least one capability is required");
    }

    const existing = this.workers.get(workerId);
    const profile: WorkerProfile = {
      workerId,
      accountId,
      displayName: params.displayName.trim() || workerId,
      capabilities,
      available: true,
      maxConcurrentJobs: Math.max(1, params.maxConcurrentJobs ?? 3),
      activeJobs: existing?.activeJobs ?? 0,
      completedJobs: existing?.completedJobs ?? 0,
      earningsAtomic: existing?.earningsAtomic ?? "0",
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    };
    this.workers.set(workerId, profile);
    this.persist();
    return profile;
  }

  public issueWorkerToken(workerId: string): string {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`ERR_UNKNOWN_WORKER: ${workerId}`);
    const token = `wkt_${workerId}_${crypto.randomBytes(16).toString("hex")}`;
    w.authKeyHash = crypto.createHash("sha256").update(token).digest("hex");
    this.persist();
    return token;
  }

  public assertWorkerAuthorized(workerId: string, token: string | undefined): void {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`ERR_UNKNOWN_WORKER: ${workerId}`);
    if (!w.authKeyHash) return; // backward-compatible if no token issued
    if (!token) throw new Error("ERR_WORKER_AUTH_REQUIRED: Missing x-worker-token.");
    const hash = crypto.createHash("sha256").update(token.trim()).digest("hex");
    if (hash !== w.authKeyHash) {
      throw new Error("ERR_WORKER_UNAUTHORIZED: Invalid worker token.");
    }
  }

  public setWorkerAvailability(workerId: string, available: boolean): WorkerProfile {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`ERR_UNKNOWN_WORKER: ${workerId}`);
    w.available = available;
    this.persist();
    return w;
  }

  public listWorkers(): WorkerProfile[] {
    return Array.from(this.workers.values());
  }

  public getWorker(workerId: string): WorkerProfile | undefined {
    return this.workers.get(workerId);
  }

  public listJobs(): WorkforceJobExecution[] {
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public getJob(jobId: string): WorkforceJobExecution | undefined {
    return this.jobs.get(jobId);
  }

  public registerJob(params: {
    jobId: string;
    customerAccountId: string;
    amountAtomic: string;
    requiredCapabilities: string[];
    prompt: string;
    deadlineSec: number;
    funded?: boolean;
  }): WorkforceJobExecution {
    const existing = this.jobs.get(params.jobId);
    if (existing) return existing;
    const inputHash =
      "0x" + crypto.createHash("sha256").update(params.prompt).digest("hex");
    const job: WorkforceJobExecution = {
      jobId: params.jobId,
      customerAccountId: params.customerAccountId,
      amountAtomic: params.amountAtomic,
      requiredCapabilities: params.requiredCapabilities.map((c) => c.trim().toLowerCase()),
      prompt: params.prompt,
      inputHash,
      outputHash: null,
      executionTimeMs: null,
      deadlineSec: params.deadlineSec,
      state: params.funded ? "FUNDED" : "CREATED",
      assignedWorkerId: null,
      assignedWorkerAccountId: null,
      attempts: 0,
      executionMode: null,
      aiModel: null,
      aiTokenUsage: null,
      outlayerRequestId: null,
      outlayerMode: null,
      output: null,
      evidenceHash: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(job.jobId, job);
    this.persist();
    return job;
  }

  public matchWorkerForJob(jobId: string): WorkerProfile | null {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
    const candidates = Array.from(this.workers.values()).filter((w) => {
      if (!w.available || w.activeJobs >= w.maxConcurrentJobs) return false;
      return job.requiredCapabilities.every((cap) => w.capabilities.includes(cap));
    });
    candidates.sort((a, b) => a.activeJobs - b.activeJobs);
    return candidates[0] ?? null;
  }

  public assignJob(jobId: string, workerId?: string): WorkforceJobExecution {
    if (this.assignmentLocks.has(jobId)) {
      throw new Error(`ERR_CONCURRENT_ASSIGNMENT: Job ${jobId} assignment is already in progress.`);
    }
    this.assignmentLocks.add(jobId);
    try {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
      if (job.state === "ASSIGNED" && (!workerId || job.assignedWorkerId === workerId)) {
        return job; // Idempotent assignment
      }
      if (job.state !== "FUNDED" && job.state !== "FAILED") {
        throw new Error(`ERR_INVALID_STATE: Cannot assign job in state ${job.state}`);
      }
      const worker = workerId
        ? this.workers.get(workerId)
        : this.matchWorkerForJob(jobId);
      if (!worker) {
        throw new Error("ERR_NO_MATCHING_WORKER: No available worker matches required capabilities.");
      }
      if (!worker.available || worker.activeJobs >= worker.maxConcurrentJobs) {
        throw new Error(`ERR_WORKER_UNAVAILABLE: Worker ${worker.workerId} is unavailable or at capacity.`);
      }
      job.assignedWorkerId = worker.workerId;
      job.assignedWorkerAccountId = worker.accountId;
      job.state = "ASSIGNED";
      job.updatedAt = new Date().toISOString();
      this.persist();
      return job;
    } finally {
      this.assignmentLocks.delete(jobId);
    }
  }

  public reassignJob(jobId: string, newWorkerId?: string): WorkforceJobExecution {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
    if (job.state !== "FAILED" && job.state !== "ASSIGNED") {
      throw new Error(`ERR_INVALID_STATE: Cannot reassign job in state ${job.state}`);
    }
    if (job.assignedWorkerId && job.state === "FAILED") {
      const oldW = this.workers.get(job.assignedWorkerId);
      if (oldW && oldW.activeJobs > 0) oldW.activeJobs -= 1;
    }
    job.state = "FUNDED";
    job.assignedWorkerId = null;
    job.assignedWorkerAccountId = null;
    this.persist();
    return this.assignJob(jobId, newWorkerId);
  }

  public acceptJob(jobId: string, workerId: string): WorkforceJobExecution {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
    if (job.state !== "ASSIGNED") {
      throw new Error(`ERR_INVALID_STATE: Cannot accept job in state ${job.state}`);
    }
    if (job.assignedWorkerId !== workerId) {
      throw new Error(`ERR_NOT_ASSIGNED_WORKER: Job ${jobId} is assigned to ${job.assignedWorkerId}, not ${workerId}.`);
    }
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`ERR_UNKNOWN_WORKER: ${workerId}`);
    worker.activeJobs += 1;
    job.state = "ACCEPTED";
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  public cancelJob(jobId: string): WorkforceJobExecution {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
    if (job.state === "SETTLED" || job.state === "EXECUTING") {
      throw new Error(`ERR_CANNOT_CANCEL: Job ${jobId} is ${job.state}`);
    }
    if (job.assignedWorkerId && (job.state === "ACCEPTED")) {
      const w = this.workers.get(job.assignedWorkerId);
      if (w && w.activeJobs > 0) w.activeJobs -= 1;
    }
    job.state = "CANCELLED";
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  public updateJobState(jobId: string, nextState: WorkforceLifecycleState): WorkforceJobExecution {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${jobId}`);
    if (
      (nextState === "SETTLED" || nextState === "FAILED" || nextState === "CANCELLED") &&
      job.assignedWorkerId
    ) {
      const w = this.workers.get(job.assignedWorkerId);
      if (w && w.activeJobs > 0) w.activeJobs -= 1;
      if (nextState === "SETTLED" && w) {
        w.completedJobs += 1;
      }
    }
    job.state = nextState;
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  public creditWorkerEarnings(workerId: string, amountAtomic: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.earningsAtomic = (BigInt(w.earningsAtomic) + BigInt(amountAtomic)).toString();
    this.persist();
  }

  public async executeJob(params: {
    jobId: string;
    workerId: string;
    aiAdapter: AIWorkerAdapter;
    outlayerAdapter?: OutLayerExecutionAdapter;
    maxRetries?: number;
    timeoutMs?: number;
  }): Promise<WorkforceJobExecution> {
    const job = this.jobs.get(params.jobId);
    if (!job) throw new Error(`ERR_UNKNOWN_JOB: ${params.jobId}`);
    if (this.executingLocks.has(params.jobId)) {
      throw new Error(`ERR_DUPLICATE_EXECUTION: Job ${params.jobId} is already executing.`);
    }
    if (
      job.state === "DELIVERED" ||
      job.state === "VERIFIED" ||
      job.state === "SETTLED"
    ) {
      throw new Error(`ERR_ALREADY_EXECUTED: Job ${params.jobId} is already in state ${job.state}.`);
    }
    if (job.state !== "ACCEPTED" && job.state !== "FAILED") {
      throw new Error(`ERR_INVALID_STATE: Job ${params.jobId} must be ACCEPTED or FAILED before executing (got ${job.state}).`);
    }
    if (job.assignedWorkerId !== params.workerId) {
      throw new Error(`ERR_NOT_ASSIGNED_WORKER: Worker ${params.workerId} is not assigned to ${params.jobId}.`);
    }

    this.executingLocks.add(params.jobId);
    job.state = "EXECUTING";
    job.lastError = null;
    job.updatedAt = new Date().toISOString();
    this.persist();

    const maxAttempts = Math.max(1, (params.maxRetries ?? 1) + 1);
    const timeoutMs = params.timeoutMs ?? 20_000;

    try {
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        job.attempts += 1;
        try {
          const syntheticJobRecord: JobRecord = {
            seq: attempt,
            jobId: job.jobId,
            title: `Workforce Job ${job.jobId.slice(0, 10)}`,
            taskDescription: job.prompt,
            customer: job.customerAccountId,
            sponsor: job.customerAccountId,
            operator: job.assignedWorkerAccountId || "worker.near",
            customerPayment: job.amountAtomic,
            maxOperatingBudget: "0",
            operatingSpent: "0",
            advanceId: 0,
            storageLockedYocto: "0",
            anchored: false,
            termsHash: "0x" + "00".repeat(32),
            deliveryHash: "0x" + "00".repeat(32),
            deadlineSec: job.deadlineSec,
            state: "InProgress",
            createdAt: job.updatedAt,
            updatedAt: job.updatedAt,
            expenses: [],
          };
          const aiPromise = params.aiAdapter.executeJobTask(syntheticJobRecord);
          const aiResult = await Promise.race([
            aiPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`ERR_EXECUTION_TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
            ),
          ]);

          if (!aiResult.summary?.trim() || !aiResult.deliverableMarkdown?.trim()) {
            throw new Error("ERR_INVALID_AI_OUTPUT: Structured output requires non-empty summary and deliverableMarkdown.");
          }

          const structuredOutput = {
            jobId: job.jobId,
            workerId: params.workerId,
            workerAccountId: job.assignedWorkerAccountId,
            summary: aiResult.summary,
            result: aiResult.deliverableMarkdown,
            model: aiResult.model,
            providerMode: aiResult.adapterMode,
            completedAt: new Date().toISOString(),
          };
          const canonical = JSON.stringify(structuredOutput);
          const evidenceHash =
            "0x" + crypto.createHash("sha256").update(canonical).digest("hex");

          if (params.outlayerAdapter) {
            const olRes = await params.outlayerAdapter.executeAndVerify({
              jobId: job.jobId,
              workerId: params.workerId,
              prompt: job.prompt,
              evidenceHash,
            });
            job.outlayerRequestId = olRes.requestId;
            job.outlayerMode = olRes.mode;
          }

          job.executionMode = aiResult.adapterMode === "near_ai" ? "live_near_ai" : "mock_fallback";
          job.aiModel = aiResult.model;
          job.aiTokenUsage = aiResult.tokenUsage ?? null;
          job.output = structuredOutput;
          job.outputHash = evidenceHash;
          job.executionTimeMs = aiResult.durationMs;
          job.evidenceHash = evidenceHash;
          job.state = "DELIVERED";
          job.updatedAt = new Date().toISOString();
          this.persist();
          return job;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }

      job.state = "FAILED";
      job.lastError = lastErr?.message || "Execution failed";
      job.updatedAt = new Date().toISOString();
      this.persist();
      throw lastErr || new Error("ERR_EXECUTION_FAILED");
    } finally {
      this.executingLocks.delete(params.jobId);
    }
  }
}

