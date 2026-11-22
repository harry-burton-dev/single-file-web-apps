import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { makeId, newId } from "../../src/records/index.js";
import { createWorld, jsonOf, variants } from "./harness.js";

const SCHEMA = { version: 1, fields: { title: "latest", room: "ask", time: "ask", body: "text" } };
const byDevice = (cands) => Object.fromEntries(cands.map((c) => [c.device, c]));

for (const variant of await variants()) {
  describe(`record layer on ${variant.name}`, () => {
    const world = () => createWorld(variant, SCHEMA);

    it("put/get/list/remove/restore", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      assert.equal(a.table.get("r1"), undefined);
      a.table.put("r1", { title: "One", extra: 5 });
      a.table.put("r2", { title: "Two" });
      assert.deepEqual(a.table.get("r1"), { id: "r1", deleted: false, fields: { extra: 5, title: "One" }, conflicts: {} });
      assert.deepEqual(a.table.list().map((r) => r.id), ["r1", "r2"]);
      a.table.remove("r1");
      assert.equal(a.table.get("r1").deleted, true);
      assert.deepEqual(a.table.list().map((r) => r.id), ["r2"]);
      assert.deepEqual(a.table.list({ includeDeleted: true }).map((r) => r.id), ["r1", "r2"]);
      a.table.put("r1", { title: "Edited" });
      assert.equal(a.table.get("r1").deleted, true, "put must not undelete");
      assert.equal(a.table.get("r1").fields.title, "Edited");
      a.table.restore("r1");
      assert.equal(a.table.get("r1").deleted, false);
    });

    it("every write is reported as a local update and replicates", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r1", { title: "x", room: "A", body: "hello" });
      a.table.remove("r1");
      assert.ok(a.outbox.length >= 2);
      w.syncAll();
      assert.equal(b.outbox.length, 0, "remote applies must not be reported");
      assert.deepEqual(b.table.get("r1"), a.table.get("r1"));
      assert.equal(jsonOf(a), jsonOf(b));
    });

    it("latest: concurrent writes converge to one value on all replicas", () => {
      const w = world();
      const [a, b, c] = ["harry-aaaaaaaa", "sam-bbbbbbbb", "kim-cccccccc"].map((d) => w.add(d));
      a.table.put("r", { title: "A" });
      b.table.put("r", { title: "B" });
      c.table.put("r", { title: "C" });
      w.syncAll();
      const values = [a, b, c].map((r) => r.table.get("r").fields.title);
      assert.equal(new Set(values).size, 1);
      assert.ok(["A", "B", "C"].includes(values[0]));
      assert.deepEqual(a.table.get("r").conflicts, {});
    });

    it("ask (P10): two concurrent writers => both candidates everywhere with attribution", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      w.time.t = 100; a.table.put("r", { room: "Alpha" });
      w.time.t = 200; b.table.put("r", { room: "Beta" });
      w.syncAll();
      const provisional = [];
      for (const r of [a, b]) {
        const f = r.table.field("r", "room");
        assert.equal(f.conflict.length, 2);
        const c = byDevice(f.conflict);
        assert.deepEqual(
          { v: c["harry-aaaaaaaa"].value, u: c["harry-aaaaaaaa"].user, t: c["harry-aaaaaaaa"].writtenAt }, { v: "Alpha", u: "harry", t: 100 });
        assert.deepEqual(
          { v: c["sam-bbbbbbbb"].value, u: c["sam-bbbbbbbb"].user, t: c["sam-bbbbbbbb"].writtenAt }, { v: "Beta", u: "sam", t: 200 });
        provisional.push(f.value);
        assert.deepEqual(r.table.get("r").conflicts.room.map((x) => x.value).sort(), ["Alpha", "Beta"]);
        assert.deepEqual(r.table.conflicts().map((x) => [x.id, x.field]), [["r", "room"]]);
      }
      assert.deepEqual(provisional, ["Beta", "Beta"], "latest writtenAt is provisional");
    });

    it("ask: equal writtenAt breaks the tie by device id, identically everywhere", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r", { room: "Alpha" });
      b.table.put("r", { room: "Beta" });
      w.syncAll();
      assert.equal(a.table.field("r", "room").value, b.table.field("r", "room").value);
    });

    it("ask: three concurrent writers keep three candidates", () => {
      const w = world();
      const reps = ["harry-aaaaaaaa", "sam-bbbbbbbb", "kim-cccccccc"].map((d) => w.add(d));
      reps.forEach((r, i) => { w.time.t = 10 + i; r.table.put("r", { room: `R${i}` }); });
      w.syncAll();
      for (const r of reps) {
        assert.deepEqual(r.table.field("r", "room").conflict.map((c) => c.value).sort(), ["R0", "R1", "R2"]);
        assert.equal(r.table.field("r", "room").value, "R2");
      }
    });

    it("ask: a writer who had seen the other makes no conflict", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r", { room: "Alpha" });
      w.syncAll();
      b.table.put("r", { room: "Beta" });
      w.syncAll();
      for (const r of [a, b]) {
        assert.equal(r.table.field("r", "room").conflict, null);
        assert.equal(r.table.field("r", "room").value, "Beta");
      }
      // and back again from the first writer
      a.table.put("r", { room: "Gamma" });
      w.syncAll();
      for (const r of [a, b]) assert.deepEqual([r.table.field("r", "room").conflict, r.table.field("r", "room").value], [null, "Gamma"]);
    });

    it("ask: resolve clears the conflict everywhere; later writes stay clear", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      const c = w.add("kim-cccccccc");
      a.table.put("r", { room: "Alpha" });
      b.table.put("r", { room: "Beta" });
      w.syncAll();
      assert.ok(c.table.field("r", "room").conflict);
      w.time.t += 10;
      c.table.field("r", "room").resolve("Gamma");
      w.syncAll();
      for (const r of [a, b, c]) {
        const f = r.table.field("r", "room");
        assert.equal(f.conflict, null);
        assert.equal(f.value, "Gamma");
        assert.deepEqual(r.table.conflicts(), []);
      }
      a.table.put("r", { room: "Delta" });
      w.syncAll();
      for (const r of [a, b, c]) assert.deepEqual([r.table.field("r", "room").conflict, r.table.field("r", "room").value], [null, "Delta"]);
    });

    it("ask: two concurrent different resolutions make a new conflict", () => {
      const w = world();
      const [a, b, c] = ["harry-aaaaaaaa", "sam-bbbbbbbb", "kim-cccccccc"].map((d) => w.add(d));
      a.table.put("r", { room: "Alpha" });
      b.table.put("r", { room: "Beta" });
      w.syncAll();
      w.time.t += 10; a.table.field("r", "room").resolve("X");
      w.time.t += 10; b.table.field("r", "room").resolve("Y");
      w.syncAll();
      for (const r of [a, b, c]) {
        assert.deepEqual(r.table.field("r", "room").conflict.map((x) => x.value).sort(), ["X", "Y"]);
      }
      // resolving that one clears it
      w.time.t += 10; c.table.field("r", "room").resolve("Z");
      w.syncAll();
      for (const r of [a, b, c]) assert.deepEqual([r.table.field("r", "room").conflict, r.table.field("r", "room").value], [null, "Z"]);
    });

    it("ask: one device writing twice before syncing leaves a single candidate from it", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r", { room: "A1" });
      a.table.put("r", { room: "A2" });
      b.table.put("r", { room: "B1" });
      w.syncAll();
      assert.deepEqual(a.table.field("r", "room").conflict.map((x) => x.value).sort(), ["A2", "B1"]);
    });

    it("text: concurrent edits at different positions both survive", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r", { body: "hello world" });
      w.syncAll();
      a.table.updateText("r", "body", "hello big world");
      b.table.updateText("r", "body", "hello world!");
      w.syncAll();
      assert.equal(a.table.get("r").fields.body, "hello big world!");
      assert.equal(b.table.get("r").fields.body, "hello big world!");
      assert.equal(jsonOf(a), jsonOf(b));
    });

    it("text: updateText on a non-text field is rejected; unchanged text writes nothing", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      assert.throws(() => a.table.updateText("r", "title", "x"), TypeError);
      a.table.put("r", { body: "same" });
      const n = a.outbox.length;
      a.table.updateText("r", "body", "same");
      assert.equal(a.outbox.length, n);
    });

    it("deterministic ids: two devices creating the same record land on one record, fields merged", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      const id = makeId("meeting-1", "item-7");
      assert.equal(id, "meeting-1:item-7");
      a.table.put(id, { title: "From A", room: "RA" });
      b.table.put(id, { extra: "from B", room: "RB" });
      w.syncAll();
      for (const r of [a, b]) {
        const rec = r.table.get(id);
        assert.equal(rec.fields.title, "From A");
        assert.equal(rec.fields.extra, "from B");
        assert.equal(rec.conflicts.room.length, 2);
        assert.equal(r.table.list().length, 1);
      }
      assert.equal(jsonOf(a), jsonOf(b));
    });

    it("concurrent remove and edit: both effects survive", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      a.table.put("r", { title: "t" });
      w.syncAll();
      a.table.remove("r");
      b.table.put("r", { title: "edited" });
      w.syncAll();
      for (const r of [a, b]) assert.deepEqual([r.table.get("r").deleted, r.table.get("r").fields.title], [true, "edited"]);
    });

    it("schema too new blocks writes but not reads", () => {
      const w = world();
      const newer = w.add("harry-aaaaaaaa", "harry", { version: 2, fields: SCHEMA.fields });
      const older = w.add("sam-bbbbbbbb", "sam", { version: 1, fields: SCHEMA.fields });
      newer.table.put("r", { title: "v2 data" });
      assert.equal(newer.table.schemaVersion(), 2);
      assert.equal(older.table.schemaVersion(), undefined);
      older.table.put("local", { title: "before sync" }); // allowed: nothing newer seen yet
      w.syncAll();
      assert.equal(older.table.schemaVersion(), 2);
      assert.equal(older.table.get("r").fields.title, "v2 data");
      assert.ok(older.table.list().length >= 1);
      for (const write of [
        () => older.table.put("x", { title: "no" }),
        () => older.table.remove("r"),
        () => older.table.restore("r"),
        () => older.table.field("r", "room").resolve("v"),
        () => older.table.updateText("r", "body", "t"),
      ]) {
        assert.throws(write, (e) => e.name === "SchemaTooNew" && e.storedVersion === 2 && e.supportedVersion === 1);
      }
    });

    it("writing with a newer schema raises the stored version", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      a.table.put("r", { title: "x" });
      assert.equal(a.table.schemaVersion(), 1);
    });

    it("rejects bad input", () => {
      const a = world().add("harry-aaaaaaaa");
      assert.throws(() => a.table.put("", { title: "x" }), TypeError);
      assert.throws(() => a.table.put("r", { deleted: true }), TypeError);
      assert.throws(() => a.table.put("r", { title: undefined }), TypeError);
      assert.throws(() => a.table.put("r\u001fx", { title: "x" }), TypeError);
    });
    it("batch is one local update", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      const result = a.table.batch(() => {
        a.table.put("r1", { title: "One", room: "A", body: "hi" });
        a.table.put("r2", { title: "Two" });
        a.table.remove("r1");
        a.table.restore("r1");
        return "done";
      });
      assert.equal(result, "done", "batch returns what fn returns");
      assert.equal(a.outbox.length, 1);
      w.syncAll();
      assert.deepEqual(b.table.list(), a.table.list());
    });

    it("batch checks the schema version once, before running fn", () => {
      const w = world();
      const newer = w.add("harry-aaaaaaaa", "harry", { ...SCHEMA, version: 2 });
      const old = w.add("sam-bbbbbbbb");
      newer.table.put("r", { title: "v2" });
      w.syncAll();
      let ran = false;
      assert.throws(() => old.table.batch(() => { ran = true; }), { name: "SchemaTooNew" });
      assert.equal(ran, false);
    });

    it("onChange fires for local and remote", () => {
      const w = world();
      const a = w.add("harry-aaaaaaaa");
      const b = w.add("sam-bbbbbbbb");
      let localCalls = 0;
      let remoteCalls = 0;
      const offA = a.table.onChange(() => localCalls++);
      b.table.onChange(() => remoteCalls++);
      a.table.batch(() => { a.table.put("r1", { title: "x" }); a.table.put("r2", { title: "y" }); });
      assert.equal(localCalls, 1, "one call per batch");
      assert.equal(remoteCalls, 0);
      w.deliver(a, b);
      assert.equal(remoteCalls, 1, "listener is called after a remote apply");
      assert.equal(b.table.get("r2").fields.title, "y", "the change is readable when the listener runs");
      offA();
      a.table.put("r3", { title: "z" });
      assert.equal(localCalls, 1, "unsubscribed listener is not called");
    });

    it("list equals per-record get for random data", () => {
      const devices = ["harry-aaaaaaaa", "sam-bbbbbbbb", "kim-cccccccc"];
      const ids = ["r1", "r2", "r3", "r4"];
      const fieldValue = fc.oneof(
        fc.record({ title: fc.string({ maxLength: 3 }) }),
        fc.record({ room: fc.constantFrom("A", "B", "C") }),
        fc.record({ time: fc.integer({ min: 0, max: 3 }) }),
        fc.record({ body: fc.string({ maxLength: 4 }) }),
        fc.record({ extra: fc.integer() }),
      );
      const op = fc.oneof(
        fc.record({ t: fc.constant("put"), d: fc.nat(2), id: fc.constantFrom(...ids), f: fieldValue }),
        fc.record({ t: fc.constant("remove"), d: fc.nat(2), id: fc.constantFrom(...ids) }),
        fc.record({ t: fc.constant("restore"), d: fc.nat(2), id: fc.constantFrom(...ids) }),
        fc.record({ t: fc.constant("sync"), d: fc.nat(2), to: fc.nat(2) }),
      );
      fc.assert(fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const w = world();
        const rs = devices.map((d) => w.add(d));
        for (const o of ops) {
          w.time.t += 1;
          const r = rs[o.d];
          if (o.t === "put") r.table.put(o.id, o.f);
          else if (o.t === "remove") r.table.remove(o.id);
          else if (o.t === "restore") r.table.restore(o.id);
          else if (o.d !== o.to) w.deliver(r, rs[o.to]);
        }
        for (const r of rs) {
          const all = r.table.list({ includeDeleted: true });
          const expected = ids.map((id) => r.table.get(id)).filter(Boolean);
          assert.deepEqual(all, expected);
          assert.deepEqual(r.table.list(), expected.filter((x) => !x.deleted));
          // field() reads each field with a full key scan: the reference for the grouped read.
          for (const rec of all) {
            for (const [name, value] of Object.entries(rec.fields)) {
              const f = r.table.field(rec.id, name);
              assert.deepEqual(value, f.value);
              assert.deepEqual(rec.conflicts[name] ?? null, f.conflict);
            }
          }
        }
      }), { numRuns: 200 });
    });
  });
}

describe("ids", () => {
  it("makeId joins parts and newId uses injected randomness", () => {
    assert.equal(makeId("a", "b", "c"), "a:b:c");
    assert.throws(() => makeId());
    assert.throws(() => makeId("a", ""));
    assert.equal(newId({ bytes: (n) => new Uint8Array(n).fill(255) }), "ffffffffffffffff");
  });
});
