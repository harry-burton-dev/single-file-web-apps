import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeWorld, json } from "./_harness.js";
import { open } from "../../src/engine/envelope.js";
import { parseStamp } from "../../src/engine/layout-chunks.js";

const A = "harry-aaaaaaaa";
const B = "sam-bbbbbbbb";
const readStatus = async (w, id) => (await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(`status/${id}.ywb`) })).meta;
const snaps = (w, id) => w.folder.paths(`data/notes/${id}/snap-`).map((p) => p.split("/").pop());
const chunks = (w, id) => w.folder.paths(`data/notes/${id}/`).filter((p) => /\/\d{6}\.ywb$/.test(p)).map((p) => p.split("/").pop());
const COMPACT = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };

test("status file reports applied, snapshots, digest and lastActiveAt", async () => {
  const w = await makeWorld();
  const a = await w.device(A);
  const b = await w.device(B);
  a.table("notes").getMap("m").set("x", 1);
  await w.run([a, b], 30000);
  const meta = await readStatus(w, A);
  assert.equal(meta.kind, "status");
  assert.equal(meta.device, A);
  assert.equal(typeof meta.lastActiveAt, "number");
  const t = meta.tables.notes;
  assert.deepEqual(t.snapshots, []);
  assert.equal(t.applied[A].seen, 1);
  assert.equal(t.digest, createHash("sha256").update(JSON.stringify(json(a))).digest("hex"));
  const mb = await readStatus(w, B);
  assert.equal(mb.tables.notes.digest, t.digest, "same content, same digest");
  assert.equal(mb.tables.notes.applied[A].seen, 1);
  assert.equal(a.status().devices[B].tables.notes.digest, t.digest);
});

test("sealed coverage advances only for chunks known to be final", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: { sealBytes: 1 } });
  const b = await w.device(B);
  for (let i = 0; i < 3; i++) {
    a.table("notes").getMap("m").set(`k${i}`, i);
    await w.run([a, b], 6000);
  }
  await w.run([a, b], 10000);
  const t = (await readStatus(w, B)).tables.notes;
  assert.equal(t.applied[A].seen, 3);
  assert.equal(t.applied[A].sealed, 2, "chunk 3 may still be rewritten, so only 1-2 are sealed");
  const own = (await readStatus(w, A)).tables.notes.applied[A];
  assert.equal(own.sealed, 3, "own chunks are all final once the next one is open");
});

async function busyPair(extraB = {}) {
  const w = await makeWorld();
  const a = await w.device(A, { options: COMPACT });
  const b = await w.device(B, { options: { compaction: { enabled: false }, ...extraB } });
  for (let i = 0; i < 6; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a, b], 6000);
  }
  b.table("notes").getMap("m").set("b0", 1);
  await w.run([b, a], 6000);
  return { w, a, b };
}

const seqOf = (name) => Number(name.slice(0, 6));
const snapCovers = async (w, id) => (await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(`data/notes/${id}/${snaps(w, id)[0]}`) })).meta.covers;

// a snapshots while b is offline; b's last status (recent, so still "active") does not list it
async function snapshotWithoutAck() {
  const w = await makeWorld();
  const a = await w.device(A, { options: COMPACT });
  const b = await w.device(B, { options: { compaction: { enabled: false } } });
  for (let i = 0; i < 4; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a, b], 6000);
  }
  for (let i = 4; i < 8; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a], 6000);
  }
  await w.run([a], 60000);
  return { w, a, b };
}

test("compaction writes a snapshot, deletes only after acknowledgement, new device joins", async () => {
  const { w, a, b } = await snapshotWithoutAck();
  assert.equal(snaps(w, A).length, 1, "a wrote a snapshot");
  assert.equal(chunks(w, A).length, 8, "nothing deleted: b has not acknowledged the snapshot");
  assert.equal(w.folder.deletes.length, 0);
  await w.run([a, b], 30000); // b returns, loads the snapshot and reports it
  const covered = (await snapCovers(w, A))[A];
  assert.ok(covered >= 5, `snapshot covers a's chunks up to ${covered}`);
  assert.deepEqual(chunks(w, A).filter((n) => seqOf(n) <= covered), [], "covered chunks are deleted");
  assert.ok(chunks(w, A).every((n) => seqOf(n) > covered));
  assert.equal(w.folder.deletes.length, covered);
  assert.equal(snaps(w, A).length, 1);
  const snapMs = parseStamp(snaps(w, A)[0].slice(5, 20));
  assert.ok(w.folder.deletes[0].at - snapMs >= 10000, "snapshot was at least minSnapshotAgeMs old");
  for (const d of w.folder.deletes) assert.ok(d.path.startsWith(`data/notes/${A}/`), `deleted only own file: ${d.path}`);
  const c = await w.device("kim-cccccccc");
  assert.deepEqual(json(c), json(a));
  assert.deepEqual(json(b), json(a));
});

test("an active device that has not acknowledged blocks deletion", async () => {
  const { w, a } = await snapshotWithoutAck();
  await w.run([a], 40000);
  assert.equal(w.folder.deletes.length, 0);
  assert.equal(chunks(w, A).length, 8);
});

test("a device silent beyond activeWindowMs no longer blocks deletion", async () => {
  const { w, a } = await snapshotWithoutAck();
  w.clock.advance(31 * 24 * 3600 * 1000);
  await w.run([a], 5000);
  assert.ok(w.folder.deletes.length > 0);
  const covered = (await snapCovers(w, A))[A];
  assert.ok(chunks(w, A).every((n) => seqOf(n) > covered));
});

test("ackRule none deletes as soon as a snapshot exists", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: { ...COMPACT, compaction: { ...COMPACT.compaction, ackRule: "none", minSnapshotAgeMs: 0 } } });
  for (let i = 0; i < 8; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a], 6000);
  }
  await w.run([a], 20000);
  assert.equal(snaps(w, A).length, 1);
  const covered = (await snapCovers(w, A))[A];
  assert.ok(w.folder.deletes.length >= covered && covered >= 5);
  assert.ok(chunks(w, A).every((n) => seqOf(n) > covered));
  const c = await w.device("kim-cccccccc");
  assert.deepEqual(json(c), json(a));
});

test("compaction disabled never writes snapshots or deletes", async () => {
  const w = await makeWorld();
  const a = await w.device(A, { options: { sealBytes: 1, compaction: { enabled: false, chunkThreshold: 1 } } });
  for (let i = 0; i < 5; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a], 6000);
  }
  assert.equal(snaps(w, A).length, 0);
  assert.equal(w.folder.deletes.length, 0);
});

test("old own snapshots are deleted once a newer acknowledged one covers them", async () => {
  const w = await makeWorld();
  const opts = { sealBytes: 1, compaction: { chunkThreshold: 2, minSnapshotAgeMs: 0, jitterMs: 0, snapshotMaxAgeMs: 20000, ackRule: "none" } };
  const a = await w.device(A, { options: opts });
  for (let i = 0; i < 12; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a], 8000);
  }
  await w.run([a], 20000);
  assert.ok(snaps(w, A).length >= 1 && snaps(w, A).length <= 2, `snapshots: ${snaps(w, A).length}`);
  const c = await w.device("kim-cccccccc");
  assert.deepEqual(json(c), json(a));
});

test("reseed after the folder is emptied restores it for a new device", async () => {
  const w = await makeWorld({ tables: { notes: "yjs", tasks: "yjs" } });
  const a = await w.device(A);
  const b = await w.device(B);
  a.table("notes").getMap("m").set("x", 1);
  b.table("tasks").getMap("m").set("y", 2);
  await w.run([a, b], 30000);
  w.folder.empty();
  assert.equal(w.folder.paths().length, 0);
  await a.reseed();
  for (const p of w.folder.paths()) assert.ok(p.startsWith(`data/`) && p.includes(`/${A}/snap-`), p);
  const c = await w.device("kim-cccccccc");
  assert.deepEqual(json(c, "notes"), json(a, "notes"));
  assert.deepEqual(json(c, "tasks"), json(a, "tasks"));
  // a keeps working afterwards without reusing seq numbers it already covered
  a.table("notes").getMap("m").set("z", 3);
  await w.run([a, c], 30000);
  assert.deepEqual(json(c, "notes").m, { x: 1, z: 3 });
});

test("every write and delete stays inside the device's own paths", async () => {
  const { w } = await busyPair();
  await w.run([], 0);
  const ok = (path) => /^data\/notes\/(harry-aaaaaaaa|sam-bbbbbbbb)\//.test(path) || /^status\/(harry-aaaaaaaa|sam-bbbbbbbb)\.ywb$/.test(path);
  for (const x of [...w.folder.writes, ...w.folder.deletes]) assert.ok(ok(x.path), x.path);
});

// Bug 2: a peer whose status file exists but cannot be read (empty or
// truncated while syncing) must not count as "no objection".
async function compactingAlone(prepare) {
  const w = await makeWorld();
  const b = await w.device(B, { options: { compaction: { enabled: false } } });
  b.table("notes").getMap("m").set("b0", 1);
  await w.run([b], 12000); // b writes a chunk and a status file
  await prepare(w);
  const a = await w.device(A, { options: COMPACT });
  for (let i = 0; i < 8; i++) {
    a.table("notes").getMap("m").set(`a${i}`, i);
    await w.run([a], 6000);
  }
  await w.run([a], 60000);
  return { w, a, b };
}

test("a peer whose status file is unreadable blocks deletion until it can be read", async () => {
  const path = `status/${B}.ywb`;
  const { w, a, b } = await compactingAlone((x) => x.folder.copy(path, path, 20));
  assert.equal(snaps(w, A).length, 1, "a wrote a snapshot");
  assert.equal(w.folder.deletes.length, 0, "nothing deleted while b's status is unreadable");
  await w.run([a, b], 30000); // b rewrites its status, acknowledges
  assert.ok(w.folder.deletes.length > 0, "deleted once b's status is readable and acknowledges");
});

test("a peer that wrote data but has no status file yet blocks deletion", async () => {
  const { w, a, b } = await compactingAlone((x) => x.folder.remove(`status/${B}.ywb`));
  assert.equal(snaps(w, A).length, 1);
  assert.equal(w.folder.deletes.length, 0);
  await w.run([a, b], 30000);
  assert.ok(w.folder.deletes.length > 0);
});
