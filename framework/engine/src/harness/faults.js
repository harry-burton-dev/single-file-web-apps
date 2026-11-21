// Fault profiles for the harness.
//
// EVERY NUMBER HERE IS AN ASSUMPTION, not a measurement (spec section 5). They
// are chosen to be plausible for a OneDrive-synced folder (documented lags of
// seconds to minutes) and increasingly nasty. Real behaviour needs recorded
// traces.
//
// A profile is { name, description, sim, behaviour }:
//   sim        overrides for the simulator's fault config (src/sim/faults.js)
//   behaviour  hints for the workload generators (not the simulator):
//                offlineWeight  relative frequency of offline/online actions
//                offlineMs      [min, max] length of an offline period
//                crashWeight, wipeWeight, injectWeight  likewise
//                injectCopies   injected files may also be exact conflict copies of chunks
//                outageWeight   relative frequency of a sustained write outage (0 = never);
//                outageMs       [min, max] length of one (every write by every device fails)
//              A profile with outageWeight is never picked by a workload's random
//              fault-profile switches; it only applies when named.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const ROUGH_SIM = Object.freeze({
  uploadLagMs: [SECOND, 30 * SECOND],
  downloadLagMs: [2 * SECOND, 2 * MINUTE],
  partialArrival: { probability: 0.1, durationMs: [SECOND, 20 * SECOND] },
  crswap: { probability: 0.3, leftBehindProbability: 0.25 },
  junk: { probability: 0.05 },
  readFailure: { probability: 0.05 },
  writeFailure: { probability: 0.05 },
});

export const PROFILES = Object.freeze({
  none: Object.freeze({
    name: "none",
    description: "no faults: zero lag, nothing fails",
    sim: Object.freeze({}),
    behaviour: Object.freeze({ offlineWeight: 1, offlineMs: [MINUTE, 10 * MINUTE], crashWeight: 1, wipeWeight: 1, injectWeight: 0 }),
  }),
  lag: Object.freeze({
    name: "lag",
    description: "realistic lags only: upload 2-60 s, download 5-300 s",
    sim: Object.freeze({ uploadLagMs: [2 * SECOND, MINUTE], downloadLagMs: [5 * SECOND, 5 * MINUTE] }),
    behaviour: Object.freeze({ offlineWeight: 1, offlineMs: [MINUTE, 10 * MINUTE], crashWeight: 1, wipeWeight: 1, injectWeight: 0 }),
  }),
  rough: Object.freeze({
    name: "rough",
    description: "lags plus partial arrival, crswap, junk, read and write failures at moderate rates",
    sim: ROUGH_SIM,
    behaviour: Object.freeze({ offlineWeight: 2, offlineMs: [MINUTE, 20 * MINUTE], crashWeight: 2, wipeWeight: 1, injectWeight: 2 }),
  }),
  outage: Object.freeze({
    name: "outage",
    description: "rough faults, deliberate conflict copies of chunk files, and write outages of 10-60 minutes",
    sim: ROUGH_SIM,
    behaviour: Object.freeze({ offlineWeight: 2, offlineMs: [MINUTE, 20 * MINUTE], crashWeight: 2, wipeWeight: 1, injectWeight: 4, injectCopies: true, outageWeight: 3, outageMs: [10 * MINUTE, HOUR] }),
  }),
  hostile: Object.freeze({
    name: "hostile",
    description: "high fault rates, lags up to hours, offline periods, conflict copies",
    sim: Object.freeze({
      uploadLagMs: [SECOND, 2 * HOUR],
      downloadLagMs: [5 * SECOND, 4 * HOUR],
      partialArrival: { probability: 0.3, durationMs: [SECOND, 10 * MINUTE] },
      conflictCopy: { probability: 0.3 },
      crswap: { probability: 0.5, leftBehindProbability: 0.5 },
      junk: { probability: 0.2 },
      readFailure: { probability: 0.2 },
      writeFailure: { probability: 0.25 },
    }),
    behaviour: Object.freeze({ offlineWeight: 4, offlineMs: [10 * MINUTE, 6 * HOUR], crashWeight: 3, wipeWeight: 2, injectWeight: 4 }),
  }),
});

export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

/** A profile name or a profile object -> profile object. */
export function resolveProfile(spec = "none") {
  if (typeof spec === "string") {
    const profile = PROFILES[spec];
    if (!profile) throw new Error(`unknown fault profile "${spec}" (known: ${PROFILE_NAMES.join(", ")})`);
    return profile;
  }
  return { description: "custom", behaviour: PROFILES.none.behaviour, ...spec, sim: spec.sim ?? {} };
}
