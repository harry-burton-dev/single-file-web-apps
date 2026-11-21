// Small stand-ins for the browser globals startHost touches: Web Locks, the
// online flag, timers and page events. Enough to start and stop the host in Node.
import { createMemFolder, testKey } from "../../../engine/test/helpers/memfolder.js";

const noop = () => undefined;

function setGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

/** Installs the fakes; returns the lock names requested and a restore function. */
export function installFakeBrowser() {
  const lockNames = [];
  const locks = {
    request(name, _options, callback) {
      lockNames.push(name);
      return Promise.resolve(callback({ name }));
    },
  };
  const intervals = new Set();
  const restores = [
    setGlobal("navigator", { locks, onLine: true }),
    setGlobal("window", {
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        intervals.add(handle);
        return handle;
      },
      clearInterval: (handle) => {
        clearInterval(handle);
        intervals.delete(handle);
      },
      addEventListener: noop,
      removeEventListener: noop,
    }),
    setGlobal("document", { visibilityState: "visible", addEventListener: noop, removeEventListener: noop }),
  ];
  return {
    lockNames,
    restore() {
      for (const handle of intervals) clearInterval(handle);
      for (const undo of restores.reverse()) undo();
    },
  };
}

/** A memory key-value store with the KeyValueDb shape. */
export function memoryDb() {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    keys: async (prefix = "") => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** Everything startHost needs apart from the app definition. */
export async function hostConfig(app) {
  return { root: createMemFolder().root, db: memoryDb(), user: "ann", key: await testKey(), keyId: 0, app };
}
