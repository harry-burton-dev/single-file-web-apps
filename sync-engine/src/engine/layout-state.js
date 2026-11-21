// Folder I/O for the "state-per-device" layout (Tonsky's design 2):
//   data/<table>/<deviceId>/state.ywb   the device's whole document, rewritten
// Conflict copies (state-<SOMETHING>.ywb) are read as data. A device only
// ever writes its own state.ywb (property P8).
import { STATE_RE, NAME_RE } from "./constants.js";
import { createCommonIo, ensureDir, listFiles, replaceFile, statFile, subDir } from "./folder-io.js";

export const STATE_NAME = "state.ywb";

export function createStateIo({ root, deviceId }) {
  const path = (table, device, name) => `data/${table}/${device}/${name}`;
  const mine = (table) => ["data", table, deviceId];

  return {
    id: "state-per-device",
    kind: "state",
    ...createCommonIo({ root, deviceId }),

    /** Every state file of a table, all devices. Never throws. */
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
            for (const f of await listFiles(handle)) {
              if (STATE_RE.test(f.name)) files.push({ device, name: f.name, path: path(table, device, f.name), handle: f.handle });
            }
          } catch (error) {
            errors.push({ path: `data/${table}/${device}`, error });
          }
        }
      } catch (error) {
        errors.push({ path: `data/${table}`, error });
      }
      return { files, errors };
    },

    /** Nothing to read before a write: only this device writes this file. */
    async current() {
      return null;
    },

    async write(table, bytes) {
      await replaceFile(await ensureDir(root, mine(table)), STATE_NAME, bytes);
      return { name: STATE_NAME, path: path(table, deviceId, STATE_NAME) };
    },

    async stat(table) {
      return statFile(await ensureDir(root, mine(table)), STATE_NAME);
    },
  };
}
