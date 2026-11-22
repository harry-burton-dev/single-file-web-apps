// Backup and restore with no screen (spec S5 part C; TR5 plan decisions 5-8).
//
//   writeBackup    one sealed snapshot per table in backups/<UTC stamp>/<table>.ywb,
//                  in the existing .ywb envelope
//   packBackup     that folder as one store-only zip, the file the admin downloads
//   restoreBackup  into a folder with no data/: an engine starts there with each
//                  table's snapshot already in its local store, then reseeds, so
//                  the folder's only data is a fresh snapshot with fresh coverage
//
// This lives outside the engine, so the engine's rule that a device writes only
// its own paths (property P8) is untouched. No DOM.
import { createEngine } from "../../engine/src/engine/engine.js";
import { seal, open, EnvelopeError } from "../../engine/src/engine/envelope.js";
import { ensureDir, findDir, listFiles, replaceFile, subDir } from "../../engine/src/engine/folder-io.js";
import { formatStamp, parseStamp } from "../../engine/src/engine/layout-chunks.js";
import { keyOf } from "../../engine/src/engine/local-state.js";
import { writeZip, readZip, ZipError } from "./zip.js";

export class BackupError extends Error {
  /** code: "no-backup" | "not-empty" | "bad-file" | "wrong-key" | "unknown-table" | "store-not-empty" | "write-failed" */
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

const ENTRY_RE = /^(\d{8}T\d{6}Z)\/([a-z][a-z0-9_-]*)\.ywb$/;

/**
 * Back up every table the engine opens. tables and adapters are the engine's
 * own config ({ table: adapterName } and { adapterName: adapter }); key and
 * keyId are the workspace's current key. Returns { stamp, files }.
 */
export async function writeBackup({ root, engine, tables, adapters, key, keyId, clock, random }) {
  const backups = await ensureDir(root, ["backups"]);
  let ms = clock.now();
  while (await subDir(backups, formatStamp(ms))) ms += 1000;
  const stamp = formatStamp(ms);
  const dir = await ensureDir(backups, [stamp]);
  const files = [];
  for (const table of Object.keys(tables).sort()) {
    const adapter = adapters[tables[table]];
    const meta = { kind: "backup", table, adapter: tables[table], stamp, writtenAt: clock.now() };
    const bytes = await seal({ key, keyId, iv: random.bytes(12), meta, updates: [adapter.snapshot(engine.table(table))] });
    await replaceFile(dir, `${table}.ywb`, bytes);
    files.push(`backups/${stamp}/${table}.ywb`);
  }
  return { stamp, files };
}

/** The backup folder backups/<stamp>/ as one store-only zip. Entries are named <stamp>/<table>.ywb. */
export async function packBackup({ root, stamp }) {
  const dir = await findDir(root, ["backups", stamp]);
  if (!dir) throw new BackupError("no-backup", `There is no backup ${stamp} in this folder.`);
  const entries = [];
  for (const { name, handle } of (await listFiles(dir)).filter((f) => f.name.endsWith(".ywb")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    entries.push({ name: `${stamp}/${name}`, bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
  }
  return writeZip(entries, { modifiedAt: parseStamp(stamp) });
}

const badFile = () => new BackupError("bad-file", "This file is not a readable backup.");

/** Every table's snapshot in a backup zip, decrypted. Throws BackupError. */
async function readBackup(file, keys) {
  let entries;
  try {
    entries = readZip(file);
  } catch (err) {
    if (err instanceof ZipError) throw badFile();
    throw err;
  }
  const parsed = entries.map((e) => ({ match: ENTRY_RE.exec(e.name), bytes: e.bytes }));
  const stamps = new Set(parsed.map((p) => p.match?.[1]));
  if (!parsed.length || stamps.has(undefined) || stamps.size !== 1) throw badFile();
  const out = [];
  for (const { match, bytes } of parsed) {
    let body;
    try {
      body = await open({ keys, bytes });
    } catch (err) {
      if (!(err instanceof EnvelopeError)) throw err;
      if (err.message === "decryption failed" || err.message.startsWith("no key for key id")) {
        throw new BackupError("wrong-key", "This backup cannot be opened with this workspace's keys.");
      }
      throw badFile();
    }
    if (body.meta?.kind !== "backup" || body.meta.table !== match[2] || body.updates.length !== 1) throw badFile();
    out.push({ table: match[2], snapshot: body.updates[0] });
  }
  return out;
}

/**
 * Restore a backup zip (file) into root, which must have no data/. engineConfig
 * is everything createEngine takes apart from root: the keys from
 * engineKeys(keyring), and a store, deviceId, tables and adapters for the
 * restoring device. Its store must hold nothing for the backed-up tables.
 * Nothing is written until the whole backup has been read. Returns { tables }.
 */
export async function restoreBackup({ root, file, engineConfig }) {
  if (await subDir(root, "data")) {
    throw new BackupError("not-empty", "This folder already has a data/ folder. Restore only into an empty folder.");
  }
  const extra = engineConfig.keys instanceof Map ? [...engineConfig.keys] : Object.entries(engineConfig.keys ?? {}).map(([id, k]) => [Number(id), k]);
  const keys = new Map([...extra, [engineConfig.keyId ?? 0, engineConfig.key]]);
  const snapshots = await readBackup(file, keys);
  const { store, tables } = engineConfig;
  for (const { table } of snapshots) {
    if (!tables[table]) throw new BackupError("unknown-table", `This backup holds a table "${table}" that this app does not open.`);
    if ((await store.keys(`t/${table}/`)).length) {
      throw new BackupError("store-not-empty", `This device already holds data for "${table}". Restore from a device with no local data.`);
    }
  }
  // The engine restores each doc from its local store at startup, and as a
  // received (not local) update, so nothing is queued as pending.
  for (const { table, snapshot } of snapshots) await store.set(keyOf.snap(table, 1), snapshot);
  const engine = await createEngine({ ...engineConfig, root });
  try {
    const written = (await engine.reseed()) ?? [];
    if (written.length !== Object.keys(tables).length) {
      throw new BackupError("write-failed", "The restored data could not be written to the folder. Check the folder and try again.");
    }
  } finally {
    await engine.close();
  }
  return { tables: snapshots.map((s) => s.table) };
}
