// Attack 15b: which store keys grow while idle, and is it bounded?
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, m, A, B } from "./_lib.js";

test("P15b idle store growth is bounded (trace history cap)", async () => {
  const w = await world();
  const a = await w.device(A); const b = await w.device(B);
  m(a).set("x", 1);
  await w.run([a, b], 60000);
  const sizes = [];
  for (let round = 0; round < 4; round++) {
    await w.run([a, b], 3000000, 6000);
    const keys = await w.store(A).keys("");
    const bytes = (await Promise.all(keys.map(async (k) => { const v = await w.store(A).get(k); return v?.length ?? JSON.stringify(v).length; }))).reduce((x, y) => x + y, 0);
    sizes.push({ keys: keys.length, bytes, sample: [...new Set(keys.map((k) => k.replace(/\d+/g, "#")))] });
  }
  console.log("P15b", JSON.stringify(sizes.map((s) => [s.keys, s.bytes])), JSON.stringify(sizes.at(-1).sample));
  assert.ok(sizes.at(-1).keys <= sizes[2].keys + 2, "keys still growing after 3 rounds");
});
