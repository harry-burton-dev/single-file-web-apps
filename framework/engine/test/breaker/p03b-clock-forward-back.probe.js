// Attack 3b: clock jumps a year forward (A saves/scans/status), then is corrected. Does A keep working?
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, DAY } from "./_lib.js";

test("P03b after a clock excursion forward and back, A still saves within minutes", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  w.offsets.set(A, 365 * DAY);
  m(a).set("future", 1);
  await w.run([a, b], 15000);
  w.offsets.set(A, 0); // user fixes the clock
  m(a).set("after-fix", 2);
  await w.run([a, b], 300000);
  console.log("P03b A pending", a.status().pending, "health", a.health().state, a.health().detail, "B sees", JSON.stringify(json(b).m));
  assert.equal(a.status().pending, 0, "A's edit made after the correction was written within 5 minutes");
  assert.equal(json(b).m["after-fix"], 2);
});

test("P03c after the same excursion A also stops reading the folder", async () => {
  const w = await world();
  const a = await w.device(A);
  const b = await w.device(B);
  w.offsets.set(A, 365 * DAY);
  await w.run([a, b], 15000);
  w.offsets.set(A, 0);
  m(b).set("from-b", 1);
  await w.run([a, b], 300000);
  console.log("P03c A sees", JSON.stringify(json(a).m));
  assert.equal(json(a).m?.["from-b"], 1, "A received B's edit within 5 minutes");
});
