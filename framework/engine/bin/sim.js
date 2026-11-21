#!/usr/bin/env node
// Simulation CLI. Real time is used only to report wall-clock durations.
//
//   node bin/sim.js --scenario short --variant baseline --faults rough --seeds 1..500
//   node bin/sim.js --scenario short --variant all --faults none,rough,hostile --seeds 1..200
//   node bin/sim.js --scenario year --days 365 --seeds 1..3 --faults lag
//   node bin/sim.js --replay 137 --scenario short --variant baseline --faults rough --verbose
//
// Options
//   --scenario  short | year | compact              (default short)
//   --variant   name | a,b,c | all                  (default baseline)
//   --faults    none | lag | rough | outage | hostile, comma list or all   (default none)
//   --seeds     N | a..b | a,b,c                    (default 1..20)
//   --days N    simulated days (year, compact)
//   --option k=v  engine option override, dotted (e.g. compaction.chunkThreshold=3); repeatable
//   --p12 N     check determinism (P12) on every Nth seed (default 10; 0 = never; 1 = all)
//   --replay S  run only seed S and print its action log and first violations
//   --trace L   engine trace level: off | summary | full (default full)
//   --p15 N     check observation-independence (P15: trace level off vs full) on every Nth seed (default 10; 0 = never)
//   --inspect   with --replay: print the failing device's traces around the first violation
//   --verbose   per-seed lines (and with --replay the full action log)
//   --no-write  do not write results/*.json
//   --list      list variants, fault profiles, scenarios
// Exit code 1 if any violation was found in any run.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VARIANTS, VARIANT_NAMES, getVariant, probeVariant } from "../src/harness/variants.js";
import { PROFILES, PROFILE_NAMES } from "../src/harness/faults.js";
import { WORKLOADS, WORKLOAD_NAMES } from "../src/harness/workloads.js";
import { runSeed, runSeedTwice, runSeedObserved, describeViolation } from "../src/harness/run.js";
import { formatAction } from "../src/harness/scenario.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { scenario: "short", variant: "baseline", faults: "none", seeds: "1..20", option: [], p12: 10, p15: 10, trace: "full" };
  const flags = new Set(["verbose", "no-write", "list", "inspect"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (flags.has(name)) out[name] = true;
    else if (name === "option") out.option.push(argv[++i]);
    else out[name] = argv[++i];
    if (out[name] === undefined) throw new Error(`--${name} needs a value`);
  }
  return out;
}

function parseSeeds(text) {
  const seeds = [];
  for (const part of String(text).split(",")) {
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(part);
    if (range) for (let s = Number(range[1]); s <= Number(range[2]); s++) seeds.push(s);
    else if (/^-?\d+$/.test(part)) seeds.push(Number(part));
    else throw new Error(`bad --seeds ${text}`);
  }
  return seeds;
}

function parseOverrides(list) {
  const out = {};
  for (const item of list) {
    const eq = item.indexOf("=");
    if (eq < 0) throw new Error(`--option needs key=value, got ${item}`);
    let value;
    try {
      value = JSON.parse(item.slice(eq + 1));
    } catch {
      value = item.slice(eq + 1);
    }
    const path = item.slice(0, eq).split(".");
    let node = out;
    for (const part of path.slice(0, -1)) node = node[part] ??= {};
    node[path.at(-1)] = value;
  }
  return out;
}

const names = (text, all) => (text === "all" ? [...all] : String(text).split(",").filter(Boolean));
const fmtMs = (ms) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

function printList() {
  console.log("variants:");
  for (const v of VARIANTS) console.log(`  ${v.name.padEnd(24)} ${v.description}`);
  console.log("fault profiles:");
  for (const p of Object.values(PROFILES)) console.log(`  ${p.name.padEnd(24)} ${p.description}`);
  console.log("scenarios:");
  for (const [n, w] of Object.entries(WORKLOADS)) console.log(`  ${n.padEnd(24)} ${w.description}`);
}

function summarizeMetrics(runs) {
  const m = runs.map((r) => r.metrics).filter(Boolean);
  if (!m.length) return null;
  const avg = (f) => m.reduce((n, x) => n + (f(x) ?? 0), 0) / m.length;
  return {
    cloudFilesEnd: avg((x) => x.cloudFilesEnd), cloudFilesPeak: avg((x) => x.cloudFilesPeak), bytesWritten: avg((x) => x.bytesWritten),
    largestFileBytes: Math.max(...m.map((x) => x.largestFile.bytes)), deletes: avg((x) => x.deletes), snapshotsWritten: avg((x) => x.snapshotsWritten),
    latencyTotalP50: avg((x) => x.latency.total.p50), latencyTotalP95: avg((x) => x.latency.total.p95),
    latencyExclSyncP50: avg((x) => x.latency.excludingSync.p50), latencyExclSyncP95: avg((x) => x.latency.excludingSync.p95),
    newDeviceFilesRead: avg((x) => x.newDevice?.files), newDeviceBytesRead: avg((x) => x.newDevice?.bytes),
  };
}

async function runCell(args, variant, faults, seeds, overrides) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const byProperty = {};
  const failing = [];
  const runs = [];
  let seedsWithViolation = 0;
  const p12Every = Number(args.p12);
  const p15Every = Number(args.p15);
  for (const seed of seeds) {
    const params = { scenario: args.scenario, variant, faults, seed, days: args.days ? Number(args.days) : undefined, overrides, trace: args.trace };
    const index = seeds.indexOf(seed);
    const twice = p12Every > 0 && index % p12Every === 0;
    const observed = !twice && p15Every > 0 && index % p15Every === p15Every >> 1;
    const t0 = performance.now();
    const run = await (twice ? runSeedTwice : observed ? runSeedObserved : runSeed)(params);
    const counts = {};
    for (const v of run.violations) counts[v.property] = (counts[v.property] ?? 0) + 1;
    for (const [p, n] of Object.entries(counts)) byProperty[p] = (byProperty[p] ?? 0) + n;
    if (run.violations.length) {
      seedsWithViolation += 1;
      failing.push({ seed, counts, first: run.violations.slice(0, 3).map(describeViolation) });
    }
    runs.push({ seed, wallMs: performance.now() - t0, p12: twice, p15: observed, violations: run.violations.slice(0, 20), counts, metrics: run.metrics, traceHash: run.traceHash });
    if (args.verbose) console.log(`  seed ${seed}: ${run.violations.length ? Object.entries(counts).map(([p, n]) => `${p}:${n}`).join(" ") : "ok"} (${fmtMs(performance.now() - t0)}, ${run.actionLog.length} actions)`);
  }
  const cpu = process.cpuUsage(cpuStarted);
  return { wallMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000, byProperty, failing, runs, seedsWithViolation };
}

const BEFORE_SHOWN = 12;
const AFTER_SHOWN = 6;
const STEPS_SHOWN = 12;

function formatTrace(t) {
  const c = t.counts;
  const head = `#${t.id} ${t.kind} ${t.outcome} (${t.reason}) t=+${((t.startedAt - Date.UTC(2026, 0, 5, 9)) / 1000).toFixed(0)}s ${t.durationMs} ticks read ${c.read}/${c.bytesRead}B write ${c.write}/${c.bytesWritten}B del ${c.delete} list ${c.list} err ${c.errors}`;
  const steps = t.steps.filter((s) => s.action !== "list" && s.action !== "skip").slice(0, STEPS_SHOWN)
    .map((s) => `      ${s.action} ${s.path} ${s.bytes}B ${s.result}${s.error ? ` ${s.error.name}` : ""}`);
  return [`  ${head}`, ...steps].join("\n");
}

/** --inspect: the failing device's traces just before and after the first violation. */
function printInspection(run) {
  const ins = run.inspect;
  if (!ins?.mark) return console.log("  inspect: no violation, nothing to show");
  const device = ins.mark.device;
  const mine = (t) => !device || t.device === device;
  console.log(`  inspect: first violation ${describeViolation(ins.mark)}`);
  console.log(`  traces of ${device ?? "all devices"} before it (newest last):`);
  for (const t of ins.before.filter(mine).slice(-BEFORE_SHOWN)) console.log(formatTrace(t));
  console.log("  and after it:");
  for (const t of ins.after.filter(mine).slice(0, AFTER_SHOWN)) console.log(formatTrace(t));
}

async function replay(args, variant, faults, overrides) {
  const seed = Number(args.replay);
  const run = await runSeed({ scenario: args.scenario, variant, faults, seed, days: args.days ? Number(args.days) : undefined, overrides, trace: args.trace, inspect: Boolean(args.inspect) });
  console.log(`replay ${args.scenario}/${variant.name}/${faults} seed ${seed}: ${run.violations.length} violations, trace ${run.traceHash.slice(0, 12)}`);
  if (args.verbose) {
    for (const e of run.actionLog) console.log(`  #${e.n} t=+${((e.t - Date.UTC(2026, 0, 5, 9)) / 1000).toFixed(0)}s ${e.applied ? "" : "(skipped) "}${formatAction(e.action)}${e.error ? ` ERROR ${e.error}` : ""}`);
  }
  for (const v of run.violations.slice(0, args.verbose ? 20 : 5)) console.log(`  ${describeViolation(v)}${v.stack ? `
      ${v.stack}` : ""}`);
  console.log(`  applied ${JSON.stringify(run.counts.applied)} skipped ${JSON.stringify(run.counts.skipped)} engineErrors ${JSON.stringify(run.engineErrors)}`);
  if (run.metrics) console.log(`  metrics ${JSON.stringify(run.metrics)}`);
  if (args.inspect) printInspection(run);
  return run.violations.length > 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return printList();
  if (!WORKLOADS[args.scenario]) throw new Error(`unknown scenario ${args.scenario} (known: ${WORKLOAD_NAMES.join(", ")})`);
  const overrides = parseOverrides(args.option);
  const variants = names(args.variant, VARIANT_NAMES).map(getVariant);
  const faultList = names(args.faults, PROFILE_NAMES);
  let anyViolation = false;

  if (args.replay !== undefined) {
    for (const v of variants) for (const f of faultList) anyViolation = (await replay(args, v, f, overrides)) || anyViolation;
    process.exitCode = anyViolation ? 1 : 0;
    return;
  }

  const seeds = parseSeeds(args.seeds);
  const outDir = join(ROOT, "results");
  const when = stamp();
  for (const variant of variants) {
    const probe = await probeVariant(variant);
    if (!probe.available) {
      console.log(`${variant.name.padEnd(24)} not available (${probe.reason})`);
      continue;
    }
    const cells = {};
    for (const faults of faultList) {
      const cell = await runCell(args, variant, faults, seeds, overrides);
      cells[faults] = cell;
      const props = Object.entries(cell.byProperty).map(([p, n]) => `${p}:${n}`).join(" ") || "none";
      const first = cell.failing.slice(0, 5).map((f) => f.seed).join(",");
      console.log(`${variant.name.padEnd(24)} ${args.scenario} ${faults.padEnd(8)} seeds ${seeds.length} failing ${cell.seedsWithViolation} violations ${props}${first ? ` first-failing ${first}` : ""}${variant.expectedUnsafe ? " (expected unsafe)" : ""} wall ${fmtMs(cell.wallMs)} cpu ${fmtMs(cell.cpuMs)}`);
      if (args.scenario !== "short" && cell.runs.length) {
        const s = summarizeMetrics(cell.runs);
        if (s) console.log(`    metrics ${JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, x]) => [k, typeof x === "number" ? Math.round(x * 10) / 10 : x])))}`);
      }
      if (cell.seedsWithViolation) anyViolation = true;
    }
    if (!args["no-write"]) {
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `${when}-${args.scenario}-${variant.name}.json`);
      const body = {
        scenario: args.scenario, variant: variant.name, description: variant.description, options: variant.options, overrides, days: args.days ?? null,
        seeds: args.seeds, results: Object.fromEntries(Object.entries(cells).map(([f, c]) => [f, {
          wallMs: Math.round(c.wallMs), cpuMs: Math.round(c.cpuMs), seedsRun: c.runs.length, seedsWithViolation: c.seedsWithViolation, violationsByProperty: c.byProperty, failing: c.failing, metrics: summarizeMetrics(c.runs), runs: c.runs,
        }])),
      };
      writeFileSync(file, JSON.stringify(body, null, 1));
    }
  }
  process.exitCode = anyViolation ? 1 : 0;
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 2;
});
