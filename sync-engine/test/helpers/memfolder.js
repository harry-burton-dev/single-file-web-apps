// Minimal in-memory folder (spec 2.2) shared by several "devices": no lag, no
// faults unless a hook asks for one. Plus a manual clock, deterministic random
// source and test key. Used only by the engine unit tests (the real simulator
// lives under src/sim).

export function createManualClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
  };
}

/** mulberry32: small, deterministic, good enough for IVs in tests. */
export function createSeededRandom(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
  };
}

export async function testKey(seed = 7) {
  const raw = createSeededRandom(seed).bytes(32);
  return globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function fsError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

export function createMemFolder({ clock = createManualClock() } = {}) {
  const rootNode = { kind: "directory", children: new Map() };
  const hooks = { failWrite: null, list: null }; // failWrite: (path) => error | falsy, checked at close(); list: (dirPath) => { fail } | { hide } | falsy
  const writes = []; // { path, size, at } for every successful close()
  const deletes = [];
  // Every operation that happened, in order: { type: "list"|"stat"|"read"|"write"|"delete", path, size }.
  // Creating an empty file is a "write" of size 0, as in the simulator's log.
  const ops = [];

  const walk = (parts, create) => {
    let node = rootNode;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next && create) {
        next = { kind: "directory", children: new Map() };
        node.children.set(part, next);
      }
      if (!next) throw fsError("NotFoundError", `no such directory: ${parts.join("/")}`);
      if (next.kind !== "directory") throw fsError("TypeMismatchError", `${part} is a file`);
      node = next;
    }
    return node;
  };

  function fileHandle(dirNode, name, pathParts) {
    const path = [...pathParts, name].join("/");
    return {
      kind: "file",
      name,
      async getFile() {
        const node = dirNode.children.get(name);
        if (!node) throw fsError("NotFoundError", path);
        const bytes = node.bytes;
        ops.push({ type: "stat", path, size: 0 });
        return {
          name, size: bytes.length, lastModified: node.lastModified,
          arrayBuffer: async () => {
            ops.push({ type: "read", path, size: bytes.length });
            return bytes.slice().buffer;
          },
        };
      },
      async createWritable() {
        const parts = [];
        let closed = false;
        return {
          async write(data) {
            parts.push(new Uint8Array(data));
          },
          async close() {
            if (closed) return;
            const failure = hooks.failWrite?.(path);
            if (failure) throw failure;
            const size = parts.reduce((n, p) => n + p.length, 0);
            const bytes = new Uint8Array(size);
            let at = 0;
            for (const p of parts) {
              bytes.set(p, at);
              at += p.length;
            }
            closed = true;
            dirNode.children.set(name, { kind: "file", bytes, lastModified: clock.now() });
            writes.push({ path, size, at: clock.now() });
            ops.push({ type: "write", path, size });
          },
          async abort() {
            closed = true;
          },
        };
      },
    };
  }

  function dirHandle(node, pathParts, name) {
    return {
      kind: "directory",
      name,
      async getDirectoryHandle(child, { create = false } = {}) {
        const next = node.children.get(child);
        if (next && next.kind !== "directory") throw fsError("TypeMismatchError", child);
        if (!next && !create) throw fsError("NotFoundError", child);
        const target = next ?? { kind: "directory", children: new Map() };
        node.children.set(child, target);
        return dirHandle(target, [...pathParts, child], child);
      },
      async getFileHandle(child, { create = false } = {}) {
        const next = node.children.get(child);
        if (next && next.kind !== "file") throw fsError("TypeMismatchError", child);
        if (!next && !create) throw fsError("NotFoundError", child);
        if (!next) {
          node.children.set(child, { kind: "file", bytes: new Uint8Array(0), lastModified: clock.now() });
          ops.push({ type: "write", path: [...pathParts, child].join("/"), size: 0 });
        }
        return fileHandle(node, child, pathParts);
      },
      async removeEntry(child) {
        if (!node.children.has(child)) throw fsError("NotFoundError", child);
        const size = node.children.get(child).bytes?.length ?? 0;
        node.children.delete(child);
        deletes.push({ path: [...pathParts, child].join("/"), at: clock.now() });
        ops.push({ type: "delete", path: [...pathParts, child].join("/"), size });
      },
      async *entries() {
        const act = hooks.list?.(pathParts.join("/"));
        if (act?.fail) throw act.fail;
        try {
          if (act?.hide) return;
          for (const [childName, child] of [...node.children]) {
            yield [childName, child.kind === "file" ? fileHandle(node, childName, pathParts) : dirHandle(child, [...pathParts, childName], childName)];
          }
        } finally {
          ops.push({ type: "list", path: pathParts.join("/"), size: 0 }); // logged when the listing ends, like a trace step
        }
      },
    };
  }

  const split = (path) => path.split("/").filter(Boolean);

  return {
    root: dirHandle(rootNode, [], ""),
    writes,
    deletes,
    ops,
    /** Make every write whose path matches fail at close() until cleared. */
    failWrites(match, error = fsError("NoModificationAllowedError", "locked")) {
      hooks.failWrite = (path) => (match(path) ? error : null);
    },
    clearFailures() {
      hooks.failWrite = null;
    },
    /** Make listing any directory whose path matches throw (a failing folder read). */
    failListing(match, error = fsError("NotReadableError", "cannot list")) {
      hooks.list = (path) => (match(path) ? { fail: error } : null);
    },
    /** Make listing any directory whose path matches look empty (not synced down yet). */
    hideListing(match) {
      hooks.list = (path) => (match(path) ? { hide: true } : null);
    },
    clearListing() {
      hooks.list = null;
    },
    /** Place any bytes at a path, creating directories (garbage, copies...). */
    drop(path, bytes) {
      const parts = split(path);
      const name = parts.pop();
      walk(parts, true).children.set(name, { kind: "file", bytes: new Uint8Array(bytes), lastModified: clock.now() });
    },
    read(path) {
      const parts = split(path);
      const name = parts.pop();
      const node = walk(parts, false).children.get(name);
      return node ? node.bytes.slice() : undefined;
    },
    /** Copy a file to another path, optionally cut short (a half-synced copy). */
    copy(from, to, length) {
      const bytes = this.read(from);
      this.drop(to, length === undefined ? bytes : bytes.slice(0, length));
    },
    remove(path) {
      const parts = split(path);
      const name = parts.pop();
      walk(parts, false).children.delete(name);
    },
    /** Sorted file paths, optionally under a prefix. */
    paths(prefix = "") {
      const out = [];
      const visit = (node, base) => {
        for (const [childName, child] of node.children) {
          const path = base ? `${base}/${childName}` : childName;
          if (child.kind === "file") out.push(path);
          else visit(child, path);
        }
      };
      visit(rootNode, "");
      return out.filter((p) => p.startsWith(prefix)).sort();
    },
    /** Delete everything (an emptied folder). */
    empty() {
      rootNode.children.clear();
    },
  };
}
