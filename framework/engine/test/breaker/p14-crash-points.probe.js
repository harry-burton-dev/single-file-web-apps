// Attack 14: process dies at the Nth store/folder call during (a) save, (b) scan+apply, (c) compaction. Restart on same store/folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, json, m, A, B, C, crashable, wrapStore, wrapDir, COMPACT, chunks, snaps } from "./_lib.js";

async function gatedDevice(w, id, limit, options) {
  const gate = crashable(null, limit);
  const engine = await w.device(id, { store: wrapStore(w.store(id), gate), root: wrapDir(w.folder.root, gate), options });
  return { engine, gate };
}

async function runUntilDead(w, engines, gate, ms) {
  for (let t = 0; t < ms && !gate.state.dead; t += 1000) {
    w.clock.advance(1000);
    for (const e of engines) await e.tick();
  }
}

test("P14a crash at every call during save: the edit still reaches B and A", async () => {
  const bad = [];
  for (let n = 0; n <= 90; n += 1) {
    const w = await world();
    const b = await w.device(B);
    let a, gate;
    try { ({ engine: a, gate } = await gatedDevice(w, A, n)); } catch { continue; } // died inside createEngine: nothing was accepted
    m(a).set("k", 1);
    await runUntilDead(w, [a, b], gate, 20000);
    const died = gate.state.dead;
    const a2 = await w.device(A);
    await w.run([a2, b], 60000);
    if (died && json(b).m?.k !== 1) bad.push(`n=${n} B lacks k`);
    if (died && json(a2).m?.k !== 1) bad.push(`n=${n} A2 lacks k`);
    if (!died) break;
  }
  assert.deepEqual(bad, []);
});

test("P14b crash at every call during a scan that applies a peer's chunk: restart converges", async () => {
  const bad = [];
  for (let n = 0; n <= 70; n += 1) {
    const w = await world();
    const b = await w.device(B);
    m(b).set("k", 1);
    await w.run([b], 12000);
    let a, gate;
    try { ({ engine: a, gate } = await gatedDevice(w, A, n)); } catch { continue; }
    m(a).set("own", 1);
    await runUntilDead(w, [a], gate, 12000);
    const died = gate.state.dead;
    const a2 = await w.device(A);
    await w.run([a2, b], 40000);
    if (JSON.stringify(json(a2).m) !== JSON.stringify({ k: 1, own: 1 }) && died) bad.push(`n=${n} A2=${JSON.stringify(json(a2).m)}`);
    if (JSON.stringify(json(b).m) !== JSON.stringify({ k: 1, own: 1 }) && died) bad.push(`n=${n} B=${JSON.stringify(json(b).m)}`);
    if (!died) break;
  }
  assert.deepEqual(bad, []);
});

test("P14c crash at every call during compaction (snapshot + delete): a brand-new device still reaches everything", async () => {
  const bad = [];
  for (let n = 40; n <= 400; n += 9) {
    const w = await world();
    const b = await w.device(B, { options: { compaction: { enabled: false } } });
    const { engine: a, gate } = await gatedDevice(w, A, 100000, COMPACT);
    for (let i = 0; i < 8; i++) { m(a).set(`a${i}`, i); await w.run([a, b], 6000); }
    gate.state.calls = 0;
    gate.limit = n;
    // re-arm: crashable's limit is closed over, so emulate by wrapping with a fresh limit via state
    const real = gate.tick;
    gate.tick = () => { gate.state.calls += 1; if (gate.state.calls > n) { gate.state.dead = true; throw Object.assign(new Error("process died"), { name: "CrashError" }); } };
    await runUntilDead(w, [a, b], gate, 200000);
    if (!gate.state.dead) continue;
    const a2 = await w.device(A, { options: COMPACT });
    await w.run([a2, b], 200000);
    const c = await w.device(C);
    await w.run([a2, b, c], 40000);
    const want = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, i]));
    for (const [name, e] of [["a2", a2], ["b", b], ["c", c]]) if (JSON.stringify(json(e).m) !== JSON.stringify(want)) bad.push(`n=${n} ${name}=${Object.keys(json(e).m ?? {}).length} keys`);
  }
  assert.deepEqual(bad, []);
});
