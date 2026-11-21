// Per-run measures (spec section 4). computeMetrics() is pure: it takes the
// simulator's log and stats plus the scenario's records and returns numbers.
//
// What is measured, exactly
//  - cloudFilesEnd / cloudFilesPeak: files in the simulated cloud after the
//    final settle (before the new device joins) / the highest count ever seen
//    by the simulator (this includes transient .crswap leftovers and conflict
//    copies when those faults are on).
//  - bytesWritten: sum of sizes of every successful local write by an engine
//    (chunks, snapshots, status files); bytesByKind splits it. bytesUploaded is
//    what actually crossed to the cloud (a write superseded before its upload
//    still uploads here: the simulator uploads every write).
//  - largestFile: biggest single write (path and bytes), and the biggest file
//    in the cloud at the end.
//  - latency: for each durable local update made while some other device had a
//    session open, the time from the edit (clock at onLocalUpdate) to the first
//    moment that other device's engine APPLIED a chunk of the author that
//    contains it (the engine's "received" event, matched on the chunk version
//    that holds the update). Per update the value is the MAX over those other
//    devices ("arrival on the last device"). Only arrivals inside the other
//    device's same session count; updates that some such device did not receive
//    before its session ended (or that arrived inside a snapshot rather than the
//    author's chunk) are counted in `missed` and left out of the percentiles.
//      total          = receive time - edit time, sync lag INCLUDED (it contains
//                       the simulated upload and download lag, the save delay
//                       and the wait for the next scan);
//      excludingSync  = total minus the transport time of the file version that
//                       delivered it: (when the file first appeared in the
//                       receiver's folder view) - (when the author wrote it).
//                       What is left is the engine's own delay (save timing and
//                       scan timing).
//  - newDevice: files and bytes read (simulator counters: arrayBuffer calls and
//    their sizes) by a brand-new device from its start until its documents equal
//    the oracle.

const CHUNK_PATH = /^data\/([^/]+)\/([^/]+)\/\d{6}\.ywb$/;

export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null };
}

function kindOf(path) {
  if (path.startsWith("status/")) return "status";
  if (/\/snap-[^/]+\.ywb$/.test(path)) return "snapshot";
  if (/\.ywb$/.test(path)) return "chunk";
  return "other";
}

function logFacts(log) {
  const bytesByKind = { chunk: 0, snapshot: 0, status: 0, other: 0 };
  let largest = { bytes: 0, path: null };
  let deletes = 0;
  let snapshotsWritten = 0;
  for (const e of log) {
    if (e.type === "write") {
      const kind = kindOf(e.path);
      bytesByKind[kind] += e.size;
      if (kind === "snapshot") snapshotsWritten += 1;
      if (e.size > largest.bytes) largest = { bytes: e.size, path: e.path };
    } else if (e.type === "delete") deletes += 1;
  }
  return { bytesByKind, largest, deletes, snapshotsWritten };
}

// Sorted-by-writtenAt arrays with a suffix minimum of arrival time.
function buildReceiveIndex(received) {
  const groups = new Map();
  for (const r of received) {
    const key = `${r.instance}|${r.table}|${r.from}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const index = new Map();
  for (const [key, list] of groups) {
    list.sort((a, b) => a.writtenAt - b.writtenAt || a.at - b.at);
    const best = new Array(list.length);
    let min = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (min === null || list[i].at < min.at) min = list[i];
      best[i] = min;
    }
    index.set(key, { list, best });
  }
  return index;
}

function firstReceive(index, instance, table, from, savedAt) {
  const entry = index.get(`${instance}|${table}|${from}`);
  if (!entry) return null;
  let lo = 0;
  let hi = entry.list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entry.list[mid].writtenAt >= savedAt) hi = mid;
    else lo = mid + 1;
  }
  return lo < entry.list.length ? entry.best[lo] : null;
}

export function computeLatency({ log, updates, received, sessions }) {
  const index = buildReceiveIndex(received);
  const writePath = new Map(); // device|table|t -> chunk path
  const downloads = new Map(); // observer|path -> [t...]
  for (const e of log) {
    if (e.type === "write") {
      const m = CHUNK_PATH.exec(e.path);
      if (m) writePath.set(`${e.device}|${m[1]}|${e.t}`, e.path);
    } else if (e.type === "download" && e.detail !== "delete") {
      const key = `${e.device}|${e.path}`;
      if (!downloads.has(key)) downloads.set(key, []);
      downloads.get(key).push(e.t);
    }
  }
  const byDevice = new Map();
  for (const s of sessions) {
    if (!byDevice.has(s.device)) byDevice.set(s.device, []);
    byDevice.get(s.device).push(s);
  }
  const totals = [];
  const excluded = [];
  let missed = 0;
  let alone = 0;
  for (const u of updates) {
    if (u.lost || !u.saved) continue;
    let total = null;
    let excl = null;
    let lost = false;
    let observers = 0;
    for (const [device, list] of byDevice) {
      if (device === u.device) continue;
      const session = list.find((s) => s.start <= u.at && (s.end === null || s.end >= u.at));
      if (!session) continue;
      observers += 1;
      const hit = firstReceive(index, session.instance, u.table, u.device, u.savedAt);
      if (!hit) {
        lost = true;
        break;
      }
      const path = writePath.get(`${u.device}|${u.table}|${hit.writtenAt}`);
      const seen = path ? downloads.get(`${device}|${path}`)?.find((t) => t >= hit.writtenAt) : undefined;
      const t = hit.at - u.at;
      const e = seen === undefined ? t : t - (seen - hit.writtenAt);
      total = total === null ? t : Math.max(total, t);
      excl = excl === null ? e : Math.max(excl, e);
    }
    if (lost) missed += 1;
    else if (!observers) alone += 1;
    else {
      totals.push(total);
      excluded.push(excl);
    }
  }
  return { measured: totals.length, missed, noObserver: alone, total: summarize(totals), excludingSync: summarize(excluded) };
}

/**
 * @param {object} input
 * @param {Array} input.log world.log
 * @param {object} input.endStats world.stats() after the final settle
 * @param {object} input.finalStats world.stats() at the very end
 * @param {Array} input.updates oracle entries
 * @param {Array} input.received {at, instance, table, from, writtenAt}
 * @param {Array} input.sessions {device, instance, start, end}
 * @param {object|null} input.newDevice {files, bytes, reachedOracle, ms}
 */
export function computeMetrics({ log, endStats, finalStats, updates, received, sessions, newDevice }) {
  const facts = logFacts(log);
  return {
    cloudFilesEnd: endStats.cloudFiles,
    cloudBytesEnd: endStats.cloudBytes,
    cloudFilesPeak: finalStats.peakCloudFiles,
    bytesWritten: finalStats.bytesWritten,
    bytesUploaded: finalStats.bytesUploaded,
    bytesByKind: facts.bytesByKind,
    largestFile: facts.largest,
    deletes: facts.deletes,
    snapshotsWritten: facts.snapshotsWritten,
    updates: updates.filter((u) => !u.lost).length,
    latency: computeLatency({ log, updates, received, sessions }),
    newDevice,
  };
}
