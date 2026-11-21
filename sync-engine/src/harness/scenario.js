// A scenario wires the real engine to the deterministic folder simulator:
// one world, one engine per device (own memory store, own named random
// stream), one shared fixed AES-GCM key, tables opened through the record
// layer, and an oracle fed from the adapters at source.
//
// Actions (plain JSON objects, see actions.js for the vocabulary) are applied
// with `await sc.apply(action)`. Actions that cannot apply (device not
// running, record missing, ...) are skipped and counted, so any sequence is
// valid; that keeps replay and fast-check shrinking simple.
//
// Checks done live: P7 (every engine call is wrapped), P8 (every new log
// entry), P4 (every delete is validated against the folder at that moment, by
// wrapping the engine's root handle), P3 (after a crash+reopen), P13 (every
// write and delete in the log against the engine's traces, after every step),
// P14 (the engine's health after every tick), P16 (no IV reused under the key,
// on every write). The rest is done by finish().
// P15 needs two runs: see run.js.
//
// Engines get a deterministic timer (a counter), so trace durations are the
// same on every run of a seed (P12).
//
// Determinism: Yjs picks a random clientID for every new Y.Doc, which changes
// update sizes between runs and so breaks P12. Each device gets a Yjs adapter
// whose clientIDs come from a seeded stream that lives as long as the device.
import { createHash } from "node:crypto";
import { createWorld } from "../sim/world.js";
import { createEngine } from "../engine/engine.js";
import { DEFAULT_OPTIONS } from "../engine/constants.js";
import { open as openEnvelope } from "../engine/envelope.js";
import { createMemoryStore } from "../store/memory.js";
import { yjsAdapter, createYjsAdapter } from "../adapters/yjs.js";
import { openTable } from "../records/index.js";
import { importFixedKey, KEY_ID } from "./keys.js";
import { resolveProfile } from "./faults.js";
import { getVariant } from "./variants.js";
import { createOracle } from "./oracle.js";
import { watchRemovals, watchWrites } from "./hooks.js";
import { computeMetrics } from "./metrics.js";
import {
  addTraceTotals, checkAttribution, checkContainment, checkConvergence, checkDigests, checkHealth, checkOracle, checkPacing, checkProgress,
  checkSingleWriter, checkTraceTotals, createCompactionChecker, createIvTracker, emptyTraceTotals, violation,
} from "./checks.js";

export const SCHEMA = Object.freeze({ version: 1, fields: Object.freeze({ title: "latest", n: "latest", owner: "ask", body: "text" }) });
export const TABLE_NAMES = Object.freeze(["notes", "tasks", "people", "projects", "events", "files", "tags", "logs", "docs", "misc"]);
export const DEFAULT_TICK_MS = 5000;
const COARSE_TICK_MS = 30000; // used inside very long advances
const COARSE_ABOVE_MS = 10 * 60 * 1000;
const SETTLE_STEP_MS = 10000;
const MAX_VIOLATIONS = 300;
const MAX_NEW_DEVICE_STEPS = 400;
const INSPECT_KEEP = 200;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep-merge engine option objects (later wins). */
export function mergeOptions(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part ?? {})) {
      out[key] = isObject(value) && isObject(out[key]) ? mergeOptions(out[key], value) : isObject(value) ? mergeOptions(value) : value;
    }
  }
  return out;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const hexDigest = async (text) =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function formatAction(a) {
  const { type, ...rest } = a;
  const args = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`).join(" ");
  return `${type}${args ? ` ${args}` : ""}`;
}

export async function createScenario(config = {}) {
  const {
    seed = 1, faults = "none", devices: deviceCount = 3, users = ["ann", "bob", "cy"], tables: tableSpec = 2,
    baseOptions = {}, optionOverrides = {}, tickMs = DEFAULT_TICK_MS, deepP4 = true, startAll = true, keepLog = true,
    traceLevel = "full", inspect = false,
  } = config;
  const variant = typeof config.variant === "string" || !config.variant ? getVariant(config.variant ?? "baseline") : config.variant;
  const tableNames = Array.isArray(tableSpec) ? tableSpec : Array.from({ length: tableSpec }, (_, i) => TABLE_NAMES[i] ?? `t${i}`);
  const profile = resolveProfile(faults);
  const world = createWorld({ seed, faults: profile.sim });
  const key = await importFixedKey();
  const keys = new Map([[KEY_ID, key]]);
  const engineOptions = mergeOptions(baseOptions, variant.options, optionOverrides);
  const effective = mergeOptions(DEFAULT_OPTIONS, engineOptions);
  const tableMap = Object.fromEntries(tableNames.map((t) => [t, variant.adapter]));
  const oracleAdapter = yjsAdapter;
  const oracle = createOracle({ adapter: oracleAdapter, tables: tableNames });
  const adaptersForChecks = { yjs: yjsAdapter };
  const compaction = createCompactionChecker({ keys, options: effective, adapters: adaptersForChecks, deep: deepP4 });

  const ivTracker = createIvTracker();
  let timerCount = 0;
  const timer = { now: () => ++timerCount }; // deterministic stand-in for a monotonic timer

  const sc = {
    seed, variant, profile, world, oracle, tableNames, engineOptions, effective, tickMs, traceLevel,
    traceBuffer: [], traceTotals: {}, harnessWrites: {},
    // --inspect: the traces just before the first violation and the ones after it
    inspect: inspect ? { recent: [], mark: null, before: [], after: [] } : null,
    devices: [], violations: [], actionLog: [], saves: [], received: [], sessions: [],
    counts: { applied: {}, skipped: {} }, engineErrors: {},
    forced: false, noFaultsEver: profile.name === "none", maxStep: tickMs, instanceCounter: 0,
    ignoredRanges: [], logCursor: 0, actionNo: 0, finished: false,
  };

  // ---- violations --------------------------------------------------------

  sc.violate = (property, fields) => {
    if (sc.violations.length < MAX_VIOLATIONS) sc.violations.push(violation(property, { at: world.clock.now(), ...fields }));
    const { inspect: ins } = sc;
    if (ins && !ins.mark) {
      ins.mark = sc.violations[sc.violations.length - 1];
      ins.before = ins.recent.slice();
    }
  };
  const describeError = (err) => `${err?.name ?? "Error"}: ${err?.message ?? err}`;

  /** P7 guard: any exception out of an engine call is a violation. */
  async function guard(label, dev, fn) {
    try {
      return await fn();
    } catch (err) {
      sc.violate("P7", { device: dev?.id, message: `${label} threw ${describeError(err)}`, stack: String(err?.stack ?? "").split("\n").slice(0, 4).join(" | ") });
      return undefined;
    }
  }

  // ---- devices and sessions ---------------------------------------------

  function addDeviceState(user) {
    const idx = sc.devices.length;
    const id = `${user}-dev${String(idx).padStart(5, "0")}`;
    const handle = world.addDevice(id);
    const dev = {
      idx, id, user, root: handle.root, store: createMemoryStore(), session: null, online: true, epoch: 0, afterCrash: false,
      adapters: { yjs: createYjsAdapter({ random: world.random(`yjs-client/${id}`) }) },
    };
    sc.devices.push(dev);
    return dev;
  }

  const adapterOf = (dev) => dev.adapters[variant.adapter];

  async function onRemove(dev, path) {
    if (!path.startsWith("data/")) return;
    try {
      const found = await compaction.check({ device: dev.id, path, now: world.clock.now(), cloud: world.cloudFiles(), local: world.deviceFiles(dev.id) });
      for (const v of found) sc.violate("P4", { ...v, at: v.at });
    } catch (err) {
      sc.violate("ERR", { device: dev.id, path, message: `P4 checker failed: ${describeError(err)}` });
    }
  }

  async function startSession(dev) {
    if (dev.session) return false;
    const instance = ++sc.instanceCounter;
    const watched = watchRemovals(dev.root, (path) => onRemove(dev, path));
    const root = watchWrites(watched, (path, bytes) => {
      for (const v of ivTracker.record({ bytes, path, device: dev.id, at: world.clock.now() })) sc.violate("P16", v);
    });
    const session = { instance, engine: null, tables: {}, unsubs: [], lastSave: null, saveErrors: 0 };
    const onTrace = (trace) => {
      sc.traceBuffer.push(trace);
      if (sc.inspect) {
        const ins = sc.inspect;
        if (!ins.mark) ins.recent = [...ins.recent.slice(-INSPECT_KEEP + 1), trace];
        else if (ins.after.length < INSPECT_KEEP) ins.after.push(trace);
      }
      sc.traceTotals[dev.id] = addTraceTotals(sc.traceTotals[dev.id] ?? emptyTraceTotals(), trace);
      if (trace.kind === "save" && trace.outcome !== "skipped") {
        session.lastSave = { outcome: trace.outcome, failed: session.saveErrors > 0 };
        session.saveErrors = 0;
      }
    };
    const engine = await guard("createEngine", dev, () => createEngine({
      root, clock: world.clock, random: world.random(`engine/${dev.id}`), store: dev.store, key, keyId: KEY_ID,
      user: dev.user, deviceId: dev.id, adapters: dev.adapters, tables: tableMap, timer, listeners: { trace: onTrace },
      options: mergeOptions(engineOptions, { trace: { level: traceLevel } }),
    }));
    if (!engine) return false;
    const adapter = adapterOf(dev);
    session.engine = engine;
    for (const name of tableNames) {
      const doc = engine.table(name);
      session.tables[name] = openTable({ adapterName: variant.adapter, adapter, doc, schema: SCHEMA, deviceId: dev.id, user: dev.user, clock: world.clock });
      session.unsubs.push(adapter.onLocalUpdate(doc, (bytes) => {
        oracle.record({ device: dev.id, table: name, bytes, at: world.clock.now(), epoch: dev.epoch, instance });
      }));
    }
    engine.on("saved", (ev) => {
      oracle.markSaved(dev.id, ev.table, ev.at, instance);
      sc.saves.push({ device: dev.id, instance, at: ev.at, forced: sc.forced });
    });
    engine.on("received", (ev) => sc.received.push({ at: world.clock.now(), instance, observer: dev.id, table: ev.table, from: ev.device, writtenAt: ev.writtenAt }));
    engine.on("error", (ev) => {
      sc.engineErrors[ev.scope] = (sc.engineErrors[ev.scope] ?? 0) + 1;
      if (ev.scope === "save") session.saveErrors += 1;
    });
    dev.session = session;
    sc.sessions.push({ device: dev.id, instance, start: world.clock.now(), end: null });
    if (dev.afterCrash) {
      dev.afterCrash = false;
      for (const name of tableNames) {
        const updates = oracle.liveEntries((e) => e.device === dev.id && e.table === name && e.epoch === dev.epoch).map((e) => e.bytes);
        for (const v of checkContainment({ adapter: oracleAdapter, restored: engine.table(name), updates, device: dev.id, table: name, at: world.clock.now() })) sc.violate("P3", v);
      }
    }
    return true;
  }

  function dropSession(dev) {
    const { session } = dev;
    if (!session) return;
    for (const off of session.unsubs) off();
    const record = sc.sessions.find((s) => s.instance === session.instance);
    if (record) record.end = world.clock.now();
    dev.session = null;
  }

  const live = () => sc.devices.filter((d) => d.session);

  // ---- time --------------------------------------------------------------

  /** Scan the simulator log for new P8 violations. */
  function afterStep() {
    const to = world.log.length;
    const ignored = (i) => sc.ignoredRanges.some(([a, b]) => i >= a && i < b);
    for (const v of checkSingleWriter(world.log, { from: sc.logCursor, to, ignore: ignored, shared: variant.sharedPaths })) sc.violate("P8", v);
    checkTraces(sc.logCursor, to, ignored);
    sc.logCursor = to;
  }

  /** P13: the engine writes and deletes in the log against the traces made since the last call. */
  function checkTraces(from, to, ignored) {
    const traces = sc.traceBuffer.splice(0);
    if (traceLevel === "off") return;
    const entries = [];
    for (let i = from; i < to; i++) {
      const e = world.log[i];
      if (e.type !== "write" && e.type !== "delete") continue;
      if (ignored(i)) {
        if (e.type === "write") {
          const h = (sc.harnessWrites[e.device] ??= { writes: 0, bytesWritten: 0 });
          h.writes += 1;
          h.bytesWritten += e.size;
        }
        continue;
      }
      entries.push(e);
    }
    if (traceLevel === "full") for (const v of checkAttribution({ entries, traces, at: world.clock.now() })) sc.violate("P13", v);
  }

  /** P13 totals, at the end: what the traces counted against the simulator's counters. */
  function checkTotals() {
    if (traceLevel === "off") return;
    for (const [device, counters] of Object.entries(world.stats().perDevice)) {
      const own = sc.harnessWrites[device] ?? { writes: 0, bytesWritten: 0 };
      const seen = { ...counters, writes: counters.writes - own.writes, bytesWritten: counters.bytesWritten - own.bytesWritten };
      for (const v of checkTraceTotals({ device, totals: sc.traceTotals[device] ?? emptyTraceTotals(), counters: seen, at: world.clock.now() })) sc.violate("P13", v);
    }
  }

  /** P14: the engine's own account of its state, right after it did its work. */
  function checkHealthOf(dev) {
    const { session } = dev;
    if (!session) return;
    let health;
    try {
      health = session.engine.health();
    } catch (err) {
      sc.violate("ERR", { device: dev.id, message: `health() threw ${describeError(err)}` });
      return;
    }
    const found = checkHealth({ health, device: dev.id, at: world.clock.now(), lastSave: session.lastSave, level: traceLevel, ackTimeoutMs: effective.health.ackTimeoutMs });
    for (const v of found) sc.violate("P14", v);
  }

  async function tickDevice(dev) {
    if (!dev.session) return;
    await guard("tick", dev, () => dev.session.engine.tick());
    checkHealthOf(dev);
  }

  async function tickAll() {
    for (const dev of live()) await tickDevice(dev);
    afterStep();
  }

  /** Advance simulated time, ticking every running engine as time passes. */
  async function advanceTicking(ms, step = tickMs) {
    let left = ms;
    while (left > 0) {
      if (!live().length) {
        await world.advance(left);
        break;
      }
      const size = Math.min(left > COARSE_ABOVE_MS ? Math.max(step, COARSE_TICK_MS) : step, left);
      sc.maxStep = Math.max(sc.maxStep, size);
      await world.advance(size);
      left -= size;
      await tickAll();
    }
    afterStep();
  }

  function setAllOnline() {
    for (const dev of sc.devices) {
      dev.online = true;
      world.setOnline(dev.id, true);
    }
  }

  const fingerprint = () => {
    const s = world.stats();
    const docs = [];
    for (const dev of live()) {
      for (const name of tableNames) docs.push(sha(JSON.stringify(adapterOf(dev).toJSON(dev.session.engine.table(name)))));
    }
    const pending = live().map((d) => d.session.engine.status().pending).join(",");
    return `${s.cloudFiles}:${s.cloudBytes}:${pending}:${sha(docs.join())}`;
  };

  /**
   * Bring everything to rest: faults off, all online, then rounds of ticking
   * until a whole round changes nothing (each round is long enough for a
   * save, a scan, a status write and the next scan to happen).
   */
  async function settle({ restoreFaults = false } = {}) {
    await world.quiesce();
    setAllOnline();
    const o = effective;
    const span = o.maxWaitMs + o.minIntervalMs + 2 * o.scanMs + o.statusMs;
    let previous = null;
    let stable = false;
    for (let round = 0; round < 10 && !stable; round++) {
      await advanceTicking(span, SETTLE_STEP_MS);
      await world.quiesce();
      const now = fingerprint();
      stable = now === previous;
      previous = now;
    }
    if (!stable) sc.violate("P1", { message: "the system did not come to rest after 10 settle rounds (still changing)" });
    if (restoreFaults) world.setFaults(sc.profile.sim);
    return stable;
  }

  // ---- actions -----------------------------------------------------------

  async function injectFile(dev, a) {
    const table = tableNames[(a.table ?? 0) % tableNames.length];
    const stream = world.random(`inject/${dev.id}`);
    const from = world.log.length;
    let dir = dev.root;
    const dirParts = ["data", table];
    let name;
    let bytes;
    const cloudChunks = [...world.cloudFiles()].filter(([p]) => p.startsWith(`data/${table}/`) && /\/\d{6}\.ywb$/.test(p)).sort(([x], [y]) => (x < y ? -1 : 1));
    const target = cloudChunks.length ? cloudChunks[(a.pick ?? 0) % cloudChunks.length] : null;
    switch (a.kind) {
      case "truncated":
      case "bitflip":
      case "copy": {
        if (!target) return false;
        const [path, original] = target;
        const parts = path.split("/");
        dirParts.push(parts[2]);
        name = parts[3].replace(".ywb", a.kind === "copy" ? "-conflict.ywb" : "-INJECT.ywb");
        bytes = original.slice();
        if (a.kind === "truncated") bytes = bytes.slice(0, Math.max(0, Math.floor(bytes.length * 0.6)));
        else if (a.kind === "bitflip") bytes[Math.min(bytes.length - 1, 20 + (a.pick ?? 0) % 8)] ^= 0xff;
        break;
      }
      case "unknown":
        dirParts.push("ghost-00000000");
        name = "readme.txt";
        bytes = stream.bytes(stream.int(0, 40));
        break;
      default:
        dirParts.push("ghost-00000000");
        name = "000001.ywb";
        bytes = stream.bytes(stream.int(0, 200));
    }
    // Injection is the harness's own doing: faults off while it happens, and its
    // log entries are exempt from P8.
    world.setFaults({});
    try {
      for (const part of dirParts) dir = await dir.getDirectoryHandle(part, { create: true });
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } finally {
      world.setFaults(sc.profile.sim);
      sc.ignoredRanges.push([from, world.log.length]);
    }
    return true;
  }

  function editRecord(dev, a) {
    const table = dev.session.tables[tableNames[a.table % tableNames.length]];
    switch (a.op) {
      case "set":
        table.put(a.rec, { [a.field === "n" ? "n" : "title"]: a.value });
        return true;
      case "ask":
        table.put(a.rec, { owner: a.value });
        return true;
      case "text": {
        const current = table.get(a.rec)?.fields.body ?? "";
        const pos = a.pos % (current.length + 1);
        const del = Math.min(a.del ?? 0, current.length - pos);
        table.updateText(a.rec, "body", current.slice(0, pos) + (a.ins ?? "") + current.slice(pos + del));
        return true;
      }
      case "remove":
        if (!table.get(a.rec)) return false;
        table.remove(a.rec);
        return true;
      case "restore":
        if (!table.get(a.rec)) return false;
        table.restore(a.rec);
        return true;
      case "resolve": {
        const open = table.conflicts();
        if (!open.length) return false;
        const pick = open[a.pick % open.length];
        table.field(pick.id, pick.field).resolve(a.value);
        return true;
      }
      default:
        throw new Error(`unknown edit op ${a.op}`);
    }
  }

  const ACTIONS = {
    async edit(a) {
      const dev = sc.devices[a.dev];
      if (!dev?.session) return false;
      if (!editRecord(dev, a)) return false;
      await guard("settled", dev, () => dev.session.engine.settled());
      return true;
    },
    async advance(a) {
      await advanceTicking(a.ms);
      return true;
    },
    async start(a) {
      const dev = sc.devices[a.dev];
      return dev ? startSession(dev) : false;
    },
    async end(a) {
      const dev = sc.devices[a.dev];
      if (!dev?.session) return false;
      sc.forced = true;
      await guard("close", dev, () => dev.session.engine.close());
      sc.forced = false;
      dropSession(dev);
      afterStep();
      return true;
    },
    async crash(a) {
      const dev = sc.devices[a.dev];
      if (!dev?.session) return false;
      dropSession(dev);
      dev.afterCrash = true;
      return true;
    },
    async wipe(a) {
      const dev = sc.devices[a.dev];
      if (!dev) return false;
      dropSession(dev);
      dev.store.wipe();
      dev.epoch += 1;
      dev.afterCrash = false;
      oracle.loseUnsaved(dev.id);
      return true;
    },
    async offline(a) {
      const dev = sc.devices[a.dev];
      if (!dev || !dev.online) return false;
      dev.online = false;
      world.setOnline(dev.id, false);
      return true;
    },
    async online(a) {
      const dev = sc.devices[a.dev];
      if (!dev || dev.online) return false;
      dev.online = true;
      world.setOnline(dev.id, true);
      return true;
    },
    async addDevice(a) {
      const dev = addDeviceState(a.user ?? users[sc.devices.length % users.length]);
      await startSession(dev);
      return true;
    },
    async flush(a) {
      const dev = sc.devices[a.dev];
      if (!dev?.session) return false;
      sc.forced = true;
      await guard("flush", dev, () => dev.session.engine.flush());
      sc.forced = false;
      afterStep();
      return true;
    },
    async faults(a) {
      const next = resolveProfile(a.profile);
      sc.profile = next;
      if (next.name !== "none") sc.noFaultsEver = false;
      world.setFaults(next.sim);
      return true;
    },
    async emptyFolder(a) {
      const dev = sc.devices[a.dev];
      if (!dev?.session) return false;
      await settle(); // everyone holds everything, faults off
      world.wipeFolder();
      sc.forced = true;
      await guard("reseed", dev, () => dev.session.engine.reseed()); // the user's own action: faults stay off
      sc.forced = false;
      world.setFaults(sc.profile.sim);
      afterStep();
      return true;
    },
    /** Every write by every device fails for a while, then the profile's faults resume. */
    async outage(a) {
      world.setFaults({ ...sc.profile.sim, writeFailure: { probability: 1 } });
      await advanceTicking(a.ms);
      world.setFaults(sc.profile.sim);
      return true;
    },
    async inject(a) {
      const dev = sc.devices[a.dev];
      if (!dev) return false;
      return injectFile(dev, a);
    },
  };

  sc.apply = async function apply(action) {
    const n = ++sc.actionNo;
    let did = false;
    try {
      const handler = ACTIONS[action.type];
      if (!handler) throw new Error(`unknown action type ${action.type}`);
      const before = world.clock.now();
      did = await handler(action);
      if (keepLog) sc.actionLog.push({ n, t: before, action, applied: Boolean(did) });
    } catch (err) {
      sc.violate("ERR", { message: `action ${formatAction(action)} failed in the harness or record layer: ${describeError(err)}`, stack: String(err?.stack ?? "").split("\n").slice(0, 5).join(" | ") });
      if (keepLog) sc.actionLog.push({ n, t: world.clock.now(), action, applied: false, error: describeError(err) });
    }
    const bucket = did ? sc.counts.applied : sc.counts.skipped;
    bucket[action.type] = (bucket[action.type] ?? 0) + 1;
    return did;
  };

  // ---- views and the final verdict --------------------------------------

  sc.views = () => {
    const views = {};
    for (const dev of live()) {
      views[dev.id] = Object.fromEntries(tableNames.map((name) => [name, adapterOf(dev).toJSON(dev.session.engine.table(name))]));
    }
    return views;
  };

  async function statusFiles() {
    const out = [];
    for (const [path, bytes] of world.cloudFiles()) {
      if (!path.startsWith("status/") || !path.endsWith(".ywb")) continue;
      try {
        const { meta } = await openEnvelope({ keys, bytes });
        if (meta?.kind === "status") out.push({ device: meta.device, tables: meta.tables });
      } catch {
        // junk or a truncated copy: not a status file
      }
    }
    return out;
  }

  async function addAndMeasureNewDevice() {
    const dev = addDeviceState(users[0]);
    const startedAt = world.clock.now();
    await startSession(dev);
    let reached = false;
    for (let i = 0; i < MAX_NEW_DEVICE_STEPS && !reached; i++) {
      await world.advance(tickMs);
      await tickDevice(dev);
      afterStep();
      const view = Object.fromEntries(tableNames.map((name) => [name, adapterOf(dev).toJSON(dev.session.engine.table(name))]));
      reached = checkOracle({ [dev.id]: view }, oracle.allJson()).length === 0;
    }
    const counters = world.stats().perDevice[dev.id];
    if (!reached) {
      const view = Object.fromEntries(tableNames.map((name) => [name, adapterOf(dev).toJSON(dev.session.engine.table(name))]));
      for (const v of checkOracle({ [dev.id]: view }, oracle.allJson(), { at: world.clock.now() })) {
        sc.violate("P4", { ...v, message: `a brand-new device never reached the oracle: ${v.message}` });
      }
    }
    return { files: counters.filesRead, bytes: counters.bytesRead, reads: counters.reads, reachedOracle: reached, simulatedMs: world.clock.now() - startedAt };
  }

  /**
   * End of run: wake every device, bring everything to rest, then run the
   * convergence, oracle, pacing, digest checks and the new-device join.
   */
  sc.finish = async function finish({ newDevice = true } = {}) {
    await world.quiesce();
    setAllOnline();
    for (const dev of sc.devices) if (!dev.session) await startSession(dev);
    await settle();
    const at = world.clock.now();
    const views = sc.views();
    for (const v of checkConvergence(views, { at })) sc.violate("P1", v);
    for (const v of checkOracle(views, oracle.allJson(), { at })) sc.violate("P2", v);
    for (const dev of live()) {
      const pending = dev.session.engine.status().pending;
      if (pending) sc.violate("P1", { device: dev.id, message: `${dev.id} still has ${pending} unsaved updates after everything settled` });
    }
    for (const v of checkPacing(sc.saves, { minIntervalMs: effective.minIntervalMs })) sc.violate("P9", v);
    if (sc.noFaultsEver) {
      const liveInstances = new Set(live().map((d) => d.session.instance));
      const updates = oracle.entries;
      for (const v of checkProgress(updates, { maxWaitMs: effective.maxWaitMs, minIntervalMs: effective.minIntervalMs, tickMs: Math.max(sc.maxStep, SETTLE_STEP_MS), endAt: at, liveInstances })) sc.violate("P9", v);
    }
    const actualDigests = {};
    for (const dev of live()) {
      actualDigests[dev.id] = {};
      for (const name of tableNames) actualDigests[dev.id][name] = await hexDigest(JSON.stringify(adapterOf(dev).toJSON(dev.session.engine.table(name))));
    }
    for (const v of checkDigests(await statusFiles(), actualDigests, { at })) sc.violate("P11", v);

    const endStats = world.stats();
    const contentHash = sha(JSON.stringify({ oracle: oracle.allJson(), views }));
    const newDeviceInfo = newDevice ? await addAndMeasureNewDevice() : null;
    await world.quiesce();
    afterStep();
    for (const dev of live()) checkHealthOf(dev);
    checkTotals();
    sc.finished = true;
    const metrics = computeMetrics({
      log: world.log, endStats, finalStats: world.stats(), updates: oracle.entries, received: sc.received, sessions: sc.sessions, newDevice: newDeviceInfo,
    });
    return { violations: sc.violations, metrics, traceHash: world.traceHash(), contentHash, endedAt: world.clock.now() };
  };

  sc.settle = settle;
  sc.tickAll = tickAll;
  sc.advanceTicking = advanceTicking;
  sc.addDevice = (user) => addDeviceState(user ?? users[sc.devices.length % users.length]);
  sc.startSession = startSession;
  sc.guard = guard;

  for (let i = 0; i < deviceCount; i++) addDeviceState(users[i % users.length]);
  if (startAll) for (const dev of sc.devices) await startSession(dev);
  return sc;
}
