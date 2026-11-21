import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

test("pending survives a crash: new engine, same store, nothing lost", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  a.table("notes").getText("t").insert(0, "draft");
  await a.settled();
  assert.equal(a.status().pending, 2);
  assert.equal(w.folder.paths("data/").length, 0);
  // "crash": the old engine is simply abandoned
  const again = await w.device("harry-aaaaaaaa");
  assert.deepEqual(json(again), { m: { x: 1 }, t: "draft" });
  assert.equal(again.status().pending, 2);
  const b = await w.device("sam-bbbbbbbb");
  await w.run([again, b], 30000);
  assert.deepEqual(json(b), { m: { x: 1 }, t: "draft" });
  assert.equal(again.status().pending, 0);
});

test("a change is accepted only once it is in the store's pending area", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  await a.settled();
  const keys = await w.store("harry-aaaaaaaa").keys("t/notes/pend/");
  assert.equal(keys.length, 1);
});

test("a saved chunk clears pending from the store", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 20000);
  assert.deepEqual(await w.store("harry-aaaaaaaa").keys("t/notes/pend/"), []);
  assert.equal(a.status().pending, 0);
});

test("recovery works from a folded local log too", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa", { options: { localSnapshotEvery: 3 } });
  for (let i = 0; i < 10; i++) a.table("notes").getMap("m").set(`k${i}`, i);
  await a.settled();
  const keys = await w.store("harry-aaaaaaaa").keys("t/notes/");
  assert.ok(keys.some((k) => k.includes("/snap/")));
  const again = await w.device("harry-aaaaaaaa", { options: { localSnapshotEvery: 3 } });
  assert.deepEqual(json(again), json(a));
});

test("a wiped store refills from the folder", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  const b = await w.device("sam-bbbbbbbb");
  a.table("notes").getMap("m").set("x", 1);
  b.table("notes").getText("t").insert(0, "hey");
  await w.run([a, b], 30000);
  w.store("sam-bbbbbbbb").wipe();
  const b2 = await w.device("sam-bbbbbbbb");
  assert.deepEqual(json(b2), json(a));
  assert.equal(b2.status().pending, 0);
});

test("close flushes pending and stops the engine", async () => {
  const w = await makeWorld({ options: { quietMs: 30000 } });
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  await a.close();
  assert.equal(a.status().pending, 0);
  assert.equal(w.folder.paths("data/notes/harry-aaaaaaaa/").length, 1);
  a.table("notes").getMap("m").set("y", 2); // no longer observed
  await a.settled();
  assert.equal(a.status().pending, 0);
});

test("flush saves immediately regardless of timing", async () => {
  const w = await makeWorld({ options: { quietMs: 30000, minIntervalMs: 30000 } });
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  assert.equal(await a.flush(), true);
  a.table("notes").getMap("m").set("y", 2);
  assert.equal(await a.flush(), true);
  assert.equal(w.folder.writes.filter((x) => x.path.startsWith("data/")).length, 2);
});
