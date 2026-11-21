// Chunks layout: a device whose local store was wiped and whose own folder
// listing is empty or failing must not restart numbering at chunk 1. Other
// devices treat an applied sealed chunk as final by name and would never read
// a replacement. Fix: numbering floors at the highest seq anyone has recorded
// (own status file, peers' status files) and a chunk name is never reused
// unless this store wrote it (direct existence probe, independent of listings).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const ownDir = `data/notes/${A}`;
const names = (w) => w.folder.paths(`${ownDir}/`).map((p) => p.split("/").pop());

/** harry writes chunks 1..3 over three sessions while sam follows along. */
async function history() {
  const w = await makeWorld();
  const b = await w.device(S);
  for (const k of ["a", "b", "c"]) {
    const e = await w.device(A);
    e.table("notes").getMap("m").set(k, 1);
    await w.run([e, b], 15000);
    await e.close();
    await w.run([b], 6000); // sam scans and writes a status file
  }
  assert.deepEqual(names(w), ["000001.ywb", "000002.ywb", "000003.ywb"]);
  assert.deepEqual(json(b).m, { a: 1, b: 1, c: 1 });
  return { w, b, before: Object.fromEntries(names(w).map((n) => [n, w.folder.read(`${ownDir}/${n}`)])) };
}

async function restartWiped(w, hide) {
  w.store(A).wipe();
  hide();
  const e = await w.device(A);
  e.table("notes").getMap("m").set("fresh", 9);
  return e;
}

/** The hook is folder-wide, so sam only ticks once the listing works again. */
async function savedThenListingBack(w, e, b) {
  await w.run([e], 15000);
  w.folder.clearListing();
  await w.run([e, b], 15000);
}

function assertNewChunkReadBySam(w, b, before) {
  assert.deepEqual(names(w).slice(0, 3), ["000001.ywb", "000002.ywb", "000003.ywb"]);
  for (const [n, bytes] of Object.entries(before)) assert.deepEqual(w.folder.read(`${ownDir}/${n}`), bytes, `${n} untouched`);
  assert.ok(names(w).includes("000004.ywb"), `new chunk is 000004, got ${names(w)}`);
  assert.equal(json(b).m.fresh, 9, "sam read the new chunk");
}

test("wiped store + failing own listing: numbering continues from status evidence", async () => {
  const { w, b, before } = await history();
  const e = await restartWiped(w, () => w.folder.failListing((p) => p === ownDir));
  await savedThenListingBack(w, e, b);
  assertNewChunkReadBySam(w, b, before);
});

test("wiped store + empty own listing: numbering continues from status evidence", async () => {
  const { w, b, before } = await history();
  const e = await restartWiped(w, () => w.folder.hideListing((p) => p === ownDir));
  await savedThenListingBack(w, e, b);
  assertNewChunkReadBySam(w, b, before);
});

test("no status evidence at all: the existence probe still refuses to overwrite chunk 1", async () => {
  const { w, b, before } = await history();
  for (const p of w.folder.paths("status/")) w.folder.remove(p);
  const e = await restartWiped(w, () => w.folder.hideListing((p) => p === ownDir));
  await savedThenListingBack(w, e, b);
  assertNewChunkReadBySam(w, b, before);
});

test("a genuinely new device still starts at chunk 1", async () => {
  const w = await makeWorld();
  const e = await w.device(A);
  e.table("notes").getMap("m").set("x", 1);
  await w.run([e], 15000);
  assert.deepEqual(names(w), ["000001.ywb"]);
});
