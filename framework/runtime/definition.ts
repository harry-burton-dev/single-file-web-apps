// The shape of an app's single definition, app/app.config.ts (spec S1, Deliver 2).

// A field is a plain kind, or a kind with a value type. The type is used for
// checking writes and inferring row types; it is never stored.
export type FieldKind = "latest" | "ask" | "text";
export type FieldType = "string" | "number" | "boolean";
export type FieldDef = FieldKind | { kind: "latest" | "ask"; type: FieldType } | { kind: "text" };

export type TableSchema = {
  version: number;
  fields?: Record<string, FieldDef>;
};

/** One step takes a record's fields from version n to n + 1. Steps should only add fields, and leave an already-migrated record unchanged. */
export type Migration = (record: Record<string, unknown>) => Record<string, unknown>;

export type AppDefinition = {
  id: string;
  name: string;
  tables: Record<string, TableSchema>;
  /** { <table>: { <fromVersion>: step } }, applied as records are read and written back by command. */
  migrations?: Record<string, Record<number, Migration>>;
};

/** What a command on a table written by a newer app fails with, and what the shell shows (spec S5, part B). */
export const OLDER_APP_MESSAGE = "this app is older than the data; load the new version";

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TABLE = /^[A-Za-z0-9][A-Za-z0-9-]*$/; // the engine's folder-name rule
const FIELD = /^[A-Za-z][A-Za-z0-9_]*$/; // keeps clear of "_deleted"-style row metadata and the key separator
const RESERVED = new Set(["id", "deleted"]);
// Tables the framework itself syncs (USERS_TABLE in identity/admin.js, decision D17).
// Compared case-insensitively, as on Windows and OneDrive "Users" and "users" are one folder.
const FRAMEWORK_TABLES = new Set(["users"]);
const KINDS = new Set(["latest", "ask", "text"]);
const TYPES = new Set(["string", "number", "boolean"]);

function assertField(table: string, field: string, def: unknown): void {
  if (!FIELD.test(field) || RESERVED.has(field)) {
    throw new Error(`Table ${table}: field name ${JSON.stringify(field)} must start with a letter, use letters, digits and _, and not be id or deleted`);
  }
  if (typeof def === "string" && KINDS.has(def)) return;
  const d = def as { kind?: unknown; type?: unknown } | null;
  if (d && typeof d === "object" && d.kind === "text" && d.type === undefined) return;
  if (d && typeof d === "object" && (d.kind === "latest" || d.kind === "ask") && TYPES.has(d.type as string)) return;
  throw new Error(`Table ${table}: field ${field} must be "latest", "ask", "text", { kind: "text" } or { kind: "latest" | "ask", type: "string" | "number" | "boolean" }`);
}

export function assertAppDefinition(def: AppDefinition): void {
  if (typeof def?.id !== "string" || !ID.test(def.id)) {
    throw new Error(`App id ${JSON.stringify(def?.id)} must be lower-case letters, digits and single hyphens`);
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    throw new Error("App name must be a non-empty string");
  }
  if (!def.tables || typeof def.tables !== "object") throw new Error("App tables must be an object");
  for (const [table, schema] of Object.entries(def.tables)) {
    if (!TABLE.test(table)) throw new Error(`Table name ${JSON.stringify(table)} must be letters, digits and hyphens, starting with a letter or digit`);
    if (FRAMEWORK_TABLES.has(table.toLowerCase())) throw new Error(`Table name ${JSON.stringify(table)} is reserved: the framework keeps its own ${table.toLowerCase()} table`);
    if (!Number.isInteger(schema?.version) || schema.version < 1) throw new Error(`Table ${table}: version must be a whole number of 1 or more`);
    for (const [field, fieldDef] of Object.entries(schema.fields ?? {})) assertField(table, field, fieldDef);
  }
  assertMigrations(def);
}

function assertMigrations(def: AppDefinition): void {
  const migrations: unknown = def.migrations;
  if (migrations === undefined) return;
  if (!migrations || typeof migrations !== "object" || Array.isArray(migrations)) throw new Error("App migrations must be an object");
  for (const [table, steps] of Object.entries(migrations)) {
    if (!Object.hasOwn(def.tables, table)) throw new Error(`Migrations name table ${table}, which is not declared in tables`);
    if (!steps || typeof steps !== "object" || Array.isArray(steps)) throw new Error(`Migrations for ${table} must be an object`);
    const version = def.tables[table].version;
    for (const [from, step] of Object.entries(steps)) {
      const n = Number(from);
      if (!Number.isInteger(n) || n < 1 || n >= version) {
        throw new Error(`Migrations for ${table}: version ${from} must be a whole number of 1 or more, below the table's version (${version})`);
      }
      if (typeof step !== "function") throw new Error(`Migrations for ${table}: the step from version ${from} must be a function`);
    }
  }
}
