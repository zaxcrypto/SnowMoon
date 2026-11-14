import fs from "node:fs";
import path from "node:path";
import type { SnowMoonConfig } from "./config.ts";

export interface PersistedSnowMoonData {
  customers: Record<string, unknown>[];
  workers: Record<string, unknown>[];
  workforceJobs: Record<string, unknown>[];
  escrowJobs: Record<string, unknown>[];
  intents: Record<string, unknown>[];
  outlayerCalls: Record<string, unknown>[];
  verifications: Record<string, unknown>[];
  settlements: Record<string, unknown>[];
  walletChallenges?: Record<string, unknown>[];
  updatedAt: string;
}

export type CollectionKey = keyof Omit<PersistedSnowMoonData, "updatedAt">;

const EMPTY_DATA: PersistedSnowMoonData = {
  customers: [],
  workers: [],
  workforceJobs: [],
  escrowJobs: [],
  intents: [],
  outlayerCalls: [],
  verifications: [],
  settlements: [],
  walletChallenges: [],
  updatedAt: new Date(0).toISOString(),
};

const FORBIDDEN_SECRET_FIELDS = new Set([
  "privateKey",
  "private_key",
  "seedPhrase",
  "seed_phrase",
  "mnemonic",
  "apiKey",
  "api_key",
  "secretKey",
  "secret_key",
  "paymentKey",
  "payment_key",
]);

/**
 * Ensures no private keys, seed phrases, or API secrets are ever persisted.
 */
export function assertNoSecretsInRecords(records: unknown[]): void {
  const visit = (val: unknown, depth = 0): void => {
    if (depth > 8 || val === null || typeof val !== "object") return;
    if (Array.isArray(val)) {
      for (const item of val) visit(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_FIELDS.has(k) && typeof v === "string" && v.trim().length > 0) {
        throw new Error(`ERR_FORBIDDEN_SECRET_PERSISTENCE: Refusing to persist secret field "${k}"`);
      }
      if (typeof v === "string" && /^ed25519:[A-Za-z0-9]{30,}$/.test(v.trim())) {
        throw new Error("ERR_FORBIDDEN_SECRET_PERSISTENCE: Refusing to persist ed25519 private key");
      }
      visit(v, depth + 1);
    }
  };
  visit(records, 0);
}

export interface DatabaseHealthStatus {
  backend: "supabase" | "json";
  productionReady: boolean;
  connected: boolean;
  migrationsApplied: boolean;
  rlsHardened: boolean;
  migrationVersion: string | null;
  pendingSyncCount: number;
  migrationFile: string;
  details: string;
}

export type SupabaseRowMode = "kv" | "dual" | "row";

export interface ConsumedChallengeRow {
  challenge_id: string;
  account_id: string;
  nonce_base64: string;
  recipient: string;
  message: string;
  expires_at_ms: number;
  consumed: boolean;
  payload: Record<string, unknown>;
  version: number;
}

export interface DatabaseAdapter {
  readonly backend: "supabase" | "json";
  getCollection<T>(key: CollectionKey): T[];
  saveCollection<T>(key: CollectionKey, items: T[]): void;
  saveCollectionAsync?<T>(key: CollectionKey, items: T[]): Promise<void>;
  ensureHydrated?(failClosed?: boolean): Promise<void>;
  flushPending?(): Promise<void>;
  upsertOutlayerCallRow?(row: Record<string, unknown>): Promise<void>;
  consumeWalletChallengeAtomic?(challengeId: string, nowMs: number): Promise<ConsumedChallengeRow | null>;
  healthCheck(): Promise<DatabaseHealthStatus>;
}

/**
 * Local development JSON adapter (atomic temp write + rename).
 * Not intended for multi-instance production scaling.
 */
export class JsonFileDatabaseAdapter implements DatabaseAdapter {
  public readonly backend = "json" as const;
  private readonly filePath: string;
  private data: PersistedSnowMoonData;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): PersistedSnowMoonData {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { ...EMPTY_DATA };
      }
      const raw = fs.readFileSync(this.filePath, "utf8").trim();
      if (!raw) return { ...EMPTY_DATA };
      const parsed = JSON.parse(raw) as Partial<PersistedSnowMoonData>;
      return {
        customers: Array.isArray(parsed.customers) ? parsed.customers : [],
        workers: Array.isArray(parsed.workers) ? parsed.workers : [],
        workforceJobs: Array.isArray(parsed.workforceJobs) ? parsed.workforceJobs : [],
        escrowJobs: Array.isArray(parsed.escrowJobs) ? parsed.escrowJobs : [],
        intents: Array.isArray(parsed.intents) ? parsed.intents : [],
        outlayerCalls: Array.isArray(parsed.outlayerCalls) ? parsed.outlayerCalls : [],
        verifications: Array.isArray(parsed.verifications) ? parsed.verifications : [],
        settlements: Array.isArray(parsed.settlements) ? parsed.settlements : [],
        walletChallenges: Array.isArray(parsed.walletChallenges) ? parsed.walletChallenges : [],
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
    } catch {
      return { ...EMPTY_DATA };
    }
  }

  private flushToDisk(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  public getCollection<T>(key: CollectionKey): T[] {
    return (this.data[key] as unknown as T[]) || [];
  }

  public saveCollection<T>(key: CollectionKey, items: T[]): void {
    assertNoSecretsInRecords(items);
    this.data[key] = items as unknown as Record<string, unknown>[];
    this.flushToDisk();
  }

  public async healthCheck(): Promise<DatabaseHealthStatus> {
    return {
      backend: "json",
      productionReady: false,
      connected: true,
      migrationsApplied: false,
      rlsHardened: false,
      migrationVersion: null,
      pendingSyncCount: 0,
      migrationFile: "migrations/001_initial_schema.sql",
      details: `Local JSON file adapter active (${path.basename(this.filePath)}). Configure SUPABASE_URL + SUPABASE_SECRET_KEY and apply migrations/001_initial_schema.sql for multi-instance production.`,
    };
  }
}

interface RowTableMeta {
  table: string;
  pkCol: string;
  pkField: string;
  toColumns: (rec: Record<string, unknown>, nowIso: string) => Record<string, unknown>;
}

const ROW_TABLE_CONFIG: Record<CollectionKey, RowTableMeta> = {
  customers: {
    table: "snowmoon_customers",
    pkCol: "account_id",
    pkField: "accountId",
    toColumns: (r, nowIso) => ({
      account_id: String(r.accountId || ""),
      wallet_provider: String(r.walletProvider || "unknown"),
      network: String(r.network || "mainnet"),
      last_verified_at: String(r.lastVerifiedAt || nowIso),
      created_at: String(r.createdAt || nowIso),
      updated_at: nowIso,
      payload: r,
    }),
  },
  workers: {
    table: "snowmoon_workers",
    pkCol: "worker_id",
    pkField: "workerId",
    toColumns: (r, nowIso) => ({
      worker_id: String(r.workerId || ""),
      account_id: String(r.accountId || ""),
      display_name: String(r.displayName || ""),
      capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
      available: r.available !== false,
      token_hash: r.authKeyHash ? String(r.authKeyHash) : null,
      updated_at: nowIso,
      payload: r,
    }),
  },
  workforceJobs: {
    table: "snowmoon_workforce_jobs",
    pkCol: "job_id",
    pkField: "jobId",
    toColumns: (r, nowIso) => ({
      job_id: String(r.jobId || ""),
      customer_account_id: String(r.customerAccountId || ""),
      amount_atomic: String(r.amountAtomic || "0"),
      required_capabilities: Array.isArray(r.requiredCapabilities) ? r.requiredCapabilities : [],
      prompt: String(r.prompt || ""),
      state: String(r.state || "FUNDED"),
      assigned_worker_id: r.assignedWorkerId ? String(r.assignedWorkerId) : null,
      attempts: Number(r.attempts || 0),
      last_error: r.lastError ? String(r.lastError) : null,
      input_hash: r.inputHash ? String(r.inputHash) : null,
      output_hash: r.outputHash ? String(r.outputHash) : null,
      execution_time_ms: typeof r.executionTimeMs === "number" ? r.executionTimeMs : null,
      execution_mode: r.executionMode ? String(r.executionMode) : null,
      updated_at: nowIso,
      payload: r,
    }),
  },
  escrowJobs: {
    table: "snowmoon_escrow_jobs",
    pkCol: "intent_id",
    pkField: "intentId",
    toColumns: (r, nowIso) => ({
      intent_id: String(r.intentId || ""),
      job_id: r.jobId ? String(r.jobId) : null,
      escrow_tx_hash: r.txHash ? String(r.txHash) : null,
      customer_account_id: String(r.customerAccountId || ""),
      amount_atomic: String(r.amountAtomic || "0"),
      escrow_state: String(r.escrowState || "UNKNOWN"),
      updated_at: nowIso,
      payload: r,
    }),
  },
  intents: {
    table: "snowmoon_intents",
    pkCol: "intent_id",
    pkField: "intentId",
    toColumns: (r, nowIso) => ({
      intent_id: String(r.intentId || ""),
      idempotency_key: String(r.idempotencyKey || r.intentId || ""),
      customer_near_account: String(r.customerNearAccount || ""),
      source_wallet_address: String(r.sourceWalletAddress || ""),
      source_chain: String(r.sourceChain || ""),
      origin_asset: String(r.originAsset || ""),
      destination_asset: String(r.destinationAsset || ""),
      amount_in_atomic: String(r.amountInAtomic || "0"),
      expected_amount_out_atomic: String(r.expectedAmountOutAtomic || "0"),
      min_amount_out_atomic: String(r.minAmountOutAtomic || "0"),
      slippage_tolerance_bps: Number(r.slippageToleranceBps ?? 50),
      deposit_address: String(r.depositAddress || r.intentId || ""),
      quote_expires_at: String(r.quoteExpiresAt || nowIso),
      source_tx_hash: r.sourceTxHash ? String(r.sourceTxHash) : null,
      destination_tx_hash: r.destinationTxHash ? String(r.destinationTxHash) : null,
      lifecycle_stage: String(r.lifecycleStage || "QUOTED"),
      status: String(r.status || "PENDING_DEPOSIT"),
      destination_verified: Boolean(r.destinationVerified),
      escrow_funding_enabled: Boolean(r.escrowFundingEnabled),
      escrow_intent_id: r.escrowIntentId ? String(r.escrowIntentId) : null,
      actionable_error: r.actionableError ? String(r.actionableError) : null,
      updated_at: nowIso,
      payload: r,
    }),
  },
  outlayerCalls: {
    table: "snowmoon_outlayer_calls",
    pkCol: "request_id",
    pkField: "requestId",
    toColumns: (r, nowIso) => ({
      request_id: String(r.requestId || ""),
      call_id: r.callId ? String(r.callId) : null,
      job_id: String(r.jobId || ""),
      worker_id: String(r.workerId || ""),
      input_hash: String(r.inputHash || ""),
      output_hash: r.outputHash ? String(r.outputHash) : null,
      evidence_hash: String(r.evidenceHash || ""),
      status: String(r.status || "EXECUTION_PENDING"),
      mode: String(r.mode || "outlayer"),
      attestation_url: r.attestationUrl ? String(r.attestationUrl) : null,
      attestation_checks: r.attestationChecks ?? null,
      error: r.error ? String(r.error) : null,
      updated_at: nowIso,
      payload: r,
    }),
  },
  verifications: {
    table: "snowmoon_verifications",
    pkCol: "job_id",
    pkField: "jobId",
    toColumns: (r, nowIso) => ({
      job_id: String(r.jobId || ""),
      evidence_hash: String(r.evidenceHash || ""),
      verification_status: String(r.verificationStatus || "PENDING"),
      verifier_account_id: r.verifierAccountId ? String(r.verifierAccountId) : null,
      audit_tx_hash: r.auditTxHash ? String(r.auditTxHash) : null,
      updated_at: nowIso,
      payload: r,
    }),
  },
  settlements: {
    table: "snowmoon_settlements",
    pkCol: "settlement_id",
    pkField: "settlementId",
    toColumns: (r, nowIso) => ({
      settlement_id: String(r.settlementId || ""),
      idempotency_key: String(r.idempotencyKey || r.settlementId || ""),
      job_id: String(r.jobId || ""),
      kind: String(r.kind || "PAYOUT_ACCEPT_DELIVERY"),
      customer_account_id: String(r.customerAccountId || ""),
      worker_account_id: String(r.workerAccountId || ""),
      gross_amount_atomic: String(r.grossAmountAtomic || "0"),
      platform_fee_bps: Number(r.platformFeeBps ?? 0),
      platform_fee_atomic: String(r.platformFeeAtomic || "0"),
      worker_payout_atomic: String(r.workerPayoutAtomic || "0"),
      status: String(r.status || "PREPARED"),
      tx_hash: r.txHash ? String(r.txHash) : null,
      on_chain_confirmed: Boolean(r.onChainConfirmed),
      updated_at: nowIso,
      payload: r,
    }),
  },
  walletChallenges: {
    table: "snowmoon_wallet_challenges",
    pkCol: "challenge_id",
    pkField: "challengeId",
    toColumns: (r, nowIso) => ({
      challenge_id: String(r.challengeId || ""),
      account_id: String(r.accountId || ""),
      nonce_base64: String(r.nonceBase64 || ""),
      recipient: String(r.recipient || "snowmoon.near"),
      message: String(r.message || ""),
      expires_at_ms: Number(r.expiresAtMs || 0),
      consumed: Boolean(r.consumed),
      updated_at: nowIso,
      payload: r,
    }),
  },
};

/**
 * Production PostgreSQL/Supabase REST adapter backed by SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Supports controlled migration modes ("kv", "dual", "row"):
 * - "kv": whole-collection CAS in snowmoon_kv_collections (legacy compatible)
 * - "dual": per-record optimistic CAS in relational tables + KV mirror for instant rollback
 * - "row": per-record optimistic CAS strictly in relational tables (no whole-collection conflicts)
 */
export class SupabaseDatabaseAdapter implements DatabaseAdapter {
  public readonly backend = "supabase" as const;
  public readonly rowMode: SupabaseRowMode;
  private readonly supabaseUrl: string;
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<CollectionKey, Record<string, unknown>[]>();
  private readonly versions = new Map<CollectionKey, number>();
  private readonly rowVersions = new Map<string, number>();
  private readonly lastSyncedRowJson = new Map<string, string>();
  private readonly dirtyCollections = new Set<CollectionKey>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly writeChains = new Map<CollectionKey, Promise<void>>();
  private hydrated = false;
  private hydratePromise: Promise<boolean> | null = null;
  private lastSyncError: string | null = null;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    _unusedFallbackPath?: string,
    fetchImpl: typeof fetch = fetch,
    rowMode: SupabaseRowMode = "kv"
  ) {
    this.supabaseUrl = supabaseUrl.replace(/\/+$/, "");
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.rowMode = rowMode;
  }

  private headers(prefer = "resolution=merge-duplicates,return=representation"): Record<string, string> {
    return {
      apikey: this.secretKey,
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    };
  }

  public getCollection<T>(key: CollectionKey): T[] {
    return (this.cache.get(key) as unknown as T[]) || [];
  }

  private enqueueCollectionWrite<T>(key: CollectionKey, items: T[]): Promise<void> {
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.syncCollectionRemote(key, items));
    this.writeChains.set(key, next.catch(() => {}));
    return next;
  }

  public saveCollection<T>(key: CollectionKey, items: T[]): void {
    assertNoSecretsInRecords(items);
    this.cache.set(key, items as unknown as Record<string, unknown>[]);
    this.dirtyCollections.add(key);
    const p = this.enqueueCollectionWrite(key, items).catch((err) => {
      this.lastSyncError = err instanceof Error ? err.message : String(err);
      throw err;
    });
    // Prevent unhandled rejection while still allowing flushPending() to observe failures.
    const tracked = p.finally(() => {
      this.pendingWrites.delete(tracked);
    });
    tracked.catch(() => {});
    this.pendingWrites.add(tracked);
  }

  public async saveCollectionAsync<T>(key: CollectionKey, items: T[]): Promise<void> {
    assertNoSecretsInRecords(items);
    this.cache.set(key, items as unknown as Record<string, unknown>[]);
    this.dirtyCollections.add(key);
    await this.enqueueCollectionWrite(key, items);
  }

  public async ensureHydrated(failClosed = false): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrateFromRemote().finally(() => {
        this.hydratePromise = null;
      });
    }
    const ok = await this.hydratePromise;
    if (!ok && failClosed) {
      throw new Error(
        `ERR_SUPABASE_HYDRATION_FAILED: ${this.lastSyncError || "Failed to hydrate state from Supabase on cold start."}`
      );
    }
  }

  public async flushPending(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      const results = await Promise.allSettled(Array.from(this.pendingWrites));
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) {
        throw rejected.reason instanceof Error
          ? rejected.reason
          : new Error(String(rejected.reason));
      }
    }
    if (this.dirtyCollections.size > 0) {
      const { failed } = await this.resyncPending();
      if (failed.length > 0) {
        throw new Error(
          `ERR_SUPABASE_WRITE_FAILED: Failed to persist collections [${failed.join(", ")}]: ${this.lastSyncError || "unknown error"}`
        );
      }
    }
  }

  public getPendingSyncCount(): number {
    return this.dirtyCollections.size;
  }

  public async resyncPending(): Promise<{ synced: CollectionKey[]; failed: CollectionKey[] }> {
    const synced: CollectionKey[] = [];
    const failed: CollectionKey[] = [];
    for (const key of Array.from(this.dirtyCollections)) {
      try {
        await this.syncCollectionRemote(key, this.getCollection(key));
        synced.push(key);
      } catch {
        failed.push(key);
      }
    }
    return { synced, failed };
  }

  public async upsertOutlayerCallRow(row: Record<string, unknown>): Promise<void> {
    assertNoSecretsInRecords([row]);
    const resp = await this.fetchImpl(
      `${this.supabaseUrl}/rest/v1/snowmoon_outlayer_calls?on_conflict=request_id`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(row),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ERR_OUTLAYER_PERSIST_FAILED: HTTP ${resp.status} ${txt.slice(0, 160)}`);
    }
  }

  private async syncRowLevelCollection<T>(key: CollectionKey, items: T[]): Promise<void> {
    const meta = ROW_TABLE_CONFIG[key];
    const nowIso = new Date().toISOString();
    const records = items as unknown as Record<string, unknown>[];

    for (const rec of records) {
      const pkVal = String(rec[meta.pkField] || "");
      if (!pkVal) continue;
      const rowKey = `${key}:${pkVal}`;
      const serialized = JSON.stringify(rec);
      if (this.lastSyncedRowJson.get(rowKey) === serialized) {
        continue;
      }
      const expectedVersion = this.rowVersions.get(rowKey);
      const cols = meta.toColumns(rec, nowIso);
      if (expectedVersion !== undefined) {
        const resp = await this.fetchImpl(
          `${this.supabaseUrl}/rest/v1/${meta.table}?${meta.pkCol}=eq.${encodeURIComponent(pkVal)}&version=eq.${expectedVersion}`,
          {
            method: "PATCH",
            headers: this.headers("return=representation"),
            body: JSON.stringify({
              ...cols,
              version: expectedVersion + 1,
            }),
          }
        );
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`Supabase row CAS PATCH HTTP ${resp.status} (${meta.table}): ${txt.slice(0, 160)}`);
        }
        const updated = (await resp.json().catch(() => [])) as Array<{ version?: number }>;
        if (Array.isArray(updated) && updated.length === 0) {
          throw new Error(
            `ERR_CONCURRENT_WRITE_CONFLICT: Row "${pkVal}" in "${meta.table}" was modified by another instance (expected version ${expectedVersion}).`
          );
        }
        this.rowVersions.set(rowKey, Number(updated[0]?.version ?? expectedVersion + 1));
        this.lastSyncedRowJson.set(rowKey, serialized);
      } else {
        const resp = await this.fetchImpl(
          `${this.supabaseUrl}/rest/v1/${meta.table}`,
          {
            method: "POST",
            headers: this.headers("return=representation"),
            body: JSON.stringify({
              ...cols,
              version: 1,
            }),
          }
        );
        if (resp.status === 409) {
          throw new Error(
            `ERR_CONCURRENT_WRITE_CONFLICT: Row "${pkVal}" in "${meta.table}" was inserted concurrently by another instance.`
          );
        }
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`Supabase row INSERT HTTP ${resp.status} (${meta.table}): ${txt.slice(0, 160)}`);
        }
        const inserted = (await resp.json().catch(() => [])) as Array<{ version?: number }>;
        this.rowVersions.set(rowKey, Number(inserted[0]?.version ?? 1));
        this.lastSyncedRowJson.set(rowKey, serialized);
      }
    }
  }

  public async consumeWalletChallengeAtomic(
    challengeId: string,
    nowMs: number
  ): Promise<ConsumedChallengeRow | null> {
    if (this.rowMode === "kv") return null;
    const resp = await this.fetchImpl(
      `${this.supabaseUrl}/rest/v1/rpc/snowmoon_consume_wallet_challenge`,
      {
        method: "POST",
        headers: this.headers("return=representation"),
        body: JSON.stringify({
          p_challenge_id: challengeId,
          p_now_ms: nowMs,
        }),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ERR_CHALLENGE_CONSUME_RPC_FAILED: HTTP ${resp.status} ${txt.slice(0, 160)}`);
    }
    const rows = (await resp.json().catch(() => [])) as ConsumedChallengeRow[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }
    const consumed = rows[0];
    const rowKey = `walletChallenges:${consumed.challenge_id}`;
    this.rowVersions.set(rowKey, Number(consumed.version));
    const current = this.getCollection<Record<string, unknown>>("walletChallenges");
    const next = current.map((r) =>
      String(r.challengeId || "") === consumed.challenge_id
        ? { ...r, consumed: true }
        : r
    );
    this.cache.set("walletChallenges", next);
    return consumed;
  }

  public async verifyRowVsKvParity(): Promise<{
    parityOk: boolean;
    mismatches: Array<{ collection: CollectionKey; kvCount: number; rowCount: number; missingInRow: string[]; missingInKv: string[] }>;
  }> {
    const mismatches: Array<{ collection: CollectionKey; kvCount: number; rowCount: number; missingInRow: string[]; missingInKv: string[] }> = [];
    for (const key of Object.keys(ROW_TABLE_CONFIG) as CollectionKey[]) {
      const cfg = ROW_TABLE_CONFIG[key];
      const kvResp = await this.fetchImpl(
        `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections?collection_key=eq.${encodeURIComponent(key)}&select=payload`,
        { method: "GET", headers: this.headers() }
      );
      const rowResp = await this.fetchImpl(
        `${this.supabaseUrl}/rest/v1/${cfg.table}?select=${encodeURIComponent(cfg.pkCol)},payload`,
        { method: "GET", headers: this.headers() }
      );
      if (!kvResp.ok || !rowResp.ok) {
        throw new Error(`ERR_PARITY_CHECK_FAILED: HTTP ${kvResp.status}/${rowResp.status} for ${key}`);
      }
      const kvRows = (await kvResp.json().catch(() => [])) as Array<{ payload?: unknown[] }>;
      const kvItems = Array.isArray(kvRows[0]?.payload) ? (kvRows[0].payload as Array<Record<string, unknown>>) : [];
      const rowItems = (await rowResp.json().catch(() => [])) as Array<Record<string, unknown>>;

      const kvIds = new Set(kvItems.map((item) => String(item[cfg.pkField] || "")).filter(Boolean));
      const rowIds = new Set(rowItems.map((r) => String(r[cfg.pkCol] || (r.payload as Record<string, unknown> | undefined)?.[cfg.pkField] || "")).filter(Boolean));

      const missingInRow = [...kvIds].filter((id) => !rowIds.has(id));
      const missingInKv = [...rowIds].filter((id) => !kvIds.has(id));
      if (missingInRow.length > 0 || missingInKv.length > 0 || kvItems.length !== rowItems.length) {
        mismatches.push({ collection: key, kvCount: kvItems.length, rowCount: rowItems.length, missingInRow, missingInKv });
      }
    }
    return { parityOk: mismatches.length === 0, mismatches };
  }

  public async syncCollectionRemote<T>(key: CollectionKey, items: T[]): Promise<void> {
    assertNoSecretsInRecords(items);
    if (this.rowMode === "row") {
      try {
        await this.syncRowLevelCollection(key, items);
        this.dirtyCollections.delete(key);
        this.lastSyncError = null;
        return;
      } catch (err) {
        this.dirtyCollections.add(key);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }
    if (this.rowMode === "dual") {
      try {
        await this.syncRowLevelCollection(key, items);
      } catch (err) {
        this.dirtyCollections.add(key);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const expectedVersion = this.versions.get(key);
        const nowIso = new Date().toISOString();
        let resp: Response;
        if (expectedVersion !== undefined) {
          // Optimistic CAS update when version column is tracked
          resp = await this.fetchImpl(
            `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections?collection_key=eq.${encodeURIComponent(key)}&version=eq.${expectedVersion}`,
            {
              method: "PATCH",
              headers: this.headers("return=representation"),
              body: JSON.stringify({
                payload: items,
                version: expectedVersion + 1,
                updated_at: nowIso,
              }),
            }
          );
          if (resp.ok) {
            const updatedRows = (await resp.json().catch(() => [])) as Array<{ version?: number }>;
            if (Array.isArray(updatedRows) && updatedRows.length === 0) {
              throw new Error(
                `ERR_CONCURRENT_WRITE_CONFLICT: Collection "${key}" was modified by another instance (expected version ${expectedVersion}).`
              );
            }
            this.versions.set(key, Number(updatedRows[0]?.version ?? expectedVersion + 1));
            this.dirtyCollections.delete(key);
            this.lastSyncError = null;
            return;
          }
          const patchTxt = await resp.text().catch(() => "");
          lastErr = new Error(`Supabase CAS PATCH HTTP ${resp.status}: ${patchTxt.slice(0, 160)}`);
          if (resp.status < 500) break;
          continue;
        }

        // Initial insert when collection does not exist yet (no merge-duplicates so concurrent insert fails closed)
        resp = await this.fetchImpl(
          `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections`,
          {
            method: "POST",
            headers: this.headers("return=representation"),
            body: JSON.stringify({
              collection_key: key,
              payload: items,
              version: 1,
              updated_at: nowIso,
            }),
          }
        );
        if (resp.ok) {
          const rows = (await resp.json().catch(() => [])) as Array<{ version?: number }>;
          this.versions.set(key, Number(rows[0]?.version ?? 1));
          this.dirtyCollections.delete(key);
          this.lastSyncError = null;
          return;
        }
        if (resp.status === 409) {
          throw new Error(
            `ERR_CONCURRENT_WRITE_CONFLICT: Collection "${key}" was created concurrently by another instance.`
          );
        }
        const txt = await resp.text().catch(() => "");
        lastErr = new Error(`Supabase sync HTTP ${resp.status}: ${txt.slice(0, 160)}`);
        if (resp.status < 500) break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (lastErr.message.includes("ERR_CONCURRENT_WRITE_CONFLICT")) break;
      }
    }
    this.dirtyCollections.add(key);
    this.lastSyncError = lastErr?.message || "Unknown Supabase sync failure";
    throw lastErr || new Error("Supabase sync failed");
  }

  public async hydrateFromRemote(): Promise<boolean> {
    try {
      if (this.rowMode === "row") {
        for (const [key, meta] of Object.entries(ROW_TABLE_CONFIG) as [CollectionKey, RowTableMeta][]) {
          const resp = await this.fetchImpl(
            `${this.supabaseUrl}/rest/v1/${meta.table}?select=payload,version`,
            { method: "GET", headers: this.headers("return=representation") }
          );
          if (!resp.ok) {
            this.lastSyncError = `Hydrate ${meta.table} HTTP ${resp.status}`;
            return false;
          }
          const rows = (await resp.json()) as Array<{
            payload?: Record<string, unknown>;
            version?: number;
          }>;
          const items: Record<string, unknown>[] = [];
          for (const row of rows) {
            if (row.payload && typeof row.payload === "object") {
              items.push(row.payload);
              const pkVal = String(row.payload[meta.pkField] || "");
              if (pkVal) {
                const rowKey = `${key}:${pkVal}`;
                this.rowVersions.set(rowKey, Number(row.version ?? 1));
                this.lastSyncedRowJson.set(rowKey, JSON.stringify(row.payload));
              }
            }
          }
          this.cache.set(key, items);
        }
        this.hydrated = true;
        return true;
      }
      const resp = await this.fetchImpl(
        `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections?select=*`,
        { method: "GET", headers: this.headers("return=representation") }
      );
      if (!resp.ok) {
        this.lastSyncError = `Hydrate HTTP ${resp.status}`;
        return false;
      }
      const rows = (await resp.json()) as Array<{
        collection_key: CollectionKey;
        payload: unknown[];
        version?: number;
      }>;
      for (const row of rows) {
        if (row.collection_key && Array.isArray(row.payload)) {
          this.cache.set(row.collection_key, row.payload as Record<string, unknown>[]);
          if (typeof row.version === "number") {
            this.versions.set(row.collection_key, row.version);
          }
        }
      }
      if (this.rowMode === "dual") {
        for (const [key, meta] of Object.entries(ROW_TABLE_CONFIG) as [CollectionKey, RowTableMeta][]) {
          const rResp = await this.fetchImpl(
            `${this.supabaseUrl}/rest/v1/${meta.table}?select=payload,version`,
            { method: "GET", headers: this.headers("return=representation") }
          );
          if (rResp.ok) {
            const rRows = (await rResp.json().catch(() => [])) as Array<{
              payload?: Record<string, unknown>;
              version?: number;
            }>;
            for (const row of rRows) {
              if (row.payload && typeof row.payload === "object") {
                const pkVal = String(row.payload[meta.pkField] || "");
                if (pkVal) {
                  const rowKey = `${key}:${pkVal}`;
                  this.rowVersions.set(rowKey, Number(row.version ?? 1));
                  this.lastSyncedRowJson.set(rowKey, JSON.stringify(row.payload));
                }
              }
            }
          }
        }
      }
      this.hydrated = true;
      return true;
    } catch (err) {
      this.lastSyncError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  public async healthCheck(): Promise<DatabaseHealthStatus> {
    try {
      const resp = await this.fetchImpl(
        `${this.supabaseUrl}/rest/v1/snowmoon_migrations?select=id&order=id.asc&limit=10`,
        { method: "GET", headers: this.headers() }
      );
      if (resp.ok) {
        const rows = (await resp.json()) as Array<{ id: string }>;
        const applied001 = rows.some((r) => r.id === "001_initial_schema");
        const rlsHardened = rows.some((r) => r.id === "002_rls_hardening");
        const applied003 = rows.some((r) => r.id === "003_kv_versioning_and_locks");
        const applied004 = rows.some((r) => r.id === "004_row_level_persistence");
        const latestVersion = applied004
          ? "004_row_level_persistence"
          : applied003
          ? "003_kv_versioning_and_locks"
          : rlsHardened
          ? "002_rls_hardening"
          : applied001
          ? "001_initial_schema"
          : rows[rows.length - 1]?.id ?? null;
        return {
          backend: "supabase",
          productionReady: applied001 && (this.rowMode === "kv" || applied004),
          connected: true,
          migrationsApplied: applied001,
          rlsHardened,
          migrationVersion: latestVersion,
          pendingSyncCount: this.dirtyCollections.size,
          migrationFile: applied004 ? "migrations/004_row_level_persistence.sql" : "migrations/001_initial_schema.sql",
          details: applied001
            ? `Connected to Supabase PostgreSQL (rowMode=${this.rowMode}, latest=${latestVersion}).`
            : "Connected to Supabase, but 001_initial_schema is not yet applied.",
        };
      }
      const txt = await resp.text().catch(() => "");
      return {
        backend: "supabase",
        productionReady: false,
        connected: resp.status !== 0,
        migrationsApplied: false,
        rlsHardened: false,
        migrationVersion: null,
        pendingSyncCount: this.dirtyCollections.size,
        migrationFile: "migrations/001_initial_schema.sql",
        details: `Supabase table check returned HTTP ${resp.status}: ${txt.slice(0, 160)}. Apply migrations/001_initial_schema.sql in Supabase SQL editor.`,
      };
    } catch (err) {
      return {
        backend: "supabase",
        productionReady: false,
        connected: false,
        migrationsApplied: false,
        rlsHardened: false,
        migrationVersion: null,
        pendingSyncCount: this.dirtyCollections.size,
        migrationFile: "migrations/001_initial_schema.sql",
        details: `Supabase unreachable: ${err instanceof Error ? err.message : String(err)}${
          this.lastSyncError ? ` | lastSyncError: ${this.lastSyncError}` : ""
        }`,
      };
    }
  }
}

export interface CustomerIdentityRecord {
  accountId: string;
  walletProvider: string;
  network: string;
  lastVerifiedAt: string;
  createdAt: string;
}

/**
 * Modular repository layer supporting local JSON (dev/test) and Supabase PostgreSQL (production).
 */
export class SnowMoonRepository {
  private readonly adapter: DatabaseAdapter;

  constructor(filePathOrAdapter: string | DatabaseAdapter) {
    this.adapter =
      typeof filePathOrAdapter === "string"
        ? new JsonFileDatabaseAdapter(filePathOrAdapter)
        : filePathOrAdapter;
  }

  public static fromConfig(
    config: SnowMoonConfig,
    fetchImpl: typeof fetch = fetch
  ): SnowMoonRepository {
    if (
      config.persistenceBackend === "supabase" &&
      config.supabaseUrl &&
      config.secrets.supabaseSecretKey
    ) {
      return new SnowMoonRepository(
        new SupabaseDatabaseAdapter(
          config.supabaseUrl,
          config.secrets.supabaseSecretKey,
          config.persistenceFile,
          fetchImpl,
          config.persistenceRowMode
        )
      );
    }
    return new SnowMoonRepository(new JsonFileDatabaseAdapter(config.persistenceFile));
  }

  public get backend(): "supabase" | "json" {
    return this.adapter.backend;
  }

  public getCollection<T>(key: CollectionKey): T[] {
    return this.adapter.getCollection<T>(key);
  }

  public saveCollection<T>(key: CollectionKey, items: T[]): void {
    this.adapter.saveCollection<T>(key, items);
  }

  public async saveCollectionAsync<T>(key: CollectionKey, items: T[]): Promise<void> {
    if (this.adapter.saveCollectionAsync) {
      await this.adapter.saveCollectionAsync<T>(key, items);
      return;
    }
    this.adapter.saveCollection<T>(key, items);
  }

  public async ensureHydrated(failClosed = false): Promise<void> {
    if (this.adapter.ensureHydrated) {
      await this.adapter.ensureHydrated(failClosed);
    }
  }

  public async flushPending(): Promise<void> {
    if (this.adapter.flushPending) {
      await this.adapter.flushPending();
    }
  }

  public async upsertOutlayerCallRow(row: Record<string, unknown>): Promise<void> {
    if (this.adapter.upsertOutlayerCallRow) {
      await this.adapter.upsertOutlayerCallRow(row);
    }
  }

  public async consumeWalletChallengeAtomic(
    challengeId: string,
    nowMs: number
  ): Promise<ConsumedChallengeRow | null> {
    if (this.adapter.consumeWalletChallengeAtomic) {
      return this.adapter.consumeWalletChallengeAtomic(challengeId, nowMs);
    }
    return null;
  }

  public recordCustomerIdentity(params: {
    accountId: string;
    walletProvider: string;
    network: string;
  }): CustomerIdentityRecord {
    const existing = this.getCollection<CustomerIdentityRecord>("customers");
    const now = new Date().toISOString();
    const idx = existing.findIndex((c) => c.accountId === params.accountId);
    const record: CustomerIdentityRecord = {
      accountId: params.accountId,
      walletProvider: params.walletProvider,
      network: params.network,
      lastVerifiedAt: now,
      createdAt: idx >= 0 ? existing[idx].createdAt : now,
    };
    if (idx >= 0) {
      existing[idx] = record;
    } else {
      existing.push(record);
    }
    this.saveCollection("customers", existing);
    return record;
  }

  public async healthCheck(): Promise<DatabaseHealthStatus> {
    return this.adapter.healthCheck();
  }
}
