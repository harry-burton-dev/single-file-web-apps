// Who tells the user about an update check (ADR-0005 section 6). Once the
// running app subscribes through onUpdate, each result goes to it and the
// bootstrap draws nothing. With no subscriber the bootstrap draws its own note,
// so an app that fails before it mounts is still covered. A subscriber that
// arrives after a check hears its result, and the bootstrap's note is taken down.
export function updateReporter({ draw, clear }) {
  const listeners = new Set();
  let last = null;
  return {
    report(result) {
      last = result;
      if (listeners.size === 0) return draw(result);
      for (const listener of listeners) listener(result);
    },
    subscribe(listener) {
      listeners.add(listener);
      if (last) {
        clear();
        listener(last);
      }
      return () => void listeners.delete(listener);
    },
  };
}
