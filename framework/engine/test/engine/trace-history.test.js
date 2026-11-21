import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { yjsAdapter, createYjsAdapter } from "../../src/adapters/yjs.js";
import { createSeededRandom } from "../helpers/memfolder.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const edit = (e, k, v = 1) => e.table("notes").getMap("m").set(k, v);

/** A store that counts how often trace segments are written. */
function countingStore() {
  const store = createMemoryStore();
  const counts = { traceSets: 0, traceDeletes: 0 };
  return {
    counts,
    inner: store,
    get: (k) => store.get(k),
    set: (k, v) => { if (k.startsWith("trace/")) counts.traceSets += 1; return store.set(k, v); },
    delete: (k) => { if (k.startsWith("trace/")) counts.traceDeletes += 1; return store.delete(k); },
    keys: (p) => store.keys(p),
  };
}

test("the in-memory history is bounded by trace.memoryLimit", async () => {
  const w = await makeWorld({ options: { trace: { memoryLimit: 7 } } });
  const a = await w.device(A);
  await w.run([a], 60000);
  const all = a.traces();
  assert.equal(all.length, 7);
  assert.deepEqual(all.map((t) => t.id), [...all.map((t) => t.id)].sort((x, y) => y - x));
  assert.ok(all[0].id > 7, "older traces were dropped, not the newest");
});

test("traces() filters by kind, outcome, table and device, newest first, with a limit", async () => {
  const w = await makeWorld({ tables: { notes: "yjs", tasks: "yjs" } });
  const a = await w.device(A);
  const b = await w.device(B);
  edit(a, "x");
  a.table("tasks").getMap("m").set("t", 1);
  await w.run([a, b], 20000);
  assert.ok(a.traces({ kind: "save" }).every((t) => t.kind === "save"));
  assert.ok(a.traces({ kind: "save" }).length >= 1);
  assert.equal(a.traces({ outcome: "failed" }).length, 0);
  assert.ok(a.traces({ table: "tasks" }).length > 0);
  assert.ok(a.traces({ table: "tasks" }).every((t) => t.tables.includes("tasks")));
  assert.equal(a.traces({ table: "nope" }).length, 0);
  const withB = a.traces({ device: B });
  assert.ok(withB.length > 0, "scans that read B's status mention B");
  assert.ok(withB.every((t) => t.devices.includes(B)));
  assert.ok(a.traces({ device: A, kind: "save" }).length > 0);
  assert.equal(a.traces({ limit: 3 }).length, 3);
  const ids = a.traces().map((t) => t.id);
  assert.deepEqual(a.traces({ limit: 3 }).map((t) => t.id), ids.slice(0, 3));
});

test("history survives a restart, stays bounded, and is written in batches", async () => {
  const w = await makeWorld({ options: { trace: { memoryLimit: 50, storeLimit: 20, persistBatch: 5 } } });
  const store = countingStore();
  const a = await w.device(A, { store });
  let saves = 0;
  a.on("trace", (t) => { if (t.kind === "save") saves += 1; });
  for (let i = 0; i < 110; i++) {
    edit(a, `k${i}`, i);
    await w.run([a], 3000);
  }
  await a.close();
  assert.ok(saves > 100, `plenty of saves were traced (${saves})`);
  assert.ok(store.counts.traceSets <= Math.ceil((saves + 1) / 5) + 1, "one store write per batch of 5, not per trace");
  assert.ok(store.counts.traceSets >= 20);
  const segments = await store.inner.keys("trace/");
  assert.ok(segments.length * 5 <= 20 + 5 + 5, `old segments were deleted (${segments.length} left)`);
  assert.ok(store.counts.traceDeletes > 0);

  const lastBefore = a.traces()[0];
  const b = await w.device(A, { store });
  const restored = b.traces();
  assert.ok(restored.length >= 20 - 5 && restored.length <= 20 + 1, `about storeLimit traces came back (${restored.length})`);
  const newest = restored.find((t) => t.reason !== "startup" || t.id <= lastBefore.id);
  assert.ok(newest.id <= lastBefore.id + 1);
  assert.equal(restored[0].reason, "startup", "the restart's own scan is the newest trace");
  assert.ok(restored[0].id > lastBefore.id, "ids keep increasing across the restart");
  assert.ok(restored.slice(1).every((t) => t.id <= lastBefore.id));
  assert.ok(restored.every((t, i) => i === 0 || t.id < restored[i - 1].id));
});

test("routine idle traces are kept in memory and emitted, but never written to the store", async () => {
  const w = await makeWorld({ options: { trace: { persistBatch: 5 } } });
  const store = countingStore();
  const a = await w.device(A, { store });
  const emitted = [];
  a.on("trace", (t) => emitted.push(t));
  await w.run([a], 10 * 60000);
  assert.ok(a.traces({ kind: "scan" }).length > 50, "idle scans are still in the history");
  assert.ok(a.traces({ kind: "status" }).length > 50, "idle status writes are still in the history");
  assert.ok(emitted.length > 100, "and still emitted");
  assert.equal(store.counts.traceSets, 0, "ten idle minutes write no trace segment");

  edit(a, "x");
  await w.run([a], 10000);
  await a.close();
  const stored = (await Promise.all((await store.inner.keys("trace/")).map((k) => store.inner.get(k)))).flat();
  assert.ok(stored.some((t) => t.kind === "save"), "a save is stored");
  assert.ok(stored.some((t) => t.reason === "startup"), "the startup scan is stored");
  const routine = (t) => t.reason === "scheduled" && t.outcome === "ok" && (t.kind === "scan" || t.kind === "status") && !t.counts.apply && !t.counts.delete && !t.counts.errors;
  assert.equal(stored.filter(routine).length, 0, "no routine trace is stored");
});

test("a crash loses at most the traces not yet written in a batch", async () => {
  const w = await makeWorld({ options: { trace: { persistBatch: 50 } } });
  const store = createMemoryStore();
  const a = await w.device(A, { store });
  await w.run([a], 10000);
  const made = a.traces().length;
  assert.ok(made > 5 && made < 50);
  const b = await w.device(A, { store }); // no close(): nothing was written yet
  assert.equal(b.traces().length, 1);
});

async function scripted(level, { switchTo } = {}) {
  const w = await makeWorld({ options: { trace: { level } } });
  const seeded = (seed) => ({ yjs: createYjsAdapter({ random: createSeededRandom(seed) }) }); // reproducible client ids
  const a = await w.device(A, { adapters: seeded(11) });
  const b = await w.device(B, { adapters: seeded(12) });
  for (let i = 0; i < 6; i++) {
    edit(a, `a${i}`, i);
    edit(b, `b${i}`, i);
    await w.run([a, b], 7000);
    if (switchTo && i === 2) {
      a.setTraceLevel(switchTo);
      b.setTraceLevel(switchTo);
    }
  }
  await a.close();
  await b.close();
  const content = { files: Object.fromEntries(w.folder.paths().map((p) => [p, Buffer.from(w.folder.read(p)).toString("hex")])), docs: [a, b].map((e) => JSON.stringify(yjsAdapter.toJSON(e.table("notes")))) };
  return { w, a, b, ops: JSON.stringify(w.folder.ops), content, metrics: a.metrics() };
}

test("trace level off, summary and full make the same folder operations and the same content", async () => {
  const off = await scripted("off");
  const summary = await scripted("summary");
  const full = await scripted("full");
  assert.ok(off.w.folder.ops.length > 100);
  assert.equal(off.ops, summary.ops);
  assert.equal(off.ops, full.ops);
  assert.deepEqual(off.content, full.content);
  assert.deepEqual(summary.content, full.content);
  assert.deepEqual(off.metrics.throughput, full.metrics.throughput, "counters do not depend on the level");
  assert.equal(off.metrics.sync.scan.count, full.metrics.sync.scan.count);
});

test("what each level keeps", async () => {
  const off = await scripted("off");
  const summary = await scripted("summary");
  const full = await scripted("full");
  assert.equal(off.a.traces().length, 0);
  const written = (e) => e.traces({ kind: "save", outcome: "ok" })[0];
  const s = written(summary.a);
  assert.deepEqual(s.steps, []);
  assert.ok(s.counts.write >= 1 && s.counts.bytesWritten > 0, "summary keeps counts and bytes");
  assert.ok(s.tables.includes("notes"));
  const f = written(full.a);
  assert.ok(f.steps.length >= 1);
  assert.deepEqual(f.counts, s.counts);
  assert.equal(full.a.traces().length, summary.a.traces().length);
});

test("changing the level while running changes nothing but what is recorded", async () => {
  const steady = await scripted("full");
  const switched = await scripted("full", { switchTo: "off" });
  assert.equal(switched.ops, steady.ops);
  assert.deepEqual(switched.content, steady.content);
  assert.ok(switched.a.traces().length < steady.a.traces().length);
  assert.deepEqual(switched.metrics.throughput, steady.metrics.throughput);
});

test("bad trace options are refused", async () => {
  const w = await makeWorld();
  await assert.rejects(() => w.device(A, { options: { trace: { level: "loud" } } }), /trace.level/);
  await assert.rejects(() => w.device(A, { options: { trace: { memoryLimit: 0 } } }), /memoryLimit/);
});
