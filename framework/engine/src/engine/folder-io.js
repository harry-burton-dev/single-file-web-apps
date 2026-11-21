// Folder helpers shared by every layout: directory walking, whole-file
// replacement, entry opening and the status-file paths (status/<device>.ywb).

export const notFound = (err) => err?.name === "NotFoundError";

export async function subDir(dir, name) {
  try {
    return await dir.getDirectoryHandle(name, { create: false });
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

export async function ensureDir(root, parts) {
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

/** Existing directory for a path, or null when any part is missing. */
export async function findDir(root, parts) {
  let dir = root;
  for (const part of parts) {
    dir = dir && (await subDir(dir, part));
    if (!dir) return null;
  }
  return dir;
}

export async function replaceFile(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort?.();
    } catch {
      // the original error matters more
    }
    throw err;
  }
}

export async function listFiles(dir) {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") out.push({ name, handle });
  }
  return out;
}

/** True when a file exists, by direct lookup (no directory listing). */
export async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch (err) {
    if (notFound(err)) return false;
    throw err;
  }
}

/** Cheap metadata first; bytes only when the caller asks. */
export async function openEntry(entry) {
  const file = await entry.handle.getFile();
  return {
    size: file.size,
    lastModified: file.lastModified,
    fingerprint: `${file.size}:${file.lastModified}`,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

export async function statFile(dir, name) {
  const file = await (await dir.getFileHandle(name)).getFile();
  return { size: file.size, fingerprint: `${file.size}:${file.lastModified}` };
}

/** Methods every layout offers: open(), listStatus(), writeStatus(). */
export function createCommonIo({ root, deviceId }) {
  return {
    open: openEntry,

    async listStatus() {
      const statusDir = await subDir(root, "status");
      if (!statusDir) return [];
      return (await listFiles(statusDir))
        .filter(({ name }) => name.endsWith(".ywb"))
        .map(({ name, handle }) => ({ device: name.slice(0, -4), name, path: `status/${name}`, handle }));
    },

    async writeStatus(bytes) {
      await replaceFile(await ensureDir(root, ["status"]), `${deviceId}.ywb`, bytes);
    },
  };
}
