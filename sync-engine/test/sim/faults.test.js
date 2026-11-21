import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, conflictCopyPath } from "../../src/sim/world.js";
import { DEFAULT_FAULTS, resolveFaults } from "../../src/sim/faults.js";
import { newWorld, textOf, textMap, writeFile, readFile, rejectsWithName } from "./helpers.js";

async function names(dir) {
  const out = [];
  for await (const [name] of dir.entries()) out.push(name);
  return out;
}

test("all faults default to off", () => {
  const faults = resolveFaults();
  assert.deepEqual(faults.uploadLagMs, [0, 0]);
  assert.deepEqual(faults.downloadLagMs, [0, 0]);
  for (const key of ["partialArrival", "conflictCopy", "crswap", "writeFailure", "readFailure", "junk"]) {
    assert.equal(faults[key].probability, 0, key);
  }
  assert.equal(DEFAULT_FAULTS.junk.probability, 0);
});

test("fault config is validated", () => {
  assert.throws(() => resolveFaults({ nonsense: 1 }), /unknown fault option/);
  assert.throws(() => resolveFaults({ junk: { chance: 1 } }), /unknown fault option/);
  assert.throws(() => resolveFaults({ junk: { probability: 2 } }), RangeError);
  assert.throws(() => resolveFaults({ uploadLagMs: [5, 1] }), RangeError);
  assert.deepEqual(resolveFaults({ uploadLagMs: 7 }).uploadLagMs, [7, 7]);
});

test("(a) lag ranges: arrival times stay inside the configured range and vary", async () => {
  const { world, a } = newWorld({ seed: 3, faults: { uploadLagMs: [1000, 3000] } });
  const arrivals = new Set();
  for (let i = 0; i < 30; i++) {
    await writeFile(a, `f${i}.txt`, "x");
  }
  await world.advance(3000);
  for (const e of world.log.filter((entry) => entry.type === "upload" && entry.size === 1)) {
    assert.ok(e.t >= world.clock.now() - 3000 + 1000);
    arrivals.add(e.t);
  }
  assert.ok(arrivals.size > 3, "lags should differ between files");
  assert.equal(world.cloudFiles().size, 30);
});

test("(b) partial arrival: truncated prefix first, complete later", async () => {
  const { world, a, b } = newWorld({ faults: { partialArrival: { probability: 1, durationMs: [5000, 5000] } } });
  const full = "0123456789abcdef";
  await writeFile(a, "f.txt", full);
  await world.advance(0);
  const partial = textOf(world.deviceFiles(b.id).get("f.txt"));
  assert.ok(partial.length < full.length);
  assert.ok(full.startsWith(partial));
  assert.equal((await (await b.root.getFileHandle("f.txt")).getFile()).size, partial.length);
  await world.advance(4999);
  assert.ok(textOf(world.deviceFiles(b.id).get("f.txt")).length < full.length);
  await world.advance(1);
  assert.equal(textOf(world.deviceFiles(b.id).get("f.txt")), full);
  assert.ok(world.log.some((e) => e.type === "fault" && e.detail === "partialArrival"));
});

test("(b) a newer version arriving during a partial window wins", async () => {
  const { world, a, b } = newWorld({ faults: { partialArrival: { probability: 1, durationMs: [5000, 5000] } } });
  await writeFile(a, "f.txt", "first-version-long");
  await world.advance(100);
  await writeFile(a, "f.txt", "second-version-long");
  await world.quiesce();
  assert.equal(textOf(world.deviceFiles(b.id).get("f.txt")), "second-version-long");
});

test("(d) conflict copy: cloud keeps the existing file, incoming is stored under a device-named copy", async () => {
  const { world, a, b } = newWorld({
    faults: { uploadLagMs: 100, downloadLagMs: 10_000, conflictCopy: { probability: 1 } },
  });
  await writeFile(a, "d/f.txt", "from-alice");
  await world.advance(100); // alice's file is in the cloud, bob has not seen it
  await writeFile(b, "d/f.txt", "from-bob");
  await world.advance(200); // let bob's uploads land while the fault is still on (quiesce turns faults off first)
  await world.quiesce();
  const expected = { "d/f.txt": "from-alice", "d/f-BOB-BBBBBBBB.txt": "from-bob" };
  assert.deepEqual(textMap(world.cloudFiles()), expected);
  assert.deepEqual(textMap(world.deviceFiles(a.id)), expected);
  assert.deepEqual(textMap(world.deviceFiles(b.id)), expected); // bob's original replaced by the cloud version
  const conflict = world.log.find((e) => e.type === "conflict");
  assert.deepEqual([conflict.device, conflict.path], [b.id, "d/f-BOB-BBBBBBBB.txt"]);
});

test("(d) without the conflict fault the last upload wins", async () => {
  const { world, a, b } = newWorld({ faults: { uploadLagMs: 100, downloadLagMs: 10_000 } });
  await writeFile(a, "f.txt", "from-alice");
  await world.advance(100);
  await writeFile(b, "f.txt", "from-bob");
  await world.quiesce();
  assert.deepEqual(textMap(world.cloudFiles()), { "f.txt": "from-bob" });
});

test("(d) conflict copy naming", () => {
  assert.equal(conflictCopyPath("a/b/notes.ywb", "harry-aaaaaaaa"), "a/b/notes-HARRY-AAAAAAAA.ywb");
  assert.equal(conflictCopyPath("noext", "x-1"), "noext-X-1");
  assert.equal(conflictCopyPath("a.b.c", "x-1"), "a.b-X-1.c");
});

test("(e) .crswap exists beside the target while a writable is open and is removed on close", async () => {
  const { world, a } = newWorld({ faults: { crswap: { probability: 1, leftBehindProbability: 0 } } });
  const handle = await a.root.getFileHandle("f.txt", { create: true });
  const writable = await handle.createWritable();
  assert.deepEqual(await names(a.root), ["f.txt", "f.txt.crswap"]);
  await writable.write("x");
  await writable.close();
  assert.deepEqual(await names(a.root), ["f.txt"]);
  const second = await handle.createWritable();
  await second.abort();
  assert.deepEqual(await names(a.root), ["f.txt"]);
  await world.quiesce();
  assert.deepEqual([...world.cloudFiles().keys()], ["f.txt"]);
});

test("(e) .crswap left behind after close syncs to others", async () => {
  const { world, a, b } = newWorld({ faults: { crswap: { probability: 1, leftBehindProbability: 1 } } });
  await writeFile(a, "d/f.txt", "payload");
  assert.deepEqual(await names(await a.root.getDirectoryHandle("d")), ["f.txt", "f.txt.crswap"]);
  await world.quiesce();
  assert.deepEqual([...world.deviceFiles(b.id).keys()], ["d/f.txt", "d/f.txt.crswap"]);
  assert.ok(world.log.some((e) => e.type === "fault" && e.detail === "crswapLeftBehind"));
});

test("(f) write failure: close rejects with NoModificationAllowedError and the target is unchanged", async () => {
  const { world, a } = newWorld();
  await writeFile(a, "f.txt", "original");
  await world.quiesce();
  world.setFaults({ writeFailure: { probability: 1 } });
  const handle = await a.root.getFileHandle("f.txt");
  const writable = await handle.createWritable();
  await writable.write("replacement");
  assert.equal(await rejectsWithName(writable.close(), "NoModificationAllowedError"), undefined);
  assert.equal(textOf(await readFile(a, "f.txt")), "original");
  await world.advance(10_000);
  assert.equal(textOf(world.cloudFiles().get("f.txt")), "original");
  assert.equal(world.stats().bytesWritten, "original".length);
});

test("(g) read failure: the first read of a newly arrived file fails, the retry works", async () => {
  const { world, a, b } = newWorld({ faults: { readFailure: { probability: 1 } } });
  await writeFile(a, "f.txt", "content");
  await world.advance(0);
  const handle = await b.root.getFileHandle("f.txt");
  let failure;
  try {
    const file = await handle.getFile();
    await file.arrayBuffer();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.name, "NotReadableError");
  assert.equal(textOf(await readFile(b, "f.txt")), "content");
  assert.equal(world.stats().perDevice[b.id].filesRead, 1);
});

test("(g) both getFile and arrayBuffer can be the failing call", async () => {
  const failing = new Set();
  for (let n = 0; n < 20; n++) {
    const { world, a, b } = newWorld({ seed: `r${n}`, faults: { readFailure: { probability: 1 } } });
    await writeFile(a, "f.txt", "content");
    await world.advance(0);
    const handle = await b.root.getFileHandle("f.txt");
    try {
      const file = await handle.getFile();
      failing.add("arrayBuffer");
      await assert.rejects(file.arrayBuffer(), { name: "NotReadableError" });
    } catch (error) {
      if (error.name !== "NotReadableError") throw error;
      failing.add("getFile");
    }
  }
  assert.deepEqual([...failing].sort(), ["arrayBuffer", "getFile"]);
});

test("(h) junk files appear in the folder of a written file and sync", async () => {
  const { world, a, b } = newWorld({ seed: 9, faults: { junk: { probability: 1 } } });
  for (let i = 0; i < 12; i++) await writeFile(a, `data/t/f${i}.bin`, "x");
  await world.quiesce();
  const junk = world.log.filter((e) => e.type === "fault" && e.detail === "junk");
  assert.equal(junk.length, 12);
  for (const entry of junk) {
    assert.match(entry.path, /^data\/t\/(desktop\.ini|~\$temp|[0-9a-f]{6}\.tmp)$/);
    assert.ok(world.deviceFiles(b.id).has(entry.path));
  }
  assert.ok(new Set(junk.map((e) => e.path.split("/").pop().replace(/[0-9a-f]{6}/, "H"))).size >= 2);
});

test("every fault enabled at once still converges after quiesce", async () => {
  const world = createWorld({
    seed: 77,
    faults: {
      uploadLagMs: [0, 4000],
      downloadLagMs: [0, 4000],
      partialArrival: { probability: 0.5 },
      conflictCopy: { probability: 0.5 },
      crswap: { probability: 0.5, leftBehindProbability: 0.5 },
      writeFailure: { probability: 0.2 },
      readFailure: { probability: 0.5 },
      junk: { probability: 0.3 },
    },
  });
  const devices = ["a-1", "b-2", "c-3"].map((id) => world.addDevice(id));
  for (let i = 0; i < 30; i++) {
    const device = devices[i % 3];
    await writeFile(device, `data/${device.id}/f${i % 5}.bin`, `v${i}`).catch((error) => {
      assert.equal(error.name, "NoModificationAllowedError");
    });
    await world.advance(250);
  }
  await world.quiesce();
  const cloud = textMap(world.cloudFiles());
  for (const device of devices) assert.deepEqual(textMap(world.deviceFiles(device.id)), cloud);
});
