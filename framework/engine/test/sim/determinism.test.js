import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../../src/sim/world.js";
import { writeFile, removeFile } from "./helpers.js";

const ALL_FAULTS = {
  uploadLagMs: [0, 3000],
  downloadLagMs: [0, 3000],
  partialArrival: { probability: 0.4 },
  conflictCopy: { probability: 0.5 },
  crswap: { probability: 0.4, leftBehindProbability: 0.4 },
  writeFailure: { probability: 0.1 },
  readFailure: { probability: 0.3 },
  junk: { probability: 0.3 },
};

async function runScript(seed) {
  const world = createWorld({ seed, faults: ALL_FAULTS });
  const devices = ["a-1", "b-2", "c-3"].map((id) => world.addDevice(id));
  world.setOnline("c-3", false);
  for (let i = 0; i < 25; i++) {
    const device = devices[i % 3];
    const path = `data/shared/f${i % 4}.bin`; // shared paths on purpose: exercises conflicts
    if (i % 7 === 6) await removeFile(device, path).catch(() => {});
    else await writeFile(device, path, `v${i}`).catch(() => {});
    await world.advance(400 + (i % 5) * 100);
    if (i === 15) world.setOnline("c-3", true);
  }
  await world.quiesce();
  return world;
}

test("same seed and same script give the same trace hash and log", async () => {
  const first = await runScript(123);
  const second = await runScript(123);
  assert.equal(first.traceHash(), second.traceHash());
  assert.deepEqual(first.log, second.log);
  assert.ok(first.log.length > 50);
});

test("a different seed gives a different trace hash", async () => {
  assert.notEqual((await runScript(123)).traceHash(), (await runScript(124)).traceHash());
});

test("trace hash is a 64 character hex string and changes when the log grows", async () => {
  const world = createWorld({ seed: 1 });
  const dev = world.addDevice("a-1");
  const before = world.traceHash();
  assert.match(before, /^[0-9a-f]{64}$/);
  await writeFile(dev, "f.txt", "x");
  assert.notEqual(world.traceHash(), before);
});

test("world.random(name) streams are seeded and independent of world activity", async () => {
  const quiet = createWorld({ seed: 5 });
  const busy = createWorld({ seed: 5, faults: ALL_FAULTS });
  const dev = busy.addDevice("a-1");
  await writeFile(dev, "f.txt", "x");
  await busy.quiesce();
  assert.deepEqual(quiet.random("engine").bytes(8), busy.random("engine").bytes(8));
  assert.notDeepEqual(quiet.random("engine").bytes(8), quiet.random("other").bytes(8));
});
