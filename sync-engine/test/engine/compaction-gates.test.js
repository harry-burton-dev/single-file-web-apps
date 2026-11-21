// Conditions that must all hold before a device deletes its covered chunks:
// the snapshot is old enough (minSnapshotAgeMs), and no peer is unaccounted for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";
import { parseStamp } from "../../src/engine/layout-chunks.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const C = "kim-cccccccc";
const MIN_AGE = 120000;
const compact = (minSnapshotAgeMs) => ({ sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs, jitterMs: 0 } });
const snapNames = (w) => w.folder.paths(`data/notes/${A}/snap-`).map((p) => p.split("/").pop());
const edit = (a, i) => a.table("notes").getMap("m").set(`a${i}`, i);

test("an acknowledged snapshot younger than minSnapshotAgeMs deletes nothing; once old enough it does", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: compact(MIN_AGE) });
  const b = await w.device(B, { options: { compaction: { enabled: false } } });
  for (let i = 0; i < 8; i++) {
    edit(a, i);
    await w.run([a, b], 6000);
  }
  await w.run([a, b], 20000);
  assert.equal(snapNames(w).length, 1, "a wrote a snapshot");
  const snapMs = parseStamp(snapNames(w)[0].slice(5, 20));
  while (w.clock.now() - snapMs < MIN_AGE - 2000) {
    await w.run([a, b], 2000);
    assert.equal(w.folder.deletes.length, 0, `nothing deleted at snapshot age ${w.clock.now() - snapMs} ms`);
  }
  await w.run([a, b], 30000);
  assert.ok(w.folder.deletes.length > 0, "deleted once the snapshot is old enough");
  assert.ok(w.folder.deletes[0].at - snapMs >= MIN_AGE, "and not before");
});

// A device with no data of its own whose status file is truncated: nothing says
// it has acknowledged anything, so nothing may be deleted until it can be read.
test("a third device without data files whose status file is unreadable blocks deletion", async () => {
  const w = await makeWorld();
  const c = await w.device(C, { options: { compaction: { enabled: false } } });
  await w.run([c], 12000); // c writes its status file and no data
  assert.deepEqual(w.folder.paths("data/"), []);
  w.folder.copy(`status/${C}.ywb`, `status/${C}.ywb`, 20);
  const a = await w.device(A, { options: compact(10000) });
  for (let i = 0; i < 8; i++) {
    edit(a, i);
    await w.run([a], 6000);
  }
  await w.run([a], 60000);
  assert.equal(snapNames(w).length, 1, "a wrote a snapshot");
  assert.equal(w.folder.deletes.length, 0, "nothing deleted while c's status is unreadable");
  await w.run([a, c], 30000); // c rewrites its status and acknowledges
  assert.ok(w.folder.deletes.length > 0, "deleted once c's status is readable and acknowledges");
});
