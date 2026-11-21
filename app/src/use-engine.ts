// React binding for one shared value. The shell owns the engine's health and
// sync state; this stands in for the query layer (ADR-0008) until TR2 replaces it.
import { useMemo, useSyncExternalStore } from "react";
import type { SharedMap } from "@trellis/framework";

/** One string value in a shared map. */
export function useSharedText(map: SharedMap, key: string): string {
  const store = useMemo(
    () => ({
      subscribe(listener: () => void) {
        map.observe(listener);
        return () => map.unobserve(listener);
      },
      getSnapshot: () => String(map.get(key) ?? ""),
    }),
    [map, key],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
