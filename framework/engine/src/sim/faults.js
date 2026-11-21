// Fault configuration. Everything defaults to OFF: lags are zero and every
// probability is 0. Pass overrides to createWorld({ faults }) or
// world.setFaults(overrides); anything not mentioned keeps its default.
//
//   uploadLagMs, downloadLagMs   [min, max] ms (a single number n means [n, n])
//   partialArrival               { probability, durationMs: [min, max] }
//   conflictCopy                 { probability }
//   crswap                       { probability, leftBehindProbability }
//   writeFailure                 { probability }
//   readFailure                  { probability }
//   junk                         { probability }

export const DEFAULT_FAULTS = Object.freeze({
  uploadLagMs: [0, 0],
  downloadLagMs: [0, 0],
  partialArrival: { probability: 0, durationMs: [1000, 10000] },
  conflictCopy: { probability: 0 },
  crswap: { probability: 0, leftBehindProbability: 0.25 },
  writeFailure: { probability: 0 },
  readFailure: { probability: 0 },
  junk: { probability: 0 },
});

function normalizeRange(value, label) {
  const range = typeof value === "number" ? [value, value] : value;
  const valid =
    Array.isArray(range) &&
    range.length === 2 &&
    Number.isInteger(range[0]) &&
    Number.isInteger(range[1]) &&
    range[0] >= 0 &&
    range[1] >= range[0];
  if (!valid) throw new RangeError(`faults.${label} must be [min, max] with 0 <= min <= max`);
  return [range[0], range[1]];
}

function checkProbability(value, label) {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new RangeError(`faults.${label} must be a probability in [0, 1]`);
  }
  return value;
}

function mergeGroup(name, defaults, overrides) {
  const unknown = Object.keys(overrides).filter((key) => !(key in defaults));
  if (unknown.length) throw new Error(`unknown fault option faults.${name}.${unknown[0]}`);
  const merged = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    merged[key] = key === "durationMs"
      ? normalizeRange(value, `${name}.${key}`)
      : checkProbability(value, `${name}.${key}`);
  }
  return merged;
}

export function resolveFaults(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !(key in DEFAULT_FAULTS));
  if (unknown.length) throw new Error(`unknown fault option faults.${unknown[0]}`);
  const resolved = {};
  for (const [name, defaults] of Object.entries(DEFAULT_FAULTS)) {
    const given = overrides[name];
    if (name.endsWith("LagMs")) resolved[name] = normalizeRange(given ?? defaults, name);
    else resolved[name] = mergeGroup(name, defaults, given ?? {});
  }
  return resolved;
}
