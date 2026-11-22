// The engine reads with every key it is given and writes with one (S3
// deliverable 3): after a rotation, chunks sealed with the old key stay readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../../src/engine/engine.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { yjsAdapter } from "../../src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom, testKey } from "../helpers/memfolder.js";
import { EAGER, json } from "./_harness.js";

async function setup() {
  const clock = createManualClock();
  const folder = createMemFolder({ clock });
  const random = createSeededRandom(5);
  const device = (deviceId, keyInput) =>
    createEngine({
      root: folder.root, clock, random, store: createMemoryStore(), deviceId, user: deviceId.split("-")[0],
      adapters: { yjs: yjsAdapter }, tables: { notes: "yjs" }, options: EAGER, ...keyInput,
    });
  const run = async (engines, ms) => {
    for (let t = 0; t < ms; t += 1000) {
      clock.advance(1000);
      for (const e of engines) await e.tick();
    }
  };
  return { device, run, key1: await testKey(1), key2: await testKey(2) };
}

test("a device writing with key 2 reads a chunk sealed with key 1", async () => {
  const { device, run, key1, key2 } = await setup();
  const old = await device("harry-aaaaaaaa", { key: key1, keyId: 1 });
  old.table("notes").getMap("m").set("old", 1);
  await run([old], 15000);

  const rotated = await device("sam-bbbbbbbb", { key: key2, keyId: 2, keys: new Map([[1, key1]]) });
  rotated.table("notes").getMap("m").set("new", 2);
  await run([old, rotated], 30000);

  assert.deepEqual(json(rotated), { m: { old: 1, new: 2 } });
  assert.equal(rotated.status().unreadable.length, 0);
  // The device with only key 1 cannot read what key 2 sealed.
  assert.deepEqual(json(old), { m: { old: 1 } });
  assert.ok(old.status().unreadable.some((u) => u.path.includes("sam-bbbbbbbb")));
});

test("keys may be a plain object keyed by key id", async () => {
  const { device, run, key1, key2 } = await setup();
  const old = await device("harry-aaaaaaaa", { key: key1, keyId: 1 });
  old.table("notes").getMap("m").set("old", 1);
  await run([old], 15000);
  const rotated = await device("sam-bbbbbbbb", { key: key2, keyId: 2, keys: { 1: key1 } });
  await run([rotated], 5000);
  assert.deepEqual(json(rotated), { m: { old: 1 } });
});
