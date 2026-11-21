// Commands and the built-ins (spec S2, Deliver 2 and the built-in half of acceptance bullet 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner, createCommandRegistry, commands, defineCommand } from "../commands.ts";
import { openRegistry } from "../registry.ts";
import { makeDataWorld, notesApp } from "./_world.js";

async function setup(deviceId = "harry-aaaaaaaa", world) {
  world ??= await makeDataWorld(notesApp);
  const { engine, registry } = await world.open(deviceId);
  const who = { deviceId, user: deviceId.split("-")[0], clock: world.clock, random: world.random };
  const registryOfCommands = createCommandRegistry();
  const runner = createRunner({ registry, who, commands: registryOfCommands });
  const updates = { notes: 0, tags: 0 };
  for (const name of registry.names) registry.table(name).onChange(() => updates[name]++);
  return { world, engine, registry, who, define: registryOfCommands.define, runner, run: runner.run, updates };
}

const state = (registry) => Object.fromEntries(registry.names.map((name) => [name, registry.table(name).list({ includeDeleted: true })]));

// --- built-ins -------------------------------------------------------------

test("records.create writes the fields and returns the id", async () => {
  const { run, registry } = await setup();
  const result = run("records.create", { table: "notes", id: "n1", fields: { title: "Hi", room: "A", body: "text" } });
  assert.equal(result.ok, true);
  assert.equal(result.value, "n1");
  assert.deepEqual(registry.table("notes").get("n1"), { id: "n1", deleted: false, fields: { body: "text", room: "A", title: "Hi" }, conflicts: {} });
});

test("records.create without an id makes a random one from the layer", async () => {
  const { run, registry } = await setup();
  const result = run("records.create", { table: "notes", fields: { title: "Hi" } });
  assert.equal(result.ok, true);
  assert.match(result.value, /^[0-9a-f]{16}$/);
  assert.equal(registry.table("notes").get(result.value).fields.title, "Hi");
});

test("records.create with no fields still creates the record", async () => {
  const { run, registry } = await setup();
  const result = run("records.create", { table: "tags", id: "t1" });
  assert.equal(result.ok, true);
  assert.deepEqual(registry.table("tags").get("t1"), { id: "t1", deleted: false, fields: {}, conflicts: {} });
});

test("records.create fails if the id is taken, even by a deleted record", async () => {
  const { run, registry } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  const taken = run("records.create", { table: "notes", id: "n1", fields: { title: "Other" } });
  assert.deepEqual(taken, { ok: false, code: "failed", error: "notes/n1 already exists" });
  run("records.remove", { table: "notes", id: "n1" });
  assert.equal(run("records.create", { table: "notes", id: "n1", fields: { title: "Other" } }).ok, false);
  assert.equal(registry.table("notes").get("n1").fields.title, "Hi");
});

test("records.update sets fields on an existing record", async () => {
  const { run, registry } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Hi", body: "one" } });
  const result = run("records.update", { table: "notes", id: "n1", fields: { title: "Hello", body: "one two" } });
  assert.equal(result.ok, true);
  assert.deepEqual(registry.table("notes").get("n1").fields, { body: "one two", title: "Hello" });
});

test("records.update of a missing record fails and writes nothing", async () => {
  const { run, registry, updates } = await setup();
  const result = run("records.update", { table: "notes", id: "nope", fields: { title: "x" } });
  assert.deepEqual(result, { ok: false, code: "failed", error: "notes/nope does not exist" });
  assert.equal(registry.table("notes").get("nope"), undefined);
  assert.equal(updates.notes, 0);
});

test("records.remove and records.restore flip the deleted flag", async () => {
  const { run, registry } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  assert.equal(run("records.remove", { table: "notes", id: "n1" }).ok, true);
  assert.equal(registry.table("notes").get("n1").deleted, true);
  assert.deepEqual(registry.table("notes").list(), []);
  assert.equal(run("records.restore", { table: "notes", id: "n1" }).ok, true);
  assert.equal(registry.table("notes").get("n1").deleted, false);
  assert.equal(registry.table("notes").get("n1").fields.title, "Hi");
});

test("records.remove and records.restore of a missing record fail", async () => {
  const { run } = await setup();
  assert.equal(run("records.remove", { table: "notes", id: "nope" }).code, "failed");
  assert.equal(run("records.restore", { table: "notes", id: "nope" }).code, "failed");
});

test("records.resolve settles an ask conflict on both devices", async () => {
  const world = await makeDataWorld(notesApp);
  const a = await setup("harry-aaaaaaaa", world);
  const b = await setup("sam-bbbbbbbb", world);
  a.run("records.create", { table: "notes", id: "n1", fields: { room: "A" } });
  await world.run([a.engine, b.engine], 30000);
  b.run("records.update", { table: "notes", id: "n1", fields: { room: "B" } });
  a.run("records.update", { table: "notes", id: "n1", fields: { room: "C" } });
  await world.run([a.engine, b.engine], 30000);
  assert.equal(a.registry.table("notes").get("n1").conflicts.room.length, 2, "the edit raced");
  const result = a.run("records.resolve", { table: "notes", id: "n1", field: "room", value: "B" });
  assert.equal(result.ok, true);
  await world.run([a.engine, b.engine], 30000);
  for (const side of [a, b]) assert.deepEqual(side.registry.table("notes").get("n1"), { id: "n1", deleted: false, fields: { room: "B" }, conflicts: {} });
});

test("records.resolve rejects a field that is not ask", async () => {
  const { run } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  const result = run("records.resolve", { table: "notes", id: "n1", field: "title", value: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid");
  assert.match(result.error, /not an ask field/);
});

// --- the layer (Deliver 2) -------------------------------------------------

test("a throwing handler writes nothing", async () => {
  const { run, define, registry, updates } = await setup();
  const boom = define("boom", (tx) => {
    tx.put("notes", "n1", { title: "Hi" });
    tx.put("tags", "t1", { label: "x" });
    throw new Error("halfway");
  });
  assert.deepEqual(run(boom, undefined), { ok: false, code: "failed", error: "halfway" });
  assert.deepEqual(state(registry), { notes: [], tags: [] });
  assert.deepEqual(updates, { notes: 0, tags: 0 });
});

test("tx.fail ends the run with the message and writes nothing", async () => {
  const { run, define, registry } = await setup();
  define("refuse", (tx) => { tx.put("notes", "n1", { title: "Hi" }); tx.fail("not today"); });
  assert.deepEqual(run("refuse"), { ok: false, code: "failed", error: "not today" });
  assert.deepEqual(state(registry), { notes: [], tags: [] });
});

test("an invalid change rejects the whole command", async () => {
  const cases = [
    [(tx) => tx.put("nope", "x", { a: 1 }), /unknown table: nope/],
    [(tx) => tx.put("notes", "", { title: "x" }), /record id/],
    [(tx) => tx.put("notes", "a\u001fb", { title: "x" }), /record id/],
    [(tx) => tx.put("notes", "n9", { colour: "red" }), /notes has no field colour/],
    [(tx) => tx.put("notes", "n9", { title: 3 }), /notes\.title: expected a string, got number/],
    [(tx) => tx.put("notes", "n9", { body: 3 }), /notes\.body: expected a string/],
    [(tx) => tx.put("notes", "n9", { title: undefined }), /value is undefined/],
    [(tx) => tx.put("notes", "n9", { toString: "x" }), /no field toString/],
    [(tx) => tx.resolve("notes", "n9", "room", 5), /expected a string/],
  ];
  for (const [i, [handler, error]] of cases.entries()) {
    const { run, define, registry, updates } = await setup();
    define("bad", (tx) => { tx.put("tags", "t1", { label: "fine" }); handler(tx); });
    const result = run("bad");
    assert.equal(result.ok, false, `case ${i}`);
    assert.equal(result.code, "invalid", `case ${i}`);
    assert.match(result.error, error, `case ${i}`);
    assert.deepEqual(state(registry), { notes: [], tags: [] }, `case ${i}: the valid change was not written either`);
    assert.deepEqual(updates, { notes: 0, tags: 0 }, `case ${i}`);
  }
});

test("put to a deleted record is rejected", async () => {
  const { run, define, registry } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  run("records.remove", { table: "notes", id: "n1" });
  define("write", (tx) => tx.put("notes", "n1", { title: "Back" }));
  const result = run("write");
  assert.equal(result.code, "invalid");
  assert.match(result.error, /notes\/n1 is deleted/);
  define("restoreThenWrite", (tx) => { tx.restore("notes", "n1"); tx.put("notes", "n1", { title: "Back" }); });
  assert.equal(run("restoreThenWrite").ok, true, "restoring first in the same command is fine");
  assert.equal(registry.table("notes").get("n1").fields.title, "Back");
  define("removeThenWrite", (tx) => { tx.remove("notes", "n1"); tx.put("notes", "n1", { title: "Gone" }); });
  assert.equal(run("removeThenWrite").code, "invalid", "removing earlier in the same command counts");
  assert.equal(registry.table("notes").get("n1").fields.title, "Back");
});

test("tx reads do not see own writes", async () => {
  const { run, define } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Old" } });
  const seen = [];
  define("look", (tx) => {
    tx.put("notes", "n1", { title: "New" });
    tx.put("notes", "n2", { title: "Two" });
    seen.push(tx.get("notes", "n1").title, tx.get("notes", "n2"), tx.list("notes").length);
  });
  assert.equal(run("look").ok, true);
  assert.deepEqual(seen, ["Old", undefined, 1]);
});

test("tx.list leaves out deleted rows unless asked", async () => {
  const { run, define } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "a" } });
  run("records.create", { table: "notes", id: "n2", fields: { title: "b" } });
  run("records.remove", { table: "notes", id: "n2" });
  let rows;
  define("look", (tx) => { rows = [tx.list("notes").map((r) => r.id), tx.list("notes", { includeDeleted: true }).map((r) => [r.id, r._deleted])]; });
  run("look");
  assert.deepEqual(rows, [["n1"], [["n1", false], ["n2", true]]]);
});

test("one update per table per command", async () => {
  const { run, define, registry, updates } = await setup();
  define("many", (tx) => {
    for (let i = 0; i < 5; i++) tx.put("notes", `n${i}`, { title: `t${i}`, room: "A", body: "x" });
    tx.put("tags", "t1", { label: "a" });
    tx.put("tags", "t2", { label: "b" });
    tx.remove("notes", "n0");
  });
  const result = run("many");
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 8);
  assert.deepEqual(updates, { notes: 1, tags: 1 });
  assert.equal(registry.table("notes").list().length, 4);
});

test("every run is logged with name and prior rows", async () => {
  const { run, runner, define, who } = await setup();
  run("records.create", { table: "notes", id: "n1", fields: { title: "Old" } });
  define("rename", (tx, { id, title }) => tx.put("notes", id, { title }));
  run("rename", { id: "n1", title: "New" });
  run("rename", { id: "n1", title: 5 });
  run("nope", {});
  const log = runner.log();
  assert.deepEqual(log.map((r) => [r.seq, r.name, r.ok, r.code]), [[1, "records.create", true, undefined], [2, "rename", true, undefined], [3, "rename", false, "invalid"], [4, "nope", false, "unknown-command"]]);
  for (const r of log) assert.deepEqual([r.user, r.device, r.at], [who.user, who.deviceId, who.clock.now()]);
  assert.deepEqual(log[0].before, [{ table: "notes", id: "n1", row: undefined }]);
  assert.deepEqual(log[1].input, { id: "n1", title: "New" });
  assert.deepEqual(log[1].changes, [{ op: "put", table: "notes", id: "n1", fields: { title: "New" } }]);
  assert.deepEqual(log[1].before, [{ table: "notes", id: "n1", row: { id: "n1", _deleted: false, _conflicts: {}, title: "Old" } }]);
  assert.match(log[2].error, /expected a string/);
});

test("the log keeps the last logLimit runs", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const runner = createRunner({ registry, who: { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random }, commands: createCommandRegistry(), logLimit: 3 });
  for (let i = 0; i < 5; i++) runner.run("records.create", { table: "tags", id: `t${i}` });
  assert.deepEqual(runner.log().map((r) => r.seq), [3, 4, 5]);
});

test("a newer stored schema gives schema-too-new and writes nothing", async () => {
  const { run, engine, registry, who, updates } = await setup();
  const newer = openRegistry(engine, { ...notesApp, tables: { ...notesApp.tables, notes: { ...notesApp.tables.notes, version: 5 } } }, who);
  newer.table("notes").put("n1", { title: "from v5" });
  updates.notes = 0;
  const result = run("records.create", { table: "notes", id: "n2", fields: { title: "x" } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema-too-new");
  assert.match(result.error, /version 5/);
  assert.equal(registry.table("notes").get("n2"), undefined);
  assert.equal(updates.notes, 0);
  const crossTable = run("records.create", { table: "tags", id: "t1", fields: { label: "a" } });
  assert.equal(crossTable.ok, true, "other tables still take writes");
});

test("a newer schema on one table blocks a command that touches two", async () => {
  const { run, define, engine, registry, who } = await setup();
  openRegistry(engine, { ...notesApp, tables: { ...notesApp.tables, notes: { ...notesApp.tables.notes, version: 5 } } }, who).table("notes").put("n1", { title: "v5" });
  define("both", (tx) => { tx.put("tags", "t1", { label: "a" }); tx.put("notes", "n2", { title: "b" }); });
  assert.equal(run("both").code, "schema-too-new");
  assert.equal(registry.table("tags").get("t1"), undefined);
});

test("ids and time come from the layer", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const bytes = [0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3];
  const who = { deviceId: "harry-aaaaaaaa", user: "harry", clock: { now: () => 1234 }, random: { bytes: (n) => Uint8Array.from(bytes.slice(0, n)) } };
  const runner = createRunner({ registry, who, commands: createCommandRegistry() });
  let seen;
  const def = { name: "look", handler: (tx) => { seen = { now: tx.now, user: tx.user, device: tx.device, id: tx.newId(), made: tx.id("entry", "item") }; } };
  assert.equal(runner.run(def).ok, true);
  assert.deepEqual(seen, { now: 1234, user: "harry", device: "harry-aaaaaaaa", id: "deadbeef00010203", made: "entry:item" });
  const result = runner.run("records.create", { table: "notes", fields: { room: "A" } });
  assert.equal(result.value, "deadbeef00010203");
  assert.equal(registry.table("notes").field(result.value, "room").value, "A");
  assert.equal(runner.log()[1].at, 1234);
});

test("a command returns its handler's value and the changes", async () => {
  const { run, define } = await setup();
  define("make", (tx, n) => { tx.put("tags", "t1", { label: String(n) }); return n * 2; });
  assert.deepEqual(run("make", 21), { ok: true, value: 42, changes: [{ op: "put", table: "tags", id: "t1", fields: { label: "21" } }] });
});

test("an unknown command fails without throwing", async () => {
  const { run } = await setup();
  assert.deepEqual(run("nope", {}), { ok: false, code: "unknown-command", error: "unknown command: nope" });
});

test("reading an unknown table fails the run", async () => {
  const { run, define } = await setup();
  define("peek", (tx) => tx.get("nope", "x"));
  assert.deepEqual(run("peek"), { ok: false, code: "failed", error: "unknown table: nope" });
});

test("the runner reads through the given row source", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const rows = [{ id: "n1", _deleted: false, _conflicts: {}, title: "from the view" }];
  const asked = [];
  const source = (table) => { asked.push(table); return { rows: () => (table === "notes" ? rows : []), byId: (id) => (table === "notes" ? rows.find((r) => r.id === id) : undefined) }; };
  const runner = createRunner({ registry, who: { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random }, commands: createCommandRegistry(), source });
  let seen;
  runner.run({ name: "look", handler: (tx) => { seen = [tx.get("notes", "n1").title, tx.list("notes").length, tx.get("notes", "n1").title]; } });
  assert.deepEqual(seen, ["from the view", 1, "from the view"]);
  assert.deepEqual(asked, ["notes"], "one snapshot per table per run");
  assert.equal(runner.run("records.update", { table: "notes", id: "n1", fields: { title: "x" } }).ok, true, "existence comes from the source");
});

// --- the registry of commands ---------------------------------------------

test("command names are unique and built-ins are reserved", () => {
  const registry = createCommandRegistry();
  const def = registry.define("notes.rename", () => {});
  assert.equal(registry.get("notes.rename"), def);
  assert.throws(() => registry.define("notes.rename", () => {}), /already defined/);
  assert.throws(() => registry.define("records.create", () => {}), /reserved/);
  assert.throws(() => registry.define("", () => {}), /non-empty/);
  assert.throws(() => registry.define("x", "nope"), /handler/);
  assert.deepEqual(registry.names(), ["records.create", "records.update", "records.remove", "records.restore", "records.resolve", "notes.rename"]);
  assert.equal(createCommandRegistry().get("notes.rename"), undefined, "registries are separate");
});

test("defineCommand adds to the app's default registry", async () => {
  const def = defineCommand("test.defaultRegistry", (tx) => tx.put("tags", "t1", { label: "via default" }));
  assert.equal(commands.get("test.defaultRegistry"), def);
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const runner = createRunner({ registry, who: { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random } });
  assert.equal(runner.run("test.defaultRegistry").ok, true);
  assert.equal(registry.table("tags").get("t1").fields.label, "via default");
});

test("onApplied hears the written tables once, before run returns", async () => {
  const world = await makeDataWorld(notesApp);
  const { registry } = await world.open("harry-aaaaaaaa");
  const calls = [];
  const runner = createRunner({ registry, who: { deviceId: "harry-aaaaaaaa", user: "harry", clock: world.clock, random: world.random }, commands: createCommandRegistry(), onApplied: (tables) => calls.push([...tables]) });
  runner.run({ name: "two", handler: (tx) => { tx.put("tags", "t1", { label: "a" }); tx.put("notes", "n1", { title: "b" }); tx.put("tags", "t2", { label: "c" }); } });
  assert.deepEqual(calls, [["tags", "notes"]]);
  runner.run("records.update", { table: "notes", id: "nope", fields: { title: "x" } });
  runner.run({ name: "nothing", handler: () => 1 });
  assert.deepEqual(calls, [["tags", "notes"]], "failed and empty runs are not reported");
});
