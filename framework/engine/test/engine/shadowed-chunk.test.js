// A device that restarts at a low chunk number while a snapshot covering its
// old chunks (by number) is on its way: identity decides what is covered, and
// the republish that follows moves numbering above the covered range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { json } from "./_harness.js";
import { open } from "../../src/engine/envelope.js";
import { A, ownChunks, restartedBehindUnseenSnapshot } from "./_unseen-snapshot.js";

const MIN_AGE = 100000;

test("a chunk already written under a reused number is not deleted on the strength of an older snapshot that covers the number", async () => {
  const { w, a2, b } = await restartedBehindUnseenSnapshot({ compaction: { chunkThreshold: 5, minSnapshotAgeMs: MIN_AGE, jitterMs: 0 } });
  w.folder.clearListing();
  w.clock.advance(MIN_AGE + 50000); // b's snapshot is now old enough; whatever a republishes next is not
  await w.run([a2, b], 30000);
  assert.ok(ownChunks(w).includes("000001.ywb"), "the new chunk 1 is still there");
  assert.deepEqual(w.folder.deletes.filter((d) => d.path.startsWith(`data/notes/${A}/`)), [], "a deleted nothing of its own");
  const c = await w.device("kim-cccccccc");
  await w.run([c], 20000);
  assert.equal(json(c).m.fresh, 1, "a new device has the content of the reused chunk");
});

test("after a shadow republish the next save is visible to a brand-new device", async () => {
  const { w, a2, b } = await restartedBehindUnseenSnapshot();
  w.folder.clearListing();
  await w.run([a2, b], 60000); // a loads b's snapshot and republishes
  a2.table("notes").getMap("m").set("later", 2);
  await w.run([a2, b], 30000);
  const snaps = w.folder.paths(`data/notes/${A}/snap-`);
  assert.equal(snaps.length, 1, "the republish happened once, not on every scan");
  const covered = (await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(snaps[0]) })).meta.covers[A];
  const later = ownChunks(w).map((n) => Number(n.slice(0, 6))).filter((n) => n > 1);
  assert.ok(later.length > 0 && later.every((n) => n > covered), `chunks written after the republish (${later}) are numbered above the covered range (${covered})`);
  const c = await w.device("kim-cccccccc");
  await w.run([c], 30000);
  assert.equal(json(c).m.later, 2, "the new device has the later edit");
  assert.equal(json(c).m.fresh, 1);
  assert.equal(json(c).m.k5, 5, "and the history the snapshot covers");
  assert.deepEqual(json(c), json(a2));
});
