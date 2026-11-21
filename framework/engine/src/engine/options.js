// Option resolution: defaults merged with caller options, validated once.
import { DEFAULT_OPTIONS, LAYOUTS } from "./constants.js";
import { TRACE_LEVELS } from "./tracing.js";

const POSITIVE = ["sealBytes", "quietMs", "maxWaitMs", "minIntervalMs", "scanMs", "statusMs", "ownCheckMs", "retryInitialMs", "retryMaxMs", "maxErrors", "localSnapshotEvery"];

export function resolveOptions(input = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...input,
    schemaVersions: { ...DEFAULT_OPTIONS.schemaVersions, ...(input.schemaVersions ?? {}) },
    compaction: { ...DEFAULT_OPTIONS.compaction, ...(input.compaction ?? {}) },
    trace: { ...DEFAULT_OPTIONS.trace, ...(input.trace ?? {}) },
    health: { ...DEFAULT_OPTIONS.health, ...(input.health ?? {}) },
  };
  if (!LAYOUTS.includes(options.layout)) throw new Error(`unsupported layout: ${options.layout}`);
  if (!["merged", "framed"].includes(options.chunkContent)) throw new Error(`bad chunkContent: ${options.chunkContent}`);
  if (!["all-active", "none"].includes(options.compaction.ackRule)) throw new Error(`bad ackRule: ${options.compaction.ackRule}`);
  if (!TRACE_LEVELS.includes(options.trace.level)) throw new Error(`bad trace.level: ${options.trace.level}`);
  for (const name of ["memoryLimit", "storeLimit", "persistBatch"]) {
    if (!(options.trace[name] > 0)) throw new Error(`option trace.${name} must be positive`);
  }
  for (const name of ["peerActiveWindowMs", "ackTimeoutMs"]) {
    if (!(options.health[name] > 0)) throw new Error(`option health.${name} must be positive`);
  }
  for (const name of POSITIVE) {
    if (!(options[name] > 0)) throw new Error(`option ${name} must be positive`);
  }
  return Object.freeze({ ...options, trace: Object.freeze(options.trace), health: Object.freeze(options.health) });
}
