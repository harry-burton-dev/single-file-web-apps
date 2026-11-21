// Property checkers (spec section 1). Each returns a list of violations:
//   { property, at, device?, table?, path?, message }
// `at` is simulated milliseconds (clock.now()). The functions take plain data
// (JSON views, log entries, byte maps) so they can be unit tested on tiny
// hand-built cases; the scenario feeds them from the running simulation.
//
// Implemented here: P1 convergence, P2 oracle equality, P3 containment after a
// crash, P4 compaction safety (live, per delete), P8 single writer, P9
// pacing and progress, P11 digest agreement, P12 determinism. P7 (tolerance)
// is collected by the scenario, which wraps every engine call. P5/P6 have no
// separate checker: they are the actions "offline for a long time", "wipe" and
// "empty folder" followed by P1/P2. P10 lives in conflicts.js.
import { open as openEnvelope } from "../engine/envelope.js";
import { chunkId } from "../engine/coverage.js";

export const violation = (property, fields) => ({ property, ...fields });

// ---- display helpers -------------------------------------------------------

const SEP = "\u001f";
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => {
  if (v === undefined) return "<missing>";
  const s = JSON.stringify(v);
  return (s.length > 70 ? `${s.slice(0, 67)}...` : s).replaceAll(SEP, "|");
};

/** Up to `limit` differing paths between two JSON values, as short strings. */
export function summarizeDiff(expected, actual, limit = 4) {
  const out = [];
  let total = 0;
  const walk = (path, a, b) => {
    if (isPlain(a) && isPlain(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(`${path}/${key.replaceAll(SEP, "|")}`, a[key], b[key]);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      total += 1;
      if (out.length < limit) out.push(`${path || "/"}: expected ${show(a)} actual ${show(b)}`);
    }
  };
  walk("", expected, actual);
  return total > out.length ? `${out.join("; ")}; ... ${total} differences in all` : out.join("; ");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- P1, P2 ----------------------------------------------------------------

/** P1: views = { deviceId: { table: json } }. All devices equal for every table. */
export function checkConvergence(views, { at = 0 } = {}) {
  const out = [];
  const devices = Object.keys(views).sort();
  if (devices.length < 2) return out;
  const tables = [...new Set(devices.flatMap((d) => Object.keys(views[d])))].sort();
  for (const table of tables) {
    const reference = devices[0];
    for (const device of devices.slice(1)) {
      if (!same(views[reference][table], views[device][table])) {
        out.push(violation("P1", {
          at, device, table,
          message: `${device} differs from ${reference} in table ${table}: ${summarizeDiff(views[reference][table], views[device][table])}`,
        }));
      }
    }
  }
  return out;
}

/** P2: every device equals the oracle. */
export function checkOracle(views, oracleJson, { at = 0 } = {}) {
  const out = [];
  for (const device of Object.keys(views).sort()) {
    for (const table of Object.keys(oracleJson).sort()) {
      if (!same(oracleJson[table], views[device][table])) {
        out.push(violation("P2", {
          at, device, table,
          message: `${device} differs from the oracle in table ${table}: ${summarizeDiff(oracleJson[table], views[device][table])}`,
        }));
      }
    }
  }
  return out;
}

// ---- P3 --------------------------------------------------------------------

/**
 * P3: a document restored after a crash must contain every update the device
 * had accepted. Containment test: merging the updates into a copy of the
 * restored document must not change it.
 */
export function checkContainment({ adapter, restored, updates, device, table, at = 0 }) {
  const copy = adapter.create();
  adapter.applyUpdate(copy, adapter.snapshot(restored), "p3");
  const before = adapter.toJSON(copy);
  for (const bytes of updates) adapter.applyUpdate(copy, bytes, "p3");
  const after = adapter.toJSON(copy);
  if (same(before, after)) return [];
  return [violation("P3", {
    at, device, table,
    message: `after a crash and reopen ${device} lost accepted updates in ${table}: ${summarizeDiff(after, before)}`,
  })];
}

// ---- P8 --------------------------------------------------------------------

/** Is `path` one of the device's own paths? */
export function isOwnPath(path, deviceId) {
  const parts = path.split("/");
  if (parts[0] === "status") return parts.length === 2 && parts[1] === `${deviceId}.ywb`;
  return parts[0] === "data" && parts.length >= 4 && parts[2] === deviceId;
}

/**
 * P8: scan log[from..to). Every "write" and "delete" entry must be inside the
 * acting device's own paths. `ignore(index)` skips harness-made writes.
 */
export function checkSingleWriter(log, { from = 0, to = log.length, ignore = () => false, shared = false } = {}) {
  if (shared) return [];
  const out = [];
  for (let i = from; i < to; i++) {
    const e = log[i];
    if ((e.type !== "write" && e.type !== "delete") || ignore(i)) continue;
    if (!isOwnPath(e.path, e.device)) {
      out.push(violation("P8", { at: e.t, device: e.device, path: e.path, message: `${e.device} did a ${e.type} on ${e.path}, outside its own paths` }));
    }
  }
  return out;
}

// ---- P9 --------------------------------------------------------------------

/**
 * P9 pacing: a save that was NOT forced (flush/close) must be at least
 * minIntervalMs after the previous save of the same engine instance.
 * saves: [{ device, instance, at, forced }] in order of occurrence.
 */
export function checkPacing(saves, { minIntervalMs }) {
  const out = [];
  const byInstance = new Map();
  for (const s of saves) {
    const list = byInstance.get(s.instance) ?? [];
    const last = list[list.length - 1];
    if (last && last.at === s.at) last.forced ||= s.forced; // several tables, one save
    else list.push({ device: s.device, at: s.at, forced: s.forced });
    byInstance.set(s.instance, list);
  }
  for (const list of byInstance.values()) {
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].at - list[i - 1].at;
      if (!list[i].forced && gap < minIntervalMs) {
        out.push(violation("P9", { at: list[i].at, device: list[i].device, message: `timed saves ${gap} ms apart, minimum is ${minIntervalMs} ms` }));
      }
    }
  }
  return out;
}

/**
 * P9 progress (only meaningful without faults): an update reaches the folder
 * within maxWaitMs + minIntervalMs (+ tickMs, because the host ticks in steps).
 * An update never saved although its engine instance is still live at `endAt`
 * counts too. Updates whose engine instance ended unsaved are skipped.
 */
export function checkProgress(updates, { maxWaitMs, minIntervalMs, tickMs, endAt, liveInstances = new Set() }) {
  const bound = maxWaitMs + minIntervalMs + tickMs;
  const out = [];
  for (const u of updates) {
    if (u.lost) continue;
    if (u.saved && u.savedInstance === u.instance) {
      if (u.savedAt - u.at > bound) {
        out.push(violation("P9", { at: u.savedAt, device: u.device, table: u.table, message: `update made at ${u.at} reached the folder after ${u.savedAt - u.at} ms (bound ${bound} ms)` }));
      }
    } else if (!u.saved && liveInstances.has(u.instance) && endAt - u.at > bound) {
      out.push(violation("P9", { at: endAt, device: u.device, table: u.table, message: `update made at ${u.at} was still not in the folder ${endAt - u.at} ms later (bound ${bound} ms)` }));
    }
  }
  return out;
}

// ---- P11 -------------------------------------------------------------------

/**
 * P11: statuses = [{ device, tables: { table: { applied, digest } } }] (decoded
 * status files); actual = { device: { table: digest } } computed from the live
 * documents. Two devices reporting the same applied state must report the same
 * digest; and (after everything has settled) a device's reported digest must
 * be the digest of its document.
 */
export function checkDigests(statuses, actual = {}, { at = 0 } = {}) {
  const out = [];
  const groups = new Map();
  for (const s of statuses) {
    for (const [table, t] of Object.entries(s.tables ?? {})) {
      const key = `${table}|${JSON.stringify(t.applied)}`;
      const group = groups.get(key) ?? [];
      group.push({ device: s.device, digest: t.digest });
      groups.set(key, group);
      const mine = actual[s.device]?.[table];
      if (mine !== undefined && t.digest !== mine) {
        out.push(violation("P11", { at, device: s.device, table, message: `status of ${s.device} reports digest ${String(t.digest).slice(0, 12)} but its table ${table} hashes to ${mine.slice(0, 12)}` }));
      }
    }
  }
  for (const [key, group] of groups) {
    if (new Set(group.map((g) => g.digest)).size > 1) {
      const table = key.slice(0, key.indexOf("|"));
      out.push(violation("P11", { at, table, message: `devices ${group.map((g) => g.device).join(", ")} report the same applied state for ${table} but different digests` }));
    }
  }
  return out;
}

// ---- P12 -------------------------------------------------------------------

/** P12: two runs of the same seed and configuration. */
export function checkDeterminism(a, b) {
  const out = [];
  if (a.traceHash !== b.traceHash) {
    out.push(violation("P12", { at: 0, message: `trace hash differs between two runs of the same seed (${a.traceHash.slice(0, 12)} vs ${b.traceHash.slice(0, 12)})` }));
  }
  if (a.content !== b.content) {
    out.push(violation("P12", { at: 0, message: "final content differs between two runs of the same seed" }));
  }
  return out;
}

// ---- P4 --------------------------------------------------------------------

const CHUNK_PATH = /^data\/([^/]+)\/([^/]+)\/(\d{6})(-.+)?\.ywb$/;
const SNAP_PATH = /^data\/([^/]+)\/([^/]+)\/(snap-(\d{8}T\d{6}Z)(-.+)?\.ywb)$/;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

function stampMs(stamp) {
  const n = (a, b) => Number(stamp.slice(a, b));
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(9, 11), n(11, 13), n(13, 15));
}

const dominates = (newer, older) => Object.entries(older ?? {}).every(([d, seq]) => (newer?.[d] ?? 0) >= seq);

/**
 * P4 checker. `check({ device, path, now, cloud, local })` validates ONE delete
 * of `path` by `device`, given the folder state at that moment: `cloud` and
 * `local` (the deleter's own view) are Maps path -> bytes. Rules (spec P4):
 *   - the deleter is the writer (the path is in its own folder);
 *   - a snapshot that covers the file exists in the cloud or on the deleter,
 *     both by its metadata and (deep) by content: merging the deleted file
 *     into the snapshot changes nothing;
 *   - that snapshot is at least minSnapshotAgeMs old;
 *   - every active device whose status file the deleter can see lists it.
 * The acknowledgement rule always demands all-active, even for the ack-none
 * variant: that variant is expected to break it.
 * Deleting a snapshot needs a newer snapshot that dominates its coverage.
 */
export function createCompactionChecker({ keys, options, adapters, deep = true }) {
  const cache = new Map();
  const c = options.compaction;

  async function decode(path, bytes) {
    const key = `${path}|${bytes.length}|${hex(bytes.subarray(5, 17))}`;
    if (cache.has(key)) return cache.get(key);
    let value = null;
    try {
      value = await openEnvelope({ keys, bytes });
    } catch {
      value = null;
    }
    cache.set(key, value);
    if (cache.size > 4000) cache.delete(cache.keys().next().value);
    return value;
  }

  function contains(adapterName, bigUpdates, smallUpdates) {
    const adapter = adapters[adapterName];
    const doc = adapter.create();
    for (const u of bigUpdates) adapter.applyUpdate(doc, u, "p4");
    const before = adapter.toJSON(doc);
    for (const u of smallUpdates) adapter.applyUpdate(doc, u, "p4");
    return same(before, adapter.toJSON(doc));
  }

  async function activeStatuses({ local, now, device, table }) {
    const out = [];
    for (const [path, bytes] of local) {
      if (!path.startsWith("status/") || !path.endsWith(".ywb")) continue;
      const parsed = await decode(path, bytes);
      const m = parsed?.meta;
      if (m?.kind !== "status" || m.device === device) continue;
      if (m.lastActiveAt >= now - c.activeWindowMs && m.tables?.[table]) out.push(m);
    }
    return out;
  }

  async function snapshotsOf(table, files) {
    const out = [];
    for (const [path, bytes] of files) {
      const m = SNAP_PATH.exec(path);
      if (!m || m[1] !== table) continue;
      const parsed = await decode(path, bytes);
      if (parsed?.meta?.kind !== "snapshot") continue;
      out.push({ path, device: m[2], name: m[3], stampMs: stampMs(m[4]), meta: parsed.meta, updates: parsed.updates });
    }
    return out;
  }

  async function remainingChunkUpdates(table, files, except) {
    const out = [];
    for (const [path, bytes] of files) {
      const m = CHUNK_PATH.exec(path);
      if (!m || m[1] !== table || path === except) continue;
      const parsed = await decode(path, bytes);
      if (parsed?.meta?.kind === "chunk") out.push(...parsed.updates);
    }
    return out;
  }

  // Why would candidate snapshot `s` not justify deleting? Returns reasons ([] = fine).
  function whyNot(s, { now, table, statuses }) {
    const reasons = [];
    if (now - s.stampMs < c.minSnapshotAgeMs) reasons.push(`snapshot ${s.device}/${s.name} is only ${now - s.stampMs} ms old (minimum ${c.minSnapshotAgeMs} ms)`);
    for (const m of statuses) {
      if (!m.tables[table].snapshots?.includes(`${s.device}/${s.name}`)) reasons.push(`active device ${m.device} has not acknowledged ${s.device}/${s.name} (its status in the deleter's view was written ${now - m.writtenAt} ms ago and lists ${m.tables[table].snapshots?.length ?? 0} snapshots)`);
    }
    return reasons;
  }

  return {
    async check({ device, path, now, cloud, local }) {
      const out = [];
      const fail = (message) => out.push(violation("P4", { at: now, device, path, message }));
      const chunk = CHUNK_PATH.exec(path);
      const snap = SNAP_PATH.exec(path);
      if (!chunk && !snap) {
        fail(`${device} deleted ${path}, which is neither a chunk nor a snapshot`);
        return out;
      }
      const table = (chunk ?? snap)[1];
      const writer = (chunk ?? snap)[2];
      if (writer !== device) {
        fail(`${device} deleted a file written by ${writer}`);
        return out;
      }
      const union = new Map([...cloud, ...local]);
      const snapshots = (await snapshotsOf(table, union)).filter((s) => s.path !== path);
      const statuses = await activeStatuses({ local, now, device, table });
      const ownBytes = local.get(path) ?? cloud.get(path);
      const target = ownBytes ? await decode(path, ownBytes) : null;

      let candidates;
      if (chunk) {
        const seq = Number(chunk[3]);
        // covered by identity, as the engine requires: the snapshot lists this exact version (a conflict copy goes with its primary)
        const primaryPath = `data/${table}/${device}/${chunk[3]}.ywb`;
        const versionBytes = chunk[4] ? (local.get(primaryPath) ?? cloud.get(primaryPath) ?? ownBytes) : ownBytes;
        const id = versionBytes ? chunkId(versionBytes) : null;
        candidates = snapshots.filter((s) => (s.meta.covers?.[device] ?? 0) >= seq && id !== null && s.meta.ids?.[device]?.[seq] === id);
        if (!candidates.length) {
          fail(`no snapshot in the cloud or on ${device} covers ${path} (chunk ${seq}, version ${id}) by number and identity; snapshots present: ${snapshots.map((s) => `${s.device}/${s.name}`).join(", ") || "none"}`);
          return out;
        }
      } else {
        const stamp = stampMs(snap[4]);
        candidates = snapshots.filter((s) => s.stampMs > stamp && dominates(s.meta.covers, target?.meta?.covers));
        if (!candidates.length) {
          fail(`no newer snapshot dominates the deleted snapshot ${path}`);
          return out;
        }
      }
      const verdicts = [];
      for (const s of candidates) {
        const reasons = whyNot(s, { now, table, statuses });
        if (!reasons.length && deep && target?.updates?.length) {
          const adapterName = s.meta.adapter;
          // A deleted snapshot may also hold content of other writers' still-open
          // chunks (not "covered" yet); that content survives in those chunk
          // files, so for snapshots the replacement is the newer snapshot PLUS
          // every chunk file that is still there.
          const big = chunk ? s.updates : [...s.updates, ...(await remainingChunkUpdates(table, union, path))];
          if (adapters[adapterName] && !contains(adapterName, big, target.updates)) {
            reasons.push(`snapshot ${s.device}/${s.name} claims coverage but ${chunk ? "does not contain" : "together with the remaining chunks does not contain"} the content of ${path}`);
          }
        }
        if (!reasons.length) return out; // a good snapshot exists
        verdicts.push(...reasons);
      }
      fail(`delete of ${path} not justified: ${[...new Set(verdicts)].slice(0, 4).join("; ")}`);
      return out;
    },
  };
}

// ---- P13 -------------------------------------------------------------------

/**
 * P13 (paths): every "write" and "delete" entry of the simulator log made by an
 * engine falls inside exactly one successful trace step with the same device,
 * action, path and byte count, and every successful write or delete step has
 * exactly one such log entry. Deletes are matched on device, path and time
 * only: the engine cannot learn a file's size without reading it (which would
 * change what it does), so a delete step carries the size it last knew, and
 * the file may since have been replaced by another version of different size.
 *   entries: log entries { t, type, device, path, size } (engine operations only)
 *   traces:  engine traces with steps (trace level "full")
 */
export function checkAttribution({ entries, traces, at = 0 }) {
  const out = [];
  const pools = new Map();
  for (const trace of traces) {
    for (const s of trace.steps ?? []) {
      if ((s.action !== "write" && s.action !== "delete") || s.error || s.result === "missing") continue;
      const key = `${trace.device}|${s.action}|${s.path}|${s.action === "delete" ? "*" : s.bytes}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push({ trace: trace.id, start: trace.startedAt, end: trace.endedAt, used: false });
    }
  }
  for (const e of entries) {
    const slot = pools.get(`${e.device}|${e.type}|${e.path}|${e.type === "delete" ? "*" : e.size}`)?.find((x) => !x.used && x.start <= e.t && e.t <= x.end);
    if (slot) slot.used = true;
    else out.push(violation("P13", { at: e.t, device: e.device, path: e.path, message: `${e.device} did a ${e.type} of ${e.path} (${e.size} bytes) at ${e.t} that is in no trace step` }));
  }
  for (const [key, list] of pools) {
    const [device, action, path, bytes] = key.split("|");
    for (const slot of list) {
      if (!slot.used) out.push(violation("P13", { at: slot.end ?? at, device, path, message: `trace ${slot.trace} records a ${action} of ${path} (${bytes} bytes) that is not in the folder log` }));
    }
  }
  return out;
}

/**
 * P13 (totals, any detail level above "off"): what the traces counted equals
 * what the simulator counted for the device. totals and counters:
 * { reads, filesRead, bytesRead, writes, bytesWritten }.
 */
export function checkTraceTotals({ device, totals, counters, at = 0 }) {
  const out = [];
  for (const field of ["reads", "filesRead", "bytesRead", "writes", "bytesWritten"]) {
    if (totals[field] !== counters[field]) {
      out.push(violation("P13", { at, device, message: `${device}: traces account for ${totals[field]} ${field}, the simulator counted ${counters[field]}` }));
    }
  }
  return out;
}

/** Add one trace's counts to a device's running totals (returns a new object). */
export function addTraceTotals(totals, trace) {
  const c = trace.counts;
  return {
    reads: totals.reads + c.read + c.stat,
    filesRead: totals.filesRead + c.read,
    bytesRead: totals.bytesRead + c.bytesRead,
    writes: totals.writes + c.write,
    bytesWritten: totals.bytesWritten + c.bytesWritten,
  };
}

export const emptyTraceTotals = () => ({ reads: 0, filesRead: 0, bytesRead: 0, writes: 0, bytesWritten: 0 });

// ---- P14 -------------------------------------------------------------------

const HEALTH_STATES = ["saved", "saving", "retrying", "folder-disconnected", "not-reaching-peers", "offline"];

/**
 * P14: one engine's health() at one moment.
 *   health    the engine's health() report
 *   lastSave  { outcome, failed } of its latest save trace that was not skipped, or null;
 *             failed: a table could not be written in that save (the engine raised a "save" error)
 *   level     trace level (the "retrying" rule needs traces)
 *   allowed   states that can have a cause here (the simulator never sets
 *             offline and never denies folder access)
 */
export function checkHealth({ health, device, at = 0, lastSave = null, level = "full", ackTimeoutMs, allowed = ["saved", "saving", "retrying", "not-reaching-peers"] }) {
  const out = [];
  const fail = (message) => out.push(violation("P14", { at, device, message: `${device} reports ${health.state}: ${message}` }));
  const { state, pending } = health;
  if (!HEALTH_STATES.includes(state)) fail("not a known state");
  else if (!allowed.includes(state)) fail("no cause for this state exists in this run");
  if ((state === "saved" || state === "not-reaching-peers") && pending > 0) fail(`${pending} updates are still pending`);
  if ((state === "saved" || state === "not-reaching-peers") && health.repairing) fail("an own file is still owed to the folder");
  if (state === "saving" && pending === 0 && !health.repairing) fail("nothing is pending and no own file is owed to the folder");
  if (state === "retrying" && level !== "off" && (!lastSave || lastSave.outcome === "ok")) {
    fail(`its last save ${lastSave ? "succeeded" : "was never attempted"}`);
  }
  // and the other way round: while the last save has failed and its updates are still waiting, a retry is scheduled
  if (lastSave?.failed && pending > 0 && state !== "retrying" && allowed.includes("retrying")) fail("its last save failed and updates are still pending, so it should be retrying");
  const active = Object.entries(health.peers ?? {}).filter(([, p]) => p.active);
  const silentFor = active.map(([, p]) => (p.ackedLatest === false && p.waitingSince != null ? at - p.waitingSince : null));
  const allSilent = active.length > 0 && silentFor.every((ms) => ms != null && ms > ackTimeoutMs);
  if (state === "not-reaching-peers" && !allSilent) {
    fail(active.length ? "an active peer has acknowledged our latest chunk or has not waited past the timeout" : "no peer is active");
  }
  if (state === "saved" && allSilent) fail(`no active peer acknowledged our latest chunk for over ${ackTimeoutMs} ms`);
  return out;
}

// ---- P16 -------------------------------------------------------------------

const MAGIC_LENGTH = 4;
const IV_START = 5;
const IV_END = 17;
const TAG_BYTES = 16;

/**
 * P16: AES-GCM must never see one IV twice under one key with different
 * content. record() takes every envelope written (any bytes that are too short
 * to be one are ignored) and returns the violations it causes: the same key id
 * and IV seen before with a different authentication tag (the tag of an
 * identical re-write is identical, which is no reuse).
 */
export function createIvTracker() {
  const seen = new Map();
  return {
    record({ bytes, path, device, at = 0 }) {
      if (bytes.length < IV_END + TAG_BYTES || hex(bytes.subarray(0, MAGIC_LENGTH)) !== "45415731") return [];
      const id = `${bytes[4]}:${hex(bytes.subarray(IV_START, IV_END))}`;
      const tag = hex(bytes.subarray(bytes.length - TAG_BYTES));
      const first = seen.get(id);
      if (first === undefined) {
        seen.set(id, { tag, path });
        return [];
      }
      if (first.tag === tag) return [];
      return [violation("P16", { at, device, path, message: `${device} wrote ${path} with an IV already used for different content in ${first.path} (key ${bytes[4]}, IV ${id.split(":")[1]})` })];
    },
  };
}

// ---- P15 -------------------------------------------------------------------

/** P15: two runs of one seed, differing only in trace level. */
export function checkObservation(a, b, { levels = ["?", "?"] } = {}) {
  const out = [];
  if (a.traceHash !== b.traceHash) {
    out.push(violation("P15", { at: 0, message: `trace hash differs between trace levels ${levels[0]} and ${levels[1]} (${a.traceHash.slice(0, 12)} vs ${b.traceHash.slice(0, 12)})` }));
  }
  if (a.content !== b.content) {
    out.push(violation("P15", { at: 0, message: `final content differs between trace levels ${levels[0]} and ${levels[1]}` }));
  }
  return out;
}
