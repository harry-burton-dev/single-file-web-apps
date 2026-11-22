// A stand-in for the shared folder in browser tests: a temporary directory in
// Node, reached from each page through a Playwright binding. In every attached
// context, window.showDirectoryPicker() returns a directory handle whose calls
// are answered from that directory, so several contexts (several devices)
// share one folder. File bytes cross the binding as base64.
//
// Calls the engine and loader use, and the stand-in answers:
//   directory  getDirectoryHandle, getFileHandle (both with { create }),
//              entries / for await, removeEntry, queryPermission, requestPermission
//   file       getFile (size, lastModified, arrayBuffer, text), createWritable
//              (write, close, abort)
// Errors carry the DOMException names a real folder gives: NotFoundError,
// TypeMismatchError, NotReadableError (a File read after the file changed).
// Each write moves the file's modification time strictly forward, so the
// engine's size:lastModified fingerprints always see a change.
//
// partition(true) splits the folder: each context then sees the folder as it
// was plus its own writes and deletes, and nothing the others do. partition(false)
// heals it: every context's changes are applied to the shared directory. This
// makes two edits concurrent without relying on timing.
//
// The root handle cannot be kept in IndexedDB as a real handle can, so the
// page's attempt to remember it stores nothing instead (as the smoke test
// does). Do not reload a page mid-test.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BINDING = "__standInFolder";
const fail = (name, message) => ({ error: { name, message } });

export async function createStandInFolder() {
  const base = mkdtempSync(join(tmpdir(), "stand-in-"));
  const dir = join(base, "shared");
  mkdirSync(dir);
  let partitioned = false;
  const sides = new Map(); // label -> { root, deleted: Set<path> } while partitioned
  let lastStamp = 0;

  const side = (label) => {
    if (!sides.has(label)) sides.set(label, { root: join(base, "side", label), deleted: new Set() });
    return sides.get(label);
  };

  /** Where `path` lives for `label`: its own partition copy first, then the shared directory. Null when absent. */
  function locate(label, path) {
    if (!partitioned) return existsSync(join(dir, path)) ? join(dir, path) : null;
    const s = side(label);
    if ([...s.deleted].some((gone) => path === gone || path.startsWith(`${gone}/`))) return null;
    if (existsSync(join(s.root, path))) return join(s.root, path);
    return existsSync(join(dir, path)) ? join(dir, path) : null;
  }

  /** The real path writes to `path` go to for `label`. */
  function target(label, path) {
    if (!partitioned) return join(dir, path);
    const s = side(label);
    for (const gone of [...s.deleted]) if (gone === path || gone.startsWith(`${path}/`) || path.startsWith(`${gone}/`)) s.deleted.delete(gone);
    return join(s.root, path);
  }

  const kindOf = (real) => (statSync(real).isDirectory() ? "directory" : "file");

  function stampWrite(real) {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    utimesSync(real, new Date(lastStamp), new Date(lastStamp));
  }

  const ops = {
    handle(label, { path, name, kind, create }) {
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return fail("TypeError", `Name is not allowed: ${name}`);
      if (!locate(label, path) || kindOf(locate(label, path)) !== "directory") return fail("NotFoundError", `${path || "folder"} is missing`);
      const child = path ? `${path}/${name}` : name;
      const found = locate(label, child);
      if (found) return kindOf(found) === kind ? { path: child } : fail("TypeMismatchError", `${child} is not a ${kind}`);
      if (!create) return fail("NotFoundError", `${child} is missing`);
      const real = target(label, child);
      if (kind === "directory") mkdirSync(real, { recursive: true });
      else {
        mkdirSync(dirname(real), { recursive: true });
        writeFileSync(real, "");
        stampWrite(real);
      }
      return { path: child };
    },

    list(label, { path }) {
      const names = new Set();
      const add = (real) => existsSync(real) && readdirSync(real).forEach((n) => names.add(n));
      add(join(dir, path));
      if (partitioned) add(join(side(label).root, path));
      const out = [];
      for (const n of [...names].sort()) {
        const child = path ? `${path}/${n}` : n;
        const real = locate(label, child);
        if (real) out.push([n, kindOf(real)]);
      }
      return { entries: out };
    },

    stat(label, { path }) {
      const real = locate(label, path);
      if (!real) return fail("NotFoundError", `${path} is missing`);
      const s = statSync(real);
      return { size: s.size, lastModified: Math.floor(s.mtimeMs) };
    },

    read(label, { path, lastModified }) {
      const real = locate(label, path);
      if (!real) return fail("NotFoundError", `${path} is missing`);
      if (Math.floor(statSync(real).mtimeMs) !== lastModified) return fail("NotReadableError", `${path} changed after it was opened`);
      return { base64: readFileSync(real).toString("base64") };
    },

    write(label, { path, base64 }) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (!locate(label, parent)) return fail("NotFoundError", `${parent} is missing`);
      const real = target(label, path);
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, Buffer.from(base64, "base64"));
      stampWrite(real);
      return {};
    },

    remove(label, { path, name, recursive }) {
      const child = path ? `${path}/${name}` : name;
      const real = locate(label, child);
      if (!real) return fail("NotFoundError", `${child} is missing`);
      if (kindOf(real) === "directory" && !recursive && ops.list(label, { path: child }).entries.length > 0) return fail("InvalidModificationError", `${child} is not empty`);
      if (!partitioned) rmSync(real, { recursive: true, force: true });
      else {
        rmSync(join(side(label).root, child), { recursive: true, force: true });
        side(label).deleted.add(child);
      }
      return {};
    },
  };

  /** Move every file under `from` to the same place under `to`, keeping modification times. */
  function mergeInto(from, to) {
    if (!existsSync(from)) return;
    for (const n of readdirSync(from)) {
      const src = join(from, n);
      const dest = join(to, n);
      if (statSync(src).isDirectory()) {
        if (existsSync(dest) && !statSync(dest).isDirectory()) rmSync(dest, { force: true });
        mkdirSync(dest, { recursive: true });
        mergeInto(src, dest);
      } else {
        rmSync(dest, { recursive: true, force: true });
        renameSync(src, dest);
      }
    }
  }

  return {
    /** The shared directory. Put files here (for example the release's app/ folder) before attaching. */
    dir,

    /** Give a Playwright BrowserContext the stand-in picker. `label` names the context (one device). */
    async attach(context, label) {
      await context.exposeBinding(BINDING, (_source, op, args) => ops[op](label, args));
      await context.addInitScript(pagePicker, { binding: BINDING, name: "shared-folder" });
    },

    /** Split (true) or heal (false) the folder between contexts. */
    async partition(on) {
      if (on === partitioned) return;
      if (!on) {
        for (const s of sides.values()) {
          for (const gone of s.deleted) rmSync(join(dir, gone), { recursive: true, force: true });
          mergeInto(s.root, dir);
        }
        sides.clear();
        rmSync(join(base, "side"), { recursive: true, force: true });
      }
      partitioned = on;
    },

    async close() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Runs in the page before its own scripts. Self-contained: Playwright sends it as source. */
function pagePicker({ binding, name: rootName }) {
  const call = async (op, args) => {
    const result = await window[binding](op, args);
    if (result?.error) {
      if (result.error.name === "TypeError") throw new TypeError(result.error.message);
      throw new DOMException(result.error.message, result.error.name);
    }
    return result;
  };
  const toBase64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const toBytes = async (data) => {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError("The stand-in folder writes strings, Blobs and binary data only");
  };
  const granted = async () => "granted";
  const leaf = (path) => path.slice(path.lastIndexOf("/") + 1);

  function fileHandle(path) {
    return {
      kind: "file",
      name: leaf(path),
      queryPermission: granted,
      requestPermission: granted,
      async getFile() {
        const { size, lastModified } = await call("stat", { path });
        const bytes = async () => fromBase64((await call("read", { path, lastModified })).base64);
        return {
          name: leaf(path),
          type: "",
          size,
          lastModified,
          arrayBuffer: async () => (await bytes()).buffer,
          text: async () => new TextDecoder().decode(await bytes()),
        };
      },
      async createWritable() {
        await call("stat", { path });
        let parts = [];
        let open = true;
        return {
          async write(data) {
            if (!open) throw new TypeError("The writable is closed");
            parts.push(await toBytes(data));
          },
          async close() {
            if (!open) throw new TypeError("The writable is closed");
            open = false;
            const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const p of parts) {
              all.set(p, at);
              at += p.length;
            }
            await call("write", { path, base64: toBase64(all) });
          },
          async abort() {
            open = false;
            parts = [];
          },
        };
      },
    };
  }

  function dirHandle(path, extra = {}) {
    async function* entries() {
      for (const [n, kind] of (await call("list", { path })).entries) {
        const child = path ? `${path}/${n}` : n;
        yield [n, kind === "directory" ? dirHandle(child) : fileHandle(child)];
      }
    }
    return {
      kind: "directory",
      name: path ? leaf(path) : rootName,
      ...extra,
      queryPermission: granted,
      requestPermission: granted,
      async getDirectoryHandle(n, options) {
        return dirHandle((await call("handle", { path, name: n, kind: "directory", create: options?.create === true })).path);
      },
      async getFileHandle(n, options) {
        return fileHandle((await call("handle", { path, name: n, kind: "file", create: options?.create === true })).path);
      },
      async removeEntry(n, options) {
        await call("remove", { path, name: n, recursive: options?.recursive === true });
      },
      entries,
      [Symbol.asyncIterator]: entries,
    };
  }

  const root = dirHandle("", { standIn: true });
  window.showDirectoryPicker = async () => root;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    return put.call(this, value?.standIn ? undefined : value, key);
  };
}
