// Property: with faults on but one writer per path, after quiesce every device
// view equals the cloud and every path holds the last content its writer wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createWorld } from "../../src/sim/world.js";
import { textMap, writeFile, removeFile } from "./helpers.js";

const DEVICE_IDS = ["amy-aaaaaaaa", "ben-bbbbbbbb", "cat-cccccccc"];
const FILES_PER_DEVICE = 3;

const FAULTS = {
  uploadLagMs: [0, 6000],
  downloadLagMs: [0, 6000],
  partialArrival: { probability: 0.4, durationMs: [500, 8000] },
  conflictCopy: { probability: 1 }, // must never trigger: nobody shares a path
  crswap: { probability: 0.5, leftBehindProbability: 0.5 },
  writeFailure: { probability: 0.2 },
  readFailure: { probability: 0.3 },
  junk: { probability: 0.3 },
};

const operation = fc.oneof(
  fc.record({
    kind: fc.constant("write"),
    device: fc.nat(DEVICE_IDS.length - 1),
    file: fc.nat(FILES_PER_DEVICE - 1),
    text: fc.string({ maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant("delete"), device: fc.nat(DEVICE_IDS.length - 1), file: fc.nat(FILES_PER_DEVICE - 1) }),
  fc.record({ kind: fc.constant("advance"), ms: fc.integer({ min: 0, max: 5000 }) }),
);

const pathFor = (deviceId, file) => `data/notes/${deviceId}/f${file}.bin`;

// Applies one operation and updates the model of what each path should hold.
async function apply(world, devices, model, op) {
  if (op.kind === "advance") return world.advance(op.ms);
  const device = devices[op.device];
  const path = pathFor(device.id, op.file);
  if (op.kind === "delete") {
    if (!model.has(path)) return;
    await removeFile(device, path);
    model.delete(path);
    return;
  }
  const existed = model.has(path);
  try {
    await writeFile(device, path, op.text);
    model.set(path, op.text);
  } catch (error) {
    assert.equal(error.name, "NoModificationAllowedError");
    if (!existed) model.set(path, ""); // creation succeeded, content write failed
  }
}

test("property: single-writer paths converge to the last content written", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer(), fc.array(operation, { maxLength: 40 }), async (seed, operations) => {
      const world = createWorld({ seed, faults: FAULTS });
      const devices = DEVICE_IDS.map((id) => world.addDevice(id));
      const model = new Map();
      for (const op of operations) await apply(world, devices, model, op);
      await world.quiesce();

      const cloud = textMap(world.cloudFiles());
      for (const device of devices) assert.deepEqual(textMap(world.deviceFiles(device.id)), cloud);
      for (const [path, text] of model) assert.equal(cloud[path], text, path);
      for (const path of Object.keys(cloud)) {
        const isData = /\/f\d\.bin$/.test(path);
        if (isData) assert.ok(model.has(path), `unexpected file ${path}`);
      }
      assert.equal(world.log.filter((e) => e.type === "conflict").length, 0);
    }),
    { numRuns: 150 },
  );
});
