// The layout interface. The engine core talks to one of these and never
// branches on a layout name. Every layout offers the folder I/O the shared
// code needs (open, listStatus, writeStatus) plus:
//
//   id                    "chunks"
//   init(T)               after the first scan: prepare table T for writing
//   save(T)               write T's pending updates to the folder; true on success
//   scanTable(T)          read every file of T that changed; never throws on bad files
//   maintenance()         compaction
//   reseed()              write the whole of every table into our own paths
//   tableStatus(T)        { applied, snapshots } parts of the status file
import { createChunksLayout } from "./layout-chunks.js";
import { initOpenChunk, saveTable } from "./saver.js";
import { scanTable } from "./scanner.js";
import { compactionStep, reseed, republishShadowed } from "./compaction.js";
import { appliedSummary, loadedSnapshotNames } from "./coverage.js";
import { repairOwn } from "./own-repair.js";

function chunksLayout(ctx) {
  const io = createChunksLayout({ root: ctx.cfg.root, deviceId: ctx.cfg.deviceId });
  return {
    ...io,
    init: async (T) => {
      await initOpenChunk(ctx, T);
      T.ready = true;
    },
    save: (T) => saveTable(ctx, T),
    scanTable: async (T) => {
      await scanTable(ctx, T);
      await republishShadowed(ctx, T);
      await repairOwn(ctx, T);
    },
    maintenance: () => compactionStep(ctx),
    reseed: () => reseed(ctx),
    tableStatus: (T) => ({ applied: appliedSummary(T, ctx.cfg.deviceId), snapshots: loadedSnapshotNames(T) }),
  };
}

const FACTORIES = {
  chunks: chunksLayout,
};

/** Build the layout named by options.layout (already validated). */
export function createLayout(ctx) {
  return FACTORIES[ctx.cfg.options.layout](ctx);
}
