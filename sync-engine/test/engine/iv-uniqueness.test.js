// AES-GCM must never see the same IV twice under one key: every write of a
// file, including every rewrite of the open chunk, draws a fresh IV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./_harness.js";
import { HEADER_BYTES } from "../../src/engine/constants.js";

const A = "harry-aaaaaaaa";
const chunkPath = `data/notes/${A}/000001.ywb`;
const ivOf = (bytes) => Buffer.from(bytes.slice(5, HEADER_BYTES)).toString("hex");

test("rewriting the open chunk uses a different IV each time", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const ivs = [];
  for (const key of ["x", "y", "z"]) {
    a.table("notes").getMap("m").set(key, 1);
    await w.run([a], 6000);
    ivs.push(ivOf(w.folder.read(chunkPath)));
  }
  assert.equal(w.folder.paths(`data/notes/${A}/`).length, 1, "all three writes went to chunk 1");
  assert.equal(new Set(ivs).size, 3, `IVs of three rewrites of one chunk: ${ivs.join(", ")}`);
});
