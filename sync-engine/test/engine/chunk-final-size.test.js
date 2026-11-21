// A reader may treat an applied chunk as final only when the next chunk it
// has also applied records, in prev.size, exactly the size of the copy the
// reader holds. Having the next chunk is not enough: files sync independently,
// so the reader can hold an early short copy of chunk N when chunk N+1 (whose
// prev.size is larger) arrives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const chunk1 = `data/notes/${A}/000001.ywb`;

/** sam holds chunk 1 v1 and chunk 2; chunk 1 v2 (the final copy, longer) has not reached him. */
async function readerWithEarlyCopy() {
  const w = await makeWorld({ options: { statusMs: 600000 } });
  const b = await w.device(S);
  const a1 = await w.device(A);
  a1.table("notes").getMap("m").set("x", 1);
  await w.run([a1, b], 15000);
  const early = w.folder.read(chunk1);
  a1.table("notes").getMap("m").set("y", 2);
  await w.run([a1], 15000);
  const final = w.folder.read(chunk1);
  assert.ok(final.length > early.length, "chunk 1 grew when it was rewritten");
  await a1.close();
  const a2 = await w.device(A);
  a2.table("notes").getMap("m").set("z", 3);
  await w.run([a2], 15000); // chunk 2 records prev.size = final.length
  w.folder.drop(chunk1, early); // what sam's copy of chunk 1 still looks like
  await w.run([b], 5000);
  assert.deepEqual(json(b).m, { x: 1, z: 3 }, "sam has chunk 2 but only the early chunk 1");
  return { w, b, final };
}

test("a chunk shorter than the size the next chunk records is not final and is read again", async () => {
  const { w, b, final } = await readerWithEarlyCopy();
  w.folder.drop(chunk1, final); // the final copy arrives
  await w.run([b], 5000);
  assert.deepEqual(json(b).m, { x: 1, y: 2, z: 3 });
});
