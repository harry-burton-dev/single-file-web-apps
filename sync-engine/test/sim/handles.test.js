import { test } from "node:test";
import assert from "node:assert/strict";
import { newWorld, bytesOf, textOf, writeFile, readFile, rejectsWithName } from "./helpers.js";

async function names(dir) {
  const out = [];
  for await (const [name] of dir.entries()) out.push(name);
  return out;
}

test("root is a directory handle", () => {
  const { a } = newWorld();
  assert.equal(a.root.kind, "directory");
  assert.equal(a.id, "alice-aaaaaaaa");
});

test("getDirectoryHandle: create, existing, missing, type mismatch", async () => {
  const { a } = newWorld();
  assert.equal(await rejectsWithName(a.root.getDirectoryHandle("data"), "NotFoundError"), undefined);
  const data = await a.root.getDirectoryHandle("data", { create: true });
  assert.equal(data.kind, "directory");
  assert.equal(data.name, "data");
  assert.equal((await a.root.getDirectoryHandle("data")).name, "data");
  await a.root.getFileHandle("f.txt", { create: true });
  assert.equal(await rejectsWithName(a.root.getDirectoryHandle("f.txt"), "TypeMismatchError"), undefined);
  assert.equal(await rejectsWithName(a.root.getFileHandle("data"), "TypeMismatchError"), undefined);
});

test("getFileHandle: missing without create, creates empty file", async () => {
  const { a } = newWorld();
  assert.equal(await rejectsWithName(a.root.getFileHandle("x.bin"), "NotFoundError"), undefined);
  const handle = await a.root.getFileHandle("x.bin", { create: true });
  assert.equal(handle.kind, "file");
  assert.equal(handle.name, "x.bin");
  const file = await handle.getFile();
  assert.equal(file.size, 0);
  assert.equal(file.name, "x.bin");
});

test("invalid names are rejected", async () => {
  const { a } = newWorld();
  for (const bad of ["", ".", "..", "a/b"]) {
    assert.equal(await rejectsWithName(a.root.getFileHandle(bad, { create: true }), "TypeError"), undefined);
  }
});

test("content is visible only after close, and replaces the whole file", async () => {
  const { a } = newWorld();
  await writeFile(a, "f.txt", "first version");
  const handle = await a.root.getFileHandle("f.txt");
  const writable = await handle.createWritable();
  await writable.write(bytesOf("sec"));
  await writable.write(bytesOf("ond"));
  assert.equal(textOf(await readFile(a, "f.txt")), "first version");
  await writable.close();
  assert.equal(textOf(await readFile(a, "f.txt")), "second");
  const file = await handle.getFile();
  assert.equal(file.size, 6);
  assert.equal(typeof file.lastModified, "number");
});

test("writable accepts strings and ArrayBuffers, rejects use after close, abort discards", async () => {
  const { a } = newWorld();
  const handle = await a.root.getFileHandle("f.txt", { create: true });
  let w = await handle.createWritable();
  await w.write("ab");
  await w.write(bytesOf("cd").buffer);
  await w.close();
  assert.equal(textOf(await readFile(a, "f.txt")), "abcd");
  await assert.rejects(w.write("x"), { name: "TypeError" });
  w = await handle.createWritable();
  await w.write("zzz");
  await w.abort();
  assert.equal(textOf(await readFile(a, "f.txt")), "abcd");
});

test("getFile returns a snapshot", async () => {
  const { a } = newWorld();
  await writeFile(a, "f.txt", "old");
  const file = await (await a.root.getFileHandle("f.txt")).getFile();
  await writeFile(a, "f.txt", "newer");
  assert.equal(textOf(new Uint8Array(await file.arrayBuffer())), "old");
});

test("handles for removed files report NotFoundError", async () => {
  const { a } = newWorld();
  await writeFile(a, "f.txt", "x");
  const handle = await a.root.getFileHandle("f.txt");
  await a.root.removeEntry("f.txt");
  assert.equal(await rejectsWithName(handle.getFile(), "NotFoundError"), undefined);
  assert.equal(await rejectsWithName(handle.createWritable(), "NotFoundError"), undefined);
  assert.equal(await rejectsWithName(a.root.removeEntry("f.txt"), "NotFoundError"), undefined);
});

test("entries lists files and directories sorted; keys, values and iterator work", async () => {
  const { a } = newWorld();
  await writeFile(a, "b.txt", "1");
  await writeFile(a, "dir/c.txt", "2");
  await writeFile(a, "a.txt", "3");
  assert.deepEqual(await names(a.root), ["a.txt", "b.txt", "dir"]);
  const kinds = [];
  for await (const [name, handle] of a.root.entries()) kinds.push(`${name}:${handle.kind}`);
  assert.deepEqual(kinds, ["a.txt:file", "b.txt:file", "dir:directory"]);
  const keys = [];
  for await (const key of a.root.keys()) keys.push(key);
  assert.deepEqual(keys, ["a.txt", "b.txt", "dir"]);
  let values = 0;
  for await (const value of a.root.values()) values += value.name ? 1 : 0;
  assert.equal(values, 3);
  let viaIterator = 0;
  for await (const _entry of a.root) viaIterator++;
  assert.equal(viaIterator, 3);
});

test("removeEntry: empty dir, non-empty needs recursive", async () => {
  const { a } = newWorld();
  await a.root.getDirectoryHandle("empty", { create: true });
  await a.root.removeEntry("empty");
  assert.deepEqual(await names(a.root), []);
  await writeFile(a, "d/x/y.txt", "1");
  assert.equal(await rejectsWithName(a.root.removeEntry("d"), "InvalidModificationError"), undefined);
  await a.root.removeEntry("d", { recursive: true });
  assert.deepEqual(await names(a.root), []);
});

test("an empty directory exists locally at once and does not sync", async () => {
  const { world, a, b } = newWorld();
  await a.root.getDirectoryHandle("empty", { create: true });
  assert.deepEqual(await names(a.root), ["empty"]);
  await world.advance(10000);
  assert.deepEqual(await names(b.root), []);
});

test("recursive removal propagates a delete for every file inside", async () => {
  const { world, a, b } = newWorld();
  await writeFile(a, "d/x.txt", "1");
  await writeFile(a, "d/y/z.txt", "2");
  await world.advance(0);
  assert.equal(world.deviceFiles(b.id).size, 2);
  await a.root.removeEntry("d", { recursive: true });
  await world.advance(0);
  assert.equal(world.cloudFiles().size, 0);
  assert.equal(world.deviceFiles(b.id).size, 0);
});
