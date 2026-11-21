// The sync engine core (spec 2.5). No timers, no clocks, no randomness of its
// own: the host calls tick() and everything due is decided from clock.now().
//
// Concurrency model: local updates arrive synchronously from the adapter and
// are persisted through an ordered chain (localChain). Every public operation
// runs exclusively (opChain), first waits for that chain to drain, and drains
// it again before resolving, so nothing keeps running after a promise settles.
//
// Observability (spec 2.7): every attempt (save, scan, status write,
// compaction pass, reseed) runs as one trace; the folder handle given to the
// layouts is the traced wrapper, so all folder I/O is attributed in one place.
import { NAME_RE } from "./constants.js";
import { resolveOptions } from "./options.js";
import { createLayout } from "./layout.js";
import { restoreTable, addPending, logUpdates } from "./local-state.js";
import { scanAll } from "./scanner.js";
import { saveAll, saveDecisionNow, pendingBounds } from "./saver.js";
import { writeStatusFile, loadStatusSeen } from "./status-files.js";
import { createTracer } from "./tracing.js";
import { traceFolder } from "./traced-folder.js";
import { buildMetrics, createMetrics } from "./metrics.js";
import { refreshHealth } from "./health.js";
import { clampStoredTimes } from "./clock-guard.js";

const describe = (error) => ({ name: error?.name ?? "Error", message: String(error?.message ?? error) });

// Save decisions that hold back pending work and are worth a "skipped" trace.
const HELD_BACK = new Set(["backoff", "min-interval"]);

function createEmitter() {
  const listeners = new Map();
  return {
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) {
        try {
          fn(payload);
        } catch {
          // a listener's failure must not break the engine
        }
      }
    },
  };
}

function validate(cfg) {
  for (const field of ["root", "clock", "random", "store", "key", "adapters", "tables", "deviceId"]) {
    if (!cfg[field]) throw new Error(`createEngine: missing ${field}`);
  }
  for (const [table, adapterName] of Object.entries(cfg.tables)) {
    if (!NAME_RE.test(table)) throw new Error(`bad table name: ${table}`);
    if (!cfg.adapters[adapterName]) throw new Error(`table ${table}: unknown adapter ${adapterName}`);
  }
  if (!NAME_RE.test(cfg.deviceId)) throw new Error(`bad deviceId: ${cfg.deviceId}`);
}

function buildContext(input) {
  validate(input);
  const options = resolveOptions(input.options);
  const emitter = createEmitter();
  const user = input.user ?? input.deviceId.split("-")[0];
  const clock = input.clock;
  const rt = {
    lastSaveAt: null, lastScanAt: null, lastScanOkAt: null, lastStatusAt: null, retryAt: null, retrySince: null, failures: 0,
    errors: [], statuses: new Map(), statusSeen: {}, statusUnreadable: [], closed: false,
    localChain: Promise.resolve(), opChain: Promise.resolve(),
    startedAt: clock.now(), offline: false, folder: { fault: null }, written: {}, acks: new Map(), health: null,
    skipNoted: new Set(), lastSave: null, lastScan: null, selfStatus: null,
  };
  const metrics = createMetrics({ limit: options.trace.memoryLimit });
  // Extra keys to read with, so old chunks stay readable after a rotation; writing always uses key and keyId.
  const readKeys = input.keys instanceof Map ? [...input.keys] : Object.entries(input.keys ?? {}).map(([id, k]) => [Number(id), k]);
  const ctx = {
    cfg: null, rt, tables: new Map(), emit: emitter.emit, on: emitter.on, metrics,
    keys: new Map([...readKeys, [input.keyId ?? 0, input.key]]),
    recordError(scope, error, extra = {}) {
      const entry = { at: clock.now(), scope, ...describe(error), ...extra };
      rt.errors = [...rt.errors, entry].slice(-options.maxErrors);
      metrics.error(scope, entry.name);
      ctx.tracer.flagError();
      emitter.emit("error", { ...entry, error });
    },
  };
  ctx.tracer = createTracer({
    clock, timer: input.timer, store: input.store, deviceId: input.deviceId, user, options: options.trace, emit: emitter.emit,
    onSample: metrics.sample, onStoreError: (err) => ctx.recordError("trace-store", err),
  });
  const root = traceFolder(input.root, { tracer: ctx.tracer, folder: rt.folder, clock });
  ctx.cfg = { ...input, root, keyId: input.keyId ?? 0, user, options };
  ctx.layout = createLayout(ctx);
  // Listeners given up front also see what happens while the engine starts (its first scan).
  for (const [event, fn] of Object.entries(input.listeners ?? {})) ctx.on(event, fn);
  // What the engine learns from its own events: delivery lag, and which chunk of ours was written when.
  ctx.on("received", (ev) => {
    if (Number.isFinite(ev.writtenAt)) metrics.delivered(clock.now() - ev.writtenAt);
  });
  ctx.on("saved", (ev) => {
    if (ev.seq == null) return;
    const previous = rt.written[ev.table];
    rt.written = { ...rt.written, [ev.table]: previous?.seq === ev.seq ? previous : { seq: ev.seq, firstAt: ev.at } };
  });
  return ctx;
}

function subscribeLocal(ctx, T) {
  const { rt, cfg } = ctx;
  return T.adapter.onLocalUpdate(T.doc, (bytes) => {
    const entry = { bytes: bytes.slice(), persisted: false, at: cfg.clock.now(), key: null };
    T.pending = [...T.pending, entry];
    refreshHealth(ctx);
    rt.localChain = rt.localChain.then(async () => {
      // "A change is durable once the engine has accepted it" (test spec P3): accepted = the pending write is in the store.
      if (await addPending(ctx, T, entry)) ctx.emit("accepted", { table: T.name });
      try {
        await logUpdates(ctx, T, [entry.bytes]);
      } catch (err) {
        ctx.recordError("store", err, { table: T.name });
      }
    });
  });
}

async function initTable(ctx, name, adapterName) {
  const adapter = ctx.cfg.adapters[adapterName];
  const now = ctx.cfg.clock.now();
  const restored = await restoreTable({ store: ctx.cfg.store, adapter, table: name, onError: (e) => ctx.recordError("restore", e, { table: name }) });
  const T = {
    name, adapterName, adapter, doc: restored.doc,
    pending: restored.pending.map((e) => ({ ...e, at: now })),
    pendSeq: restored.pendSeq, updSeq: restored.updSeq, updSinceSnap: restored.updSinceSnap,
    idx: restored.idx.repair === "open" ? { ...restored.idx, repair: "full" } : restored.idx, idxDirty: false, hw: restored.hw,
    open: { seq: restored.hw + 1, updates: [], prev: null },
    listing: { files: [], errors: [] }, unreadable: [], sizeAnomalies: new Set(), compactAt: null, compactRetryAt: null,
  };
  T.unsub = subscribeLocal(ctx, T);
  ctx.tables.set(name, T);
  if (T.pending.length) {
    try {
      await logUpdates(ctx, T, T.pending.map((e) => e.bytes)); // so the next restart still has them in the doc once the pending copies are written out
    } catch (err) {
      ctx.recordError("store", err, { table: name });
    }
  }
  return T;
}

function buildStatus(ctx) {
  const { rt } = ctx;
  const tables = [...ctx.tables.values()];
  const devices = {};
  for (const [device, { meta }] of rt.statuses) {
    devices[device] = { user: meta.user, appVersion: meta.appVersion, writtenAt: meta.writtenAt, lastActiveAt: meta.lastActiveAt, tables: meta.tables };
  }
  return {
    deviceId: ctx.cfg.deviceId,
    pending: tables.reduce((n, T) => n + T.pending.length, 0),
    lastSaveAt: rt.lastSaveAt,
    lastScanAt: rt.lastScanAt,
    lastStatusAt: rt.lastStatusAt,
    retryAt: rt.retryAt,
    devices,
    unreadable: [...tables.flatMap((T) => T.unreadable), ...rt.statusUnreadable],
    errors: [...rt.errors],
    tables: Object.fromEntries(tables.map((T) => [T.name, { pending: T.pending.length, openSeq: T.open?.seq ?? null }])),
  };
}

// ---- traced attempts ---------------------------------------------------------

function saveOutcome({ rt }) {
  const { saved, failed } = rt.lastSave ?? {};
  if (!saved && !failed) return { outcome: "skipped", reason: "nothing-pending" };
  if (failed) return saved ? "partial" : "failed";
  return "ok";
}

const tracedSave = (ctx, reason) => ctx.tracer.run("save", reason, () => saveAll(ctx), { outcome: () => saveOutcome(ctx) });

function scanOutcome({ rt }) {
  const s = rt.lastScan;
  if (!s) return undefined;
  if (!s.rootOk) return "failed";
  return s.failedTables || s.unreadable || s.listErrors ? "partial" : undefined;
}

const tracedScan = (ctx, reason) => ctx.tracer.run("scan", reason, () => scanAll(ctx), { outcome: () => scanOutcome(ctx) });

async function statusSafe(ctx) {
  try {
    await writeStatusFile(ctx);
    return true;
  } catch (err) {
    ctx.recordError("status", err);
    ctx.rt.lastStatusAt = ctx.cfg.clock.now(); // retry on the normal cadence
    return false;
  }
}

const tracedStatus = (ctx, reason) => ctx.tracer.run("status", reason, () => statusSafe(ctx), { outcome: (ok) => (ok ? undefined : "failed") });

/** Pending work is being held back: say why, once per reason until the state changes. */
function noteHeldBack(ctx, decision) {
  const { rt } = ctx;
  if (decision.reason === "nothing-pending") {
    rt.skipNoted.clear();
    return;
  }
  if (!HELD_BACK.has(decision.reason) || rt.skipNoted.has(decision.reason)) return;
  rt.skipNoted.add(decision.reason);
  const pending = [...ctx.tables.values()].reduce((n, T) => n + T.pending.length, 0);
  ctx.tracer.skipped("save", decision.reason, { pending, retryAt: rt.retryAt, lastSaveAt: rt.lastSaveAt, oldestPendingAt: pendingBounds(ctx).oldestAt });
}

async function tickBody(ctx) {
  const { rt, cfg } = ctx;
  if (rt.closed) return;
  const now = cfg.clock.now();
  clampStoredTimes(ctx, now);
  const decision = saveDecisionNow(ctx);
  if (decision.due) {
    rt.skipNoted.clear();
    await tracedSave(ctx, decision.reason);
  } else {
    noteHeldBack(ctx, decision);
  }
  if (rt.lastScanAt == null || now - rt.lastScanAt >= cfg.options.scanMs) await tracedScan(ctx, "scheduled");
  if (rt.lastStatusAt == null || now - rt.lastStatusAt >= cfg.options.statusMs) await tracedStatus(ctx, "scheduled");
  await ctx.tracer.run("compaction", "scheduled", () => ctx.layout.maintenance(), { discardIfEmpty: true });
}

export async function createEngine(input) {
  const ctx = buildContext(input);
  const { rt, cfg } = ctx;
  const drain = async () => {
    let seen;
    do {
      seen = rt.localChain;
      await seen;
    } while (seen !== rt.localChain);
  };
  const exclusive = (fn) => {
    const run = rt.opChain.then(async () => {
      await drain();
      try {
        return await fn();
      } finally {
        await drain();
        await ctx.tracer.persist();
        refreshHealth(ctx);
      }
    });
    rt.opChain = run.catch(() => {});
    return run;
  };
  const guarded = (scope, fn) => exclusive(async () => {
    try {
      return await fn();
    } catch (err) {
      ctx.recordError(scope, err);
      return undefined;
    }
  });

  await ctx.tracer.load();
  await loadStatusSeen(ctx);
  for (const [name, adapterName] of Object.entries(cfg.tables)) await initTable(ctx, name, adapterName);
  await ctx.tracer.run("scan", "startup", async () => {
    await guarded("scan", () => scanAll(ctx));
    for (const T of ctx.tables.values()) await ctx.layout.init(T);
  }, { outcome: () => scanOutcome(ctx) });
  refreshHealth(ctx);

  const flush = () => guarded("save", async () => {
    if (!rt.closed) await tracedSave(ctx, "forced");
    return buildStatus(ctx).pending === 0;
  });

  return {
    table(name) {
      const T = ctx.tables.get(name);
      if (!T) throw new Error(`unknown table: ${name}`);
      return T.doc;
    },
    tick: () => guarded("tick", () => tickBody(ctx)).then(() => undefined),
    flush,
    scan: () => guarded("scan", async () => { if (!rt.closed) await tracedScan(ctx, "forced"); }).then(() => undefined),
    reseed: () => guarded("reseed", () => ctx.tracer.run("reseed", "forced", () => ctx.layout.reseed())),
    settled: async () => {
      await drain();
      await rt.opChain;
      await drain();
    },
    status: () => buildStatus(ctx),
    on: ctx.on,
    traces: (filter) => ctx.tracer.traces(filter),
    setTraceLevel: (level) => ctx.tracer.setLevel(level),
    metrics: () => buildMetrics(ctx),
    health: () => refreshHealth(ctx, { full: true }),
    /** The host's network hint: the engine cannot see the network itself. */
    setOffline(value) {
      rt.offline = Boolean(value);
      refreshHealth(ctx);
    },
    /** The record layer or app reports ask conflicts and overlap notices, which the engine cannot see. */
    noteConflict: (event) => ctx.metrics.noteConflict(event),
    async close() {
      await flush();
      await exclusive(async () => {
        rt.closed = true;
        for (const T of ctx.tables.values()) T.unsub?.();
        await ctx.tracer.persist({ force: true });
      });
    },
  };
}
