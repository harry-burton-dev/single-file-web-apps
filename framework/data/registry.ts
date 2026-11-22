// The table registry (spec S2, Deliver 1): at start, every table in app.config.ts
// is opened through the record layer with its schema. Tables in the folder that
// the definition does not name are never opened, so they are left alone.
import { openTable } from "../engine/src/records/index.js";
import { assertAppDefinition, OLDER_APP_MESSAGE, type AppDefinition, type Migration, type TableSchema } from "../runtime/definition.ts";
import { toRecordSchema } from "./schema.ts";

export type RecordTable = ReturnType<typeof openTable>;

// openTable is JavaScript; its inferred parameter type wrongly requires the unused `adapter`.
const open = openTable as (options: { doc: unknown; schema: { version: number }; deviceId: string; user: string; clock: { now(): number }; migrations?: Record<number, Migration> }) => RecordTable;

export interface EngineLike {
  table(name: string): unknown;
}

export interface Identity {
  deviceId: string;
  user: string;
  clock: { now(): number };
  random: { bytes(n: number): Uint8Array };
}

/** Whether this app may write a table. A table written by a newer app reads but does not write. */
export type TableStatus =
  | { writable: true; storedVersion: number | undefined; supportedVersion: number }
  | { writable: false; storedVersion: number; supportedVersion: number; message: typeof OLDER_APP_MESSAGE };

export interface Registry {
  readonly names: readonly string[];
  has(name: string): boolean;
  def(name: string): TableSchema;
  table(name: string): RecordTable;
  status(name: string): TableStatus;
}

export function openRegistry(engine: EngineLike, config: AppDefinition, who: Identity): Registry {
  assertAppDefinition(config);
  const tables = new Map<string, { def: TableSchema; table: RecordTable }>();
  for (const [name, def] of Object.entries(config.tables)) {
    const table = open({ doc: engine.table(name), schema: toRecordSchema(def), deviceId: who.deviceId, user: who.user, clock: who.clock, migrations: config.migrations?.[name] });
    tables.set(name, { def, table });
  }
  const entry = (name: string) => {
    const found = tables.get(name);
    if (!found) throw new Error(`unknown table: ${name}`);
    return found;
  };
  return {
    names: [...tables.keys()],
    has: (name) => tables.has(name),
    def: (name) => entry(name).def,
    table: (name) => entry(name).table,
    status: (name) => {
      const { def, table } = entry(name);
      const stored = table.schemaVersion() as number | undefined;
      if (typeof stored === "number" && stored > def.version) {
        return { writable: false, storedVersion: stored, supportedVersion: def.version, message: OLDER_APP_MESSAGE };
      }
      return { writable: true, storedVersion: stored, supportedVersion: def.version };
    },
  };
}
