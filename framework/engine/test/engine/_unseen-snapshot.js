// Shared setup (not a test file): device A's store is wiped and its folder
// emptied apart from a snapshot, written by B, that has not reached A yet. A
// restarts at chunk 1 and writes new content, which B's snapshot "covers" by
// number (A's old chunks 1..7) but does not contain.
import { makeWorld } from "./_harness.js";

export const A = "harry-aaaaaaaa";
export const B = "sam-bbbbbbbb";
export const ownChunks = (w) => w.folder.paths(`data/notes/${A}/`).filter((p) => /\/\d{6}\.ywb$/.test(p)).map((p) => p.split("/").pop());

/** `aOptions` are extra engine options for A's second session. The listing of B's folder is still hidden from A when this returns. */
export async function restartedBehindUnseenSnapshot(aOptions = {}) {
  const w = await makeWorld();
  const a = await w.device(A, { options: { sealBytes: 1 } });
  const b = await w.device(B, { options: { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } } });
  for (let i = 0; i < 7; i++) {
    a.table("notes").getMap("m").set(`k${i}`, i);
    await w.run([a, b], 6000);
  }
  await w.run([a, b], 30000);
  if (w.folder.paths(`data/notes/${B}/snap-`).length !== 1) throw new Error("b did not write a snapshot");
  await a.close();
  for (const p of [...ownChunks(w).map((n) => `data/notes/${A}/${n}`), ...w.folder.paths("status/")]) w.folder.remove(p);
  w.store(A).wipe();
  w.folder.hideListing((p) => p === `data/notes/${B}`); // the snapshot has not reached A yet
  const a2 = await w.device(A, { options: { sealBytes: 1, ...aOptions } });
  a2.table("notes").getMap("m").set("fresh", 1);
  await w.run([a2], 15000);
  if (ownChunks(w).join() !== "000001.ywb") throw new Error(`A did not restart at chunk 1: ${ownChunks(w)}`);
  return { w, a2, b };
}
