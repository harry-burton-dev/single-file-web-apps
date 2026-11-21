// Attacks 3-5: clock skew effects on snapshot age, activity window and ack rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, DAY, snaps, chunks, readMeta } from "./_lib.js";

const opts = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0, snapshotMaxAgeMs: 7 * DAY } };

test("P03 a year-ahead clock stamps one snapshot; compaction by everyone else must not stall for a year", async () => {
  const w = await world({ options: opts });
  const a = await w.device(A, { offsetMs: 365 * DAY });
  const b = await w.device(B);
  for (let i = 0; i < 8; i++) { m(a).set(`k${i}`, i); await w.run([a, b], 6000); }
  await w.run([a, b], 30000);
  console.log("P03 A snapshot names", snaps(w, A));
  await a.close();
  w.offsets.set(A, 0);
  w.clock.advance(10 * DAY);
  for (let i = 0; i < 12; i++) { m(b).set(`b${i}`, i); await w.run([b], 6000); }
  await w.run([b], 60000);
  const total = chunks(w, B).length + chunks(w, A).length;
  console.log("P03 chunks", total, "B snaps", snaps(w, B), "A snaps", snaps(w, A));
  assert.ok(snaps(w, B).length >= 1, "B never wrote a snapshot although there are " + total + " chunks (threshold 5) and only a future-dated snapshot exists");
});

test("P04 a device with a clock far in the past is treated as inactive, so peers delete chunks it has not acknowledged", async () => {
  const w = await world({ options: opts });
  const a = await w.device(A);
  const b = await w.device(B, { offsetMs: -90 * DAY, options: { compaction: { enabled: false } } });
  // B reads/acks nothing for the snapshot: block B's scanning by never ticking it after its first status
  m(b).set("b0", 1);
  await w.run([a, b], 12000);
  for (let i = 0; i < 8; i++) { m(a).set(`a${i}`, i); await w.run([a], 6000); } // B is not ticked: alive but has not acknowledged anything
  await w.run([a], 120000);
  const bStatus = await readMeta(w, `status/${B}.ywb`);
  console.log("P04 B status ack list", bStatus.tables.notes.snapshots, "A chunks left", chunks(w, A), "A snaps", snaps(w, A));
  assert.ok(chunks(w, A).length > 3, "A deleted its covered chunks although active device B never acknowledged the snapshot (B's clock is 90 days behind)");
});

test("P05 device offline beyond the active window returns with unsent edits after peers compacted", async () => {
  const w = await world({ options: { ...opts, compaction: { ...opts.compaction, activeWindowMs: 30 * DAY } } });
  const a = await w.device(A);
  const b = await w.device(B);
  const c = await w.device(C);
  m(c).set("c0", 1);
  await w.run([a, b, c], 15000);
  await c.close();
  m(c) && 0;
  for (let i = 0; i < 12; i++) { m(a).set(`a${i}`, i); await w.run([a, b], 6000); }
  await w.run([a, b], 40 * DAY, 3 * 3600 * 1000);
  const c2 = await w.device(C);
  m(c2).set("c-offline-edit", 1);
  await w.run([a, b, c2], 120000);
  const want = json(a).m;
  assert.equal(want["c-offline-edit"], 1);
  assert.deepEqual(json(c2).m, want);
  assert.deepEqual(json(b).m, want);
  const d = await w.device("lee-dddddddd");
  await w.run([a, b, c2, d], 60000);
  assert.deepEqual(json(d).m, want);
});
