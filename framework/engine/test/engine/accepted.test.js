// "A change is durable once the engine has accepted it" (test spec P3): the
// engine says so with an `accepted` event, fired once the pending write is in
// the store and never when the store refused it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const A = "harry-aaaaaaaa";

test("accepted fires once per edit, after the store holds the pending entry", async () => {
  const w = await makeWorld();
  const store = w.store(A);
  const seen = [];
  const a = await w.device(A, {
    listeners: { accepted: (ev) => seen.push({ ev, pend: store.keys("t/notes/pend/") }) },
  });
  a.table("notes").getMap("m").set("x", 1);
  a.table("notes").getMap("m").set("y", 2);
  await a.settled();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.ev), [{ table: "notes" }, { table: "notes" }]);
  assert.deepEqual((await seen[0].pend).length, 1);
  assert.deepEqual((await seen[1].pend).length, 2);
  await w.run([a], 30000);
  assert.equal(seen.length, 2, "saving to the folder does not accept the edit again");
});

test("accepted does not fire when the store rejects the pending write", async () => {
  const w = await makeWorld();
  const inner = w.store(A);
  let failPend = false;
  const store = {
    get: (k) => inner.get(k),
    keys: (p) => inner.keys(p),
    delete: (k) => inner.delete(k),
    set: async (k, v) => {
      if (failPend && k.includes("/pend/")) throw new Error("quota exceeded");
      return inner.set(k, v);
    },
  };
  const seen = [];
  const a = await w.device(A, { store, listeners: { accepted: (ev) => seen.push(ev) } });
  failPend = true;
  a.table("notes").getMap("m").set("x", 1);
  await a.settled();
  assert.deepEqual(seen, []);
  failPend = false;
  a.table("notes").getMap("m").set("y", 2);
  await a.settled();
  assert.deepEqual(seen, [{ table: "notes" }]);
});

test("edits recovered from the store at startup are not accepted again", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  a.table("notes").getMap("m").set("x", 1);
  await a.settled();
  const seen = [];
  const again = await w.device(A, { listeners: { accepted: (ev) => seen.push(ev) } });
  await again.settled();
  assert.equal(again.status().pending, 1);
  assert.deepEqual(seen, []);
});
