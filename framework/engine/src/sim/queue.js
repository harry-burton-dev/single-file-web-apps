// Time-ordered event queue. Events are delivered in (at, seq) order, so ties
// are broken by scheduling order. push() takes an `orderKey`: events sharing a
// key never overtake each other (their due time is raised to the previous
// event's), which keeps the history of a single path in order while different
// paths stay independent.

export function createEventQueue() {
  // Sorted latest-first so the next event is cheap to pop from the end.
  const items = [];
  const tails = new Map();
  let nextSeq = 0;

  const isLater = (a, b) => a.at > b.at || (a.at === b.at && a.seq > b.seq);

  function insert(event) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (isLater(items[mid], event)) lo = mid + 1;
      else hi = mid;
    }
    items.splice(lo, 0, event);
  }

  return {
    push(event, dueAt, orderKey) {
      const at = Math.max(dueAt, tails.get(orderKey) ?? dueAt);
      tails.set(orderKey, at);
      const scheduled = { ...event, at, seq: nextSeq++ };
      insert(scheduled);
      return scheduled;
    },
    // Re-insert an event that was held back (offline device); keeps its seq.
    requeue(event, notBefore) {
      event.at = Math.max(event.at, notBefore);
      insert(event);
    },
    popDue(limit) {
      const next = items[items.length - 1];
      return next && next.at <= limit ? items.pop() : undefined;
    },
    clear() {
      items.length = 0;
      tails.clear();
    },
    get size() {
      return items.length;
    },
  };
}
