// Attack 1: a device's browser storage is restored from an old backup (local state goes backwards, folder files stay).
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, chunks } from "./_lib.js";
import { createMemoryStore } from "../../src/store/memory.js";

async function snapshotStore(store) {
  const copy = createMemoryStore();
  for (const k of await store.keys("")) await copy.set(k, structuredClone(await store.get(k)));
  return copy;
}

test("P01a restored backup of local store: later own edits survive and everyone converges", async () => {
  const w = await world();
  let a = await w.device(A);
  const b = await w.device(B);
  m(a).set("e1", 1);
  await w.run([a, b], 15000);
  const backup = await snapshotStore(w.store(A)); // taken after edit 1
  m(a).set("e2", 2);
  await w.run([a, b], 15000);
  m(a).set("e3", 3);
  await w.run([a, b], 15000);
  await a.close();
  w.stores.set(A, backup); // user restores the old backup
  a = await w.device(A);
  m(a).set("e4", 4);
  await w.run([a, b], 40000);
  const want = { e1: 1, e2: 2, e3: 3, e4: 4 };
  assert.deepEqual(json(a).m, want, "A after restore");
  assert.deepEqual(json(b).m, want, "B after restore");
  const c = await w.device(C);
  await w.run([a, b, c], 20000);
  assert.deepEqual(json(c).m, want, "new device");
});

test("P01b restored backup + compaction having deleted A's older chunks meanwhile", async () => {
  const w = await world({ options: { ...{} } });
  const opts = { sealBytes: 1, compaction: { chunkThreshold: 4, minSnapshotAgeMs: 10000, jitterMs: 0 } };
  let a = await w.device(A, { options: opts });
  const b = await w.device(B, { options: opts });
  m(a).set("e0", 0);
  await w.run([a, b], 8000);
  const backup = await snapshotStore(w.store(A));
  for (let i = 1; i < 14; i++) { m(a).set(`e${i}`, i); await w.run([a, b], 6000); }
  await w.run([a, b], 60000);
  await a.close();
  w.stores.set(A, backup);
  a = await w.device(A, { options: opts });
  m(a).set("late", 1);
  await w.run([a, b], 60000);
  const c = await w.device(C, { options: opts });
  await w.run([a, b, c], 30000);
  assert.deepEqual(json(a), json(b));
  assert.deepEqual(json(c), json(b));
  assert.equal(json(c).m.late, 1);
  for (let i = 0; i < 14; i++) assert.equal(json(c).m[`e${i}`], i, `e${i}`);
});

test("P01c restored backup, then A publishes a snapshot (reseed): new device must still get e2,e3", async () => {
  const w = await world();
  let a = await w.device(A);
  const b = await w.device(B);
  m(a).set("e1", 1);
  await w.run([a, b], 15000);
  const backup = await snapshotStore(w.store(A));
  m(a).set("e2", 2);
  await w.run([a, b], 15000);
  await a.close();
  w.stores.set(A, backup);
  a = await w.device(A);
  await w.run([a, b], 20000);
  await a.reseed();
  await w.run([a, b], 20000);
  const c = await w.device(C);
  await w.run([a, b, c], 30000);
  console.log("P01c state A/B/C:", JSON.stringify(json(a).m), JSON.stringify(json(b).m), JSON.stringify(json(c).m));
  assert.deepEqual(json(b).m, { e1: 1, e2: 2 }, "B");
  assert.deepEqual(json(a).m, { e1: 1, e2: 2 }, "A");
  assert.deepEqual(json(c).m, { e1: 1, e2: 2 }, "C (new device)");
});

test("P01d same as P01c, then compaction deletes: is e2 still in the folder for a brand-new device when B is wiped?", async () => {
  const opts = { compaction: { chunkThreshold: 1, minSnapshotAgeMs: 5000, jitterMs: 0, snapshotMaxAgeMs: 1000 } };
  const w = await world({ options: opts });
  let a = await w.device(A);
  const b = await w.device(B);
  m(a).set("e1", 1);
  await w.run([a, b], 15000);
  const backup = await snapshotStore(w.store(A));
  m(a).set("e2", 2);
  await w.run([a, b], 15000);
  await a.close();
  w.stores.set(A, backup);
  a = await w.device(A);
  await w.run([a, b], 120000); // compaction runs, snapshot acked, A deletes covered chunks
  const left = w.folder.paths(`data/notes/${A}/`);
  console.log("files after compaction:", left);
  // B loses its local store (browser cleared); the folder is now the only copy of e2
  await b.close();
  w.stores.delete(B);
  const b2 = await w.device(B);
  await w.run([a, b2], 40000);
  assert.deepEqual(json(b2).m, { e1: 1, e2: 2 }, "B rebuilt from folder");
});
