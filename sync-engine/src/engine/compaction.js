// Snapshots and compaction (ADR-0001 section 8). A device only ever deletes
// files in its own folder, and only once a snapshot that covers them has been
// acknowledged (or at once, with ackRule "none", which is unsafe by design).
import { seal } from "./envelope.js";
import { baseCovers, computeCovers, computeIds, loadedSnapshots, provablyCovered } from "./coverage.js";
import { chunkName, formatStamp, parseStamp, snapName } from "./layout-chunks.js";
import { makeMeta } from "./saver.js";
import { forgetFiles, markApplied, saveIdx } from "./local-state.js";
import { isPeerActive } from "./status-files.js";

/** Write a snapshot of the whole table into the own folder. Returns its name. */
export async function writeSnapshot(ctx, T) {
  const { cfg } = ctx;
  const taken = new Set(T.listing.files.filter((e) => e.kind === "snap" && e.device === cfg.deviceId).map((e) => e.name));
  let ms = cfg.clock.now();
  while (taken.has(snapName(formatStamp(ms)))) ms += 1000;
  const stamp = formatStamp(ms);
  const name = snapName(stamp);
  const covers = computeCovers(T);
  const ids = computeIds(T, covers);
  const meta = makeMeta(ctx, T, "snapshot", { covers, ids });
  const bytes = await seal({ key: cfg.key, keyId: cfg.keyId, iv: cfg.random.bytes(12), meta, updates: [T.adapter.snapshot(T.doc)] });
  const path = await ctx.layout.writeData(T.name, name, bytes);
  let fp = `${bytes.length}:?`;
  try {
    fp = (await ctx.layout.statData(T.name, name)).fingerprint;
  } catch {
    // re-read once on the next scan
  }
  const stampMs = parseStamp(stamp);
  markApplied(T, path, { kind: "snap", device: cfg.deviceId, name, fp, covers, ids, writtenAt: meta.writtenAt, stampMs });
  T.listing = { ...T.listing, files: [...T.listing.files, { kind: "snap", device: cfg.deviceId, name, path, stamp, stampMs, suffix: "" }] };
  return name;
}

export async function reseed(ctx) {
  const written = [];
  for (const T of ctx.tables.values()) {
    try {
      written.push(`${ctx.cfg.deviceId}/${await writeSnapshot(ctx, T)}`);
      await saveIdx(ctx, T);
    } catch (err) {
      ctx.recordError("snapshot", err, { table: T.name });
    }
  }
  return written;
}

async function maybeSnapshot(ctx, T, now) {
  const c = ctx.cfg.options.compaction;
  const files = T.listing?.files ?? [];
  const chunkCount = files.filter((e) => e.kind === "chunk").length;
  // a snapshot stamped ahead of our clock (a skewed writer) says nothing about how stale compaction is
  const newest = Math.max(-Infinity, ...files.filter((e) => e.kind === "snap" && e.stampMs <= now).map((e) => e.stampMs));
  const wanted = chunkCount > c.chunkThreshold && (newest === -Infinity || now - newest > c.snapshotMaxAgeMs);
  if (!wanted) {
    T.compactAt = null;
    return;
  }
  T.compactAt ??= now + Math.floor(ctx.cfg.random.float() * c.jitterMs);
  if (now < T.compactAt) return;
  T.compactAt = null;
  await writeSnapshot(ctx, T);
  await saveIdx(ctx, T);
}

/**
 * A peer we cannot hear from is not a peer with no objection. Deletion waits
 * while any other device (a) has a status file we cannot read right now, or
 * (b) has written data for this table but has no status we ever read. Peers
 * with a last good status are judged by it (see acknowledged) once readable.
 */
function hasUnconfirmedPeer(ctx, T) {
  const self = ctx.cfg.deviceId;
  if (ctx.rt.statusUnreadable.some((u) => u.device !== self)) return true;
  return (T.listing?.files ?? []).some((e) => e.device !== self && !ctx.rt.statuses.has(e.device));
}

function acknowledged(ctx, T, now) {
  const c = ctx.cfg.options.compaction;
  const present = new Set((T.listing?.files ?? []).filter((e) => e.kind === "snap").map((e) => e.path));
  const loaded = Object.entries(T.idx.files).filter(([path, f]) => f.kind === "snap" && present.has(path)).map(([path, f]) => ({ ...f, path }));
  if (c.ackRule === "none") return loaded;
  if (hasUnconfirmedPeer(ctx, T)) return [];
  const active = [...ctx.rt.statuses]
    .filter(([device, s]) => s.meta.tables?.[T.name] && isPeerActive(ctx, device, now))
    .map(([, s]) => s.meta);
  return loaded.filter((s) => now - s.stampMs >= c.minSnapshotAgeMs && active.every((m) => m.tables[T.name].snapshots?.includes(`${s.device}/${s.name}`)));
}

const dominates = (newer, older) => Object.entries(older).every(([device, seq]) => (newer[device] ?? 0) >= seq);

function deletable(ctx, T, acked) {
  const self = ctx.cfg.deviceId;
  const own = T.listing.files.filter((e) => e.device === self);
  const primary = (e) => T.idx.files[ctx.layout.dataPath(T.name, self, chunkName(e.seq))];
  // covered means: an acknowledged snapshot lists this exact version (a
  // conflict copy goes with its primary), not merely a chunk with this number
  const chunks = own.filter((e) => e.kind === "chunk" && e.seq < T.open.seq && provablyCovered(acked, self, e.seq, primary(e)?.iv));
  const snaps = own.filter((e) => {
    const rec = T.idx.files[e.path];
    return e.kind === "snap" && rec && acked.some((n) => n.path !== e.path && n.stampMs > rec.stampMs && dominates(n.covers, rec.covers));
  });
  return [...chunks, ...snaps];
}

async function deleteSuperseded(ctx, T, now) {
  const acked = acknowledged(ctx, T, now);
  if (!acked.length) return;
  const removed = [];
  for (const e of deletable(ctx, T, acked)) {
    const known = T.idx.files[e.path];
    if (known) ctx.tracer.hintSize(e.path, known.size ?? Number(String(known.fp).split(":")[0]));
    try {
      await ctx.layout.removeData(T.name, e.name);
      removed.push(e.path);
    } catch (err) {
      ctx.recordError("delete", err, { table: T.name, path: e.path });
      T.compactRetryAt = now + ctx.cfg.options.retryInitialMs;
    }
  }
  if (!removed.length) return;
  const gone = new Set(removed);
  T.listing = { ...T.listing, files: T.listing.files.filter((e) => !gone.has(e.path)) };
  forgetFiles(T, removed.filter((p) => T.idx.files[p]?.kind === "chunk"));
  await saveIdx(ctx, T);
}

/**
 * Our own chunks that a loaded snapshot shadows by number but does not
 * contain (a device that restarted at a low chunk number before a snapshot
 * covering the old chunks reached it). Readers skip such chunks as covered, so
 * move the open chunk above the covered range and publish everything we hold
 * in a snapshot, once. Never throws.
 */
export async function republishShadowed(ctx, T) {
  const self = ctx.cfg.deviceId;
  const covered = baseCovers(T)[self] ?? 0;
  if (!T.ready || !covered) return;
  const snaps = loadedSnapshots(T);
  const shadowed = Object.entries(T.idx.files).filter(([, f]) => f.kind === "chunk" && f.device === self && f.suffix === "" && f.seq <= covered && !f.republished && !provablyCovered(snaps, self, f.seq, f.iv));
  const openShadowed = T.open.seq <= covered;
  if (!shadowed.length && !openShadowed) return;
  try {
    if (openShadowed) T.open = { seq: covered + 1, updates: [], prev: null };
    await writeSnapshot(ctx, T);
    for (const [path, f] of shadowed) markApplied(T, path, { ...f, republished: true });
    await saveIdx(ctx, T);
  } catch (err) {
    ctx.recordError("snapshot", err, { table: T.name });
  }
}

/** One compaction pass over every table. Never throws. */
export async function compactionStep(ctx) {
  if (!ctx.cfg.options.compaction.enabled) return;
  const now = ctx.cfg.clock.now();
  for (const T of ctx.tables.values()) {
    if (!T.listing || (T.compactRetryAt != null && now < T.compactRetryAt)) continue;
    try {
      await maybeSnapshot(ctx, T, now);
      await deleteSuperseded(ctx, T, now);
    } catch (err) {
      ctx.recordError("compaction", err, { table: T.name });
      T.compactRetryAt = now + ctx.cfg.options.retryInitialMs;
    }
  }
}
