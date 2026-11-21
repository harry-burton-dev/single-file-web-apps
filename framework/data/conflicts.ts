// The open-conflict list (spec S2): every ask field that holds more than one
// candidate, across all views, sorted by table, id and field. It reports opened and
// resolved conflicts to the engine, which makes its askOpen metric live.
import type { Candidate } from "./schema.ts";
import { same, type Store, type TableView } from "./view.ts";
import { stable } from "./select.ts";

export interface Conflict {
  readonly table: string;
  readonly id: string;
  readonly field: string;
  /** The provisional value: the latest candidate. */
  readonly value: unknown;
  readonly candidates: readonly Candidate<unknown>[];
}

export interface ConflictSink {
  noteConflict?(event: { type: "ask-opened" | "ask-resolved"; table: string; id: string; field: string }): void;
}

export interface ConflictStore extends Store<readonly Conflict[]> {
  close(): void;
}

const keyOf = (c: Pick<Conflict, "table" | "id" | "field">) => `${c.table}|${c.id}|${c.field}`;

export function createConflictStore(views: ReadonlyMap<string, TableView>, engine?: ConflictSink): ConflictStore {
  const listeners = new Set<() => void>();
  let list: readonly Conflict[] = [];
  let byKey = new Map<string, Conflict>();

  // Deleted records are left out, as the record layer's table.conflicts() does.
  function compute(): boolean {
    const next: Conflict[] = [];
    const nextByKey = new Map<string, Conflict>();
    for (const table of [...views.keys()].sort()) {
      for (const row of views.get(table)!.rows()) {
        if (row._deleted) continue;
        const conflicts = row._conflicts as Record<string, readonly Candidate<unknown>[]>;
        for (const field of Object.keys(conflicts).sort()) {
          const fresh: Conflict = { table, id: row.id, field, value: (row as Record<string, unknown>)[field], candidates: conflicts[field] };
          const key = keyOf(fresh);
          const old = byKey.get(key);
          const conflict = old && same(old, fresh) ? old : fresh;
          next.push(conflict);
          nextByKey.set(key, conflict);
        }
      }
    }
    for (const key of nextByKey.keys()) if (!byKey.has(key)) report("ask-opened", nextByKey.get(key)!);
    for (const key of byKey.keys()) if (!nextByKey.has(key)) report("ask-resolved", byKey.get(key)!);
    const prev = list;
    list = stable(prev, next);
    byKey = nextByKey;
    return list !== prev;
  }

  function report(type: "ask-opened" | "ask-resolved", c: Conflict) {
    engine?.noteConflict?.({ type, table: c.table, id: c.id, field: c.field });
  }

  // Recomputed when a view notifies, so the engine hears about conflicts even with no reader.
  const onViewChange = () => {
    if (compute()) for (const listener of [...listeners]) listener();
  };
  const unsubscribes = [...views.values()].map((view) => view.store.subscribe(onViewChange));
  compute();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => list,
    close() {
      for (const off of unsubscribes) off();
      listeners.clear();
    },
  };
}
