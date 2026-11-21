// Manual clock. Time only moves when someone calls advance(); there is no
// connection to real time. Date.UTC is pure arithmetic (no current time read).

export const EPOCH_MS = Date.UTC(2026, 0, 5, 9, 0, 0);

export function createClock(startMs = EPOCH_MS) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError(`advance(ms) needs ms >= 0, got ${ms}`);
      current += ms;
      return current;
    },
  };
}
