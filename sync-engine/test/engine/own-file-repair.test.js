// A device's own files can vanish from the shared folder (deleted in Explorer,
// folder wiped) or be replaced by an older version (OneDrive version restore).
// The device that wrote them is the only one sure to hold their content, so it
// puts it back: the open chunk is rewritten, anything else is republished in
// one snapshot. Health does not say "saved" while that is still owed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const C = "kim-cccccccc";
const set = (e, k, v) => e.table("notes").getMap("m").set(k, v);
const own = (w, id) => w.folder.paths(`data/notes/${id}/`);
const snaps = (w, id) => w.folder.paths(`data/notes/${id}/snap-`);
const writesTo = (w, id) => w.folder.writes.filter((x) => x.path.startsWith(`data/notes/${id}/`)).length;

async function freshReader(w, others) {
  const c = await w.device(C);
  await w.run([...others, c], 10000);
  return json(c).m;
}

test("a deleted open chunk is rewritten from memory", async () => {
  const w = await makeWorld();
  const b = await w.device(B);
  set(b, "b1", 1);
  await w.run([b], 15000);
  for (const p of own(w, B)) w.folder.remove(p);

  await w.run([b], 5000);

  assert.deepEqual(own(w, B), [`data/notes/${B}/000001.ywb`]);
  assert.deepEqual(await freshReader(w, [b]), { b1: 1 });
  assert.equal(b.health().state, "saved");
});

test("a deleted sealed chunk is republished in one snapshot, once", async () => {
  const w = await makeWorld({ options: { sealBytes: 1 } });
  const b = await w.device(B);
  for (const k of ["k1", "k2", "k3"]) {
    set(b, k, 1);
    await w.run([b], 12000);
  }
  w.folder.remove(`data/notes/${B}/000002.ywb`);

  await w.run([b], 5000);
  assert.equal(snaps(w, B).length, 1);
  const before = writesTo(w, B);
  await w.run([b], 60000);

  assert.equal(writesTo(w, B), before, "no further writes once republished");
  assert.deepEqual(await freshReader(w, [b]), { k1: 1, k2: 1, k3: 1 });
});

test("an open chunk rolled back to an older version is rewritten", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  set(a, "x", 1);
  await w.run([a], 12000);
  const old = w.folder.read(`data/notes/${A}/000001.ywb`);
  set(a, "y", 2);
  await w.run([a], 12000);
  w.folder.drop(`data/notes/${A}/000001.ywb`, old);

  await w.run([a], 5000);

  assert.deepEqual(await freshReader(w, [a]), { x: 1, y: 2 });
});

test("a sealed chunk replaced by other content is noticed within ownCheckMs and republished", async () => {
  const w = await makeWorld({ options: { sealBytes: 1, ownCheckMs: 20000 } });
  const a = await w.device(A);
  for (const k of ["k1", "k2", "k3"]) {
    set(a, k, 1);
    await w.run([a], 12000);
  }
  w.folder.copy(`data/notes/${A}/000001.ywb`, `data/notes/${A}/000002.ywb`); // k2's chunk now holds k1 only

  await w.run([a], 25000);

  assert.equal(snaps(w, A).length, 1);
  assert.deepEqual(await freshReader(w, [a]), { k1: 1, k2: 1, k3: 1 });
});

test("a rollback that happened while the device was closed is republished after restart", async () => {
  const w = await makeWorld();
  let a = await w.device(A);
  set(a, "x", 1);
  await w.run([a], 12000);
  const old = w.folder.read(`data/notes/${A}/000001.ywb`);
  set(a, "y", 2);
  await w.run([a], 12000);
  await a.close();
  w.folder.drop(`data/notes/${A}/000001.ywb`, old);

  a = await w.device(A);
  await w.run([a], 5000);

  assert.deepEqual(await freshReader(w, [a]), { x: 1, y: 2 });
});

test("health does not say saved while a lost file could not be put back", async () => {
  const w = await makeWorld();
  const b = await w.device(B);
  b.on("error", () => {});
  set(b, "b1", 1);
  await w.run([b], 15000);
  w.folder.remove(`data/notes/${B}/000001.ywb`);
  w.folder.failWrites((p) => p.startsWith("data/"));

  await w.run([b], 5000);
  assert.notEqual(b.health().state, "saved");

  w.folder.clearFailures();
  await w.run([b], 400000);
  assert.equal(b.health().state, "saved");
  assert.deepEqual(await freshReader(w, [b]), { b1: 1 });
});

test("a listing that hides the own folder does not trigger a rewrite", async () => {
  const w = await makeWorld({ options: { sealBytes: 1 } });
  const b = await w.device(B);
  for (const k of ["k1", "k2"]) {
    set(b, k, 1);
    await w.run([b], 12000);
  }
  const before = writesTo(w, B);
  w.folder.hideListing((p) => p === `data/notes/${B}`);

  await w.run([b], 30000);
  w.folder.clearListing();
  await w.run([b], 30000);

  assert.equal(writesTo(w, B), before);
});

test("two profiles sharing a deviceId do not rewrite each other's chunk forever", async () => {
  const w = await makeWorld();
  const p1 = await w.device(A, { store: w.store("p1") });
  const p2 = await w.device(A, { store: w.store("p2") });
  set(p1, "p1", 1);
  set(p2, "p2", 2);
  await w.run([p1, p2], 30000);
  const before = writesTo(w, A);

  await w.run([p1, p2], 120000);

  assert.ok(writesTo(w, A) - before <= 4, `${writesTo(w, A) - before} writes in two idle minutes`);
});
