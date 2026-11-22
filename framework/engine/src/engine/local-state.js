// Durable local state per table, kept in the injected store (ADR-0001 section 2).
//
// Keys (all under t/<table>/):
//   snap/<n>   adapter snapshot covering update log entries up to n
//   upd/<n>    framed list of updates applied to the doc (local or remote)
//   pend/<n>   one local update not yet written to the folder
//   idx        JSON { files: { <path>: record } } of folder files applied
//   hw         JSON { seq } highest own chunk seq successfully written
//
// Recovery = highest snap + every upd entry (applying twice is harmless).
import { frameUpdates, parseFrames } from "./envelope.js";

const pad = (n) => String(n).padStart(9, "0");
const prefix = (table) => `t/${table}/`;
export const keyOf = {
  snap: (t, n) => `${prefix(t)}snap/${pad(n)}`,
  upd: (t, n) => `${prefix(t)}upd/${pad(n)}`,
  pend: (t, n) => `${prefix(t)}pend/${pad(n)}`,
  idx: (t) => `${prefix(t)}idx`,
  hw: (t) => `${prefix(t)}hw`,
};

const tail = (key) => Number(key.slice(key.lastIndexOf("/") + 1));
const ofKind = (keys, table, kind) => keys.filter((k) => k.startsWith(`${prefix(table)}${kind}/`)).sort();

/** Rebuild a table's doc and bookkeeping from the store. */
export async function restoreTable({ store, adapter, table, onError }) {
  const doc = adapter.create();
  const keys = await store.keys(prefix(table));
  const snaps = ofKind(keys, table, "snap");
  const upds = ofKind(keys, table, "upd");
  const pends = ofKind(keys, table, "pend");
  const apply = (bytes) => {
    try {
      adapter.applyUpdate(doc, bytes, "restore");
    } catch (err) {
      onError(err);
    }
  };
  if (snaps.length) apply(await store.get(snaps.at(-1)));
  for (const key of upds) {
    try {
      parseFrames(await store.get(key)).forEach(apply);
    } catch (err) {
      onError(err);
    }
  }
  const pending = [];
  for (const key of pends) {
    // a crash can fall between persisting a pending update and logging it: the doc must have it too
    const bytes = await store.get(key);
    apply(bytes);
    pending.push({ key, bytes, persisted: true, at: null });
  }
  return {
    doc,
    pending,
    updSeq: Math.max(0, ...upds.map(tail), ...snaps.map(tail)),
    pendSeq: Math.max(0, ...pends.map(tail)),
    updSinceSnap: upds.length,
    idx: (await store.get(keyOf.idx(table))) ?? { files: {} },
    hw: (await store.get(keyOf.hw(table)))?.seq ?? 0,
  };
}

/** Log updates applied to the doc; fold the log into a snapshot now and then. */
export async function logUpdates(ctx, T, updates) {
  const { store } = ctx.cfg;
  T.updSeq += 1;
  await store.set(keyOf.upd(T.name, T.updSeq), frameUpdates(updates));
  T.updSinceSnap += 1;
  if (T.updSinceSnap >= ctx.cfg.options.localSnapshotEvery) await foldLog(ctx, T);
}

async function foldLog(ctx, T) {
  const { store } = ctx.cfg;
  const upTo = T.updSeq;
  await store.set(keyOf.snap(T.name, upTo), T.adapter.snapshot(T.doc));
  T.updSinceSnap = 0;
  const keys = await store.keys(prefix(T.name));
  const stale = [...ofKind(keys, T.name, "upd"), ...ofKind(keys, T.name, "snap")].filter((k) => tail(k) <= upTo && k !== keyOf.snap(T.name, upTo));
  for (const key of stale) await store.delete(key);
}

/** Persist a local update as pending. Resolves true only if the store took it (the edit is then accepted). */
export async function addPending(ctx, T, entry) {
  T.pendSeq += 1;
  const key = keyOf.pend(T.name, T.pendSeq);
  entry.key = key;
  let stored = true;
  try {
    await ctx.cfg.store.set(key, entry.bytes);
  } catch (err) {
    stored = false;
    ctx.recordError("store", err, { table: T.name });
  }
  entry.persisted = true;
  return stored;
}

export async function dropPending(ctx, T, entries) {
  const gone = new Set(entries);
  T.pending = T.pending.filter((e) => !gone.has(e));
  for (const e of entries) {
    try {
      await ctx.cfg.store.delete(e.key);
    } catch (err) {
      ctx.recordError("store", err, { table: T.name });
    }
  }
}

export async function saveIdx(ctx, T) {
  if (!T.idxDirty) return;
  try {
    await ctx.cfg.store.set(keyOf.idx(T.name), T.idx);
    T.idxDirty = false;
  } catch (err) {
    ctx.recordError("store", err, { table: T.name });
  }
}

export async function saveHw(ctx, T, seq) {
  if (seq <= T.hw) return;
  T.hw = seq;
  try {
    await ctx.cfg.store.set(keyOf.hw(T.name), { seq });
  } catch (err) {
    ctx.recordError("store", err, { table: T.name });
  }
}

/** Record that a folder file has been applied (immutably replaces the record). */
export function markApplied(T, path, record) {
  T.idx = { ...T.idx, files: { ...T.idx.files, [path]: record } };
  T.idxDirty = true;
}

export function forgetFiles(T, paths) {
  const files = { ...T.idx.files };
  for (const p of paths) delete files[p];
  T.idx = { ...T.idx, files };
  T.idxDirty = true;
}
