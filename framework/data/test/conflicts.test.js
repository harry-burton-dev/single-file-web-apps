// The open-conflict list, read on one device after a concurrent ask edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createView } from "../view.ts";
import { createConflictStore } from "../conflicts.ts";
import { makeDataWorld, notesApp } from "./_world.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function conflicted() {
  const world = await makeDataWorld(notesApp);
  const a = await world.open("harry-aaaaaaaa");
  const b = await world.open("sam-bbbbbbbb");
  a.registry.table("notes").put("n1", { title: "Hi" });
  await world.run([a.engine, b.engine], 30000);
  world.clock.advance(10);
  a.registry.table("notes").put("n1", { room: "Alpha" });
  world.clock.advance(10);
  b.registry.table("notes").put("n1", { room: "Beta" });
  await world.run([a.engine, b.engine], 30000);
  const views = new Map(a.registry.names.map((name) => [name, createView(a.registry.table(name))]));
  return { world, a, b, views };
}

test("a concurrent ask edit is one open conflict with both candidates", async () => {
  const { a, views } = await conflicted();
  const store = createConflictStore(views, a.engine);
  const list = store.getSnapshot();
  assert.equal(list.length, 1);
  const [c] = list;
  assert.deepEqual({ table: c.table, id: c.id, field: c.field, value: c.value }, { table: "notes", id: "n1", field: "room", value: "Beta" });
  assert.deepEqual(c.candidates.map((x) => x.value), ["Alpha", "Beta"]);
  assert.equal(a.engine.metrics().conflicts.askOpen, 1, "the engine's askOpen metric is live");
});

test("the list keeps identity across unrelated changes and empties on resolve", async () => {
  const { a, views } = await conflicted();
  const store = createConflictStore(views, a.engine);
  const first = store.getSnapshot();
  let calls = 0;
  store.subscribe(() => calls++);

  a.registry.table("notes").put("n1", { title: "other field" });
  a.registry.table("tags").put("t1", { label: "x" });
  await tick();
  assert.equal(calls, 0, "no notification when the list is unchanged");
  assert.equal(store.getSnapshot(), first);

  a.registry.table("notes").put("n1", { room: "Alpha" }); // a write to an ask field resolves it
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(store.getSnapshot(), []);
  const m = a.engine.metrics().conflicts;
  assert.deepEqual([m.askOpen, m.askOpened, m.askResolved], [0, 1, 1]);
  store.close();
});

test("conflicts on deleted records are not listed; sorted by table, id and field", async () => {
  const { a, views } = await conflicted();
  a.registry.table("notes").remove("n1");
  const store = createConflictStore(views);
  assert.deepEqual(store.getSnapshot(), []);
  a.registry.table("notes").restore("n1");
  await tick();
  assert.deepEqual(store.getSnapshot().map((c) => `${c.table}/${c.id}/${c.field}`), ["notes/n1/room"]);
});
