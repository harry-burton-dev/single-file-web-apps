// Backend-independent record layer (ADR-0002). A backend (yjs-backend.js) stores flat keys and implements:
//   keys(), getPlain(key), getText(key), getAsk(id, field, devices?), schemaVersion(), onChange(listener),
//   write(fn(tx)) with tx.setPlain / updateText / setAsk / setSchemaVersion.
import { DELETED, SEP, VERSION, key2, parseKey } from "./keys.js";

export function schemaTooNew(stored, supported) {
  const err = new Error(`Table schema version ${stored} is newer than this app understands (${supported}); writes are blocked`);
  err.name = "SchemaTooNew";
  err.storedVersion = stored;
  err.supportedVersion = supported;
  return err;
}

// Provisional value: latest writtenAt, ties broken by device id. Same on every replica.
const byRank = (a, b) => (a.writtenAt - b.writtenAt) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);

// Ask slot used when a put writes back migrated values. Every device writes the
// same slot with the same content, so two devices migrating one record at once
// leave one candidate, not a conflict between two equal values.
const MIGRATION_SLOT = { user: null, device: "_migration", writtenAt: 0 };

// migrations: { <fromVersion>: (fields) => fields }, each taking version n to n + 1.
// Steps are applied in memory on read. A put on an older record writes back the
// migrated fields whose value changed. Steps should be additive and leave an
// already-migrated record unchanged: a record edited at once by devices on
// different versions can carry either version afterwards.
export function createTable({ backend, schema, deviceId, user, clock, migrations = {} }) {
  const fieldsSchema = schema.fields ?? {};
  const kindOf = (field) => fieldsSchema[field] ?? "latest";

  function assertId(id) {
    if (typeof id !== "string" || !id || id.includes(SEP)) throw new TypeError("record id must be a non-empty string without U+001F");
  }
  function assertField(field) {
    if (typeof field !== "string" || !field || field.includes(SEP)) throw new TypeError(`bad field name: ${field}`);
    if (field === DELETED || field === VERSION) throw new TypeError(`"${field}" is a reserved field name`);
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

  // id -> Map of field name (excluding the deleted flag) -> ask slot devices, in key order.
  // One pass over the keys, so list() is linear in the number of keys.
  function index() {
    const ids = new Map();
    for (const key of backend.keys()) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      if (!ids.has(parsed.id)) ids.set(parsed.id, new Map());
      if (parsed.field === DELETED || parsed.field === VERSION) continue;
      const fields = ids.get(parsed.id);
      if (!fields.has(parsed.field)) fields.set(parsed.field, []);
      if (parsed.device !== null) fields.get(parsed.field).push(parsed.device);
    }
    return ids;
  }

  // `devices` (from index()) lets an ask read skip the backend's key scan.
  function readField(id, field, devices) {
    const kind = kindOf(field);
    if (kind === "text") return { value: backend.getText(key2(id, field)), conflict: null };
    if (kind === "ask") {
      const candidates = backend.getAsk(id, field, devices).sort(byRank);
      if (candidates.length === 0) return { value: undefined, conflict: null };
      const value = candidates[candidates.length - 1].value;
      return { value, conflict: candidates.length > 1 ? candidates : null };
    }
    return { value: backend.getPlain(key2(id, field)), conflict: null };
  }

  const versionOf = (id) => backend.getPlain(key2(id, VERSION)) ?? 1;

  // Runs the steps from `version` up to the schema version; a missing step changes nothing.
  function migrate(fields, version) {
    let out = fields;
    for (let v = version; v < schema.version; v++) if (migrations[v]) out = migrations[v]({ ...out });
    return out;
  }

  const sorted = (fields) => Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]]));

  function readStored(id, fieldMap) {
    const fields = {};
    const conflicts = {};
    for (const name of [...fieldMap.keys()].sort()) {
      const { value, conflict } = readField(id, name, fieldMap.get(name));
      if (value === undefined) continue;
      fields[name] = value;
      if (conflict) conflicts[name] = conflict;
    }
    return { id, deleted: backend.getPlain(key2(id, DELETED)) === true, fields, conflicts };
  }

  function readRecord(id, fieldMap) {
    const record = readStored(id, fieldMap);
    const version = versionOf(id);
    if (version < schema.version) record.fields = sorted(migrate(record.fields, version));
    return record;
  }

  // Migrated fields whose value differs from what is stored, for a put to write back.
  function migratedChanges(id) {
    const fieldMap = index().get(id);
    const version = versionOf(id);
    if (!fieldMap || version >= schema.version) return {};
    const stored = readStored(id, fieldMap).fields;
    const changes = {};
    for (const [name, value] of Object.entries(migrate(stored, version))) {
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(stored[name])) changes[name] = value;
    }
    return changes;
  }

  function writeField(tx, id, field, value, migrated = false) {
    if (value === undefined) throw new TypeError(`value for ${field} is undefined`);
    const kind = kindOf(field);
    if (kind === "text") {
      if (typeof value !== "string") throw new TypeError(`text field ${field} needs a string`);
      tx.updateText(key2(id, field), value);
    } else if (kind === "ask") {
      tx.setAsk(id, field, value, migrated ? MIGRATION_SLOT : { user, device: deviceId, writtenAt: clock.now() });
    } else {
      tx.setPlain(key2(id, field), value);
    }
  }

  const table = {
    put(id, fields) {
      assertId(id);
      for (const name of Object.keys(fields)) assertField(name);
      write((tx) => {
        for (const [name, value] of Object.entries(migratedChanges(id))) if (!(name in fields)) writeField(tx, id, name, value, true);
        for (const [name, value] of Object.entries(fields)) writeField(tx, id, name, value);
        if (backend.getPlain(key2(id, VERSION)) !== schema.version) tx.setPlain(key2(id, VERSION), schema.version);
      });
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
    // Runs fn inside one backend transaction, so every write in it is one local update.
    batch(fn) {
      assertWritable();
      let result;
      write(() => { result = fn(); });
      return result;
    },
    onChange: (listener) => backend.onChange(listener),
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
      const read = readField(id, name);
      const value = versionOf(id) < schema.version ? table.get(id)?.fields[name] : read.value;
      return { value, conflict: read.conflict, resolve: (v) => table.put(id, { [name]: v }) };
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
