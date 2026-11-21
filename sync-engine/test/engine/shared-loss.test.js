// Documents what the plain shared-file pattern loses (for the harness author).
// Two devices have separate views of the synced folder (two memfolders). Both
// read a stale (empty) table.ywb and write; the sync service keeps only one of
// the two writes (here: sam's overwrites harry's everywhere).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";
import { createMemFolder } from "../helpers/memfolder.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const FILE = "data/notes/table.ywb";

async function concurrentSaves() {
  const w = await makeWorld({ options: { layout: "shared-file" } });
  const viewA = w.folder;
  const viewB = createMemFolder({ clock: w.clock });
  const a = await w.device(A, { root: viewA.root });
  const b = await w.device(S, { root: viewB.root });
  a.table("notes").getMap("m").set("fromHarry", 1);
  b.table("notes").getMap("m").set("fromSam", 2);
  await a.flush(); // both saves read the file before the other's write arrives
  await b.flush();
  viewA.drop(FILE, viewB.read(FILE)); // the service keeps only sam's write
  return { w, viewA, a, b };
}

test("shared-file: two saves on stale reads, one survives; the folder lacks the other change", async () => {
  const { w, viewA, a, b } = await concurrentSaves();
  const late = await w.device("kim-cccccccc", { root: viewA.root });
  assert.deepEqual(json(late), { m: { fromSam: 2 } }, "a new device never sees harry's change");
  assert.equal(a.status().pending, 0, "harry believes it is saved");
  assert.deepEqual(json(a).m, { fromHarry: 1 }, "harry still has it locally until it rescans");
  assert.deepEqual(json(b).m, { fromSam: 2 });
});

test("shared-file: the lost change comes back on harry's next save, but not if harry's store is wiped first", async () => {
  const { w, viewA, a } = await concurrentSaves();
  await a.scan(); // harry now also holds sam's change
  assert.deepEqual(json(a).m, { fromHarry: 1, fromSam: 2 });
  a.table("notes").getMap("m").set("later", 3);
  await a.flush(); // snapshot of the whole doc re-publishes harry's change
  assert.deepEqual(json(await w.device("kim-cccccccc", { root: viewA.root })).m, { fromHarry: 1, fromSam: 2, later: 3 });

  const lost = await concurrentSaves();
  lost.w.store(A).wipe(); // wiped before harry ever saves again
  const again = await lost.w.device(A, { root: lost.viewA.root });
  assert.deepEqual(json(again), { m: { fromSam: 2 } }, "harry's change is gone for good");
});
