// Yjs adapter (spec 2.4). The engine never touches Yjs directly.
//
// Local vs remote: every update applied through applyUpdate carries the fixed
// REMOTE_ORIGIN, and onLocalUpdate reports only transactions whose origin is
// something else, so updates received from the folder are never echoed back.
import * as Y from "yjs";

const REMOTE_ORIGIN = Object.freeze({ remote: true });

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

// A top-level type that this doc received but never declared is a bare
// AbstractType with no toJSON. Sniff what it holds so devices that have not
// touched the type still compare equal to devices that have.
function resolveType(doc, name, type) {
  if (type.constructor !== Y.AbstractType) return type;
  if (type._map.size > 0) return doc.getMap(name);
  const first = type._start;
  if (first === null) return null;
  return typeof first.content.str === "string" ? doc.getText(name) : doc.getArray(name);
}

function isEmpty(json) {
  if (json === undefined || json === null || json === "") return true;
  if (Array.isArray(json)) return json.length === 0;
  return typeof json === "object" && Object.keys(json).length === 0;
}

/**
 * Yjs adapter factory. By default every new Y.Doc gets Yjs's own random
 * clientID. With `random` ({ bytes(n) } from the host's injected source) the
 * clientID is drawn from it instead, so a seeded run is reproducible.
 *
 * Whatever the source, clientIDs must stay unique per session: two sessions
 * (or a wiped store and its predecessor) that write with the same clientID
 * and overlapping clocks corrupt each other's items. So a seeded source must
 * be one stream per device that keeps advancing across sessions, never one
 * that is re-created, and a production host passes real randomness.
 */
export function createYjsAdapter({ random } = {}) {
  const create = () => {
    const doc = new Y.Doc();
    if (random) doc.clientID = new DataView(random.bytes(4).buffer).getUint32(0);
    return doc;
  };
  return Object.freeze({ ...yjsAdapterBase, create });
}

const yjsAdapterBase = {
  name: "yjs",
  create: () => new Y.Doc(),
  onLocalUpdate(doc, cb) {
    const handler = (update, origin) => {
      if (origin !== REMOTE_ORIGIN) cb(update);
    };
    doc.on("update", handler);
    return () => doc.off("update", handler);
  },
  applyUpdate(doc, bytes) {
    Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
  },
  snapshot: (doc) => Y.encodeStateAsUpdate(doc),
  compact: (updates) => (updates.length <= 1 ? updates : [Y.mergeUpdates(updates)]),
  // Canonical JSON: top-level types by name, keys sorted recursively. Empty
  // top-level values are omitted so "declared but empty" equals "never seen".
  toJSON(doc) {
    const out = {};
    for (const name of [...doc.share.keys()].sort()) {
      const type = resolveType(doc, name, doc.share.get(name));
      const json = type ? type.toJSON() : undefined;
      if (!isEmpty(json)) out[name] = sortKeys(json);
    }
    return out;
  },
};

export const yjsAdapter = createYjsAdapter();

export default yjsAdapter;
