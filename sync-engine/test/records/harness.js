// Shared helpers for record-layer tests: adapters, replicas, direct sync.
import { existsSync } from "node:fs";
import * as Y from "yjs";
import { openTable } from "../../src/records/index.js";

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

// Tiny stand-in used only when src/adapters/yjs.js does not exist yet.
const REMOTE = Symbol("remote");
const inlineYjs = {
  name: "yjs",
  create: () => new Y.Doc(),
  onLocalUpdate(doc, cb) {
    const h = (u, origin) => { if (origin !== REMOTE) cb(u); };
    doc.on("update", h);
    return () => doc.off("update", h);
  },
  applyUpdate: (doc, bytes) => Y.applyUpdate(doc, bytes, REMOTE),
  snapshot: (doc) => Y.encodeStateAsUpdate(doc),
  toJSON: (doc) => canonical(doc.toJSON()),
};

export async function loadYjsAdapter() {
  const url = new URL("../../src/adapters/yjs.js", import.meta.url);
  if (existsSync(url)) {
    try {
      const mod = await import(url.href);
      const adapter = mod.default ?? mod.yjsAdapter ?? (mod.createYjsAdapter && mod.createYjsAdapter());
      if (adapter) return { adapter, source: "src/adapters/yjs.js" };
    } catch { /* fall through to the inline adapter */ }
  }
  return { adapter: inlineYjs, source: "inline" };
}

export async function variants() {
  const yjs = await loadYjsAdapter();
  return [
    { name: "yjs", adapter: yjs.adapter },
  ];
}

// A set of replicas of one table that sync by passing adapter updates directly.
export function createWorld(variant, schema) {
  const time = { t: 1000 };
  const replicas = [];
  const world = {
    time,
    replicas,
    add(deviceId, user = deviceId.split("-")[0], schemaOverride = schema) {
      const { adapter, name } = variant;
      const doc = adapter.create();
      const outbox = [];
      adapter.onLocalUpdate(doc, (u) => outbox.push(u));
      const table = openTable({
        adapterName: name, adapter, doc, schema: schemaOverride, deviceId, user, clock: { now: () => time.t },
      });
      const replica = { deviceId, adapter, doc, outbox, table, delivered: new Map() };
      replicas.push(replica);
      return replica;
    },
    // Deliver everything `from` has produced and `to` has not yet received.
    deliver(from, to) {
      const start = to.delivered.get(from) ?? 0;
      for (const u of from.outbox.slice(start)) to.adapter.applyUpdate(to.doc, u, "remote");
      to.delivered.set(from, from.outbox.length);
    },
    syncAll() {
      for (let round = 0; round < 2; round++) for (const a of replicas) for (const b of replicas) if (a !== b) world.deliver(a, b);
    },
  };
  return world;
}

export const jsonOf = (r) => JSON.stringify(r.adapter.toJSON(r.doc));
