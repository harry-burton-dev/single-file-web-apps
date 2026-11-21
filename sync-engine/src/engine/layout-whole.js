// Sync behaviour shared by the two whole-file layouts (state-per-device and
// shared-file): every save writes the table's whole document, every reader
// applies a file whenever its (size, lastModified) fingerprint changes.
// No chunks, no sealing, no compaction, no deletes. The folder side (paths
// and names) is supplied by `io`; see layout-state.js and layout-shared.js.
import { seal, open as openEnvelope } from "./envelope.js";
import { logUpdates, markApplied, saveIdx, dropPending, forgetFiles } from "./local-state.js";
import { makeMeta } from "./saver.js";

const describe = (error) => ({ name: error?.name ?? "Error", message: String(error?.message ?? error) });

export function createWholeFileLayout(ctx, io, { readBeforeWrite, trustOwnWrite }) {
  const { cfg } = ctx;
  const { kind } = io;

  /** Apply one file if its fingerprint changed. Throws when unreadable. */
  async function readEntry(T, e) {
    const known = T.idx.files[e.path];
    const file = await io.open(e);
    if (known?.fp === file.fingerprint) {
      ctx.tracer.step({ table: T.name, path: e.path, action: "skip", result: "unchanged" });
      return;
    }
    const bytes = await file.bytes();
    let parsed;
    try {
      parsed = await openEnvelope({ keys: ctx.keys, bytes });
    } catch (err) {
      ctx.tracer.apply({ table: T.name, path: e.path, bytes: bytes.length, error: describe(err) });
      throw err;
    }
    const { meta, updates } = parsed;
    const record = { kind, device: e.device ?? meta?.device ?? null, fp: file.fingerprint, size: file.size };
    if (meta?.table !== T.name || meta?.adapter !== T.adapterName) {
      markApplied(T, e.path, { ...record, ignored: true }); // another table or adapter
      ctx.tracer.apply({ table: T.name, path: e.path, bytes: bytes.length, result: "ignored (other table or adapter)" });
      return;
    }
    if (meta.kind !== kind) {
      const err = new Error(`file kind ${meta.kind} does not match layout ${io.id}`);
      ctx.tracer.apply({ table: T.name, path: e.path, bytes: bytes.length, error: describe(err) });
      throw err;
    }
    for (const update of updates) T.adapter.applyUpdate(T.doc, update, { device: meta.device });
    if (updates.length) {
      try {
        await logUpdates(ctx, T, updates);
      } catch (err) {
        ctx.recordError("store", err, { table: T.name, path: e.path });
        return; // not marked applied: read again next scan
      }
    }
    markApplied(T, e.path, record);
    ctx.tracer.apply({ table: T.name, path: e.path, count: updates.length, bytes: bytes.length });
    if (meta.device !== cfg.deviceId) ctx.emit("received", { table: T.name, device: meta.device ?? e.device, writtenAt: meta.writtenAt });
  }

  /** The plain read-merge step of a shared-file save; an unreadable file is simply overwritten. */
  async function mergeCurrent(T) {
    const current = await io.current(T.name);
    if (!current) return;
    try {
      await readEntry(T, current);
    } catch {
      // not readable now: the write below replaces it, as the plain pattern does
    }
  }

  async function writeTable(T, entries) {
    if (readBeforeWrite) await mergeCurrent(T);
    const meta = makeMeta(ctx, T, kind);
    const bytes = await seal({ key: cfg.key, keyId: cfg.keyId, iv: cfg.random.bytes(12), meta, updates: [T.adapter.snapshot(T.doc)] });
    const written = await io.write(T.name, bytes);
    if (trustOwnWrite) {
      let fp = `${bytes.length}:?`;
      try {
        fp = (await io.stat(T.name)).fingerprint;
      } catch {
        // the next scan re-reads our own file once; harmless
      }
      markApplied(T, written.path, { kind, device: cfg.deviceId, fp, size: bytes.length });
    }
    await dropPending(ctx, T, entries);
    ctx.emit("saved", { table: T.name, seq: null, bytes: bytes.length, at: cfg.clock.now() });
    return written;
  }

  async function save(T) {
    const entries = T.pending.filter((e) => e.persisted);
    if (!entries.length) return true;
    try {
      await writeTable(T, entries);
      return true;
    } catch (err) {
      ctx.recordError("save", err, { table: T.name });
      return false;
    }
  }

  async function scanTable(T) {
    const listing = await io.listTable(T.name);
    for (const e of listing.errors) ctx.recordError("list", e.error, { path: e.path });
    T.listing = listing;
    for (const e of listing.files) if (e.name !== "state.ywb" && e.name !== "table.ywb") ctx.metrics.copySeen(e.path);
    const unreadable = [];
    for (const e of [...listing.files].sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        await readEntry(T, e);
      } catch (err) {
        unreadable.push({ path: e.path, error: describe(err) });
      }
    }
    T.unreadable = unreadable;
    if (!listing.errors.length) {
      const present = new Set(listing.files.map((e) => e.path));
      const gone = Object.keys(T.idx.files).filter((p) => !present.has(p));
      if (gone.length) forgetFiles(T, gone);
    }
    await saveIdx(ctx, T);
  }

  async function reseed() {
    const written = [];
    for (const T of ctx.tables.values()) {
      try {
        const file = await writeTable(T, T.pending.filter((e) => e.persisted));
        written.push(file.path);
      } catch (err) {
        ctx.recordError("snapshot", err, { table: T.name });
      }
    }
    return written;
  }

  return {
    ...io,
    async init(T) {
      T.open = null; // no open chunk in this layout
    },
    save,
    scanTable,
    async maintenance() {},
    reseed,
    tableStatus: () => ({ applied: {}, snapshots: [] }),
  };
}
