// A wall clock can jump forward and then be corrected. Every stored absolute
// time the engine compares with "now" (last save, scan, status, retry and
// compaction schedules, pending-edit stamps) would then lie in the future and
// freeze its work until the clock catches up. At the start of each tick a
// stored time that is ahead of the clock is invalid and is clamped to now, so
// the normal intervals apply again from here.

const LAST_KEYS = ["lastSaveAt", "lastScanAt", "lastScanOkAt", "lastStatusAt", "retrySince"];

/** Clamp every future-dated stored time. Mutates ctx.rt and the tables' scheduling fields, as the engine does elsewhere. */
export function clampStoredTimes(ctx, now) {
  const { rt, cfg } = ctx;
  const { retryMaxMs, retryInitialMs, compaction } = cfg.options;
  for (const key of LAST_KEYS) if (rt[key] != null && rt[key] > now) rt[key] = now;
  if (rt.retryAt != null && rt.retryAt > now + retryMaxMs) rt.retryAt = now + retryMaxMs;
  if (Object.values(rt.written).some((w) => w.firstAt > now)) {
    rt.written = Object.fromEntries(Object.entries(rt.written).map(([table, w]) => [table, w.firstAt > now ? { ...w, firstAt: now } : w]));
  }
  for (const T of ctx.tables.values()) {
    for (const entry of T.pending) if (entry.at > now) entry.at = now;
    if (T.compactAt != null && T.compactAt > now + compaction.jitterMs) T.compactAt = now + compaction.jitterMs;
    if (T.compactRetryAt != null && T.compactRetryAt > now + retryInitialMs) T.compactRetryAt = now + retryInitialMs;
  }
}
