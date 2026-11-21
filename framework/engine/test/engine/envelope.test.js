import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, open, EnvelopeError } from "../../src/engine/envelope.js";
import { testKey, createSeededRandom } from "../helpers/memfolder.js";

const meta = { table: "notes", device: "harry-aaaaaaaa", writtenAt: 5 };
const updates = [Uint8Array.of(1, 2, 3), new Uint8Array(0), Uint8Array.of(9)];

async function sealed() {
  const key = await testKey(1);
  const iv = createSeededRandom(3).bytes(12);
  return { key, bytes: await seal({ key, keyId: 4, iv, meta, updates }) };
}

test("round trip returns metadata and updates", async () => {
  const { key, bytes } = await sealed();
  const out = await open({ keys: new Map([[4, key]]), bytes });
  assert.deepEqual(out.meta, meta);
  assert.deepEqual(out.updates, updates);
});

test("header carries magic, key id and iv in the clear", async () => {
  const { bytes } = await sealed();
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "EAW1");
  assert.equal(bytes[4], 4);
});

test("an empty update list round-trips", async () => {
  const key = await testKey(1);
  const bytes = await seal({ key, keyId: 0, iv: createSeededRandom(1).bytes(12), meta: { a: 1 }, updates: [] });
  assert.deepEqual(await open({ keys: new Map([[0, key]]), bytes }), { meta: { a: 1 }, updates: [] });
});

test("flipping any byte is rejected", async () => {
  const { key, bytes } = await sealed();
  for (const at of [0, 4, 6, 17, bytes.length - 1]) {
    const bad = bytes.slice();
    bad[at] ^= 0x01;
    await assert.rejects(open({ keys: new Map([[4, key], [5, key]]), bytes: bad }), EnvelopeError, `byte ${at}`);
  }
});

test("every truncation is rejected", async () => {
  const { key, bytes } = await sealed();
  for (const len of [0, 3, 17, 30, bytes.length - 1]) {
    await assert.rejects(open({ keys: new Map([[4, key]]), bytes: bytes.slice(0, len) }), EnvelopeError, `len ${len}`);
  }
});

test("the wrong key and an unknown key id are rejected", async () => {
  const { bytes } = await sealed();
  const other = await testKey(2);
  await assert.rejects(open({ keys: new Map([[4, other]]), bytes }), EnvelopeError);
  await assert.rejects(open({ keys: new Map(), bytes }), EnvelopeError);
});

test("seal validates iv and key id", async () => {
  const key = await testKey(1);
  await assert.rejects(seal({ key, keyId: 0, iv: new Uint8Array(8), meta, updates }), EnvelopeError);
  await assert.rejects(seal({ key, keyId: 256, iv: new Uint8Array(12), meta, updates }), EnvelopeError);
});
