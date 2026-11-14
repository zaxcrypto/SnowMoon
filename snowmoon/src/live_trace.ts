import { EventEmitter } from "node:events";

export type LiveTraceStage =
  | "escrow"
  | "workforce"
  | "rules"
  | "ai"
  | "tool"
  | "tee"
  | "verification"
  | "settlement"
  | "anchor";

export type LiveTraceStatus = "running" | "ok" | "error" | "info";

export interface LiveTraceEvent {
  id: string;
  jobId: string;
  ts: string;
  stage: LiveTraceStage;
  status: LiveTraceStatus;
  title: string;
  detail?: string;
  durationMs?: number;
  txHash?: string;
}

const MAX_EVENTS_PER_JOB = 250;
const MAX_TRACKED_JOBS = 120;

class LiveTraceBus extends EventEmitter {
  private readonly jobEvents = new Map<string, LiveTraceEvent[]>();
  private seq = 0;

  public emitTrace(input: Omit<LiveTraceEvent, "id" | "ts"> & { id?: string; ts?: string }): LiveTraceEvent {
    this.seq += 1;
    const evt: LiveTraceEvent = {
      id: input.id || `trc_${Date.now().toString(36)}_${this.seq}`,
      ts: input.ts || new Date().toISOString(),
      jobId: input.jobId || "global",
      stage: input.stage,
      status: input.status,
      title: input.title,
      detail: input.detail,
      durationMs: input.durationMs,
      txHash: input.txHash,
    };

    const list = this.jobEvents.get(evt.jobId) || [];
    list.push(evt);
    if (list.length > MAX_EVENTS_PER_JOB) {
      list.splice(0, list.length - MAX_EVENTS_PER_JOB);
    }
    this.jobEvents.set(evt.jobId, list);

    if (this.jobEvents.size > MAX_TRACKED_JOBS) {
      const oldestKey = this.jobEvents.keys().next().value;
      if (oldestKey) this.jobEvents.delete(oldestKey);
    }

    this.emit("trace", evt);
    return evt;
  }

  public getTrace(jobId?: string): LiveTraceEvent[] {
    if (jobId) {
      return [...(this.jobEvents.get(jobId) || [])];
    }
    const all: LiveTraceEvent[] = [];
    for (const arr of this.jobEvents.values()) {
      all.push(...arr);
    }
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    return all.slice(-200);
  }
}

export const liveTraceBus = new LiveTraceBus();

export function emitLiveTrace(
  input: Omit<LiveTraceEvent, "id" | "ts"> & { id?: string; ts?: string }
): LiveTraceEvent {
  return liveTraceBus.emitTrace(input);
}

