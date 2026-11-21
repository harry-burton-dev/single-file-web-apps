// where and sort over a view's rows (spec S2, Deliver 3), and `stable`, which keeps
// a selector's previous result when the new one has the same elements.
import { same } from "./view.ts";

export type Sort<R> = keyof R | { by: keyof R; dir?: "asc" | "desc" } | ((a: R, b: R) => number);

export interface Query<R> {
  /** An object matches rows whose fields equal every given value; a function is a filter. */
  where?: Partial<R> | ((row: R) => boolean);
  sort?: Sort<R>;
  /** Deleted rows are left out unless this is true. */
  includeDeleted?: boolean;
}

// Missing values (undefined or null) sort last in both directions; others compare with < and >.
function byField<R>(by: keyof R, dir: "asc" | "desc"): (a: R, b: R) => number {
  const sign = dir === "desc" ? -1 : 1;
  return (a, b) => {
    const x = a[by] as unknown;
    const y = b[by] as unknown;
    const xm = x === undefined || x === null;
    const ym = y === undefined || y === null;
    if (xm || ym) return xm === ym ? 0 : xm ? 1 : -1;
    return (x as never) < (y as never) ? -sign : (x as never) > (y as never) ? sign : 0;
  };
}

function comparator<R>(sort: Sort<R>): (a: R, b: R) => number {
  if (typeof sort === "function") return sort;
  if (typeof sort === "object" && sort !== null) return byField(sort.by, sort.dir ?? "asc");
  return byField(sort, "asc");
}

/** Filters and sorts rows. The input is not changed. Ties keep the input order (rows come sorted by id). */
export function select<R>(rows: readonly R[], q: Query<R> = {}): readonly R[] {
  const where = q.where;
  const match = typeof where === "function" ? where
    : where ? (row: R) => Object.entries(where).every(([k, v]) => same((row as Record<string, unknown>)[k], v))
    : null;
  let out = rows.filter((row) => (q.includeDeleted || !(row as { _deleted?: boolean })._deleted) && (!match || match(row)));
  if (q.sort !== undefined) out = out.sort(comparator(q.sort));
  return out;
}

/** Returns prev when next is the same value, or an array with the same elements in the same order. */
export function stable<T>(prev: T | undefined, next: T): T {
  if (prev === undefined) return next;
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((x, i) => Object.is(x, next[i]))) return prev;
  return next;
}
