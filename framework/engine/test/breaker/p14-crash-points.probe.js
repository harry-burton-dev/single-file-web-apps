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

// P14a and P14b hold the engine to "a change is durable once the engine has accepted it"
// (test spec P3). The engine reports acceptance with its `accepted` event. An edit it
// accepted must survive the crash on both devices; an edit it never accepted may be
// lost, but only on both devices together, never kept by one and missing on the other.

/** The edit's fate after the crash, by whether the engine had accepted it. */
function judge(bad, n, accepted, inA, inB, what) {
  if (accepted) {
    if (!inB) bad.push(`n=${n} accepted ${what}: B lacks it`);
    if (!inA) bad.push(`n=${n} accepted ${what}: A2 lacks it`);
  } else if (inA !== inB) {
    bad.push(`n=${n} unaccepted ${what}: A2 has=${inA} B has=${inB}`);
  }
}

test("P14a crash at every call during save: an accepted edit still reaches B and A, an unaccepted one never diverges", async () => {
  const bad = [];
  const tally = { accepted: 0, unaccepted: 0 };
  for (let n = 0; n <= 90; n += 1) {
    const w = await world();
    const b = await w.device(B);
    let a, gate;
    try { ({ engine: a, gate } = await gatedDevice(w, A, n)); } catch { continue; } // died inside createEngine: nothing was accepted
    let accepted = false;
    a.on("accepted", () => { accepted = true; });
    m(a).set("k", 1);
    await runUntilDead(w, [a, b], gate, 20000);
    const died = gate.state.dead;
    if (!died) break;
    tally[accepted ? "accepted" : "unaccepted"] += 1;
    const a2 = await w.device(A);
    await w.run([a2, b], 60000);
    judge(bad, n, accepted, json(a2).m?.k === 1, json(b).m?.k === 1, "k");
  }
  console.log("P14a crash points with the edit accepted / not accepted:", tally.accepted, "/", tally.unaccepted);
  assert.ok(tally.accepted > 0, "no crash point came after acceptance: the probe tests nothing");
  assert.deepEqual(bad, []);
});

test("P14b crash at every call during a scan that applies a peer's chunk: restart converges, and the peer's edit is never lost", async () => {
  const bad = [];
  const tally = { accepted: 0, unaccepted: 0 };
  for (let n = 0; n <= 70; n += 1) {
    const w = await world();
    const b = await w.device(B);
    m(b).set("k", 1);
    await w.run([b], 12000);
    let a, gate;
    try { ({ engine: a, gate } = await gatedDevice(w, A, n)); } catch { continue; }
    let accepted = false;
    a.on("accepted", () => { accepted = true; });
    m(a).set("own", 1);
    await runUntilDead(w, [a], gate, 12000);
    const died = gate.state.dead;
    if (!died) break;
    tally[accepted ? "accepted" : "unaccepted"] += 1;
    const a2 = await w.device(A);
    await w.run([a2, b], 40000);
    const ja = json(a2).m ?? {}, jb = json(b).m ?? {};
    if (ja.k !== 1) bad.push(`n=${n} A2 lacks B's k: ${JSON.stringify(ja)}`);
    if (jb.k !== 1) bad.push(`n=${n} B lacks its own k: ${JSON.stringify(jb)}`);
    judge(bad, n, accepted, ja.own === 1, jb.own === 1, "own");
    if (JSON.stringify(ja) !== JSON.stringify(jb)) bad.push(`n=${n} diverged A2=${JSON.stringify(ja)} B=${JSON.stringify(jb)}`);
  }
  console.log("P14b crash points with the edit accepted / not accepted:", tally.accepted, "/", tally.unaccepted);
  assert.ok(tally.accepted > 0, "no crash point came after acceptance: the probe tests nothing");
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
