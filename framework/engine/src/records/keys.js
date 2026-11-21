// Storage keys are FLAT: one entry per (record, field), not a map per record.
//
// Why (deviation from ADR-0002 section 1, verified by test): if two devices
// concurrently create the same record id, a nested `records[id] = {...}`
// creates two different container objects and the CRDT keeps only one of them
// (Y.Map.set behaves this way), so the
// other device's fields vanish. With flat keys, two devices creating "the
// same" deterministic-id record write different keys and both survive.
//
//   latest / text field  : `<id> SEP <field>`
//   ask field            : `<id> SEP <field> SEP <deviceId>`  (one slot per device)
//   deleted flag         : `<id> SEP deleted`  (a "latest" boolean)
//   record version       : `<id> SEP _v`  (a "latest" number; missing means 1)
export const SEP = "\u001f";
export const DELETED = "deleted";
export const VERSION = "_v";

export const key2 = (id, field) => id + SEP + field;
export const key3 = (id, field, device) => id + SEP + field + SEP + device;

export function parseKey(key) {
  const parts = key.split(SEP);
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) return null;
  return { id: parts[0], field: parts[1], device: parts[2] ?? null };
}

// Schema version is stored per device (`schemaVersion:<device>`) and read as the
// maximum. A single shared key is last-writer-wins, so an old app writing
// concurrently with a new one could lower the stored version and unblock writes.
export const VERSION_PREFIX = "schemaVersion:";
export function maxVersion(entries) {
  let max;
  for (const [key, value] of entries) {
    if (key.startsWith(VERSION_PREFIX) && typeof value === "number" && (max === undefined || value > max)) max = value;
  }
  return max;
}
