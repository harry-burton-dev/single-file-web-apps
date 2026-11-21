// Saving (ADR-0001 sections 4 and 6): when a save is due, and how the open
// chunk of each table is rewritten.
import { seal, open as openEnvelope } from "./envelope.js";
import { chunkName } from "./layout-chunks.js";
import { MAX_CHUNK_SEQ } from "./constants.js";
import { baseCovers, chunkId } from "./coverage.js";
import { dropPending, markApplied, saveHw, saveIdx } from "./local-state.js";

/** Metadata block shared by chunks and snapshots. */
export function makeMeta(ctx, T, kind, extra = {}) {
  const { cfg } = ctx;
  return {
    kind,
    user: cfg.user,
    device: cfg.deviceId,
    table: T.name,
    adapter: T.adapterName,
    schemaVersion: cfg.options.schemaVersions[T.name] ?? 1,
    appVersion: cfg.options.appVersion,
    writtenAt: cfg.clock.now(),
    ...extra,
  };
}

/**
 * Pure timing rule: quiet period, max wait, min interval, retry backoff.
 * { due, reason }: when due, reason is "quiet", "max-wait" or "retry"; when
 * not, "nothing-pending", "backoff" (retry not yet due), "min-interval" or
 * "waiting" (quiet period and max wait not yet reached).
 */
export function saveDecision({ oldestAt, newestAt, lastSaveAt, retryAt }, now, o) {
  if (oldestAt == null) return { due: false, reason: "nothing-pending" };
  const intervalOk = lastSaveAt == null || now - lastSaveAt >= o.minIntervalMs;
  if (retryAt != null) {
    if (now < retryAt) return { due: false, reason: "backoff" };
    return intervalOk ? { due: true, reason: "retry" } : { due: false, reason: "min-interval" };
  }
  const quiet = now - newestAt >= o.quietMs;
  if (!quiet && now - oldestAt < o.maxWaitMs) return { due: false, reason: "waiting" };
  if (!intervalOk) return { due: false, reason: "min-interval" };
  return { due: true, reason: quiet ? "quiet" : "max-wait" };
}

export const isSaveDue = (bounds, now, o) => saveDecision(bounds, now, o).due;

export function pendingBounds(ctx) {
  const times = [...ctx.tables.values()].flatMap((T) => T.pending.map((e) => e.at));
  return times.length ? { oldestAt: Math.min(...times), newestAt: Math.max(...times) } : { oldestAt: null, newestAt: null };
}

export function saveDecisionNow(ctx) {
  const { rt, cfg } = ctx;
  return saveDecision({ ...pendingBounds(ctx), lastSaveAt: rt.lastSaveAt, retryAt: rt.retryAt }, cfg.clock.now(), cfg.options);
}

export const saveDue = (ctx) => saveDecisionNow(ctx).due;

async function recordFile(ctx, T, name, bytes, meta) {
  let fingerprint = `${bytes.length}:?`;
  try {
    fingerprint = (await ctx.layout.statData(T.name, name)).fingerprint;
  } catch {
    // the next scan re-reads our own file once; harmless
  }
  const { seq, prev } = T.open;
  markApplied(T, ctx.layout.dataPath(T.name, ctx.cfg.deviceId, name), { kind: "chunk", device: ctx.cfg.deviceId, seq, suffix: "", fp: fingerprint, size: bytes.length, iv: chunkId(bytes), prev: meta.prev ?? prev ?? null });
}

async function writeOpenChunk(ctx, T, content) {
  const { cfg } = ctx;
  const meta = makeMeta(ctx, T, "chunk", { seq: T.open.seq, prev: T.open.prev });
  const bytes = await seal({ key: cfg.key, keyId: cfg.keyId, iv: cfg.random.bytes(12), meta, updates: content });
  const name = chunkName(T.open.seq);
  await ctx.layout.writeData(T.name, name, bytes);
  return { bytes, name, meta };
}

/**
 * Never reuse a chunk name we did not write in this store's lifetime: other
 * devices treat an applied sealed chunk as final and would never re-read a
 * replaced one. A direct existence probe works even when listings fail.
 */
async function claimFreshSeq(ctx, T) {
  if (T.open.updates.length || T.open.seq <= T.hw) return;
  let seq = T.open.seq;
  while (await ctx.layout.exists(T.name, chunkName(seq))) seq += 1;
  if (seq !== T.open.seq) T.open = { seq, updates: [], prev: null };
}

/** We are done with this chunk and the applied copy is the one in the folder: it is final. */
function markSealed(ctx, T, name) {
  const path = ctx.layout.dataPath(T.name, ctx.cfg.deviceId, name);
  const record = T.idx.files[path];
  if (record) markApplied(T, path, { ...record, sealed: true });
}

/** Rewrite table T's open chunk with its pending updates. Returns success. */
export async function saveTable(ctx, T) {
  const entries = T.pending.filter((e) => e.persisted);
  if (!entries.length) return true;
  const { options } = ctx.cfg;
  const all = [...T.open.updates, ...entries.map((e) => e.bytes)];
  let written;
  let content;
  try {
    await claimFreshSeq(ctx, T);
    content = options.chunkContent === "merged" && T.adapter.compact ? T.adapter.compact(all) : all;
    written = await writeOpenChunk(ctx, T, content);
  } catch (err) {
    ctx.recordError("save", err, { table: T.name });
    return false;
  }
  const { seq } = T.open;
  await recordFile(ctx, T, written.name, written.bytes, written.meta);
  await saveIdx(ctx, T); // a restart must not take our newest write for a foreign version (own-repair.js)
  T.open = { ...T.open, updates: content };
  await saveHw(ctx, T, seq);
  await dropPending(ctx, T, entries);
  if (written.bytes.length >= options.sealBytes) {
    markSealed(ctx, T, written.name);
    T.open = { seq: seq + 1, updates: [], prev: { seq, size: written.bytes.length } };
  }
  ctx.emit("saved", { table: T.name, seq, bytes: written.bytes.length, at: ctx.cfg.clock.now() });
  return true;
}

/** Write the open chunk again as held in memory (the copy in the folder was lost or replaced). */
export async function rewriteOpenChunk(ctx, T) {
  const written = await writeOpenChunk(ctx, T, T.open.updates);
  await recordFile(ctx, T, written.name, written.bytes, written.meta);
}

function backoffMs(options, failures) {
  return Math.min(options.retryInitialMs * 2 ** (failures - 1), options.retryMaxMs);
}

/** Save every table with pending updates. Returns true when nothing failed. */
export async function saveAll(ctx) {
  const { rt, cfg } = ctx;
  const started = cfg.clock.now();
  let failed = false;
  let saved = false;
  for (const T of ctx.tables.values()) {
    if (!T.pending.some((e) => e.persisted)) continue;
    if (await ctx.layout.save(T)) saved = true;
    else failed = true;
  }
  if (saved) rt.lastSaveAt = started;
  rt.lastSave = { saved, failed };
  if (failed) {
    if (rt.retryAt == null) rt.retrySince = started;
    rt.failures += 1;
    rt.retryAt = started + backoffMs(cfg.options, rt.failures);
  } else {
    rt.failures = 0;
    rt.retryAt = null;
  }
  return !failed;
}

async function continueChunk(ctx, T, entry) {
  const file = await ctx.layout.open(entry);
  if (file.size >= ctx.cfg.options.sealBytes) return null;
  const { meta, updates } = await openEnvelope({ keys: ctx.keys, bytes: await file.bytes() });
  if (meta.table !== T.name || meta.adapter !== T.adapterName) return null;
  return { seq: entry.seq, updates, prev: meta.prev ?? null };
}

async function prevOf(ctx, entry) {
  if (!entry) return null;
  try {
    return { seq: entry.seq, size: (await ctx.layout.open(entry)).size };
  } catch {
    return null;
  }
}

/**
 * Sequence numbers in status files are untrusted input. One we could not turn
 * into a file name (not an integer in 1..MAX_CHUNK_SEQ - 1, so that the next
 * number still fits the 6-digit rule) would wedge saving for good. A value in
 * range but wrong only burns numbers.
 */
const isPlausibleSeq = (n) => Number.isInteger(n) && n >= 1 && n < MAX_CHUNK_SEQ;

/**
 * Highest chunk seq of ours that anyone has recorded: our own status file
 * (survives a wiped store) and what every peer's status file says it has seen
 * of us. Independent of folder listings, which can be empty or fail.
 */
function evidenceFloor(ctx, T) {
  const self = ctx.cfg.deviceId;
  const metas = [...ctx.rt.statuses.values()].map((s) => s.meta);
  if (ctx.rt.ownStatus) metas.push(ctx.rt.ownStatus);
  const seen = metas.map((m) => m.tables?.[T.name]?.applied?.[self]);
  return Math.max(0, ...seen.flatMap((a) => [a?.seen, a?.sealed]).filter(isPlausibleSeq));
}

/** Decide which chunk this session writes into (ADR-0001 section 4). */
export async function initOpenChunk(ctx, T) {
  const self = ctx.cfg.deviceId;
  const own = T.listing.files.filter((e) => e.device === self && e.kind === "chunk");
  const maxListed = Math.max(0, ...own.map((e) => e.seq));
  const highest = Math.max(maxListed, baseCovers(T)[self] ?? 0, T.hw, evidenceFloor(ctx, T));
  const primary = own.find((e) => e.seq === highest && e.suffix === "");
  if (!ctx.cfg.options.newChunkPerSession && primary) {
    try {
      const open = await continueChunk(ctx, T, primary);
      if (open) {
        T.open = open;
        return;
      }
    } catch (err) {
      ctx.recordError("read", err, { table: T.name, path: primary.path });
    }
  }
  const prev = await prevOf(ctx, primary);
  T.open = { seq: highest + 1, updates: [], prev };
  // The copy we applied is the one in the folder now, and we never write it again.
  if (primary && prev && T.idx.files[primary.path]?.size === prev.size) markSealed(ctx, T, primary.name);
}
