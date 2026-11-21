// Chunk numbering must survive the loss of every folder-side trace of our own
// files: the local store remembers the highest chunk number written (hw).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const ownDir = `data/notes/${A}`;
const names = (w) => w.folder.paths(`${ownDir}/`).map((p) => p.split("/").pop());

test("own chunks and status file gone from the folder: the local high-water mark keeps numbering above them", async () => {
  const w = await makeWorld();
  const b = await w.device(S);
  for (const k of ["a", "b", "c"]) {
    const e = await w.device(A);
    e.table("notes").getMap("m").set(k, 1);
    await w.run([e, b], 15000);
    await e.close();
  }
  assert.deepEqual(names(w), ["000001.ywb", "000002.ywb", "000003.ywb"]);
  for (const p of [...w.folder.paths(`${ownDir}/`), ...w.folder.paths("status/")]) w.folder.remove(p); // no listing, own status or peer status evidence
  const e = await w.device(A); // the same local store
  e.table("notes").getMap("m").set("fresh", 9);
  await w.run([e, b], 15000);
  assert.deepEqual(names(w).filter((n) => !n.startsWith("snap-")), ["000004.ywb"], "numbering continues above 3");
  assert.equal(names(w).filter((n) => n.startsWith("snap-")).length, 1, "the lost chunks are republished in one snapshot");
  assert.equal(json(b).m.fresh, 9, "the peer received the edit");
});
