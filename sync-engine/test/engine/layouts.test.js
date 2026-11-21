// The two baseline layouts, state-per-device and shared-file, driven through
// the same scenarios. Layout specifics live in LAYOUTS below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, json } from "./_harness.js";
import { open } from "../../src/engine/envelope.js";

const A = "harry-aaaaaaaa";
const S = "sam-bbbbbbbb";
const K = "kim-cccccccc";

const LAYOUTS = {
  "state-per-device": {
    mainPath: (device) => `data/notes/${device}/state.ywb`,
    copyPath: (device) => `data/notes/${device}/state-DESKTOP.ywb`,
    fileName: "state.ywb",
    kind: "state",
  },
  "shared-file": {
    mainPath: () => "data/notes/table.ywb",
    copyPath: () => "data/notes/table-DESKTOP.ywb",
    fileName: "table.ywb",
    kind: "table",
  },
};

const dataWrites = (w) => w.folder.writes.filter((x) => x.path.startsWith("data/"));

for (const [layout, L] of Object.entries(LAYOUTS)) {
  const make = (extra = {}) => makeWorld({ options: { layout, ...extra } });
  const t = (name, fn) => test(`${layout}: ${name}`, fn);

  t("two engines converge on a map and text workload", async () => {
    const w = await make();
    const a = await w.device(A);
    const b = await w.device(S);
    a.table("notes").getMap("m").set("x", 1);
    a.table("notes").getText("t").insert(0, "hello");
    b.table("notes").getMap("m").set("y", 2);
    b.table("notes").getText("t").insert(0, "world");
    await w.run([a, b], 60000);
    assert.deepEqual(json(a), json(b));
    assert.equal(json(a).m.x, 1);
    assert.equal(json(a).m.y, 2);
    assert.equal(json(a).t.length, 10);
    assert.equal(a.status().pending, 0);
    assert.equal(b.status().pending, 0);
  });

  t("three engines converge, see each other's status and agree on the digest", async () => {
    const w = await make();
    const es = [];
    for (const id of [A, S, K]) es.push(await w.device(id));
    es.forEach((e, i) => e.table("notes").getMap("m").set(`k${i}`, i));
    await w.run(es, 90000);
    assert.deepEqual(json(es[0]), json(es[1]));
    assert.deepEqual(json(es[1]), json(es[2]));
    assert.equal(Object.keys(json(es[0]).m).length, 3);
    assert.deepEqual(Object.keys(es[0].status().devices).sort(), [K, S]);
    const digests = Object.values(es[0].status().devices).map((d) => d.tables.notes.digest);
    assert.equal(new Set(digests).size, 1);
    assert.equal(typeof es[0].status().devices[S].lastActiveAt, "number");
  });

  t("received event reports table, device and writtenAt", async () => {
    const w = await make();
    const a = await w.device(A);
    const b = await w.device(S);
    const got = [];
    b.on("received", (e) => got.push(e));
    a.table("notes").getMap("m").set("x", 1);
    await w.run([a, b], 30000);
    assert.ok(got.length >= 1);
    assert.deepEqual([got[0].table, got[0].device], ["notes", A]);
    assert.equal(typeof got[0].writtenAt, "number");
  });

  t("the file is an envelope holding one whole-document snapshot", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    await a.flush();
    const { meta, updates } = await open({ keys: new Map([[1, w.key]]), bytes: w.folder.read(L.mainPath(A)) });
    assert.equal(meta.kind, L.kind);
    assert.equal(meta.table, "notes");
    assert.equal(meta.device, A);
    assert.equal(updates.length, 1);
    assert.deepEqual(w.folder.paths("data/"), [L.mainPath(A)]);
  });

  t("pending survives a crash: new engine, same store, nothing lost", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    a.table("notes").getText("t").insert(0, "draft");
    await a.settled();
    assert.equal(a.status().pending, 2);
    assert.equal(w.folder.paths("data/").length, 0);
    const again = await w.device(A); // the old engine is simply abandoned
    assert.deepEqual(json(again), { m: { x: 1 }, t: "draft" });
    assert.equal(again.status().pending, 2);
    const b = await w.device(S);
    await w.run([again, b], 30000);
    assert.deepEqual(json(b), { m: { x: 1 }, t: "draft" });
    assert.equal(again.status().pending, 0);
  });

  t("a wiped store refills from the folder", async () => {
    const w = await make();
    const a = await w.device(A);
    const b = await w.device(S);
    a.table("notes").getMap("m").set("x", 1);
    b.table("notes").getText("t").insert(0, "hey");
    await w.run([a, b], 30000);
    w.store(S).wipe();
    const b2 = await w.device(S);
    assert.deepEqual(json(b2), json(a));
    assert.equal(b2.status().pending, 0);
  });

  t("a brand-new device joining later gets everything", async () => {
    const w = await make();
    const es = [await w.device(A), await w.device(S)];
    for (let round = 0; round < 4; round++) {
      es.forEach((e, i) => e.table("notes").getMap("m").set(`r${round}-${i}`, round));
      await w.run(es, 15000);
    }
    const late = await w.device(K);
    assert.deepEqual(json(late), json(es[0]));
    assert.equal(Object.keys(json(late).m).length, 8);
  });

  t("garbage and truncated files are skipped, reported, and never change content", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    await w.run([a], 15000);
    const reader = await w.device(K);
    const before = json(reader);
    w.folder.drop(L.copyPath(S), new Uint8Array(200).fill(7));
    await reader.scan();
    await reader.tick();
    assert.deepEqual(json(reader), before);
    assert.equal(reader.status().unreadable.length, 1);
    const full = w.folder.read(L.mainPath(A));
    w.folder.drop(L.copyPath(S), full.slice(0, Math.floor(full.length / 2)));
    await reader.scan();
    assert.deepEqual(json(reader), before);
    assert.equal(reader.status().unreadable.length, 1);
    w.folder.drop(L.copyPath(S), full);
    await reader.scan();
    assert.equal(reader.status().unreadable.length, 0);
  });

  t("crswap, tmp, unknown tables and odd names never throw or change content", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    await w.run([a], 15000);
    const before = json(a);
    const main = L.mainPath(A);
    for (const p of [`${main}.crswap`, `${main}.tmp`, main.replace(".ywb", "x.ywb"), "data/other/sam-bbbbbbbb/state.ywb", "data/notes/readme.txt"]) {
      w.folder.drop(p, Uint8Array.of(1, 2, 3));
    }
    await a.scan();
    await a.tick();
    assert.deepEqual(json(a), before);
    assert.equal(a.status().errors.length, 0);
    assert.equal(a.status().unreadable.length, 0);
  });

  t("a conflict copy is read as data", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    await w.run([a], 15000);
    w.folder.copy(L.mainPath(A), L.copyPath(S));
    w.folder.remove(L.mainPath(A));
    const reader = await w.device(K);
    assert.deepEqual(json(reader), { m: { x: 1 } });
    assert.equal(reader.status().unreadable.length, 0);
  });

  t("a failed write keeps the change pending and the retry succeeds", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    w.folder.failWrites((p) => p.startsWith("data/"));
    await w.run([a], 10000);
    assert.equal(a.status().pending, 1);
    assert.ok(a.status().errors.some((e) => e.scope === "save"));
    assert.ok(w.folder.paths("data/").every((p) => w.folder.read(p).length === 0), "no content reached the folder");
    w.folder.clearFailures();
    await w.run([a], 30000);
    assert.equal(a.status().pending, 0);
    const reader = await w.device(S);
    assert.deepEqual(json(reader), { m: { x: 1 } });
  });

  t("saves wait for quiet, are forced by maxWait, and keep minInterval apart", async () => {
    const w = await make({ quietMs: 5000, maxWaitMs: 12000, minIntervalMs: 6000 });
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 0);
    await w.run([a], 4000);
    assert.equal(dataWrites(w).length, 0, "still inside the quiet period");
    await w.run([a], 2000);
    assert.equal(dataWrites(w).length, 1, "saved once quiet");
    for (let i = 1; i <= 30; i++) {
      a.table("notes").getMap("m").set("x", i);
      await w.run([a], 1000); // never quiet
    }
    const times = dataWrites(w).map((x) => x.at);
    assert.ok(times.length >= 3, `forced saves happened: ${times.length}`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 6000, "minInterval respected");
    assert.ok(times[1] - times[0] <= 12000 + 1000, "maxWait respected");
  });

  t("reseed writes every table into an emptied folder", async () => {
    const w = await make();
    const a = await w.device(A);
    a.table("notes").getMap("m").set("x", 1);
    await w.run([a], 15000);
    w.folder.empty();
    await a.reseed();
    assert.ok(w.folder.paths("data/").length >= 1);
    const late = await w.device(S);
    assert.deepEqual(json(late), { m: { x: 1 } });
  });

  t("no chunk files, no snapshots, no deletes, ever", async () => {
    const w = await make();
    const es = [await w.device(A), await w.device(S)];
    for (let i = 0; i < 6; i++) {
      es.forEach((e, j) => e.table("notes").getMap("m").set(`k${i}-${j}`, i));
      await w.run(es, 12000);
    }
    assert.equal(w.folder.deletes.length, 0);
    const names = w.folder.paths("data/").map((p) => p.split("/").pop());
    assert.deepEqual([...new Set(names)], [L.fileName]);
  });
}

test("an unknown layout name is rejected", async () => {
  const w = await makeWorld({ options: { layout: "nope" } });
  await assert.rejects(() => w.device(A), /unsupported layout/);
});

test("state-per-device never writes outside its own folder and status file", async () => {
  const w = await makeWorld({ tables: { notes: "yjs", tags: "yjs" }, options: { layout: "state-per-device" } });
  const es = [await w.device(A), await w.device(S)];
  for (let i = 0; i < 4; i++) {
    es[i % 2].table("notes").getMap("m").set(`k${i}`, i);
    es[(i + 1) % 2].table("tags").getMap("m").set(`k${i}`, i);
    await w.run(es, 15000);
  }
  assert.ok(w.folder.writes.length > 4);
  for (const { path } of w.folder.writes) {
    const mine = [A, S].some((d) => new RegExp(`^(data/(notes|tags)/${d}/state\\.ywb|status/${d}\\.ywb)$`).test(path));
    assert.ok(mine, `unexpected write ${path}`);
  }
  assert.deepEqual(
    [...new Set(w.folder.paths("data/").map((p) => p.split("/").slice(0, 3).join("/")))].sort(),
    [`data/notes/${A}`, `data/notes/${S}`, `data/tags/${A}`, `data/tags/${S}`],
  );
});

test("shared-file: every device writes the one shared file", async () => {
  const w = await makeWorld({ options: { layout: "shared-file" } });
  const es = [await w.device(A), await w.device(S)];
  es.forEach((e, i) => e.table("notes").getMap("m").set(`k${i}`, i));
  await w.run(es, 30000);
  assert.deepEqual(w.folder.paths("data/"), ["data/notes/table.ywb"]);
  assert.deepEqual(json(es[0]), json(es[1]));
});
