// The app's single definition (S1): its identity and its tables. Pure and
// import-free, so Node scripts, the Vite config and the bootstrap can all load it.

export type FieldType = "string" | "number" | "boolean" | "json";
export type FieldDef = { kind: "latest" | "ask"; type: FieldType } | { kind: "text" };
export interface TableDef {
  version: number;
  fields: Record<string, FieldDef>;
}
export interface AppConfig {
  id: string;
  name: string;
  tables: Record<string, TableDef>;
}

/** The folder picker's id limit (32 characters), lower-case so it can name files and databases. */
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The engine's rule for table names (engine/src/engine/constants.js, NAME_RE). */
const TABLE_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** Names the record layer keeps for itself. */
const RESERVED_FIELDS = new Set(["deleted", "id"]);
const UNIT_SEPARATOR = "\u001f";

/** Returns the config unchanged, or throws on the first rule it breaks. */
export function validateConfig(config: AppConfig): AppConfig {
  if (!ID_RE.test(config.id)) throw new Error(`App id "${config.id}" must be 1 to 32 lower-case letters, digits or "-", starting with a letter.`);
  if (config.name.trim() === "") throw new Error("App name must not be empty.");
  for (const [table, def] of Object.entries(config.tables)) {
    if (!TABLE_RE.test(table)) throw new Error(`Table name "${table}" must be letters, digits or "-", starting with a letter or digit.`);
    for (const field of Object.keys(def.fields)) {
      if (RESERVED_FIELDS.has(field) || field.startsWith("_") || field.includes(UNIT_SEPARATOR)) {
        throw new Error(`Table "${table}": field name "${field}" is reserved or contains U+001F.`);
      }
    }
  }
  return config;
}
