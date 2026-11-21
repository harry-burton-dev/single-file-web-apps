// What this device has applied, per table, derived from the applied-file index.
//
// "Sealed" means final: the writer never rewrites a chunk once it has started
// the next one. A reader may only trust that it holds the FINAL version of
// chunk s if the next chunk's metadata (prev: {seq, size}) names the size of
// the version the reader applied; otherwise it may have read a stale copy of
// s while s+1 had already arrived (files sync independently).

const filesOf = (T) => Object.values(T.idx.files);

/**
 * Identity of one written version of a chunk file: the first 4 bytes of its
 * random IV (bytes 5-8 of the envelope, new for every write). A covering
 * snapshot lists this per chunk, so "covered" means "this exact version is in
 * the snapshot", not merely "a chunk with this number was once in it".
 */
export const chunkId = (bytes) => [...bytes.slice(5, 9)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function loadedSnapshots(T) {
  return filesOf(T).filter((f) => f.kind === "snap");
}

/** Per device, the highest chunk seq included in any loaded snapshot. */
export function baseCovers(T) {
  const base = {};
  for (const snap of loadedSnapshots(T)) {
    for (const [device, seq] of Object.entries(snap.covers ?? {})) base[device] = Math.max(base[device] ?? 0, seq);
  }
  return base;
}

function chunkIndex(T) {
  const byDevice = {};
  for (const f of filesOf(T)) {
    if (f.kind !== "chunk") continue;
    const seqs = (byDevice[f.device] ??= {});
    const entry = (seqs[f.seq] ??= { primary: null });
    if (f.suffix === "") entry.primary = f;
  }
  return byDevice;
}

function isBlocked(T, device, seq) {
  const tag = `/${device}/${String(seq).padStart(6, "0")}`;
  return T.unreadable.some((u) => u.path.includes(tag));
}

function extend(T, device, start, seqs) {
  let seq = start;
  for (;;) {
    const cur = seqs[seq + 1]?.primary;
    const next = seqs[seq + 2]?.primary;
    if (!cur || isBlocked(T, device, seq + 1)) return seq;
    const provenFinal = next?.prev?.seq === seq + 1 && next.prev.size === cur.size;
    if (!cur.sealed && !provenFinal) return seq;
    seq += 1;
  }
}

/**
 * Highest sealed chunk seq per device that is fully applied here (contiguous
 * from what loaded snapshots already cover). Own chunks count only when this
 * device applied them and knows that copy to be final (sealed flag), exactly
 * like a peer's: a chunk we never applied, or applied in an older version, is
 * not claimed.
 */
export function computeCovers(T) {
  const base = baseCovers(T);
  const index = chunkIndex(T);
  const covers = { ...base };
  for (const [device, seqs] of Object.entries(index)) {
    const seq = extend(T, device, base[device] ?? 0, seqs);
    if (seq > 0) covers[device] = seq;
  }
  return covers;
}

/**
 * { device: { seq: id } } for every chunk file still in the folder that the
 * given covers vector includes. Ids come from what this device applied, else
 * from the loaded snapshots (which saw the chunk when it was covered).
 */
export function computeIds(T, covers) {
  const ids = {};
  const carried = (device, seq) => loadedSnapshots(T).map((s) => s.ids?.[device]?.[seq]).find(Boolean);
  for (const e of T.listing?.files ?? []) {
    if (e.kind !== "chunk" || e.suffix !== "" || e.seq > (covers[e.device] ?? 0)) continue;
    const id = T.idx.files[e.path]?.iv ?? carried(e.device, e.seq);
    if (id) (ids[e.device] ??= {})[e.seq] = id;
  }
  return ids;
}

/** Is this exact version of our own chunk listed by a snapshot that covers it? */
export function provablyCovered(snaps, device, seq, id) {
  return Boolean(id) && snaps.some((s) => (s.covers?.[device] ?? 0) >= seq && s.ids?.[device]?.[seq] === id);
}

/** { device: { sealed, seen } } for the status file. */
export function appliedSummary(T, selfId) {
  const covers = computeCovers(T);
  const seen = {};
  for (const f of filesOf(T)) {
    if (f.kind === "chunk") seen[f.device] = Math.max(seen[f.device] ?? 0, f.seq);
  }
  seen[selfId] = Math.max(seen[selfId] ?? 0, T.hw);
  const out = {};
  for (const device of new Set([...Object.keys(covers), ...Object.keys(seen)])) {
    out[device] = { sealed: covers[device] ?? 0, seen: seen[device] ?? 0 };
  }
  return out;
}

/** Names `<device>/<file>` of loaded snapshots that still exist in the folder. */
export function loadedSnapshotNames(T) {
  const present = new Set((T.listing?.files ?? []).filter((e) => e.kind === "snap").map((e) => e.path));
  return Object.entries(T.idx.files)
    .filter(([path, f]) => f.kind === "snap" && present.has(path))
    .map(([, f]) => `${f.device}/${f.name}`)
    .sort();
}
