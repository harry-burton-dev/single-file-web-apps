// Bug 3: a device whose store was wiped, in a folder that was emptied apart
// from a snapshot it has not downloaded yet, restarts at chunk 1. The snapshot
// "covers" A's chunks 1..n by number (the old chunks), so readers skipped the
// new chunk 1 and A itself deleted it. Covering is now by identity: a snapshot
// lists the id (IV prefix) of every covered chunk, A deletes a chunk only when
// the acknowledged snapshot lists exactly that version, and a device that finds
// its own chunks shadowed by a snapshot republishes its content in a snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const COMPACT = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };
const ownChunks = (w) => w.folder.paths(`data/notes/${A}/`).filter((p) => /\/\d{6}\.ywb$/.test(p)).map((p) => p.split("/").pop());

async function emptiedFolderWithUnseenSnapshot() {
  const w = await makeWorld();
  const a = await w.device(A, { options: { sealBytes: 1 } });
  const b = await w.device(B, { options: COMPACT });
  for (let i = 0; i < 7; i++) {
    a.table("notes").getMap("m").set(`k${i}`, i);
    await w.run([a, b], 6000);
  }
  await w.run([a, b], 30000);
  assert.equal(w.folder.paths(`data/notes/${B}/snap-`).length, 1, "b wrote a snapshot");
  await a.close();
  for (const p of [...ownChunks(w).map((n) => `data/notes/${A}/${n}`), ...w.folder.paths("status/")]) w.folder.remove(p);
  w.store(A).wipe();
  w.folder.hideListing((p) => p === `data/notes/${B}`); // the snapshot has not reached A yet
  const a2 = await w.device(A, { options: { sealBytes: 1 } });
  a2.table("notes").getMap("m").set("fresh", 1);
  await w.run([a2], 15000);
  assert.deepEqual(ownChunks(w), ["000001.ywb"], "A restarted at chunk 1");
  w.folder.clearListing();
  return { w, a2, b };
}

test("new content in a reused chunk number is not skipped as covered by an older snapshot", async () => {
  const { w, a2, b } = await emptiedFolderWithUnseenSnapshot();
  await w.run([a2, b], 120000);
  const c = await w.device("kim-cccccccc");
  await w.run([c], 20000);
  assert.equal(json(c).m.fresh, 1, "a new device sees the content");
  assert.equal(json(b).m.fresh, 1, "so does b");
  assert.deepEqual(json(c), json(a2));
});

test("the writer never deletes a chunk the acknowledged snapshot does not list by identity", async () => {
  const { w, a2, b } = await emptiedFolderWithUnseenSnapshot();
  await w.run([a2, b], 120000);
  const d = await w.device("lee-dddddddd");
  await w.run([d], 20000);
  assert.equal(json(d).m.fresh, 1);
  assert.deepEqual(json(d), json(a2));
});
