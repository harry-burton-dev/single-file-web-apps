import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../../src/sim/world.js";
import { EPOCH_MS } from "../../src/sim/clock.js";
import { newWorld, textOf, textMap, writeFile, readFile, removeFile } from "./helpers.js";

const LAGS = { uploadLagMs: 1000, downloadLagMs: 2000 };

test("write is local at once, reaches the cloud after the upload lag, others after the download lag", async () => {
  const { world, a, b } = newWorld({ faults: LAGS });
  await writeFile(a, "f.txt", "hello");
  assert.equal(textOf(await readFile(a, "f.txt")), "hello");
  assert.equal(world.cloudFiles().size, 0);
  await world.advance(999);
  assert.equal(world.cloudFiles().size, 0);
  await world.advance(1);
  assert.equal(textOf(world.cloudFiles().get("f.txt")), "hello");
  assert.equal(world.deviceFiles(b.id).size, 0);
  await world.advance(1999);
  assert.equal(world.deviceFiles(b.id).size, 0);
  await world.advance(1);
  assert.equal(textOf(world.deviceFiles(b.id).get("f.txt")), "hello");
});

test("lastModified: writer sees write time, receiver sees arrival time", async () => {
  const { world, a, b } = newWorld({ faults: LAGS });
  await world.advance(500);
  await writeFile(a, "f.txt", "x");
  const own = await (await a.root.getFileHandle("f.txt")).getFile();
  assert.equal(own.lastModified, EPOCH_MS + 500);
  await world.advance(3000);
  const received = await (await b.root.getFileHandle("f.txt")).getFile();
  assert.equal(received.lastModified, EPOCH_MS + 500 + 3000);
});

test("nothing is delivered before advance, even with zero lags", async () => {
  const { world, a } = newWorld();
  await writeFile(a, "f.txt", "x");
  assert.equal(world.cloudFiles().size, 0);
  await world.advance(0);
  assert.equal(world.cloudFiles().size, 1);
});

test("the clock moves with advance and the log is in time order", async () => {
  const { world, a, b } = newWorld({ seed: 5, faults: { uploadLagMs: [0, 4000], downloadLagMs: [0, 4000] } });
  for (let i = 0; i < 12; i++) {
    await writeFile(i % 2 ? a : b, `d${i % 2}/f${i}.txt`, `v${i}`);
    await world.advance(700);
  }
  await world.quiesce();
  const times = world.log.map((e) => e.t);
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
  assert.ok(world.clock.now() >= EPOCH_MS + 12 * 700);
});

test("per path ordering is preserved despite wide random lags", async () => {
  for (const seed of ["p1", "p2", "p3", "p4"]) {
    const { world, a, b } = newWorld({ seed, faults: { uploadLagMs: [0, 9000], downloadLagMs: [0, 9000] } });
    for (let i = 0; i < 10; i++) {
      await writeFile(a, "f.txt", `v${i}`);
      await world.advance(100);
    }
    await world.quiesce();
    assert.equal(textOf(world.deviceFiles(b.id).get("f.txt")), "v9", `seed ${seed}`);
  }
});

test("per path ordering: delete after write never resurrects the file", async () => {
  for (const seed of ["d1", "d2", "d3", "d4", "d5"]) {
    const { world, a, b } = newWorld({ seed, faults: { uploadLagMs: [0, 9000], downloadLagMs: [0, 9000] } });
    await writeFile(a, "f.txt", "x");
    await world.advance(10);
    await removeFile(a, "f.txt");
    await world.quiesce();
    assert.equal(world.cloudFiles().size, 0, `seed ${seed}`);
    assert.equal(world.deviceFiles(b.id).size, 0, `seed ${seed}`);
  }
});

test("a delete of one file can arrive before an earlier create of another", async () => {
  let observed = false;
  for (let n = 0; n < 40 && !observed; n++) {
    const { world, a, b } = newWorld({ seed: `x${n}`, faults: { uploadLagMs: [0, 8000], downloadLagMs: [0, 8000] } });
    await writeFile(a, "old.txt", "old");
    await world.quiesce();
    world.setFaults({ uploadLagMs: [0, 8000], downloadLagMs: [0, 8000] });
    await writeFile(a, "new.txt", "new"); // created first
    await world.advance(1);
    await removeFile(a, "old.txt"); // deleted second
    await world.advance(0);
    await world.quiesce();
    const arrivals = world.log.filter((e) => e.type === "download" && e.device === b.id).slice(-3);
    const deleteIndex = arrivals.findIndex((e) => e.path === "old.txt" && e.detail === "delete");
    const createIndex = arrivals.findIndex((e) => e.path === "new.txt" && e.size === 3);
    observed = deleteIndex >= 0 && createIndex >= 0 && deleteIndex < createIndex;
    assert.deepEqual(textMap(world.deviceFiles(b.id)), { "new.txt": "new" });
  }
  assert.ok(observed, "expected at least one seed where the delete overtook the create");
});

test("offline device keeps working locally; traffic is queued and delivered on return", async () => {
  const { world, a, b } = newWorld({ faults: LAGS });
  world.setOnline(b.id, false);
  await writeFile(a, "from-a.txt", "A");
  await writeFile(b, "from-b.txt", "B");
  assert.equal(textOf(await readFile(b, "from-b.txt")), "B");
  await world.advance(60_000);
  assert.deepEqual(textMap(world.cloudFiles()), { "from-a.txt": "A" });
  assert.deepEqual(textMap(world.deviceFiles(b.id)), { "from-b.txt": "B" });
  world.setOnline(b.id, true);
  await world.advance(0);
  assert.deepEqual(textMap(world.cloudFiles()), { "from-a.txt": "A", "from-b.txt": "B" });
  await world.advance(10_000);
  assert.deepEqual(textMap(world.deviceFiles(a.id)), { "from-a.txt": "A", "from-b.txt": "B" });
  assert.deepEqual(textMap(world.deviceFiles(b.id)), { "from-a.txt": "A", "from-b.txt": "B" });
});

test("an offline device applies queued changes to one path in order", async () => {
  const { world, a, b } = newWorld({ faults: LAGS });
  world.setOnline(b.id, false);
  await writeFile(a, "f.txt", "1");
  await world.advance(5000);
  await writeFile(a, "f.txt", "2");
  await world.advance(5000);
  await removeFile(a, "f.txt");
  await writeFile(a, "f.txt", "3");
  await world.advance(5000);
  world.setOnline(b.id, true);
  await world.advance(10_000);
  assert.equal(textOf(world.deviceFiles(b.id).get("f.txt")), "3");
});

test("setOnline on an unknown device throws", () => {
  const { world } = newWorld();
  assert.throws(() => world.setOnline("nobody", true), /unknown device/);
});

test("quiesce delivers everything and leaves all views equal to the cloud", async () => {
  const { world, a, b } = newWorld({
    seed: 11,
    faults: {
      uploadLagMs: [0, 5000],
      downloadLagMs: [0, 5000],
      partialArrival: { probability: 0.5 },
      crswap: { probability: 0.5, leftBehindProbability: 0.5 },
      junk: { probability: 0.5 },
    },
  });
  const c = world.addDevice("cara-cccccccc");
  world.setOnline(c.id, false);
  for (let i = 0; i < 8; i++) {
    await writeFile(a, `data/a/f${i}.bin`, `a${i}`);
    await writeFile(b, `data/b/f${i}.bin`, `b${i}`);
    await writeFile(c, `data/c/f${i}.bin`, `c${i}`);
    await world.advance(300);
  }
  await world.quiesce();
  const cloud = textMap(world.cloudFiles());
  for (const device of [a, b, c]) assert.deepEqual(textMap(world.deviceFiles(device.id)), cloud);
  assert.equal(cloud["data/c/f7.bin"], "c7");
});

test("faults stay off after quiesce until setFaults is called", async () => {
  const { world, a } = newWorld({ faults: { writeFailure: { probability: 1 } } });
  await world.quiesce();
  await writeFile(a, "ok.txt", "fine");
  world.setFaults({ writeFailure: { probability: 1 } });
  await assert.rejects(writeFile(a, "no.txt", "x"), { name: "NoModificationAllowedError" });
});

test("a new device receives everything already in the cloud", async () => {
  const { world, a } = newWorld({ faults: LAGS });
  await writeFile(a, "d/one.txt", "1");
  await writeFile(a, "two.txt", "2");
  await world.quiesce();
  const late = world.addDevice("dave-dddddddd");
  assert.equal(world.deviceFiles(late.id).size, 0);
  await world.quiesce();
  assert.deepEqual(textMap(world.deviceFiles(late.id)), { "d/one.txt": "1", "two.txt": "2" });
});

test("wipeFolder empties the cloud and every view and drops pending events", async () => {
  const { world, a, b } = newWorld({ faults: LAGS });
  await writeFile(a, "one.txt", "1");
  await world.advance(10_000);
  await writeFile(a, "pending.txt", "p"); // still in flight
  world.wipeFolder();
  assert.equal(world.cloudFiles().size, 0);
  assert.equal(world.deviceFiles(a.id).size, 0);
  assert.equal(world.deviceFiles(b.id).size, 0);
  await world.quiesce();
  assert.equal(world.cloudFiles().size, 0);
  await writeFile(b, "again.txt", "z");
  await world.quiesce();
  assert.deepEqual(textMap(world.deviceFiles(a.id)), { "again.txt": "z" });
});

test("removeLocalFile propagates by default and can be local only", async () => {
  const { world, a, b } = newWorld();
  await writeFile(a, "f.txt", "1");
  await writeFile(a, "g.txt", "2");
  await world.quiesce();
  world.removeLocalFile(b.id, "f.txt", { propagate: false });
  assert.equal(world.deviceFiles(b.id).has("f.txt"), false);
  await world.quiesce();
  assert.equal(world.cloudFiles().has("f.txt"), true);
  world.removeLocalFile(b.id, "g.txt");
  await world.quiesce();
  assert.equal(world.cloudFiles().has("g.txt"), false);
  assert.throws(() => world.removeLocalFile(b.id, "missing.txt"), { name: "NotFoundError" });
  assert.ok(world.log.every((e) => e.type !== "delete"), "removeLocalFile is logged as a fault, not an engine delete");
});

test("log entries carry the device that wrote or deleted", async () => {
  const { world, a, b } = newWorld();
  await writeFile(a, "data/x/alice/c.bin", "abc");
  await removeFile(b, "nothing").catch(() => {});
  await world.quiesce();
  await removeFile(b, "data/x/alice/c.bin");
  const write = world.log.find((e) => e.type === "write" && e.size === 3);
  assert.equal(write.device, a.id);
  assert.equal(write.path, "data/x/alice/c.bin");
  const del = world.log.find((e) => e.type === "delete");
  assert.equal(del.device, b.id);
  assert.ok(world.log.some((e) => e.type === "upload" && e.device === a.id));
  assert.ok(world.log.some((e) => e.type === "download" && e.device === b.id));
});

test("stats count files, bytes, uploads and reads", async () => {
  const { world, a, b } = newWorld();
  await writeFile(a, "one.bin", new Uint8Array(10));
  await writeFile(a, "two.bin", new Uint8Array(5));
  await world.quiesce();
  await writeFile(a, "one.bin", new Uint8Array(3));
  await removeFile(a, "two.bin");
  await world.quiesce();
  await readFile(b, "one.bin");
  const s = world.stats();
  assert.equal(s.cloudFiles, 1);
  assert.equal(s.cloudBytes, 3);
  assert.equal(s.peakCloudFiles, 2);
  assert.equal(s.bytesWritten, 18);
  assert.equal(s.bytesUploaded, 18);
  assert.equal(s.perDevice[a.id].bytesWritten, 18);
  assert.equal(s.perDevice[a.id].writes, 5); // two creations + three closes
  assert.equal(s.perDevice[b.id].reads, 2); // getFile + arrayBuffer
  assert.equal(s.perDevice[b.id].bytesRead, 3);
  assert.equal(s.perDevice[b.id].filesRead, 1);
  assert.equal(s.perDevice[a.id].reads, 0);
});

test("a device that writes a file it did not own keeps counting per device", async () => {
  const world = createWorld({ seed: 1 });
  const solo = world.addDevice("solo-00000000");
  await writeFile(solo, "a.txt", "1");
  assert.equal(world.stats().perDevice[solo.id].writes, 2);
});
