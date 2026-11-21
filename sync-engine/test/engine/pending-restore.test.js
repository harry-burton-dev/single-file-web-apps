// A crash can fall after an update was persisted as pending but before it was
// logged to the local update log. On restart the pending update must be in the
// document too (Yjs updates are idempotent), not only re-sent to the folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { yjsAdapter } from "../../src/adapters/yjs.js";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";

function updateSettingK() {
  const doc = yjsAdapter.create();
  let bytes;
  yjsAdapter.onLocalUpdate(doc, (u) => { bytes = u; });
  doc.getMap("m").set("k", 1);
  return bytes;
}

test("a pending update found at start is applied to the document, sent, and survives another restart", async () => {
  const w = await makeWorld();
  await w.store(A).set("t/notes/pend/000000001", updateSettingK()); // persisted, never logged
  let a = await w.device(A);
  const b = await w.device(S);
  assert.equal(json(a).m?.k, 1, "visible in the document right after start");

  await w.run([a, b], 30000);
  await a.close();
  a = await w.device(A);

  assert.equal(json(b).m?.k, 1, "reached the other device");
  assert.equal(json(a).m?.k, 1, "still in the document after the next restart");
});
