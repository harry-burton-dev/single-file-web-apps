// A device's own sealed chunk is not trusted to be in its document just
// because it is below the open chunk: a restored browser store can hold an
// older copy of it than the folder does. Own chunks follow the peer rule
// (re-read unless the applied copy is known final), and a snapshot claims an
// own chunk only if this device applied it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { open } from "../../src/engine/envelope.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const set = (e, k, v) => e.table("notes").getMap("m").set(k, v);

async function copyStore(store) {
  const copy = createMemoryStore();
  for (const k of await store.keys("")) await copy.set(k, await store.get(k));
  return copy;
}

async function snapshotCovers(w, device) {
  const path = w.folder.paths(`data/notes/${device}/snap-`)[0];
  return (await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(path) })).meta.covers;
}

test("own chunk rewritten after the local store backup is re-read on restart", async () => {
  const w = await makeWorld();
  let a = await w.device(A);
  const b = await w.device(S);
  set(a, "e1", 1);
  await w.run([a, b], 15000);
  const backup = await copyStore(w.store(A)); // chunk 1 as it was after e1
  set(a, "e2", 2);
  await w.run([a, b], 15000); // same session: chunk 1 is rewritten with e2
  await a.close();
  w.stores.set(A, backup);

  a = await w.device(A);
  await w.run([a, b], 5000);

  assert.deepEqual(json(a).m, { e1: 1, e2: 2 });
});

test("a snapshot written after a restored backup covers the own chunk only once its current content is applied", async () => {
  const w = await makeWorld();
  let a = await w.device(A);
  const b = await w.device(S);
  set(a, "e1", 1);
  await w.run([a, b], 15000);
  const backup = await copyStore(w.store(A));
  set(a, "e2", 2);
  await w.run([a, b], 15000);
  await a.close();
  w.stores.set(A, backup);
  a = await w.device(A);
  await w.run([a, b], 5000);

  await a.reseed();
  await w.run([a, b], 20000);

  const c = await w.device("kim-cccccccc");
  await w.run([a, b, c], 20000);
  assert.deepEqual(json(c).m, { e1: 1, e2: 2 });
});

test("reseed does not claim an own chunk that was unreadable and never applied", async () => {
  const w = await makeWorld({ options: { sealBytes: 1 } });
  let a = await w.device(A);
  const b = await w.device(S);
  for (const k of ["k1", "k2", "k3"]) {
    set(a, k, 1);
    await w.run([a, b], 12000);
  }
  await a.close();
  w.stores.delete(A); // browser storage cleared
  const hideChunk2 = (node) => new Proxy(node, {
    get(t, p) {
      if (p === "getDirectoryHandle") return async (n, o) => hideChunk2(await t.getDirectoryHandle(n, o));
      if (p === "entries") return async function* () { for await (const [n, h] of t.entries()) yield [n, h.kind === "file" ? hideFile(h, n) : hideChunk2(h)]; };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const hideFile = (h, name) => new Proxy(h, {
    get(t, p) {
      if (p === "getFile" && name === "000002.ywb") return async () => { throw Object.assign(new Error("cloud-only"), { name: "NotReadableError" }); };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  a = await w.device(A, { root: hideChunk2(w.folder.root) });
  a.on("error", () => {});

  await a.reseed();

  const covers = await snapshotCovers(w, A);
  assert.ok((covers[A] ?? 0) < 2, `snapshot covers own chunk 2 although it was never applied: ${JSON.stringify(covers)}`);
});
