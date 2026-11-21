// Folder I/O for the "chunks" layout (ADR-0001 section 3). Everything that
// knows a path or a file name lives here, so another layout can replace it.
// Writes and deletes are confined to the device's own paths (property P8).
import { CHUNK_RE, SNAP_RE, NAME_RE } from "./constants.js";
import { createCommonIo, ensureDir, findDir, fileExists, listFiles, notFound, replaceFile, statFile, subDir } from "./folder-io.js";

export const chunkName = (seq) => `${String(seq).padStart(6, "0")}.ywb`;
export const snapName = (stamp) => `snap-${stamp}.ywb`;

/** UTC yyyymmddThhmmssZ from epoch milliseconds. */
export function formatStamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

export function parseStamp(stamp) {
  const n = (a, b) => Number(stamp.slice(a, b));
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(9, 11), n(11, 13), n(13, 15));
}

/** Classify a file name inside a device folder; null means "not ours, ignore". */
export function parseDataName(name) {
  const c = CHUNK_RE.exec(name);
  if (c) return { kind: "chunk", seq: Number(c[1]), suffix: c[2] ?? "" };
  const s = SNAP_RE.exec(name);
  if (s) return { kind: "snap", stamp: s[1], stampMs: parseStamp(s[1]), suffix: s[2] ?? "" };
  return null;
}

export function createChunksLayout({ root, deviceId }) {
  const dataPath = (table, device, name) => `data/${table}/${device}/${name}`;
  const mine = (table) => ["data", table, deviceId];

  async function listDevice(tableDir, table, device, handle, out) {
    for (const { name, handle: fh } of await listFiles(handle)) {
      const parsed = parseDataName(name);
      if (parsed) out.push({ ...parsed, device, name, path: dataPath(table, device, name), handle: fh });
    }
  }

  return {
    id: "chunks",
    ...createCommonIo({ root, deviceId }),
    dataPath,

    /** Every chunk and snapshot entry of a table, all devices. Never throws. */
    async listTable(table) {
      const files = [];
      const errors = [];
      try {
        const data = await subDir(root, "data");
        const tableDir = data && (await subDir(data, table));
        if (!tableDir) return { files, errors };
        for await (const [device, handle] of tableDir.entries()) {
          if (handle.kind !== "directory" || !NAME_RE.test(device)) continue;
          try {
            await listDevice(tableDir, table, device, handle, files);
          } catch (error) {
            errors.push({ path: `data/${table}/${device}`, error });
          }
        }
      } catch (error) {
        errors.push({ path: `data/${table}`, error });
      }
      return { files, errors };
    },

    async writeData(table, name, bytes) {
      if (!parseDataName(name)) throw new Error(`refusing to write ${name}`);
      await replaceFile(await ensureDir(root, mine(table)), name, bytes);
      return dataPath(table, deviceId, name);
    },

    async statData(table, name) {
      return statFile(await ensureDir(root, mine(table)), name);
    },

    /** Does our own file exist? A direct lookup, independent of listings. */
    async exists(table, name) {
      const dir = await findDir(root, mine(table));
      return dir ? fileExists(dir, name) : false;
    },

    async removeData(table, name) {
      if (!parseDataName(name)) throw new Error(`refusing to delete ${name}`);
      const data = await subDir(root, "data");
      const tableDir = data && (await subDir(data, table));
      const dir = tableDir && (await subDir(tableDir, deviceId));
      if (!dir) return;
      try {
        await dir.removeEntry(name);
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    },
  };
}
