// Every folder step on data/<table>/<device>/... is attributed to that device
// in the trace that made it (trace.devices, and so traces({ device })).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";
import { partsOfPath } from "../../src/engine/tracing.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const ownerOf = (path) => /^data\/[^/]+\/([^/]+)\/[^/]+$/.exec(path)?.[1];

test("partsOfPath names the table and the device of a data file", () => {
  assert.deepEqual(partsOfPath(`data/notes/${A}/000001.ywb`), { table: "notes", device: A });
  assert.deepEqual(partsOfPath(`data/notes/${A}/snap-20260101T000000Z.ywb`), { table: "notes", device: A });
  assert.deepEqual(partsOfPath("data/notes"), { table: "notes", device: null });
  assert.deepEqual(partsOfPath(`status/${S}.ywb`), { table: null, device: S });
});

test("each trace lists the devices whose files its steps touched", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(S);
  a.table("notes").getMap("m").set("x", 1);
  b.table("notes").getMap("m").set("y", 2);
  await w.run([a, b], 30000);
  let checked = 0;
  for (const engine of [a, b]) {
    for (const trace of engine.traces()) {
      for (const step of trace.steps) {
        const owner = ownerOf(step.path);
        if (!owner) continue;
        checked += 1;
        assert.ok(trace.devices.includes(owner), `${trace.kind} trace lists ${trace.devices} but touched ${step.path}`);
        assert.ok(engine.traces({ device: owner }).includes(trace));
      }
    }
  }
  assert.ok(checked > 10, `${checked} data steps checked`);
  assert.ok(a.traces({ device: A, kind: "save" }).length > 0, "a's saves are attributed to a");
  assert.equal(a.traces({ device: S, kind: "save" }).length, 0, "and not to sam");
  assert.ok(a.traces({ device: S, kind: "scan" }).length > 0, "a's scans that read sam's chunk are attributed to sam");
});
