import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SnowMoonConfig } from "./config.ts";
import {
  ANCHOR_FINAL_STAKE,
  ANCHOR_STORAGE_DEPOSIT,
  JOB_STORAGE_DEPOSIT_INITIAL,
  LP_SHARE_STAKE,
  STORAGE_REGISTRATION,
} from "./engine.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAINNET_USDC_CONTRACT_ID =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_STORAGE_BYTE_COST_YOCTO = 10_000_000_000_000_000_000n; // 1e19 yoctoNEAR per byte (0.00001 NEAR/byte)
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export interface WasmArtifactManifestEntry {
  contractName: "snapfall_core" | "snapfall_audit";
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  sha256Hex: string;
  storageStakeRequiredYocto: string;
  storageStakeRequiredNear: string;
  recommendedAccountFundingNear: string;
  initMethod: string;
  initArgsTemplate: Record<string, unknown>;
}

export interface NearMainnetAccountState {
  accountId: string;
  exists: boolean;
  amountYocto: string;
  amountNear: string;
  lockedYocto: string;
  storageUsageBytes: number;
  codeHash: string;
  hasContractDeployed: boolean;
  usdcBalanceAtomic: string;
  usdcBalanceFormatted: string;
  usdcStorageRegistered: boolean;
  usdcStorageBalance: { total: string; available: string } | null;
  error?: string;
}

export interface Nep141TokenMetadata {
  spec: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface CoreAccountingRpcView {
  escrowed_usdc: string;
  total_assets: string;
  total_outstanding: string;
  total_written_off: string;
  reserve: string;
  total_shares: string;
  share_epoch: number;
  total_claimable_usdc: string;
  total_in_flight_usdc: string;
  flagged_stuck_count: number;
  total_storage_credits: string;
  total_storage_locked: string;
  total_inflight_storage_near: string;
  total_inflight_registration: string;
  total_storage_registration: string;
  next_job_seq: number;
  vault_paused: boolean;
  pool_paused: boolean;
}

export interface ContractReadProbeResult {
  contractId: string;
  accountExists: boolean;
  hasContractCode: boolean;
  codeHash: string;
  deploymentStatus: "DEPLOYED_AND_INITIALIZED" | "DEPLOYED_UNINITIALIZED" | "ACCOUNT_EXISTS_NO_CONTRACT" | "NOT_DEPLOYED_ACCOUNT_MISSING";
  admin?: string | null;
  coreContract?: string | null;
  operatorAuthority?: string | null;
  jobStorageDepositYocto?: string | null;
  viewQueryResult?: unknown;
  error?: string;
}

export interface AuditContractStateSnapshot {
  contractId: string;
  exists: boolean;
  hasContractCode: boolean;
  codeHash: string;
  amountNear: string;
  storageUsageBytes: number;
  initialized: boolean;
  coreContract: string | null;
  operatorAuthority: string | null;
  admin: string | null;
  pendingAdmin: string | null;
  adminTransferAcceptableAt: number;
  nextAuditOpId: number | null;
  totalAnchorStorageLockedYocto: string | null;
  coreAuthorizedMatch: boolean;
  operatorMatchesConfig: boolean;
  adminMatchesConfig: boolean;
  error?: string;
}

export interface CoreContractLimitsSnapshot {
  contractId: string;
  usdcToken: string | null;
  admin: string | null;
  maxJobPaymentAtomic: string | null;
  maxJobPaymentUsdc: number | null;
  maxTotalExposureAtomic: string | null;
  maxTotalExposureUsdc: number | null;
  maxAdvanceAtomic: string | null;
  maxAdvanceUsdc: number | null;
  vaultPaused: boolean | null;
  poolPaused: boolean | null;
  depositAllowlistEnabled: boolean | null;
  error?: string;
}

export interface PreparedNearAction {
  type: "FunctionCall";
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  depositYocto: string;
}

export interface PreparedNearTransaction {
  stepNumber: number;
  description: string;
  signerId: string;
  receiverId: string;
  actions: PreparedNearAction[];
  callbackFlowSummary?: string;
}

export interface NearMainnetStatusSnapshot {
  checkedAt: string;
  rpcUrl: string;
  rpcReachable: boolean;
  chainId: string | null;
  latestBlockHeight: number | null;
  latestBlockTime: string | null;
  protocolVersion: number | null;
  liveTxBroadcastingEnabled: false;
  broadcastGuardReason: string;
  wasmArtifacts: {
    core: WasmArtifactManifestEntry;
    audit: WasmArtifactManifestEntry;
  };
  usdcMainnet: {
    contractId: string;
    metadata: Nep141TokenMetadata | null;
    storageBalanceBounds: { min: string; max: string } | null;
  };
  contracts: {
    core: ContractReadProbeResult;
    audit: ContractReadProbeResult;
  };
  accounts: Record<string, NearMainnetAccountState>;
  storageAndDeploymentRequirements: {
    byteCostYocto: string;
    coreWasmStorageNear: string;
    auditWasmStorageNear: string;
    usdcRegistrationDepositYocto: string;
    usdcRegistrationDepositNear: string;
    coreStorageRegistrationYocto: string;
    coreJobStorageDepositYocto: string;
    coreLpShareStakeYocto: string;
    auditAnchorDepositYocto: string;
    auditAnchorRetainedYocto: string;
    requiredUsdcRegistrations: string[];
  };
  error?: string;
}

function formatNearFromYocto(yoctoStr: string, decimals = 4): string {
  try {
    const val = BigInt(yoctoStr || "0");
    const whole = val / 10n ** 24n;
    const frac = val % 10n ** 24n;
    const fracStr = frac.toString().padStart(24, "0").slice(0, decimals);
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return "0.0000";
  }
}

function formatUsdcFromAtomic(atomicStr: string): string {
  try {
    const val = BigInt(atomicStr || "0");
    const whole = val / 1_000_000n;
    const frac = (val % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
    return `$${whole.toString()}.${frac} USDC`;
  } catch {
    return "$0.00 USDC";
  }
}

const NEAR_IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
const NEAR_NAMED_ACCOUNT_RE =
  /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const HEX32_LOWERCASE_RE = /^0x[0-9a-f]{64}$/;

export function assertValidNearAccountId(accountId: string, fieldName: string): string {
  const trimmed = accountId.trim();
  if (
    !NEAR_IMPLICIT_ACCOUNT_RE.test(trimmed) &&
    !NEAR_NAMED_ACCOUNT_RE.test(trimmed)
  ) {
    throw new Error(
      `ERR_INVALID_NEAR_ACCOUNT_ID (${fieldName}): "${trimmed}" is not a valid NEAR AccountId`
    );
  }
  return trimmed;
}

export function normalizeHex32Lowercase(hexStr: string, fieldName: string): string {
  const normalized = hexStr.trim().toLowerCase();
  if (!HEX32_LOWERCASE_RE.test(normalized)) {
    throw new Error(
      `ERR_INVALID_HEX32 (${fieldName}): expected "0x" + 64 lowercase hex characters, got "${hexStr}"`
    );
  }
  if (normalized === "0x" + "0".repeat(64)) {
    throw new Error(`ERR_ZERO_HEX32 (${fieldName}): hash cannot be all-zero`);
  }
  return normalized;
}

export function parseU128DecimalString(
  rawVal: string,
  fieldName: string,
  allowZero: boolean
): bigint {
  const s = rawVal.trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(
      `ERR_INVALID_U128 (${fieldName}): expected base-10 integer string, got "${rawVal}"`
    );
  }
  const n = BigInt(s);
  const maxU128 = (1n << 128n) - 1n;
  if (n > maxU128) {
    throw new Error(`ERR_U128_OVERFLOW (${fieldName}): exceeds u128::MAX`);
  }
  if (!allowZero && n <= 0n) {
    throw new Error(`ERR_ZERO_AMOUNT (${fieldName}): must be > 0`);
  }
  return n;
}

/**
 * Inspects the compiled production WASM artifacts (`near/artifacts/production/*.wasm`)
 * and computes exact byte lengths, SHA-256 hashes, and NEAR storage staking requirements.
 */
export function inspectProductionWasmArtifacts(config: SnowMoonConfig): {
  core: WasmArtifactManifestEntry;
  audit: WasmArtifactManifestEntry;
} {
  const prodDir = path.resolve(__dirname, "..", "..", "near", "artifacts", "production");
  const corePath = path.join(prodDir, "snapfall_core.wasm");
  const auditPath = path.join(prodDir, "snapfall_audit.wasm");

  const inspectOne = (
    contractName: "snapfall_core" | "snapfall_audit",
    filePath: string,
    recommendedNear: string,
    initArgsTemplate: Record<string, unknown>
  ): WasmArtifactManifestEntry => {
    if (!fs.existsSync(filePath)) {
      return {
        contractName,
        filePath,
        exists: false,
        sizeBytes: 0,
        sha256Hex: "",
        storageStakeRequiredYocto: "0",
        storageStakeRequiredNear: "0.0000",
        recommendedAccountFundingNear: recommendedNear,
        initMethod: "new",
        initArgsTemplate,
      };
    }
    const buf = fs.readFileSync(filePath);
    const sizeBytes = buf.length;
    const sha256Hex = crypto.createHash("sha256").update(buf).digest("hex");
    const stakeYocto = BigInt(sizeBytes) * NEAR_STORAGE_BYTE_COST_YOCTO;
    return {
      contractName,
      filePath,
      exists: true,
      sizeBytes,
      sha256Hex,
      storageStakeRequiredYocto: stakeYocto.toString(),
      storageStakeRequiredNear: formatNearFromYocto(stakeYocto.toString(), 5),
      recommendedAccountFundingNear: recommendedNear,
      initMethod: "new",
      initArgsTemplate,
    };
  };

  return {
    core: inspectOne(
      "snapfall_core",
      corePath,
      "8.00 NEAR",
      {
        usdc_token: config.mainnetUsdcContractId,
        admin: config.mainnetAdminAccountId,
      }
    ),
    audit: inspectOne(
      "snapfall_audit",
      auditPath,
      "4.00 NEAR",
      {
        core_contract: config.mainnetCoreContractId,
        operator_authority: config.mainnetAuditOperatorAccountId,
        admin: config.mainnetAdminAccountId,
      }
    ),
  };
}

/**
 * Strictly read-only NEAR Mainnet RPC client & transaction preparation engine.
 * NEVER signs or broadcasts any transaction (`liveTxBroadcastingEnabled = false`).
 */
export class NearMainnetRpcAdapter {
  private config: SnowMoonConfig;
  private fetchImpl: typeof fetch;
  private cachedStatus: NearMainnetStatusSnapshot | null = null;

  constructor(config: SnowMoonConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  public getRpcUrl(): string {
    return this.config.nearMainnetRpcUrl || "https://free.rpc.fastnear.com";
  }

  private async rpcCall<T = unknown>(
    method: string,
    params: unknown
  ): Promise<{ ok: boolean; result?: T; error?: unknown }> {
    const primaryUrl = this.getRpcUrl();
    const fallbackUrl = "https://free.rpc.fastnear.com";
    let lastError: unknown = "Unknown RPC error";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const targetUrl =
        attempt > 1 && primaryUrl !== fallbackUrl ? fallbackUrl : primaryUrl;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const resp = await this.fetchImpl(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "snowmoon-mainnet-read",
            method,
            params,
          }),
          signal: controller.signal,
        });
        if (resp.status === 429 || resp.status >= 500) {
          lastError = `HTTP ${resp.status} ${resp.statusText}`;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 300 * attempt));
            continue;
          }
          return { ok: false, error: lastError };
        }
        if (!resp.ok) {
          return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
        }
        const data = (await resp.json()) as {
          result?: T;
          error?: unknown;
        };
        if (data.error) {
          return { ok: false, error: data.error };
        }
        return { ok: true, result: data.result };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError };
  }

  /**
   * Read-only `call_function` query on NEAR Mainnet (`finality: "final"`).
   */
  public async callViewMethod<T = unknown>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown> = {}
  ): Promise<{
    ok: boolean;
    data?: T;
    blockHeight?: number;
    blockHash?: string;
    error?: string;
  }> {
    const argsBase64 = Buffer.from(JSON.stringify(args), "utf8").toString(
      "base64"
    );
    const res = await this.rpcCall<{
      result?: number[];
      logs?: string[];
      block_height?: number;
      block_hash?: string;
      error?: string;
    }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64,
    });

    if (!res.ok || !res.result) {
      return {
        ok: false,
        error: JSON.stringify(res.error ?? "RPC call_function failed"),
      };
    }
    if (res.result.error) {
      return { ok: false, error: res.result.error };
    }
    const rawBytes = Buffer.from(res.result.result ?? []);
    const decoded = rawBytes.toString("utf8");
    try {
      return {
        ok: true,
        data: JSON.parse(decoded) as T,
        blockHeight: res.result.block_height,
        blockHash: res.result.block_hash,
      };
    } catch {
      return {
        ok: true,
        data: decoded as unknown as T,
        blockHeight: res.result.block_height,
        blockHash: res.result.block_hash,
      };
    }
  }

  /**
   * Read-only `view_account` query on NEAR Mainnet (`finality: "final"`).
   */
  public async viewAccount(accountId: string): Promise<{
    exists: boolean;
    amountYocto: string;
    lockedYocto: string;
    storageUsageBytes: number;
    codeHash: string;
    error?: string;
  }> {
    const res = await this.rpcCall<{
      amount: string;
      locked: string;
      storage_usage: number;
      code_hash: string;
    }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });

    if (!res.ok || !res.result) {
      const errObj = res.error as { cause?: { name?: string }; message?: string };
      return {
        exists: false,
        amountYocto: "0",
        lockedYocto: "0",
        storageUsageBytes: 0,
        codeHash: EMPTY_CODE_HASH,
        error: errObj?.cause?.name || errObj?.message || "UNKNOWN_ACCOUNT",
      };
    }

    return {
      exists: true,
      amountYocto: res.result.amount,
      lockedYocto: res.result.locked,
      storageUsageBytes: res.result.storage_usage,
      codeHash: res.result.code_hash,
    };
  }

  /**
   * Read-only NEP-141 `ft_metadata`, `storage_balance_bounds`, `ft_balance_of`, and `storage_balance_of`
   * directly on Mainnet native USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`).
   */
  public async queryUsdcAccountState(accountId: string): Promise<{
    balanceAtomic: string;
    storageRegistered: boolean;
    storageBalance: { total: string; available: string } | null;
  }> {
    const usdcId = this.config.mainnetUsdcContractId;
    const [balRes, storRes] = await Promise.all([
      this.callViewMethod<string>(usdcId, "ft_balance_of", {
        account_id: accountId,
      }),
      this.callViewMethod<{ total: string; available: string } | null>(
        usdcId,
        "storage_balance_of",
        { account_id: accountId }
      ),
    ]);

    const balanceAtomic = balRes.ok && balRes.data ? String(balRes.data) : "0";
    const storageBalance = storRes.ok && storRes.data ? storRes.data : null;
    return {
      balanceAtomic,
      storageRegistered: storageBalance !== null,
      storageBalance,
    };
  }

  /**
   * Full read-only probe of a target Account ID on NEAR Mainnet (native balance + contract code + USDC balance/registration).
   */
  public async inspectMainnetAccount(
    accountId: string
  ): Promise<NearMainnetAccountState> {
    const [acct, usdc] = await Promise.all([
      this.viewAccount(accountId),
      this.queryUsdcAccountState(accountId),
    ]);

    return {
      accountId,
      exists: acct.exists,
      amountYocto: acct.amountYocto,
      amountNear: formatNearFromYocto(acct.amountYocto, 4),
      lockedYocto: acct.lockedYocto,
      storageUsageBytes: acct.storageUsageBytes,
      codeHash: acct.codeHash,
      hasContractDeployed:
        acct.exists && acct.codeHash !== EMPTY_CODE_HASH && acct.codeHash !== "",
      usdcBalanceAtomic: usdc.balanceAtomic,
      usdcBalanceFormatted: formatUsdcFromAtomic(usdc.balanceAtomic),
      usdcStorageRegistered: usdc.storageRegistered,
      usdcStorageBalance: usdc.storageBalance,
      error: acct.error,
    };
  }

  /**
   * Read-only contract queries for deployed SnowMoon Core (`snapfall-core`) and Audit (`snapfall-audit`) contracts:
   * - Core views: `accounting()`, `get_job({ job_id })`, `get_advance({ job_id })`, `storage_credit_of({ account_id })`,
   *   `storage_registration_of({ account_id })`, `job_storage_deposit()`, `claimable_of({ account_id })`,
   *   `verify_job_for_audit({ job_id })`, `admin()`
   * - Audit views: `get_anchor({ job_id })`
   */
  public async probeCoreContract(
    coreContractId = this.config.mainnetCoreContractId
  ): Promise<ContractReadProbeResult> {
    const acct = await this.viewAccount(coreContractId);
    if (!acct.exists) {
      return {
        contractId: coreContractId,
        accountExists: false,
        hasContractCode: false,
        codeHash: acct.codeHash,
        deploymentStatus: "NOT_DEPLOYED_ACCOUNT_MISSING",
        error: `Account ${coreContractId} does not exist on NEAR Mainnet yet.`,
      };
    }
    if (acct.codeHash === EMPTY_CODE_HASH) {
      return {
        contractId: coreContractId,
        accountExists: true,
        hasContractCode: false,
        codeHash: acct.codeHash,
        deploymentStatus: "ACCOUNT_EXISTS_NO_CONTRACT",
        error: `Account ${coreContractId} exists (${formatNearFromYocto(acct.amountYocto)} NEAR) but has no WASM code deployed.`,
      };
    }

    const [accountingRes, adminRes, jobDepositRes] = await Promise.all([
      this.callViewMethod<CoreAccountingRpcView>(coreContractId, "accounting", {}),
      this.callViewMethod<string>(coreContractId, "admin", {}),
      this.callViewMethod<string>(coreContractId, "job_storage_deposit", {}),
    ]);
    if (!accountingRes.ok) {
      return {
        contractId: coreContractId,
        accountExists: true,
        hasContractCode: true,
        codeHash: acct.codeHash,
        deploymentStatus: "DEPLOYED_UNINITIALIZED",
        error: accountingRes.error,
      };
    }

    return {
      contractId: coreContractId,
      accountExists: true,
      hasContractCode: true,
      codeHash: acct.codeHash,
      deploymentStatus: "DEPLOYED_AND_INITIALIZED",
      admin: adminRes.ok ? (adminRes.data ?? null) : null,
      jobStorageDepositYocto: jobDepositRes.ok ? (jobDepositRes.data ?? null) : null,
      viewQueryResult: accountingRes.data,
    };
  }

  public async probeAuditContract(
    auditContractId = this.config.mainnetAuditContractId
  ): Promise<ContractReadProbeResult> {
    const acct = await this.viewAccount(auditContractId);
    if (!acct.exists) {
      return {
        contractId: auditContractId,
        accountExists: false,
        hasContractCode: false,
        codeHash: acct.codeHash,
        deploymentStatus: "NOT_DEPLOYED_ACCOUNT_MISSING",
        error: `Account ${auditContractId} does not exist on NEAR Mainnet yet.`,
      };
    }
    if (acct.codeHash === EMPTY_CODE_HASH) {
      return {
        contractId: auditContractId,
        accountExists: true,
        hasContractCode: false,
        codeHash: acct.codeHash,
        deploymentStatus: "ACCOUNT_EXISTS_NO_CONTRACT",
        error: `Account ${auditContractId} exists (${formatNearFromYocto(acct.amountYocto)} NEAR) but has no WASM code deployed.`,
      };
    }

    const zeroHex = "0x" + "0".repeat(64);
    const [anchorRes, stateInfo] = await Promise.all([
      this.callViewMethod<unknown>(auditContractId, "get_anchor", { job_id: zeroHex }),
      this.inspectAuditContractState(auditContractId).catch(() => null),
    ]);
    if (!anchorRes.ok) {
      return {
        contractId: auditContractId,
        accountExists: true,
        hasContractCode: true,
        codeHash: acct.codeHash,
        deploymentStatus: "DEPLOYED_UNINITIALIZED",
        error: anchorRes.error,
      };
    }

    return {
      contractId: auditContractId,
      accountExists: true,
      hasContractCode: true,
      codeHash: acct.codeHash,
      deploymentStatus: "DEPLOYED_AND_INITIALIZED",
      admin: stateInfo?.admin ?? null,
      coreContract: stateInfo?.coreContract ?? null,
      operatorAuthority: stateInfo?.operatorAuthority ?? null,
      viewQueryResult: anchorRes.data,
    };
  }

  /**
   * Read-only inspection of AuditAnchor contract state (`STATE` Borsh entry) and account health.
   */
  public async inspectAuditContractState(
    auditContractId = this.config.mainnetAuditContractId
  ): Promise<AuditContractStateSnapshot> {
    const acct = await this.viewAccount(auditContractId);
    if (!acct.exists || acct.codeHash === EMPTY_CODE_HASH) {
      return {
        contractId: auditContractId,
        exists: acct.exists,
        hasContractCode: acct.exists && acct.codeHash !== EMPTY_CODE_HASH,
        codeHash: acct.codeHash,
        amountNear: formatNearFromYocto(acct.amountYocto),
        storageUsageBytes: acct.storageUsageBytes,
        initialized: false,
        coreContract: null,
        operatorAuthority: null,
        admin: null,
        pendingAdmin: null,
        adminTransferAcceptableAt: 0,
        nextAuditOpId: null,
        totalAnchorStorageLockedYocto: null,
        coreAuthorizedMatch: false,
        operatorMatchesConfig: false,
        adminMatchesConfig: false,
        error: acct.error || "AuditAnchor contract not deployed",
      };
    }

    try {
      const stateRes = await this.rpcCall<{
        values?: Array<{ key: string; value: string }>;
      }>("query", {
        request_type: "view_state",
        finality: "final",
        account_id: auditContractId,
        prefix_base64: Buffer.from("STATE", "utf8").toString("base64"),
      });
      const entry = (stateRes.ok && stateRes.result?.values ? stateRes.result.values : []).find(
        (v: { key: string; value: string }) => Buffer.from(v.key, "base64").toString("utf8") === "STATE"
      );
      if (!entry) {
        return {
          contractId: auditContractId,
          exists: true,
          hasContractCode: true,
          codeHash: acct.codeHash,
          amountNear: formatNearFromYocto(acct.amountYocto),
          storageUsageBytes: acct.storageUsageBytes,
          initialized: false,
          coreContract: null,
          operatorAuthority: null,
          admin: null,
          pendingAdmin: null,
          adminTransferAcceptableAt: 0,
          nextAuditOpId: null,
          totalAnchorStorageLockedYocto: null,
          coreAuthorizedMatch: false,
          operatorMatchesConfig: false,
          adminMatchesConfig: false,
          error: "STATE key not found (contract uninitialized)",
        };
      }

      const buf = Buffer.from(entry.value, "base64");
      let off = 0;
      const readStr = () => {
        const len = buf.readUInt32LE(off);
        off += 4;
        const val = buf.subarray(off, off + len).toString("utf8");
        off += len;
        return val;
      };
      const skipBytes = () => {
        const len = buf.readUInt32LE(off);
        off += 4 + len;
      };
      const coreContract = readStr();
      const operatorAuthority = readStr();
      const admin = readStr();
      const hasPending = buf.readUInt8(off);
      off += 1;
      const pendingAdmin = hasPending ? readStr() : null;
      const adminTransferAcceptableAt = Number(buf.readBigUInt64LE(off));
      off += 8;
      // Skip 3 collection prefixes: anchors, pending_verifications, jobs_pending_anchor
      skipBytes();
      skipBytes();
      skipBytes();
      const nextAuditOpId = off + 8 <= buf.length ? Number(buf.readBigUInt64LE(off)) : null;
      off += 8;
      let totalAnchorStorageLockedYocto: string | null = null;
      if (off + 16 <= buf.length) {
        let val = 0n;
        for (let i = 15; i >= 0; i--) {
          val = (val << 8n) + BigInt(buf[off + i]);
        }
        totalAnchorStorageLockedYocto = val.toString();
      }

      return {
        contractId: auditContractId,
        exists: true,
        hasContractCode: true,
        codeHash: acct.codeHash,
        amountNear: formatNearFromYocto(acct.amountYocto),
        storageUsageBytes: acct.storageUsageBytes,
        initialized: true,
        coreContract,
        operatorAuthority,
        admin,
        pendingAdmin,
        adminTransferAcceptableAt,
        nextAuditOpId,
        totalAnchorStorageLockedYocto,
        coreAuthorizedMatch: coreContract === this.config.mainnetCoreContractId,
        operatorMatchesConfig: operatorAuthority === this.config.mainnetAuditOperatorAccountId,
        adminMatchesConfig: admin === this.config.mainnetAdminAccountId,
      };
    } catch (err) {
      return {
        contractId: auditContractId,
        exists: true,
        hasContractCode: true,
        codeHash: acct.codeHash,
        amountNear: formatNearFromYocto(acct.amountYocto),
        storageUsageBytes: acct.storageUsageBytes,
        initialized: false,
        coreContract: null,
        operatorAuthority: null,
        admin: null,
        pendingAdmin: null,
        adminTransferAcceptableAt: 0,
        nextAuditOpId: null,
        totalAnchorStorageLockedYocto: null,
        coreAuthorizedMatch: false,
        operatorMatchesConfig: false,
        adminMatchesConfig: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Read-only inspection of Core contract (`core.cryptozax.near`) `STATE` limits and pause flags.
   */
  public async inspectCoreContractLimits(
    coreContractId = this.config.mainnetCoreContractId
  ): Promise<CoreContractLimitsSnapshot> {
    try {
      const stateRes = await this.rpcCall<{
        values?: Array<{ key: string; value: string }>;
      }>("query", {
        request_type: "view_state",
        finality: "final",
        account_id: coreContractId,
        prefix_base64: Buffer.from("STATE", "utf8").toString("base64"),
      });
      const entry = (stateRes.ok && stateRes.result?.values ? stateRes.result.values : []).find(
        (v: { key: string; value: string }) => Buffer.from(v.key, "base64").toString("utf8") === "STATE"
      );
      if (!entry) {
        return {
          contractId: coreContractId,
          usdcToken: null,
          admin: null,
          maxJobPaymentAtomic: null,
          maxJobPaymentUsdc: null,
          maxTotalExposureAtomic: null,
          maxTotalExposureUsdc: null,
          maxAdvanceAtomic: null,
          maxAdvanceUsdc: null,
          vaultPaused: null,
          poolPaused: null,
          depositAllowlistEnabled: null,
          error: "Core STATE key not found",
        };
      }
      const buf = Buffer.from(entry.value, "base64");
      let off = 0;
      const readStr = () => {
        const len = buf.readUInt32LE(off);
        off += 4;
        const s = buf.subarray(off, off + len).toString("utf8");
        off += len;
        return s;
      };
      const skipBytes = () => {
        const len = buf.readUInt32LE(off);
        off += 4 + len;
      };
      const readU64 = () => {
        const v = buf.readBigUInt64LE(off);
        off += 8;
        return v;
      };
      const readU32 = () => {
        const v = buf.readUInt32LE(off);
        off += 4;
        return v;
      };
      const readU128 = () => {
        let v = 0n;
        for (let i = 15; i >= 0; i--) v = (v << 8n) + BigInt(buf[off + i]);
        off += 16;
        return v;
      };
      const readBool = () => {
        const v = buf.readUInt8(off) !== 0;
        off += 1;
        return v;
      };

      const usdcToken = readStr();
      skipBytes();
      skipBytes();
      skipBytes();
      readU64(); // next_near_op_id
      readU128(); // job_storage_deposit
      if (readBool()) readU128(); // pending_job_storage_deposit
      readU64(); // storage_deposit_lower_executable_at
      readU128(); // total_storage_credits
      readU128(); // total_storage_locked
      readU128(); // total_inflight_storage_near
      readU128(); // total_inflight_registration
      readU128(); // total_storage_registration

      skipBytes(); // jobs
      readU64(); // next_job_seq
      readU128(); // escrowed_usdc
      const maxJobPayment = readU128();
      const vaultPaused = readBool();

      skipBytes();
      skipBytes();
      skipBytes(); // advances, org_credit, shares_of
      readU64(); // share_epoch
      readU128(); // total_assets
      readU128(); // total_outstanding
      readU128(); // total_written_off
      readU128(); // reserve
      readU128(); // total_shares
      const maxTotalExposure = readU128();
      const maxAdvance = readU128();
      const poolPaused = readBool();

      skipBytes();
      skipBytes(); // pending_ops, claimable_usdc
      readU64(); // next_op_id
      readU128(); // total_in_flight_usdc
      readU128(); // total_claimable_usdc
      readU32(); // flagged_stuck_count

      const admin = readStr();
      if (readBool()) readStr(); // pending_admin
      readU64(); // admin_transfer_acceptable_at
      const depositAllowlistEnabled = readBool();

      return {
        contractId: coreContractId,
        usdcToken,
        admin,
        maxJobPaymentAtomic: maxJobPayment.toString(),
        maxJobPaymentUsdc: Number(maxJobPayment) / 1e6,
        maxTotalExposureAtomic: maxTotalExposure.toString(),
        maxTotalExposureUsdc: Number(maxTotalExposure) / 1e6,
        maxAdvanceAtomic: maxAdvance.toString(),
        maxAdvanceUsdc: Number(maxAdvance) / 1e6,
        vaultPaused,
        poolPaused,
        depositAllowlistEnabled,
      };
    } catch (err) {
      return {
        contractId: coreContractId,
        usdcToken: null,
        admin: null,
        maxJobPaymentAtomic: null,
        maxJobPaymentUsdc: null,
        maxTotalExposureAtomic: null,
        maxTotalExposureUsdc: null,
        maxAdvanceAtomic: null,
        maxAdvanceUsdc: null,
        vaultPaused: null,
        poolPaused: null,
        depositAllowlistEnabled: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Read-only queries for specific Core / Audit contract methods when a contract is deployed.
   */
  public async queryCoreJob(jobId: string, coreContractId = this.config.mainnetCoreContractId) {
    return this.callViewMethod(coreContractId, "get_job", { job_id: jobId });
  }

  public async queryCoreStorageCredit(
    accountId: string,
    coreContractId = this.config.mainnetCoreContractId
  ) {
    const [balance, registration] = await Promise.all([
      this.callViewMethod<string>(coreContractId, "storage_credit_of", {
        account_id: accountId,
      }),
      this.callViewMethod<string>(coreContractId, "storage_registration_of", {
        account_id: accountId,
      }),
    ]);
    return { balance, registration };
  }

  public async queryAuditAnchor(
    jobId: string,
    auditContractId = this.config.mainnetAuditContractId
  ) {
    return this.callViewMethod(auditContractId, "get_anchor", { job_id: jobId });
  }

  public async queryTransactionStatus(txHash: string, senderAccountId: string) {
    const sender = assertValidNearAccountId(senderAccountId, "senderAccountId");
    const hash = txHash.trim();
    if (!hash) {
      throw new Error("ERR_INVALID_TX_HASH: txHash is required");
    }
    return this.rpcCall<{
      final_execution_status?: string;
      status?: Record<string, unknown>;
      transaction?: {
        hash?: string;
        signer_id?: string;
        receiver_id?: string;
        actions?: Array<Record<string, unknown>>;
      };
      receipts_outcome?: Array<{ id?: string; outcome?: { logs?: string[]; status?: Record<string, unknown> } }>;
    }>("EXPERIMENTAL_tx_status", [hash, sender]);
  }

  /**
   * Synchronizes and caches the complete NEAR Mainnet RPC read-only snapshot.
   */
  public async syncMainnetStatus(extraAccountId?: string): Promise<NearMainnetStatusSnapshot> {
    const wasmArtifacts = inspectProductionWasmArtifacts(this.config);
    const statusRes = await this.rpcCall<{
      chain_id: string;
      protocol_version: number;
      sync_info: {
        latest_block_height: number;
        latest_block_time: string;
      };
    }>("status", []);

    const usdcId = this.config.mainnetUsdcContractId;
    const [ftMetaRes, boundsRes, coreProbe, auditProbe] = await Promise.all([
      this.callViewMethod<Nep141TokenMetadata>(usdcId, "ft_metadata", {}),
      this.callViewMethod<{ min: string; max: string }>(
        usdcId,
        "storage_balance_bounds",
        {}
      ),
      this.probeCoreContract(this.config.mainnetCoreContractId),
      this.probeAuditContract(this.config.mainnetAuditContractId),
    ]);

    const accountList = Array.from(
      new Set(
        [
          this.config.mainnetAdminAccountId,
          this.config.mainnetOperatorAccountId,
          this.config.mainnetCoreContractId,
          this.config.mainnetAuditContractId,
          extraAccountId,
        ].filter((x): x is string => Boolean(x && x.trim().length > 0))
      )
    );

    const accountStates = await Promise.all(
      accountList.map((acc) => this.inspectMainnetAccount(acc))
    );
    const accountsMap: Record<string, NearMainnetAccountState> = {};
    for (const st of accountStates) {
      accountsMap[st.accountId] = st;
    }

    const usdcMinBounds = boundsRes.ok && boundsRes.data?.min
      ? boundsRes.data.min
      : "1250000000000000000000";

    const snapshot: NearMainnetStatusSnapshot = {
      checkedAt: new Date().toISOString(),
      rpcUrl: this.getRpcUrl(),
      rpcReachable: statusRes.ok && Boolean(statusRes.result),
      chainId: statusRes.result?.chain_id ?? null,
      latestBlockHeight:
        statusRes.result?.sync_info?.latest_block_height ?? null,
      latestBlockTime: statusRes.result?.sync_info?.latest_block_time ?? null,
      protocolVersion: statusRes.result?.protocol_version ?? null,
      liveTxBroadcastingEnabled: false,
      broadcastGuardReason:
        "DISABLED_BY_OWNER_POLICY: Real transactions remain disabled until contract deployment, wallet authorization, and transaction simulation are verified.",
      wasmArtifacts,
      usdcMainnet: {
        contractId: usdcId,
        metadata: ftMetaRes.ok && ftMetaRes.data
          ? {
              spec: ftMetaRes.data.spec,
              name: ftMetaRes.data.name,
              symbol: ftMetaRes.data.symbol,
              decimals: ftMetaRes.data.decimals,
            }
          : null,
        storageBalanceBounds: boundsRes.ok && boundsRes.data ? boundsRes.data : null,
      },
      contracts: {
        core: coreProbe,
        audit: auditProbe,
      },
      accounts: accountsMap,
      storageAndDeploymentRequirements: {
        byteCostYocto: NEAR_STORAGE_BYTE_COST_YOCTO.toString(),
        coreWasmStorageNear: wasmArtifacts.core.storageStakeRequiredNear,
        auditWasmStorageNear: wasmArtifacts.audit.storageStakeRequiredNear,
        usdcRegistrationDepositYocto: usdcMinBounds,
        usdcRegistrationDepositNear: formatNearFromYocto(usdcMinBounds, 5),
        coreStorageRegistrationYocto: STORAGE_REGISTRATION,
        coreJobStorageDepositYocto: JOB_STORAGE_DEPOSIT_INITIAL,
        coreLpShareStakeYocto: LP_SHARE_STAKE,
        auditAnchorDepositYocto: ANCHOR_STORAGE_DEPOSIT,
        auditAnchorRetainedYocto: ANCHOR_FINAL_STAKE,
        requiredUsdcRegistrations: [
          `${this.config.mainnetCoreContractId} (MUST be registered on USDC before any ft_transfer_call or ft_transfer)`,
          `${this.config.mainnetAdminAccountId} (Customer / Admin / LP account)`,
          `${this.config.mainnetOperatorAccountId} (Operator / OutLayer executor account receiving advances & settlement payouts)`,
        ],
      },
    };

    this.cachedStatus = snapshot;
    return snapshot;
  }

  public getCachedStatus(): NearMainnetStatusSnapshot | null {
    return this.cachedStatus;
  }

  /**
   * Builds unsigned NEAR transaction payloads for real NEP-141 USDC escrow (`ft_transfer_call`)
   * and SnowMoon contract calls so they can be inspected/simulated without broadcasting.
   */
  public prepareUsdcEscrowAndJobPayloads(params: {
    customerAccountId?: string;
    operatorAccountId?: string;
    coreContractId?: string;
    auditContractId?: string;
    usdcContractId?: string;
    customerPaymentUsdcAtomic?: string;
    maxOperatingBudgetUsdcAtomic?: string;
    termsHash?: string;
    deadlineSec?: number;
    jobId?: string;
    needsStorageRegistration?: boolean;
  }): {
    broadcastingEnabled: false;
    executionStatus: "NOT_EXECUTED_UNSIGNED_DRAFT";
    walletSigned: false;
    onChainVerified: false;
    mode: "UNSIGNED_PREPARATION_ONLY";
    transactions: PreparedNearTransaction[];
  } {
    const customer = assertValidNearAccountId(
      params.customerAccountId || this.config.mainnetAdminAccountId,
      "customerAccountId"
    );
    const operator = assertValidNearAccountId(
      params.operatorAccountId || this.config.mainnetOperatorAccountId,
      "operatorAccountId"
    );
    const coreId = assertValidNearAccountId(
      params.coreContractId || this.config.mainnetCoreContractId,
      "coreContractId"
    );
    const usdcId = assertValidNearAccountId(
      params.usdcContractId || this.config.mainnetUsdcContractId,
      "usdcContractId"
    );
    const paymentVal = parseU128DecimalString(
      params.customerPaymentUsdcAtomic || "100000000",
      "customerPaymentUsdcAtomic",
      false
    );
    const budgetVal = parseU128DecimalString(
      params.maxOperatingBudgetUsdcAtomic || "25000000",
      "maxOperatingBudgetUsdcAtomic",
      true
    );
    const paymentAtomic = paymentVal.toString();
    const budgetAtomic = budgetVal.toString();

    const termsHash = normalizeHex32Lowercase(
      params.termsHash ||
        "0xd8a2a66c36307e760125edcea6a9867891c4d19ef472e5a52e3db1583b3e14de",
      "termsHash"
    );
    const rawDeadline =
      params.deadlineSec !== undefined
        ? Number(params.deadlineSec)
        : Math.floor(Date.now() / 1000) + 86400;
    if (!Number.isSafeInteger(rawDeadline) || rawDeadline <= 0) {
      throw new Error(
        `ERR_INVALID_DEADLINE: deadlineSec must be a positive integer (u64 seconds), got ${params.deadlineSec}`
      );
    }
    const deadlineSec = rawDeadline;
    const firstTimeRegistration = params.needsStorageRegistration ?? true;

    // Decision 1 & Decision 4: 0.023 NEAR per job + 0.007 NEAR one-time storage credit registration = 0.030 NEAR
    const storageDepositRequired = firstTimeRegistration
      ? (
          BigInt(JOB_STORAGE_DEPOSIT_INITIAL) + BigInt(STORAGE_REGISTRATION)
        ).toString()
      : JOB_STORAGE_DEPOSIT_INITIAL;

    const createAndFundMsg = JSON.stringify({
      CreateAndFundJob: {
        operator,
        max_operating_budget: budgetAtomic,
        terms_hash: termsHash,
        deadline: deadlineSec,
      },
    });

    const transactions: PreparedNearTransaction[] = [
      {
        stepNumber: 1,
        description: `Pre-deposit NEAR storage credits on ${coreId} (${
          firstTimeRegistration
            ? "0.007 NEAR registration + 0.023 NEAR job storage = 0.030 NEAR"
            : "0.023 NEAR job storage"
        }) required before 1-step NEP-141 CreateAndFundJob`,
        signerId: customer,
        receiverId: coreId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "storage_deposit",
            args: { account_id: customer },
            gas: "30000000000000", // 30 TGas
            depositYocto: storageDepositRequired,
          },
        ],
      },
      {
        stepNumber: 2,
        description: `Atomic 1-Step NEP-141 USDC Escrow (ft_transfer_call -> ${coreId}::ft_on_transfer -> ft_resolve_transfer)`,
        signerId: customer,
        receiverId: usdcId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "ft_transfer_call",
            args: {
              receiver_id: coreId,
              amount: paymentAtomic,
              memo: "SnowMoon CreateAndFundJob Escrow",
              msg: createAndFundMsg,
            },
            gas: "100000000000000", // 100 TGas (covers ft_transfer_call + ft_on_transfer + ft_resolve_transfer)
            depositYocto: "1", // 1 yoctoNEAR required by NEP-141 ft_transfer_call
          },
        ],
        callbackFlowSummary:
          "1. USDC transfers `amount` from `sender_id` to `coreContractId` -> 2. Invokes `coreContractId::ft_on_transfer(sender_id, amount, msg)` which locks 0.023 NEAR from `storage_credits[sender_id]`, derives `job_id = sha256('snowmoon-core/job-id/v1' || borsh(sender_id) || le64(next_job_seq))`, stores `Job` in `Funded` status, increments `escrowed_usdc`, and returns `PromiseOrValue::Value(U128(0))` (0 refund) -> 3. USDC callback `ft_resolve_transfer` finalizes 0 refund; if `ft_on_transfer` panics, `ft_resolve_transfer` refunds 100% of `amount` to `sender_id`.",
      },
    ];

    if (params.jobId) {
      const normalizedJobId = normalizeHex32Lowercase(params.jobId, "jobId");
      const fundExistingMsg = JSON.stringify({
        FundJob: {
          job_id: normalizedJobId,
        },
      });
      transactions.push({
        stepNumber: 3,
        description: `Alternative 2-Step Funding for Existing Created Job (${normalizedJobId.slice(0, 14)}...) via NEP-141 ft_transfer_call`,
        signerId: customer,
        receiverId: usdcId,
        actions: [
          {
            type: "FunctionCall",
            methodName: "ft_transfer_call",
            args: {
              receiver_id: coreId,
              amount: paymentAtomic,
              memo: "SnowMoon FundJob Escrow",
              msg: fundExistingMsg,
            },
            gas: "90000000000000", // 90 TGas
            depositYocto: "1",
          },
        ],
      });
    }

    return {
      broadcastingEnabled: false,
      executionStatus: "NOT_EXECUTED_UNSIGNED_DRAFT",
      walletSigned: false,
      onChainVerified: false,
      mode: "UNSIGNED_PREPARATION_ONLY",
      transactions,
    };
  }

  public prepareFloatPoolDepositPayload(params: {
    lpAccountId: string;
    amountUsdcAtomic: string;
    receiverAccountId?: string;
  }): PreparedNearTransaction {
    const lp = assertValidNearAccountId(params.lpAccountId, "lpAccountId");
    const receiver = params.receiverAccountId
      ? assertValidNearAccountId(params.receiverAccountId, "receiverAccountId")
      : null;
    const amount = parseU128DecimalString(params.amountUsdcAtomic, "amountUsdcAtomic", false);
    const msg = JSON.stringify({ DepositPool: { receiver } });
    return {
      stepNumber: 1,
      description: `Deposit ${amount.toString()} atomic USDC into FloatPool on ${this.config.mainnetCoreContractId}`,
      signerId: lp,
      receiverId: this.config.mainnetUsdcContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "ft_transfer_call",
          args: {
            receiver_id: this.config.mainnetCoreContractId,
            amount: amount.toString(),
            memo: "SnowMoon FloatPool LP deposit",
            msg,
          },
          gas: "120000000000000",
          depositYocto: "1",
        },
      ],
    };
  }

  public prepareFloatPoolWithdrawPayload(params: {
    lpAccountId: string;
    amountUsdcAtomic: string;
    receiverAccountId?: string;
  }): PreparedNearTransaction {
    const lp = assertValidNearAccountId(params.lpAccountId, "lpAccountId");
    const receiver = params.receiverAccountId
      ? assertValidNearAccountId(params.receiverAccountId, "receiverAccountId")
      : null;
    const amount = parseU128DecimalString(params.amountUsdcAtomic, "amountUsdcAtomic", false);
    return {
      stepNumber: 1,
      description: `Withdraw ${amount.toString()} atomic USDC from FloatPool on ${this.config.mainnetCoreContractId}`,
      signerId: lp,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "withdraw",
          args: {
            assets: amount.toString(),
            receiver,
          },
          gas: "100000000000000",
          depositYocto: "1",
        },
      ],
    };
  }

  public prepareVaultAcceptDeliveryPayload(params: {
    customerAccountId: string;
    jobId: string;
  }): PreparedNearTransaction {
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    return {
      stepNumber: 1,
      description: `Accept delivery, repay any open FloatPool advance, and settle job ${jobIdHex} on ${this.config.mainnetCoreContractId}`,
      signerId: customer,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "accept_delivery",
          args: { job_id: jobIdHex },
          gas: "120000000000000",
          depositYocto: "0",
        },
      ],
      callbackFlowSummary:
        "Synchronously repays any Issued FloatPool advance (principal + 2% fee) via repay_advance_internal before spawning ft_transfer payout of operator_net.",
    };
  }

  public prepareVaultRefundPayload(params: {
    customerAccountId: string;
    jobId: string;
  }): PreparedNearTransaction {
    const customer = assertValidNearAccountId(params.customerAccountId, "customerAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    return {
      stepNumber: 1,
      description: `Refund expired/undelivered job ${jobIdHex} on ${this.config.mainnetCoreContractId}`,
      signerId: customer,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "refund",
          args: { job_id: jobIdHex },
          gas: "100000000000000",
          depositYocto: "0",
        },
      ],
    };
  }

  public prepareFloatPoolRequestAdvancePayload(params: {
    operatorAccountId: string;
    jobId: string;
    expectedPrincipalAtomic: string;
  }): PreparedNearTransaction {
    const operator = assertValidNearAccountId(params.operatorAccountId, "operatorAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    const expectedPrincipal = parseU128DecimalString(
      params.expectedPrincipalAtomic,
      "expectedPrincipalAtomic",
      false
    );
    return {
      stepNumber: 1,
      description: `Request FloatPool advance (${expectedPrincipal.toString()} atomic USDC) for job ${jobIdHex} on ${this.config.mainnetCoreContractId}`,
      signerId: operator,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "request_advance",
          args: {
            job_id: jobIdHex,
            expected_principal: expectedPrincipal.toString(),
          },
          gas: "120000000000000",
          depositYocto: "0",
        },
      ],
      callbackFlowSummary:
        "Verifies Funded job, org exposure cap (<=10% of total_assets), utilization cap (<=80%), and spawns ft_transfer of principal to operator.",
    };
  }

  public prepareVaultStartWorkPayload(params: {
    operatorAccountId: string;
    jobId: string;
  }): PreparedNearTransaction {
    const operator = assertValidNearAccountId(params.operatorAccountId, "operatorAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    return {
      stepNumber: 1,
      description: `Start work on job ${jobIdHex} on ${this.config.mainnetCoreContractId}`,
      signerId: operator,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "start_work",
          args: { job_id: jobIdHex },
          gas: "40000000000000",
          depositYocto: "0",
        },
      ],
    };
  }

  public prepareVaultSubmitDeliveryPayload(params: {
    operatorAccountId: string;
    jobId: string;
    deliveryHash: string;
  }): PreparedNearTransaction {
    const operator = assertValidNearAccountId(params.operatorAccountId, "operatorAccountId");
    const jobIdHex = normalizeHex32Lowercase(params.jobId, "jobId");
    const deliveryHashHex = normalizeHex32Lowercase(params.deliveryHash, "deliveryHash");
    if (deliveryHashHex === "0x" + "00".repeat(32)) {
      throw new Error("ERR_ZERO_HASH: deliveryHash must be non-zero.");
    }
    return {
      stepNumber: 1,
      description: `Submit delivery hash ${deliveryHashHex} for job ${jobIdHex} on ${this.config.mainnetCoreContractId}`,
      signerId: operator,
      receiverId: this.config.mainnetCoreContractId,
      actions: [
        {
          type: "FunctionCall",
          methodName: "submit_delivery",
          args: {
            job_id: jobIdHex,
            delivery_hash: deliveryHashHex,
          },
          gas: "40000000000000",
          depositYocto: "0",
        },
      ],
    };
  }
}

