import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { yjsAdapter as ya } from "../../src/adapters/yjs.js";
import { createMemoryStore } from "../../src/store/memory.js";

test("onLocalUpdate reports local changes only, applyUpdate is silent", () => {
  const a = ya.create();
  const b = ya.create();
  const fromA = [];
  const fromB = [];
  ya.onLocalUpdate(a, (u) => fromA.push(u));
  ya.onLocalUpdate(b, (u) => fromB.push(u));
  a.getMap("m").set("x", 1);
  assert.equal(fromA.length, 1);
  ya.applyUpdate(b, fromA[0], "ignored-origin");
  assert.equal(fromB.length, 0);
  assert.deepEqual(ya.toJSON(b), { m: { x: 1 } });
});

test("unsubscribe stops reports", () => {
  const a = ya.create();
  const seen = [];
  const off = ya.onLocalUpdate(a, (u) => seen.push(u));
  off();
  a.getMap("m").set("x", 1);
  assert.equal(seen.length, 0);
});

test("snapshot and compact reproduce the document, in any order, twice", () => {
  const a = ya.create();
  const updates = [];
  ya.onLocalUpdate(a, (u) => updates.push(u));
  a.getMap("m").set("x", 1);
  a.getText("t").insert(0, "hi");
  a.getMap("m").set("y", [1, 2]);
  const merged = ya.compact(updates);
  assert.equal(merged.length, 1);
  for (const input of [[ya.snapshot(a)], merged, [...updates].reverse(), [...updates, ...updates]]) {
    const doc = ya.create();
    input.forEach((u) => ya.applyUpdate(doc, u));
    assert.deepEqual(ya.toJSON(doc), ya.toJSON(a));
  }
});

test("toJSON sorts keys recursively and treats undeclared types like declared ones", () => {
  const a = ya.create();
  a.getMap("zeta").set("b", new Y.Map([["d", 1], ["c", 2]]));
  a.getMap("zeta").set("a", 1);
  a.getText("alpha").insert(0, "x");
  const b = ya.create();
  ya.applyUpdate(b, ya.snapshot(a)); // b never declared its types
  const json = ya.toJSON(b);
  assert.deepEqual(json, ya.toJSON(a));
  assert.deepEqual(Object.keys(json), ["alpha", "zeta"]);
  assert.deepEqual(Object.keys(json.zeta), ["a", "b"]);
  assert.deepEqual(Object.keys(json.zeta.b), ["c", "d"]);
  const c = ya.create();
  c.getMap("empty");
  assert.deepEqual(ya.toJSON(c), {});
});

test("memory store copies values on set and get, lists by prefix, wipes", async () => {
  const s = createMemoryStore();
  const bytes = Uint8Array.of(1, 2, 3);
  const obj = { a: [1] };
  await s.set("p/bytes", bytes);
  await s.set("p/obj", obj);
  await s.set("q/x", 1);
  bytes[0] = 9;
  obj.a.push(2);
  assert.deepEqual(await s.get("p/bytes"), Uint8Array.of(1, 2, 3));
  assert.deepEqual(await s.get("p/obj"), { a: [1] });
  (await s.get("p/bytes"))[1] = 9;
  assert.deepEqual(await s.get("p/bytes"), Uint8Array.of(1, 2, 3));
  assert.equal(await s.get("missing"), undefined);
  assert.deepEqual(await s.keys("p/"), ["p/bytes", "p/obj"]);
  await s.delete("p/obj");
  assert.deepEqual(await s.keys("p/"), ["p/bytes"]);
  s.wipe();
  assert.deepEqual(await s.keys(""), []);
});
