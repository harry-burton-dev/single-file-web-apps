// Types for the engine's public surface (spec 2.5 and 2.7). The engine itself
// is still JavaScript (ADR-0009 section 4); these describe what the framework uses.

export type HealthState = "saved" | "saving" | "retrying" | "folder-disconnected" | "not-reaching-peers" | "offline";

export interface PeerHealth {
  user: string;
  lastHeardAt: number | null;
  lastAckedAt: number | null;
  active: boolean;
  ackedLatest: boolean;
  waitingSince: number | null;
}

export interface Health {
  state: HealthState;
  since: number;
  lastSaveAt: number | null;
  lastScanAt: number | null;
  lastScanOkAt: number | null;
  pending: number;
  nextSaveAt: number | null;
  retryAt: number | null;
  peers: Record<string, PeerHealth>;
}

export type TraceKind = "save" | "scan" | "status" | "compaction" | "reseed";
export type TraceOutcome = "ok" | "partial" | "failed" | "skipped";

export interface TraceStep {
  at: number;
  table: string | null;
  path: string;
  action: "read" | "stat" | "list" | "write" | "delete" | "skip" | "apply";
  bytes: number | null;
  durationMs: number;
  result: string;
  error: string | null;
}

export interface Trace {
  id: number | string;
  kind: TraceKind;
  startedAt: number;
  durationMs: number;
  outcome: TraceOutcome;
  reason: string;
  counts: Record<string, number>;
  steps: TraceStep[];
}

export interface SyncTiming {
  count: number;
  lastMs: number | null;
  avgMs: number | null;
  p95Ms: number | null;
}

export interface Metrics {
  sync: { save: SyncTiming; scan: SyncTiming };
  backlog: { pendingCount: number; pendingBytes: number; oldestAgeMs: number | null; unreadableFiles: number };
  conflicts: { copiesSeen: number; digestMismatches: number; askOpen: number; overlapNotices: number };
  errors: { total: number };
}

export interface Engine {
  /** The table's Yjs document. Only the data runtime (framework/data) reads it. */
  table(name: string): unknown;
  tick(): Promise<void>;
  flush(): Promise<void>;
  scan(): Promise<void>;
  close(): Promise<void>;
  health(): Health;
  metrics(): Metrics;
  traces(filter?: { kind?: TraceKind; outcome?: TraceOutcome; limit?: number }): Trace[];
  setOffline(offline: boolean): void;
  /** Counts ask conflicts opening and closing in metrics().conflicts.askOpen. */
  noteConflict(event: { type: "ask-opened" | "ask-resolved"; table: string; id: string; field: string }): void;
  on(event: "trace" | "health" | "accepted" | "received" | "saved" | "error", listener: (payload: unknown) => void): () => void;
}
