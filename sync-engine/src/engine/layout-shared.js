// Folder I/O for the "shared-file" layout (Tonsky's design 1):
//   data/<table>/table.ywb   one file per table, written by every device
// Conflict copies (table-<SOMETHING>.ywb) are read as data. This layout
// deliberately breaks the single-writer rule (P8); that is what it measures.
import { TABLE_FILE_RE } from "./constants.js";
import { createCommonIo, ensureDir, listFiles, notFound, replaceFile, statFile, subDir } from "./folder-io.js";

export const TABLE_NAME = "table.ywb";

export function createSharedIo({ root, deviceId }) {
  const path = (table, name) => `data/${table}/${name}`;

  async function tableDir(table) {
    const data = await subDir(root, "data");
    return data && subDir(data, table);
  }

  return {
    id: "shared-file",
    kind: "table",
    ...createCommonIo({ root, deviceId }),

    /** Every table file (and conflict copy) of a table. Never throws. */
    async listTable(table) {
      const files = [];
      const errors = [];
      try {
        const dir = await tableDir(table);
        if (!dir) return { files, errors };
        for (const f of await listFiles(dir)) {
          if (TABLE_FILE_RE.test(f.name)) files.push({ device: null, name: f.name, path: path(table, f.name), handle: f.handle });
        }
      } catch (error) {
        errors.push({ path: `data/${table}`, error });
      }
      return { files, errors };
    },

    /** The shared file as it is now, or null when it does not exist. */
    async current(table) {
      const dir = await tableDir(table);
      if (!dir) return null;
      try {
        return { device: null, name: TABLE_NAME, path: path(table, TABLE_NAME), handle: await dir.getFileHandle(TABLE_NAME) };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async write(table, bytes) {
      await replaceFile(await ensureDir(root, ["data", table]), TABLE_NAME, bytes);
      return { name: TABLE_NAME, path: path(table, TABLE_NAME) };
    },

    async stat(table) {
      return statFile(await ensureDir(root, ["data", table]), TABLE_NAME);
    },
  };
}
