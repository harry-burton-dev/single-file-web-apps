import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";
import { seal } from "../../src/engine/envelope.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const SLOW = { quietMs: 30000, maxWaitMs: 180000, minIntervalMs: 30000 };
const edit = (e, k, v = 1) => e.table("notes").getMap("m").set(k, v);

const nearestRank = (values, p) => [...values].sort((x, y) => x - y)[Math.ceil(p * values.length) - 1];

test("sync durations: last, average and p95 over the retained traces", async () => {
  const w = await makeWorld();
  let n = 0;
  const a = await w.device(A, { timer: { now: () => (n += 3) } });
  for (let i = 0; i < 5; i++) {
    edit(a, `k${i}`, i);
    await w.run([a], 4000);
  }
  for (const kind of ["save", "scan"]) {
    const durations = a.traces({ kind }).filter((t) => t.outcome !== "skipped").map((t) => t.durationMs);
    const m = a.metrics().sync[kind];
    assert.equal(m.count, durations.length);
    assert.equal(m.lastMs, durations[0]);
    assert.equal(m.avgMs, durations.reduce((x, y) => x + y, 0) / durations.length);
    assert.equal(m.p95Ms, nearestRank(durations, 0.95));
  }
  assert.equal(a.metrics().sync.save.count, 5);
});

test("metrics work with tracing off", async () => {
  const w = await makeWorld({ options: { trace: { level: "off" } } });
  let n = 0;
  const a = await w.device(A, { timer: { now: () => (n += 3) } });
  edit(a, "x");
  await w.run([a], 4000);
  assert.equal(a.traces().length, 0);
  assert.equal(a.metrics().sync.save.count, 1);
  assert.ok(a.metrics().sync.save.lastMs > 0);
  assert.ok(a.metrics().throughput.filesWritten >= 2);
});

test("backlog: pending count and bytes, age of the oldest, unreadable files", async () => {
  const w = await makeWorld({ options: SLOW });
  const a = await w.device(A);
  assert.deepEqual(a.metrics().backlog, { pendingCount: 0, pendingBytes: 0, oldestAgeMs: null, unreadableFiles: 0 });
  edit(a, "x", 1);
  w.clock.advance(5000);
  edit(a, "y", 2);
  w.clock.advance(7000);
  await a.settled();
  const b = a.metrics().backlog;
  assert.equal(b.pendingCount, 2);
  assert.ok(b.pendingBytes > 0);
  assert.equal(b.oldestAgeMs, 12000);
  w.folder.drop("data/notes/ghost-00000000/000001.ywb", new Uint8Array([1, 2, 3, 4]));
  await a.scan();
  assert.equal(a.metrics().backlog.unreadableFiles, 1);
  await a.flush();
  assert.deepEqual([a.metrics().backlog.pendingCount, a.metrics().backlog.oldestAgeMs], [0, null]);
});

test("retry state follows a failed save and its recovery", async () => {
  const w = await makeWorld({ options: { retryInitialMs: 20000 } });
  const a = await w.device(A);
  assert.deepEqual(a.metrics().retry, { backingOff: false, since: null, nextAttemptAt: null, failures: 0 });
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 3000);
  const t0 = a.traces({ kind: "save", outcome: "failed" })[0].startedAt;
  const r = a.metrics().retry;
  assert.deepEqual([r.backingOff, r.since, r.nextAttemptAt, r.failures], [true, t0, t0 + 20000, 1]);
  await w.run([a], 22000);
  assert.equal(a.metrics().retry.failures, 2);
  assert.equal(a.metrics().retry.since, t0, "since stays at the first failure of the streak");
  w.folder.clearFailures();
  await w.run([a], 50000);
  assert.deepEqual(a.metrics().retry, { backingOff: false, since: null, nextAttemptAt: null, failures: 0 });
});

test("throughput counts the files and bytes the engine read and wrote", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(B);
  edit(a, "x");
  await w.run([a, b], 20000);
  const m = a.metrics().throughput;
  const writes = w.folder.writes.filter((x) => x.path.includes(A));
  assert.equal(m.filesWritten, writes.length);
  assert.equal(m.bytesWritten, writes.reduce((n, x) => n + x.size, 0));
  assert.ok(m.filesRead >= 1 && m.bytesRead > 0, "read B's status file");
  assert.equal(m.filesDeleted, 0);
  const bm = b.metrics().throughput;
  assert.ok(bm.bytesRead >= writes.find((x) => x.path.includes("data/")).size, "B read A's chunk");
});

test("delivery lag: now minus the file's writtenAt, including any clock difference", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  edit(a, "x");
  await a.flush();
  w.clock.advance(7000);
  const b = await w.device(B);
  let d = b.metrics().deliveryLag;
  assert.deepEqual([d.count, d.lastMs, d.medianMs, d.p95Ms], [1, 7000, 7000, 7000]);
  edit(a, "y");
  await a.flush();
  w.clock.advance(1000);
  await b.scan();
  edit(a, "z");
  await a.flush();
  w.clock.advance(5000);
  await b.scan();
  d = b.metrics().deliveryLag;
  assert.equal(d.count, 3);
  assert.equal(d.lastMs, 5000);
  assert.equal(d.medianMs, 5000, "samples are 7000, 1000, 5000");
  assert.equal(d.p95Ms, 7000);
  assert.equal(a.metrics().deliveryLag.count, 0, "own files are not deliveries");
});

test("acknowledgement lag is per peer, null until a peer's status shows our chunk", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(B);
  await w.run([a, b], 3000);
  assert.equal(a.metrics().ackLag[B].lagMs, null, "we have written nothing yet");
  edit(a, "x");
  await w.run([a], 4000);
  assert.equal(a.metrics().ackLag[B].lagMs, null, "B has not acknowledged our chunk");
  assert.ok(a.metrics().ackLag[B].unackedForMs >= 0);
  await w.run([a, b], 15000);
  const acked = a.metrics().ackLag[B];
  assert.ok(acked.lastAckedAt > 0);
  assert.equal(acked.unackedForMs, null);
  w.clock.advance(5000);
  assert.equal(a.metrics().ackLag[B].lagMs, w.clock.now() - acked.lastAckedAt);
  assert.ok(a.metrics().ackLag[B].lagMs >= 5000);
});

test("conflict copies and digest mismatches the engine can see", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(B);
  edit(a, "x");
  await w.run([a, b], 20000);
  assert.deepEqual([a.metrics().conflicts.copiesSeen, a.metrics().conflicts.digestMismatches], [0, 0]);

  w.folder.copy(`data/notes/${A}/000001.ywb`, `data/notes/${A}/000001-HARRY-AAAAAAAA.ywb`);
  w.folder.copy(`status/${B}.ywb`, `status/${B}-COPY.ywb`);
  await a.scan();
  await a.scan();
  const c = a.metrics().conflicts;
  assert.equal(c.copiesSeen, 2, "each copy is counted once, however often it is listed");
  assert.deepEqual(c.copyPaths.sort(), [`data/notes/${A}/000001-HARRY-AAAAAAAA.ywb`, `status/${B}-COPY.ywb`].sort());

  // a third device that claims the same applied state with another digest
  const aStatus = a.status().devices[B].tables.notes;
  const forged = await seal({
    key: w.key, keyId: 1, iv: new Uint8Array(12).fill(5),
    meta: { kind: "status", user: "cy", device: "cy-cccccccc", appVersion: "dev", writtenAt: w.clock.now(), lastActiveAt: w.clock.now(), tables: { notes: { ...aStatus, digest: "f".repeat(64), pending: 0 } } },
    updates: [],
  });
  w.folder.drop("status/cy-cccccccc.ywb", forged);
  await a.scan();
  await a.scan();
  assert.equal(a.metrics().conflicts.digestMismatches, 1);
});

test("a device with unsaved edits is not a digest mismatch", async () => {
  const w = await makeWorld({ options: SLOW });
  const a = await w.device(A);
  const b = await w.device(B);
  edit(a, "x");
  edit(b, "y");
  await a.flush();
  await b.flush();
  await w.run([a, b], 65000, 5000);
  edit(b, "local-only");
  await w.run([b, a], 20000, 5000);
  assert.equal(b.metrics().backlog.pendingCount, 1);
  assert.equal(a.metrics().conflicts.digestMismatches, 0);
});

test("noteConflict feeds ask conflicts and overlap notices into the metrics", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  a.noteConflict({ type: "ask-opened", table: "notes", id: "r1", field: "owner" });
  a.noteConflict({ type: "ask-opened", table: "notes", id: "r2", field: "owner" });
  a.noteConflict({ type: "ask-resolved", table: "notes", id: "r1", field: "owner" });
  a.noteConflict({ type: "overlap", table: "notes", id: "r3", field: "title" });
  const c = a.metrics().conflicts;
  assert.deepEqual([c.askOpened, c.askResolved, c.askOpen, c.overlapNotices], [2, 1, 1, 1]);
  assert.throws(() => a.noteConflict({ type: "bogus" }), /unknown type/);
});

test("errors are counted by scope and by error name", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 30000);
  const e = a.metrics().errors;
  assert.ok(e.total >= 2);
  assert.equal(e.byScope.save, e.total);
  assert.equal(e.byName.NoModificationAllowedError, e.total);
  w.folder.failListing((p) => p === "status");
  await a.scan();
  assert.equal(a.metrics().errors.byScope.list, 1);
  assert.equal(a.metrics().errors.byName.NotReadableError, 1);
});
