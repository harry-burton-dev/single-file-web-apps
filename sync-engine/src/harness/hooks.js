// Directory-handle wrapper that tells the harness about every removeEntry
// BEFORE it happens, so P4 can validate a delete against the folder state at
// that exact moment. Everything else is passed through untouched.
const join = (dir, name) => (dir === "" ? name : `${dir}/${name}`);

export function watchRemovals(dir, onRemove, path = "") {
  return new Proxy(dir, {
    get(target, prop) {
      if (prop === "getDirectoryHandle") {
        return async (name, options) => watchRemovals(await target.getDirectoryHandle(name, options), onRemove, join(path, name));
      }
      if (prop === "removeEntry") {
        return async (name, options) => {
          await onRemove(join(path, name));
          return target.removeEntry(name, options);
        };
      }
      if (prop === "entries") {
        return async function* entries() {
          for await (const [name, handle] of target.entries()) {
            yield [name, handle.kind === "directory" ? watchRemovals(handle, onRemove, join(path, name)) : handle];
          }
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Directory-handle wrapper that reports every byte string the engine hands to a
 * writable, with the path of the file, as it is written. Everything else is
 * passed through untouched. Used by P16 (IV uniqueness).
 */
export function watchWrites(dir, onWrite, path = "") {
  const wrapFile = (file, filePath) =>
    new Proxy(file, {
      get(target, prop) {
        if (prop !== "createWritable") {
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args) => {
          const writable = await target.createWritable(...args);
          return new Proxy(writable, {
            get(w, wProp) {
              if (wProp === "write") {
                return (data) => {
                  if (data instanceof Uint8Array) onWrite(filePath, data);
                  return w.write(data);
                };
              }
              const v = w[wProp];
              return typeof v === "function" ? v.bind(w) : v;
            },
          });
        };
      },
    });
  return new Proxy(dir, {
    get(target, prop) {
      if (prop === "getDirectoryHandle") {
        return async (name, options) => watchWrites(await target.getDirectoryHandle(name, options), onWrite, join(path, name));
      }
      if (prop === "getFileHandle") {
        return async (name, options) => wrapFile(await target.getFileHandle(name, options), join(path, name));
      }
      if (prop === "entries") {
        return async function* entries() {
          for await (const [name, handle] of target.entries()) {
            yield [name, handle.kind === "directory" ? watchWrites(handle, onWrite, join(path, name)) : wrapFile(handle, join(path, name))];
          }
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
