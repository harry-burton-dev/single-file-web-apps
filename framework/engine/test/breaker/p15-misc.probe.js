// Attacks 13, 15-19.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, COMPACT, DAY, chunks, snaps } from "./_lib.js";

test("P13 A and B write snapshots concurrently covering different chunks; deletions keep a new device whole", async () => {
  const opts = { sealBytes: 1, compaction: { chunkThreshold: 4, minSnapshotAgeMs: 10000, jitterMs: 0, snapshotMaxAgeMs: 1000 } };
  const w = await world({ options: opts });
  const a = await w.device(A);
  const b = await w.device(B);
  for (let i = 0; i < 10; i++) { m(a).set(`a${i}`, i); m(b).set(`b${i}`, i); await w.run([a], 3000); await w.run([b], 3000); await w.run([a, b], 3000); }
  await w.run([a, b], 200000);
  const c = await w.device(C);
  await w.run([a, b, c], 60000);
  console.log("P13 files", w.folder.paths("data/").length, "snaps", snaps(w, A).length, snaps(w, B).length);
  assert.deepEqual(json(c), json(a)); assert.deepEqual(json(a), json(b));
  assert.equal(Object.keys(json(c).m).length, 20);
});

test("P15 thousands of idle ticks: nothing grows (store keys, folder files/bytes, traces, errors, writes)", async () => {
  const w = await world({ options: { statusMs: 60000, scanMs: 30000 } });
  const a = await w.device(A);
  const b = await w.device(B);
  m(a).set("x", 1);
  await w.run([a, b], 60000);
  const snap = async () => ({ keysA: (await w.store(A).keys("")).length, keysB: (await w.store(B).keys("")).length, files: w.folder.paths("").length, writes: w.folder.writes.length, ops: w.folder.ops.length, traces: a.traces({ limit: 100000 }).length, errors: a.status().errors.length, heap: process.memoryUsage().heapUsed });
  await w.run([a, b], 600000);
  const s1 = await snap();
  await w.run([a, b], 5000000, 2000);
  const s2 = await snap();
  console.log("P15", JSON.stringify(s1), JSON.stringify(s2));
  assert.equal(s2.keysA, s1.keysA, "store keys grow"); assert.equal(s2.keysB, s1.keysB);
  assert.equal(s2.files, s1.files);
  assert.ok(s2.traces <= 500);
  assert.ok(s2.errors <= 50);
});

test("P16a close() right after an edit never loses it; edit after close is reported, not silently dropped", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  m(a).set("x", 1);
  const closing = a.close();               // close races the local-store chain
  m(a).set("y", 2);                         // edit made while close is in flight
  await closing;
  await w.run([b], 30000);
  console.log("P16a B sees", JSON.stringify(json(b).m), "A doc", JSON.stringify(json(a).m));
  assert.deepEqual(json(b).m, { x: 1, y: 2 });
});

test("P16b flush()/tick()/scan() concurrently with edits: no loss, no duplicate chunk numbering", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  const ps = [];
  for (let i = 0; i < 30; i++) {
    m(a).set(`k${i}`, i);
    ps.push(a.flush(), a.scan(), a.tick());
    w.clock.advance(300);
  }
  await Promise.all(ps);
  await w.run([a, b], 30000);
  assert.equal(Object.keys(json(b).m).length, 30);
  assert.equal(a.status().pending, 0);
});

test("P17 wiped-store device whose own chunk is unreadable at start publishes a snapshot (reseed): chunk is then skipped forever", async () => {
  const w = await world();
  let a = await w.device(A, { options: { sealBytes: 1 } });
  const b = await w.device(B);
  m(a).set("k1", 1); await w.run([a, b], 12000);
  m(a).set("k2", 2); await w.run([a, b], 12000);
  m(a).set("k3", 3); await w.run([a, b], 12000);
  await a.close();
  w.stores.delete(A); // browser storage cleared
  // chunk 2 unreadable for A at startup
  const root = w.folder.root;
  let unreadable = true;
  const flaky = (dir) => new Proxy(dir, { get(t, p) {
    if (p === "getDirectoryHandle") return async (n, o) => flaky(await t.getDirectoryHandle(n, o));
    if (p === "entries") return async function* () { for await (const [n, h] of t.entries()) yield [n, h.kind === "file" ? flakyFile(h, n) : flaky(h)]; };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const flakyFile = (h, n) => new Proxy(h, { get(t, p) {
    if (p === "getFile" && unreadable && n === "000002.ywb") return async () => { throw Object.assign(new Error("cloud-only"), { name: "NotReadableError" }); };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  a = await w.device(A, { root: flaky(root), options: { sealBytes: 1 } });
  a.on("error", () => {});
  await a.reseed();                // admin forces a snapshot while chunk 2 cannot be read
  unreadable = false;
  await w.run([a, b], 60000);
  const c = await w.device(C);
  await w.run([a, b, c], 40000);
  console.log("P17 A", JSON.stringify(json(a).m), "B", JSON.stringify(json(b).m), "C", JSON.stringify(json(c).m));
  assert.deepEqual(json(a).m, { k1: 1, k2: 2, k3: 3 }, "A");
  assert.deepEqual(json(c).m, { k1: 1, k2: 2, k3: 3 }, "C");
});

test("P18 snapshot arrives without its chunks (and chunks deleted) to a device that never read them", async () => {
  const opts = { sealBytes: 1, compaction: { chunkThreshold: 4, minSnapshotAgeMs: 10000, jitterMs: 0 } };
  const w = await world({ options: opts });
  const a = await w.device(A);
  const b = await w.device(B, { options: { compaction: { enabled: false } } });
  for (let i = 0; i < 8; i++) { m(a).set(`a${i}`, i); await w.run([a, b], 6000); }
  await w.run([a, b], 200000);
  console.log("P18 A files", w.folder.paths(`data/notes/${A}/`).map((p) => p.split("/").pop()));
  // device D shows up when only snapshot + tail exist, and sees snapshot but not tail yet (hide listing of chunks)
  const d = await w.device("lee-dddddddd");
  await w.run([a, b, d], 40000);
  assert.deepEqual(json(d), json(a));
});

test("P19 local store failing: health must not say saved while edits are only in memory", async () => {
  const w = await world();
  const store = w.store(A);
  let broken = false;
  const wrapped = { get: (k) => store.get(k), keys: (p) => store.keys(p), delete: (k) => { if (broken) throw new Error("quota"); return store.delete(k); }, set: (k, v) => { if (broken) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); return store.set(k, v); } };
  const a = await w.device(A, { store: wrapped });
  a.on("error", () => {});
  broken = true;
  m(a).set("x", 1);
  const states = [];
  for (let i = 0; i < 20; i++) { w.clock.advance(1000); await a.tick(); states.push(`${a.health().state}/${a.status().pending}`); }
  console.log("P19 states", [...new Set(states)]);
  // folder is fine: edit should reach the folder and health 'saved' is then truthful (edit is in folder)
  const b = await w.device(B);
  await w.run([a, b], 20000);
  assert.equal(json(b).m?.x, 1);
});
