// Migrations in app.config.ts and the "older app" status (spec S5, part B; OUT-47).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner, createCommandRegistry } from "../commands.ts";
import { openRegistry } from "../registry.ts";
import { assertAppDefinition, OLDER_APP_MESSAGE } from "../../runtime/definition.ts";
import { openTable } from "../../engine/src/records/index.js";
import { makeDataWorld, notesApp } from "./_world.js";

const withNotes = (notes, migrations) => ({ ...notesApp, tables: { ...notesApp.tables, notes: { ...notesApp.tables.notes, ...notes } }, ...(migrations && { migrations }) });

test("the older-app message is the spec's wording", () => {
  assert.equal(OLDER_APP_MESSAGE, "this app is older than the data; load the new version");
});

test("a definition with a bad migration is refused at start", async () => {
  const step = (fields) => fields;
  const bad = [
    [{ other: { 1: step } }, /other.*not declared/],
    [{ notes: { 2: step } }, /notes.*version 2.*below/], // notes is at version 2 here: a step from 2 would go to 3
    [{ notes: { 3: step } }, /notes.*version 3.*below/],
    [{ notes: { 0: step } }, /notes.*version 0/],
    [{ notes: { "1.5": step } }, /notes.*version 1\.5/],
    [{ notes: { 1: "not a function" } }, /notes.*function/],
    [{ notes: [] }, /notes.*object/],
    ["nope", /migrations.*object/],
  ];
  for (const [migrations, message] of bad) {
    const def = withNotes({ version: 2 }, migrations);
    assert.throws(() => assertAppDefinition(def), message, JSON.stringify(migrations));
    const world = await makeDataWorld(def);
    await assert.rejects(world.open("harry-aaaaaaaa"), message, `openRegistry refuses ${JSON.stringify(migrations)}`);
  }
  assert.doesNotThrow(() => assertAppDefinition(withNotes({ version: 2 }, { notes: { 1: step } })));
  assert.doesNotThrow(() => assertAppDefinition(withNotes({ version: 3 }, { notes: { 1: step, 2: step }, tags: { 1: step } })));
  assert.doesNotThrow(() => assertAppDefinition(notesApp), "migrations are optional");
});

test("each table reports whether it is writable, with its stored and supported versions", async () => {
  const world = await makeDataWorld(notesApp);
  const { engine, registry } = await world.open("harry-aaaaaaaa");
  const who = { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random };
  assert.deepEqual(registry.status("notes"), { writable: true, storedVersion: undefined, supportedVersion: 1 });
  openRegistry(engine, withNotes({ version: 4 }), who).table("notes").put("n1", { title: "v4" });
  registry.table("tags").put("t1", { label: "x" });
  assert.deepEqual(registry.status("notes"), { writable: false, storedVersion: 4, supportedVersion: 1, message: OLDER_APP_MESSAGE });
  assert.deepEqual(registry.status("tags"), { writable: true, storedVersion: 2, supportedVersion: 2 });
  assert.throws(() => registry.status("other"), /unknown table/);
});

test("with one table written at a higher version, commands on it fail with the message and the rest works", async () => {
  const world = await makeDataWorld(notesApp);
  const { engine, registry } = await world.open("harry-aaaaaaaa");
  const who = { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random };
  openRegistry(engine, withNotes({ version: 3 }), who).table("notes").put("n1", { title: "from v3" });
  const runner = createRunner({ registry, who, commands: createCommandRegistry() });

  const blocked = runner.run("records.update", { table: "notes", id: "n1", fields: { title: "from v1" } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "schema-too-new");
  assert.ok(blocked.error.includes(OLDER_APP_MESSAGE), blocked.error);
  assert.equal(registry.table("notes").get("n1").fields.title, "from v3", "nothing was written");

  const other = runner.run("records.create", { table: "tags", id: "t1", fields: { label: "a" } });
  assert.equal(other.ok, true, "the other table still takes commands");

  assert.equal(registry.table("notes").get("n1").fields.title, "from v3", "the newer table still reads");
  assert.equal(registry.table("tags").get("t1").fields.label, "a", "the other table reads");
});

test("a record written at version 1 and updated by a command at version 2 is stored migrated", async () => {
  const v1 = { ...notesApp, tables: { notes: { version: 1, fields: { title: "latest" } } } };
  const v2 = {
    ...notesApp,
    tables: { notes: { version: 2, fields: { title: "latest", status: { kind: "latest", type: "string" } } } },
    migrations: { notes: { 1: (record) => ({ status: "open", ...record }) } },
  };
  const world = await makeDataWorld(v1);
  const { engine, registry: old } = await world.open("harry-aaaaaaaa");
  const who = { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random };
  old.table("notes").put("n1", { title: "Hi" });

  const registry = openRegistry(engine, v2, who);
  assert.deepEqual(registry.table("notes").get("n1").fields, { status: "open", title: "Hi" }, "the migration runs on read");
  const runner = createRunner({ registry, who, commands: createCommandRegistry() });
  assert.equal(runner.run("records.update", { table: "notes", id: "n1", fields: { title: "Hello" } }).ok, true);

  // Read back with no migrations: only what is stored.
  const raw = openTable({ doc: engine.table("notes"), schema: { version: 2, fields: { title: "latest", status: "latest" } }, deviceId: "x", user: "x", clock: world.clock });
  assert.deepEqual(raw.get("n1").fields, { status: "open", title: "Hello" });
});
