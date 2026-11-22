// Backup and restore with no screen (TR5 C1, OUT-45). Written before the code.
//
// A backup is one sealed snapshot per table in backups/<stamp>/<table>.ywb,
// packed as a store-only zip. Restore goes into a folder with no data/: an
// engine starts there, takes each table's snapshot and reseeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../../../engine/src/engine/engine.js";
import { open } from "../../../engine/src/engine/envelope.js";
import { openTable } from "../../../engine/src/records/index.js";
import { createMemoryStore } from "../../../engine/src/store/memory.js";
import { yjsAdapter } from "../../../engine/src/adapters/yjs.js";
import { createMemFolder, createManualClock, createSeededRandom } from "../../../engine/test/helpers/memfolder.js";
import { EAGER } from "../../../engine/test/engine/_harness.js";
import { newKeyring, rotateKeyring, engineKeys, USERS_TABLE, USERS_SCHEMA, putUser } from "../../identity/admin.js";
import { writeBackup, packBackup, restoreBackup, BackupError } from "../../backup/backup.js";
import { readZip } from "../../backup/zip.js";

const NOTES_SCHEMA = { version: 1, fields: { title: "latest", room: "ask", body: "text" } };
const TABLES = { notes: "yjs", [USERS_TABLE]: "yjs" };
const ADAPTERS = { yjs: yjsAdapter };
const textOf = (engine, table) => JSON.stringify(yjsAdapter.toJSON(engine.table(table)));

async function run(clock, engines, ms) {
  for (let t = 0; t < ms; t += 1000) {
    clock.advance(1000);
    for (const e of engines) await e.tick();
  }
}

function engineOn(folder, { clock, random, keys, deviceId, store = createMemoryStore() }) {
  return createEngine({
    root: folder.root, clock, random, store, deviceId, user: deviceId.split("-")[0],
    adapters: ADAPTERS, tables: TABLES, options: EAGER, ...keys,
  });
}

/**
 * Two devices edit a shared folder: a notes record with a text field and an
 * ask field both of them set at once, and two users records. Then Sam backs up.
 */
async function backedUp() {
  const clock = createManualClock();
  const random = createSeededRandom(45);
  const keyring = newKeyring({ random });
  const keys = await engineKeys(keyring);
  const source = createMemFolder({ clock });
  const sam = await engineOn(source, { clock, random, keys, deviceId: "sam-aaaaaaaa" });
  const kim = await engineOn(source, { clock, random, keys, deviceId: "kim-bbbbbbbb" });
  const notes = (engine, deviceId) => openTable({ doc: engine.table("notes"), schema: NOTES_SCHEMA, deviceId, user: deviceId.split("-")[0], clock });
  const users = openTable({ doc: sam.table(USERS_TABLE), schema: USERS_SCHEMA, deviceId: "sam-aaaaaaaa", user: "sam", clock });
  putUser(users, { id: "sam", name: "Sam", role: "admin", status: "active" });
  putUser(users, { id: "kim", name: "Kim", role: "member", status: "active" });
  notes(sam, "sam-aaaaaaaa").put("r1", { title: "Standup", body: "Agenda: backups" });
  await run(clock, [sam, kim], 30000);
  notes(sam, "sam-aaaaaaaa").put("r1", { room: "North" });
  notes(kim, "kim-bbbbbbbb").put("r1", { room: "South" });
  await run(clock, [sam, kim], 30000);
  const record = notes(sam, "sam-aaaaaaaa").get("r1");
  assert.equal(record.fields.body, "Agenda: backups");
  assert.equal(record.conflicts.room?.length, 2, "the ask field holds both candidates");

  const backup = await writeBackup({ root: source.root, engine: sam, tables: TABLES, adapters: ADAPTERS, key: keys.key, keyId: keys.keyId, clock, random });
  return { clock, random, keyring, keys, source, sam, kim, backup };
}

const restoreConfig = (b, keys, extra = {}) => ({
  clock: b.clock, random: b.random, store: createMemoryStore(), deviceId: "harry-rrrrrrrr", user: "harry",
  adapters: ADAPTERS, tables: TABLES, options: EAGER, ...keys, ...extra,
});

async function statusDigests(folder, deviceId, keys) {
  const { meta } = await open({ keys: keys.keys, bytes: folder.read(`status/${deviceId}.ywb`) });
  return Object.fromEntries(Object.entries(meta.tables).map(([t, s]) => [t, s.digest]));
}

test("writeBackup writes one sealed snapshot per table under backups/<UTC stamp>/", async () => {
  const b = await backedUp();
  assert.match(b.backup.stamp, /^\d{8}T\d{6}Z$/);
  assert.deepEqual(b.backup.files, [`backups/${b.backup.stamp}/notes.ywb`, `backups/${b.backup.stamp}/users.ywb`]);
  for (const path of b.backup.files) {
    const { meta, updates } = await open({ keys: b.keys.keys, bytes: b.source.read(path) });
    assert.equal(meta.kind, "backup");
    assert.equal(updates.length, 1);
  }
  const again = await writeBackup({ root: b.source.root, engine: b.sam, tables: TABLES, adapters: ADAPTERS, key: b.keys.key, keyId: b.keys.keyId, clock: b.clock, random: b.random });
  assert.notEqual(again.stamp, b.backup.stamp, "a second backup in the same second does not overwrite the first");
});

test("back up, then restore into an empty folder: every table's JSON is byte-equal", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  const target = createMemFolder({ clock: b.clock });
  const config = restoreConfig(b, b.keys);
  const result = await restoreBackup({ root: target.root, file: zip, engineConfig: config });
  assert.deepEqual(result.tables, ["notes", "users"]);

  // The restoring device itself keeps the data across a restart.
  const reopened = await engineOn(target, { clock: b.clock, random: b.random, keys: b.keys, deviceId: "harry-rrrrrrrr", store: config.store });
  for (const t of Object.keys(TABLES)) assert.equal(textOf(reopened, t), textOf(b.sam, t), `${t} on the restoring device`);
  await reopened.close();
});

test("a brand-new device on the restored folder reaches the same JSON and the same status digest", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  const target = createMemFolder({ clock: b.clock });
  await restoreBackup({ root: target.root, file: zip, engineConfig: restoreConfig(b, b.keys) });

  const fresh = await engineOn(target, { clock: b.clock, random: b.random, keys: b.keys, deviceId: "lee-cccccccc" });
  await run(b.clock, [fresh, b.sam, b.kim], 30000);
  for (const t of Object.keys(TABLES)) assert.equal(textOf(fresh, t), textOf(b.sam, t), t);
  assert.deepEqual(await statusDigests(target, "lee-cccccccc", b.keys), await statusDigests(b.source, "sam-aaaaaaaa", b.keys));
  assert.deepEqual(fresh.status().unreadable, []);
});

test("restore into a folder that already has data/ is refused", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  await assert.rejects(
    restoreBackup({ root: b.source.root, file: zip, engineConfig: restoreConfig(b, b.keys) }),
    (err) => err instanceof BackupError && err.code === "not-empty" && /data/.test(err.message),
  );
});

test("a wrong key is refused with a message, and nothing is written", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  const other = await engineKeys(newKeyring({ random: createSeededRandom(99) }));
  const target = createMemFolder({ clock: b.clock });
  await assert.rejects(
    restoreBackup({ root: target.root, file: zip, engineConfig: restoreConfig(b, other) }),
    (err) => err instanceof BackupError && err.code === "wrong-key" && err.message === "This backup cannot be opened with this workspace's keys.",
  );
  assert.deepEqual(target.writes, []);
});

test("a backup made before a key rotation restores with the rotated keyring", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  const rotated = await engineKeys(rotateKeyring(b.keyring, { random: b.random }));
  assert.equal(rotated.keyId, 2);
  const target = createMemFolder({ clock: b.clock });
  await restoreBackup({ root: target.root, file: zip, engineConfig: restoreConfig(b, rotated) });
  const fresh = await engineOn(target, { clock: b.clock, random: b.random, keys: rotated, deviceId: "lee-cccccccc" });
  await run(b.clock, [fresh], 10000);
  for (const t of Object.keys(TABLES)) assert.equal(textOf(fresh, t), textOf(b.sam, t), t);
  const data = target.writes.map((w) => w.path).filter((p) => p.startsWith("data/") && p.includes("/harry-rrrrrrrr/"));
  assert.ok(data.length > 0);
  for (const path of data) assert.equal(target.read(path)[4], 2, `${path} is written with the new key`);
});

test("the zip is store-only, holds the backup folder and passes unzip -t", async (t) => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  assert.ok(zip instanceof Uint8Array);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), [`${b.backup.stamp}/notes.ywb`, `${b.backup.stamp}/users.ywb`]);
  for (const e of entries) assert.deepEqual(e.bytes, b.source.read(`backups/${e.name}`));

  const probe = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (probe.error) {
    console.log("NOTICE: unzip is not installed; skipping the unzip -t check");
    t.skip("unzip is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "backup-"));
  try {
    const path = join(dir, "backup.zip");
    writeFileSync(path, zip);
    const result = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged zip is refused with a message", async () => {
  const b = await backedUp();
  const zip = await packBackup({ root: b.source.root, stamp: b.backup.stamp });
  const damaged = zip.slice();
  damaged[60] ^= 0xff; // inside the first file's bytes
  const target = createMemFolder({ clock: b.clock });
  await assert.rejects(
    restoreBackup({ root: target.root, file: damaged, engineConfig: restoreConfig(b, b.keys) }),
    (err) => err instanceof BackupError && err.code === "bad-file",
  );
});
