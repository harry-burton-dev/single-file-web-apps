import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";
import { open } from "../../src/engine/envelope.js";

const A = "harry-aaaaaaaa";
const own = (w) => w.folder.paths(`data/notes/${A}/`).map((p) => p.split("/").pop());
const decode = async (w, path) => open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(path) });

async function session(w, options, edits) {
  const e = await w.device(A, { options });
  edits(e.table("notes"));
  await w.run([e], 15000);
  await e.close();
  return e;
}

test("newChunkPerSession=true starts the next seq each session", async () => {
  const w = await makeWorld();
  await session(w, { newChunkPerSession: true }, (d) => d.getMap("m").set("a", 1));
  await session(w, { newChunkPerSession: true }, (d) => d.getMap("m").set("b", 2));
  await session(w, { newChunkPerSession: true }, (d) => d.getMap("m").set("c", 3));
  assert.deepEqual(own(w), ["000001.ywb", "000002.ywb", "000003.ywb"]);
  const reader = await w.device("sam-bbbbbbbb");
  assert.deepEqual(json(reader).m, { a: 1, b: 2, c: 3 });
});

test("a restart after a crash also starts a new chunk and keeps the old one untouched", async () => {
  const w = await makeWorld();
  const e = await w.device(A);
  e.table("notes").getMap("m").set("a", 1);
  await w.run([e], 15000);
  const before = w.folder.read(`data/notes/${A}/000001.ywb`);
  const e2 = await w.device(A); // no close()
  e2.table("notes").getMap("m").set("b", 2);
  await w.run([e2], 15000);
  assert.deepEqual(own(w), ["000001.ywb", "000002.ywb"]);
  assert.deepEqual(w.folder.read(`data/notes/${A}/000001.ywb`), before);
});

test("newChunkPerSession=false continues the last chunk and keeps its updates", async () => {
  const w = await makeWorld();
  await session(w, { newChunkPerSession: false }, (d) => d.getMap("m").set("a", 1));
  await session(w, { newChunkPerSession: false }, (d) => d.getMap("m").set("b", 2));
  assert.deepEqual(own(w), ["000001.ywb"]);
  const reader = await w.device("sam-bbbbbbbb");
  assert.deepEqual(json(reader).m, { a: 1, b: 2 });
});

test("newChunkPerSession=false still moves on once the chunk reached the seal size", async () => {
  const w = await makeWorld();
  const big = { newChunkPerSession: false, sealBytes: 200 };
  await session(w, big, (d) => d.getText("t").insert(0, "x".repeat(300)));
  await session(w, big, (d) => d.getMap("m").set("b", 2));
  assert.deepEqual(own(w), ["000001.ywb", "000002.ywb"]);
});

test("chunkContent merged keeps one update, framed keeps each", async () => {
  for (const [mode, expected] of [["merged", 1], ["framed", 3]]) {
    const w = await makeWorld();
    const e = await w.device(A, { options: { chunkContent: mode } });
    const doc = e.table("notes");
    doc.getMap("m").set("a", 1);
    doc.getMap("m").set("b", 2);
    doc.getMap("m").set("c", 3);
    await w.run([e], 15000);
    const { updates, meta } = await decode(w, `data/notes/${A}/000001.ywb`);
    assert.equal(updates.length, expected, mode);
    assert.equal(meta.table, "notes");
    assert.equal(meta.adapter, "yjs");
    assert.equal(meta.device, A);
    assert.equal(meta.user, "harry");
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.appVersion, "dev");
    assert.equal(typeof meta.writtenAt, "number");
    const reader = await w.device("sam-bbbbbbbb");
    assert.deepEqual(json(reader).m, { a: 1, b: 2, c: 3 });
  }
});

test("metadata passes through schemaVersions and appVersion", async () => {
  const w = await makeWorld();
  const e = await w.device(A, { options: { schemaVersions: { notes: 4 }, appVersion: "1.2.3" } });
  e.table("notes").getMap("m").set("a", 1);
  await e.flush();
  const { meta } = await decode(w, `data/notes/${A}/000001.ywb`);
  assert.equal(meta.schemaVersion, 4);
  assert.equal(meta.appVersion, "1.2.3");
});

test("chunks seal at sealBytes and a sealed chunk is never rewritten", async () => {
  const w = await makeWorld();
  const e = await w.device(A, { options: { chunkContent: "framed", sealBytes: 300 } });
  for (let i = 0; i < 8; i++) {
    e.table("notes").getText("t").insert(0, `line-${i}-${"y".repeat(20)}`);
    await e.flush();
  }
  const names = own(w);
  assert.ok(names.length >= 3, `expected several chunks, got ${names.join()}`);
  const order = w.folder.writes.filter((p) => p.path.startsWith("data/")).map((p) => p.path);
  const sealed = names.slice(0, -1);
  for (const [i, n] of sealed.entries()) {
    const path = `data/notes/${A}/${n}`;
    assert.ok(w.folder.read(path).length >= 300, `${n} reached the seal size`);
    const lastWrite = order.lastIndexOf(path);
    const nextFirst = order.indexOf(`data/notes/${A}/${names[i + 1]}`);
    assert.ok(lastWrite < nextFirst, `${n} is not rewritten after the next chunk starts`);
  }
  const reader = await w.device("sam-bbbbbbbb");
  assert.deepEqual(json(reader), json(e));
});

test("chunk metadata links each chunk to the previous one's size", async () => {
  const w = await makeWorld();
  await session(w, {}, (d) => d.getMap("m").set("a", 1));
  await session(w, {}, (d) => d.getMap("m").set("b", 2));
  const first = w.folder.read(`data/notes/${A}/000001.ywb`);
  const { meta } = await decode(w, `data/notes/${A}/000002.ywb`);
  assert.deepEqual(meta.prev, { seq: 1, size: first.length });
});
