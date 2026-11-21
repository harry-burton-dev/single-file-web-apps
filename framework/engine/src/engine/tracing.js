// Sync tracing (ADR-0004 section 3, spec 2.7).
//
// One trace per sync attempt: { id, kind, device, user, startedAt, endedAt,
// durationMs, outcome, reason, detail?, tables, devices, counts, steps }.
// Traces hold paths, sizes, counts, names, times and error names only, never
// record content.
//
// Levels: "off" keeps no history and emits nothing (only the cheap counters
// metrics need); "summary" keeps counts but no per-file steps; "full" (default)
// also keeps the steps. The level never changes what the engine does or which
// folder operations it makes: every operation is recorded here as a side
// effect of the traced folder wrapper (traced-folder.js), nothing else.
//
// Time: startedAt/endedAt/step.at come from clock.now(); durations come from
// the injected monotonic timer.now() (0 when no timer is given).
//
// Persistence: finished traces are written to the local store in segments of
// `persistBatch` traces (one store write per batch, appended, never
// rewritten), and the oldest segments are deleted so at most about
// `storeLimit` traces remain. A restart reloads them. Routine traces (a
// scheduled scan or status write with outcome "ok" and no apply, delete or
// error) are kept in memory and emitted but never stored, so an idle device
// does not write to its store.

export const TRACE_LEVELS = Object.freeze(["off", "summary", "full"]);
const SEGMENT_PREFIX = "trace/seg/";
const STEP_CAP = 2000; // steps kept per trace in memory; counts stay exact
const PERSISTED_STEP_CAP = 100; // steps kept per trace in the store
const pad = (n) => String(n).padStart(9, "0");

// counts[action] counts completed steps; failed steps are counted in `errors`
// and lookups that found nothing in `missing`. bytesRead/bytesWritten are the
// bytes of the completed read and write steps.
const emptyCounts = () => ({ read: 0, write: 0, delete: 0, list: 0, stat: 0, skip: 0, apply: 0, missing: 0, bytesRead: 0, bytesWritten: 0, errors: 0 });

/** table, device and a short label for a folder path (relative to the workspace root). */
export function partsOfPath(path) {
  const p = String(path ?? "").split("/");
  if (p[0] === "data" && p.length >= 2) return { table: p[1], device: p.length >= 4 ? p[2] : null };
  if (p[0] === "status" && p.length === 2) return { table: null, device: p[1].replace(/\.ywb$/, "") };
  return { table: null, device: null };
}

/** A scheduled scan or status write that went fine and changed nothing: kept in memory, never stored. */
const isRoutine = (t) =>
  t.reason === "scheduled" && t.outcome === "ok" && (t.kind === "scan" || t.kind === "status") && !t.counts.apply && !t.counts.delete && !t.counts.errors;

export function createTracer({ clock, timer, store, deviceId, user, options, emit, onSample, onStoreError }) {
  let level = options.level;
  let nextId = 1;
  let nextSegment = 1;
  let ring = [];
  let batch = [];
  let segments = []; // [{ key, count }] oldest first
  let current = null;
  let untraced = 0;
  const sizeHints = new Map();
  const throughput = { filesRead: 0, bytesRead: 0, filesWritten: 0, bytesWritten: 0, filesDeleted: 0 };
  const now = () => (timer ? timer.now() : 0);

  function open(kind, reason, detail) {
    return {
      id: null, kind, device: deviceId, user, startedAt: clock.now(), endedAt: null, durationMs: 0, outcome: null, reason,
      ...(detail ? { detail } : {}), tables: [], devices: [], counts: emptyCounts(), steps: [], t0: now(), flagged: false, errorName: null,
    };
  }

  function deriveOutcome(trace) {
    if (!trace.counts.errors && !trace.flagged) return "ok";
    const worked = trace.counts.read + trace.counts.write + trace.counts.delete + trace.counts.list;
    return worked > 0 || trace.counts.stat > 0 ? "partial" : "failed";
  }

  function retain(trace) {
    ring.push(trace); // internal bounded buffers, mutated in place (hot path)
    if (ring.length > options.memoryLimit) ring.splice(0, ring.length - options.memoryLimit);
    if (!isRoutine(trace)) batch.push(trace);
    emit("trace", trace);
  }

  /** Close a trace: durations, outcome, history. Returns false when it was dropped. */
  function finish(trace, verdict, { discardIfEmpty = false } = {}) {
    const c = trace.counts;
    trace.endedAt = clock.now();
    trace.durationMs = Math.max(0, now() - trace.t0);
    const outcome = typeof verdict === "string" ? verdict : verdict?.outcome;
    if (verdict?.reason) trace.reason = verdict.reason;
    trace.outcome = outcome ?? deriveOutcome(trace);
    delete trace.t0;
    delete trace.flagged;
    delete trace.errorName;
    if (discardIfEmpty && trace.outcome === "ok" && c.read + c.write + c.delete + c.list + c.stat + c.apply === 0) return false;
    if (onSample && trace.outcome !== "skipped") onSample(trace.kind, trace.durationMs, trace.outcome);
    if (level === "off") return false;
    trace.id = nextId++;
    retain(trace);
    return true;
  }

  const tracer = {
    get level() {
      return level;
    },
    setLevel(next) {
      if (!TRACE_LEVELS.includes(next)) throw new Error(`bad trace level: ${next}`);
      level = next;
    },
    now,
    throughput,
    /** The size a delete of `path` will report when the folder has not shown it yet. */
    hintSize(path, size) {
      if (Number.isFinite(size)) sizeHints.set(path, size);
    },
    takeSizeHint(path) {
      const size = sizeHints.get(path);
      sizeHints.delete(path);
      return size;
    },
    get untraced() {
      return untraced;
    },

    /**
     * Run one attempt as one trace. `outcome(result, trace)` may return an
     * outcome string or { outcome, reason }; the default is derived from the
     * steps. A nested call just runs inside the outer trace.
     */
    async run(kind, reason, fn, opts = {}) {
      if (current) return fn();
      const trace = open(kind, reason, opts.detail);
      current = trace;
      let result;
      try {
        result = await fn();
      } catch (err) {
        current = null;
        finish(trace, "failed");
        throw err;
      }
      current = null;
      finish(trace, opts.outcome?.(result, trace), opts);
      return result;
    },

    /** A decision not to act (only called when there is pending work held back). */
    skipped(kind, reason, detail) {
      if (level === "off") return;
      const trace = open(kind, reason, detail);
      finish(trace, "skipped");
    },

    /** The attempt in progress saw an error that is not a failed folder step. */
    flagError() {
      if (current) current.flagged = true;
    },

    /** One folder or apply step of the attempt in progress. */
    step({ path, action, bytes = 0, durationMs = 0, result = "ok", error = null, count, table: tableArg }) {
      if (action === "read" && !error) {
        throughput.filesRead += 1;
        throughput.bytesRead += bytes;
      } else if (action === "write" && !error && result !== "created") {
        throughput.filesWritten += 1;
        throughput.bytesWritten += bytes;
      } else if (action === "delete" && !error && result !== "missing") {
        throughput.filesDeleted += 1;
      }
      if (!current) {
        untraced += 1;
        return;
      }
      if (level === "off") return;
      const c = current.counts;
      if (error) c.errors += 1;
      else if (result === "missing") c.missing += 1;
      else c[action] += 1;
      if (action === "read" && !error) c.bytesRead += bytes;
      if (action === "write" && !error) c.bytesWritten += bytes;
      const parsed = partsOfPath(path);
      const table = tableArg ?? parsed.table;
      if (table && !current.tables.includes(table)) current.tables.push(table);
      if (parsed.device && !current.devices.includes(parsed.device)) current.devices.push(parsed.device);
      if (level !== "full") return;
      if (current.steps.length >= STEP_CAP) {
        current.truncated = (current.truncated ?? 0) + 1;
        return;
      }
      const step = { at: clock.now(), table, path, action, bytes, durationMs, result, error };
      if (count !== undefined) step.count = count;
      current.steps.push(step);
    },

    /** Applying a file's updates to a table (or failing to). */
    apply({ table, path, count = 0, bytes = 0, error = null, result = error ? "failed" : "applied" }) {
      tracer.step({ path, action: "apply", bytes, result, error, count, table });
    },

    /** Newest first. */
    traces({ kind, outcome, table, device, limit } = {}) {
      const out = [];
      for (let i = ring.length - 1; i >= 0 && (limit === undefined || out.length < limit); i--) {
        const t = ring[i];
        if (kind && t.kind !== kind) continue;
        if (outcome && t.outcome !== outcome) continue;
        if (table && !t.tables.includes(table)) continue;
        if (device && t.device !== device && !t.devices.includes(device)) continue;
        out.push(t);
      }
      return out;
    },

    /** Write finished traces not yet stored; keeps the stored history bounded. */
    async persist({ force = false } = {}) {
      if (!store || !batch.length || (!force && batch.length < options.persistBatch)) return;
      const slice = batch;
      batch = [];
      const key = `${SEGMENT_PREFIX}${pad(nextSegment++)}`;
      const lean = slice.map((t) => (t.steps.length > PERSISTED_STEP_CAP ? { ...t, steps: t.steps.slice(0, PERSISTED_STEP_CAP), truncated: (t.truncated ?? 0) + t.steps.length - PERSISTED_STEP_CAP } : t));
      try {
        await store.set(key, lean);
        segments = [...segments, { key, count: slice.length }];
        let total = segments.reduce((n, s) => n + s.count, 0);
        while (segments.length > 1 && total - segments[0].count >= options.storeLimit) {
          await store.delete(segments[0].key);
          total -= segments[0].count;
          segments = segments.slice(1);
        }
      } catch (err) {
        onStoreError?.(err);
      }
    },

    /** Reload the stored history (called once, before the first attempt). */
    async load() {
      if (!store) return;
      try {
        const keys = await store.keys(SEGMENT_PREFIX);
        const loaded = [];
        for (const key of keys) {
          const list = (await store.get(key)) ?? [];
          segments = [...segments, { key, count: list.length }];
          loaded.push(...list);
          nextSegment = Math.max(nextSegment, Number(key.slice(SEGMENT_PREFIX.length)) + 1);
        }
        loaded.sort((a, b) => a.id - b.id);
        const kept = loaded.slice(-Math.min(options.storeLimit, options.memoryLimit));
        ring = kept;
        nextId = Math.max(1, ...loaded.map((t) => t.id + 1));
      } catch (err) {
        onStoreError?.(err);
      }
    },
  };
  return tracer;
}
