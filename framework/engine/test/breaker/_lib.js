// Shared helpers for the breaker probes. Not a probe itself.
import { createEngine } from "../../src/engine/engine.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { yjsAdapter } from "../../src/adapters/yjs.js";
import { open } from "../../src/engine/envelope.js";
import { createMemFolder, createManualClock, createSeededRandom, testKey } from "../helpers/memfolder.js";

export const A = "harry-aaaaaaaa";
export const B = "sam-bbbbbbbb";
export const C = "kim-cccccccc";
export const EAGER = { quietMs: 2000, maxWaitMs: 10000, minIntervalMs: 2000, scanMs: 1000, statusMs: 5000 };
export const COMPACT = { sealBytes: 1, compaction: { chunkThreshold: 5, minSnapshotAgeMs: 10000, jitterMs: 0 } };
export const DAY = 86400000;

export async function world({ tables = { notes: "yjs" }, options = {}, seed = 42 } = {}) {
  const clock = createManualClock();
  const folder = createMemFolder({ clock });
  const random = createSeededRandom(seed);
  const key = await testKey();
  const stores = new Map();
  const w = {
    clock, folder, key, random, stores, tables, engines: new Map(), offsets: new Map(),
    store(id) { if (!stores.has(id)) stores.set(id, createMemoryStore()); return stores.get(id); },
    /** Per-device clock = shared clock + offset (mutable via w.offsets). */
    async device(id, extra = {}) {
      if (extra.offsetMs != null) w.offsets.set(id, extra.offsetMs);
      const dclock = { now: () => clock.now() + (w.offsets.get(id) ?? 0) };
      const engine = await createEngine({
        root: extra.root ?? folder.root, clock: dclock, random, store: extra.store ?? w.store(id),
        key: extra.key ?? key, keyId: extra.keyId ?? 1, keys: extra.keys,
        user: id.split("-")[0], deviceId: id, adapters: { yjs: yjsAdapter }, tables: extra.tables ?? tables,
        options: { ...EAGER, ...options, ...(extra.options ?? {}) },
      });
      w.engines.set(id, engine);
      return engine;
    },
    async run(engines, ms, step = 1000) {
      for (let t = 0; t < ms; t += step) {
        clock.advance(step);
        for (const e of engines) await e.tick();
      }
    },
  };
  return w;
}

export const json = (e, table = "notes") => yjsAdapter.toJSON(e.table(table));
export const m = (e, table = "notes") => e.table(table).getMap("m");
export const paths = (w, prefix) => w.folder.paths(prefix);
export const chunks = (w, id, table = "notes") => w.folder.paths(`data/${table}/${id}/`).filter((p) => /\/\d{6}\.ywb$/.test(p)).map((p) => p.split("/").pop());
export const snaps = (w, id, table = "notes") => w.folder.paths(`data/${table}/${id}/snap-`).map((p) => p.split("/").pop());
export const readMeta = async (w, path) => (await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(path) })).meta;

/** An engine plus its dead-after-N-calls wrappers: calls beyond N reject, as if the process died. */
export function crashable(inner, limit, onDeath) {
  const state = { calls: 0, dead: false };
  const tick = () => {
    state.calls += 1;
    if (state.calls > limit) { state.dead = true; onDeath?.(); throw Object.assign(new Error("process died"), { name: "CrashError" }); }
  };
  return { state, tick };
}

export function wrapStore(store, gate) {
  return {
    get: async (k) => { gate.tick(); return store.get(k); },
    set: async (k, v) => { gate.tick(); return store.set(k, v); },
    delete: async (k) => { gate.tick(); return store.delete(k); },
    keys: async (p) => { gate.tick(); return store.keys(p); },
  };
}

/** Wrap a directory handle so every mutating/reading call passes the gate. */
export function wrapDir(dir, gate) {
  return new Proxy(dir, {
    get(t, p) {
      if (p === "getDirectoryHandle") return async (n, o) => { gate.tick(); return wrapDir(await t.getDirectoryHandle(n, o), gate); };
      if (p === "getFileHandle") return async (n, o) => { gate.tick(); return wrapFile(await t.getFileHandle(n, o), gate); };
      if (p === "removeEntry") return async (n, o) => { gate.tick(); return t.removeEntry(n, o); };
      if (p === "entries") return async function* () { gate.tick(); for await (const [n, h] of t.entries()) yield [n, h.kind === "file" ? wrapFile(h, gate) : wrapDir(h, gate)]; };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
function wrapFile(fh, gate) {
  return new Proxy(fh, {
    get(t, p) {
      if (p === "createWritable") return async () => {
        gate.tick();
        const w = await t.createWritable();
        return { write: async (d) => { gate.tick(); return w.write(d); }, close: async () => { gate.tick(); return w.close(); }, abort: async () => w.abort?.() };
      };
      if (p === "getFile") return async () => { gate.tick(); return t.getFile(); };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
