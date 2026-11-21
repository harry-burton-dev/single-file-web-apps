// The oracle (spec P2): per table, one document of the same adapter to which
// every durable local update from every device is applied directly, at the
// moment the adapter emits it (adapter.onLocalUpdate, at source).
//
// Durability bookkeeping. Each emitted update is kept in an ordered list with
// a saved flag. A device's engine emits "saved" {table, at} when it has written
// its pending updates of that table to the folder; because the harness only
// edits between awaited engine calls, that event covers every update the
// device emitted for that table so far, so markSaved() flags them all.
// Updates written to the device's own folder count as durable even before they
// reach the cloud: the simulator still uploads them.
//
// When a device's local store is wiped, updates it never saved are gone for
// good (spec section 1): loseUnsaved() marks them lost and rebuilds every
// oracle document from the remaining updates in emission order.
//
// Limits: (1) "saved" is taken from the engine's own event, so an engine that
// emits "saved" without actually writing would hide a loss; P4's new-device
// check and P1 still see the folder. (2) A crash (store intact) never loses
// anything, so crash-time loss of an accepted update shows up as a P2 failure.
// (3) Rebuilding replays all updates, which is O(total updates) per wipe.

export function createOracle({ adapter, tables }) {
  const docs = new Map();
  const entries = [];
  const unsaved = new Map(); // `${device}|${table}` -> entries not yet saved

  const reset = () => {
    for (const table of tables) docs.set(table, adapter.create());
  };
  reset();

  const queueKey = (device, table) => `${device}|${table}`;

  const oracle = {
    adapter,
    tables,
    entries,
    /** Apply a local update emitted by `device` for `table`. */
    record({ device, table, bytes, at, epoch = 0, instance = null }) {
      const copy = bytes.slice();
      const entry = { id: entries.length, device, table, bytes: copy, at, epoch, instance, saved: false, savedAt: null, savedInstance: null, lost: false };
      entries.push(entry);
      adapter.applyUpdate(docs.get(table), copy, "oracle");
      const key = queueKey(device, table);
      if (!unsaved.has(key)) unsaved.set(key, []);
      unsaved.get(key).push(entry);
      return entry;
    },
    /** The device wrote its pending updates of `table` to the folder at `at`. */
    markSaved(device, table, at, instance = null) {
      const key = queueKey(device, table);
      for (const entry of unsaved.get(key) ?? []) {
        entry.saved = true;
        entry.savedAt = at;
        entry.savedInstance = instance;
      }
      unsaved.set(key, []);
    },
    /** The device's store was wiped: its unsaved updates are gone. Returns how many. */
    loseUnsaved(device) {
      let lost = 0;
      for (const [key, list] of unsaved) {
        if (!key.startsWith(`${device}|`)) continue;
        for (const entry of list) {
          entry.lost = true;
          lost += 1;
        }
        unsaved.set(key, []);
      }
      if (lost) oracle.rebuild();
      return lost;
    },
    rebuild() {
      reset();
      for (const entry of entries) {
        if (!entry.lost) adapter.applyUpdate(docs.get(entry.table), entry.bytes, "oracle");
      }
    },
    doc: (table) => docs.get(table),
    json: (table) => adapter.toJSON(docs.get(table)),
    allJson() {
      return Object.fromEntries(tables.map((table) => [table, adapter.toJSON(docs.get(table))]));
    },
    liveEntries: (filter = () => true) => entries.filter((entry) => !entry.lost && filter(entry)),
    unsavedCount: () => entries.filter((entry) => !entry.saved && !entry.lost).length,
  };
  return oracle;
}
