// Bug 1: a reader that applied chunk n while its author was still writing it
// must re-read n until it holds the final version (the size that chunk n+1
// records in prev.size), even when n+1 is already in the listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const ownDir = `data/notes/${A}`;

/** sam reads chunk 1 v1; harry rewrites chunk 1 (v2) and starts chunk 2 while sam is away. */
async function staleReader(sealBytes) {
  const w = await makeWorld({ options: { statusMs: 600000 } });
  const b = await w.device(S);
  const a1 = await w.device(A, { options: { sealBytes } });
  a1.table("notes").getMap("m").set("x", 1);
  await w.run([a1, b], 15000);
  assert.deepEqual(json(b).m, { x: 1 }, "sam applied chunk 1 v1");
  a1.table("notes").getMap("m").set("y", 2);
  await w.run([a1], 15000); // chunk 1 rewritten, sam not scanning
  await a1.close();
  const a2 = await w.device(A, { options: { sealBytes } });
  a2.table("notes").getMap("m").set("z", 3);
  await w.run([a2], 15000); // chunk 2 written
  assert.deepEqual(w.folder.paths(`${ownDir}/`).map((p) => p.split("/").pop()), ["000001.ywb", "000002.ywb"]);
  return { w, a2, b };
}

test("a chunk read while still open is re-read once the next chunk exists", async () => {
  const { w, b } = await staleReader(65536);
  await w.run([b], 5000);
  assert.deepEqual(json(b).m, { x: 1, y: 2, z: 3 });
});

test("a chunk whose final version has been applied is never touched again", async () => {
  const { w, b } = await staleReader(65536);
  await w.run([b], 5000);
  const reads = [];
  const root = w.folder.root;
  const original = root.getDirectoryHandle.bind(root);
  // count getFile() calls on chunk 1 after sam holds its final version
  root.getDirectoryHandle = async (...args) => {
    const dir = await original(...args);
    return wrapDir(dir, reads);
  };
  await w.run([b], 10000);
  assert.deepEqual(reads.filter((p) => p.endsWith("000001.ywb")), [], "final chunk 1 is not stat'ed or read");
  assert.ok(reads.some((p) => p.endsWith("000002.ywb")), "the open chunk 2 is still checked");
});

function wrapDir(dir, reads, prefix = "") {
  return new Proxy(dir, {
    get(target, prop) {
      if (prop === "getDirectoryHandle") return async (n, o) => wrapDir(await target.getDirectoryHandle(n, o), reads, `${prefix}${n}/`);
      if (prop === "entries") {
        return async function* () {
          for await (const [name, h] of target.entries()) {
            yield [name, h.kind === "file" ? { kind: "file", name, getFile: async () => { reads.push(`${prefix}${name}`); return h.getFile(); }, createWritable: () => h.createWritable() } : wrapDir(h, reads, `${prefix}${name}/`)];
          }
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
