import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const SLOW = { quietMs: 30000, maxWaitMs: 180000, minIntervalMs: 30000 };
const COMPACT = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };
const edit = (e, k, v = 1) => e.table("notes").getMap("m").set(k, v);
const kinds = (e, filter) => e.traces(filter).reverse();
const saves = (e) => kinds(e, { kind: "save" });

test("every kind of attempt produces a trace with the documented shape", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: COMPACT });
  const b = await w.device(B, { options: { compaction: { enabled: false } } });
  for (let i = 0; i < 7; i++) {
    edit(a, `k${i}`, i);
    await w.run([a, b], 6000);
  }
  await a.reseed();
  for (const kind of ["scan", "save", "status", "compaction", "reseed"]) {
    const found = a.traces({ kind });
    assert.ok(found.length, `a ${kind} trace exists`);
    for (const t of found) {
      assert.equal(t.kind, kind);
      assert.equal(typeof t.id, "number");
      assert.ok(["ok", "partial", "failed", "skipped"].includes(t.outcome));
      assert.equal(typeof t.reason, "string");
      assert.ok(t.startedAt <= t.endedAt);
      assert.equal(t.durationMs, 0, "no timer, no durations");
      assert.ok(Array.isArray(t.steps));
    }
  }
  const ids = a.traces().map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => y - x), "newest first, ids increase");
  assert.equal(new Set(ids).size, ids.length);
  const step = saves(a).find((t) => t.steps.some((s) => s.action === "write")).steps.find((s) => s.action === "write" && s.result === "ok");
  assert.deepEqual(Object.keys(step).sort(), ["action", "at", "bytes", "durationMs", "error", "path", "result", "table"]);
  assert.equal(step.table, "notes");
  assert.match(step.path, /^data\/notes\/harry-aaaaaaaa\/\d{6}\.ywb$/);
  assert.ok(step.bytes > 0);
  const compaction = a.traces({ kind: "compaction" }).find((t) => t.steps.some((s) => s.action === "write"));
  assert.match(compaction.steps.find((s) => s.action === "write" && s.bytes > 0).path, /snap-/);
});

test("the first scan is traced as startup, with its apply steps", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  edit(a, "x");
  await a.flush();
  const b = await w.device(B);
  const first = kinds(b, { kind: "scan" })[0];
  assert.equal(first.reason, "startup");
  const apply = first.steps.find((s) => s.action === "apply");
  assert.equal(apply.table, "notes");
  assert.equal(apply.count, 1);
  assert.match(apply.path, /data\/notes\/harry-aaaaaaaa\/000001\.ywb/);
});

test("save reasons: quiet, max-wait, forced", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  edit(a, "x");
  await w.run([a], 3000);
  assert.deepEqual(saves(a).map((t) => [t.reason, t.outcome]), [["quiet", "ok"]]);

  const w2 = await makeWorld({ options: SLOW });
  const s = await w2.device(A);
  for (let t = 0; t < 400 && !saves(s).length; t += 10) {
    edit(s, `k${t}`, t);
    await w2.run([s], 10000, 10000);
  }
  assert.equal(saves(s)[0].reason, "max-wait");

  edit(s, "late");
  await s.flush();
  assert.equal(saves(s).at(-1).reason, "forced");
});

test("a failed save is traced as failed, the next attempt as a retry", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 3000);
  const failed = saves(a).filter((t) => t.outcome !== "skipped")[0];
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reason, "quiet");
  assert.equal(failed.steps.find((s) => s.action === "write" && s.error).error.name, "NoModificationAllowedError");
  w.folder.clearFailures();
  await w.run([a], 20000);
  const retried = saves(a).filter((t) => t.outcome !== "skipped").at(-1);
  assert.equal(retried.reason, "retry");
  assert.equal(retried.outcome, "ok");
});

test("pending work held back by the minimum interval gets one skipped trace, not one per tick", async () => {
  const w = await makeWorld({ options: { quietMs: 2000, maxWaitMs: 10000, minIntervalMs: 30000 } });
  const a = await w.device(A);
  edit(a, "x");
  await w.run([a], 3000);
  edit(a, "y");
  await w.run([a], 20000);
  const held = saves(a).filter((t) => t.outcome === "skipped");
  assert.equal(held.length, 1);
  assert.equal(held[0].reason, "min-interval");
  assert.equal(held[0].steps.length, 0);
  assert.equal(held[0].detail.pending, 1);
  await w.run([a], 20000);
  assert.equal(saves(a).filter((t) => t.outcome === "skipped").length, 1, "the save happened; no further skip traces");
  assert.equal(saves(a).filter((t) => t.outcome === "ok").length, 2);
  edit(a, "z");
  await w.run([a], 20000);
  assert.equal(saves(a).filter((t) => t.outcome === "skipped").length, 2, "a new hold-back is a new state");
});

test("backing off after a failure gets one skipped trace", async () => {
  const w = await makeWorld({ options: { quietMs: 2000, minIntervalMs: 1000, retryInitialMs: 20000 } });
  const a = await w.device(A);
  w.folder.failWrites((p) => p.startsWith("data/"));
  edit(a, "x");
  await w.run([a], 12000);
  const held = saves(a).filter((t) => t.outcome === "skipped");
  assert.deepEqual(held.map((t) => t.reason), ["backoff"]);
});

test("ticks with nothing pending add no save or compaction traces", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  await w.run([a], 5000);
  const before = a.traces().filter((t) => t.kind === "save" || t.kind === "compaction").length;
  await w.run([a], 60000);
  assert.equal(a.traces().filter((t) => t.kind === "save" || t.kind === "compaction").length, before);
  assert.equal(before, 0);
});

test("a forced flush with nothing to save is a skipped trace", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  await a.flush();
  const t = saves(a)[0];
  assert.deepEqual([t.outcome, t.reason], ["skipped", "nothing-pending"]);
});

// What the folder itself recorded, in order, as comparable [type, path, size].
const folderOps = (folder) => folder.ops.map((o) => [o.type, o.path, o.size]);
const stepOps = (engine) => engine.traces().reverse().flatMap((t) => t.steps)
  .filter((s) => ["list", "stat", "read", "write", "delete"].includes(s.action) && !s.error && s.result !== "missing")
  .map((s) => [s.action, s.path, s.bytes]);

test("trace steps are exactly the folder operations performed (same path, same size)", async () => {
  const w = await makeWorld({ tables: { notes: "yjs", tasks: "yjs" } });
  const a = await w.device(A, { options: COMPACT });
  for (let i = 0; i < 8; i++) {
    edit(a, `k${i}`, i);
    a.table("tasks").getMap("m").set(`t${i}`, i);
    await w.run([a], 6000);
  }
  await a.reseed();
  await a.close();
  assert.ok(w.folder.ops.length > 50);
  assert.deepEqual(stepOps(a), folderOps(w.folder));
  assert.equal(a.metrics().untracedOperations, 0);
});

test("a second device's reads, deletes and snapshots are attributed too", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: COMPACT });
  for (let i = 0; i < 7; i++) {
    edit(a, `k${i}`, i);
    await w.run([a], 6000);
  }
  const before = w.folder.ops.length;
  const b = await w.device(B);
  const afterB = w.folder.ops.slice(before);
  const own = b.traces().reverse().flatMap((t) => t.steps)
    .filter((s) => ["list", "stat", "read", "write", "delete"].includes(s.action) && !s.error && s.result !== "missing")
    .map((s) => [s.action, s.path, s.bytes]);
  assert.deepEqual(own, afterB.map((o) => [o.type, o.path, o.size]));
});

test("traces hold no record content", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(B);
  edit(a, "visible-key", "SECRET-VALUE-42");
  await w.run([a, b], 20000);
  const all = JSON.stringify([...a.traces(), ...b.traces()]);
  assert.ok(all.length > 1000);
  assert.ok(!all.includes("SECRET-VALUE-42"));
  assert.ok(!all.includes("visible-key"));
});

test("engine.on('trace') delivers each finished trace once", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const seen = [];
  a.on("trace", (t) => seen.push(t));
  edit(a, "x");
  await w.run([a], 6000);
  assert.ok(seen.length >= 3);
  assert.deepEqual(seen.map((t) => t.id), [...new Set(seen.map((t) => t.id))]);
  assert.deepEqual(a.traces({ limit: seen.length }).reverse(), seen);
});

test("listeners given at creation also see the startup trace", async () => {
  const w = await makeWorld();
  const seen = [];
  await w.device(A, { listeners: { trace: (t) => seen.push(t) } });
  assert.deepEqual(seen.map((t) => [t.kind, t.reason]), [["scan", "startup"]]);
});

test("durations come from the injected timer and nothing else", async () => {
  const w = await makeWorld();
  let n = 0;
  const timer = { now: () => (n += 5) };
  const a = await w.device(A, { timer });
  edit(a, "x");
  await w.run([a], 6000);
  const t = saves(a)[0];
  assert.ok(t.durationMs > 0 && t.durationMs % 5 === 0);
  assert.ok(t.steps.every((s) => s.durationMs % 5 === 0));
  assert.equal(t.endedAt - t.startedAt, 0, "wall times come from the clock, which did not move inside the attempt");
});
