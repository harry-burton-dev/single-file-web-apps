// Reading the folder (ADR-0001 section 7). Never throws: every failure is
// recorded and the file is retried on the next scan.
import { open } from "./envelope.js";
import { logUpdates, markApplied, saveIdx, forgetFiles } from "./local-state.js";
import { baseCovers, chunkId } from "./coverage.js";
import { chunkName } from "./layout-chunks.js";
import { checkDigestAgreement, readStatusFiles } from "./status-files.js";
import { noteOwnChanged, noteOwnLost } from "./own-repair.js";

const describe = (error) => ({ name: error?.name ?? "Error", message: String(error?.message ?? error) });

function byReadOrder(a, b) {
  return a.device.localeCompare(b.device) || (a.seq ?? 0) - (b.seq ?? 0) || a.name.localeCompare(b.name);
}

function recordFor(e, file, meta, bytes) {
  if (e.kind === "snap") {
    return { kind: "snap", device: e.device, name: e.name, fp: file.fingerprint, covers: meta.covers ?? {}, ids: meta.ids ?? {}, writtenAt: meta.writtenAt ?? 0, stampMs: e.stampMs };
  }
  return { kind: "chunk", device: e.device, seq: e.seq, suffix: e.suffix, fp: file.fingerprint, size: file.size, iv: chunkId(bytes), prev: meta.prev ?? null };
}

function checkMeta(T, e, meta) {
  const wantKind = e.kind === "snap" ? "snapshot" : "chunk";
  if (meta?.table !== T.name || meta?.adapter !== T.adapterName) return "ignore"; // other table or adapter
  if (meta.kind !== wantKind) throw new Error(`file kind ${meta.kind} does not match name`);
  return "ok";
}

async function applyEntry(ctx, T, e, file, bytes, parsed) {
  const record = recordFor(e, file, parsed.meta, bytes);
  if (checkMeta(T, e, parsed.meta) === "ignore") {
    markApplied(T, e.path, { ...record, ignored: true });
    ctx.tracer.apply({ table: T.name, path: e.path, bytes: bytes.length, result: "ignored (other table or adapter)" });
    return;
  }
  for (const update of parsed.updates) T.adapter.applyUpdate(T.doc, update, { device: e.device });
  if (parsed.updates.length) {
    try {
      await logUpdates(ctx, T, parsed.updates);
    } catch (err) {
      ctx.recordError("store", err, { table: T.name, path: e.path });
      return; // not marked applied: read again next scan
    }
  }
  // our own chunk in a version we did not write down: rolled back or replaced
  const known = T.idx.files[e.path];
  const changed = e.device === ctx.cfg.deviceId && e.kind === "chunk" && e.suffix === "" && Boolean(known?.iv) && known.iv !== record.iv;
  markApplied(T, e.path, changed && known.sealed ? { ...record, sealed: true } : record);
  if (changed) noteOwnChanged(T, e.seq);
  ctx.tracer.apply({ table: T.name, path: e.path, count: parsed.updates.length, bytes: bytes.length });
  if (e.device !== ctx.cfg.deviceId) {
    ctx.emit("received", { table: T.name, device: parsed.meta.device ?? e.device, writtenAt: parsed.meta.writtenAt });
  }
}

/**
 * Is the applied version of this file known to be the final one? A snapshot
 * and a conflict copy are immutable. A chunk is final only when the next
 * chunk of the same device (already applied) records, in prev.size, exactly
 * the size of the version applied here: the writer never touches a chunk after
 * starting the next, so that size is the final size. Merely seeing a higher
 * number in the listing proves nothing, because the copy we applied may be an
 * older write of a chunk that was rewritten before it was sealed.
 */
function isFinal(ctx, T, e, known) {
  if (!known) return false;
  if (e.kind === "snap" || known.ignored || e.suffix !== "") return true;
  if (known.sealed) return true; // our own, applied and known to match the folder when we moved past it
  const next = T.idx.files[ctx.layout.dataPath(T.name, e.device, chunkName(e.seq + 1))];
  if (next?.kind !== "chunk" || next.prev?.seq !== e.seq || typeof next.prev.size !== "number") return false;
  if (known.size > next.prev.size) {
    // cannot happen with a well-behaved writer: keep re-checking, but say so once
    if (!T.sizeAnomalies.has(e.path)) {
      T.sizeAnomalies.add(e.path);
      ctx.recordError("scan", new Error(`applied chunk is ${known.size} bytes but the next chunk says its predecessor ended at ${next.prev.size}`), { table: T.name, path: e.path });
    }
    return false;
  }
  return known.size === next.prev.size;
}

async function readEntry(ctx, T, e, unreadable) {
  const known = T.idx.files[e.path];
  // never read again, except our own sealed chunks, which are compared with the folder now and then
  if (isFinal(ctx, T, e, known) && !(T.checkOwn && known.sealed && e.kind === "chunk" && e.device === ctx.cfg.deviceId)) return;
  try {
    const file = await ctx.layout.open(e); // metadata only; non-final chunks are few
    if (known?.fp === file.fingerprint) {
      ctx.tracer.step({ table: T.name, path: e.path, action: "skip", result: "unchanged" });
      return;
    }
    const bytes = await file.bytes();
    try {
      await applyEntry(ctx, T, e, file, bytes, await open({ keys: ctx.keys, bytes }));
    } catch (err) {
      ctx.tracer.apply({ table: T.name, path: e.path, bytes: bytes.length, error: describe(err) });
      throw err;
    }
  } catch (err) {
    unreadable.push({ path: e.path, error: describe(err) });
  }
}

function prune(T, listing) {
  if (listing.errors.length) return;
  const present = new Set(listing.files.map((e) => e.path));
  const base = baseCovers(T);
  const gone = Object.entries(T.idx.files)
    .filter(([path, f]) => f.kind === "chunk" && !present.has(path) && f.seq <= (base[f.device] ?? 0))
    .map(([path]) => path);
  if (gone.length) forgetFiles(T, gone);
}

export async function scanTable(ctx, T) {
  const listing = await ctx.layout.listTable(T.name);
  for (const e of listing.errors) ctx.recordError("list", e.error, { path: e.path });
  T.listing = listing;
  for (const e of listing.files) if (e.suffix) ctx.metrics.copySeen(e.path);
  const unreadable = [];
  const now = ctx.cfg.clock.now();
  T.checkOwn = T.ownCheckAt == null || now >= T.ownCheckAt;
  if (T.checkOwn) T.ownCheckAt = now + ctx.cfg.options.ownCheckMs;
  const snaps = listing.files.filter((e) => e.kind === "snap").sort((a, b) => b.stamp.localeCompare(a.stamp) || a.path.localeCompare(b.path));
  for (const e of snaps) await readEntry(ctx, T, e, unreadable);
  const covered = baseCovers(T);
  const chunks = listing.files.filter((e) => e.kind === "chunk").sort(byReadOrder);
  for (const e of chunks) {
    if (e.seq <= (covered[e.device] ?? 0)) continue; // a loaded snapshot includes it
    await readEntry(ctx, T, e, unreadable);
  }
  T.unreadable = unreadable;
  await noteOwnLost(ctx, T, listing);
  prune(T, listing);
  await saveIdx(ctx, T);
}

/** Can the workspace root be listed at all? (A failure marks the folder disconnected, see traced-folder.js.) */
async function probeRoot(ctx) {
  try {
    for await (const entry of ctx.cfg.root.entries()) {
      if (entry) break;
    }
    return true;
  } catch {
    return false;
  }
}

export async function scanAll(ctx) {
  const rootOk = await probeRoot(ctx);
  let failedTables = 0;
  for (const T of ctx.tables.values()) {
    try {
      await ctx.layout.scanTable(T);
    } catch (err) {
      failedTables += 1;
      ctx.recordError("scan", err, { table: T.name });
    }
  }
  await readStatusFiles(ctx);
  checkDigestAgreement(ctx);
  const tables = [...ctx.tables.values()];
  ctx.rt.lastScan = {
    rootOk,
    failedTables,
    unreadable: tables.reduce((n, T) => n + T.unreadable.length, 0) + ctx.rt.statusUnreadable.length,
    listErrors: tables.reduce((n, T) => n + (T.listing?.errors?.length ?? 0), 0),
  };
  ctx.rt.lastScanAt = ctx.cfg.clock.now();
  if (rootOk && !failedTables) ctx.rt.lastScanOkAt = ctx.rt.lastScanAt;
}
