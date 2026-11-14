function redactSensitiveText(input: string): string {
  return String(input)
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-[REDACTED]")
    .replace(/sb_secret_[a-zA-Z0-9_-]+/g, "sb_secret_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/g, "ed25519:[REDACTED]");
}

export type MonitoringEventKind =
  | "FAILED_PAYMENT"
  | "STUCK_JOB"
  | "PENDING_ADVANCE"
  | "PENDING_CALLBACK"
  | "FAILED_REFUND"
  | "DUPLICATE_ATTEMPT"
  | "RPC_ERROR"
  | "SUPABASE_WRITE_CONFLICT"
  | "OUTLAYER_FAILURE"
  | "UNEXPECTED_FINANCIAL_STATE"
  | "LOW_FLOAT_LIQUIDITY";

export interface MonitoringAlert {
  id: string;
  kind: MonitoringEventKind;
  severity: "INFO" | "WARN" | "CRITICAL";
  message: string;
  jobId?: string;
  timestamp: string;
}

export class MonitoringService {
  private readonly alerts: MonitoringAlert[] = [];
  private readonly counters: Record<MonitoringEventKind, number> = {
    FAILED_PAYMENT: 0,
    STUCK_JOB: 0,
    PENDING_ADVANCE: 0,
    PENDING_CALLBACK: 0,
    FAILED_REFUND: 0,
    DUPLICATE_ATTEMPT: 0,
    RPC_ERROR: 0,
    SUPABASE_WRITE_CONFLICT: 0,
    OUTLAYER_FAILURE: 0,
    UNEXPECTED_FINANCIAL_STATE: 0,
    LOW_FLOAT_LIQUIDITY: 0,
  };

  public record(
    kind: MonitoringEventKind,
    severity: "INFO" | "WARN" | "CRITICAL",
    message: string,
    jobId?: string
  ): MonitoringAlert {
    this.counters[kind] += 1;
    const alert: MonitoringAlert = {
      id: `mon_${Date.now()}_${this.alerts.length + 1}`,
      kind,
      severity,
      message: redactSensitiveText(message),
      jobId,
      timestamp: new Date().toISOString(),
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > 250) {
      this.alerts.length = 250;
    }
    return alert;
  }

  public snapshot(extra?: {
    stuckJobsCount?: number;
    pendingAdvancesCount?: number;
    idleFloatLiquidityAtomic?: string;
    lowLiquidityThresholdAtomic?: string;
  }): {
    counters: Record<MonitoringEventKind, number>;
    recentAlerts: MonitoringAlert[];
    stuckJobsCount: number;
    pendingAdvancesCount: number;
    lowFloatLiquidity: boolean;
  } {
    const idle = BigInt(extra?.idleFloatLiquidityAtomic || "0");
    const thresh = BigInt(extra?.lowLiquidityThresholdAtomic || "0");
    const lowFloatLiquidity = thresh > 0n && idle < thresh;
    return {
      counters: { ...this.counters },
      recentAlerts: this.alerts.slice(0, 50),
      stuckJobsCount: extra?.stuckJobsCount ?? 0,
      pendingAdvancesCount: extra?.pendingAdvancesCount ?? 0,
      lowFloatLiquidity,
    };
  }
}
