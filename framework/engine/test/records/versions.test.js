// Record versions (`_v`) and migrations (S5 part B), with real engines
// syncing through one in-memory folder (test/engine/_harness.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openTable } from "../../src/records/index.js";
import { makeWorld, json } from "../engine/_harness.js";

const FIELDS = { title: "latest", room: "ask", priority: "ask", status: "latest" };
const V1 = { version: 1, fields: FIELDS };
const V2 = { version: 2, fields: FIELDS };
// Version 1 -> 2 adds two fields with defaults, one of them an ask field.
const MIGRATIONS = { 1: (r) => ({ ...r, status: r.status ?? "open", priority: r.priority ?? "normal" }) };

const TABLES = { notes: "yjs", other: "yjs" };
const SYNC_MS = 60000;

// Engines are created through device(); remember each one's id for openTable.
const ids = new WeakMap();
async function device(w, id) {
  const engine = await w.device(id);
  ids.set(engine, id);
  return engine;
}

function open(engine, name, schema, migrations) {
  const deviceId = ids.get(engine);
  return openTable({ doc: engine.table(name), schema, migrations, deviceId, user: deviceId.split("-")[0], clock: { now: () => 1000 } });
}

async function pair() {
  const w = await makeWorld({ tables: TABLES });
  const a = await device(w, "harry-aaaaaaaa");
  const b = await device(w, "sam-bbbbbbbb");
  return { w, a, b };
}

const countUpdates = (doc) => {
  let n = 0;
  doc.on("update", () => { n++; });
  return () => n;
};

describe("record versions and migrations", () => {
  it("an app at version 1 opening a table written at version 2: write throws SchemaTooNew, read works, other tables still write", async () => {
    const { w, a, b } = await pair();
    open(b, "notes", V2, MIGRATIONS).put("r1", { title: "New", status: "done", priority: "high" });
    await w.run([a, b], SYNC_MS);

    const oldNotes = open(a, "notes", V1);
    assert.throws(() => oldNotes.put("r1", { title: "x" }), { name: "SchemaTooNew" });
    assert.throws(() => oldNotes.put("r2", { title: "x" }), { name: "SchemaTooNew" });
    assert.deepEqual(oldNotes.get("r1").fields, { priority: "high", status: "done", title: "New" });
    assert.deepEqual(oldNotes.list().map((r) => r.id), ["r1"]);

    open(a, "other", V1).put("o1", { title: "still works" });
    await w.run([a, b], SYNC_MS);
    assert.equal(open(b, "other", V1).get("o1").fields.title, "still works");
  });

  it("a record migrated on device A equals the view on unmigrated device B after sync", async () => {
    const { w, a, b } = await pair();
    open(a, "notes", V1).put("r1", { title: "One", room: "Alpha" });
    await w.run([a, b], SYNC_MS);

    const aNotes = open(a, "notes", V2, MIGRATIONS);
    const bNotes = open(b, "notes", V2, MIGRATIONS);
    const bUpdates = countUpdates(b.table("notes"));
    const expected = { priority: "normal", room: "Alpha", status: "open", title: "One" };
    assert.deepEqual(bNotes.get("r1").fields, expected, "B reads the record migrated in memory");
    assert.deepEqual(bNotes.list()[0].fields, expected);
    assert.equal(bNotes.field("r1", "status").value, "open");
    assert.equal(bUpdates(), 0, "reading writes nothing");

    aNotes.put("r1", { title: "Edited" });
    assert.deepEqual(aNotes.get("r1").fields, { ...expected, title: "Edited" });
    await w.run([a, b], SYNC_MS);
    assert.deepEqual(bNotes.get("r1"), aNotes.get("r1"));
    assert.deepEqual(json(a), json(b));
    assert.equal(a.table("notes").getMap("records").get("r1\u001f_v"), 2, "put writes _v");
  });

  it("the same record migrated on A and B at once: equal JSON and zero conflicts, ask field included", async () => {
    const { w, a, b } = await pair();
    open(a, "notes", V1).put("r1", { title: "One", room: "Alpha" });
    await w.run([a, b], SYNC_MS);

    const aNotes = open(a, "notes", V2, MIGRATIONS);
    const bNotes = open(b, "notes", V2, MIGRATIONS);
    aNotes.put("r1", { title: "From A" });
    bNotes.put("r1", { extra: "From B" });
    await w.run([a, b], SYNC_MS);

    assert.deepEqual(json(a), json(b));
    for (const t of [aNotes, bNotes]) {
      assert.deepEqual(t.conflicts(), []);
      assert.equal(t.field("r1", "priority").conflict, null);
      assert.equal(t.get("r1").fields.priority, "normal");
      assert.equal(t.get("r1").fields.status, "open");
      assert.equal(t.get("r1").fields.room, "Alpha");
    }
  });

  it("a version 1 device's late write, made before it saw version 2, is migrated on read by the others", async () => {
    const { w, a, b } = await pair();
    const c = await device(w, "kim-cccccccc");
    open(a, "notes", V1).put("r1", { title: "One" });
    await w.run([a, b, c], SYNC_MS);

    // B upgrades and writes; A has not seen it yet and writes at version 1.
    open(b, "notes", V2, MIGRATIONS).put("r2", { title: "Two" });
    const aOld = open(a, "notes", V1);
    aOld.put("r3", { title: "Late", room: "Beta" });
    aOld.put("r1", { title: "One edited" });
    await w.run([a, b, c], SYNC_MS);

    for (const t of [open(b, "notes", V2, MIGRATIONS), open(c, "notes", V2, MIGRATIONS)]) {
      assert.deepEqual(t.get("r3").fields, { priority: "normal", room: "Beta", status: "open", title: "Late" });
      assert.deepEqual(t.get("r1").fields, { priority: "normal", status: "open", title: "One edited" });
    }
    assert.throws(() => aOld.put("r4", { title: "x" }), { name: "SchemaTooNew" }, "A is blocked once it sees version 2");
  });
});

describe("record version rules", () => {
  const solo = async () => {
    const w = await makeWorld({ tables: TABLES });
    return device(w, "harry-aaaaaaaa");
  };

  it("_v is reserved and never shown as a field", async () => {
    const a = await solo();
    const t = open(a, "notes", V2, MIGRATIONS);
    assert.throws(() => t.put("r1", { _v: 3 }), TypeError);
    t.put("r1", { title: "x" });
    assert.equal("_v" in t.get("r1").fields, false);
  });

  it("a record with no _v is version 1", async () => {
    const a = await solo();
    // A record written before records carried a version.
    a.table("notes").getMap("records").set("old\u001ftitle", "Legacy");
    const t = open(a, "notes", V2, MIGRATIONS);
    assert.deepEqual(t.get("old").fields, { priority: "normal", status: "open", title: "Legacy" });
  });

  it("a missing step changes nothing; later steps still run", async () => {
    const a = await solo();
    open(a, "notes", V1).put("r1", { title: "x" });
    const v3 = { version: 3, fields: FIELDS };
    const t = open(a, "notes", v3, { 2: (r) => ({ ...r, status: "v3" }) });
    assert.deepEqual(t.get("r1").fields, { status: "v3", title: "x" });
  });

  it("put writes back only migrated fields whose value changed", async () => {
    const a = await solo();
    open(a, "notes", V1).put("r1", { title: "x", status: "done" });
    const doc = a.table("notes");
    const written = [];
    doc.getMap("records").observe((ev) => { for (const k of ev.keysChanged) written.push(k); });
    open(a, "notes", V2, MIGRATIONS).put("r1", { room: "A" });
    assert.deepEqual(written.map((k) => k.split("\u001f")[1]).sort(), ["_v", "priority", "room"]);
  });
});
