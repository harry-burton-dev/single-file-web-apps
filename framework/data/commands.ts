// Commands (spec S2, Deliver 2): the only way to write. A command's handler
// gets a `tx` that reads the data as it stood when the run began and buffers
// changes. When the handler returns, every change is validated; only then is
// anything written, as one record-layer batch per table (ADR-0007 sections 3
// and 4). A throw, tx.fail() or a failed check writes nothing.
import { makeId, newId } from "../engine/src/records/index.js";
import type { FieldDef } from "../runtime/definition.ts";
import { builtins } from "./builtins.ts";
import type { Registry, Identity } from "./registry.ts";
import { checkValue, toRow, type AnyRow, type Config, type Fields, type RowOf, type RowSource, type StoredRecord, type TableName } from "./schema.ts";

export interface Tx {
  /** The time of this run, read once from the layer's clock. */
  readonly now: number;
  readonly user: string;
  readonly device: string;
  /** Reads see the data as it stood when the run began, not this run's own changes. */
  get<T extends TableName>(table: T, id: string): RowOf<T> | undefined;
  list<T extends TableName>(table: T, options?: { includeDeleted?: boolean }): readonly RowOf<T>[];
  /** A random id from the layer's randomness. */
  newId(): string;
  /** A predictable id built from its parts, so two devices doing the same thing land on one record. */
  id(...parts: string[]): string;
  put<T extends TableName>(table: T, id: string, fields: Fields<Config["tables"][T]>): void;
  remove(table: TableName, id: string): void;
  restore(table: TableName, id: string): void;
  resolve(table: TableName, id: string, field: string, value: unknown): void;
  /** Ends the run with { ok: false, code: "failed", error: message }. Nothing is written. */
  fail(message: string): never;
}

export type Change =
  | { op: "put"; table: string; id: string; fields: Record<string, unknown> }
  | { op: "remove" | "restore"; table: string; id: string }
  | { op: "resolve"; table: string; id: string; field: string; value: unknown };

export type FailCode = "failed" | "invalid" | "schema-too-new" | "unknown-command";
export type CommandResult<V = unknown> =
  | { ok: true; value: V; changes: readonly Change[] }
  | { ok: false; error: string; code: FailCode };

export interface CommandDef<I = any, V = any> {
  readonly name: string;
  readonly handler: (tx: Tx, input: I) => V;
}

/** One logged run. `before` holds each touched record as it stood, so undo can be added later. */
export interface CommandRun {
  seq: number;
  name: string;
  input: unknown;
  at: number;
  user: string;
  device: string;
  ok: boolean;
  code?: FailCode;
  error?: string;
  changes: readonly Change[];
  before: readonly { table: string; id: string; row: AnyRow | undefined }[];
}

const BUILTIN = /^records\./;
const builtinByName = new Map(builtins.map((def) => [def.name, def as CommandDef]));

export interface CommandRegistry {
  define<I = void, V = void>(name: string, handler: (tx: Tx, input: I) => V): CommandDef<I, V>;
  get(name: string): CommandDef | undefined;
  names(): readonly string[];
}

/** A set of app commands. Built-ins (records.*) are always available and can't be redefined. */
export function createCommandRegistry(): CommandRegistry {
  const defs = new Map<string, CommandDef>();
  return {
    define(name, handler) {
      if (typeof name !== "string" || name === "") throw new TypeError("command name must be a non-empty string");
      if (typeof handler !== "function") throw new TypeError(`command ${name} needs a handler function`);
      if (BUILTIN.test(name)) throw new Error(`command name ${name} is reserved for built-ins`);
      if (defs.has(name)) throw new Error(`command ${name} is already defined`);
      const def = Object.freeze({ name, handler });
      defs.set(name, def);
      return def;
    },
    get: (name) => builtinByName.get(name) ?? defs.get(name),
    names: () => [...builtinByName.keys(), ...defs.keys()],
  };
}

/** The app's commands. defineCommand at module scope adds to it; a duplicate name throws at import. */
export const commands = createCommandRegistry();
export const defineCommand: CommandRegistry["define"] = (name, handler) => commands.define(name, handler);

const SEP = "\u001f";
const badId = (id: unknown) => typeof id !== "string" || id === "" || id.includes(SEP);
const kindOf = (def: FieldDef) => (typeof def === "string" ? def : def.kind);

/** Reads a table straight from the record layer. Used when no view supplies the rows. */
export function recordSource(registry: Registry, name: string): RowSource {
  const table = registry.table(name);
  return {
    rows: () => (table.list({ includeDeleted: true }) as StoredRecord[]).map(toRow),
    byId: (id) => {
      const record = table.get(id) as StoredRecord | undefined;
      return record && toRow(record);
    },
  };
}

export interface RunnerDeps {
  registry: Registry;
  who: Identity;
  commands?: CommandRegistry;
  /** Where a run reads each table's rows; views supply this once they exist. Defaults to the record layer. */
  source?: (table: string) => RowSource;
  /** Called once after a run writes, with the tables it wrote to. The runtime flushes those views here, so screens hear about the change before run() returns. */
  onApplied?: (tables: readonly string[]) => void;
  /** How many runs the in-memory log keeps (default 200). */
  logLimit?: number;
}

export interface Runner {
  run<I, V>(command: string | CommandDef<I, V>, input: I): CommandResult<V>;
  log(): readonly CommandRun[];
}

export function createRunner(deps: RunnerDeps): Runner {
  const { registry, who } = deps;
  const registryOfCommands = deps.commands ?? commands;
  const source = deps.source ?? ((name: string) => recordSource(registry, name));
  const logLimit = deps.logLimit ?? 200;
  const log: CommandRun[] = [];
  let seq = 0;

  function run<I, V>(command: string | CommandDef<I, V>, input: I): CommandResult<V> {
    const name = typeof command === "string" ? command : command?.name;
    const def = typeof command === "string" ? registryOfCommands.get(command) : command;
    const at = who.clock.now();
    const changes: Change[] = [];
    const before = new Map<string, { table: string; id: string; row: AnyRow | undefined }>();
    // Each table's rows are read once, on first use, so a run sees one snapshot per table.
    const snapshots = new Map<string, RowSource>();

    const sourceOf = (table: string) => {
      if (!registry.has(table)) throw new Error(`unknown table: ${table}`);
      let found = snapshots.get(table);
      if (!found) {
        const rows = source(table).rows();
        const byId = new Map(rows.map((row) => [row.id, row]));
        found = { rows: () => rows, byId: (id) => byId.get(id) };
        snapshots.set(table, found);
      }
      return found;
    };
    const touch = (table: string, id: string) => {
      const key = table + SEP + id;
      if (!before.has(key) && registry.has(table) && !badId(id)) before.set(key, { table, id, row: sourceOf(table).byId(id) });
    };
    const record = (change: Change) => {
      changes.push(change);
      touch(change.table, change.id);
    };

    const finish = (result: CommandResult<V>): CommandResult<V> => {
      log.push({
        seq: ++seq, name: name ?? String(command), input, at, user: who.user, device: who.deviceId,
        ok: result.ok, ...(result.ok ? {} : { code: result.code, error: result.error }),
        changes: [...changes], before: [...before.values()],
      });
      if (log.length > logLimit) log.splice(0, log.length - logLimit);
      return result;
    };
    const failed = (code: FailCode, error: string) => finish({ ok: false, code, error });

    if (!def || typeof def.handler !== "function") return failed("unknown-command", `unknown command: ${name}`);

    const tx: Tx = {
      now: at,
      user: who.user,
      device: who.deviceId,
      get: (table, id) => sourceOf(table).byId(id) as any,
      list: (table, options) => sourceOf(table).rows().filter((row) => options?.includeDeleted || !row._deleted) as any,
      newId: () => newId(who.random),
      id: (...parts) => makeId(...parts),
      put: (table, id, fields) => record({ op: "put", table, id, fields: { ...(fields as object) } }),
      remove: (table, id) => record({ op: "remove", table, id }),
      restore: (table, id) => record({ op: "restore", table, id }),
      resolve: (table, id, field, value) => record({ op: "resolve", table, id, field, value }),
      fail: (message) => { throw new Error(message); },
    };

    let value: V;
    try {
      value = def.handler(tx, input);
    } catch (err) {
      return failed("failed", err instanceof Error ? err.message : String(err));
    }

    let problem: { code: FailCode; error: string } | null;
    try {
      problem = validate(changes, sourceOf);
    } catch (err) {
      problem = { code: "invalid", error: err instanceof Error ? err.message : String(err) };
    }
    if (problem) return failed(problem.code, problem.error);

    apply(changes);
    const result = finish({ ok: true, value, changes: [...changes] });
    if (changes.length > 0) deps.onApplied?.([...new Set(changes.map((c) => c.table))]);
    return result;
  }

  // ADR-0007 section 4, step 4, plus the schema check of step 2. Returns the first problem, or null.
  function validate(changes: Change[], sourceOf: (table: string) => RowSource): { code: FailCode; error: string } | null {
    const deleted = new Map<string, boolean>();
    for (const change of changes) {
      const { table, id } = change;
      if (!registry.has(table)) return { code: "invalid", error: `unknown table: ${table}` };
      if (badId(id)) return { code: "invalid", error: `${table}: record id must be a non-empty string without U+001F` };
      const schema = registry.def(table);
      const fields = schema.fields ?? {};
      const key = table + SEP + id;
      if (!deleted.has(key)) deleted.set(key, sourceOf(table).byId(id)?._deleted === true);

      if (change.op === "remove" || change.op === "restore") {
        deleted.set(key, change.op === "remove");
        continue;
      }
      if (deleted.get(key)) return { code: "invalid", error: `${table}/${id} is deleted; restore it before writing to it` };
      const values = change.op === "put" ? change.fields : change.op === "resolve" ? { [change.field]: change.value } : {};
      if (values === null || typeof values !== "object" || Array.isArray(values)) return { code: "invalid", error: `${table}/${id}: fields must be an object` };
      for (const [field, value] of Object.entries(values)) {
        const fieldDef = Object.hasOwn(fields, field) ? fields[field] : undefined;
        if (fieldDef === undefined) return { code: "invalid", error: `${table} has no field ${field}` };
        if (change.op === "resolve" && kindOf(fieldDef) !== "ask") return { code: "invalid", error: `${table}.${field} is not an ask field, so it has nothing to resolve` };
        const reason = checkValue(fieldDef, value);
        if (reason) return { code: "invalid", error: `${table}.${field}: ${reason}` };
      }
    }
    for (const table of new Set(changes.map((c) => c.table))) {
      const status = registry.status(table);
      if (!status.writable) {
        return { code: "schema-too-new", error: `${table}: ${status.message} (stored at schema version ${status.storedVersion}, this app supports ${status.supportedVersion}); nothing was written` };
      }
    }
    return null;
  }

  // One batch per table, in the order each table was first touched. Validation has
  // already ruled out everything the record layer would throw on.
  function apply(changes: Change[]) {
    const byTable = new Map<string, Change[]>();
    for (const change of changes) {
      if (!byTable.has(change.table)) byTable.set(change.table, []);
      byTable.get(change.table)!.push(change);
    }
    for (const [name, list] of byTable) {
      const table = registry.table(name);
      table.batch(() => {
        for (const change of list) {
          if (change.op === "put") { if (Object.keys(change.fields).length > 0) table.put(change.id, change.fields); }
          else if (change.op === "resolve") table.put(change.id, { [change.field]: change.value });
          else if (change.op === "remove") table.remove(change.id);
          else table.restore(change.id);
        }
      });
    }
  }

  return { run, log: () => [...log] };
}
