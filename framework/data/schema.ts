// Row types inferred from the schema in app.config.ts, with no code generation
// step (spec S2, "Defaults chosen"), and the conversion to the record layer's schema.
import type { AppDefinition, FieldDef, FieldKind, TableSchema } from "../runtime/definition.ts";

/** The TypeScript type of a field's value. Untyped "latest" and "ask" fields are unknown. */
export type ValueOf<F> = F extends "text" | { kind: "text" } ? string
  : F extends { type: "string" } ? string
  : F extends { type: "number" } ? number
  : F extends { type: "boolean" } ? boolean
  : unknown;

export type KindOf<F> = F extends FieldKind ? F : F extends { kind: infer K } ? K : never;

/** A table's declared fields; none when the schema has no fields. */
export type FieldsOf<S> = S extends { fields?: infer F extends Record<string, FieldDef> } ? F : {};

/** One device's value of an ask field. */
export interface Candidate<V> {
  readonly value: V;
  readonly user: string;
  readonly device: string;
  readonly writtenAt: number;
}

export type AskFields<S> = { [K in keyof FieldsOf<S>]: KindOf<FieldsOf<S>[K]> extends "ask" ? K : never }[keyof FieldsOf<S>];

/** A record as screens read it. Every field is optional: data is incomplete by design (ADR-0008 section 5). */
export type Row<S extends TableSchema> = {
  readonly id: string;
  readonly _deleted: boolean;
  readonly _conflicts: { readonly [K in AskFields<S>]?: readonly Candidate<ValueOf<FieldsOf<S>[K]>>[] };
} & { readonly [K in keyof FieldsOf<S>]?: ValueOf<FieldsOf<S>[K]> };

/** The fields a write may set. */
export type Fields<S extends TableSchema> = { [K in keyof FieldsOf<S>]?: ValueOf<FieldsOf<S>[K]> };

/**
 * The app registers its definition once, in app.config.ts:
 *   declare module "@trellis/framework" { interface Register { config: typeof config } }
 * Until it does, every table name is a string and every row is untyped.
 */
export interface Register {}
export type ConfigOf<R> = R extends { config: infer C extends AppDefinition } ? C : AppDefinition;
export type Config = ConfigOf<Register>;
export type TableName = keyof Config["tables"] & string;
export type RowOf<T extends TableName> = Row<Config["tables"][T]>;

/** A row of any table, as framework code sees it. */
export type AnyRow = Row<TableSchema>;

/** Read access to one table's rows. Views provide it; commands read through it. */
export interface RowSource {
  rows(): readonly AnyRow[];
  byId(id: string): AnyRow | undefined;
}

/** A record as the record layer returns it from get() and list(). */
export interface StoredRecord {
  id: string;
  deleted: boolean;
  fields: Record<string, unknown>;
  conflicts: Record<string, readonly Candidate<unknown>[]>;
}

/** Flattens a stored record into a row: fields at the top, metadata under _deleted and _conflicts. */
export function toRow(record: StoredRecord): AnyRow {
  return { ...record.fields, id: record.id, _deleted: record.deleted, _conflicts: record.conflicts } as AnyRow;
}

const kindOf = (def: FieldDef): FieldKind => (typeof def === "string" ? def : def.kind);

/** The record layer's schema: the version, and each field's kind. */
export function toRecordSchema(def: TableSchema): { version: number; fields: Record<string, FieldKind> } {
  const fields: Record<string, FieldKind> = {};
  for (const [name, field] of Object.entries(def.fields ?? {})) fields[name] = kindOf(field);
  return { version: def.version, fields };
}

/** Checks one value against its field. Returns null when it is valid, else the reason. */
export function checkValue(def: FieldDef, value: unknown): string | null {
  if (value === undefined) return "value is undefined";
  const type = kindOf(def) === "text" ? "string" : typeof def === "string" ? undefined : (def as { type?: string }).type;
  if (type === undefined || typeof value === type) return null;
  return `expected a ${type}, got ${value === null ? "null" : typeof value}`;
}
