// React bindings for engine state. Every sync attempt emits a trace and every
// state change emits a health event, so re-reading on those keeps the screen
// current without polling. Snapshots are cached: the engine returns a new
// object on every read.
import { useMemo, useSyncExternalStore } from "react";
import type { Engine } from "../host/engine-types";

type EngineEvent = Parameters<Engine["on"]>[0];

/** `events` and `read` must be fixed per call site (module constants). Null before the engine has started. */
export function useEngineValue<T>(engine: Engine, events: readonly EngineEvent[], read: (engine: Engine) => T): T;
export function useEngineValue<T>(engine: Engine | null, events: readonly EngineEvent[], read: (engine: Engine) => T): T | null;
export function useEngineValue<T>(engine: Engine | null, events: readonly EngineEvent[], read: (engine: Engine) => T): T | null {
  const store = useMemo(() => {
    if (!engine) return { subscribe: () => () => undefined, getSnapshot: () => null };
    let snapshot = read(engine);
    return {
      subscribe(listener: () => void) {
        const refresh = (): void => {
          snapshot = read(engine);
          listener();
        };
        const stops = events.map((event) => engine.on(event, refresh));
        refresh();
        return () => stops.forEach((stop) => stop());
      },
      getSnapshot: () => snapshot,
    };
  }, [engine, events, read]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
