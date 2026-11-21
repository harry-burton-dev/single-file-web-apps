// Minimal promise wrapper over one IndexedDB object store of key/value pairs.
// Used for the engine's local store and for remembering the folder handle.

const STORE = "kv";

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export interface KeyValueDb {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export async function openDb(name: string): Promise<KeyValueDb> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(STORE);
  };
  const db = await done(opening);
  const store = (mode: IDBTransactionMode): IDBObjectStore => db.transaction(STORE, mode).objectStore(STORE);

  return {
    get: (key) => done(store("readonly").get(key)),
    async set(key, value) {
      await done(store("readwrite").put(value, key));
    },
    async delete(key) {
      await done(store("readwrite").delete(key));
    },
    async keys(prefix = "") {
      // "￿" sorts after every character used in keys, so this is a prefix range.
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
      const found = await done(store("readonly").getAllKeys(range));
      return found.map(String).sort();
    },
  };
}
