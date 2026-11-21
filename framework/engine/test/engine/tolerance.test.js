import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";

async function writerAndReader() {
  const w = await makeWorld();
  const a = await w.device(A);
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 15000);
  const reader = await w.device("kim-cccccccc");
  return { w, a, reader };
}

test("garbage with a chunk name is skipped, reported and never changes content", async () => {
  const { w, reader } = await writerAndReader();
  const before = json(reader);
  w.folder.drop(`data/notes/${S}/000001.ywb`, new Uint8Array(200).fill(7));
  await reader.scan();
  await reader.tick();
  assert.deepEqual(json(reader), before);
  const bad = reader.status().unreadable;
  assert.equal(bad.length, 1);
  assert.match(bad[0].path, /sam-bbbbbbbb\/000001\.ywb$/);
});

test("a truncated copy is skipped, then applied once it is complete", async () => {
  const { w, reader } = await writerAndReader();
  const full = w.folder.read(`data/notes/${A}/000001.ywb`);
  const to = `data/notes/${S}/000001.ywb`;
  w.folder.drop(to, full.slice(0, Math.floor(full.length / 2)));
  await reader.scan();
  assert.ok(reader.status().unreadable.some((u) => u.path.endsWith(`${S}/000001.ywb`)));
  assert.deepEqual(json(reader), { m: { x: 1 } });
  w.folder.drop(to, full);
  await reader.scan();
  assert.equal(reader.status().unreadable.length, 0);
});

test("a conflict copy is read as data", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a], 15000);
  w.folder.copy(`data/notes/${A}/000001.ywb`, `data/notes/${S}/000001-DESKTOP.ywb`);
  w.folder.remove(`data/notes/${A}/000001.ywb`);
  const reader = await w.device("kim-cccccccc");
  assert.deepEqual(json(reader), { m: { x: 1 } });
  assert.equal(reader.status().unreadable.length, 0);
});

test(".crswap, .tmp, unknown tables and odd names never throw or change content", async () => {
  const { w, reader } = await writerAndReader();
  const before = json(reader);
  for (const p of [
    `data/notes/${A}/000001.ywb.crswap`,
    `data/notes/${A}/000009.ywb.tmp`,
    `data/notes/${A}/notes.txt`,
    `data/notes/${A}/snap-bad.ywb`,
    `data/zzz/${A}/000001.ywb`,
    `status/${S}.ywb.crswap`,
    "stray.ywb",
  ]) w.folder.drop(p, new Uint8Array(64).fill(1));
  await reader.scan();
  await reader.tick();
  assert.deepEqual(json(reader), before);
  assert.equal(reader.status().unreadable.length, 0);
  assert.equal(reader.status().errors.length, 0);
});

test("a junk status file is reported unreadable but harmless", async () => {
  const { w, reader } = await writerAndReader();
  w.folder.drop(`status/${S}.ywb`, new Uint8Array(100).fill(3));
  await reader.scan();
  assert.ok(reader.status().unreadable.some((u) => u.path === `status/${S}.ywb`));
  assert.equal(Object.keys(reader.status().devices).includes(S), false);
});

test("files with an unknown adapter or table in their metadata are ignored quietly", async () => {
  const { w, reader } = await writerAndReader();
  // A valid file for a table the reader does not know, placed under a known table's folder
  const other = await makeWorld({ tables: { notes: "yjs", extra: "yjs" } });
  const x = await other.device("zed-eeeeeeee");
  x.table("extra").getMap("m").set("q", 1);
  await x.flush();
  other.folder.copy(`data/extra/zed-eeeeeeee/000001.ywb`, `data/notes/zed-eeeeeeee/000001.ywb`);
  const bytes = other.folder.read(`data/notes/zed-eeeeeeee/000001.ywb`);
  w.folder.drop(`data/notes/zed-eeeeeeee/000001.ywb`, bytes);
  await reader.scan();
  assert.equal(reader.status().errors.length, 0);
  assert.deepEqual(json(reader), { m: { x: 1 } });
});
