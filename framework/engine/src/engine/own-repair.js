// Putting our own files back (ADR-0001, changes after adversarial testing).
//
// The folder is not ours alone: a colleague can delete files in Explorer, the
// folder can be wiped and re-created, OneDrive can restore an older version
// of a file. The device that wrote a file is the only one sure to hold its
// content, so it notices when its own file is gone or holds another version
// and publishes the content again:
//
//   "open"  the damaged file is the chunk this session is still writing and
//           its content is in memory: write it again.
//   "full"  anything else: publish one snapshot of the whole table.
//
// What is owed is kept in the applied-file index (idx.repair), so it survives
// a restart; an owed "open" becomes "full" then, because the memory is gone.
import { chunkName } from "./layout-chunks.js";
import { forgetFiles, markApplied, saveIdx } from "./local-state.js";
import { rewriteOpenChunk } from "./saver.js";
import { writeSnapshot } from "./compaction.js";

const dominates = (newer, older) => Object.entries(older).every(([device, seq]) => (newer[device] ?? 0) >= seq);

function owe(T, kind) {
  if (T.idx.repair === "full" || T.idx.repair === kind) return;
  T.idx = { ...T.idx, repair: kind };
  T.idxDirty = true;
}

const isOpenChunk = (T, seq) => Boolean(T.ready) && seq === T.open.seq && T.open.updates.length > 0;

/** The scanner read our own chunk and found a version we did not record. */
export function noteOwnChanged(T, seq) {
  owe(T, isOpenChunk(T, seq) ? "open" : "full");
}

/**
 * Own files we recorded that a clean listing no longer shows, and that no
 * snapshot still in the folder stands in for. A direct lookup confirms each
 * one, because a listing can come back short without failing.
 */
export async function noteOwnLost(ctx, T, listing) {
  if (listing.errors.length) return;
  const self = ctx.cfg.deviceId;
  const present = new Set(listing.files.map((e) => e.path));
  const snaps = Object.entries(T.idx.files).filter(([path, f]) => f.kind === "snap" && present.has(path)).map(([, f]) => f);
  const covered = Math.max(0, ...snaps.map((s) => s.covers?.[self] ?? 0));
  for (const [path, f] of Object.entries(T.idx.files)) {
    if (f.device !== self || present.has(path) || f.republished) continue;
    if (f.kind === "chunk") {
      if (f.suffix !== "" || f.seq <= covered) continue;
      if (await ctx.layout.exists(T.name, chunkName(f.seq))) continue;
      if (isOpenChunk(T, f.seq)) {
        owe(T, "open");
      } else {
        // its content is in our document, so the snapshot we owe may claim it
        markApplied(T, path, { ...f, sealed: true, republished: true });
        owe(T, "full");
      }
    } else {
      if (snaps.some((n) => n.stampMs > f.stampMs && dominates(n.covers, f.covers))) continue;
      if (await ctx.layout.exists(T.name, f.name)) continue;
      forgetFiles(T, [path]);
      owe(T, "full");
    }
  }
}

/** Publish what is owed. At most once per ownCheckMs, so two writers of one file cannot chase each other. Never throws. */
export async function repairOwn(ctx, T) {
  const kind = T.idx.repair;
  const now = ctx.cfg.clock.now();
  if (!kind || !T.ready || (T.repairAt != null && now < T.repairAt)) return;
  try {
    if (kind === "full") await writeSnapshot(ctx, T);
    else if (T.open.updates.length) await rewriteOpenChunk(ctx, T);
    const { repair, ...idx } = T.idx;
    T.idx = idx;
    T.idxDirty = true;
    T.repairAt = now + ctx.cfg.options.ownCheckMs;
    await saveIdx(ctx, T);
  } catch (err) {
    ctx.recordError("repair", err, { table: T.name });
    T.repairAt = now + ctx.cfg.options.retryInitialMs;
  }
}
