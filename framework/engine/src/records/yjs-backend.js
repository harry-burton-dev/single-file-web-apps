// Yjs storage backend for the record layer.
// doc.getMap("records"): flat keys (see keys.js). Plain values are stored
// directly, "text" fields as Y.Text, "ask" fields as one plain-object slot per
// device (ADR-0002 section 3): { n, value, seen: {device: n}, user, writtenAt }.
// doc.getMap("meta"): `schemaVersion:<device>` entries (see keys.js maxVersion).
import * as Y from "yjs";
import { key3 } from "./keys.js";
import { textEdit } from "./textdiff.js";

import { VERSION_PREFIX, maxVersion } from "./keys.js";

export function createYjsBackend({ doc }) {
  const records = doc.getMap("records");
  const meta = doc.getMap("meta");

  // `devices`, when the caller already grouped the keys, skips the full key scan.
  const slotsOf = (id, field, devices) => {
    if (devices) return devices.map((device) => ({ device, ...records.get(key3(id, field, device)) }));
    const prefix = key3(id, field, "");
    const out = [];
    for (const key of records.keys()) {
      if (key.startsWith(prefix)) out.push({ device: key.slice(prefix.length), ...records.get(key) });
    }
    return out;
  };

  // Slots not superseded by another slot's `seen`.
  const survivors = (slots) =>
    slots.filter((s) => !slots.some((o) => o.device !== s.device && (o.seen?.[s.device] ?? 0) >= s.n));

  return {
    keys: () => [...records.keys()],
    getPlain: (key) => records.get(key),
    getText(key) {
      const v = records.get(key);
      return v instanceof Y.Text ? v.toString() : typeof v === "string" ? v : undefined;
    },
    getAsk(id, field, devices) {
      return survivors(slotsOf(id, field, devices)).map(({ value, user, device, writtenAt }) => ({ value, user, device, writtenAt }));
    },
    schemaVersion: () => maxVersion(meta.entries()),
    // Fires after every committed change to the doc, local or remote.
    onChange(listener) {
      const h = () => listener();
      doc.on("update", h);
      return () => doc.off("update", h);
    },

    // doc.transact without an origin: a local change for the adapter.
    write(fn) {
      doc.transact(() => {
        fn({
          setPlain: (key, value) => records.set(key, value),
          updateText(key, text) {
            const current = records.get(key);
            if (current instanceof Y.Text) {
              const { index, deleteCount, insert } = textEdit(current.toString(), text);
              if (deleteCount) current.delete(index, deleteCount);
              if (insert) current.insert(index, insert);
            } else {
              const created = new Y.Text();
              records.set(key, created);
              if (text) created.insert(0, text);
            }
          },
          // Writes this device's slot; `seen` covers every other slot now known,
          // so the write supersedes all current candidates (this is also resolve).
          setAsk(id, field, value, { user, device, writtenAt }) {
            const slots = slotsOf(id, field);
            const mine = slots.find((s) => s.device === device);
            const seen = {};
            for (const s of slots) if (s.device !== device) seen[s.device] = s.n;
            records.set(key3(id, field, device), { n: (mine?.n ?? 0) + 1, value, seen, user, writtenAt });
          },
          setSchemaVersion: (n, device) => meta.set(VERSION_PREFIX + device, n),
        });
      });
    },
  };
}
