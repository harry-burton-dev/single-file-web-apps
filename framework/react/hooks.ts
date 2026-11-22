// The React data hooks (spec S2): how a screen reads and writes. Each read hook
// subscribes to one table's view and keeps its previous result while the new one
// has the same rows, so a screen re-renders only when its own result changes.
// Writes go through commands only. No JSX, so this file needs no React transform.
import { createContext, createElement, useCallback, useContext, useRef, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import type { Data } from "../data/runtime.ts";
import type { CreateInput, RecordInput, ResolveInput, UpdateInput } from "../data/builtins.ts";
import type { CommandDef, CommandResult } from "../data/commands.ts";
import type { Conflict } from "../data/conflicts.ts";
import type { AnyRow, Candidate, Config, FieldsOf, RowOf, TableName, ValueOf } from "../data/schema.ts";
import { select, stable, type Query } from "../data/select.ts";
import { same } from "../data/view.ts";

const DataContext = createContext<Data | null>(null);

/** Gives the screens below it one device's data. */
export function DataProvider(props: { data: Data; children?: ReactNode }): ReactElement {
  return createElement(DataContext.Provider, { value: props.data }, props.children);
}

function useData(): Data {
  const data = useContext(DataContext);
  if (!data) throw new Error("Data hooks must be inside <DataProvider>");
  return data;
}

/**
 * Subscribes to one table's view and derives a value from its rows. The value is
 * recomputed only when the rows array or `key` (compared by value) changes, and
 * `keep` hands back the previous value when the new one is equivalent.
 */
function useFromView<T>(table: string, key: unknown, compute: (rows: readonly AnyRow[]) => T, keep: (prev: T | undefined, next: T) => T): T {
  const view = useData().view(table);
  const memo = useRef<{ view: unknown; rows: readonly AnyRow[]; key: unknown; value: T } | null>(null);
  const getSnapshot = () => {
    const rows = view.rows();
    const m = memo.current;
    if (m && m.view === view && m.rows === rows && same(m.key, key)) return m.value;
    const value = keep(m?.view === view ? m.value : undefined, compute(rows));
    memo.current = { view, rows, key, value };
    return value;
  };
  return useSyncExternalStore(view.store.subscribe, getSnapshot, getSnapshot);
}

const keepSame = <T>(prev: T | undefined, next: T): T => (prev !== undefined && same(prev, next) ? prev : next);

/** The table's live rows (deleted ones left out unless the query asks), filtered and sorted. */
export function useRecords<T extends TableName>(table: T, query?: Query<RowOf<T>>): readonly RowOf<T>[] {
  return useFromView(table, query, (rows) => select(rows as readonly RowOf<T>[], query), stable);
}

/** One record by id, deleted or not (check `_deleted`); undefined when there is none. */
export function useRecord<T extends TableName>(table: T, id: string): RowOf<T> | undefined {
  return useFromView(table, id, (rows) => rows.find((r) => r.id === id) as RowOf<T> | undefined, stable);
}

type FieldName<T extends TableName> = keyof FieldsOf<Config["tables"][T]> & string;
type FieldValue<T extends TableName, F extends FieldName<T>> = ValueOf<FieldsOf<Config["tables"][T]>[F]>;

export interface FieldState<V> {
  /** The field's value; for an ask field in conflict, the provisional (latest) one. */
  readonly value: V | undefined;
  /** The candidates while an ask field is in conflict, otherwise null. */
  readonly conflict: readonly Candidate<V>[] | null;
}

/** One field of one record, with its conflict if it has one. */
export function useField<T extends TableName, F extends FieldName<T>>(table: T, id: string, field: F): FieldState<FieldValue<T, F>> {
  return useFromView(table, [id, field], (rows) => {
    const row = rows.find((r) => r.id === id) as Record<string, unknown> | undefined;
    const conflicts = row?._conflicts as Record<string, readonly Candidate<FieldValue<T, F>>[]> | undefined;
    return { value: row?.[field] as FieldValue<T, F> | undefined, conflict: conflicts?.[field] ?? null };
  }, keepSame);
}

/** The built-in commands' inputs and values, so useCommand("records.create") is typed. */
export interface BuiltinCommands {
  "records.create": [CreateInput, string];
  "records.update": [UpdateInput, void];
  "records.remove": [RecordInput, void];
  "records.restore": [RecordInput, void];
  "records.resolve": [ResolveInput, void];
}

/** A function that runs the command on this device. It never throws; check `ok`. It keeps its identity across renders. */
export function useCommand<N extends keyof BuiltinCommands>(name: N): (input: BuiltinCommands[N][0]) => CommandResult<BuiltinCommands[N][1]>;
export function useCommand<I, V>(command: CommandDef<I, V>): (input: I) => CommandResult<V>;
export function useCommand(name: string): (input: unknown) => CommandResult;
export function useCommand(command: string | CommandDef): (input: unknown) => CommandResult {
  const data = useData();
  return useCallback((input: unknown) => data.run(command, input), [data, command]);
}

/** Every open conflict on this device, sorted by table, id and field. */
export function useConflicts(): readonly Conflict[] {
  const { conflicts } = useData();
  return useSyncExternalStore(conflicts.subscribe, conflicts.getSnapshot, conflicts.getSnapshot);
}

type ConflictRef = Pick<Conflict, "table" | "id" | "field">;

/** Settles a conflict to one value with the records.resolve command. */
export function resolveConflict(data: Data, conflict: ConflictRef, value: unknown): CommandResult<void> {
  return data.run<ResolveInput, void>("records.resolve", { table: conflict.table as TableName, id: conflict.id, field: conflict.field, value });
}

/** resolveConflict bound to this device's data. */
export function useResolveConflict(): (conflict: ConflictRef, value: unknown) => CommandResult<void> {
  const data = useData();
  return useCallback((conflict: ConflictRef, value: unknown) => resolveConflict(data, conflict, value), [data]);
}
