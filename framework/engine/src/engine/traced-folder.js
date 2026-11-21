// The one place where the engine's folder I/O is observed. The workspace
// root handed to createEngine is wrapped here, so every directory listing,
// metadata lookup, read, write and delete the engine performs lands as one
// step of the attempt in progress (tracing.js), with the same path and byte
// count the folder itself would report. Nothing else in the engine records
// folder operations.
//
// What becomes a step
//   list    entries() of a directory (bytes 0, result "<n> entries")
//   stat    getFile() (metadata), and a lookup that found nothing (result "missing")
//   read    arrayBuffer() (bytes = bytes read)
//   write   close() of a writable (bytes = bytes written), and the empty file
//           that getFileHandle(name, { create: true }) makes (result "created")
//   delete  removeEntry() (bytes = size of the file, known from an earlier
//           read or write of it or from tracer.hintSize)
// Lookups that succeed (getDirectoryHandle, getFileHandle) are not steps.
//
// The wrapper never changes what is asked of the folder, with one addition
// made at every trace level: before getFileHandle(name, { create: true }) it
// looks the name up without creating, to know whether the call creates a file.
//
// It also keeps the folder-access state used by health(): an access error
// (NotAllowedError, SecurityError) on any operation, any failure to list the
// root, or a NotFoundError when creating directly under the root marks the
// folder as disconnected. The mark records what kind of operation failed and
// is cleared by the next success of the same kind: a write failure by a
// write, a failure to list by a root listing, anything else by either.

const ACCESS_ERRORS = new Set(["NotAllowedError", "SecurityError"]);
const SIZE_CACHE_LIMIT = 2000;

const join = (dir, name) => (dir === "" ? name : `${dir}/${name}`);
const errorInfo = (err) => ({ name: err?.name ?? "Error", message: String(err?.message ?? err) });
const lengthOf = (data) => data?.byteLength ?? data?.length ?? 0;

export function traceFolder(root, { tracer, folder, clock }) {
  const sizes = new Map(); // path -> last known size, for delete steps
  const remember = (path, size) => {
    sizes.delete(path);
    sizes.set(path, size);
    if (sizes.size > SIZE_CACHE_LIMIT) sizes.delete(sizes.keys().next().value);
  };

  /** Update folder-access state from one outcome. kind: "write" | "list" | "other". */
  function settle(err, { kind = "other", rootList = false, rootCreate = false, clears = null }) {
    if (!err) {
      const fault = folder.fault;
      if (clears && fault && (fault.kind === clears || fault.kind === "other")) folder.fault = null;
      return;
    }
    const name = err?.name ?? "Error";
    if (!folder.fault && (ACCESS_ERRORS.has(name) || rootList || (rootCreate && name === "NotFoundError"))) {
      folder.fault = { name, since: clock.now(), kind };
    }
  }

  /** Run one operation, record its step, rethrow its failure. */
  async function observe({ path, action, missingOk = false, quiet = false, bytesOf, flags = {} }, fn) {
    const t0 = tracer.now();
    let value;
    try {
      value = await fn();
    } catch (err) {
      const missing = missingOk && err?.name === "NotFoundError";
      settle(missing ? null : err, flags);
      tracer.step({ path, action, durationMs: tracer.now() - t0, result: missing ? "missing" : "failed", error: missing ? null : errorInfo(err) });
      throw err;
    }
    settle(null, flags);
    if (!quiet) tracer.step({ path, action, bytes: bytesOf ? bytesOf(value) : 0, durationMs: tracer.now() - t0 });
    return value;
  }

  function wrapFile(handle, path) {
    return {
      kind: "file",
      name: handle.name,
      async getFile() {
        const file = await observe({ path, action: "stat" }, () => handle.getFile());
        remember(path, file.size);
        return {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          arrayBuffer: () => observe({ path, action: "read", bytesOf: (buf) => buf.byteLength }, () => file.arrayBuffer()),
        };
      },
      async createWritable() {
        const t0 = tracer.now();
        let writable;
        try {
          writable = await handle.createWritable();
        } catch (err) {
          settle(err, { kind: "write" });
          tracer.step({ path, action: "write", durationMs: tracer.now() - t0, result: "failed", error: errorInfo(err) });
          throw err;
        }
        let bytes = 0;
        const wrapped = {
          async write(data) {
            bytes += lengthOf(data);
            return writable.write(data);
          },
          async close() {
            try {
              await writable.close();
            } catch (err) {
              settle(err, { kind: "write" });
              tracer.step({ path, action: "write", bytes, durationMs: tracer.now() - t0, result: "failed", error: errorInfo(err) });
              throw err;
            }
            settle(null, { clears: "write" });
            remember(path, bytes);
            tracer.step({ path, action: "write", bytes, durationMs: tracer.now() - t0 });
          },
        };
        if (writable.abort) wrapped.abort = () => writable.abort();
        return wrapped;
      },
    };
  }

  /** Would getFileHandle(name, { create: true }) create the file? */
  async function wouldCreate(handle, name) {
    try {
      await handle.getFileHandle(name, { create: false });
      return false;
    } catch (err) {
      return err?.name === "NotFoundError";
    }
  }

  function wrapHandle(handle, path) {
    return handle.kind === "directory" ? wrapDir(handle, path) : wrapFile(handle, path);
  }

  function wrapDir(handle, dir) {
    const isRoot = dir === "";
    async function* entries() {
      const t0 = tracer.now();
      let count = 0;
      let failure = null;
      try {
        for await (const [name, child] of handle.entries()) {
          count += 1;
          yield [name, wrapHandle(child, join(dir, name))];
        }
      } catch (err) {
        failure = err;
        throw err;
      } finally {
        settle(failure, { kind: "list", rootList: isRoot, clears: isRoot ? "list" : null });
        tracer.step({ path: dir, action: "list", durationMs: tracer.now() - t0, result: failure ? "failed" : `${count} entries`, error: failure ? errorInfo(failure) : null, count });
      }
    }
    return {
      kind: "directory",
      name: handle.name,
      async getDirectoryHandle(name, options) {
        const path = join(dir, name);
        const create = options?.create === true;
        const child = await observe({ path, action: "stat", missingOk: !create, quiet: true, flags: { rootCreate: create && isRoot } }, () => handle.getDirectoryHandle(name, options));
        return wrapDir(child, path);
      },
      async getFileHandle(name, options) {
        const path = join(dir, name);
        const create = options?.create === true;
        const created = create && (await wouldCreate(handle, name));
        const child = await observe({ path, action: create ? "write" : "stat", missingOk: !create, quiet: true, flags: { rootCreate: create && isRoot } }, () => handle.getFileHandle(name, options));
        if (created) tracer.step({ path, action: "write", bytes: 0, result: "created" });
        return wrapFile(child, path);
      },
      async removeEntry(name, options) {
        const path = join(dir, name);
        const size = sizes.get(path) ?? tracer.takeSizeHint(path) ?? 0;
        await observe({ path, action: "delete", missingOk: true, bytesOf: () => size }, () => handle.removeEntry(name, options));
        sizes.delete(path);
      },
      entries,
      [Symbol.asyncIterator]: entries,
    };
  }

  return wrapDir(root, "");
}
