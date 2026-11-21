// The table registry (spec S2, Deliver 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRegistry } from "../registry.ts";
import { toRecordSchema, checkValue, toRow } from "../schema.ts";
import { assertAppDefinition } from "../../runtime/definition.ts";
import { makeDataWorld, notesApp } from "./_world.js";

test("opens every configured table with its schema", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  assert.deepEqual([...registry.names], ["notes", "tags"]);
  assert.equal(registry.has("notes"), true);
  assert.equal(registry.has("other"), false);
  assert.equal(registry.def("tags"), notesApp.tables.tags);
  for (const name of registry.names) {
    const table = registry.table(name);
    assert.equal(table.schemaVersion(), undefined, `${name} has no stored version before a write`);
    table.put("r1", name === "notes" ? { title: "Hi", room: "A", body: "text" } : { label: "x", owner: "me", note: "n" });
    assert.equal(table.schemaVersion(), notesApp.tables[name].version, `${name} stores its version on first write`);
  }
});

test("each field is opened with its declared kind", async () => {
  const world = await makeDataWorld(notesApp);
  const a = await world.open("harry-aaaaaaaa");
  const b = await world.open("sam-bbbbbbbb");
  for (const [name, fields] of [["notes", ["title", "room"]], ["tags", ["label", "owner"]]]) {
    a.registry.table(name).put("r1", { [fields[0]]: "a", [fields[1]]: "a" });
    b.registry.table(name).put("r1", { [fields[0]]: "b", [fields[1]]: "b" });
  }
  await world.run([a.engine, b.engine], 30000);
  for (const [name, latest, ask, text] of [["notes", "title", "room", "body"], ["tags", "label", "owner", "note"]]) {
    const table = a.registry.table(name);
    assert.equal(table.field("r1", latest).conflict, null, `${name}.${latest} is latest-wins`);
    assert.equal(table.field("r1", ask).conflict?.length, 2, `${name}.${ask} keeps both candidates`);
    assert.throws(() => table.updateText("r1", latest, "x"), /not a text field/);
    assert.doesNotThrow(() => table.updateText("r1", text, "x"), `${name}.${text} is text`);
  }
});

test("unknown tables in the folder are left alone", async () => {
  const world = await makeDataWorld(notesApp);
  const stray = { "data/other/sam-bbbbbbbb/000001.ywb": [1, 2, 3], "data/other/sam-bbbbbbbb/status.json": [4, 5] };
  for (const [path, bytes] of Object.entries(stray)) world.folder.drop(path, Uint8Array.from(bytes));
  const { engine, registry } = await world.open("harry-aaaaaaaa");
  registry.table("notes").put("n1", { title: "Hi" });
  await world.run([engine], 30000);
  await engine.flush();
  assert.ok(world.folder.paths("data/notes/").length > 0, "the configured table was written");
  assert.deepEqual(world.folder.paths("data/other/"), Object.keys(stray).sort());
  for (const [path, bytes] of Object.entries(stray)) assert.deepEqual([...world.folder.read(path)], bytes);
  assert.deepEqual(world.folder.deletes.filter((d) => d.path.startsWith("data/other/")), []);
  assert.throws(() => registry.table("other"), /unknown table/);
});

test("tables: {} gives an empty registry", async () => {
  const world = await makeDataWorld({ id: "empty", name: "Empty", tables: {} });
  const { registry } = await world.open("harry-aaaaaaaa");
  assert.deepEqual([...registry.names], []);
});

test("openRegistry refuses an invalid definition", () => {
  const engine = { table: () => assert.fail("no table is opened") };
  const who = { deviceId: "harry-aaaaaaaa", user: "harry", clock: { now: () => 0 }, random: { bytes: (n) => new Uint8Array(n) } };
  assert.throws(() => openRegistry(engine, { id: "x", name: "X", tables: { notes: { version: 1, fields: { id: "latest" } } } }, who));
});

test("assertAppDefinition checks table and field names and field definitions", () => {
  const app = (tables) => ({ id: "acme", name: "Acme", tables });
  const bad = [
    { "bad name": { version: 1 } },
    { "-notes": { version: 1 } },
    { notes: { version: 0 } },
    { notes: { version: 1.5 } },
    { notes: {} },
    ...["id", "deleted", "_x", "1st", "a b", "a\u001fb", ""].map((field) => ({ notes: { version: 1, fields: { [field]: "latest" } } })),
    ...["lww", { kind: "latest" }, { kind: "ask", type: "date" }, { kind: "text", type: "string" }, null].map((def) => ({ notes: { version: 1, fields: { title: def } } })),
  ];
  for (const tables of bad) assert.throws(() => assertAppDefinition(app(tables)), undefined, JSON.stringify(tables));
  assert.doesNotThrow(() => assertAppDefinition(notesApp));
  assert.doesNotThrow(() => assertAppDefinition(app({ "Notes-2": { version: 3, fields: { a_b: "ask", c: { kind: "ask", type: "boolean" } } } })));
});

test("toRecordSchema gives the record layer each field's kind", () => {
  assert.deepEqual(toRecordSchema(notesApp.tables.notes), { version: 1, fields: { title: "latest", room: "ask", body: "text" } });
  assert.deepEqual(toRecordSchema(notesApp.tables.tags), { version: 2, fields: { label: "latest", owner: "ask", note: "text" } });
  assert.deepEqual(toRecordSchema({ version: 4 }), { version: 4, fields: {} });
});

test("checkValue accepts the declared type and explains a mismatch", () => {
  const ok = [
    [{ kind: "latest", type: "string" }, "a"], [{ kind: "ask", type: "number" }, 0], [{ kind: "latest", type: "boolean" }, false],
    [{ kind: "text" }, ""], ["text", "x"], ["latest", { any: 1 }], ["ask", null],
  ];
  for (const [def, value] of ok) assert.equal(checkValue(def, value), null, `${JSON.stringify(def)} ${JSON.stringify(value)}`);
  assert.equal(checkValue({ kind: "latest", type: "number" }, "1"), "expected a number, got string");
  assert.equal(checkValue({ kind: "ask", type: "string" }, null), "expected a string, got null");
  assert.equal(checkValue("text", 3), "expected a string, got number");
  assert.equal(checkValue("latest", undefined), "value is undefined");
});

test("toRow flattens a stored record", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const table = registry.table("notes");
  table.put("n1", { title: "Hi", room: "A" });
  table.remove("n1");
  assert.deepEqual(toRow(table.get("n1")), { id: "n1", _deleted: true, _conflicts: {}, title: "Hi", room: "A" });
});
