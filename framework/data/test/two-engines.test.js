// Spec S2 acceptance bullet 2: with two engines on one memory folder, a command run
// on one appears in the other's results. Store level; the hooks test (OUT-25) repeats
// it through a mounted component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { select } from "../select.ts";
import { createCommandRegistry } from "../commands.ts";
import { makeDataWorld, notesApp } from "./_world.js";

async function pair(commands) {
  const world = await makeDataWorld(notesApp);
  const a = await world.data("harry-aaaaaaaa", commands);
  const b = await world.data("sam-bbbbbbbb", commands);
  const sync = () => world.run([a.engine, b.engine], 30000);
  return { world, a, b, sync };
}

test("a command on one engine appears in the other's results", async () => {
  const { a, b, sync } = await pair();
  const created = a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  assert.equal(created.ok, true);
  assert.equal(select(b.data.view("notes").rows(), { where: { title: "Hi" } }).length, 0, "not there before the folder carries it");
  await sync();
  const found = select(b.data.view("notes").rows(), { where: { title: "Hi" } });
  assert.deepEqual(found.map((r) => r.id), ["n1"]);
});

test("the other engine's view notifies when the change arrives", async () => {
  const { a, b, sync } = await pair();
  let calls = 0;
  b.data.view("notes").store.subscribe(() => calls++);
  a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  await sync();
  assert.ok(calls >= 1, "B's subscribers hear about A's command");
  assert.equal(b.data.view("notes").byId("n1")?.title, "Hi");
});

test("a run notifies its own views before it returns", async () => {
  const { a } = await pair();
  let calls = 0;
  a.data.view("notes").store.subscribe(() => calls++);
  a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  assert.equal(calls, 1, "synchronous, not on a microtask");
  await Promise.resolve();
  assert.equal(calls, 1, "and only once");
});

test("updates, removes and restores travel both ways", async () => {
  const { a, b, sync } = await pair();
  a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  await sync();
  assert.equal(b.data.run("records.update", { table: "notes", id: "n1", fields: { title: "Hello" } }).ok, true);
  await sync();
  assert.equal(a.data.view("notes").byId("n1")?.title, "Hello");
  a.data.run("records.remove", { table: "notes", id: "n1" });
  await sync();
  assert.deepEqual(select(b.data.view("notes").rows()), [], "removed rows leave B's default results");
  b.data.run("records.restore", { table: "notes", id: "n1" });
  await sync();
  assert.deepEqual(select(a.data.view("notes").rows()).map((r) => r.id), ["n1"]);
});

test("an app command run on one engine appears on the other", async () => {
  const commands = createCommandRegistry();
  const rename = commands.define("notes.rename", (tx, { id, title }) => tx.put("notes", id, { title }));
  const { a, b, sync } = await pair(commands);
  a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  assert.equal(a.data.run(rename, { id: "n1", title: "Renamed" }).ok, true);
  await sync();
  assert.equal(b.data.view("notes").byId("n1")?.title, "Renamed");
  assert.deepEqual(a.data.commandLog().map((r) => r.name), ["records.create", "notes.rename"]);
  assert.deepEqual(b.data.commandLog(), [], "the log is per device; it does not sync");
});

test("data exposes the configured tables and rejects others", async () => {
  const { a } = await pair();
  assert.deepEqual(a.data.tables, ["notes", "tags"]);
  assert.throws(() => a.data.view("nope"), /unknown table/);
  assert.equal(a.data.run("records.create", { table: "nope", fields: {} }).ok, false);
});

test("close stops notifications", async () => {
  const { a, b, sync } = await pair();
  let calls = 0;
  b.data.view("notes").store.subscribe(() => calls++);
  b.data.conflicts.subscribe(() => calls++);
  b.data.close();
  a.data.run("records.create", { table: "notes", id: "n1", fields: { title: "Hi" } });
  await sync();
  assert.equal(calls, 0);
});
