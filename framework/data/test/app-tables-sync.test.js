// Every table the project declares in app/app.config.ts syncs between two users
// (OUT-31, from the cold start): a record one user creates, with a value in
// every field, reaches the other through the shared folder. It reads the
// definition, so a project's own tables are covered by its `npm test` without
// writing a test or naming a table here.
import { test } from "node:test";
import assert from "node:assert/strict";
import definition from "../../build/app-definition.js";
import { makeDataWorld } from "./_world.js";

/** A value of the field's declared type. */
function sample(def) {
  const kind = typeof def === "string" ? def : def.kind;
  const type = typeof def === "object" ? def.type : undefined;
  if (kind === "text") return "some text";
  if (type === "number") return 42;
  if (type === "boolean") return true;
  return "a value";
}

for (const [table, schema] of Object.entries(definition.tables)) {
  test(`table ${table}: a record one user creates reaches the other with every field`, async () => {
    const world = await makeDataWorld(definition);
    const a = await world.data("alice-aaaaaaaa");
    const b = await world.data("bob-bbbbbbbb");
    const fields = Object.fromEntries(Object.entries(schema.fields ?? {}).map(([field, def]) => [field, sample(def)]));
    const made = a.data.run("records.create", { table, id: "r1", fields });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(b.data.view(table).byId("r1"), undefined, "not there before the folder carries it");
    await world.run([a.engine, b.engine], 30000);
    const row = b.data.view(table).byId("r1");
    assert.ok(row, "the record reached the other user");
    for (const [field, value] of Object.entries(fields)) assert.equal(row[field], value, field);
  });
}
