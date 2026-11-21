// Attacks 6-9: folder wiped / own chunk deleted / chunk replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, chunks } from "./_lib.js";

test("P06 folder wiped while B holds edits the folder never delivered; A reseeds; B's edits must reach A", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  m(a).set("a0", 1);
  await w.run([a, b], 15000);
  m(b).set("b-edit", 1);
  await w.run([b], 15000);   // B saved to its folder, A has not scanned
  w.folder.empty();          // OneDrive folder wiped / re-created
  await a.reseed();          // admin reseeds from A
  await w.run([a, b], 90000);
  console.log("P06 A", JSON.stringify(json(a).m), "B", JSON.stringify(json(b).m), "health B", b.health().state);
  const c = await w.device(C);
  await w.run([a, b, c], 40000);
  console.log("P06 C", JSON.stringify(json(c).m));
  assert.deepEqual(json(a).m, json(b).m, "A and B converge");
  assert.deepEqual(json(c).m, json(b).m, "new device C equals B");
});

test("P07 user deletes B's own sealed-but-unread chunk in Explorer; health must not claim saved/peers-ok and edit must not be lost for others", async () => {
  const w = await world();
  const a = await w.device(A, { options: { scanMs: 600000 } });
  const b = await w.device(B);
  m(b).set("b1", 1);
  await w.run([b], 15000);
  for (const p of w.folder.paths(`data/notes/${B}/`)) w.folder.remove?.(p);
  await w.run([b], 200000);
  const c = await w.device(C);
  await w.run([a, b, c], 60000);
  console.log("P07 B health", b.health().state, "C", JSON.stringify(json(c).m), "files", w.folder.paths("data/"));
  assert.equal(json(c).m?.b1, 1, "C never got B's edit even though B reports saved");
});

test("P08 chunk replaced in place by an older/different valid file (OneDrive version restore)", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  m(a).set("x", 1);
  await w.run([a, b], 12000);
  const old = w.folder.read(`data/notes/${A}/000001.ywb`);
  m(a).set("y", 2);
  await w.run([a, b], 12000);
  w.folder.drop(`data/notes/${A}/000001.ywb`, old); // restore old version
  await w.run([a, b], 30000);
  const c = await w.device(C);
  await w.run([a, b, c], 30000);
  console.log("P08 A/B/C", JSON.stringify(json(a).m), JSON.stringify(json(b).m), JSON.stringify(json(c).m));
  assert.deepEqual(json(c).m, { x: 1, y: 2 }, "C (new device) lost y because the only copy in the folder was rolled back");
});
