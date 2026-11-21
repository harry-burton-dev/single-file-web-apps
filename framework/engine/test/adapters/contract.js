// Adapter contract tests (spec section 2.4), shared by every adapter.
//   runAdapterContract(name, makeAdapter, ops)
//   ops.set(adapter, doc, key, value): one LOCAL edit that writes `key` at top level
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

export function runAdapterContract(name, makeAdapter, ops) {
  // A replica remembers every local update it produced.
  function replica(adapter) {
    const doc = adapter.create();
    const local = [];
    adapter.onLocalUpdate(doc, (bytes) => local.push(bytes));
    return { doc, local };
  }
  const edit = (adapter, r, key, value) => ops.set(adapter, r.doc, key, value);
  const json = (adapter, r) => JSON.stringify(adapter.toJSON(r.doc));

  describe(`adapter contract: ${name}`, () => {
    it("reports local changes as Uint8Array and does not report remote applies", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      const b = replica(adapter);
      edit(adapter, a, "k", 1);
      assert.equal(a.local.length, 1);
      assert.ok(a.local[0] instanceof Uint8Array);
      adapter.applyUpdate(b.doc, a.local[0], "remote");
      assert.equal(b.local.length, 0);
      assert.equal(json(adapter, b), json(adapter, a));
    });

    it("unsubscribe stops reports", () => {
      const adapter = makeAdapter();
      const doc = adapter.create();
      const seen = [];
      const off = adapter.onLocalUpdate(doc, (u) => seen.push(u));
      ops.set(adapter, doc, "a", 1);
      off();
      ops.set(adapter, doc, "b", 2);
      assert.equal(seen.length, 1);
    });

    it("applying the same update twice is harmless", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      const b = replica(adapter);
      edit(adapter, a, "k", 1);
      adapter.applyUpdate(b.doc, a.local[0], "remote");
      const once = json(adapter, b);
      adapter.applyUpdate(b.doc, a.local[0], "remote");
      assert.equal(json(adapter, b), once);
    });

    it("applying updates in reverse order gives the same result", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      edit(adapter, a, "k", 1);
      edit(adapter, a, "k", 2);
      edit(adapter, a, "j", 3);
      const b = replica(adapter);
      for (const u of [...a.local].reverse()) adapter.applyUpdate(b.doc, u, "remote");
      assert.equal(json(adapter, b), json(adapter, a));
    });

    it("an update with missing dependencies is held, then takes effect", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      edit(adapter, a, "k", 1);
      edit(adapter, a, "j", 2);
      const b = replica(adapter);
      const before = json(adapter, b);
      adapter.applyUpdate(b.doc, a.local[1], "remote");
      assert.equal(json(adapter, b), before, "dependent update must not show yet");
      adapter.applyUpdate(b.doc, a.local[0], "remote");
      assert.equal(json(adapter, b), json(adapter, a));
    });

    it("a snapshot applied on top of existing state is harmless", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      edit(adapter, a, "k", 1);
      edit(adapter, a, "j", 2);
      const b = replica(adapter);
      adapter.applyUpdate(b.doc, a.local[0], "remote"); // partial overlap
      adapter.applyUpdate(b.doc, adapter.snapshot(a.doc), "remote");
      assert.equal(json(adapter, b), json(adapter, a));
      adapter.applyUpdate(b.doc, adapter.snapshot(a.doc), "remote"); // all changes already present
      assert.equal(json(adapter, b), json(adapter, a));
      assert.equal(b.local.length, 0);
    });

    it("a snapshot fills a fresh replica, and later updates from the source still apply", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      edit(adapter, a, "k", 1);
      const b = replica(adapter);
      adapter.applyUpdate(b.doc, adapter.snapshot(a.doc), "remote");
      edit(adapter, a, "k", 2);
      adapter.applyUpdate(b.doc, a.local[1], "remote");
      assert.equal(json(adapter, b), json(adapter, a));
    });

    it("independently created docs are mergeable (same top-level key written on two devices)", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      const b = replica(adapter);
      edit(adapter, a, "x", "from-a");
      edit(adapter, b, "y", "from-b");
      for (const u of a.local) adapter.applyUpdate(b.doc, u, "remote");
      for (const u of b.local) adapter.applyUpdate(a.doc, u, "remote");
      assert.equal(json(adapter, a), json(adapter, b));
      assert.match(json(adapter, a), /from-a/);
      assert.match(json(adapter, a), /from-b/);
    });

    it("toJSON is canonical: keys are sorted", () => {
      const adapter = makeAdapter();
      const a = replica(adapter);
      edit(adapter, a, "b", 1);
      edit(adapter, a, "a", 2);
      const text = json(adapter, a);
      const parsed = JSON.parse(text);
      assert.equal(text, JSON.stringify(sortKeys(parsed)));
    });

    it("compact (if provided) yields fewer updates with the same content", () => {
      const adapter = makeAdapter();
      if (!adapter.compact) return;
      const a = replica(adapter);
      for (let i = 0; i < 5; i++) edit(adapter, a, `k${i}`, i);
      const compacted = adapter.compact(a.local);
      assert.ok(compacted.length < a.local.length);
      const b = replica(adapter);
      for (const u of compacted) adapter.applyUpdate(b.doc, u, "remote");
      assert.equal(json(adapter, b), json(adapter, a));
    });

    it("three replicas with interleaved concurrent edits converge", () => {
      const adapter = makeAdapter();
      const reps = [replica(adapter), replica(adapter), replica(adapter)];
      edit(adapter, reps[0], "shared", "r0");
      edit(adapter, reps[1], "shared", "r1");
      edit(adapter, reps[2], "shared", "r2");
      edit(adapter, reps[0], "only0", 1);
      // r0 -> r1 sync, then more concurrent edits, then full sync
      for (const u of reps[0].local) adapter.applyUpdate(reps[1].doc, u, "remote");
      edit(adapter, reps[1], "shared", "r1b");
      edit(adapter, reps[2], "only2", 2);
      for (const r of reps) for (const o of reps) if (r !== o) for (const u of o.local) adapter.applyUpdate(r.doc, u, "remote");
      assert.equal(json(adapter, reps[0]), json(adapter, reps[1]));
      assert.equal(json(adapter, reps[1]), json(adapter, reps[2]));
    });

    it("property: random interleavings and delivery orders with duplication converge to the oracle", () => {
      const step = fc.oneof(
        fc.record({ t: fc.constant("edit"), r: fc.nat(2), k: fc.constantFrom("a", "b", "c"), v: fc.nat(99) }),
        fc.record({ t: fc.constant("deliver"), to: fc.nat(2), pick: fc.nat(1000) }),
      );
      fc.assert(
        fc.property(fc.array(step, { maxLength: 40 }), fc.array(fc.nat(1000), { maxLength: 200 }), (steps, shuffle) => {
          const adapter = makeAdapter();
          const reps = [replica(adapter), replica(adapter), replica(adapter)];
          const log = []; // every local update, in creation order
          reps.forEach((r) => adapter.onLocalUpdate(r.doc, (u) => log.push(u)));
          let n = 0;
          for (const s of steps) {
            if (s.t === "edit") edit(adapter, reps[s.r], s.k, s.v * 1000 + n++);
            else if (log.length) adapter.applyUpdate(reps[s.to].doc, log[s.pick % log.length], "remote"); // any order, may repeat
          }
          // Final delivery: every update to every replica, shuffled and duplicated.
          const order = log.map((_, i) => i);
          shuffle.forEach((x, i) => {
            if (order.length > 1) { const j = x % order.length; [order[i % order.length], order[j]] = [order[j], order[i % order.length]]; }
          });
          for (const r of reps) {
            for (const i of order) adapter.applyUpdate(r.doc, log[i], "remote");
            for (const i of order.slice(0, 5)) adapter.applyUpdate(r.doc, log[i], "remote");
          }
          const oracle = adapter.create();
          for (const u of log) adapter.applyUpdate(oracle, u, "remote");
          const expected = JSON.stringify(adapter.toJSON(oracle));
          for (const r of reps) assert.equal(JSON.stringify(adapter.toJSON(r.doc)), expected);
        }),
        { numRuns: 150 },
      );
    });
  });
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
