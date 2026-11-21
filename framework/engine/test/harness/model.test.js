// Model-based property test: random action sequences against the real engine
// (fast-check shrinks failing sequences). Asserts P1, P2, P7 and P8 (plus no
// harness errors). Raise the number of runs with SIM_FC_RUNS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createScenario, formatAction } from "../../src/harness/scenario.js";
import { describeViolation } from "../../src/harness/run.js";

const RUNS = Number(process.env.SIM_FC_RUNS ?? 25);
const dev = fc.integer({ min: 0, max: 1 }); // two devices keep the state space small
const table = fc.integer({ min: 0, max: 1 });
const rec = fc.constantFrom("r0", "r1", "r2");
const word = fc.string({ minLength: 1, maxLength: 5 });
const edit = (fields) => fc.record({ type: fc.constant("edit"), dev, table, rec, ...fields });

const actionArb = fc.oneof(
  { weight: 8, arbitrary: edit({ op: fc.constant("set"), field: fc.constantFrom("title", "n"), value: word }) },
  { weight: 6, arbitrary: edit({ op: fc.constant("ask"), value: word }) },
  { weight: 6, arbitrary: edit({ op: fc.constant("text"), pos: fc.integer({ min: 0, max: 30 }), del: fc.integer({ min: 0, max: 4 }), ins: word }) },
  { weight: 2, arbitrary: edit({ op: fc.constantFrom("remove", "restore") }) },
  { weight: 2, arbitrary: edit({ op: fc.constant("resolve"), pick: fc.integer({ min: 0, max: 3 }), value: word }) },
  { weight: 12, arbitrary: fc.record({ type: fc.constant("advance"), ms: fc.constantFrom(1000, 5000, 12000, 23000, 35000, 48000, 120000) }) },
  { weight: 8, arbitrary: fc.record({ type: fc.constantFrom("start", "end", "crash", "wipe", "flush"), dev }) },
  { weight: 10, arbitrary: fc.record({ type: fc.constantFrom("offline", "online"), dev }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("addDevice") }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("emptyFolder"), dev }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("inject"), dev, kind: fc.constantFrom("garbage", "truncated", "unknown", "bitflip"), table, pick: fc.integer({ min: 0, max: 9 }) }) },
);

const CHECKED = new Set(["P1", "P2", "P7", "P8", "ERR"]);

for (const faults of ["none", "rough"]) {
  test(`random action sequences keep P1, P2, P7, P8 (${faults}, ${RUNS} runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 70 }), fc.integer({ min: 1, max: 1000 }), async (actions, seed) => {
        const sc = await createScenario({ seed, variant: "baseline", faults, devices: 2, tables: 2 });
        for (const a of actions) await sc.apply(a);
        await sc.finish({ newDevice: false });
        const bad = sc.violations.filter((v) => CHECKED.has(v.property));
        assert.deepEqual(bad.map(describeViolation), [], `actions: ${actions.map(formatAction).join(" ; ")}`);
      }),
      { numRuns: RUNS },
    );
  });
}
