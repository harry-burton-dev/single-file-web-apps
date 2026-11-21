// Seeded workloads. A workload is a generator of plain action objects that is a
// pure function of (seed, profile, options): it never looks at the running
// system, so a seed always means the same actions (replay, shrinking, P12).
//
//   short    minutes of simulated time, 3 devices, 2 tables, dense random
//            actions including crashes, wipes, offline periods, a new device,
//            an emptied folder, injected garbage and fault-profile changes.
//   year     the standard workload of spec section 4: 3 users, 4 devices, 10
//            tables, ~2 sessions per device per working day, 20-60 changes per
//            session, `days` simulated days (365 = a year), default compaction.
//   compact  not in the spec: a smaller daily workload (3 devices, 2 tables, one
//            overlapping session per device per day, 3-8 changes) over `days`
//            days, whose BASE options lower the compaction threshold (variants
//            that set their own threshold keep it) so compaction really runs.
//
// All the numbers below are assumptions about plausible use.
import { createRandom } from "../sim/prng.js";
import { resolveProfile, PROFILE_NAMES, PROFILES } from "./faults.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WORDS = ["alpha", "bravo", "cedar", "delta", "ember", "fjord", "grove", "haze", "iris", "jade", "kilo", "lumen"];
const PEOPLE = ["ann", "bob", "cy", "dee"];

function weighted(rng, entries) {
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let x = rng.float() * total;
  for (const [value, w] of entries) {
    x -= w;
    if (x < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** One random edit action for device `dev`, table index `table`. */
function randomEdit(rng, { dev, table, records }) {
  const op = weighted(rng, [["set", 22], ["ask", 24], ["text", 24], ["remove", 5], ["restore", 4], ["resolve", 9]]);
  const rec = `r${rng.int(0, Math.max(0, records - 1))}`;
  const a = { type: "edit", dev, table, op, rec };
  if (op === "set") {
    a.field = rng.chance(0.3) ? "n" : "title";
    a.value = a.field === "n" ? rng.int(0, 999) : `${rng.pick(WORDS)}-${rng.int(0, 99)}`;
  } else if (op === "ask") a.value = rng.pick(PEOPLE);
  else if (op === "text") {
    a.pos = rng.int(0, 400);
    a.del = rng.chance(0.4) ? rng.int(0, 6) : 0;
    a.ins = rng.chance(0.85) ? `${rng.pick(WORDS)} `.slice(0, rng.int(1, 6)) : "";
  } else if (op === "resolve") {
    a.pick = rng.int(0, 5);
    a.value = rng.pick(PEOPLE);
  }
  return a;
}

// ---- short -------------------------------------------------------------------

export function* shortWorkload({ seed, profile: spec = "none", devices = 3, tables = 2, steps = null }) {
  const profile = resolveProfile(spec);
  const b = profile.behaviour;
  const rng = createRandom(seed).stream("workload/short");
  const running = Array(devices).fill(true);
  const offline = Array(devices).fill(false);
  let added = 0;
  let emptied = 0;
  const total = steps ?? rng.int(60, 140);
  const pickDevice = (pred) => {
    const ok = running.map((r, i) => i).filter((i) => pred(i));
    return ok.length ? rng.pick(ok) : -1;
  };
  for (let step = 0; step < total; step++) {
    const kind = weighted(rng, [
      ["outage", b.outageWeight ?? 0],
      ["edit", 48], ["advance", 24], ["end", 3], ["start", 6], ["crash", 2 * b.crashWeight], ["wipe", 1.5 * b.wipeWeight],
      ["offline", 3 * b.offlineWeight], ["online", 6], ["flush", 3], ["addDevice", 0.8], ["emptyFolder", 0.7],
      ["inject", 2 * b.injectWeight], ["faults", profile.name === "none" ? 0 : 1],
    ]);
    switch (kind) {
      case "edit": {
        const dev = pickDevice((i) => running[i]);
        if (dev < 0) {
          const wake = rng.int(0, running.length - 1);
          running[wake] = true;
          yield { type: "start", dev: wake };
        } else yield randomEdit(rng, { dev, table: rng.int(0, tables - 1), records: 4 });
        break;
      }
      case "advance": {
        const anyOffline = offline.some(Boolean);
        const ms = weighted(rng, [
          [rng.int(1, 60) * SECOND, 70], [rng.int(1, 10) * MINUTE, 20],
          [anyOffline ? rng.int(b.offlineMs[0], b.offlineMs[1]) : rng.int(5, 15) * MINUTE, 10],
        ]);
        yield { type: "advance", ms };
        break;
      }
      case "end": {
        const dev = pickDevice((i) => running[i]);
        if (dev >= 0) { running[dev] = false; yield { type: "end", dev }; }
        break;
      }
      case "start": {
        const dev = pickDevice((i) => !running[i]);
        if (dev >= 0) { running[dev] = true; yield { type: "start", dev }; }
        break;
      }
      case "crash":
      case "wipe": {
        const dev = pickDevice((i) => running[i]);
        if (dev >= 0) { running[dev] = false; yield { type: kind, dev }; }
        break;
      }
      case "offline": {
        const dev = pickDevice((i) => !offline[i]);
        if (dev >= 0) { offline[dev] = true; yield { type: "offline", dev }; }
        break;
      }
      case "online": {
        const dev = pickDevice((i) => offline[i]);
        if (dev >= 0) { offline[dev] = false; yield { type: "online", dev }; }
        break;
      }
      case "flush": {
        const dev = pickDevice((i) => running[i]);
        if (dev >= 0) yield { type: "flush", dev };
        break;
      }
      case "addDevice":
        if (added < 2) {
          added += 1;
          running.push(true);
          offline.push(false);
          yield { type: "addDevice" };
        }
        break;
      case "emptyFolder": {
        const dev = pickDevice((i) => running[i]);
        if (dev >= 0 && emptied < 1) {
          emptied += 1;
          for (let i = 0; i < offline.length; i++) offline[i] = false; // settling brings everyone online
          yield { type: "emptyFolder", dev };
        }
        break;
      }
      case "inject": {
        const dev = pickDevice((i) => running[i]);
        const kinds = b.injectCopies ? ["garbage", "truncated", "unknown", "bitflip", "copy"] : ["garbage", "truncated", "unknown", "bitflip"];
        if (dev >= 0) yield { type: "inject", dev, kind: rng.pick(kinds), table: rng.int(0, tables - 1), pick: rng.int(0, 20) };
        break;
      }
      case "outage":
        yield { type: "outage", ms: rng.int(b.outageMs[0], b.outageMs[1]) };
        break;
      case "faults":
        yield { type: "faults", profile: rng.pick(PROFILE_NAMES.filter((n) => !PROFILES[n].behaviour.outageWeight && (n !== "none" || rng.chance(0.5)))) };
        break;
      default:
    }
  }
}

// ---- daily workloads (year, compact) ---------------------------------------------

function* dailyWorkload({ seed, days, devices, users, tables, sessionsOf, editsOf, workdaysOnly, durationOf, stream }) {
  const rng = createRandom(seed).stream(stream);
  const records = Array(tables).fill(0); // next new record number per table
  let now = 0;
  for (let day = 0; day < days; day++) {
    const dayStart = day * DAY;
    const weekday = day % 7 < 5; // day 0 is a Monday
    if (workdaysOnly && !weekday) continue;
    // Build this day's events: [time, order, action]
    const events = [];
    for (let dev = 0; dev < devices; dev++) {
      let cursor = rng.int(0, 90) * MINUTE;
      for (let s = 0; s < sessionsOf(rng, dev); s++) {
        const length = durationOf(rng);
        const start = dayStart + cursor;
        events.push([start, 0, { type: "start", dev }]);
        const focus = [rng.int(0, tables - 1), rng.int(0, tables - 1), rng.int(0, tables - 1)];
        const n = editsOf(rng);
        for (let i = 0; i < n; i++) {
          const table = rng.chance(0.7) ? focus[rng.int(0, focus.length - 1)] : rng.int(0, tables - 1);
          const known = records[table];
          const fresh = known === 0 || rng.chance(0.25);
          const index = fresh ? records[table]++ : rng.int(0, known - 1);
          const edit = randomEdit(rng, { dev, table, records: index + 1 });
          edit.rec = `r${index}`;
          events.push([start + MINUTE + Math.floor(rng.float() * 0.85 * (length - MINUTE)), 1, edit]);
        }
        events.push([start + length, 2, { type: "end", dev }]);
        cursor += length + rng.int(30, 180) * MINUTE;
      }
    }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [t, , action] of events) {
      if (t > now) {
        yield { type: "advance", ms: t - now };
        now = t;
      }
      yield action;
    }
  }
  // finish() settles, so no trailing advance is needed.
}

export function* yearWorkload({ seed, days = 365, devices = 4, tables = 10, users = 3 }) {
  yield* dailyWorkload({
    seed, days, devices, users, tables, stream: "workload/year", workdaysOnly: true,
    sessionsOf: (rng) => weighted(rng, [[1, 2], [2, 6], [3, 2]]),
    editsOf: (rng) => rng.int(20, 60),
    durationOf: (rng) => rng.int(10, 45) * MINUTE,
  });
}

export function* compactWorkload({ seed, days = 60, devices = 3, tables = 2 }) {
  yield* dailyWorkload({
    seed, days, devices, users: devices, tables, stream: "workload/compact", workdaysOnly: false,
    sessionsOf: () => 1,
    editsOf: (rng) => rng.int(3, 8),
    durationOf: (rng) => rng.int(8, 14) * MINUTE,
  });
}

// ---- registry --------------------------------------------------------------------

export const WORKLOADS = Object.freeze({
  short: {
    description: "minutes of simulated time, 3 devices, dense random actions",
    create: () => ({ devices: 3, tables: 2, startAll: true, deepP4: true, keepLog: true }),
    plan: (seed, profile, opts) => shortWorkload({ seed, profile, ...opts }),
  },
  year: {
    description: "spec section 4 standard workload: 3 users, 4 devices, 10 tables, ~2 sessions per device per working day",
    create: () => ({ devices: 4, tables: 10, users: ["ann", "bob", "cy"], startAll: false, deepP4: false, keepLog: false }),
    plan: (seed, profile, opts) => yearWorkload({ seed, ...opts }),
    defaultDays: 365,
  },
  compact: {
    description: "daily overlapping sessions over many days with a lowered compaction threshold (so compaction runs)",
    create: () => ({
      devices: 3, tables: 2, startAll: false, deepP4: true, keepLog: false,
      baseOptions: { compaction: { chunkThreshold: 8, snapshotMaxAgeMs: 3 * DAY } },
    }),
    plan: (seed, profile, opts) => compactWorkload({ seed, ...opts }),
    defaultDays: 60,
  },
});

export const WORKLOAD_NAMES = Object.freeze(Object.keys(WORKLOADS));
