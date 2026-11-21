// Attack 2: two browser profiles share one deviceId (separate stores, same folder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C } from "./_lib.js";

test("P02 two profiles with the same deviceId both keep their edits", async () => {
  const w = await world();
  const p1 = await w.device(A, { store: w.store("p1") });
  const p2 = await w.device(A, { store: w.store("p2") });
  const b = await w.device(B);
  for (let i = 0; i < 4; i++) {
    m(p1).set(`p1-${i}`, i);
    m(p2).set(`p2-${i}`, i);
    await w.run([p1, p2, b], 12000);
  }
  await w.run([p1, p2, b], 60000);
  const c = await w.device(C);
  await w.run([p1, p2, b, c], 40000);
  const views = { p1: json(p1).m, p2: json(p2).m, b: json(b).m, c: json(c).m };
  console.log("P02 key counts", Object.fromEntries(Object.entries(views).map(([k, v]) => [k, Object.keys(v ?? {}).length])));
  assert.deepEqual(views.p1, views.p2, "p1 vs p2");
  assert.deepEqual(views.b, views.p1, "b vs p1");
  assert.deepEqual(views.c, views.p1, "c vs p1");
  assert.equal(Object.keys(views.p1).length, 8);
});
