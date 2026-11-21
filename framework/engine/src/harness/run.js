// Run one (scenario, variant, faults, seed) and return everything the CLI and
// the tests need. Pure with respect to its inputs: no real time is read here.
import { createScenario, formatAction } from "./scenario.js";
import { WORKLOADS } from "./workloads.js";
import { checkDeterminism, checkObservation, violation } from "./checks.js";
import { getVariant } from "./variants.js";
import { resolveProfile } from "./faults.js";

// Errors thrown outside any awaited call (a forgotten promise) are P7 too.
let rejectionSink = null;
const onRejection = (reason) => rejectionSink?.push(reason);

export async function runSeed({ scenario = "short", variant = "baseline", faults = "none", seed = 1, days, overrides = {}, steps, trace = "full", keepTraces = false, inspect = false } = {}) {
  const workload = WORKLOADS[scenario];
  if (!workload) throw new Error(`unknown scenario ${scenario}`);
  const v = typeof variant === "string" ? getVariant(variant) : variant;
  const profile = resolveProfile(faults);
  const days_ = days ?? workload.defaultDays;
  const sc = await createScenario({ seed, variant: v, faults: profile, optionOverrides: overrides, traceLevel: trace, inspect, ...workload.create() });
  const rejections = [];
  rejectionSink = rejections;
  process.on("unhandledRejection", onRejection);
  let result;
  try {
    const plan = workload.plan(seed, profile, { ...(days_ ? { days: days_ } : {}), ...(steps ? { steps } : {}) });
    for (const action of plan) await sc.apply(action);
    await new Promise((resolve) => setImmediate(resolve)); // let stray rejections surface
    result = await sc.finish();
  } finally {
    process.off("unhandledRejection", onRejection);
    rejectionSink = null;
  }
  for (const reason of rejections) sc.violate("P7", { message: `unhandled promise rejection: ${reason?.name}: ${reason?.message}` });
  return {
    scenario, variant: v.name, faults: profile.name, seed, days: days_ ?? null,
    violations: sc.violations, metrics: result.metrics, traceHash: result.traceHash, content: result.contentHash,
    endedAtMs: result.endedAt, actionLog: sc.actionLog, counts: sc.counts, engineErrors: sc.engineErrors, trace,
    ...(inspect ? { inspect: sc.inspect } : {}),
    ...(keepTraces ? { engineTraces: sc.devices.filter((d) => d.session).map((d) => ({ device: d.id, traces: d.session.engine.traces() })) } : {}),
  };
}

/** P12: run twice, compare. Returns the first run with any P12 violations added. */
export async function runSeedTwice(params) {
  const a = await runSeed(params);
  const b = await runSeed(params);
  a.violations = [...a.violations, ...checkDeterminism(a, b)];
  return a;
}

/** P15: the same seed with tracing off and on must leave the same log and content. */
export async function runSeedObserved(params) {
  const level = params.trace ?? "full";
  const other = level === "off" ? "full" : "off";
  const a = await runSeed({ ...params, trace: level });
  const b = await runSeed({ ...params, trace: other });
  a.violations = [...a.violations, ...checkObservation(a, b, { levels: [level, other] })];
  return a;
}

export const describeViolation = (v) =>
  `${v.property} t=${v.at}${v.device ? ` ${v.device}` : ""}${v.table ? ` [${v.table}]` : ""}${v.path ? ` ${v.path}` : ""}: ${v.message}`;

export { formatAction, violation };
