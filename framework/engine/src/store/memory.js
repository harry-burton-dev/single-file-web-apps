// In-memory local store (spec 2.3). Values are copied on set and get so a
// caller can never mutate stored data (or be mutated by it).

function copy(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value === undefined) return undefined;
  return structuredClone(value);
}

export function createMemoryStore() {
  const data = new Map();
  return {
    async get(key) {
      return copy(data.get(key));
    },
    async set(key, value) {
      data.set(key, copy(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async keys(prefix = "") {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    // Test/fault hook: forget everything, as a cleared browser profile would.
    wipe() {
      data.clear();
    },
  };
}

export default createMemoryStore;
