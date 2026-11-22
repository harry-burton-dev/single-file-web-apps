// Per-table row views (spec S2, Deliver 3; ADR-0008 reductions). A view holds the
// table's rows in memory and rebuilds them whole and lazily after a change. Rows
// that did not change keep their object identity, and so does the rows array when
// nothing changed, so a screen re-renders only when its result changes.
import type { RecordTable } from "./registry.ts";
import { toRow, type AnyRow, type RowSource, type StoredRecord } from "./schema.ts";

/** An external store, in the shape React's useSyncExternalStore takes. */
export interface Store<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

export interface TableView extends RowSource {
  /** Every row, deleted ones included, sorted by id. */
  rows(): readonly AnyRow[];
  byId(id: string): AnyRow | undefined;
  /** Subscribe to changes; the snapshot is rows(). */
  readonly store: Store<readonly AnyRow[]>;
  /** Marks the rows stale and schedules one notification for the next microtask. */
  markDirty(): void;
  /** Delivers a pending notification now instead of on the microtask. Commands call this once after they write. */
  flush(): void;
  close(): void;
}

/** Structural equality for stored values: plain JSON data (objects, arrays, primitives). */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export function createView(table: RecordTable): TableView {
  let rows: readonly AnyRow[] = [];
  let index = new Map<string, AnyRow>();
  let dirty = true;
  let pending = false;
  let closed = false;
  const listeners = new Set<() => void>();

  function rebuild() {
    dirty = false;
    const prev = index;
    const nextIndex = new Map<string, AnyRow>();
    const next: AnyRow[] = [];
    let changed = false;
    for (const record of table.list({ includeDeleted: true }) as StoredRecord[]) {
      const fresh = toRow(record);
      const old = prev.get(record.id);
      const row = old && same(old, fresh) ? old : fresh;
      if (row !== rows[next.length]) changed = true;
      next.push(row);
      nextIndex.set(record.id, row);
    }
    if (changed || next.length !== rows.length) rows = next;
    index = nextIndex;
  }

  function notify() {
    pending = false;
    for (const listener of [...listeners]) listener();
  }

  const view: TableView = {
    rows() {
      if (dirty) rebuild();
      return rows;
    },
    byId(id) {
      if (dirty) rebuild();
      return index.get(id);
    },
    store: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => view.rows(),
    },
    markDirty() {
      dirty = true;
      if (pending || closed) return;
      pending = true;
      queueMicrotask(() => { if (pending) notify(); });
    },
    flush() {
      if (pending) notify();
    },
    close() {
      closed = true;
      pending = false;
      unsubscribe();
      listeners.clear();
    },
  };
  // Fires once per committed transaction, local or remote (OUT-19).
  const unsubscribe = table.onChange(() => view.markDirty());
  return view;
}
