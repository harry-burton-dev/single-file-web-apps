// Backend-independent record layer (ADR-0002). A backend (yjs-backend.js) stores flat keys and implements:
//   keys(), getPlain(key), getText(key), getAsk(id, field), schemaVersion(),
//   write(fn(tx)) with tx.setPlain / updateText / setAsk / setSchemaVersion.
import { DELETED, SEP, key2, parseKey } from "./keys.js";

export function schemaTooNew(stored, supported) {
  const err = new Error(`Table schema version ${stored} is newer than this app understands (${supported}); writes are blocked`);
  err.name = "SchemaTooNew";
  err.storedVersion = stored;
  err.supportedVersion = supported;
  return err;
}

// Provisional value: latest writtenAt, ties broken by device id. Same on every replica.
const byRank = (a, b) => (a.writtenAt - b.writtenAt) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);

export function createTable({ backend, schema, deviceId, user, clock }) {
  const fieldsSchema = schema.fields ?? {};
  const kindOf = (field) => fieldsSchema[field] ?? "latest";

  function assertId(id) {
    if (typeof id !== "string" || !id || id.includes(SEP)) throw new TypeError("record id must be a non-empty string without U+001F");
  }
  function assertField(field) {
    if (typeof field !== "string" || !field || field.includes(SEP)) throw new TypeError(`bad field name: ${field}`);
    if (field === DELETED) throw new TypeError('"deleted" is a reserved field name');
  }
  function assertWritable() {
    const stored = backend.schemaVersion();
    if (typeof stored === "number" && stored > schema.version) throw schemaTooNew(stored, schema.version);
  }
  function write(fn) {
    assertWritable();
    backend.write((tx) => {
      const stored = backend.schemaVersion();
      if (typeof stored !== "number" || stored < schema.version) tx.setSchemaVersion(schema.version, deviceId);
      fn(tx);
    });
  }

  // id -> Set of field names (excluding the deleted flag).
  function index() {
    const ids = new Map();
    for (const key of backend.keys()) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      if (!ids.has(parsed.id)) ids.set(parsed.id, new Set());
      if (parsed.field !== DELETED) ids.get(parsed.id).add(parsed.field);
    }
    return ids;
  }

  function readField(id, field) {
    const kind = kindOf(field);
    if (kind === "text") return { value: backend.getText(key2(id, field)), conflict: null };
    if (kind === "ask") {
      const candidates = backend.getAsk(id, field).sort(byRank);
      if (candidates.length === 0) return { value: undefined, conflict: null };
      const value = candidates[candidates.length - 1].value;
      return { value, conflict: candidates.length > 1 ? candidates : null };
    }
    return { value: backend.getPlain(key2(id, field)), conflict: null };
  }

  function readRecord(id, fieldNames) {
    const fields = {};
    const conflicts = {};
    for (const name of [...fieldNames].sort()) {
      const { value, conflict } = readField(id, name);
      if (value === undefined) continue;
      fields[name] = value;
      if (conflict) conflicts[name] = conflict;
    }
    return { id, deleted: backend.getPlain(key2(id, DELETED)) === true, fields, conflicts };
  }

  function writeField(tx, id, field, value) {
    if (value === undefined) throw new TypeError(`value for ${field} is undefined`);
    const kind = kindOf(field);
    if (kind === "text") {
      if (typeof value !== "string") throw new TypeError(`text field ${field} needs a string`);
      tx.updateText(key2(id, field), value);
    } else if (kind === "ask") {
      tx.setAsk(id, field, value, { user, device: deviceId, writtenAt: clock.now() });
    } else {
      tx.setPlain(key2(id, field), value);
    }
  }

  const table = {
    put(id, fields) {
      assertId(id);
      for (const name of Object.keys(fields)) assertField(name);
      write((tx) => { for (const [name, value] of Object.entries(fields)) writeField(tx, id, name, value); });
    },
    get(id) {
      assertId(id);
      const names = index().get(id);
      return names ? readRecord(id, names) : undefined;
    },
    list({ includeDeleted = false } = {}) {
      const out = [];
      for (const [id, names] of [...index()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const record = readRecord(id, names);
        if (includeDeleted || !record.deleted) out.push(record);
      }
      return out;
    },
    remove(id) {
      assertId(id);
      write((tx) => tx.setPlain(key2(id, DELETED), true));
    },
    restore(id) {
      assertId(id);
      write((tx) => tx.setPlain(key2(id, DELETED), false));
    },
    field(id, name) {
      assertId(id);
      assertField(name);
      const { value, conflict } = readField(id, name);
      return { value, conflict, resolve: (v) => table.put(id, { [name]: v }) };
    },
    updateText(id, name, newString) {
      assertId(id);
      assertField(name);
      if (kindOf(name) !== "text") throw new TypeError(`${name} is not a text field`);
      table.put(id, { [name]: newString });
    },
    conflicts() {
      const out = [];
      for (const record of table.list()) {
        for (const [field, candidates] of Object.entries(record.conflicts)) out.push({ id: record.id, field, candidates });
      }
      return out;
    },
    schemaVersion: () => backend.schemaVersion(),
  };
  return table;
}
