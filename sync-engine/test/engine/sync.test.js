import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

test("two engines converge on a map and text workload", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  const b = await w.device("sam-bbbbbbbb");
  a.table("notes").getMap("m").set("x", 1);
  a.table("notes").getText("t").insert(0, "hello");
  b.table("notes").getMap("m").set("y", 2);
  b.table("notes").getText("t").insert(0, "world");
  await w.run([a, b], 60000);
  assert.deepEqual(json(a), json(b));
  assert.equal(json(a).m.x, 1);
  assert.equal(json(a).m.y, 2);
  assert.equal(json(a).t.length, 10);
  assert.equal(a.status().pending, 0);
});

test("three engines converge and see each other's status", async () => {
  const w = await makeWorld();
  const ids = ["harry-aaaaaaaa", "sam-bbbbbbbb", "kim-cccccccc"];
  const es = [];
  for (const id of ids) es.push(await w.device(id));
  es.forEach((e, i) => e.table("notes").getMap("m").set(`k${i}`, i));
  await w.run(es, 60000);
  const [a, b, c] = es;
  assert.deepEqual(json(a), json(b));
  assert.deepEqual(json(b), json(c));
  assert.equal(Object.keys(json(a).m).length, 3);
  assert.deepEqual(Object.keys(a.status().devices).sort(), ["kim-cccccccc", "sam-bbbbbbbb"]);
});

test("received event reports table, device and writtenAt", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  const b = await w.device("sam-bbbbbbbb");
  const got = [];
  b.on("received", (e) => got.push(e));
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a, b], 30000);
  assert.ok(got.length >= 1);
  assert.equal(got[0].table, "notes");
  assert.equal(got[0].device, "harry-aaaaaaaa");
  assert.equal(typeof got[0].writtenAt, "number");
});

test("a late device catches up from existing files", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 30000);
  const b = await w.device("sam-bbbbbbbb");
  assert.deepEqual(json(b), json(a));
});

test("unknown tables, adapters and junk are ignored without error", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  w.folder.drop("data/other/sam-bbbbbbbb/000001.ywb", Uint8Array.of(1, 2, 3));
  w.folder.drop("data/notes/sam-bbbbbbbb/readme.txt", Uint8Array.of(1));
  w.folder.drop("data/notes/sam-bbbbbbbb/000001.ywb.crswap", Uint8Array.of(1));
  w.folder.drop("data/notes/sam-bbbbbbbb/000002.tmp", Uint8Array.of(1));
  await a.scan();
  await a.tick();
  assert.equal(a.status().errors.length, 0);
  assert.equal(a.status().unreadable.length, 0);
});
