// A stand-in engine for component tests: health, metrics and traces are set by
// the test, and emit() fires the events the shell listens to.
import * as Y from "yjs";
import type { Engine, Health, HealthState, Metrics, Trace } from "../../../host/engine-types";

type Event = Parameters<Engine["on"]>[0];

export interface FakeEngine extends Engine {
  setHealth(next: Partial<Health>): void;
  emit(event: Event): void;
  calls: string[];
}

export function health(state: HealthState, extra: Partial<Health> = {}): Health {
  return { state, since: 0, lastSaveAt: null, lastScanAt: null, lastScanOkAt: null, pending: 0, nextSaveAt: null, retryAt: null, peers: {}, ...extra };
}

export const emptyMetrics: Metrics = {
  sync: { save: { count: 0, lastMs: null, avgMs: null, p95Ms: null }, scan: { count: 0, lastMs: null, avgMs: null, p95Ms: null } },
  backlog: { pendingCount: 0, pendingBytes: 0, oldestAgeMs: null, unreadableFiles: 0 },
  conflicts: { copiesSeen: 0, digestMismatches: 0, askOpen: 0, overlapNotices: 0 },
  errors: { total: 0 },
};

export function fakeEngine({ state = "saved" as HealthState, traces = [] as Trace[], metrics = emptyMetrics, extra = {} as Partial<Health> } = {}): FakeEngine {
  let current = health(state, extra);
  const listeners = new Map<Event, Set<(payload: unknown) => void>>();
  const calls: string[] = [];
  const docs = new Map<string, Y.Doc>();
  const engine: FakeEngine = {
    calls,
    // A real Yjs document per table, so the data runtime can open the app's tables.
    table: (name) => docs.get(name) ?? docs.set(name, new Y.Doc()).get(name)!,
    tick: async () => undefined,
    flush: async () => void calls.push("flush"),
    scan: async () => void calls.push("scan"),
    close: async () => undefined,
    health: () => ({ ...current }),
    metrics: () => metrics,
    traces: () => traces,
    setOffline: () => undefined,
    noteConflict: () => undefined,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)!.delete(listener);
    },
    setHealth(next) {
      current = { ...current, ...next };
      engine.emit("health");
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener(undefined);
    },
  };
  return engine;
}
