// A clock that runs ahead and is then corrected leaves stored absolute times
// (last save, last scan, ...) in the future. Work must resume within the
// normal intervals, and a future-dated snapshot must not block compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const DAY = 86400000;
const set = (e, k, v) => e.table("notes").getMap("m").set(k, v);

/** A device clock that is the shared clock plus a mutable offset. */
const skewed = (w, offset) => ({ now: () => w.clock.now() + offset.ms });

test("saving resumes within minutes after the clock ran a year ahead and was corrected", async () => {
  const w = await makeWorld();
  const offset = { ms: 0 };
  const a = await w.device(A, { clock: skewed(w, offset) });
  const b = await w.device(S);
  offset.ms = 365 * DAY;
  set(a, "future", 1);
  await w.run([a, b], 15000);
  offset.ms = 0;

  set(a, "after-fix", 2);
  await w.run([a, b], 300000);

  assert.equal(a.status().pending, 0);
  assert.equal(json(b).m["after-fix"], 2);
});

test("scanning resumes within minutes after the clock ran a year ahead and was corrected", async () => {
  const w = await makeWorld();
  const offset = { ms: 0 };
  const a = await w.device(A, { clock: skewed(w, offset) });
  const b = await w.device(S);
  offset.ms = 365 * DAY;
  await w.run([a, b], 15000);
  offset.ms = 0;

  set(b, "from-b", 1);
  await w.run([a, b], 300000);

  assert.equal(json(a).m?.["from-b"], 1);
});

test("a retry time set while the clock was ahead does not freeze saving after the correction", async () => {
  const w = await makeWorld();
  const offset = { ms: 0 };
  let failWrites = true;
  const failing = (node) => new Proxy(node, {
    get(t, p) {
      if (p === "getDirectoryHandle") return async (n, o) => failing(await t.getDirectoryHandle(n, o));
      if (p === "getFileHandle") return async (n, o) => {
        if (failWrites && o?.create) throw Object.assign(new Error("locked"), { name: "NoModificationAllowedError" });
        return t.getFileHandle(n, o);
      };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const a = await w.device(A, { clock: skewed(w, offset), root: failing(w.folder.root) });
  a.on("error", () => {});
  offset.ms = 365 * DAY;
  set(a, "x", 1);
  await w.run([a], 20000); // fails, retryAt is a year ahead of the real clock
  offset.ms = 0;
  failWrites = false;

  await w.run([a], 600000);

  assert.equal(a.status().pending, 0);
});

test("a snapshot stamped a year ahead does not stop another device from writing a snapshot", async () => {
  const opts = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };
  const w = await makeWorld({ options: opts });
  const offset = { ms: 365 * DAY };
  const a = await w.device(A, { clock: skewed(w, offset) });
  const b = await w.device(S);
  for (let i = 0; i < 8; i++) {
    set(a, `k${i}`, i);
    await w.run([a, b], 6000);
  }
  await w.run([a, b], 30000);
  await a.close();
  w.clock.advance(10 * DAY);
  for (let i = 0; i < 12; i++) {
    set(b, `b${i}`, i);
    await w.run([b], 6000);
  }

  await w.run([b], 60000);

  assert.ok(w.folder.paths(`data/notes/${S}/snap-`).length >= 1, "sam never wrote a snapshot");
});
