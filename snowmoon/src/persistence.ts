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

export interface DatabaseAdapter {
  readonly backend: "supabase" | "json";
  getCollection<T>(key: CollectionKey): T[];
  saveCollection<T>(key: CollectionKey, items: T[]): void;
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

/**
 * Production PostgreSQL/Supabase REST adapter backed by SUPABASE_URL + SUPABASE_SECRET_KEY
 * with synchronous in-memory read cache + async write-through to snowmoon_kv_collections
 * and local write-ahead safety backup.
 */
export class SupabaseDatabaseAdapter implements DatabaseAdapter {
  public readonly backend = "supabase" as const;
  private readonly supabaseUrl: string;
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly localBackup: JsonFileDatabaseAdapter;
  private readonly dirtyCollections = new Set<CollectionKey>();
  private lastSyncError: string | null = null;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    fallbackFilePath: string,
    fetchImpl: typeof fetch = fetch
  ) {
    this.supabaseUrl = supabaseUrl.replace(/\/+$/, "");
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.localBackup = new JsonFileDatabaseAdapter(fallbackFilePath);
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.secretKey,
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    };
  }

  public getCollection<T>(key: CollectionKey): T[] {
    return this.localBackup.getCollection<T>(key);
  }

  public saveCollection<T>(key: CollectionKey, items: T[]): void {
    assertNoSecretsInRecords(items);
    this.localBackup.saveCollection(key, items);
    this.dirtyCollections.add(key);
    void this.syncCollectionRemote(key, items).catch((err) => {
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    });
  }

  public getPendingSyncCount(): number {
    return this.dirtyCollections.size;
  }

  public async resyncPending(): Promise<{ synced: CollectionKey[]; failed: CollectionKey[] }> {
    const synced: CollectionKey[] = [];
    const failed: CollectionKey[] = [];
    for (const key of Array.from(this.dirtyCollections)) {
      try {
        await this.syncCollectionRemote(key, this.localBackup.getCollection(key));
        synced.push(key);
      } catch {
        failed.push(key);
      }
    }
    return { synced, failed };
  }

  public async syncCollectionRemote<T>(key: CollectionKey, items: T[]): Promise<void> {
    assertNoSecretsInRecords(items);
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await this.fetchImpl(
          `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections`,
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              collection_key: key,
              payload: items,
              updated_at: new Date().toISOString(),
            }),
          }
        );
        if (resp.ok) {
          this.dirtyCollections.delete(key);
          this.lastSyncError = null;
          return;
        }
        const txt = await resp.text().catch(() => "");
        lastErr = new Error(`Supabase sync HTTP ${resp.status}: ${txt.slice(0, 160)}`);
        if (resp.status < 500) break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    this.dirtyCollections.add(key);
    this.lastSyncError = lastErr?.message || "Unknown Supabase sync failure";
    throw lastErr || new Error("Supabase sync failed");
  }

  public async hydrateFromRemote(): Promise<boolean> {
    try {
      const resp = await this.fetchImpl(
        `${this.supabaseUrl}/rest/v1/snowmoon_kv_collections?select=collection_key,payload`,
        { method: "GET", headers: this.headers() }
      );
      if (!resp.ok) return false;
      const rows = (await resp.json()) as Array<{
        collection_key: CollectionKey;
        payload: unknown[];
      }>;
      for (const row of rows) {
        if (row.collection_key && Array.isArray(row.payload)) {
          this.localBackup.saveCollection(row.collection_key, row.payload);
        }
      }
      return true;
    } catch {
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
        const latestVersion = rlsHardened
          ? "002_rls_hardening"
          : applied001
          ? "001_initial_schema"
          : rows[rows.length - 1]?.id ?? null;
        return {
          backend: "supabase",
          productionReady: applied001,
          connected: true,
          migrationsApplied: applied001,
          rlsHardened,
          migrationVersion: latestVersion,
          pendingSyncCount: this.dirtyCollections.size,
          migrationFile: "migrations/001_initial_schema.sql",
          details: applied001
            ? rlsHardened
              ? "Connected to Supabase PostgreSQL with 001_initial_schema and 002_rls_hardening applied."
              : "Connected to Supabase PostgreSQL with 001_initial_schema applied (002_rls_hardening pending)."
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
          fetchImpl
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
