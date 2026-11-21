import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";

const SLOW = { quietMs: 30000, maxWaitMs: 180000, minIntervalMs: 30000 };
const dataWrites = (w) => w.folder.writes.filter((x) => x.path.startsWith("data/"));

test("saves only after the quiet period", async () => {
  const w = await makeWorld({ options: SLOW });
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  w.clock.advance(29000);
  await a.tick();
  assert.equal(dataWrites(w).length, 0);
  w.clock.advance(1000);
  await a.tick();
  assert.equal(dataWrites(w).length, 1);
});

test("continued activity restarts the countdown", async () => {
  const w = await makeWorld({ options: SLOW });
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  w.clock.advance(20000);
  a.table("notes").getMap("m").set("y", 2);
  w.clock.advance(20000);
  await a.tick();
  assert.equal(dataWrites(w).length, 0);
  w.clock.advance(10000);
  await a.tick();
  assert.equal(dataWrites(w).length, 1);
});

test("max wait forces a save while activity never stops", async () => {
  const w = await makeWorld({ options: SLOW });
  const a = await w.device("harry-aaaaaaaa");
  const t0 = w.clock.now();
  for (let s = 0; s < 400; s += 10) {
    a.table("notes").getMap("m").set(`k${s}`, s);
    w.clock.advance(10000);
    await a.tick();
    if (dataWrites(w).length) break;
  }
  const first = dataWrites(w)[0];
  assert.ok(first, "a save happened");
  assert.ok(first.at - t0 >= 180000 && first.at - t0 <= 190000, `saved at +${first.at - t0}`);
});

test("timed saves are never closer than minIntervalMs", async () => {
  const w = await makeWorld({ options: { ...SLOW, quietMs: 2000 } });
  const a = await w.device("harry-aaaaaaaa");
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 3000);
  assert.equal(dataWrites(w).length, 1);
  a.table("notes").getMap("m").set("y", 2);
  await w.run([a], 20000);
  assert.equal(dataWrites(w).length, 1, "second change must wait for the interval");
  await w.run([a], 10000);
  const writes = dataWrites(w);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].at - writes[0].at >= 30000);
});

test("scan and status cadence follow scanMs and statusMs", async () => {
  const w = await makeWorld({ options: { scanMs: 30000, statusMs: 60000 } });
  const a = await w.device("harry-aaaaaaaa");
  const first = a.status().lastScanAt;
  w.clock.advance(29000);
  await a.tick();
  assert.equal(a.status().lastScanAt, first);
  w.clock.advance(1000);
  await a.tick();
  assert.equal(a.status().lastScanAt, w.clock.now());
  const statusWrites = () => w.folder.writes.filter((x) => x.path.startsWith("status/")).length;
  assert.equal(statusWrites(), 1);
  w.clock.advance(58000);
  await a.tick();
  assert.equal(statusWrites(), 1);
  w.clock.advance(1000);
  await a.tick();
  assert.equal(statusWrites(), 2);
});

test("a write failure keeps pending, records the error and retries with backoff", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  const errors = [];
  a.on("error", (e) => errors.push(e.at));
  w.folder.failWrites((p) => p.startsWith("data/"));
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 60000);
  assert.equal(a.status().pending, 1);
  assert.equal(dataWrites(w).length, 0);
  assert.ok(a.status().errors.some((e) => e.scope === "save"));
  assert.ok(errors.length >= 3);
  assert.ok(errors[1] - errors[0] >= 5000, "first backoff 5s");
  assert.ok(errors[2] - errors[1] >= 10000, "second backoff doubles");
  w.folder.clearFailures();
  await w.run([a], 40000);
  assert.equal(a.status().pending, 0);
  assert.equal(dataWrites(w).length, 1);
});

test("tick never throws even when the folder fails everywhere", async () => {
  const w = await makeWorld();
  const a = await w.device("harry-aaaaaaaa");
  w.folder.failWrites(() => true);
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 70000);
  await a.flush();
  await a.scan();
  assert.equal(a.status().pending, 1);
});
