// Unit tests for the P13, P14 and P15 checkers on tiny hand-built inputs, including broken ones,
// plus end-to-end runs of the properties through the simulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTraceTotals, checkAttribution, checkHealth, checkObservation, checkTraceTotals, emptyTraceTotals,
} from "../../src/harness/checks.js";
import { runSeed, runSeedObserved, describeViolation } from "../../src/harness/run.js";

const D = "ann-dev00000";
const step = (action, path, bytes, extra = {}) => ({ at: 100, table: "notes", path, action, bytes, durationMs: 0, result: "ok", error: null, ...extra });
const trace = (id, steps, extra = {}) => ({ id, device: D, kind: "save", startedAt: 100, endedAt: 100, steps, ...extra });
const entry = (type, path, size, extra = {}) => ({ t: 100, type, device: D, path, size, ...extra });
const P = "data/notes/ann-dev00000/000001.ywb";

// ---- P13 ------------------------------------------------------------------

test("P13: matching write and delete entries pass", () => {
  const traces = [trace(1, [step("write", P, 0, { result: "created" }), step("write", P, 50), step("delete", P, 50), step("read", P, 50)])];
  const entries = [entry("write", P, 0), entry("write", P, 50), entry("delete", P, 50)];
  assert.deepEqual(checkAttribution({ entries, traces }), []);
});

test("P13: a log entry no step accounts for is a violation", () => {
  const out = checkAttribution({ entries: [entry("write", P, 50)], traces: [trace(1, [])] });
  assert.equal(out.length, 1);
  assert.equal(out[0].property, "P13");
  assert.match(out[0].message, /in no trace step/);
});

test("P13: the size must match", () => {
  const out = checkAttribution({ entries: [entry("write", P, 50)], traces: [trace(1, [step("write", P, 51)])] });
  assert.equal(out.length, 2, "the entry is unmatched and the step has no entry");
});

test("P13: a delete step's size is the engine's last known size, so deletes match on path only", () => {
  assert.deepEqual(checkAttribution({ entries: [entry("delete", P, 375)], traces: [trace(1, [step("delete", P, 364)])] }), []);
});

test("P13: the path must match", () => {
  const out = checkAttribution({ entries: [entry("delete", P, 5)], traces: [trace(1, [step("delete", "data/notes/ann-dev00000/000002.ywb", 5)])] });
  assert.equal(out.length, 2);
});

test("P13: the device must match", () => {
  const out = checkAttribution({ entries: [entry("write", P, 5, { device: "bob-dev00001" })], traces: [trace(1, [step("write", P, 5)])] });
  assert.equal(out.length, 2);
});

test("P13: the entry must fall inside the trace's time window", () => {
  const late = entry("write", P, 5, { t: 500 });
  assert.equal(checkAttribution({ entries: [late], traces: [trace(1, [step("write", P, 5)], { startedAt: 100, endedAt: 200 })] }).length, 2);
  assert.deepEqual(checkAttribution({ entries: [late], traces: [trace(1, [step("write", P, 5)], { startedAt: 100, endedAt: 500 })] }), []);
});

test("P13: one step cannot account for two entries (exactly one)", () => {
  const out = checkAttribution({ entries: [entry("write", P, 5), entry("write", P, 5)], traces: [trace(1, [step("write", P, 5)])] });
  assert.equal(out.length, 1);
  assert.match(out[0].message, /in no trace step/);
});

test("P13: a successful step with no log entry is a violation; failed and missing steps are not", () => {
  const phantom = checkAttribution({ entries: [], traces: [trace(7, [step("write", P, 5)])] });
  assert.equal(phantom.length, 1);
  assert.match(phantom[0].message, /trace 7 records a write/);
  const harmless = [step("write", P, 5, { error: { name: "NoModificationAllowedError", message: "x" } }), step("delete", P, 0, { result: "missing" }), step("read", P, 5)];
  assert.deepEqual(checkAttribution({ entries: [], traces: [trace(1, harmless)] }), []);
});

test("P13 totals: what the traces counted must equal the simulator's counters", () => {
  const counts = { read: 2, stat: 3, write: 1, bytesRead: 40, bytesWritten: 9 };
  const totals = addTraceTotals(addTraceTotals(emptyTraceTotals(), { counts }), { counts });
  assert.deepEqual(totals, { reads: 10, filesRead: 4, bytesRead: 80, writes: 2, bytesWritten: 18 });
  assert.deepEqual(checkTraceTotals({ device: D, totals, counters: { ...totals } }), []);
  const out = checkTraceTotals({ device: D, totals, counters: { ...totals, filesRead: 5, bytesWritten: 19 } });
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.property === "P13"));
});

// ---- P14 ------------------------------------------------------------------

const peer = (extra = {}) => ({ active: true, ackedLatest: false, waitingSince: 0, ...extra });
const health = (extra = {}) => ({ state: "saved", pending: 0, peers: {}, ...extra });
const check = (h, extra = {}) => checkHealth({ health: h, device: D, at: 1_000_000, ackTimeoutMs: 600_000, lastSave: { outcome: "ok" }, ...extra });

test("P14: consistent reports pass", () => {
  assert.deepEqual(check(health()), []);
  assert.deepEqual(check(health({ state: "saving", pending: 2 })), []);
  assert.deepEqual(check(health({ state: "retrying", pending: 1 }), { lastSave: { outcome: "failed" } }), []);
  assert.deepEqual(check(health({ state: "retrying", pending: 1 }), { lastSave: { outcome: "partial" } }), []);
  assert.deepEqual(check(health({ state: "not-reaching-peers", peers: { x: peer() } })), []);
});

test("P14: saved while updates are pending is a violation", () => {
  const out = check(health({ pending: 3 }));
  assert.equal(out.length, 1);
  assert.match(out[0].message, /3 updates are still pending/);
});

test("P14: saving with nothing pending is a violation", () => {
  assert.equal(check(health({ state: "saving", pending: 0 })).length, 1);
});

test("P14: retrying needs a failed last save", () => {
  assert.equal(check(health({ state: "retrying", pending: 1 }), { lastSave: { outcome: "ok" } }).length, 1);
  assert.equal(check(health({ state: "retrying", pending: 1 }), { lastSave: null }).length, 1);
  assert.deepEqual(check(health({ state: "retrying", pending: 1 }), { lastSave: null, level: "off" }), [], "no traces to check against at level off");
});

test("P14: while the last save failed and updates are pending, the state must be retrying", () => {
  const failed = { outcome: "partial", failed: true };
  assert.deepEqual(check(health({ state: "retrying", pending: 1 }), { lastSave: failed }), []);
  const out = check(health({ state: "saving", pending: 1 }), { lastSave: failed });
  assert.equal(out.length, 1);
  assert.match(out[0].message, /should be retrying/);
  assert.equal(check(health({ pending: 1 }), { lastSave: failed }).length, 2, "saved with updates pending is also wrong in its own right");
  assert.deepEqual(check(health({ state: "saving", pending: 1 }), { lastSave: { outcome: "partial", failed: false } }), [], "a save with a harmless step error did not fail");
  assert.deepEqual(check(health(), { lastSave: failed }), [], "nothing pending: nothing to retry");
});

test("P14: not-reaching-peers needs an active peer that has not acknowledged for longer than the timeout", () => {
  assert.equal(check(health({ state: "not-reaching-peers" })).length, 1, "no peers at all");
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ active: false }) } })).length, 1, "only an inactive peer");
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ ackedLatest: true, waitingSince: null }) } })).length, 1, "the peer acknowledged");
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ waitingSince: 500_000 }) } })).length, 1, "not yet 10 minutes");
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ waitingSince: 400_000 }) } })).length, 1, "exactly 10 minutes is not longer than 10 minutes");
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ waitingSince: 399_999 }) } })).length, 0);
  assert.equal(check(health({ state: "not-reaching-peers", peers: { x: peer({ waitingSince: 399_999 }), y: peer({ ackedLatest: true, waitingSince: null }) } })).length, 1, "one peer did acknowledge");
  assert.equal(check(health({ state: "not-reaching-peers", pending: 1, peers: { x: peer() } })).length, 1);
});

test("P14: saved although every active peer is overdue is a violation", () => {
  const out = check(health({ peers: { x: peer({ waitingSince: 0 }) } }));
  assert.equal(out.length, 1);
  assert.match(out[0].message, /acknowledged our latest chunk for over/);
  assert.deepEqual(check(health({ peers: { x: peer({ active: false }) } })), []);
});

test("P14: states with no cause in a simulation, and unknown states, are violations", () => {
  assert.equal(check(health({ state: "offline" })).length, 1);
  assert.equal(check(health({ state: "folder-disconnected" })).length, 1);
  assert.equal(check(health({ state: "folder-disconnected" }), { allowed: ["folder-disconnected"] }).length, 0);
  assert.equal(check(health({ state: "confused" })).length, 1);
});

// ---- P15 ------------------------------------------------------------------

test("P15: identical hash and content pass; any difference is a violation", () => {
  const run = { traceHash: "a".repeat(64), content: "c1" };
  assert.deepEqual(checkObservation(run, { ...run }), []);
  const hash = checkObservation(run, { ...run, traceHash: "b".repeat(64) }, { levels: ["full", "off"] });
  assert.equal(hash.length, 1);
  assert.match(hash[0].message, /levels full and off/);
  assert.equal(checkObservation(run, { ...run, content: "c2" }).length, 1);
  assert.equal(checkObservation(run, { traceHash: "x", content: "y" }).length, 2);
});

// ---- end to end ---------------------------------------------------------------

test("P13 to P15 hold on real runs, and a seed has the same log at trace level off, summary and full", async () => {
  const levels = {};
  for (const trace of ["off", "summary", "full"]) {
    levels[trace] = await runSeed({ scenario: "short", variant: "baseline", faults: "rough", seed: 3, trace });
    assert.deepEqual(levels[trace].violations.map(describeViolation), []);
  }
  assert.equal(levels.off.traceHash, levels.full.traceHash);
  assert.equal(levels.summary.traceHash, levels.full.traceHash);
  assert.equal(levels.off.content, levels.full.content);
  const observed = await runSeedObserved({ scenario: "short", variant: "reuse-chunk", faults: "hostile", seed: 2 });
  assert.deepEqual(observed.violations.map(describeViolation), []);
});

test("the checkers catch an engine that does I/O outside its traces", async () => {
  const { createScenario } = await import("../../src/harness/scenario.js");
  const sc = await createScenario({ seed: 1, variant: "baseline", faults: "none", devices: 2, tables: 1 });
  await sc.apply({ type: "edit", dev: 0, table: 0, op: "set", rec: "r0", field: "title", value: "x" });
  await sc.apply({ type: "advance", ms: 60000 });
  // a write behind the engine's back, as if it had bypassed the traced folder
  const dev = sc.devices[0];
  const handle = await (await (await dev.root.getDirectoryHandle("data")).getDirectoryHandle("t0".replace("t0", sc.tableNames[0]))).getDirectoryHandle(dev.id);
  const file = await handle.getFileHandle("999999.ywb", { create: true });
  const w = await file.createWritable();
  await w.write(new Uint8Array(7));
  await w.close();
  await sc.apply({ type: "advance", ms: 5000 });
  const p13 = sc.violations.filter((v) => v.property === "P13");
  assert.ok(p13.length >= 2, "the creation and the write are both unattributed");
  assert.ok(p13.some((v) => v.path?.endsWith("999999.ywb")));
});
