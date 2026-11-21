// Small-seed smoke runs of the `short` scenario on the baseline variant, plus
// determinism (P12) and the end-to-end conflict check (P10).
//
// Every violation, P1, P2 and P11 included, fails the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSeed, runSeedTwice, describeViolation } from "../../src/harness/run.js";
import { runConflictCheck } from "../../src/harness/conflicts.js";

const SEEDS = Number(process.env.SIM_SMOKE_SEEDS ?? 4);

for (const faults of ["none", "rough"]) {
  test(`short / baseline / ${faults}: ${SEEDS} seeds run clean (every property)`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const run = await runSeed({ scenario: "short", variant: "baseline", faults, seed });
      assert.ok(run.actionLog.length > 20, "workload produced actions");
      assert.ok(run.metrics.updates > 0);
      assert.deepEqual(run.violations.map(describeViolation), [], `seed ${seed}`);
    }
  });
}

test("P12: the same seed gives the same trace hash and content", async () => {
  const run = await runSeedTwice({ scenario: "short", variant: "baseline", faults: "rough", seed: 5 });
  assert.deepEqual(run.violations.filter((v) => v.property === "P12"), []);
});

test("different seeds give different traces", async () => {
  const a = await runSeed({ scenario: "short", variant: "baseline", faults: "none", seed: 1 });
  const b = await runSeed({ scenario: "short", variant: "baseline", faults: "none", seed: 2 });
  assert.notEqual(a.traceHash, b.traceHash);
});

for (const variant of ["baseline"]) {
  test(`P10 end to end through the engine (${variant})`, async () => {
    const violations = await runConflictCheck({ variant, seed: 3 });
    assert.deepEqual(violations.filter((v) => v.property === "P10").map(describeViolation), []);
  });
}

// Minimal reproduction (found by shrinking short/baseline/none seed 3): a
// reader (dev 2) goes offline after reading chunk 1 while it was still open;
// the author rewrites chunk 1 and starts chunk 2; when the reader returns it
// sees chunk 2, treats chunk 1 as sealed and never re-reads it.
test("stale copy of a chunk that was sealed later is re-read (P1/P2)", async () => {
  const { createScenario } = await import("../../src/harness/scenario.js");
  const sc = await createScenario({ seed: 3, variant: "baseline", faults: "none", devices: 3, tables: 2 });
  const actions = [
    { type: "edit", dev: 0, table: 0, op: "set", rec: "r0", field: "title", value: "ember-40" },
    { type: "advance", ms: 12000 }, { type: "advance", ms: 23000 },
    { type: "edit", dev: 0, table: 0, op: "restore", rec: "r0" },
    { type: "end", dev: 0 }, { type: "start", dev: 0 },
    { type: "edit", dev: 0, table: 0, op: "remove", rec: "r0" },
    { type: "offline", dev: 2 }, { type: "advance", ms: 40000 },
  ];
  for (const a of actions) await sc.apply(a);
  await sc.finish({ newDevice: false });
  assert.deepEqual(sc.violations.map(describeViolation), []);
});
