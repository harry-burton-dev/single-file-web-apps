// createYjsAdapter({ random }): clientIDs come from the injected source, so a
// seeded run is reproducible; without it Yjs's own randomness is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createYjsAdapter, yjsAdapter } from "../../src/adapters/yjs.js";

function seededRandom(seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  return { bytes: (n) => Uint8Array.from({ length: n }, () => next() >>> 24) };
}

const ids = (adapter, n) => Array.from({ length: n }, () => adapter.create().clientID);

test("the same random source gives the same clientIDs, in order", () => {
  assert.deepEqual(ids(createYjsAdapter({ random: seededRandom(5) }), 4), ids(createYjsAdapter({ random: seededRandom(5) }), 4));
});

test("successive docs from one adapter get different clientIDs", () => {
  const got = ids(createYjsAdapter({ random: seededRandom(9) }), 20);
  assert.equal(new Set(got).size, got.length);
});

test("a different source gives different clientIDs", () => {
  assert.notDeepEqual(ids(createYjsAdapter({ random: seededRandom(1) }), 3), ids(createYjsAdapter({ random: seededRandom(2) }), 3));
});

test("the default adapter keeps Yjs's real randomness and the full adapter surface", () => {
  assert.notEqual(yjsAdapter.create().clientID, yjsAdapter.create().clientID);
  const seeded = createYjsAdapter({ random: seededRandom(3) });
  for (const k of Object.keys(yjsAdapter)) assert.equal(typeof seeded[k], typeof yjsAdapter[k], k);
});

test("identical edits on identically seeded docs encode to identical bytes", () => {
  const encode = (seed) => {
    const adapter = createYjsAdapter({ random: seededRandom(seed) });
    const doc = adapter.create();
    doc.getMap("m").set("k", "value");
    return adapter.snapshot(doc);
  };
  assert.deepEqual(encode(4), encode(4));
});
