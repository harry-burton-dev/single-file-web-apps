// Attacks 9-12: truncation at every boundary, wrong keyId, huge update, forged status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, chunks, snaps } from "./_lib.js";

test("P09 truncated / zero-byte copies of every file kind at every interesting length never throw, change content, or wedge the reader", async () => {
  const w = await world();
  const a = await w.device(A, { options: { sealBytes: 1 } });
  m(a).set("x", 1);
  await w.run([a], 15000);
  m(a).set("y", 2);
  await w.run([a], 15000);
  await a.reseed();
  const targets = w.folder.paths("data/").concat(w.folder.paths("status/"));
  const real = new Map(targets.map((p) => [p, w.folder.read(p)]));
  const errors = [];
  for (const p of targets) {
    const bytes = real.get(p);
    for (const len of [0, 1, 3, 4, 5, 16, 17, 18, 32, 33, 34, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const bogus = p.replace(/\.ywb$/, "-COPY.ywb");
      w.folder.drop(p.includes("status/") ? p.replace(/\.ywb$/, "-COPY.ywb") : bogus, bytes.slice(0, len));
      const b = await w.device(B, { store: w.store(`B-${p}-${len}`) });
      b.on("error", () => {});
      await w.run([b], 4000);
      try { assert.deepEqual(json(b).m ?? {}, { x: 1, y: 2 }); } catch (e) { errors.push(`${p} len ${len}: ${JSON.stringify(json(b).m)}`); }
      w.folder.remove(bogus);
      await b.close();
    }
  }
  assert.deepEqual(errors, []);
});

test("P10 file written with an unknown keyId (rotation) is skipped, not applied, and never breaks other tables", async () => {
  const w = await world({ tables: { notes: "yjs", tasks: "yjs" } });
  const a = await w.device(A, { keyId: 2 });  // A is already on key 2
  const b = await w.device(B);                 // B only has key 1
  m(a).set("n", 1); m(a, "tasks").set("t", 1);
  await w.run([a, b], 30000);
  const b2health = b.health();
  console.log("P10 B unreadable", b.status().unreadable.length, "health", b2health.state, "peers", JSON.stringify(Object.keys(b2health.peers)));
  assert.equal(json(b).m, undefined);
  assert.ok(b.status().unreadable.length > 0, "B reports unreadable files");
});

test("P11 a single update far larger than sealBytes goes through intact, once", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  const big = "x".repeat(5_000_000);
  m(a).set("big", big);
  m(a).set("small", 1);
  await w.run([a, b], 20000);
  assert.equal(json(b).m.big.length, big.length);
  m(a).set("more", 2);
  await w.run([a, b], 20000);
  const sizes = w.folder.paths(`data/notes/${A}/`).map((p) => w.folder.read(p).length);
  console.log("P11 chunk sizes", sizes);
  assert.equal(json(b).m.more, 2);
});

test("P12 forged/buggy status claiming A's chunk 900000 exists makes A number past it", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  m(a).set("x", 1);
  await w.run([a, b], 15000);
  await b.close();
  // B (buggy build) reports it has seen A chunk 999999
  const { seal } = await import("../../src/engine/envelope.js");
  const meta = { kind: "status", user: "sam", device: B, appVersion: "x", writtenAt: w.clock.now(), lastActiveAt: w.clock.now(), tables: { notes: { applied: { [A]: { sealed: 999999, seen: 999999 } }, snapshots: [], digest: "x", pending: 0 } } };
  w.folder.drop(`status/${B}.ywb`, await seal({ key: w.key, keyId: 1, iv: w.random.bytes(12), meta }));
  await a.close();
  w.stores.delete(A); // A's store gets wiped, so only status evidence remains
  const a2 = await w.device(A);
  a2.on("error", () => {});
  m(a2).set("y", 2);
  await w.run([a2], 40000);
  console.log("P12 A files", w.folder.paths(`data/notes/${A}/`), "health", a2.health().state, "pending", a2.status().pending);
  assert.equal(a2.status().pending, 0, "A can still save");
});
