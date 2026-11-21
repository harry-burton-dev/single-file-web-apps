// "Active" for the acknowledgement rule (ADR-0001 section 8) is judged by when
// this device last saw the peer's status file change, on this device's clock,
// not by the peer's own lastActiveAt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const DAY = 86400000;
const set = (e, k, v) => e.table("notes").getMap("m").set(k, v);
const chunkFiles = (w, id) => w.folder.paths(`data/notes/${id}/`).filter((p) => /\/\d{6}\.ywb$/.test(p));
const compactEagerly = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };

test("a live peer whose clock is 90 days behind still blocks deletion until it acknowledges", async () => {
  const w = await makeWorld({ options: compactEagerly });
  const behind = { now: () => w.clock.now() - 90 * DAY };
  const a = await w.device(A);
  const b = await w.device(S, { clock: behind, options: { compaction: { enabled: false } } });
  set(b, "b0", 1);
  await w.run([a, b], 12000); // sam writes a status file, then stops ticking: alive but silent on acknowledgements
  for (let i = 0; i < 8; i++) {
    set(a, `a${i}`, i);
    await w.run([a], 6000);
  }

  await w.run([a], 120000);

  assert.ok(chunkFiles(w, A).length > 3, "harry deleted chunks that sam never acknowledged");
});

test("a peer silent for the whole active window stops blocking deletion", async () => {
  const opts = { ...compactEagerly, compaction: { ...compactEagerly.compaction, activeWindowMs: 10 * DAY } };
  const w = await makeWorld({ options: opts });
  const a = await w.device(A);
  const b = await w.device(S);
  set(b, "b0", 1);
  await w.run([a, b], 12000);
  await b.close(); // sam is never heard from again
  for (let i = 0; i < 8; i++) {
    set(a, `a${i}`, i);
    await w.run([a], 6000);
  }

  await w.run([a], 12 * DAY, 3 * 3600 * 1000);

  assert.ok(chunkFiles(w, A).length <= 3, `harry still holds ${chunkFiles(w, A).length} chunks for a retired peer`);
});

test("the time a peer was last seen survives a restart, so restarting does not postpone retirement", async () => {
  const opts = { ...compactEagerly, compaction: { ...compactEagerly.compaction, activeWindowMs: 10 * DAY } };
  const w = await makeWorld({ options: opts });
  let a = await w.device(A);
  const b = await w.device(S);
  set(b, "b0", 1);
  await w.run([a, b], 12000);
  await b.close();
  for (let i = 0; i < 8; i++) {
    set(a, `a${i}`, i);
    await w.run([a], 6000);
  }
  for (let day = 0; day < 12; day++) {
    await a.close(); // harry restarts every day
    a = await w.device(A);
    await w.run([a], DAY, 3 * 3600 * 1000);
  }

  assert.ok(chunkFiles(w, A).length <= 3, `harry still holds ${chunkFiles(w, A).length} chunks for a retired peer`);
});
