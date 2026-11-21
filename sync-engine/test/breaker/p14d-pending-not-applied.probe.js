// Attack 14d: crash between "pending update persisted" and "update logged to local doc log"; reopen. The recovered pending edit is sent to the folder but never applied to the local doc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, crashable, wrapStore, wrapDir } from "./_lib.js";

test("P14d after a crash mid-persist, the reopened device shows its own edit and so does everyone else", async () => {
  const bad = []; const lostEverywhere = [];
  for (let n = 0; n <= 40; n++) {
    const w = await world();
    const b = await w.device(B);
    const gate = crashable(null, n);
    let a;
    try { a = await w.device(A, { store: wrapStore(w.store(A), gate), root: wrapDir(w.folder.root, gate) }); } catch { continue; }
    m(a).set("k", 1);
    for (let t = 0; t < 20000 && !gate.state.dead; t += 1000) { w.clock.advance(1000); await a.tick(); await b.tick(); }
    if (!gate.state.dead) break;
    const a2 = await w.device(A);
    await w.run([a2, b], 90000);
    const inA = json(a2).m?.k === 1, inB = json(b).m?.k === 1;
    if (!inA && !inB) lostEverywhere.push(n); else if (inA !== inB) bad.push(`n=${n} A2 has=${inA} B has=${inB}`);
  }
  console.log("P14d edit lost on both (crash before pend persisted):", lostEverywhere.join(","));
  console.log("P14d divergent after reopen:", bad.join("; "));
  assert.deepEqual(bad, []);
});
