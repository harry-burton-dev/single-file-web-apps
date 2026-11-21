// Sequence numbers reported by status files are untrusted input: one that
// cannot become a chunk file name must not make a device pick it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seal } from "../../src/engine/envelope.js";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const set = (e, k, v) => e.table("notes").getMap("m").set(k, v);

async function forgeStatus(w, claim) {
  const now = w.clock.now();
  const applied = { [A]: { sealed: claim, seen: claim } };
  const meta = { kind: "status", user: "sam", device: S, appVersion: "x", writtenAt: now, lastActiveAt: now, tables: { notes: { applied, snapshots: [], digest: "x", pending: 0 } } };
  w.folder.drop(`status/${S}.ywb`, await seal({ key: w.key, keyId: 1, iv: w.random.bytes(12), meta }));
}

for (const claim of [999999, 1e9, -3, 2.5]) {
  test(`a peer status claiming we wrote chunk ${claim} does not wedge saving after our store is wiped`, async () => {
    const w = await makeWorld();
    const a = await w.device(A);
    const b = await w.device(S);
    set(a, "x", 1);
    await w.run([a, b], 15000);
    await b.close();
    await forgeStatus(w, claim);
    await a.close();
    w.stores.delete(A);
    const a2 = await w.device(A);
    a2.on("error", () => {});

    set(a2, "y", 2);
    await w.run([a2], 40000);

    assert.equal(a2.status().pending, 0);
    assert.ok(w.folder.paths(`data/notes/${A}/`).every((p) => /\/\d{6}\.ywb$/.test(p)));
  });
}
