import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SnowMoonConfig } from "./config.ts";
import { assertValidNearAccountId, normalizeHex32Lowercase } from "./near_rpc.ts";

export interface PrivateObjectStorage {
  readonly kind: "local" | "supabase_private_bucket";
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

export function sanitizeStorageObjectKey(key: string): string {
  const cleaned = String(key || "").trim().replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(cleaned)) {
    throw new Error(`ERR_INVALID_STORAGE_KEY: Unsafe object key "${key}".`);
  }
  return cleaned;
}

export class LocalPrivateObjectStorage implements PrivateObjectStorage {
  public readonly kind = "local" as const;
  private readonly storageDir: string;

  constructor(storageDir: string, isProductionMode = false) {
    if (isProductionMode) {
      throw new Error(
        "ERR_LOCAL_STORAGE_FORBIDDEN_IN_PRODUCTION: Local disk deliverable storage is disabled in production; configure shared private object storage."
      );
    }
    this.storageDir = path.resolve(storageDir);
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  public async putObject(key: string, data: Buffer): Promise<void> {
    const safeKey = sanitizeStorageObjectKey(key);
    const fullPath = path.resolve(this.storageDir, safeKey);
    if (!fullPath.startsWith(this.storageDir + path.sep)) {
      throw new Error("ERR_PATH_TRAVERSAL_BLOCKED");
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
  }

  public async getObject(key: string): Promise<Buffer> {
    const safeKey = sanitizeStorageObjectKey(key);
    const fullPath = path.resolve(this.storageDir, safeKey);
    if (!fullPath.startsWith(this.storageDir + path.sep)) {
      throw new Error("ERR_PATH_TRAVERSAL_BLOCKED");
    }
    return fs.readFileSync(fullPath);
  }

  public async deleteObject(key: string): Promise<void> {
    const safeKey = sanitizeStorageObjectKey(key);
    const fullPath = path.resolve(this.storageDir, safeKey);
    if (!fullPath.startsWith(this.storageDir + path.sep)) {
      throw new Error("ERR_PATH_TRAVERSAL_BLOCKED");
    }
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
}

export class SupabasePrivateObjectStorage implements PrivateObjectStorage {
  public readonly kind = "supabase_private_bucket" as const;
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;

  constructor(params: {
    supabaseUrl: string;
    serviceRoleKey: string;
    bucket?: string;
    fetchImpl?: typeof fetch;
  }) {
    if (!params.supabaseUrl?.trim() || !params.serviceRoleKey?.trim()) {
      throw new Error(
        "ERR_SHARED_DELIVERABLE_STORAGE_REQUIRED: SUPABASE_URL and SUPABASE_SECRET_KEY are required for shared private deliverable storage."
      );
    }
    this.baseUrl = params.supabaseUrl.replace(/\/+$/, "");
    this.serviceKey = params.serviceRoleKey.trim();
    this.bucket = (params.bucket || "snowmoon-deliverables-private").trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(this.bucket)) {
      throw new Error(`ERR_INVALID_BUCKET_NAME: ${this.bucket}`);
    }
    this.fetchImpl = params.fetchImpl ?? fetch;
  }

  public async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const safeKey = sanitizeStorageObjectKey(key);
    const resp = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${safeKey}`,
      {
        method: "POST",
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: new Uint8Array(data),
      }
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ERR_OBJECT_STORAGE_PUT_FAILED: HTTP ${resp.status} ${txt.slice(0, 160)}`);
    }
  }

  public async getObject(key: string): Promise<Buffer> {
    const safeKey = sanitizeStorageObjectKey(key);
    const resp = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(this.bucket)}/${safeKey}`,
      {
        method: "GET",
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
        },
      }
    );
    if (!resp.ok) {
      throw new Error(`ERR_OBJECT_STORAGE_GET_FAILED: HTTP ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  public async deleteObject(key: string): Promise<void> {
    const safeKey = sanitizeStorageObjectKey(key);
    const resp = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${safeKey}`,
      {
        method: "DELETE",
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
        },
      }
    );
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`ERR_OBJECT_STORAGE_DELETE_FAILED: HTTP ${resp.status}`);
    }
  }
}

export type DeliverableStatus =
  | "PENDING_CUSTOMER_REVIEW"
  | "ACCEPTED_AND_UNLOCKED"
  | "REJECTED_LOCKED";

export interface DeliverableRecord {
  deliverableId: string; // Random unguessable ID (never predictable from jobId)
  jobId: string;
  customerAccountId: string;
  version: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  auditAnchorTxHash?: string;
  status: DeliverableStatus;
  previewText: string;
  previewSummary: string;
  privateStoragePath: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

const ALLOWED_MIME_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "application/pdf",
  "text/x-rust",
  "text/typescript",
  "application/octet-stream",
]);

const MAX_DELIVERABLE_BYTES = 10 * 1024 * 1024; // 10 MB

export function generateRestrictedPreview(
  content: Buffer,
  mimeType: string,
  filename: string
): { previewSummary: string; previewText: string } {
  const safeName = path.basename(filename);
  const watermark = `\n\n--- [SNOWMOON RESTRICTED PREVIEW] Accept & settle on-chain to unlock full ${safeName} (${content.length} bytes) ---`;

  if (mimeType === "application/json") {
    const raw = content.toString("utf8");
    const excerpt = raw.slice(0, 240);
    return {
      previewSummary: `JSON deliverable (${content.length} bytes) — truncated schema/excerpt preview`,
      previewText: `${excerpt}${raw.length > 240 ? "\n... [truncated]" : ""}${watermark}`,
    };
  }

  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/csv"
  ) {
    const rawText = content.toString("utf8");
    // Strip internal execution-log blockquotes and any raw XML tool-call tags so preview shows actual AI deliverable content
    const cleanedLines = rawText
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !(
          t.startsWith("> **Execution Mode:**") ||
          t.startsWith("> **Endpoint:**") ||
          t.startsWith("> **Model:**") ||
          t.startsWith("> **Routing:**") ||
          t.startsWith("> **Agentic Tools Executed") ||
          t.startsWith("> **Token Usage:**") ||
          t.startsWith("> **Prompt Cache:**")
        );
      });
    // Trim leading blank lines after stripping metadata header
    while (cleanedLines.length > 0 && !cleanedLines[0].trim()) cleanedLines.shift();
    const lines = cleanedLines.length > 0 ? cleanedLines : rawText.split(/\r?\n/);
    const cleanFull = lines.join("\n");

    // Smart Security-Audit Preview: surface Executive Summary + Top Findings teasers (never code/fixes!)
    const isAuditReport =
      /##\s+Top Findings Summary/i.test(cleanFull) ||
      /###\s+\d+\.\s+/i.test(cleanFull) ||
      /Security Audit Report/i.test(cleanFull);
    if (isAuditReport && mimeType !== "text/x-rust" && mimeType !== "text/typescript") {
      // Strip fenced code blocks so vulnerable snippets & concrete fixes are never leaked before settlement
      const noCodeText = cleanFull.replace(/```[\s\S]*?```/g, "").trim();
      const execMatch = noCodeText.match(/##\s+Executive Summary\s*\n+([\s\S]*?)(?=\n##\s+|$)/i);
      const topSummaryMatch = noCodeText.match(/##\s+Top Findings Summary\s*\n+([\s\S]*?)(?=\n##\s+|$)/i);
      const headingMatches = [...noCodeText.matchAll(/^###\s+(.+)$/gm)].map((m) => `- ${m[1].trim()}`);

      const titleLine = lines.find((l) => l.trim().startsWith("# ")) || "# Security Audit Report";
      const previewParts: string[] = [titleLine];
      if (execMatch?.[1]?.trim()) {
        previewParts.push(`\n## Executive Summary\n${execMatch[1].trim().slice(0, 420)}`);
      }
      if (topSummaryMatch?.[1]?.trim()) {
        const bullets = topSummaryMatch[1]
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith("-"))
          .slice(0, 4);
        if (bullets.length > 0) {
          previewParts.push(`\n## Key Risks Detected (Preview)\n${bullets.join("\n")}`);
        }
      } else if (headingMatches.length > 0) {
        previewParts.push(`\n## Key Risks Detected (Preview)\n${headingMatches.slice(0, 4).join("\n")}`);
      }
      const rpcMatch = noCodeText.match(/##\s+Live NEAR Mainnet RPC Verification\s*\n+([\s\S]*?)(?=\n##\s+|$)/i);
      if (rpcMatch?.[1]?.trim() && !/not performed/i.test(rpcMatch[1])) {
        previewParts.push(`\n## Live NEAR Mainnet RPC Verification\n${rpcMatch[1].trim().slice(0, 260)}`);
      }
      const teaserText = previewParts.join("\n").trim();
      if (teaserText.length > 80) {
        const findingCount = headingMatches.length || (topSummaryMatch?.[1]?.split(/\r?\n/).filter((l) => l.trim().startsWith("-")).length ?? 0);
        const lockNote = findingCount > 0
          ? `\n\n... [${findingCount} findings with vulnerable code & concrete fixes locked until on-chain settlement]`
          : `\n\n... [Full detailed report & remediation locked until on-chain settlement]`;
        return {
          previewSummary: `${safeName} (${lines.length} lines, ${content.length} bytes) — ${findingCount || "audit"} findings preview`,
          previewText: `${teaserText}${lockNote}${watermark}`,
        };
      }
    }

    const baseMaxLines = mimeType === "text/x-rust" || mimeType === "text/typescript" ? 16 : 14;
    const maxLines = Math.min(baseMaxLines, Math.max(4, Math.floor(lines.length * 0.55)));
    const excerpt = lines.slice(0, maxLines).join("\n").slice(0, 950).trim();
    return {
      previewSummary: `${safeName} (${lines.length} lines, ${content.length} bytes) — deliverable preview`,
      previewText: `${excerpt || "Deliverable generated and vaulted."}${lines.length > maxLines ? "\n\n... [Full detailed report & remediation locked until on-chain settlement]" : ""}${watermark}`,
    };
  }

  // Binary / PDF / Image fallback: never leak full binary bytes in preview
  const shaPrefix = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return {
    previewSummary: `Binary deliverable ${safeName} (${mimeType}, ${content.length} bytes, sha256:${shaPrefix}...)`,
    previewText: `Restricted binary preview for ${safeName}. Full file is locked in private storage until customer acceptance and confirmed on-chain settlement.${watermark}`,
  };
}

export class DeliverableVault {
  private readonly storageDir: string | null;
  private readonly objectStorage: PrivateObjectStorage;
  private readonly signingSecret: string;
  private readonly byJob = new Map<string, DeliverableRecord>();
  private readonly consumedTokens = new Set<string>();

  constructor(storageOrDir: string | PrivateObjectStorage, signingSecret: string) {
    if (!signingSecret || signingSecret.length < 8) {
      throw new Error("ERR_DELIVERABLE_SECRET_REQUIRED: signingSecret (>= 8 chars) is required.");
    }
    this.signingSecret = signingSecret;
    if (typeof storageOrDir === "string") {
      this.storageDir = path.resolve(storageOrDir);
      this.objectStorage = new LocalPrivateObjectStorage(this.storageDir, false);
    } else {
      this.storageDir = null;
      this.objectStorage = storageOrDir;
    }
  }

  public static fromConfig(
    config: SnowMoonConfig,
    signingSecret: string,
    fetchImpl?: typeof fetch
  ): DeliverableVault {
    const supabaseUrl = (config.supabaseUrl || "").trim();
    const supabaseKey = (config.secrets.supabaseSecretKey || "").trim();
    if (config.isProductionMode) {
      if (!supabaseUrl || !supabaseKey) {
        throw new Error(
          "ERR_SHARED_DELIVERABLE_STORAGE_REQUIRED: Production requires shared private object storage (SUPABASE_URL + SUPABASE_SECRET_KEY)."
        );
      }
      return new DeliverableVault(
        new SupabasePrivateObjectStorage({
          supabaseUrl,
          serviceRoleKey: supabaseKey,
          bucket: process.env.SNOWMOON_DELIVERABLES_BUCKET || "snowmoon-deliverables-private",
          fetchImpl,
        }),
        signingSecret
      );
    }
    if (supabaseUrl && supabaseKey && process.env.SNOWMOON_DELIVERABLES_BUCKET) {
      return new DeliverableVault(
        new SupabasePrivateObjectStorage({
          supabaseUrl,
          serviceRoleKey: supabaseKey,
          bucket: process.env.SNOWMOON_DELIVERABLES_BUCKET,
          fetchImpl,
        }),
        signingSecret
      );
    }
    return new DeliverableVault(
      path.join(path.dirname(config.stateFile), "private-deliverables"),
      signingSecret
    );
  }

  public get storageBackendKind(): PrivateObjectStorage["kind"] {
    return this.objectStorage.kind;
  }

  public async storeDeliverableAsync(params: {
    jobId: string;
    customerAccountId: string;
    filename: string;
    mimeType: string;
    content: Buffer;
    auditAnchorTxHash?: string;
  }): Promise<DeliverableRecord> {
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
      throw new Error(`ERR_UNSUPPORTED_MIME_TYPE: ${params.mimeType} is not permitted.`);
    }
    if (!Buffer.isBuffer(params.content) || params.content.length === 0) {
      throw new Error("ERR_EMPTY_DELIVERABLE: Deliverable content cannot be empty.");
    }
    if (params.content.length > MAX_DELIVERABLE_BYTES) {
      throw new Error(`ERR_DELIVERABLE_TOO_LARGE: Exceeds ${MAX_DELIVERABLE_BYTES} bytes.`);
    }

    const prev = this.byJob.get(jobId);
    const version = (prev?.version ?? 0) + 1;
    const deliverableId = `deliv_${crypto.randomBytes(16).toString("hex")}`;
    const objectKey = `${jobId}/${deliverableId}_v${version}.bin`;
    const contentHash = `0x${crypto.createHash("sha256").update(params.content).digest("hex")}`;
    await this.objectStorage.putObject(objectKey, params.content, params.mimeType);

    const { previewSummary, previewText } = generateRestrictedPreview(
      params.content,
      params.mimeType,
      params.filename
    );

    const now = new Date().toISOString();
    const record: DeliverableRecord = {
      deliverableId,
      jobId,
      customerAccountId: customer,
      version,
      filename: path.basename(params.filename),
      mimeType: params.mimeType,
      sizeBytes: params.content.length,
      contentHash,
      auditAnchorTxHash: params.auditAnchorTxHash,
      status: "PENDING_CUSTOMER_REVIEW",
      previewSummary,
      previewText,
      privateStoragePath: objectKey,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    this.byJob.set(jobId, record);
    return record;
  }

  public async verifyAndReadFullDeliverableAsync(params: {
    token: string;
    callerCustomerAccountId: string;
    jobState: string;
    settlementConfirmed: boolean;
    nowMs?: number;
    singleUse?: boolean;
  }): Promise<{ record: DeliverableRecord; content: Buffer }> {
    const parts = String(params.token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("ERR_INVALID_DOWNLOAD_TOKEN: Malformed token.");
    }
    const [payloadB64, sigB64] = parts;
    const expectedSig = crypto
      .createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("base64url");
    const a = Buffer.from(sigB64, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("ERR_INVALID_DOWNLOAD_TOKEN: Signature verification failed.");
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
      deliverableId: string;
      jobId: string;
      customerAccountId: string;
      version: number;
      contentHash: string;
      expMs: number;
      jti?: string;
    };
    if (params.singleUse && payload.jti && this.consumedTokens.has(payload.jti)) {
      throw new Error("ERR_DOWNLOAD_TOKEN_REPLAYED: Single-use download token already consumed.");
    }
    const nowMs = params.nowMs ?? Date.now();
    if (nowMs > payload.expMs) {
      throw new Error("ERR_DOWNLOAD_TOKEN_EXPIRED: Signed download URL has expired.");
    }
    if (payload.customerAccountId !== params.callerCustomerAccountId) {
      throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Token does not belong to caller.");
    }
    const rec = this.byJob.get(payload.jobId);
    if (!rec || rec.deliverableId !== payload.deliverableId || rec.version !== payload.version) {
      throw new Error("ERR_DELIVERABLE_VERSION_MISMATCH: Deliverable no longer matches token.");
    }
    if (
      rec.status !== "ACCEPTED_AND_UNLOCKED" ||
      params.jobState !== "SETTLED" ||
      !params.settlementConfirmed
    ) {
      throw new Error("ERR_DOWNLOAD_LOCKED: Deliverable is locked until confirmed settlement.");
    }
    const bytes = await this.objectStorage.getObject(rec.privateStoragePath);
    const actualHash = `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (actualHash !== rec.contentHash) {
      throw new Error("ERR_DELIVERABLE_HASH_MISMATCH: Stored file integrity check failed.");
    }
    if (params.singleUse && payload.jti) {
      this.consumedTokens.add(payload.jti);
    }
    return { record: rec, content: bytes };
  }

  public async cleanupRejectedOrExpired(retentionMs: number, nowMs = Date.now()): Promise<number> {
    let deleted = 0;
    for (const [jobId, rec] of this.byJob.entries()) {
      if (rec.status === "REJECTED_LOCKED" && nowMs - Date.parse(rec.updatedAt) >= retentionMs) {
        await this.objectStorage.deleteObject(rec.privateStoragePath);
        this.byJob.delete(jobId);
        deleted += 1;
      }
    }
    return deleted;
  }

  public storeDeliverable(params: {
    jobId: string;
    customerAccountId: string;
    filename: string;
    mimeType: string;
    content: Buffer;
    auditAnchorTxHash?: string;
  }): DeliverableRecord {
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
      throw new Error(`ERR_UNSUPPORTED_MIME_TYPE: ${params.mimeType} is not permitted.`);
    }
    if (!Buffer.isBuffer(params.content) || params.content.length === 0) {
      throw new Error("ERR_EMPTY_DELIVERABLE: Deliverable content cannot be empty.");
    }
    if (params.content.length > MAX_DELIVERABLE_BYTES) {
      throw new Error(`ERR_DELIVERABLE_TOO_LARGE: Exceeds ${MAX_DELIVERABLE_BYTES} bytes.`);
    }
    if (!this.storageDir) {
      throw new Error("ERR_USE_ASYNC_OBJECT_STORAGE: Use storeDeliverableAsync for remote object storage.");
    }

    const prev = this.byJob.get(jobId);
    const version = (prev?.version ?? 0) + 1;
    const deliverableId = `deliv_${crypto.randomBytes(16).toString("hex")}`;
    const contentHash = `0x${crypto.createHash("sha256").update(params.content).digest("hex")}`;
    const privatePath = path.join(this.storageDir, `${deliverableId}.bin`);
    fs.writeFileSync(privatePath, params.content);

    const { previewSummary, previewText } = generateRestrictedPreview(
      params.content,
      params.mimeType,
      params.filename
    );

    const now = new Date().toISOString();
    const record: DeliverableRecord = {
      deliverableId,
      jobId,
      customerAccountId: customer,
      version,
      filename: path.basename(params.filename),
      mimeType: params.mimeType,
      sizeBytes: params.content.length,
      contentHash,
      auditAnchorTxHash: params.auditAnchorTxHash,
      status: "PENDING_CUSTOMER_REVIEW",
      previewSummary,
      previewText,
      privateStoragePath: privatePath,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    this.byJob.set(jobId, record);
    return record;
  }

  public getDeliverableByJob(jobId: string): DeliverableRecord | undefined {
    return this.byJob.get(normalizeHex32Lowercase(jobId, "jobId"));
  }

  public getCustomerPreview(jobId: string, callerCustomerAccountId: string): {
    deliverableId: string;
    jobId: string;
    version: number;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    auditAnchorTxHash?: string;
    status: DeliverableStatus;
    previewSummary: string;
    previewText: string;
    fullDownloadUnlocked: boolean;
  } {
    const normalizedJobId = normalizeHex32Lowercase(jobId, "jobId");
    const rec = this.byJob.get(normalizedJobId);
    if (!rec) throw new Error(`ERR_DELIVERABLE_NOT_FOUND: No deliverable for ${normalizedJobId}.`);
    if (rec.customerAccountId !== callerCustomerAccountId) {
      throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Only the job customer may view preview.");
    }
    return {
      deliverableId: rec.deliverableId,
      jobId: rec.jobId,
      version: rec.version,
      filename: rec.filename,
      mimeType: rec.mimeType,
      sizeBytes: rec.sizeBytes,
      contentHash: rec.contentHash,
      auditAnchorTxHash: rec.auditAnchorTxHash,
      status: rec.status,
      previewSummary: rec.previewSummary,
      previewText: rec.previewText,
      fullDownloadUnlocked: rec.status === "ACCEPTED_AND_UNLOCKED",
    };
  }

  public markRejected(jobId: string, callerCustomerAccountId: string, reason: string): DeliverableRecord {
    const normalizedJobId = normalizeHex32Lowercase(jobId, "jobId");
    const rec = this.byJob.get(normalizedJobId);
    if (!rec) throw new Error(`ERR_DELIVERABLE_NOT_FOUND: No deliverable for ${normalizedJobId}.`);
    if (rec.customerAccountId !== callerCustomerAccountId) {
      throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Only the job customer may reject.");
    }
    if (rec.status === "ACCEPTED_AND_UNLOCKED") {
      throw new Error("ERR_ALREADY_ACCEPTED_AND_SETTLED: Cannot reject after settled acceptance.");
    }
    rec.status = "REJECTED_LOCKED";
    rec.rejectionReason = reason;
    rec.updatedAt = new Date().toISOString();
    return rec;
  }

  public unlockAfterConfirmedSettlement(params: {
    jobId: string;
    customerAccountId: string;
    jobState: string;
    settlementConfirmed: boolean;
    settlementKind: string;
  }): DeliverableRecord {
    const jobId = normalizeHex32Lowercase(params.jobId, "jobId");
    const rec = this.byJob.get(jobId);
    if (!rec) throw new Error(`ERR_DELIVERABLE_NOT_FOUND: No deliverable for ${jobId}.`);
    if (rec.customerAccountId !== params.customerAccountId) {
      throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED");
    }
    if (
      params.jobState !== "SETTLED" ||
      !params.settlementConfirmed ||
      params.settlementKind !== "PAYOUT_ACCEPT_DELIVERY"
    ) {
      throw new Error(
        "ERR_SETTLEMENT_REQUIRED_FOR_UNLOCK: Full deliverable remains locked until on-chain settlement is confirmed."
      );
    }
    rec.status = "ACCEPTED_AND_UNLOCKED";
    rec.updatedAt = new Date().toISOString();
    return rec;
  }

  public issueSignedDownloadToken(params: {
    jobId: string;
    customerAccountId: string;
    jobState: string;
    settlementConfirmed: boolean;
    settlementKind: string;
    ttlSeconds?: number;
    nowMs?: number;
  }): { token: string; expiresAtMs: number; deliverableId: string; version: number; contentHash: string } {
    const rec = this.unlockAfterConfirmedSettlement(params);
    const nowMs = params.nowMs ?? Date.now();
    const ttlMs = Math.min(300, Math.max(15, params.ttlSeconds ?? 120)) * 1000;
    const expiresAtMs = nowMs + ttlMs;
    const payloadObj = {
      deliverableId: rec.deliverableId,
      jobId: rec.jobId,
      customerAccountId: rec.customerAccountId,
      version: rec.version,
      contentHash: rec.contentHash,
      expMs: expiresAtMs,
      jti: crypto.randomBytes(12).toString("hex"),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
    const sig = crypto
      .createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("base64url");
    return {
      token: `${payloadB64}.${sig}`,
      expiresAtMs,
      deliverableId: rec.deliverableId,
      version: rec.version,
      contentHash: rec.contentHash,
    };
  }

  public verifyAndReadFullDeliverable(params: {
    token: string;
    callerCustomerAccountId: string;
    jobState: string;
    settlementConfirmed: boolean;
    nowMs?: number;
  }): { record: DeliverableRecord; content: Buffer } {
    const parts = String(params.token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("ERR_INVALID_DOWNLOAD_TOKEN: Malformed token.");
    }
    const [payloadB64, sigB64] = parts;
    const expectedSig = crypto
      .createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("base64url");
    const a = Buffer.from(sigB64, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("ERR_INVALID_DOWNLOAD_TOKEN: Signature verification failed.");
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
      deliverableId: string;
      jobId: string;
      customerAccountId: string;
      version: number;
      contentHash: string;
      expMs: number;
    };

    const nowMs = params.nowMs ?? Date.now();
    if (nowMs > payload.expMs) {
      throw new Error("ERR_DOWNLOAD_TOKEN_EXPIRED: Signed download URL has expired.");
    }
    if (payload.customerAccountId !== params.callerCustomerAccountId) {
      throw new Error("ERR_CUSTOMER_OWNERSHIP_REQUIRED: Token does not belong to caller.");
    }
    const rec = this.byJob.get(payload.jobId);
    if (!rec || rec.deliverableId !== payload.deliverableId || rec.version !== payload.version) {
      throw new Error("ERR_DELIVERABLE_VERSION_MISMATCH: Deliverable no longer matches token.");
    }
    if (
      rec.status !== "ACCEPTED_AND_UNLOCKED" ||
      params.jobState !== "SETTLED" ||
      !params.settlementConfirmed
    ) {
      throw new Error("ERR_DOWNLOAD_LOCKED: Deliverable is locked until confirmed settlement.");
    }
    const bytes = fs.readFileSync(rec.privateStoragePath);
    const actualHash = `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (actualHash !== rec.contentHash) {
      throw new Error("ERR_DELIVERABLE_HASH_MISMATCH: Stored file integrity check failed.");
    }
    return { record: rec, content: bytes };
  }
}
