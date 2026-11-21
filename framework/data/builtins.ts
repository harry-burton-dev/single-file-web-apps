// Built-in commands (spec S2, Deliver 2): create, update, remove, restore and
// resolve a record in any table. They take the table name as input, so the
// framework holds no app identifiers (G4). Every runner knows them by name.
import type { CommandDef, Tx } from "./commands.ts";
import type { TableName } from "./schema.ts";

export type CreateInput = { table: TableName; id?: string; fields?: Record<string, unknown> };
export type UpdateInput = { table: TableName; id: string; fields: Record<string, unknown> };
export type RecordInput = { table: TableName; id: string };
export type ResolveInput = { table: TableName; id: string; field: string; value: unknown };

const existing = (tx: Tx, table: TableName, id: string) => {
  const row = tx.get(table, id);
  if (!row) tx.fail(`${table}/${id} does not exist`);
  return row!;
};

/** Creates a record and returns its id: the given one, or a new random one. Fails if the id is taken, even by a deleted record. */
export const create: CommandDef<CreateInput, string> = {
  name: "records.create",
  handler(tx, { table, id = tx.newId(), fields = {} }) {
    if (tx.get(table, id)) tx.fail(`${table}/${id} already exists`);
    tx.put(table, id, fields as any);
    // A record with no fields has no keys, so mark it live to make it exist.
    if (Object.keys(fields).length === 0) tx.restore(table, id);
    return id;
  },
};

/** Sets the given fields on an existing record. */
export const update: CommandDef<UpdateInput, void> = {
  name: "records.update",
  handler(tx, { table, id, fields }) {
    existing(tx, table, id);
    tx.put(table, id, fields as any);
  },
};

/** Marks an existing record deleted. */
export const remove: CommandDef<RecordInput, void> = {
  name: "records.remove",
  handler(tx, { table, id }) {
    existing(tx, table, id);
    tx.remove(table, id);
  },
};

/** Brings back a deleted record. */
export const restore: CommandDef<RecordInput, void> = {
  name: "records.restore",
  handler(tx, { table, id }) {
    existing(tx, table, id);
    tx.restore(table, id);
  },
};

/** Settles an ask field to one value, which clears its conflict on every device once synced. */
export const resolve: CommandDef<ResolveInput, void> = {
  name: "records.resolve",
  handler(tx, { table, id, field, value }) {
    existing(tx, table, id);
    tx.resolve(table, id, field, value);
  },
};

export const builtins: readonly CommandDef[] = [create, update, remove, restore, resolve];
