// Unit tests for the oracle, the checkers and the metrics on tiny hand-built
// cases. Every checker is also shown to FAIL on a deliberately broken input.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { yjsAdapter } from "../../src/adapters/yjs.js";
import { seal } from "../../src/engine/envelope.js";
import { chunkId } from "../../src/engine/coverage.js";
import { DEFAULT_OPTIONS } from "../../src/engine/constants.js";
import { importFixedKey, KEY_ID } from "../../src/harness/keys.js";
import { createOracle } from "../../src/harness/oracle.js";
import {
  checkContainment, checkConvergence, checkDeterminism, checkDigests, checkOracle, checkPacing, checkProgress,
  checkSingleWriter, createCompactionChecker, createIvTracker, isOwnPath, summarizeDiff,
} from "../../src/harness/checks.js";
import { computeLatency, computeMetrics, percentile } from "../../src/harness/metrics.js";
import { resolveProfile, PROFILES } from "../../src/harness/faults.js";
import { VARIANTS, getVariant } from "../../src/harness/variants.js";

// A Yjs doc plus the updates it emits.
function makeDoc() {
  const doc = new Y.Doc();
  const updates = [];
  doc.on("update", (u) => updates.push(u));
  return { doc, updates, set: (k, v) => doc.getMap("m").set(k, v) };
}

test("oracle applies every update and drops unsaved ones of a wiped device", () => {
  const oracle = createOracle({ adapter: yjsAdapter, tables: ["t"] });
  const a = makeDoc();
  const b = makeDoc();
  a.set("a1", 1);
  b.set("b1", 1);
  a.updates.forEach((bytes) => oracle.record({ device: "ann", table: "t", bytes, at: 1 }));
  b.updates.forEach((bytes) => oracle.record({ device: "bob", table: "t", bytes, at: 1 }));
  oracle.markSaved("ann", "t", 5);
  assert.deepEqual(Object.keys(oracle.json("t").m).sort(), ["a1", "b1"]);
  assert.equal(oracle.loseUnsaved("bob"), 1);
  assert.deepEqual(Object.keys(oracle.json("t").m), ["a1"]);
  assert.equal(oracle.loseUnsaved("ann"), 0, "saved updates survive a wipe");
});

test("checkConvergence and checkOracle pass on equal views and fail on a broken one", () => {
  const views = { a: { t: { x: 1 } }, b: { t: { x: 1 } } };
  assert.deepEqual(checkConvergence(views), []);
  assert.deepEqual(checkOracle(views, { t: { x: 1 } }), []);
  const broken = { ...views, b: { t: { x: 2 } } };
  assert.equal(checkConvergence(broken)[0].property, "P1");
  assert.equal(checkOracle(broken, { t: { x: 1 } })[0].property, "P2");
  assert.match(summarizeDiff({ a: 1 }, { a: 2 }), /expected 1 actual 2/);
});

test("checkContainment (P3) detects a lost update", () => {
  const writer = makeDoc();
  writer.set("k", 1);
  const restored = new Y.Doc();
  assert.equal(checkContainment({ adapter: yjsAdapter, restored: yjsAdapter.create(), updates: writer.updates, device: "d", table: "t" })[0].property, "P3");
  Y.applyUpdate(restored, writer.updates[0]);
  assert.deepEqual(checkContainment({ adapter: yjsAdapter, restored, updates: writer.updates, device: "d", table: "t" }), []);
});

test("checkSingleWriter (P8) accepts own paths and flags foreign writes and deletes", () => {
  assert.ok(isOwnPath("data/notes/ann-1/000001.ywb", "ann-1"));
  assert.ok(isOwnPath("status/ann-1.ywb", "ann-1"));
  assert.ok(!isOwnPath("status/bob-1.ywb", "ann-1"));
  const log = [
    { t: 1, type: "write", device: "ann-1", path: "data/notes/ann-1/000001.ywb", size: 3 },
    { t: 2, type: "download", device: "ann-1", path: "data/notes/bob-1/000001.ywb", size: 3 },
    { t: 3, type: "write", device: "ann-1", path: "data/notes/bob-1/000002.ywb", size: 3 },
    { t: 4, type: "delete", device: "ann-1", path: "status/bob-1.ywb", size: 3 },
  ];
  assert.deepEqual(checkSingleWriter(log.slice(0, 2)), []);
  assert.equal(checkSingleWriter(log).length, 2);
  assert.deepEqual(checkSingleWriter(log, { shared: true }), []);
  assert.deepEqual(checkSingleWriter(log, { ignore: (i) => i >= 2 }), []);
});

test("checkPacing and checkProgress (P9)", () => {
  const ok = [{ device: "a", instance: 1, at: 0, forced: false }, { device: "a", instance: 1, at: 30000, forced: false }];
  assert.deepEqual(checkPacing(ok, { minIntervalMs: 30000 }), []);
  const tooClose = [...ok, { device: "a", instance: 1, at: 40000, forced: false }];
  assert.equal(checkPacing(tooClose, { minIntervalMs: 30000 })[0].property, "P9");
  assert.deepEqual(checkPacing([...ok, { device: "a", instance: 1, at: 40000, forced: true }], { minIntervalMs: 30000 }), []);
  const bounds = { maxWaitMs: 180000, minIntervalMs: 30000, tickMs: 5000, endAt: 1e7 };
  const fast = { device: "a", table: "t", at: 0, saved: true, savedAt: 100000, instance: 1, savedInstance: 1, lost: false };
  const slow = { ...fast, savedAt: 400000 };
  assert.deepEqual(checkProgress([fast], bounds), []);
  assert.equal(checkProgress([slow], bounds)[0].property, "P9");
  const never = { ...fast, saved: false, savedAt: null, savedInstance: null };
  assert.equal(checkProgress([never], { ...bounds, liveInstances: new Set([1]) }).length, 1);
  assert.deepEqual(checkProgress([never], bounds), []);
});

test("checkDigests (P11)", () => {
  const status = (device, digest, applied = { a: 1 }) => ({ device, tables: { t: { applied, digest } } });
  assert.deepEqual(checkDigests([status("a", "x"), status("b", "x")], { a: { t: "x" } }), []);
  assert.equal(checkDigests([status("a", "x"), status("b", "y")])[0].property, "P11");
  assert.deepEqual(checkDigests([status("a", "x"), status("b", "y", { a: 2 })]), [], "different applied state may differ");
  assert.equal(checkDigests([status("a", "x")], { a: { t: "z" } })[0].property, "P11");
});

test("checkDeterminism (P12)", () => {
  const a = { traceHash: "1", content: "c" };
  assert.deepEqual(checkDeterminism(a, { ...a }), []);
  assert.equal(checkDeterminism(a, { ...a, traceHash: "2" })[0].property, "P12");
  assert.equal(checkDeterminism(a, { ...a, content: "d" })[0].property, "P12");
});

// ---- P16 ----------------------------------------------------------------------------

test("checkIvTracker (P16): one IV for different content is flagged, a fresh IV or an identical re-write is not", async () => {
  const key = await importFixedKey();
  const meta = { kind: "chunk" };
  const write = (n, updates) => seal({ key, keyId: KEY_ID, iv: new Uint8Array(12).fill(n), meta, updates });
  const tracker = createIvTracker();
  const record = (bytes, path) => tracker.record({ bytes, path, device: "ann-1" });
  const first = await write(1, [Uint8Array.of(1, 2, 3)]);
  assert.deepEqual(record(first, "data/t/ann-1/000001.ywb"), []);
  assert.deepEqual(record(await write(2, [Uint8Array.of(1, 2, 3, 4)]), "data/t/ann-1/000001.ywb"), [], "a new IV for the rewrite");
  assert.deepEqual(record(first, "data/t/ann-1/000001.ywb"), [], "the same bytes again are no reuse");
  const reused = record(await write(1, [Uint8Array.of(1, 2, 3, 4)]), "data/t/ann-1/000001.ywb");
  assert.equal(reused.length, 1);
  assert.equal(reused[0].property, "P16");
  assert.deepEqual(record(Uint8Array.of(1, 2, 3), "status/x"), [], "bytes that are not an envelope are ignored");
});

// ---- P4 on hand-built folder states ------------------------------------------------

async function p4Fixture() {
  const key = await importFixedKey();
  const keys = new Map([[KEY_ID, key]]);
  const iv = (n) => new Uint8Array(12).fill(n);
  const writer = makeDoc();
  writer.set("k", 1);
  const chunk = await seal({ key, keyId: KEY_ID, iv: iv(1), meta: { kind: "chunk", table: "t", adapter: "yjs", device: "bob-1", seq: 2 }, updates: writer.updates });
  const ids = { "bob-1": { 2: chunkId(chunk) } }; // the snapshot lists the exact version of chunk 2
  const snapOf = (updates, covers, n, listed = ids) => seal({ key, keyId: KEY_ID, iv: iv(n), meta: { kind: "snapshot", table: "t", adapter: "yjs", device: "ann-1", covers, ids: listed }, updates });
  const snap = await snapOf([yjsAdapter.snapshot(writer.doc)], { "bob-1": 2 }, 2);
  let statusCounter = 20; // every write gets a fresh IV, as in the engine (the checker caches by IV)
  const status = (device, snapshots, lastActiveAt) => seal({ key, keyId: KEY_ID, iv: iv(statusCounter++), meta: { kind: "status", device, lastActiveAt, tables: { t: { snapshots } } }, updates: [] });
  const options = { compaction: { ...DEFAULT_OPTIONS.compaction } };
  const checker = createCompactionChecker({ keys, options, adapters: { yjs: yjsAdapter }, deep: true });
  const snapPath = "data/t/ann-1/snap-20260101T000000Z.ywb";
  const now = Date.UTC(2026, 0, 3);
  const base = {
    device: "bob-1", path: "data/t/bob-1/000002.ywb", now,
    cloud: new Map([[snapPath, snap]]),
    local: new Map([["data/t/bob-1/000002.ywb", chunk], [snapPath, snap], ["status/ann-1.ywb", await status("ann-1", ["ann-1/snap-20260101T000000Z.ywb"], now - 1000)]]),
  };
  return { checker, base, snapPath, status, snapOf, now, chunk, writer, key, iv };
}

test("P4: a justified delete passes", async () => {
  const f = await p4Fixture();
  assert.deepEqual(await f.checker.check(f.base), []);
});

test("P4: no covering snapshot, unacknowledged, too young, foreign file, or non-covering content all fail", async () => {
  const f = await p4Fixture();
  const noSnap = { ...f.base, cloud: new Map(), local: new Map([...f.base.local].filter(([p]) => !p.includes("snap-"))) };
  assert.match((await f.checker.check(noSnap))[0].message, /no snapshot/);
  const unacked = { ...f.base, local: new Map([...f.base.local, ["status/ann-1.ywb", await f.status("ann-1", [], f.now - 1000)]]) };
  assert.match((await f.checker.check(unacked))[0].message, /not acknowledged/);
  const youngNow = Date.UTC(2026, 0, 1, 5);
  const young = { ...f.base, now: youngNow, local: new Map([...f.base.local, ["status/ann-1.ywb", await f.status("ann-1", ["ann-1/snap-20260101T000000Z.ywb"], youngNow - 1000)]]) };
  assert.match((await f.checker.check(young))[0].message, /only/);
  assert.match((await f.checker.check({ ...f.base, device: "ann-1" }))[0].message, /written by bob-1/);
  const empty = await f.snapOf([yjsAdapter.snapshot(new Y.Doc())], { "bob-1": 2 }, 9);
  const liar = { ...f.base, cloud: new Map([[f.snapPath, empty]]), local: new Map([...f.base.local, [f.snapPath, empty]]) };
  assert.match((await f.checker.check(liar))[0].message, /does not contain/);
});

test("P4: a snapshot that covers the chunk number but lists another version of it does not justify the delete", async () => {
  const f = await p4Fixture();
  const sealOther = (n) => seal({ key: f.key, keyId: KEY_ID, iv: f.iv(n), meta: { kind: "chunk", table: "t", adapter: "yjs", device: "bob-1", seq: 2 }, updates: f.writer.updates });
  const reused = await sealOther(5); // same number and content, but a different write of chunk 2
  assert.notEqual(chunkId(reused), chunkId(f.chunk));
  const reusedState = { ...f.base, local: new Map([...f.base.local, [f.base.path, reused]]) };
  assert.match((await f.checker.check(reusedState))[0].message, /no snapshot .* identity/);
  const noIds = await f.snapOf([yjsAdapter.snapshot(f.writer.doc)], { "bob-1": 2 }, 6, {});
  const unlisted = { ...f.base, cloud: new Map([[f.snapPath, noIds]]), local: new Map([...f.base.local, [f.snapPath, noIds]]) };
  assert.match((await f.checker.check(unlisted))[0].message, /no snapshot/);
});

test("P4: a conflict copy of a chunk is justified by the snapshot that lists its primary", async () => {
  const f = await p4Fixture();
  const copyPath = "data/t/bob-1/000002-ann-1.ywb";
  const copy = await seal({ key: f.key, keyId: KEY_ID, iv: f.iv(7), meta: { kind: "chunk", table: "t", adapter: "yjs", device: "bob-1", seq: 2 }, updates: f.writer.updates });
  const withCopy = { ...f.base, path: copyPath, local: new Map([...f.base.local, [copyPath, copy]]) };
  assert.deepEqual(await f.checker.check(withCopy), []);
});

test("P4: inactive devices do not have to acknowledge, active ones do", async () => {
  const f = await p4Fixture();
  const stale = new Map([...f.base.local, ["status/cy-1.ywb", await f.status("cy-1", [], f.now - 40 * 24 * 3600 * 1000)]]);
  assert.deepEqual(await f.checker.check({ ...f.base, local: stale }), []);
  const active = new Map([...f.base.local, ["status/cy-1.ywb", await f.status("cy-1", [], f.now - 1000)]]);
  assert.equal((await f.checker.check({ ...f.base, local: active })).length, 1);
});

// ---- metrics ---------------------------------------------------------------------

test("percentile and computeMetrics on a tiny log", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([], 50), null);
  const log = [
    { t: 100, type: "write", device: "a-1", path: "data/t/a-1/000001.ywb", size: 50 },
    { t: 100, type: "write", device: "a-1", path: "status/a-1.ywb", size: 30 },
    { t: 130, type: "download", device: "b-1", path: "data/t/a-1/000001.ywb", size: 50 },
    { t: 500, type: "delete", device: "a-1", path: "data/t/a-1/000001.ywb", size: 50 },
  ];
  const updates = [{ device: "a-1", table: "t", at: 40, saved: true, savedAt: 100, lost: false }];
  const received = [{ at: 160, instance: 7, observer: "b-1", table: "t", from: "a-1", writtenAt: 100 }];
  const sessions = [{ device: "a-1", instance: 1, start: 0, end: null }, { device: "b-1", instance: 7, start: 0, end: null }];
  const latency = computeLatency({ log, updates, received, sessions });
  assert.equal(latency.measured, 1);
  assert.equal(latency.total.p50, 120); // 160 - 40
  assert.equal(latency.excludingSync.p50, 90); // minus (130 - 100) transport
  assert.equal(computeLatency({ log, updates, received: [], sessions }).missed, 1);
  assert.equal(computeLatency({ log, updates, received, sessions: [sessions[0]] }).noObserver, 1);
  const stats = { cloudFiles: 2, cloudBytes: 80, peakCloudFiles: 3, bytesWritten: 80, bytesUploaded: 80 };
  const m = computeMetrics({ log, endStats: stats, finalStats: stats, updates, received, sessions, newDevice: { files: 2, bytes: 80 } });
  assert.equal(m.largestFile.bytes, 50);
  assert.equal(m.bytesByKind.status, 30);
  assert.equal(m.deletes, 1);
  assert.equal(m.cloudFilesPeak, 3);
});

test("fault profiles and variants resolve", () => {
  assert.deepEqual(Object.keys(PROFILES), ["none", "lag", "rough", "outage", "hostile"]);
  assert.throws(() => resolveProfile("nope"));
  assert.equal(getVariant("ack-none").options.compaction.ackRule, "none");
  assert.equal(VARIANTS.length, 10);
});
