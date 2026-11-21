// React bindings for engine state. Every sync attempt emits a trace and every
// state change emits a health event, so re-reading on those two keeps the
// screen current without polling.
import { useMemo, useSyncExternalStore } from "react";
import type { Engine, Health, Metrics, SharedMap, Trace } from "@trellis/framework";

const TRACE_LIMIT = 100;

export interface SyncView {
  health: Health | null;
  metrics: Metrics;
  traces: Trace[];
}

interface ExternalStore<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
}

function createSyncStore(engine: Engine): ExternalStore<SyncView> {
  const read = (): SyncView => ({
    health: engine.health(),
    metrics: engine.metrics(),
    traces: engine.traces({ limit: TRACE_LIMIT }),
  });
  let snapshot = read();
  return {
    subscribe(listener) {
      const refresh = (): void => {
        snapshot = read();
        listener();
      };
      const stops = [engine.on("trace", refresh), engine.on("health", refresh)];
      refresh();
      return () => stops.forEach((stop) => stop());
    },
    getSnapshot: () => snapshot,
  };
}

export function useSync(engine: Engine): SyncView {
  const store = useMemo(() => createSyncStore(engine), [engine]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** One string value in a shared map; stands in for the query layer (ADR-0008). */
export function useSharedText(map: SharedMap, key: string): string {
  const store = useMemo<ExternalStore<string>>(
    () => ({
      subscribe(listener) {
        map.observe(listener);
        return () => map.unobserve(listener);
      },
      getSnapshot: () => String(map.get(key) ?? ""),
    }),
    [map, key],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
