// Metrics (ADR-0004 section 4). A collector fed by the engine's own events and
// a builder that assembles the report from it and from engine state. Samples
// are kept whatever the trace level is, so metrics work with tracing off.
import { peerView } from "./health.js";

const SET_CAP = 10000;
const COPY_PATHS_SHOWN = 50;

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function durationStats(samples) {
  if (!samples.length) return { count: 0, lastMs: null, avgMs: null, p95Ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, lastMs: samples[samples.length - 1], avgMs: samples.reduce((n, x) => n + x, 0) / samples.length, p95Ms: percentile(sorted, 0.95) };
}

function lagStats(samples) {
  if (!samples.length) return { count: 0, lastMs: null, medianMs: null, p95Ms: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, lastMs: samples[samples.length - 1], medianMs: median(sorted), p95Ms: percentile(sorted, 0.95) };
}

const bump = (map, key) => ({ ...map, [key]: (map[key] ?? 0) + 1 });

/** Keep a Set from growing without bound: forget the oldest entry. */
function addCapped(set, value) {
  set.add(value);
  if (set.size > SET_CAP) set.delete(set.values().next().value);
}

export function createMetrics({ limit }) {
  const durations = {}; // kind -> recent attempt durations (not skipped)
  const delivery = [];
  const copies = new Set();
  const mismatches = new Set();
  const askOpen = new Set();
  const state = { errors: { total: 0, byScope: {}, byName: {} }, askOpened: 0, askResolved: 0, overlap: 0 };
  const push = (list, value) => {
    list.push(value);
    if (list.length > limit) list.splice(0, list.length - limit);
  };
  return {
    state,
    durations,
    delivery,
    copies,
    mismatches,
    askOpen,
    sample(kind, ms) {
      push((durations[kind] ??= []), ms);
    },
    delivered(lagMs) {
      push(delivery, lagMs);
    },
    error(scope, name) {
      state.errors = { total: state.errors.total + 1, byScope: bump(state.errors.byScope, scope), byName: bump(state.errors.byName, name) };
    },
    copySeen: (path) => addCapped(copies, path),
    mismatch: (key) => addCapped(mismatches, key),
    /** The record layer or app reports what the engine cannot see: ask conflicts and overlap notices. */
    noteConflict({ type, table, id, field } = {}) {
      const key = `${table}|${id}|${field}`;
      if (type === "ask-opened") {
        state.askOpened += 1;
        addCapped(askOpen, key);
      } else if (type === "ask-resolved") {
        state.askResolved += 1;
        askOpen.delete(key);
      } else if (type === "overlap") {
        state.overlap += 1;
      } else {
        throw new Error(`noteConflict: unknown type ${type} (ask-opened, ask-resolved, overlap)`);
      }
    },
  };
}

export function buildMetrics(ctx) {
  const { rt, cfg, metrics: m, tracer } = ctx;
  const now = cfg.clock.now();
  const tables = [...ctx.tables.values()];
  const pending = tables.flatMap((T) => T.pending);
  const ackLag = {};
  for (const [device, view] of Object.entries(peerView(ctx))) {
    ackLag[device] = {
      lastAckedAt: view.lastAckedAt,
      lagMs: view.lastAckedAt == null ? null : now - view.lastAckedAt,
      unackedForMs: view.waitingSince == null ? null : now - view.waitingSince,
    };
  }
  return {
    at: now,
    startedAt: rt.startedAt,
    sync: { save: durationStats(m.durations.save ?? []), scan: durationStats(m.durations.scan ?? []) },
    backlog: {
      pendingCount: pending.length,
      pendingBytes: pending.reduce((n, e) => n + e.bytes.length, 0),
      oldestAgeMs: pending.length ? now - Math.min(...pending.map((e) => e.at)) : null,
      unreadableFiles: tables.reduce((n, T) => n + T.unreadable.length, 0) + rt.statusUnreadable.length,
    },
    retry: { backingOff: rt.retryAt != null, since: rt.retryAt != null ? rt.retrySince : null, nextAttemptAt: rt.retryAt, failures: rt.failures },
    throughput: { ...tracer.throughput },
    deliveryLag: lagStats(m.delivery),
    ackLag,
    conflicts: {
      copiesSeen: m.copies.size,
      copyPaths: [...m.copies].slice(-COPY_PATHS_SHOWN),
      digestMismatches: m.mismatches.size,
      sizeAnomalies: tables.reduce((n, T) => n + T.sizeAnomalies.size, 0),
      askOpened: m.state.askOpened,
      askResolved: m.state.askResolved,
      askOpen: m.askOpen.size,
      overlapNotices: m.state.overlap,
    },
    errors: { ...m.state.errors },
    untracedOperations: tracer.untraced,
  };
}
