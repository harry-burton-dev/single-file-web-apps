// Row views (spec S2, Deliver 3): rows keep their identity when unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createView } from "../view.ts";
import { toRow } from "../schema.ts";
import { makeDataWorld, notesApp } from "./_world.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function oneDevice() {
  const world = await makeDataWorld(notesApp);
  const { engine, registry } = await world.open("harry-aaaaaaaa");
  const table = registry.table("notes");
  return { world, engine, table, view: createView(table) };
}

test("a view holds every row, deleted ones included, as flat rows sorted by id", async () => {
  const { table, view } = await oneDevice();
  table.put("b", { title: "B", room: "x", body: "hello" });
  table.put("a", { title: "A" });
  table.remove("a");
  assert.deepEqual(view.rows(), [
    { id: "a", _deleted: true, _conflicts: {}, title: "A" },
    { id: "b", _deleted: false, _conflicts: {}, title: "B", room: "x", body: "hello" },
  ]);
  assert.equal(view.byId("b"), view.rows()[1]);
  assert.equal(view.byId("zzz"), undefined);
});

test("unchanged rows keep identity", async () => {
  const { table, view } = await oneDevice();
  table.put("a", { title: "A" });
  table.put("b", { title: "B" });
  const [a1, b1] = view.rows();
  table.put("b", { title: "B2" });
  const [a2, b2] = view.rows();
  assert.equal(a2, a1, "a did not change");
  assert.notEqual(b2, b1, "b changed");
  assert.equal(b2.title, "B2");
  assert.equal(view.byId("a"), a1);
});

test("the rows array keeps identity when nothing changed", async () => {
  const { table, view } = await oneDevice();
  table.put("a", { title: "A", body: "x" });
  const first = view.rows();
  assert.equal(view.rows(), first, "repeat reads");
  table.put("a", { title: "A", body: "x" }); // a write that leaves the same values
  view.markDirty();
  assert.equal(view.rows(), first, "rebuilt, same content");
  table.put("a", { title: "changed" });
  assert.notEqual(view.rows(), first);
});

test("changes notify once, on a microtask; flush delivers it now", async () => {
  const { table, view } = await oneDevice();
  let calls = 0;
  const off = view.store.subscribe(() => calls++);
  table.batch(() => { table.put("a", { title: "A" }); table.put("b", { title: "B" }); });
  table.put("c", { title: "C" });
  assert.equal(calls, 0, "not synchronous");
  await tick();
  assert.equal(calls, 1, "coalesced");

  table.put("d", { title: "D" });
  view.flush();
  assert.equal(calls, 2, "flush notifies now");
  await tick();
  assert.equal(calls, 2, "and the microtask does not notify again");
  view.flush();
  assert.equal(calls, 2, "flush with nothing pending is silent");

  off();
  table.put("e", { title: "E" });
  await tick();
  assert.equal(calls, 2, "unsubscribed");
  assert.equal(view.store.getSnapshot(), view.rows());
});

test("remote changes reach the view; close stops it", async () => {
  const world = await makeDataWorld(notesApp);
  const a = await world.open("harry-aaaaaaaa");
  const b = await world.open("sam-bbbbbbbb");
  const viewB = createView(b.registry.table("notes"));
  let calls = 0;
  viewB.store.subscribe(() => calls++);
  a.registry.table("notes").put("n1", { title: "Hi" });
  await world.run([a.engine, b.engine], 30000);
  await tick();
  assert.ok(calls >= 1);
  assert.equal(viewB.byId("n1")?.title, "Hi");

  viewB.close();
  const before = calls;
  b.registry.table("notes").put("n2", { title: "x" });
  await tick();
  assert.equal(calls, before);
});

// Random puts, removes and restores on two devices with syncs between them.
const op = fc.record({
  device: fc.constantFrom(0, 1),
  kind: fc.constantFrom("put", "put", "put", "remove", "restore", "sync"),
  id: fc.constantFrom("r1", "r2", "r3", "r4"),
  title: fc.constantFrom("a", "b", "c"),
  room: fc.option(fc.constantFrom("x", "y"), { nil: undefined }),
});

test("a view equals a fresh list after random writes and syncs", async () => {
  await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
    const world = await makeDataWorld(notesApp);
    const devices = [await world.open("harry-aaaaaaaa"), await world.open("sam-bbbbbbbb")];
    const tables = devices.map((d) => d.registry.table("notes"));
    const views = tables.map((t) => createView(t));
    const prev = views.map((v) => v.rows());
    for (const { device, kind, id, title, room } of ops) {
      const t = tables[device];
      if (kind === "sync") {
        await world.run(devices.map((d) => d.engine), 15000);
      } else if (kind === "put") {
        t.put(id, room === undefined ? { title } : { title, room });
      } else if (t.get(id)) {
        if (kind === "remove") t.remove(id); else t.restore(id);
      }
      for (const i of [0, 1]) {
        const rows = views[i].rows();
        assert.deepEqual(rows, tables[i].list({ includeDeleted: true }).map(toRow));
        for (const row of rows) {
          const old = prev[i].find((r) => r.id === row.id);
          if (old && JSON.stringify(old) === JSON.stringify(row)) assert.equal(row, old, `unchanged ${row.id} keeps identity`);
        }
        prev[i] = rows;
      }
    }
  }), { numRuns: 15, seed: 22 });
});
